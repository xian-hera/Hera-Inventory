const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// DB init — run once on startup (idempotent)
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS label_templates (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL DEFAULT 'Untitled template',
      paper_width_mm  NUMERIC(8,2) NOT NULL DEFAULT 50,
      paper_height_mm NUMERIC(8,2) NOT NULL DEFAULT 30,
      elements    JSONB NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE label_templates ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false;`).catch(() => {});
}
ensureTables().catch(e => console.error('label_templates table init error:', e));

// GET /api/label-templates — buyer: all templates
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, paper_width_mm, paper_height_mm, is_published, created_at, updated_at FROM label_templates ORDER BY updated_at DESC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/label-templates error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/label-templates/published — manager: only published templates
router.get('/published', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, paper_width_mm, paper_height_mm, is_published, created_at, updated_at FROM label_templates WHERE is_published = true ORDER BY updated_at DESC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/label-templates/published error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/label-templates/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM label_templates WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('GET /api/label-templates/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/label-templates
router.post('/', async (req, res) => {
  try {
    const { name, paper_width_mm, paper_height_mm, elements } = req.body;
    const result = await pool.query(
      `INSERT INTO label_templates (name, paper_width_mm, paper_height_mm, elements)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        name || 'Untitled template',
        paper_width_mm || 50,
        paper_height_mm || 30,
        JSON.stringify(elements || []),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/label-templates error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/label-templates/:id/duplicate
router.post('/:id/duplicate', async (req, res) => {
  try {
    const source = await pool.query(
      'SELECT * FROM label_templates WHERE id = $1',
      [req.params.id]
    );
    if (source.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const t = source.rows[0];
    // Duplicated template is always unpublished
    const result = await pool.query(
      `INSERT INTO label_templates (name, paper_width_mm, paper_height_mm, elements, is_published)
       VALUES ($1, $2, $3, $4, false) RETURNING *`,
      [
        `${t.name} (copy)`,
        t.paper_width_mm,
        t.paper_height_mm,
        JSON.stringify(t.elements),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/label-templates/:id/duplicate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/label-templates/:id/publish
router.patch('/:id/publish', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE label_templates SET is_published = true, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PATCH /api/label-templates/:id/publish error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/label-templates/:id/unpublish
router.patch('/:id/unpublish', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE label_templates SET is_published = false, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PATCH /api/label-templates/:id/unpublish error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/label-templates/:id
router.put('/:id', async (req, res) => {
  try {
    // Block editing published templates
    const check = await pool.query('SELECT is_published FROM label_templates WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (check.rows[0].is_published) return res.status(403).json({ error: 'Cannot edit a published template. Unpublish it first.' });

    const { name, paper_width_mm, paper_height_mm, elements } = req.body;
    const result = await pool.query(
      `UPDATE label_templates
       SET name = COALESCE($1, name),
           paper_width_mm  = COALESCE($2, paper_width_mm),
           paper_height_mm = COALESCE($3, paper_height_mm),
           elements = COALESCE($4, elements),
           updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [
        name,
        paper_width_mm,
        paper_height_mm,
        elements !== undefined ? JSON.stringify(elements) : undefined,
        req.params.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PUT /api/label-templates/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/label-templates/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM label_templates WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/label-templates/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;