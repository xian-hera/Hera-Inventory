// Online › Swatch (see claude/SWATCH_FEATURE_SPEC.md).
// Mounted at /api/swatch. Every write that changes what the storefront shows
// ends with syncSwatchMetafield() (spec §9); bulk uploads may pass
// { sync: false } per image and call POST /sync once at the end.
//
// Phase 0 (2026-10-01): /debug/metafield read + test write.
// Phase 1 (2026-10-01): libraries, images (Shopify Files), codes, ignore,
//   product scan, management list, config, metafield sync.
const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { gql, userErrorText } = require('../services/shopifyGql');
const { Matcher, codeKey, fileStem } = require('../services/swatchMatch');
const store = require('../services/swatchStore');
const shop = require('../services/swatchShopify');
const { startScan, getScanStatus } = require('../jobs/swatchScan');

const wrap = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(`[swatch] ${req.method} ${req.originalUrl}:`, e);
    res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) });
  }
};
const fail = (status, message, extra) => Object.assign(new Error(message), { status, extra });

// Sync, but never let a sync problem hide the result of the write itself.
async function trySync() {
  try {
    return { synced: true, ...(await shop.syncSwatchMetafield()) };
  } catch (e) {
    console.error('[swatch] metafield sync failed:', e);
    return { synced: false, syncError: e.message };
  }
}

// ─── Phase 0 debug ───────────────────────────────────────────────────────────
const NAMESPACE = 'hera_swatch';
const KEY = 'config';

const READ_QUERY = `
  query SwatchMetafield($namespace: String!, $key: String!) {
    currentAppInstallation {
      id
      metafield(namespace: $namespace, key: $key) {
        id
        type
        value
        updatedAt
      }
    }
  }
`;

const SET_MUTATION = `
  mutation SwatchMetafieldSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key type updatedAt }
      userErrors { field message code }
    }
  }
`;

router.get('/debug/metafield', async (req, res) => {
  try {
    const data = await gql(READ_QUERY, { namespace: NAMESPACE, key: req.query.key || KEY });
    const inst = data.currentAppInstallation;
    const mf = inst && inst.metafield;
    res.json({
      appInstallationId: inst ? inst.id : null,
      namespace: NAMESPACE,
      key: req.query.key || KEY,
      found: !!mf,
      type: mf ? mf.type : null,
      updatedAt: mf ? mf.updatedAt : null,
      bytes: mf ? Buffer.byteLength(mf.value || '', 'utf8') : 0,
      value: mf ? JSON.parse(mf.value) : null,
    });
  } catch (e) {
    console.error('GET /api/swatch/debug/metafield error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Phase 0 test write. Kept for debugging; note that the next real sync
// overwrites hera_swatch.config with the real configuration.
router.post('/debug/metafield', async (req, res) => {
  try {
    const data = await gql(READ_QUERY, { namespace: NAMESPACE, key: KEY });
    const ownerId = data.currentAppInstallation && data.currentAppInstallation.id;
    if (!ownerId) return res.status(500).json({ error: 'currentAppInstallation not found' });

    const value = { version: 0, note: 'phase 0 test', writtenAt: new Date().toISOString() };
    const out = await gql(SET_MUTATION, {
      metafields: [{ ownerId, namespace: NAMESPACE, key: KEY, type: 'json', value: JSON.stringify(value) }],
    });
    const errText = userErrorText(out.metafieldsSet);
    if (errText) return res.status(400).json({ error: errText });
    res.json({ ok: true, ownerId, written: value, metafield: out.metafieldsSet.metafields[0] });
  } catch (e) {
    console.error('POST /api/swatch/debug/metafield error:', e);
    res.status(500).json({ error: e.message });
  }
});

// What would be written, without writing it.
router.get('/debug/payload', wrap(async (req, res) => {
  const p = await shop.buildPayload();
  const sizes = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v), 'utf8')]));
  res.json({ sizes, payload: req.query.full ? p : undefined });
}));

