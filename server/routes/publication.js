// Online › Publication (2026-10-15, Hera). Spec: claude/PUBLICATION_FEATURE_SPEC.md
// Mounted at /api/publication.
//   GET  /meta                    channels, product types, locations
//   GET  /groups   PUT /groups    Channel Groups (whole list saved at once)
//   GET  /settings PUT /settings  Settings sub-tab
//   POST /scan                    start a scan (background) → scan status
//   GET  /scan/latest             { scan: newest scan, results: newest finished scan }
//   GET  /scan/:id                scan status (polling)
//   GET  /scan/:id/items?page=    one page (100 rows) of a finished scan
//   POST /publish  POST /unpublish  { itemIds, groupIds } → action status
//   GET  /actions/:id             action status (polling)
const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { gql } = require('../services/shopifyGql');
const { listPublications, fetchDefinitions } = require('../services/productData');
const { getSettings, saveSettings } = require('../services/publicationSettings');
const job = require('../jobs/publicationScan');
// Shared canonical location order (2026-10-22, Hera) — same order as every
// other location list in the Hub.
// (2026-10-22, later the same day: now reads the shared list itself via
// getActiveLocationMap(), so it follows the order saved in Settings →
// Locations. compareLocationNames is still imported but no longer used here.)
const { compareLocationNames, getActiveLocationMap } = require('./shopify');

const PAGE_SIZE = 100;

const wrap = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(`[publication] ${req.method} ${req.originalUrl}:`, e);
    res.status(e.status || 500).json({ error: e.message });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });

async function productTypes() {
  const out = [];
  let after = null;
  for (;;) {
    const d = await gql(`query($after: String) { productTypes(first: 1000, after: $after) { nodes pageInfo { hasNextPage endCursor } } }`, { after });
    out.push(...d.productTypes.nodes);
    if (!d.productTypes.pageInfo.hasNextPage) break;
    after = d.productTypes.pageInfo.endCursor;
  }
  return out.filter(Boolean).sort();
}

router.get('/meta', wrap(async (req, res) => {
  const [channels, types, locs] = await Promise.all([
    listPublications(),
    productTypes(),
    // Was: pool.query('SELECT location_name FROM location_map WHERE is_active = TRUE ORDER BY location_name')
    // — now the shared list (same source and order as GET /api/shopify/location-map).
    getActiveLocationMap(),
  ]);
  res.json({
    channels: channels.sort((a, b) => a.name.localeCompare(b.name)),
    productTypes: types,
    // Was alphabetical (SQL ORDER BY location_name only); now the shared
    // canonical order (2026-10-22, Hera). Was:
    //   locs.rows.map(r => r.location_name).sort(compareLocationNames)
    locations: locs.map(l => l.name),
  });
}));

// ─── Channel Groups ──────────────────────────────────────────────────────────
async function listGroups() {
  const r = await pool.query('SELECT id, name, publication_ids FROM publication_channel_groups ORDER BY sort_order, id');
  return r.rows.map(g => ({ id: g.id, name: g.name, channelIds: g.publication_ids || [] }));
}

router.get('/groups', wrap(async (req, res) => {
  res.json({ groups: await listGroups() });
}));

