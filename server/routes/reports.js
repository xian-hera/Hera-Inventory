const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { getShopify, getSession } = require('../shopify');

// GET /api/reports - get all zero qty reports with filters
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

// PATCH /api/reports/:id/commit - commit single report
router.patch('/:id/commit', async (req, res) => {
  try {
    const { id } = req.params;
    const report = await pool.query('SELECT * FROM zero_qty_reports WHERE id = $1', [id]);
    if (report.rows.length === 0) return res.status(404).json({ error: 'Report not found' });

    const r = report.rows[0];
    if (r.status !== 'reviewing') return res.json({ success: true });

    const delta = r.poh - r.soh;
    if (delta !== 0) {
      const session = await getSession();
      const shopify = getShopify();
      const client = new shopify.clients.Graphql({ session });

      const variantQuery = `{
        productVariants(first: 1, query: "barcode:${r.barcode}") {
          edges { node { inventoryItem { id } } }
        }
      }`;
      const variantRes = await client.query({ data: variantQuery });
      const invItemId = variantRes.body.data.productVariants.edges[0]?.node?.inventoryItem?.id;

      if (invItemId) {
        const mutation = `
          mutation {
            inventoryAdjustQuantities(input: {
              reason: "correction",
              name: "available",
              changes: [{
                inventoryItemId: "${invItemId}",
                locationId: "${r.shopify_location_id}",
                delta: ${delta}
              }]
            }) {
              userErrors { field message }
            }
          }
        `;
        await client.query({ data: mutation });
      }
    }

    await pool.query(
      "UPDATE zero_qty_reports SET status = 'committed', committed_at = NOW() WHERE id = $1",
      [id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/reports/:id/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/reports/commit - commit multiple reports
router.patch('/commit', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids' });
    for (const id of ids) {
      await fetch(`http://localhost:${process.env.PORT || 3001}/api/reports/${id}/commit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/reports/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/reports - delete selected
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

// PATCH /api/reports/archive - archive selected
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
// POST /api/reports/submit - manager submits zero qty report items
router.post('/submit', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });

    for (const item of items) {
      await pool.query(
        `INSERT INTO zero_qty_reports 
         (barcode, name, department, location, shopify_location_id, soh, poh, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'reviewing')`,
        [item.barcode, item.name, item.department, item.location, item.locationId, item.soh, item.poh]
      );
    }
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/reports/submit error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;