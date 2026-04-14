const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

async function generateTaskNo(client) {
  const res = await client.query(
    'SELECT last_number FROM price_change_counter WHERE id = 1 FOR UPDATE'
  );
  const next = res.rows[0].last_number + 1;
  await client.query(
    'UPDATE price_change_counter SET last_number = $1 WHERE id = 1',
    [next]
  );
  return String(next).padStart(6, '0');
}

async function cleanupExpired() {
  await pool.query(
    `DELETE FROM price_change_location_status
     WHERE status = 'done' AND auto_delete_at IS NOT NULL AND auto_delete_at < NOW()`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BUYER ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/price-change-tasks
router.get('/', async (req, res) => {
  try {
    await cleanupExpired();
    const result = await pool.query(`
      SELECT
        t.*,
        COUNT(i.id) AS item_count,
        ARRAY_AGG(DISTINCT ls.location) FILTER (WHERE ls.status = 'pending') AS unfinished_locations
      FROM price_change_tasks t
      LEFT JOIN price_change_items i ON i.task_id = t.id
      LEFT JOIN price_change_location_status ls ON ls.task_id = t.id
      WHERE t.status = 'active'
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/price-change-tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/price-change-tasks
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { locations, items, note, label_type } = req.body;
    if (!locations || locations.length === 0) {
      return res.status(400).json({ error: 'locations required' });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'items required' });
    }

    await client.query('BEGIN');
    const taskNo = await generateTaskNo(client);

    const taskRes = await client.query(
      `INSERT INTO price_change_tasks (task_no, note, locations, label_type)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [taskNo, note || null, locations, label_type || 'Regular price']
    );
    const task = taskRes.rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO price_change_items (task_id, sku, name, price, barcode, compare_at_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [task.id, item.sku, item.name || null, item.price || null, item.barcode || null, item.compare_at_price || null]
      );
    }

    for (const loc of locations) {
      await client.query(
        `INSERT INTO price_change_location_status (task_id, location, status)
         VALUES ($1, $2, 'pending')`,
        [task.id, loc]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, task });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/price-change-tasks error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// DELETE /api/price-change-tasks
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids' });
    await pool.query('DELETE FROM price_change_tasks WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/price-change-tasks/archive
router.patch('/archive', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids' });
    await pool.query(
      "UPDATE price_change_tasks SET status = 'archived' WHERE id = ANY($1)",
      [ids]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/price-change-tasks/:id/items
router.get('/:id/items', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM price_change_items WHERE task_id = $1 ORDER BY id',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MANAGER ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/price-change-tasks/manager?location=MTL01
router.get('/manager', async (req, res) => {
  try {
    await cleanupExpired();
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'location required' });

    const result = await pool.query(`
      SELECT
        t.id, t.task_no, t.note, t.created_at, t.label_type,
        COUNT(i.id) AS item_count,
        ls.status AS location_status,
        ls.printed_at,
        ls.auto_delete_at
      FROM price_change_tasks t
      JOIN price_change_location_status ls
        ON ls.task_id = t.id AND ls.location = $1
      LEFT JOIN price_change_items i ON i.task_id = t.id
      WHERE t.status = 'active'
        AND (ls.status = 'pending' OR (ls.status = 'done' AND ls.auto_delete_at > NOW()))
      GROUP BY t.id, ls.status, ls.printed_at, ls.auto_delete_at
      ORDER BY t.created_at DESC
    `, [location]);

    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/price-change-tasks/manager error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/price-change-tasks/:id/print
// Records printed_at only — does NOT change status or trigger auto-deletion
router.patch('/:id/print', async (req, res) => {
  try {
    const { location } = req.body;
    if (!location) return res.status(400).json({ error: 'location required' });

    await pool.query(
      `UPDATE price_change_location_status
       SET printed_at = NOW()
       WHERE task_id = $1 AND location = $2`,
      [req.params.id, location]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/price-change-tasks/:id/print error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/price-change-tasks/:id/done
// Manager marks task as done — sets status to 'done', auto-deletes after 2 hours
router.patch('/:id/done', async (req, res) => {
  try {
    const { location } = req.body;
    if (!location) return res.status(400).json({ error: 'location required' });

    const autoDeleteAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE price_change_location_status
       SET status = 'done', auto_delete_at = $1
       WHERE task_id = $2 AND location = $3`,
      [autoDeleteAt, req.params.id, location]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/price-change-tasks/:id/done error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;