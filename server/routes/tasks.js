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
    const { department, locations, filterSummary, items, notes, publish } = req.body;
    if (!department || !locations || locations.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Fetch location map
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

      // Insert items
      for (const item of items) {
        await client.query(
          `INSERT INTO task_items (task_id, barcode, name) VALUES ($1, $2, $3)`,
          [task.id, item.barcode, item.name]
        );
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

// PATCH /api/tasks/:id/notes - update notes on a task
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

// PATCH /api/tasks/:id/commit - commit selected items
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
    const session = getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const shopifyLocationId = task.rows[0].shopify_location_id;

    for (const item of items.rows) {
      if (item.is_correct || item.poh === null || item.soh === null) continue;
      const delta = item.poh - item.soh;
      if (delta === 0) continue;

      // Get inventory item id
      const variantQuery = `{
        productVariants(first: 1, query: "barcode:${item.barcode}") {
          edges {
            node {
              inventoryItem { id }
            }
          }
        }
      }`;
      const variantRes = await client.query({ data: variantQuery });
      const invItemId = variantRes.body.data.productVariants.edges[0]?.node?.inventoryItem?.id;
      if (!invItemId) continue;

      // Adjust inventory
      const mutation = `
        mutation {
          inventoryAdjustQuantities(input: {
            reason: "correction",
            name: "available",
            changes: [{
              inventoryItemId: "${invItemId}",
              locationId: "${shopifyLocationId}",
              delta: ${delta}
            }]
          }) {
            userErrors { field message }
          }
        }
      `;
      await client.query({ data: mutation });

      // Mark as committed
      await pool.query(
        'UPDATE task_items SET is_committed = TRUE WHERE id = $1',
        [item.id]
      );
    }

    // Check if all inaccurate items are now committed
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

    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/submit - manager submits task
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

// PATCH /api/tasks/:taskId/items/:itemId/scan - save scan result
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

module.exports = router;