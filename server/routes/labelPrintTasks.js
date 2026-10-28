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
      id                SERIAL PRIMARY KEY,
      task_id           INTEGER NOT NULL REFERENCES label_print_tasks(id) ON DELETE CASCADE,
      variant_id        VARCHAR(255),
      sku               VARCHAR(255),
      product_title     VARCHAR(255),
      variant_title     VARCHAR(255),
      custom_name       VARCHAR(255),
      price             VARCHAR(50),
      compare_at_price  VARCHAR(50),
      barcode           VARCHAR(255),
      vendor            VARCHAR(255),
      product_type      VARCHAR(255),
      qty_to_print      INTEGER NOT NULL DEFAULT 1,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE label_print_tasks ADD COLUMN IF NOT EXISTS location VARCHAR(50);`).catch(() => {});
  await pool.query(`ALTER TABLE label_print_items ADD COLUMN IF NOT EXISTS price VARCHAR(50);`).catch(() => {});
  await pool.query(`ALTER TABLE label_print_items ADD COLUMN IF NOT EXISTS compare_at_price VARCHAR(50);`).catch(() => {});
  await pool.query(`ALTER TABLE label_print_items ADD COLUMN IF NOT EXISTS barcode VARCHAR(255);`).catch(() => {});
  await pool.query(`ALTER TABLE label_print_items ADD COLUMN IF NOT EXISTS vendor VARCHAR(255);`).catch(() => {});
  await pool.query(`ALTER TABLE label_print_items ADD COLUMN IF NOT EXISTS product_type VARCHAR(255);`).catch(() => {});
}
ensureTables().catch(e => console.error('label_print_tasks table init error:', e));

// ─── Search by Filters (Store › Label Print, 2026-10-28, Hera) ──────────────
// Read from the local variant index (active products only, refreshed by
// jobs/syncVariantIndex.js — by default every 12 hours).

// GET /api/label-print-tasks/filter-options → { vendors, suppliers, displaySections }
// (Types come from GET /api/shopify/product-types — the enabled ones.)
router.get('/filter-options', async (req, res) => {
  try {
    const [v, s] = await Promise.all([
      pool.query(`SELECT DISTINCT vendor FROM variant_search_index WHERE vendor IS NOT NULL AND vendor <> '' ORDER BY vendor`),
      pool.query(`SELECT name FROM po_suppliers ORDER BY name ASC`).catch(() => ({ rows: [] })),
    ]);
    // Display section: the metafield's own choices in Shopify; if that can't
    // be read, the values found in the index.
    let displaySections = [];
    try {
      const { fetchDefinitions } = require('../services/productData');
      const defs = await fetchDefinitions('PRODUCTVARIANT');
      const def = defs.find(d => d.namespace === 'custom' && d.key === 'display_section');
      if (def && Array.isArray(def.choices)) displaySections = def.choices;
    } catch (e) {
      console.error('filter-options: display_section choices could not be read:', e.message);
    }
    if (!displaySections.length) {
      const d = await pool.query(
        `SELECT DISTINCT x FROM variant_search_index, unnest(display_section) AS x WHERE x <> '' ORDER BY x`
      );
      displaySections = d.rows.map(r => r.x);
    }
    res.json({
      vendors: v.rows.map(r => r.vendor),
      suppliers: s.rows.map(r => r.name).filter(Boolean),
      displaySections,
    });
  } catch (e) {
    console.error('GET /api/label-print-tasks/filter-options error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/label-print-tasks/filter-search
// body { type, vendor, supplier, displaySection, discontinued } — '' / missing
// = Any; discontinued: 'true' | 'false' | 'empty'. All filters together (AND),
// case-insensitive exact values; supplier = custom.supplier_a_name only.
// → { total, limit: 100, results: [{ variantId, sku, name, type, vendor,
//      supplier, displaySection, discontinued }] } — at most 100 rows.
const FILTER_LIMIT = 100;
router.post('/filter-search', async (req, res) => {
  try {
    const b = req.body || {};
    const val = (x) => (x == null ? '' : String(x).trim());
    const where = [];
    const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (val(b.type)) add('LOWER(product_type) = LOWER(?)', val(b.type));
    if (val(b.vendor)) add('LOWER(vendor) = LOWER(?)', val(b.vendor));
    if (val(b.supplier)) add('LOWER(TRIM(supplier_a_name)) = LOWER(?)', val(b.supplier));
    if (val(b.displaySection)) add('EXISTS (SELECT 1 FROM unnest(display_section) AS ds WHERE LOWER(ds) = LOWER(?))', val(b.displaySection));
    const disc = val(b.discontinued).toLowerCase();
    if (disc === 'true' || disc === 'false') add('discontinued = ?', disc);
    else if (disc === 'empty') where.push('discontinued IS NULL');
    if (!where.length) return res.status(400).json({ error: 'Choose at least one filter.' });
    const w = where.join(' AND ');
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM variant_search_index WHERE ${w}`, params)).rows[0].n;
    const rows = (await pool.query(
      `SELECT shopify_variant_id, sku, barcode, custom_name, product_title, product_type, vendor,
              supplier_a_name, display_section, discontinued
         FROM variant_search_index WHERE ${w}
        ORDER BY LOWER(COALESCE(NULLIF(custom_name, ''), product_title)), barcode
        LIMIT ${FILTER_LIMIT}`,
      params
    )).rows;
    res.json({
      total,
      limit: FILTER_LIMIT,
      results: rows.map(r => ({
        variantId: r.shopify_variant_id,
        sku: r.barcode || r.sku,
        name: r.custom_name || r.product_title,
        type: r.product_type,
        vendor: r.vendor,
        supplier: r.supplier_a_name,
        displaySection: (r.display_section || []).join(', '),
        discontinued: r.discontinued == null ? 'Empty' : r.discontinued === 'true' ? 'True' : r.discontinued === 'false' ? 'False' : r.discontinued,
      })),
    });
  } catch (e) {
    console.error('POST /api/label-print-tasks/filter-search error:', e);
    res.status(500).json({ error: e.message });
  }
});

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
    const {
      variant_id, sku, product_title, variant_title, custom_name,
      price, compare_at_price, barcode, vendor, product_type,
      qty_to_print,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO label_print_items
        (task_id, variant_id, sku, product_title, variant_title, custom_name,
         price, compare_at_price, barcode, vendor, product_type, qty_to_print)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        req.params.id, variant_id, sku, product_title, variant_title, custom_name,
        price || null, compare_at_price || null, barcode || null,
        vendor || null, product_type || null, qty_to_print || 1,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/label-print-tasks/:id/items error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/label-print-tasks/:id/items/:itemId
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