// Remove a swatch file from Shopify Files by name (only Hera_swatch_* files,
// and only if no image row uses it) — for cleaning up after a failed upload.
router.delete('/debug/file', wrap(async (req, res) => {
  const name = String(req.query.name || '');
  if (!name.startsWith('Hera_swatch_')) throw fail(400, 'Only Hera_swatch_* files');
  const used = await pool.query('SELECT id FROM swatch_images WHERE filename = $1', [name]);
  if (used.rows.length) throw fail(400, 'This file belongs to an image in a library — delete the image instead');
  const found = await shop.findFileByName(name);
  for (const f of found) await shop.deleteFile(f.id);
  res.json({ deleted: found.map(f => f.id) });
}));

// ─── Meta: vendors, product types, locations ─────────────────────────────────
async function allStrings(field) {
  const out = [];
  let after = null;
  for (;;) {
    const d = await gql(`query($after: String) { ${field}(first: 1000, after: $after) { nodes pageInfo { hasNextPage endCursor } } }`, { after });
    out.push(...d[field].nodes);
    if (!d[field].pageInfo.hasNextPage) break;
    after = d[field].pageInfo.endCursor;
  }
  return out.filter(Boolean).sort();
}

router.get('/meta', wrap(async (req, res) => {
  const [vendors, productTypes, locs] = await Promise.all([
    allStrings('productVendors'),
    allStrings('productTypes'),
    pool.query('SELECT location_name FROM location_map WHERE is_active = TRUE ORDER BY location_name'),
  ]);
  res.json({ vendors, productTypes, locations: locs.rows.map(r => r.location_name) });
}));

// ─── Config (rules, style, text, icons, abbreviations, suggest-ignore) ──────
router.get('/config', wrap(async (req, res) => {
  const lastSync = (await pool.query("SELECT value FROM app_settings WHERE key = 'swatch_last_sync'")).rows[0];
  res.json({ config: await store.getConfig(), lastSync: lastSync ? lastSync.value : null });
}));

router.put('/config', wrap(async (req, res) => {
  const body = req.body || {};
  if (body.rules) {
    if (!Array.isArray(body.rules)) throw fail(400, 'rules must be a list');
    body.rules = body.rules.map(r => ({
      optionName: String(r.optionName || '').trim(),
      caseSensitive: !!r.caseSensitive,
      productTypes: [...new Set((r.productTypes || []).map(String))],
    }));
    if (body.rules.some(r => !r.optionName)) throw fail(400, 'Every rule needs an option name');
    if (body.rules.some(r => !r.productTypes.length)) throw fail(400, 'Every rule needs at least one product type');
  }
  const config = await store.saveConfig(body);
  res.json({ config, ...(await trySync()) });
}));

router.post('/sync', wrap(async (req, res) => {
  res.json(await shop.syncSwatchMetafield());
}));

// ─── Libraries ───────────────────────────────────────────────────────────────
router.get('/libraries', wrap(async (req, res) => {
  res.json({ libraries: await store.listLibraries() });
}));

router.post('/libraries', wrap(async (req, res) => {
  const { name, prefix, vendors } = req.body || {};
  let list;
  try {
    list = await store.validateLibrary({ name, prefix, vendors });
  } catch (e) {
    throw fail(400, e.message);
  }
  const dup = await pool.query('SELECT 1 FROM swatch_libraries WHERE name = $1 OR prefix = $2', [name, prefix]);
  if (dup.rows.length) throw fail(400, 'A library with this name or prefix already exists');
  const r = await pool.query(
    'INSERT INTO swatch_libraries (name, prefix, vendors) VALUES ($1, $2, $3) RETURNING *', [name, prefix, list]);
  res.json({ library: r.rows[0], ...(await trySync()) });
}));

