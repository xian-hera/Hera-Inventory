const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { runSingleSupplierUpdate, getSingleSupplierStatus } = require('../jobs/poSkuUpdater');

const VALID_CURRENCIES = ['USD', 'CAD'];

// GET /api/po-suppliers?q=...
// Searches by supplier name, or by code/sku/product-name within po_supplier_skus.
router.get('/', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      const result = await pool.query(
        `SELECT * FROM po_suppliers ORDER BY name ASC`
      );
      return res.json(result.rows);
    }

    const term = `%${q.trim()}%`;
    const result = await pool.query(
      `SELECT DISTINCT s.* FROM po_suppliers s
       LEFT JOIN po_supplier_skus sk ON sk.supplier_id = s.id
       WHERE s.name ILIKE $1 OR sk.code ILIKE $1 OR sk.sku ILIKE $1 OR sk.name ILIKE $1
       ORDER BY s.name ASC`,
      [term]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/po-suppliers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/po-suppliers/autocomplete?q=...
// Case-sensitive substring match, used by the Import an invoice supplier field.
router.get('/autocomplete', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const result = await pool.query(
      `SELECT id, name, currency, fx_rate FROM po_suppliers WHERE name LIKE $1 ORDER BY name ASC LIMIT 20`,
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/po-suppliers/autocomplete error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/po-suppliers
router.post('/', async (req, res) => {
  try {
    const { name, currency, fxRate, typesCarrying } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!VALID_CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Currency must be USD or CAD' });
    if (!typesCarrying || typesCarrying.length === 0) return res.status(400).json({ error: 'At least one type is required' });
    if (currency === 'USD' && (fxRate === undefined || fxRate === null || fxRate === '')) {
      return res.status(400).json({ error: 'FX rate is required when currency is USD' });
    }

    const dupe = await pool.query('SELECT id FROM po_suppliers WHERE LOWER(name) = LOWER($1)', [name.trim()]);
    if (dupe.rows.length > 0) return res.status(409).json({ error: 'A supplier with this name already exists' });

    const result = await pool.query(
      `INSERT INTO po_suppliers (name, currency, fx_rate, types_carrying, updated_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
      [name.trim(), currency, currency === 'USD' ? fxRate : null, typesCarrying]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/po-suppliers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/po-suppliers/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { q } = req.query;

    const supplierRes = await pool.query('SELECT * FROM po_suppliers WHERE id = $1', [id]);
    if (supplierRes.rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });

    let skuQuery = 'SELECT * FROM po_supplier_skus WHERE supplier_id = $1';
    const params = [id];
    if (q && q.trim()) {
      skuQuery += ` AND (code ILIKE $2 OR sku ILIKE $2 OR name ILIKE $2)`;
      params.push(`%${q.trim()}%`);
    }
    skuQuery += ' ORDER BY name ASC';

    const skuRes = await pool.query(skuQuery, params);
    const skus = skuRes.rows.map(r => ({
      ...r,
      average_cost: r.cost_count > 0 ? Number(r.cost_sum) / r.cost_count : null,
    }));

    res.json({ supplier: supplierRes.rows[0], skus });
  } catch (e) {
    console.error('GET /api/po-suppliers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/po-suppliers/:id — single-field edit (name / currency+fxRate / typesCarrying)
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, currency, fxRate, typesCarrying } = req.body;

    const existing = await pool.query('SELECT * FROM po_suppliers WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name is required' });
      const dupe = await pool.query('SELECT id FROM po_suppliers WHERE LOWER(name) = LOWER($1) AND id != $2', [name.trim(), id]);
      if (dupe.rows.length > 0) return res.status(409).json({ error: 'A supplier with this name already exists' });
      await pool.query('UPDATE po_suppliers SET name = $1, updated_at = NOW() WHERE id = $2', [name.trim(), id]);
    }

    if (currency !== undefined) {
      if (!VALID_CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Currency must be USD or CAD' });
      if (currency === 'USD' && (fxRate === undefined || fxRate === null || fxRate === '')) {
        return res.status(400).json({ error: 'FX rate is required when currency is USD' });
      }
      await pool.query(
        'UPDATE po_suppliers SET currency = $1, fx_rate = $2, updated_at = NOW() WHERE id = $3',
        [currency, currency === 'USD' ? fxRate : null, id]
      );
    }

    if (typesCarrying !== undefined) {
      if (!typesCarrying || typesCarrying.length === 0) return res.status(400).json({ error: 'At least one type is required' });
      await pool.query('UPDATE po_suppliers SET types_carrying = $1, updated_at = NOW() WHERE id = $2', [typesCarrying, id]);
    }

    const updated = await pool.query('SELECT * FROM po_suppliers WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (e) {
    console.error('PATCH /api/po-suppliers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/po-suppliers/:id
// Blocked if this supplier has any invoice records (pending or committed) —
// po_invoices.supplier_id has no ON DELETE CASCADE on purpose, since a
// committed invoice is a real historical record of Shopify inventory/cost
// changes that already happened and shouldn't silently disappear or be
// orphaned. The buyer has to clear those invoices first.
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const invoiceCheck = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
              COUNT(*) FILTER (WHERE status = 'committed') AS committed_count
       FROM po_invoices WHERE supplier_id = $1`,
      [id]
    );
    const { pending_count, committed_count } = invoiceCheck.rows[0];
    if (Number(pending_count) > 0 || Number(committed_count) > 0) {
      return res.status(400).json({
        error: 'This Supplier has related Invoice(s) that are Committed or Commit later. To delete this Supplier, please delete those invoice records first.',
      });
    }
    await pool.query('DELETE FROM po_suppliers WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/po-suppliers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/po-suppliers/:id/update-sku — fire and forget, client polls status
router.post('/:id/update-sku', async (req, res) => {
  try {
    const { id } = req.params;
    const status = getSingleSupplierStatus();
    if (status.isRunning) return res.status(409).json({ error: 'An Update SKU run is already in progress' });

    runSingleSupplierUpdate(Number(id)).catch(e => console.error('[poSuppliers] update-sku error:', e.message));
    res.json({ started: true });
  } catch (e) {
    console.error('POST /api/po-suppliers/:id/update-sku error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/po-suppliers/:id/update-sku/status
router.get('/:id/update-sku/status', async (req, res) => {
  res.json(getSingleSupplierStatus());
});

module.exports = router;
