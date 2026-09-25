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
  subCollectionSync: 'import_sub_collection_sync', // { [type]: status }
};

// Sub type / Sub collection / Display section → which metafield definition.
// (2026-09-25: only sub_type is still assigned through this table by the
// Settings page. Display section uses the metafield's own choices; Sub
// collection has its own table — see "Sub collections" below.)
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

// ─── Sub collections (2026-09-25, Hera) ──────────────────────────────────────
// custom.sub_collection is single-line text. Per Type, Sync reads the values
// ACTIVE products use; the buyer assigns each value to a sub type (a value
// may be duplicated to sit under several sub types). The import table then
// offers, per row, the values assigned to that row's sub type.
// Values are compared case-insensitively and stored in Title Case.

function subCollectionKey(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
}

// "KIDS" / "kids" → "Kids"; "lace front" → "Lace Front"; "u-part" → "U-Part".
function titleCase(v) {
  return subCollectionKey(v).replace(/(^|[\s\-/(])([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());
}

// custom.sub_collection is a LIST metafield (list.single_line_text_field):
// Shopify returns '["Bang","Wrap"]'. Each item is its own value; a plain
// (non-JSON) value is treated as one item (2026-09-25).
function listItems(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(x => String(x == null ? '' : x)).filter(x => x.trim());
    } catch (e) { /* not JSON — fall through */ }
  }
  return [s];
}

const subCollectionSyncRunning = new Set();

// Every distinct sub_collection value used by ACTIVE products of one type.
// Throws on any Shopify error, so a partial read can never delete values.
async function collectSubCollections(productType) {
  const values = new Map(); // key → Title Case value
  let productCount = 0;
  let after = null;
  const q = `product_type:${JSON.stringify(productType)} AND status:active`;
  for (;;) {
    const data = await gql(
      `query($q: String!, $after: String) {
        products(first: 250, query: $q, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { productType status metafield(namespace: "custom", key: "sub_collection") { value } }
        }
      }`,
      { q, after }
    );
    if (!data || !data.products) throw new Error('Unexpected response from Shopify');
    for (const n of data.products.nodes) {
      // Search is loose — keep exact (case-insensitive) type + active only.
      if (String(n.productType || '').toLowerCase() !== productType.toLowerCase()) continue;
      if (n.status !== 'ACTIVE') continue;
      productCount++;
      for (const item of listItems(n.metafield && n.metafield.value)) {
        const key = subCollectionKey(item);
        if (key && !values.has(key)) values.set(key, titleCase(item));
      }
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return { productCount, values };
}

async function setSubCollectionStatus(type, patch) {
  const all = await getSetting(KEYS.subCollectionSync, {});
  all[type] = { ...(all[type] || {}), ...patch };
  await setSetting(KEYS.subCollectionSync, all);
}

// Apply one Sync result to the Hub table for this type (one transaction):
//   - values in use but not in the table → added, unassigned
//   - values in the table no longer used by any active product → deleted
//     (assigned copies too — Hera 2026-09-25)
//   - stored values normalised to Title Case
async function applySubCollectionSync(productType, { productCount, values }) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Serialise with Save for the same type.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`import_sub_collection:${productType}`]);
    const cur = await db.query(
      'SELECT id, value, sub_type FROM import_sub_collection_values WHERE product_type = $1 FOR UPDATE',
      [productType]
    );
    // Safety: only delete when the read is clearly complete and sane.
    if (productCount === 0) {
      throw new Error(`No active ${productType} products were found in Shopify — nothing was changed.`);
    }
    if (values.size === 0 && cur.rows.length > 0) {
      throw new Error(`None of the ${productCount} active ${productType} products has a sub collection — nothing was changed. Please check Shopify.`);
    }
    const haveKeys = new Set();
    let removed = 0;
    let added = 0;
    for (const r of cur.rows) {
      const key = subCollectionKey(r.value);
      if (!values.has(key)) {
        await db.query('DELETE FROM import_sub_collection_values WHERE id = $1', [r.id]);
        removed++;
        continue;
      }
      haveKeys.add(key);
      const canonical = values.get(key);
      if (r.value !== canonical) {
        await db.query('UPDATE import_sub_collection_values SET value = $1 WHERE id = $2', [canonical, r.id]);
      }
    }
    for (const [key, v] of values) {
      if (haveKeys.has(key)) continue;
      await db.query('INSERT INTO import_sub_collection_values (product_type, value, sub_type) VALUES ($1, $2, NULL)', [productType, v]);
      added++;
    }
    await db.query('COMMIT');
    return { added, removed, total: values.size, productCount };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

async function runSubCollectionSync(productType) {
  subCollectionSyncRunning.add(productType);
  await setSubCollectionStatus(productType, { running: true, startedAt: new Date().toISOString() });
  try {
    const found = await collectSubCollections(productType);
    const summary = await applySubCollectionSync(productType, found);
    await setSubCollectionStatus(productType, {
      running: false, lastSuccessAt: new Date().toISOString(), lastError: null, lastErrorAt: null, lastSummary: summary,
    });
  } catch (e) {
    console.error(`[import-products] sub collection sync failed for ${productType}:`, e);
    await setSubCollectionStatus(productType, { running: false, lastError: e.message, lastErrorAt: new Date().toISOString() });
  } finally {
    subCollectionSyncRunning.delete(productType);
  }
}

async function listSubCollections(productType) {
  const r = await pool.query(
    'SELECT id, value, sub_type AS "subType" FROM import_sub_collection_values WHERE product_type = $1 ORDER BY LOWER(value), id',
    [productType]
  );
  return r.rows;
}

router.get('/settings/sub-collections', async (req, res) => {
  try {
    const type = String(req.query.type || '');
    if (!type) return res.status(400).json({ error: 'type required' });
    const all = await getSetting(KEYS.subCollectionSync, {});
    const status = { ...(all[type] || {}) };
    // A restart mid-sync leaves running:true behind; trust memory instead.
    status.running = subCollectionSyncRunning.has(type);
    res.json({ rows: await listSubCollections(type), status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings/sub-collections/sync', async (req, res) => {
  try {
    const type = String((req.body && req.body.type) || '');
    if (!type) return res.status(400).json({ error: 'type required' });
    if (subCollectionSyncRunning.has(type)) return res.status(409).json({ error: 'A sync for this type is already running' });
    runSubCollectionSync(type); // not awaited — background
    res.json({ started: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save the whole card for one type: [{ id|null, value, subType|null }].
//   id → existing row (only its sub type is taken from the client)
//   id null → a Duplicate of an existing value (value must already exist)
//   rows missing from the list → deleted (Delete duplicated), but at least
//   one row per value always stays.
router.put('/settings/sub-collections', async (req, res) => {
  const type = String((req.body && req.body.type) || '');
  const list = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!type || !list) return res.status(400).json({ error: 'type and rows required' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`import_sub_collection:${type}`]);
    const cur = await db.query(
      'SELECT id, value, sub_type FROM import_sub_collection_values WHERE product_type = $1 FOR UPDATE',
      [type]
    );
    const byId = new Map(cur.rows.map(r => [r.id, r]));
    const canonicalByKey = new Map(cur.rows.map(r => [subCollectionKey(r.value), r.value]));
    const clean = (st) => (st == null || String(st).trim() === '' ? null : String(st));

    const updates = [];
    const inserts = [];
    let dropped = 0; // rows a Sync removed meanwhile
    for (const item of list) {
      const id = item && item.id != null ? Number(item.id) : null;
      if (id != null) {
        if (!byId.has(id)) { dropped++; continue; }
        updates.push({ id, key: subCollectionKey(byId.get(id).value), subType: clean(item.subType) });
      } else {
        const key = subCollectionKey(item && item.value);
        if (!canonicalByKey.has(key)) { dropped++; continue; } // only duplicates of existing values
        inserts.push({ key, value: canonicalByKey.get(key), subType: clean(item.subType) });
      }
    }
    const keptIds = new Set(updates.map(u => u.id));
    const deletes = cur.rows.filter(r => !keptIds.has(r.id));

    // Every value keeps at least one row; no value twice under one sub type.
    const finalCount = new Map();
    const seen = new Set();
    for (const r of [...updates, ...inserts]) {
      finalCount.set(r.key, (finalCount.get(r.key) || 0) + 1);
      if (r.subType) {
        const k = `${r.key}\u0000${r.subType.toLowerCase()}`;
        if (seen.has(k)) throw Object.assign(new Error(`"${canonicalByKey.get(r.key)}" is assigned to ${r.subType} more than once.`), { status: 400 });
        seen.add(k);
      }
    }
    for (const r of deletes) {
      const key = subCollectionKey(r.value);
      if (!finalCount.get(key)) throw Object.assign(new Error(`"${r.value}" can't be deleted — at least one copy must stay.`), { status: 400 });
    }

    for (const r of deletes) await db.query('DELETE FROM import_sub_collection_values WHERE id = $1', [r.id]);
    for (const u of updates) await db.query('UPDATE import_sub_collection_values SET sub_type = $1 WHERE id = $2', [u.subType, u.id]);
    for (const i of inserts) {
      await db.query('INSERT INTO import_sub_collection_values (product_type, value, sub_type) VALUES ($1, $2, $3)', [type, i.value, i.subType]);
    }
    await db.query('COMMIT');
    res.json({ success: true, dropped, rows: await listSubCollections(type) });
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    res.status(e.status || 500).json({ error: e.message });
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
    // Sub collections per sub type (2026-09-25). Keys are the sub type as
    // stored; the import table matches them case-insensitively.
    const sc = await pool.query(
      `SELECT sub_type, value FROM import_sub_collection_values
       WHERE LOWER(product_type) = LOWER($1) AND sub_type IS NOT NULL
       ORDER BY LOWER(value)`,
      [type]
    );
    const subCollectionsBySubType = {};
    for (const r of sc.rows) (subCollectionsBySubType[r.sub_type] = subCollectionsBySubType[r.sub_type] || []).push(r.value);
    res.json({
      categories: cats.rows,
      subTypes: pick('sub_type'),
      subCollections: pick('sub_collection'), // legacy, now always empty
      subCollectionsBySubType,
      displaySections: pick('display_section'), // legacy, now always empty — the table uses the metafield's own choices
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
// Exposed for tests.
module.exports._subCollections = { subCollectionKey, titleCase, listItems, collectSubCollections, applySubCollectionSync };
