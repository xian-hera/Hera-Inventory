// /api/import-products — Buyer "Import Products" (2026-09-24).
// Spec: claude/IMPORT_PRODUCTS_FEATURE_SPEC.md
const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { gql } = require('../services/shopifyGql');
const { getSetting, setSetting, fetchAllDefinitions, fetchDefinitions } = require('../services/productData');
const { precheck, startImport, getJob } = require('../jobs/importProductsJob');

const KEYS = {
  locations: 'import_default_locations',
  blankMode: 'import_update_blank_mode',
  categoryStatus: 'import_category_status',
};

// Sub type / Sub collection / Display section → which metafield definition.
const ASSIGNABLE = {
  sub_type: { ownerType: 'PRODUCT', namespace: 'custom', key: 'sub_type' },
  sub_collection: { ownerType: 'PRODUCT', namespace: 'custom', key: 'sub_collection' },
  display_section: { ownerType: 'PRODUCTVARIANT', namespace: 'custom', key: 'display_section' },
};

// ─── Settings ────────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const counts = await pool.query('SELECT product_type, COUNT(*)::int AS n FROM import_category_pool GROUP BY product_type');
    res.json({
      defaultLocations: await getSetting(KEYS.locations, []),
      blankMode: await getSetting(KEYS.blankMode, 'keep'),
      categoryStatus: await getSetting(KEYS.categoryStatus, {}),
      categoryCounts: Object.fromEntries(counts.rows.map(r => [r.product_type, r.n])),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings/locations', async (req, res) => {
  try {
    const list = Array.isArray(req.body.locations) ? req.body.locations.map(String) : [];
    await setSetting(KEYS.locations, list);
    res.json({ success: true, defaultLocations: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings/blank-mode', async (req, res) => {
  try {
    const mode = req.body.mode === 'clear' ? 'clear' : 'keep';
    await setSetting(KEYS.blankMode, mode);
    res.json({ success: true, blankMode: mode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Categories: collect every category used by ACTIVE products of each chosen
// type and rebuild that type's pool (wipe + insert in one transaction).
// Runs in the background; status (incl. a persistent error) is saved in
// app_settings so the card can show it after a page reload.
let categoryUpdateRunning = false;

async function collectCategories(productType) {
  const seen = new Map();
  let after = null;
  const q = `product_type:${JSON.stringify(productType)} AND status:active`;
  for (;;) {
    const data = await gql(
      `query($q: String!, $after: String) {
        products(first: 250, query: $q, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { productType category { id name fullName } }
        }
      }`,
      { q, after }
    );
    for (const n of data.products.nodes) {
      // Search is loose — keep exact (case-insensitive) type matches only.
      if (String(n.productType || '').toLowerCase() !== productType.toLowerCase()) continue;
      if (n.category && !seen.has(n.category.id)) seen.set(n.category.id, n.category);
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return [...seen.values()];
}

async function runCategoryUpdate(types) {
  categoryUpdateRunning = true;
  const prev = await getSetting(KEYS.categoryStatus, {});
  await setSetting(KEYS.categoryStatus, { ...prev, running: true, startedAt: new Date().toISOString() });
  try {
    const results = {};
    for (const t of types) results[t] = await collectCategories(t);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      for (const t of types) {
        await db.query('DELETE FROM import_category_pool WHERE product_type = $1', [t]);
        for (const c of results[t]) {
          await db.query(
            `INSERT INTO import_category_pool (product_type, category_id, name, full_name, updated_at)
             VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (product_type, category_id) DO NOTHING`,
            [t, c.id, c.name, c.fullName]
          );
        }
      }
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      db.release();
    }
    await setSetting(KEYS.categoryStatus, {
      running: false, lastSuccessAt: new Date().toISOString(), lastError: null, lastErrorAt: null,
    });
  } catch (e) {
    console.error('[import-products] category update failed:', e);
    const cur = await getSetting(KEYS.categoryStatus, {});
    await setSetting(KEYS.categoryStatus, { ...cur, running: false, lastError: e.message, lastErrorAt: new Date().toISOString() });
  } finally {
    categoryUpdateRunning = false;
  }
}

router.post('/settings/categories/update', async (req, res) => {
  try {
    const types = Array.isArray(req.body.types) ? req.body.types.map(String).filter(Boolean) : [];
    if (!types.length) return res.status(400).json({ error: 'Select at least one type' });
    if (categoryUpdateRunning) return res.status(409).json({ error: 'An update is already running' });
    runCategoryUpdate(types); // not awaited — background
    res.json({ started: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sub type / Sub collection / Display section assignments.
router.get('/settings/assignments/:field', async (req, res) => {
  try {
    const cfg = ASSIGNABLE[req.params.field];
    if (!cfg) return res.status(404).json({ error: 'Unknown field' });
    const defs = await fetchDefinitions(cfg.ownerType);
    const def = defs.find(d => d.namespace === cfg.namespace && d.key === cfg.key);
    const r = await pool.query('SELECT choice_value, product_type FROM import_metafield_assignments WHERE metafield = $1', [req.params.field]);
    res.json({
      definitionFound: !!def,
      name: def ? def.name : null,
      choices: (def && def.choices) || [],
      assignments: Object.fromEntries(r.rows.map(x => [x.choice_value, x.product_type])),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings/assignments/:field', async (req, res) => {
  const field = req.params.field;
  if (!ASSIGNABLE[field]) return res.status(404).json({ error: 'Unknown field' });
  const assignments = req.body.assignments && typeof req.body.assignments === 'object' ? req.body.assignments : {};
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('DELETE FROM import_metafield_assignments WHERE metafield = $1', [field]);
    for (const [choice, type] of Object.entries(assignments)) {
      if (!choice || !type) continue;
      await db.query(
        'INSERT INTO import_metafield_assignments (metafield, choice_value, product_type) VALUES ($1, $2, $3)',
        [field, String(choice), String(type)]
      );
    }
    await db.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    db.release();
  }
});

// ─── Import page data ────────────────────────────────────────────────────────
router.get('/metafield-definitions', async (req, res) => {
  try {
    res.json(await fetchAllDefinitions());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dropdown pools for one Type (Start card).
router.get('/options', async (req, res) => {
  try {
    const type = String(req.query.type || '');
    const cats = await pool.query(
      'SELECT category_id AS id, name, full_name AS "fullName" FROM import_category_pool WHERE LOWER(product_type) = LOWER($1) ORDER BY full_name',
      [type]
    );
    const asg = await pool.query(
      'SELECT metafield, choice_value FROM import_metafield_assignments WHERE LOWER(product_type) = LOWER($1) ORDER BY choice_value',
      [type]
    );
    const pick = (f) => asg.rows.filter(r => r.metafield === f).map(r => r.choice_value);
    res.json({
      categories: cats.rows,
      subTypes: pick('sub_type'),
      subCollections: pick('sub_collection'),
      displaySections: pick('display_section'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/publications', async (req, res) => {
  try {
    const { listPublications } = require('../services/productData');
    res.json(await listPublications());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/precheck', async (req, res) => {
  try {
    const mode = req.body.mode === 'update' ? 'update' : 'add';
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length > 500) return res.status(400).json({ error: 'Too many rows' });
    res.json(await precheck(mode, rows));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import', async (req, res) => {
  try {
    const body = req.body || {};
    const mode = body.mode === 'update' ? 'update' : 'add';
    const products = Array.isArray(body.products) ? body.products : [];
    if (!products.length) return res.status(400).json({ error: 'Nothing to import' });
    const job = startImport({
      mode,
      productType: body.productType || '',
      locations: Array.isArray(body.locations) ? body.locations : [],
      products,
    });
    res.json({ jobId: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/import/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Import job not found (the server may have restarted)' });
  res.json(job);
});

module.exports = router;