// Change linked vendors (always allowed) or name / prefix (only while the
// library has no images, because both are baked into file names / alt text).
router.put('/libraries/:id', wrap(async (req, res) => {
  const lib = await store.getLibrary(req.params.id);
  if (!lib) throw fail(404, 'Library not found');
  const name = req.body.name !== undefined ? req.body.name : lib.name;
  const prefix = req.body.prefix !== undefined ? req.body.prefix : lib.prefix;
  const vendors = req.body.vendors !== undefined ? req.body.vendors : lib.vendors;
  if (name !== lib.name || prefix !== lib.prefix) {
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM swatch_images WHERE library_id = $1', [lib.id]);
    if (n.rows[0].n > 0) throw fail(400, 'Name and prefix can only be changed while the library has no images');
  }
  let list;
  try {
    list = await store.validateLibrary({ id: lib.id, name, prefix, vendors });
  } catch (e) {
    throw fail(400, e.message);
  }
  const r = await pool.query(
    'UPDATE swatch_libraries SET name = $2, prefix = $3, vendors = $4, updated_at = NOW() WHERE id = $1 RETURNING *',
    [lib.id, name, prefix, list]);
  res.json({ library: r.rows[0], ...(await trySync()) });
}));

// Only an empty library can be deleted (images must be deleted first, so
// Shopify Files never keeps orphans we no longer know about).
router.delete('/libraries/:id', wrap(async (req, res) => {
  const lib = await store.getLibrary(req.params.id);
  if (!lib) throw fail(404, 'Library not found');
  const n = await pool.query('SELECT COUNT(*)::int AS n FROM swatch_images WHERE library_id = $1', [lib.id]);
  if (n.rows[0].n > 0) throw fail(400, `Delete the ${n.rows[0].n} images of this library first`);
  await pool.query('DELETE FROM swatch_libraries WHERE id = $1', [lib.id]);
  res.json({ deleted: true, ...(await trySync()) });
}));

// ─── Matching helpers ────────────────────────────────────────────────────────
// Colour codes in use (last scan) for the vendors of a library, one per key.
async function libraryCodes(lib) {
  const r = await pool.query(
    'SELECT DISTINCT ON (code_key) code, code_key FROM swatch_scan_codes WHERE vendor = ANY($1) ORDER BY code_key, code',
    [lib.vendors]);
  return r.rows;
}

async function makeMatcher(extraNames = []) {
  const cfg = await store.getConfig();
  const codes = await pool.query('SELECT DISTINCT code FROM swatch_scan_codes');
  const names = await pool.query('SELECT original_name FROM swatch_images');
  const m = new Matcher({ abbr: cfg.abbreviations });
  for (const r of codes.rows) m.addVocab(r.code);
  for (const r of names.rows) m.addVocab(fileStem(r.original_name));
  for (const n of extraNames) m.addVocab(fileStem(n));
  return m;
}

// Upload preview (§5.1 step 3): for each local file name, which codes match.
router.post('/libraries/:id/preview', wrap(async (req, res) => {
  const lib = await store.getLibrary(req.params.id);
  if (!lib) throw fail(404, 'Library not found');
  const names = (req.body.names || []).map(String);
  const codes = await libraryCodes(lib);
  const m = await makeMatcher(names);
  const assigned = new Map((await pool.query(`
    SELECT c.code_key, i.original_name FROM swatch_codes c JOIN swatch_images i ON i.id = c.image_id WHERE c.library_id = $1`,
  [lib.id])).rows.map(r => [r.code_key, r.original_name]));
  const existingNames = new Set((await pool.query('SELECT original_name FROM swatch_images WHERE library_id = $1', [lib.id])).rows.map(r => r.original_name));
  const files = names.map(name => {
    const stem = fileStem(name);
    const exact = [], possible = [];
    for (const c of codes) {
      const s = m.score(c.code, stem);
      if (!s) continue;
      const item = { code: c.code, cost: s.cost, assignedTo: assigned.get(c.code_key) || null };
      (s.cost === 0 ? exact : possible).push(item);
    }
    possible.sort((a, b) => a.cost - b.cost || (a.code < b.code ? -1 : 1));
    return {
      name,
      shopifyName: shop.shopifyFileName(lib.prefix, name),
      alreadyUploaded: existingNames.has(name),
      exact, possible,
    };
  });
  res.json({ library: lib, codesInUse: codes.length, files });
}));

