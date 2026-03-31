const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// DB init — idempotent
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS label_print_tasks (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL DEFAULT 'Print task',
      location   VARCHAR(50),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS label_print_items (
      id            SERIAL PRIMARY KEY,
      task_id       INTEGER NOT NULL REFERENCES label_print_tasks(id) ON DELETE CASCADE,
      variant_id    VARCHAR(255),
      sku           VARCHAR(255),
      product_title VARCHAR(255),
      variant_title VARCHAR(255),
      custom_name   VARCHAR(255),
      qty_to_print  INTEGER NOT NULL DEFAULT 1,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Add location column if upgrading from old schema
  await pool.query(`
    ALTER TABLE label_print_tasks ADD COLUMN IF NOT EXISTS location VARCHAR(50);
  `).catch(() => {});
}
ensureTables().catch(e => console.error('label_print_tasks table init error:', e));

// GET /api/label-print-tasks?location=MTL10
router.get('/', async (req, res) => {
  try {
    const { location } = req.query;
    const conditions = location ? 'WHERE t.location = $1' : '';
    const params = location ? [location] : [];
    const result = await pool.query(`
      SELECT t.*, COUNT(i.id)::int AS item_count
      FROM label_print_tasks t
      LEFT JOIN label_print_items i ON i.task_id = t.id
      ${conditions}
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `, params);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/label-print-tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/label-print-tasks
router.post('/', async (req, res) => {
  try {
    const { name, location } = req.body;
    const result = await pool.query(
      'INSERT INTO label_print_tasks (name, location) VALUES ($1, $2) RETURNING *',
      [name || 'Print task', location || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/label-print-tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/label-print-tasks/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM label_print_tasks WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/label-print-tasks — bulk delete
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
    await pool.query('DELETE FROM label_print_tasks WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/label-print-tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/label-print-tasks/:id — single delete
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM label_print_tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Items ─────────────────────────────────────────────────────────────────────

// GET /api/label-print-tasks/:id/items
router.get('/:id/items', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM label_print_items WHERE task_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/label-print-tasks/:id/items
router.post('/:id/items', async (req, res) => {
  try {
    const { variant_id, sku, product_title, variant_title, custom_name, qty_to_print } = req.body;
    const result = await pool.query(
      `INSERT INTO label_print_items
        (task_id, variant_id, sku, product_title, variant_title, custom_name, qty_to_print)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, variant_id, sku, product_title, variant_title, custom_name, qty_to_print || 1]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/label-print-tasks/:id/items error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/label-print-tasks/:id/items/:itemId — update qty
router.patch('/:id/items/:itemId', async (req, res) => {
  try {
    const { qty_to_print } = req.body;
    const result = await pool.query(
      'UPDATE label_print_items SET qty_to_print = $1 WHERE id = $2 AND task_id = $3 RETURNING *',
      [qty_to_print, req.params.itemId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/label-print-tasks/:id/items/:itemId
router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM label_print_items WHERE id = $1 AND task_id = $2',
      [req.params.itemId, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;