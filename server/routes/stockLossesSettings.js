const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// ─── Local Supplier Brands ───────────────────────────────────────────────────

// GET /api/stock-losses-settings/brands
router.get('/brands', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM local_supplier_brands ORDER BY vendor ASC');
    res.json(result.rows);
  } catch (e) {
    console.error('GET /brands error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stock-losses-settings/brands
router.post('/brands', async (req, res) => {
  try {
    const { vendor } = req.body;
    if (!vendor || !vendor.trim()) return res.status(400).json({ error: 'vendor required' });
    const result = await pool.query(
      'INSERT INTO local_supplier_brands (vendor) VALUES ($1) ON CONFLICT (vendor) DO NOTHING RETURNING *',
      [vendor.trim()]
    );
    res.json({ success: true, row: result.rows[0] || null });
  } catch (e) {
    console.error('POST /brands error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/stock-losses-settings/brands/:id
router.delete('/brands/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM local_supplier_brands WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /brands/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Custom Reasons ──────────────────────────────────────────────────────────

// GET /api/stock-losses-settings/custom-reasons
router.get('/custom-reasons', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM stock_losses_custom_reasons ORDER BY sort_order ASC, id ASC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /custom-reasons error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stock-losses-settings/custom-reasons
router.post('/custom-reasons', async (req, res) => {
  try {
    const { reason_label } = req.body;
    if (!reason_label || !reason_label.trim()) return res.status(400).json({ error: 'reason_label required' });
    const key = reason_label.trim().toLowerCase().replace(/\s+/g, '_');
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS max FROM stock_losses_custom_reasons');
    const sortOrder = parseInt(maxOrder.rows[0].max) + 1;
    const result = await pool.query(
      'INSERT INTO stock_losses_custom_reasons (reason_key, reason_label, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [key, reason_label.trim(), sortOrder]
    );
    res.json({ success: true, row: result.rows[0] });
  } catch (e) {
    console.error('POST /custom-reasons error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/stock-losses-settings/custom-reasons/:id
router.delete('/custom-reasons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Also delete all settings rows that reference this reason_key
    const reason = await pool.query('SELECT reason_key FROM stock_losses_custom_reasons WHERE id = $1', [id]);
    if (reason.rows.length > 0) {
      await pool.query('DELETE FROM stock_losses_settings WHERE reason = $1', [reason.rows[0].reason_key]);
    }
    await pool.query('DELETE FROM stock_losses_custom_reasons WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /custom-reasons/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Settings Matrix ─────────────────────────────────────────────────────────

// GET /api/stock-losses-settings/matrix
router.get('/matrix', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM stock_losses_settings ORDER BY id ASC');
    res.json(result.rows);
  } catch (e) {
    console.error('GET /matrix error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stock-losses-settings/matrix
// Upsert a single cell (type_value x reason)
router.post('/matrix', async (req, res) => {
  try {
    const {
      type_value, type_label,
      metafield_level, metafield_namespace, metafield_key, metafield_value,
      reason, reason_label,
      photo_required, instruction_text, local_supplier_instruction_text,
    } = req.body;

    if (!type_value || !reason) return res.status(400).json({ error: 'type_value and reason required' });

    const result = await pool.query(
      `INSERT INTO stock_losses_settings
        (type_value, type_label, metafield_level, metafield_namespace, metafield_key, metafield_value,
         reason, reason_label, photo_required, instruction_text, local_supplier_instruction_text, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (type_value, reason) DO UPDATE SET
         type_label = $2,
         metafield_level = $3,
         metafield_namespace = $4,
         metafield_key = $5,
         metafield_value = $6,
         reason_label = $8,
         photo_required = $9,
         instruction_text = $10,
         local_supplier_instruction_text = $11,
         updated_at = NOW()
       RETURNING *`,
      [
        type_value, type_label || type_value,
        metafield_level || null, metafield_namespace || null, metafield_key || null, metafield_value || null,
        reason, reason_label || reason,
        photo_required || false,
        instruction_text || null,
        local_supplier_instruction_text || null,
      ]
    );
    res.json({ success: true, row: result.rows[0] });
  } catch (e) {
    console.error('POST /matrix error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/stock-losses-settings/type/:type_value
// Delete all settings rows for a custom type row
router.delete('/type/:type_value', async (req, res) => {
  try {
    await pool.query('DELETE FROM stock_losses_settings WHERE type_value = $1', [req.params.type_value]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /type/:type_value error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;