// ─── Images ──────────────────────────────────────────────────────────────────
router.get('/libraries/:id/images', wrap(async (req, res) => {
  res.json({ images: await store.listImages(req.params.id) });
}));

// Upload one image. Body: { name, data (base64), codes: [], reassign, sync }
router.post('/libraries/:id/images', wrap(async (req, res) => {
  const lib = await store.getLibrary(req.params.id);
  if (!lib) throw fail(404, 'Library not found');
  const { name, data, reassign, sync } = req.body || {};
  const codes = [...new Set((req.body.codes || []).map(String).filter(c => codeKey(c)))];
  if (!name || !data) throw fail(400, 'name and data are required');
  if (!/\.(jpe?g|png|webp|gif)$/i.test(name)) throw fail(400, 'Only jpg, png, webp or gif images');
  const dupName = await pool.query('SELECT id FROM swatch_images WHERE library_id = $1 AND original_name = $2', [lib.id, name]);
  if (dupName.rows.length) throw fail(409, `"${name}" is already in this library — use Replace instead`);
  const conflicts = await store.codeConflicts(lib.id, codes);
  if (conflicts.length && !reassign) throw fail(409, 'Some codes already point to another image', { conflicts });

  const buffer = Buffer.from(String(data).replace(/^data:[^,]*,/, ''), 'base64');
  const file = await shop.createFile({
    filename: shop.shopifyFileName(lib.prefix, name),
    alt: shop.altText(lib.name, codes),
    buffer,
    mimeType: shop.guessMime(name),
  });

  const client = await pool.connect();
  let imageId;
  try {
    await client.query('BEGIN');
    const ins = await client.query(`
      INSERT INTO swatch_images (library_id, original_name, shopify_file_id, filename, url, alt, width, height)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [lib.id, name, file.id, file.filename, file.url, shop.altText(lib.name, codes), file.width, file.height]);
    imageId = ins.rows[0].id;
    await store.assignCodes(client, lib.id, imageId, codes);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  // Images that lost a code to this one need their alt text rewritten.
  for (const id of new Set(conflicts.map(c => c.image_id))) await shop.refreshAlt(id).catch(e => console.error(e));
  const out = { image: await store.imageWithCodes(imageId) };
  res.json(sync === false ? out : { ...out, ...(await trySync()) });
}));

// Change the codes and/or crop position of an image.
// Body: { codes?: [...], position?: 'center top' | null, reassign }
router.put('/images/:id', wrap(async (req, res) => {
  const img = await store.imageWithCodes(req.params.id);
  if (!img) throw fail(404, 'Image not found');
  const affected = new Set([img.id]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (req.body.codes) {
      const codes = [...new Set(req.body.codes.map(String).filter(c => codeKey(c)))];
      const conflicts = await store.codeConflicts(img.library_id, codes, img.id);
      if (conflicts.length && !req.body.reassign) throw fail(409, 'Some codes already point to another image', { conflicts });
      conflicts.forEach(c => affected.add(c.image_id));
      await client.query('DELETE FROM swatch_codes WHERE image_id = $1 AND NOT (code_key = ANY($2))', [img.id, codes.map(codeKey)]);
      await store.assignCodes(client, img.library_id, img.id, codes);
    }
    if (req.body.position !== undefined) {
      await client.query('UPDATE swatch_images SET position = $2, updated_at = NOW() WHERE id = $1', [img.id, req.body.position || null]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  if (req.body.codes) for (const id of affected) await shop.refreshAlt(id);
  res.json({ image: await store.imageWithCodes(img.id), ...(await trySync()) });
}));

// Replace the picture, keeping the Shopify file, its name and its codes.
// Body: { data (base64), name? (new local file name, for the record only) }
router.put('/images/:id/file', wrap(async (req, res) => {
  const img = await store.imageWithCodes(req.params.id);
  if (!img) throw fail(404, 'Image not found');
  if (!req.body.data) throw fail(400, 'data is required');
  const buffer = Buffer.from(String(req.body.data).replace(/^data:[^,]*,/, ''), 'base64');
  const file = await shop.replaceFileContent({
    fileId: img.shopify_file_id, filename: img.filename, buffer, mimeType: shop.guessMime(img.filename),
  });
  await pool.query(`
    UPDATE swatch_images SET url = $2, width = $3, height = $4, filename = $5,
      original_name = COALESCE($6, original_name), updated_at = NOW() WHERE id = $1`,
  [img.id, file.url, file.width, file.height, file.filename || img.filename, req.body.name || null]);
  const out = { image: await store.imageWithCodes(img.id) };
  res.json(file.filename && file.filename !== img.filename ? { ...out, ...(await trySync()) } : out);
}));

// Delete an image here AND in Shopify Files (§5.2).
router.delete('/images/:id', wrap(async (req, res) => {
  const img = await store.imageWithCodes(req.params.id);
  if (!img) throw fail(404, 'Image not found');
  if (img.shopify_file_id) await shop.deleteFile(img.shopify_file_id);
  await pool.query('DELETE FROM swatch_images WHERE id = $1', [img.id]);
  res.json({ deleted: true, codesRemoved: img.codes, ...(await trySync()) });
}));

// ─── Codes (confirm a possible match / manual assign / unassign) ────────────
router.post('/codes', wrap(async (req, res) => {
  const { libraryId, code, imageId, reassign } = req.body || {};
  if (!codeKey(code)) throw fail(400, 'code is required');
  const img = await store.imageWithCodes(imageId);
  if (!img || String(img.library_id) !== String(libraryId)) throw fail(400, 'Image not found in this library');
  const conflicts = await store.codeConflicts(img.library_id, [code], img.id);
  if (conflicts.length && !reassign) throw fail(409, `${code} already points to ${conflicts[0].original_name}`, { conflicts });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await store.assignCodes(client, img.library_id, img.id, [code]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  for (const id of new Set([img.id, ...conflicts.map(c => c.image_id)])) await shop.refreshAlt(id);
  res.json({ image: await store.imageWithCodes(img.id), ...(await trySync()) });
}));

router.delete('/codes', wrap(async (req, res) => {
  const { libraryId, code } = req.body || {};
  const r = await pool.query('DELETE FROM swatch_codes WHERE library_id = $1 AND code_key = $2 RETURNING image_id', [libraryId, codeKey(code)]);
  if (!r.rows.length) throw fail(404, 'This code is not assigned');
  await shop.refreshAlt(r.rows[0].image_id);
  res.json({ unassigned: true, ...(await trySync()) });
}));

// ─── Ignore (§5.6) — Hub only, does not change the storefront ───────────────
router.post('/ignore', wrap(async (req, res) => {
  const { libraryId, codes, reason } = req.body || {};
  const list = (codes || []).map(String).filter(c => codeKey(c));
  for (const code of list) {
    await pool.query(`
      INSERT INTO swatch_ignored_codes (library_id, code_key, code, reason) VALUES ($1, $2, $3, $4)
      ON CONFLICT (library_id, code_key) DO UPDATE SET reason = EXCLUDED.reason, ignored_at = NOW()`,
    [libraryId, codeKey(code), code, reason || null]);
  }
  res.json({ ignored: list.length });
}));

router.post('/unignore', wrap(async (req, res) => {
  const { libraryId, codes } = req.body || {};
  const r = await pool.query('DELETE FROM swatch_ignored_codes WHERE library_id = $1 AND code_key = ANY($2)',
    [libraryId, (codes || []).map(codeKey)]);
  res.json({ unignored: r.rowCount });
}));

// ─── Scan + management list (§5.4 / §5.6) ────────────────────────────────────
router.post('/scan', wrap(async (req, res) => {
  res.json(await startScan());
}));

router.get('/scan', wrap(async (req, res) => {
  res.json(await getScanStatus());
}));

// GET /list?vendor=OUTRE&filter=all|none|possible|ignored|suggest
//   none     = no image and no candidate        (excludes ignored + hidden)
//   possible = a candidate file, not confirmed  (excludes ignored + hidden)
//   suggest  = none/possible rows whose every SKU meets the 建议 Ignore rule
// hidden rows (every variant sold out + discontinued, §6.2.1) show under "all" only.
router.get('/list', wrap(async (req, res) => {
  const vendor = String(req.query.vendor || '');
  const filter = String(req.query.filter || 'all');
  const lib = await store.libraryForVendor(vendor);
  const scanRows = (await pool.query('SELECT * FROM swatch_scan_codes WHERE vendor = $1 ORDER BY code_key', [vendor])).rows;

  let assigned = new Map(), ignored = new Map(), files = [], m = null;
  if (lib) {
    assigned = new Map((await pool.query(`
      SELECT c.code_key, i.id, i.original_name, i.filename, i.alt, i.url FROM swatch_codes c
      JOIN swatch_images i ON i.id = c.image_id WHERE c.library_id = $1`, [lib.id])).rows.map(r => [r.code_key, r]));
    ignored = new Map((await pool.query('SELECT * FROM swatch_ignored_codes WHERE library_id = $1', [lib.id])).rows.map(r => [r.code_key, r]));
    files = (await store.listImages(lib.id)).map(i => ({ id: i.id, name: i.original_name, stems: [fileStem(i.original_name)], image: i }));
    m = await makeMatcher();
  }

  const rows = scanRows.map(s => {
    const a = assigned.get(s.code_key);
    let status = 'none', candidate = null;
    if (a) status = 'matched';
    else if (m && files.length) {
      const r = m.matchCode(s.code, files);
      if (r.best) {
        status = 'possible';
        const im = r.best.file.image;
        candidate = { imageId: im.id, name: im.original_name, filename: im.filename, url: im.url, kind: r.status, cost: r.best.cost };
      }
    }
    const ig = ignored.get(s.code_key);
    return {
      code: s.code, codeKey: s.code_key,
      products: s.products, productCount: s.products.length, variantCount: s.variant_count,
      status, hidden: s.hidden, suggestIgnore: s.suggest_ignore && status !== 'matched',
      ignored: !a && ig ? { reason: ig.reason, at: ig.ignored_at } : null,
      file: a ? { imageId: a.id, name: a.original_name, filename: a.filename, alt: a.alt, url: a.url } : null,
      candidate,
    };
  });

  const open = r => !r.ignored && !r.hidden;
  const pick = {
    all: () => true,
    none: r => r.status === 'none' && open(r),
    possible: r => r.status === 'possible' && open(r),
    ignored: r => !!r.ignored,
    suggest: r => r.status !== 'matched' && r.suggestIgnore && open(r),
  };
  if (!pick[filter]) throw fail(400, 'Unknown filter');
  const counts = Object.fromEntries(Object.entries(pick).map(([k, f]) => [k, rows.filter(f).length]));
  res.json({
    vendor, library: lib, scan: await getScanStatus(), counts,
    rows: rows.filter(pick[filter]),
  });
}));

// Vendors seen in the last scan, with their library (null = no library: the
// storefront shows blank image areas for them, §4).
router.get('/vendors', wrap(async (req, res) => {
  const r = await pool.query(`
    SELECT s.vendor, COUNT(*)::int AS codes, l.id AS library_id, l.name AS library_name
    FROM swatch_scan_codes s LEFT JOIN swatch_libraries l ON s.vendor = ANY(l.vendors)
    GROUP BY s.vendor, l.id, l.name ORDER BY s.vendor`);
  res.json({ vendors: r.rows });
}));

module.exports = router;