// body { groups: [{ id?, name, channelIds }] } — replaces the whole list.
router.put('/groups', wrap(async (req, res) => {
  const input = Array.isArray(req.body.groups) ? req.body.groups : [];
  const seen = new Set();
  const groups = input.map((g, i) => {
    const name = String((g && g.name) || '').trim();
    const channelIds = [...new Set((Array.isArray(g && g.channelIds) ? g.channelIds : []).map(String).filter(id => /^gid:\/\/shopify\/Publication\/\d+$/.test(id)))];
    if (!name) throw fail(400, `Group ${i + 1}: enter a name.`);
    if (seen.has(name.toLowerCase())) throw fail(400, `There are two groups named "${name}".`);
    seen.add(name.toLowerCase());
    if (!channelIds.length) throw fail(400, `${name}: choose at least one channel.`);
    const id = Number(g.id);
    return { id: Number.isInteger(id) && id > 0 ? id : null, name, channelIds };
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keep = groups.filter(g => g.id).map(g => g.id);
    await client.query('DELETE FROM publication_channel_groups WHERE NOT (id = ANY($1))', [keep]);
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const upd = g.id
        ? await client.query(
          'UPDATE publication_channel_groups SET name = $2, publication_ids = $3, sort_order = $4, updated_at = NOW() WHERE id = $1',
          [g.id, g.name, g.channelIds, i])
        : { rowCount: 0 };
      if (!upd.rowCount) {
        await client.query(
          'INSERT INTO publication_channel_groups (name, publication_ids, sort_order) VALUES ($1, $2, $3)',
          [g.name, g.channelIds, i]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ groups: await listGroups() });
}));

// ─── Settings ────────────────────────────────────────────────────────────────
router.get('/settings', wrap(async (req, res) => {
  res.json({ settings: await getSettings() });
}));

router.put('/settings', wrap(async (req, res) => {
  const body = req.body || {};
  if (body.fulfillmentLocation) {
    const r = await pool.query('SELECT 1 FROM location_map WHERE location_name = $1', [String(body.fulfillmentLocation)]);
    if (!r.rows.length) throw fail(400, `Location ${body.fulfillmentLocation} is not in the location map.`);
  }
  const settings = await saveSettings(body);
  // Warn (do not refuse) when Shopify has no definition (same as Price Change Settings).
  const warnings = [];
  for (const [label, m] of [['Discontinued', settings.discontinued], ['POS_Only', settings.posOnly]]) {
    const owner = m.owner === 'product' ? 'PRODUCT' : 'PRODUCTVARIANT';
    try {
      const defs = await fetchDefinitions(owner);
      if (!defs.some(d => d.namespace === m.namespace && d.key === m.key)) {
        warnings.push(`${label}: no ${m.owner} metafield definition ${m.namespace}.${m.key} was found in Shopify. Saved anyway; check the Name space and Key.`);
      }
    } catch (e) {
      warnings.push(`${label}: could not check ${m.namespace}.${m.key} in Shopify (${e.message}). Saved anyway.`);
    }
  }
  res.json({ settings, warnings });
}));

// ─── Scan ────────────────────────────────────────────────────────────────────
router.post('/scan', wrap(async (req, res) => {
  res.json({ scan: await job.startScan(req.body) });
}));

router.get('/scan/latest', wrap(async (req, res) => {
  const [scan, results] = await Promise.all([job.getLatestScan(), job.getLatestDoneScan()]);
  res.json({ scan, results });
}));

router.get('/scan/:id', wrap(async (req, res) => {
  const scan = await job.getScan(Number(req.params.id));
  if (!scan) throw fail(404, 'Scan not found');
  res.json({ scan });
}));

router.get('/scan/:id/items', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = Number((await pool.query('SELECT COUNT(*) AS n FROM publication_scan_items WHERE scan_id = $1', [id])).rows[0].n);
  const r = await pool.query(
    'SELECT * FROM publication_scan_items WHERE scan_id = $1 ORDER BY id LIMIT $2 OFFSET $3',
    [id, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
  res.json({
    page, pageSize: PAGE_SIZE, total,
    items: r.rows.map(x => ({
      id: x.id,
      productId: x.product_id,
      variantId: x.variant_id,
      isDefaultVariant: x.is_default_variant,
      title: x.title,
      variantName: x.variant_name,
      vendor: x.vendor,
      posOnly: x.pos_only,
      fulfillmentQty: x.fulfillment_qty,
      totalQty: x.total_qty,
      channelIds: x.publication_ids || [],
    })),
  });
}));

// ─── Publish / Unpublish ─────────────────────────────────────────────────────
router.post('/publish', wrap(async (req, res) => {
  res.json({ action: await job.startAction('publish', req.body || {}) });
}));

router.post('/unpublish', wrap(async (req, res) => {
  res.json({ action: await job.startAction('unpublish', req.body || {}) });
}));

router.get('/actions/:id', wrap(async (req, res) => {
  const action = job.getAction(req.params.id);
  if (!action) throw fail(404, 'This result is no longer available (the server may have restarted).');
  res.json({ action });
}));

module.exports = router;
