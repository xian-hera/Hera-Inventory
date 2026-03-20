const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { getShopify, getSession } = require('../shopify');

// ═══════════════════════════════════════════════════════════════════════════
// ZERO QTY REPORTS  (buyer-side, submitted data)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/reports
router.get('/', async (req, res) => {
  try {
    const { department, location, status, date } = req.query;
    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (department && department !== 'ALL') {
      conditions.push(`department = $${paramIndex++}`);
      params.push(department);
    }
    if (location && location !== 'ALL') {
      const locations = location.split(',');
      conditions.push(`location = ANY($${paramIndex++})`);
      params.push(locations);
    }
    if (status && status !== 'ALL') {
      const statuses = status.split(',');
      conditions.push(`status = ANY($${paramIndex++})`);
      params.push(statuses);
    }
    if (date && date !== 'ALL') {
      let interval;
      if (date === 'today') interval = '1 day';
      else if (date === '7days') interval = '7 days';
      else if (date === '30days') interval = '30 days';
      if (interval) conditions.push(`submitted_at >= NOW() - INTERVAL '${interval}'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM zero_qty_reports ${whereClause} ORDER BY submitted_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/reports error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/reports/commit  (bulk — must come before /:id routes)
router.patch('/commit', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids' });
    for (const id of ids) {
      await commitReport(id);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/reports/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/reports/archive
router.patch('/archive', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids' });
    await pool.query(
      "UPDATE zero_qty_reports SET status = 'archived' WHERE id = ANY($1)",
      [ids]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reports/submit
router.post('/submit', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });

    for (const item of items) {
      // shopify_location_id may come in as item.shopify_location_id (from draft)
      // or item.locationId (legacy). Fall back to location_map lookup if both are null.
      let shopifyLocationId = item.shopify_location_id || item.locationId || null;

      if (!shopifyLocationId && item.location) {
        const mapRow = await pool.query(
          'SELECT shopify_location_id FROM location_map WHERE location_name = $1',
          [item.location]
        );
        if (mapRow.rows.length > 0) shopifyLocationId = mapRow.rows[0].shopify_location_id;
      }

      await pool.query(
        `INSERT INTO zero_qty_reports
         (barcode, name, department, location, shopify_location_id, soh, poh, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'reviewing')`,
        [item.barcode, item.name, item.department, item.location, shopifyLocationId, item.soh, item.poh]
      );
    }

    // Remove submitted barcodes from drafts for this location
    const location = items[0]?.location;
    if (location) {
      const barcodes = items.map(i => i.barcode);
      await pool.query(
        'DELETE FROM zero_qty_drafts WHERE location = $1 AND barcode = ANY($2)',
        [location, barcodes]
      );
    }

    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/reports/submit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/reports
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids' });
    await pool.query('DELETE FROM zero_qty_reports WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/reports/:id/commit
router.patch('/:id/commit', async (req, res) => {
  try {
    await commitReport(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/reports/:id/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Shared commit helper
async function commitReport(id) {
  const report = await pool.query('SELECT * FROM zero_qty_reports WHERE id = $1', [id]);
  if (report.rows.length === 0) throw new Error('Report not found');
  const r = report.rows[0];
  if (r.status !== 'reviewing') return;

  const delta = r.poh - r.soh;
  if (delta !== 0) {
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const variantRes = await client.query({
      data: `{ productVariants(first: 1, query: "barcode:${r.barcode}") {
        edges { node { inventoryItem { id } } }
      } }`
    });
    const invItemId = variantRes.body.data.productVariants.edges[0]?.node?.inventoryItem?.id;
    if (invItemId) {
      await client.query({
        data: `mutation {
          inventoryAdjustQuantities(input: {
            reason: "correction", name: "available",
            changes: [{
              inventoryItemId: "${invItemId}",
              locationId: "${r.shopify_location_id}",
              delta: ${delta}
            }]
          }) { userErrors { field message } }
        }`
      });
    }
  }

  await pool.query(
    "UPDATE zero_qty_reports SET status = 'committed', committed_at = NOW() WHERE id = $1",
    [id]
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ZERO QTY DRAFTS  (manager-side, unsumitted, persistent per location)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/reports/drafts?location=MTL01
router.get('/drafts', async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'location required' });

    // Clean up expired rows first
    await pool.query('DELETE FROM zero_qty_drafts WHERE expires_at < NOW()');

    const result = await pool.query(
      'SELECT * FROM zero_qty_drafts WHERE location = $1 ORDER BY created_at ASC',
      [location]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/reports/drafts error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/reports/drafts  — upsert a single draft entry
router.put('/drafts', async (req, res) => {
  try {
    const { barcode, name, department, location, shopify_location_id, soh, poh, scan_history } = req.body;
    if (!barcode || !location) return res.status(400).json({ error: 'barcode and location required' });

    const result = await pool.query(
      `INSERT INTO zero_qty_drafts
         (barcode, name, department, location, shopify_location_id, soh, poh, scan_history, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '15 days', NOW())
       ON CONFLICT (barcode, location) DO UPDATE SET
         name                = EXCLUDED.name,
         department          = EXCLUDED.department,
         shopify_location_id = EXCLUDED.shopify_location_id,
         soh                 = EXCLUDED.soh,
         poh                 = EXCLUDED.poh,
         scan_history        = EXCLUDED.scan_history,
         expires_at          = NOW() + INTERVAL '15 days',
         updated_at          = NOW()
       RETURNING *`,
      [barcode, name, department, location, shopify_location_id, soh, poh, JSON.stringify(scan_history || [])]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PUT /api/reports/drafts error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/reports/drafts  — delete by ids or all for a location
router.delete('/drafts', async (req, res) => {
  try {
    const { ids, location, all } = req.body;
    if (all && location) {
      await pool.query('DELETE FROM zero_qty_drafts WHERE location = $1', [location]);
    } else if (ids && ids.length > 0) {
      await pool.query('DELETE FROM zero_qty_drafts WHERE id = ANY($1)', [ids]);
    } else {
      return res.status(400).json({ error: 'Provide ids or all+location' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RESTOCK PLANS  (manager-side, persistent per location)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/reports/restock?location=MTL01
router.get('/restock', async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'location required' });

    await pool.query('DELETE FROM restock_plans WHERE expires_at < NOW()');

    const result = await pool.query(
      'SELECT * FROM restock_plans WHERE location = $1 ORDER BY created_at ASC',
      [location]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/reports/restock error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/reports/restock  — upsert a single restock entry
router.put('/restock', async (req, res) => {
  try {
    const { barcode, name, location, shopify_location_id, soh, restock_qty } = req.body;
    if (!barcode || !location) return res.status(400).json({ error: 'barcode and location required' });

    const result = await pool.query(
      `INSERT INTO restock_plans
         (barcode, name, location, shopify_location_id, soh, restock_qty, is_done, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, NOW() + INTERVAL '15 days', NOW())
       ON CONFLICT (barcode, location) DO UPDATE SET
         name                = EXCLUDED.name,
         shopify_location_id = EXCLUDED.shopify_location_id,
         soh                 = EXCLUDED.soh,
         restock_qty         = EXCLUDED.restock_qty,
         expires_at          = NOW() + INTERVAL '15 days',
         updated_at          = NOW()
       RETURNING *`,
      [barcode, name, location, shopify_location_id, soh, restock_qty]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PUT /api/reports/restock error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/reports/restock/:id/done  — toggle is_done
router.patch('/restock/:id/done', async (req, res) => {
  try {
    const { id } = req.params;
    const { is_done } = req.body;
    const result = await pool.query(
      'UPDATE restock_plans SET is_done = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [is_done, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/reports/restock  — delete by ids or all for a location
router.delete('/restock', async (req, res) => {
  try {
    const { ids, location, all } = req.body;
    if (all && location) {
      await pool.query('DELETE FROM restock_plans WHERE location = $1', [location]);
    } else if (ids && ids.length > 0) {
      await pool.query('DELETE FROM restock_plans WHERE id = ANY($1)', [ids]);
    } else {
      return res.status(400).json({ error: 'Provide ids or all+location' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;