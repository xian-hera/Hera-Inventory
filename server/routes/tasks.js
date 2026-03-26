const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// GET /api/tasks - get all tasks with filters
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
      if (interval) {
        conditions.push(`created_at >= NOW() - INTERVAL '${interval}'`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT 
        t.*,
        COUNT(ti.id) FILTER (
          WHERE ti.soh IS NOT NULL AND ti.is_correct = FALSE AND ti.poh IS NOT NULL
        ) AS inaccurate_count,
        COUNT(ti.id) FILTER (
          WHERE ti.soh IS NOT NULL
        ) AS processed_count,
        COUNT(ti.id) AS total_count
      FROM tasks t
      LEFT JOIN task_items ti ON ti.task_id = t.id
      ${whereClause}
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tasks - delete selected tasks
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
    await pool.query('DELETE FROM tasks WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/archive - archive selected tasks
router.patch('/archive', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
    await pool.query(
      "UPDATE tasks SET status = 'archived', updated_at = NOW() WHERE id = ANY($1)",
      [ids]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/archive error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/negative-inventory - must be before /:id routes
router.post('/negative-inventory', async (req, res) => {
  try {
    const { locations, department } = req.body;
    if (!locations || locations.length === 0) {
      return res.status(400).json({ error: 'No locations provided' });
    }

    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const locMap = await pool.query(
      'SELECT location_name, shopify_location_id FROM location_map WHERE location_name = ANY($1)',
      [locations]
    );
    const locationIdMap = {};
    locMap.rows.forEach(r => { locationIdMap[r.location_name] = r.shopify_location_id; });

    const result = {};

    for (const location of locations) {
      const shopifyLocationId = locationIdMap[location];
      if (!shopifyLocationId) { result[location] = []; continue; }

      const gqlQuery = `
        query getNegativeInventory($locationId: ID!) {
          location(id: $locationId) {
            inventoryLevels(first: 250, query: "available:<0") {
              edges {
                node {
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                  item {
                    id
                    sku
                    variant {
                      barcode
                      metafield(namespace: "custom", key: "name") { value }
                      product { title productType }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const response = await client.request(gqlQuery, { variables: { locationId: shopifyLocationId } });
      const levels = response.data?.location?.inventoryLevels?.edges || [];

      const { getDepartment } = require('./shopify');
      const items = levels
        .filter(e => {
          const qty = e.node.quantities.find(q => q.name === 'available')?.quantity ?? 0;
          return qty < 0;
        })
        .map(e => {
          const variant = e.node.item?.variant;
          const name = variant?.metafield?.value || variant?.product?.title || '';
          const barcode = variant?.barcode || e.node.item?.sku || '';
          return { barcode, name };
        })
        .filter(i => i.barcode);

      result[location] = items;
    }

    res.json(result);
  } catch (e) {
    console.error('POST /api/tasks/negative-inventory error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Generate next task number
async function generateTaskNo(client) {
  const result = await client.query('SELECT last_number, last_letter FROM task_counter WHERE id = 1 FOR UPDATE');
  let { last_number, last_letter } = result.rows[0];

  last_number += 1;
  if (last_number > 9999) {
    last_number = 0;
    last_letter = String.fromCharCode(last_letter.charCodeAt(0) + 1);
  }

  await client.query(
    'UPDATE task_counter SET last_number = $1, last_letter = $2 WHERE id = 1',
    [last_number, last_letter]
  );

  return `${last_letter}${String(last_number).padStart(4, '0')}`;
}

// POST /api/tasks - create new task(s)
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { department, locations, filterSummary, items, notes, publish, negativeItems, excludedBarcodes } = req.body;
    if (!department || !locations || locations.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const locMap = await pool.query('SELECT location_name, shopify_location_id FROM location_map');
    const locationIdMap = {};
    locMap.rows.forEach(r => { locationIdMap[r.location_name] = r.shopify_location_id; });

    const status = publish ? 'counting' : 'draft';
    const createdTasks = [];

    await client.query('BEGIN');

    for (const location of locations) {
      const shopifyLocationId = locationIdMap[location] || '';
      const taskNo = await generateTaskNo(client);

      const taskResult = await client.query(
        `INSERT INTO tasks (task_no, department, location, shopify_location_id, status, filter_summary, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [taskNo, department, location, shopifyLocationId, status, filterSummary, JSON.stringify(notes || [])]
      );

      const task = taskResult.rows[0];

      // Insert regular items, skipping excluded zero-SOH for this location
      const locationExcluded = (excludedBarcodes && excludedBarcodes[location]) || [];
      for (const item of items) {
        if (locationExcluded.includes(item.barcode)) continue;
        await client.query(
          `INSERT INTO task_items (task_id, barcode, name) VALUES ($1, $2, $3)`,
          [task.id, item.barcode, item.name]
        );
      }

      // Insert negative items for this location (appended at end)
      const locationNegativeItems = (negativeItems && negativeItems[location]) || [];
      for (const item of locationNegativeItems) {
        const alreadyExists = items.some(i => i.barcode === item.barcode);
        if (!alreadyExists) {
          await client.query(
            `INSERT INTO task_items (task_id, barcode, name) VALUES ($1, $2, $3)`,
            [task.id, item.barcode, item.name]
          );
        }
      }

      createdTasks.push(task);
    }

    await client.query('COMMIT');
    res.json({ success: true, tasks: createdTasks });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/tasks error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/tasks/:id - get single task with items
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const taskResult = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const itemsResult = await pool.query(
      'SELECT * FROM task_items WHERE task_id = $1 ORDER BY id',
      [id]
    );

    res.json({ ...taskResult.rows[0], items: itemsResult.rows });
  } catch (e) {
    console.error('GET /api/tasks/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/notes
router.patch('/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    await pool.query(
      'UPDATE tasks SET notes = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(notes), id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/notes error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/commit
router.patch('/:id/commit', async (req, res) => {
  try {
    const { id } = req.params;
    const { itemIds } = req.body;

    const task = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (task.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const items = await pool.query(
      'SELECT * FROM task_items WHERE id = ANY($1) AND task_id = $2',
      [itemIds, id]
    );

    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const shopifyLocationId = task.rows[0].shopify_location_id;

    // Helper: call Shopify with up to 2 retries on timeout
    const shopifyRequest = async (fn, retries = 2) => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await fn();
        } catch (e) {
          const isTimeout = e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' ||
            (e.message && (e.message.includes('ETIMEDOUT') || e.message.includes('ECONNRESET')));
          if (isTimeout && attempt < retries) {
            console.log(`Shopify timeout, retrying (${attempt + 1}/${retries})...`);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
    };

    const errors = [];

    for (const item of items.rows) {
      if (item.is_correct || item.poh === null || item.soh === null) continue;

      const delta = item.poh - item.soh;

      // delta = 0: SOH and POH match — no Shopify call needed, just mark committed
      if (delta === 0) {
        await pool.query(
          'UPDATE task_items SET is_committed = TRUE WHERE id = $1',
          [item.id]
        );
        continue;
      }

      try {
        // Fetch inventory item ID with retry
        const variantRes = await shopifyRequest(() =>
          client.query({
            data: `{
              productVariants(first: 1, query: "barcode:${item.barcode}") {
                edges { node { inventoryItem { id } } }
              }
            }`
          })
        );
        const invItemId = variantRes.body.data.productVariants.edges[0]?.node?.inventoryItem?.id;
        if (!invItemId) {
          errors.push(`Barcode ${item.barcode}: inventory item not found in Shopify`);
          continue;
        }

        // Set on_hand inventory (cycle count — adjust absolute on_hand value)
        const newOnHand = item.soh + delta;
        await shopifyRequest(() =>
          client.query({
            data: `
              mutation {
                inventorySetOnHandQuantities(input: {
                  reason: "cycle_count_available",
                  setQuantities: [{
                    inventoryItemId: "${invItemId}",
                    locationId: "${shopifyLocationId}",
                    quantity: ${newOnHand}
                  }]
                }) {
                  userErrors { field message }
                }
              }
            `
          })
        );

        await pool.query(
          'UPDATE task_items SET is_committed = TRUE WHERE id = $1',
          [item.id]
        );
      } catch (e) {
        // Log but continue with other items — don't abort the whole commit
        console.error(`Commit failed for item ${item.id} (barcode: ${item.barcode}):`, e.message);
        errors.push(`Barcode ${item.barcode}: ${e.message}`);
      }
    }

    // Update task status if all inaccurate items are now committed
    const remaining = await pool.query(
      `SELECT COUNT(*) FROM task_items 
       WHERE task_id = $1 AND is_correct = FALSE AND poh IS NOT NULL AND is_committed = FALSE`,
      [id]
    );
    if (parseInt(remaining.rows[0].count) === 0) {
      await pool.query(
        "UPDATE tasks SET status = 'committed', updated_at = NOW() WHERE id = $1",
        [id]
      );
    }

    if (errors.length > 0) {
      // Partial success — some items committed, some failed
      return res.json({ success: true, warnings: errors });
    }

    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/submit
router.patch('/:id/submit', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      "UPDATE tasks SET status = 'reviewing', updated_at = NOW() WHERE id = $1",
      [id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/submit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:taskId/items/:itemId/poh — buyer overrides POH for a single item
router.patch('/:taskId/items/:itemId/poh', async (req, res) => {
  try {
    const { taskId, itemId } = req.params;
    const { poh } = req.body;
    if (poh === undefined || poh === null) return res.status(400).json({ error: 'poh required' });

    const pohVal = parseInt(poh);
    if (isNaN(pohVal)) return res.status(400).json({ error: 'poh must be a number' });

    // Fetch current item to recalculate is_correct
    const itemRes = await pool.query(
      'SELECT * FROM task_items WHERE id = $1 AND task_id = $2',
      [itemId, taskId]
    );
    if (itemRes.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    const item = itemRes.rows[0];

    const isCorrect = item.soh !== null && pohVal === item.soh;

    await pool.query(
      `UPDATE task_items SET poh = $1, is_correct = $2 WHERE id = $3`,
      [pohVal, isCorrect, itemId]
    );

    const updated = await pool.query('SELECT * FROM task_items WHERE id = $1', [itemId]);
    res.json(updated.rows[0]);
  } catch (e) {
    console.error('PATCH /:taskId/items/:itemId/poh error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:taskId/items/:itemId/scan
router.patch('/:taskId/items/:itemId/scan', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { scan_history, poh, soh, is_correct } = req.body;
    await pool.query(
      `UPDATE task_items 
       SET scan_history = $1, poh = $2, soh = $3, is_correct = $4
       WHERE id = $5`,
      [JSON.stringify(scan_history), poh, soh, is_correct, itemId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH scan error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/publish
router.patch('/:id/publish', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      "UPDATE tasks SET status = 'counting', updated_at = NOW() WHERE id = $1 AND status = 'draft'",
      [id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/publish error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;