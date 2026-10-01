// Online › Swatch — settings + database helpers (spec: claude/SWATCH_FEATURE_SPEC.md).
const { pool } = require('../database/init');
const { getSetting, setSetting } = require('./productData');
const { DEFAULT_ABBR, codeKey } = require('./swatchMatch');

const CONFIG_KEY = 'swatch_config';
const SCAN_META_KEY = 'swatch_scan_meta';

// Defaults = the reference app's numbers (spec §1.1 / §7).
const DEFAULT_CONFIG = {
  // §3: [{ optionName, caseSensitive, productTypes: [] }]
  // Master switch (Hera 2026-10-01). 'off' = storefront untouched;
  // 'preview' = only on *.shopifypreview.com and in the theme editor, for
  // testing on a duplicated theme; 'live' = replace on the real store too.
  mode: 'off',
  rules: [],
  // §6.1: only the main product section's picker is replaced
  selector: 'variant-selects[id$="__main"]',
  // Other pickers to hide while Hera Swatch is active (third-party apps).
  hideSelectors: ['variant-swatch-king'],
  style: {
    cardWidth: 72,           // px
    imageHeight: 81,         // px (image area 71 x 81 at the default width)
    imagePosition: 'center top',
    accentColor: '#E32A69',  // selected / hover card border
    buttonSelectedBg: '#292929',
    soldOutBg: 'rgba(187,187,187,0.82)',
    soldOutColor: '#FFFFFF',
    overlayColor: '#F8F8F8',
    overlayOpacity: 0.75,
  },
  text: {
    soldOut: { en: 'SOLD OUT', fr: '' },     // FR default to be filled in by Hera
    modalNote: { en: '', fr: '' },
  },
  // magnifierFile: { filename, url } of an SVG in Shopify Files (Hera
  // 2026-10-01, preferred); magnifier: inline SVG code, used only when no
  // file is linked; placeholder icon when both are empty.
  icons: { magnifierFile: null, magnifier: '' },
  abbreviations: DEFAULT_ABBR,               // §5.5, editable later
  // §5.6 "建议 Ignore": every SKU discontinued + no stock here + total < minTotal
  suggestIgnore: { locationName: 'MTL10', minTotal: 3 },
};

function mergeConfig(saved) {
  const s = saved || {};
  return {
    ...DEFAULT_CONFIG,
    ...s,
    style: { ...DEFAULT_CONFIG.style, ...(s.style || {}) },
    text: {
      soldOut: { ...DEFAULT_CONFIG.text.soldOut, ...((s.text || {}).soldOut || {}) },
      modalNote: { ...DEFAULT_CONFIG.text.modalNote, ...((s.text || {}).modalNote || {}) },
    },
    icons: { ...DEFAULT_CONFIG.icons, ...(s.icons || {}) },
    abbreviations: { ...(s.abbreviations || DEFAULT_CONFIG.abbreviations) },
    suggestIgnore: { ...DEFAULT_CONFIG.suggestIgnore, ...(s.suggestIgnore || {}) },
    rules: Array.isArray(s.rules) ? s.rules : [],
    mode: ['off', 'preview', 'live'].includes(s.mode) ? s.mode : 'off',
    hideSelectors: Array.isArray(s.hideSelectors) ? s.hideSelectors : DEFAULT_CONFIG.hideSelectors,
  };
}

async function getConfig() {
  return mergeConfig(await getSetting(CONFIG_KEY, null));
}

async function saveConfig(patch) {
  const cur = await getConfig();
  const next = mergeConfig({ ...cur, ...patch,
    style: { ...cur.style, ...((patch && patch.style) || {}) },
    text: {
      soldOut: { ...cur.text.soldOut, ...(((patch || {}).text || {}).soldOut || {}) },
      modalNote: { ...cur.text.modalNote, ...(((patch || {}).text || {}).modalNote || {}) },
    },
    icons: { ...cur.icons, ...((patch && patch.icons) || {}) },
    suggestIgnore: { ...cur.suggestIgnore, ...((patch && patch.suggestIgnore) || {}) },
  });
  await setSetting(CONFIG_KEY, next);
  return next;
}

// Does a product hit a rule? Returns the swatch option name or null (§3:
// first rule in the list wins).
function ruleOptionFor(rules, productType, optionNames) {
  for (const r of rules || []) {
    if (!r || !r.optionName) continue;
    if (!(r.productTypes || []).includes(productType)) continue;
    const want = String(r.optionName).trim();
    const hit = (optionNames || []).find(n =>
      r.caseSensitive ? String(n).trim() === want : String(n).trim().toUpperCase() === want.toUpperCase());
    if (hit) return hit;
  }
  return null;
}

// ─── Libraries ───────────────────────────────────────────────────────────────
async function listLibraries() {
  const r = await pool.query(`
    SELECT l.*,
      (SELECT COUNT(*)::int FROM swatch_images i WHERE i.library_id = l.id) AS image_count,
      (SELECT COUNT(*)::int FROM swatch_codes c WHERE c.library_id = l.id) AS code_count
    FROM swatch_libraries l ORDER BY l.name`);
  return r.rows;
}

async function getLibrary(id) {
  const r = await pool.query('SELECT * FROM swatch_libraries WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function libraryForVendor(vendor) {
  const r = await pool.query('SELECT * FROM swatch_libraries WHERE $1 = ANY(vendors) LIMIT 1', [vendor]);
  return r.rows[0] || null;
}

// Validates name / prefix / vendors; throws a readable Error.
async function validateLibrary({ id = null, name, prefix, vendors }) {
  if (!name || !String(name).trim()) throw new Error('Library name is required (pick a vendor)');
  if (!/^[a-z0-9]+$/.test(prefix || '')) throw new Error('Prefix: lowercase letters and digits only');
  const list = [...new Set([name, ...(vendors || [])].map(v => String(v)))];
  const others = await pool.query(
    'SELECT name, vendors FROM swatch_libraries WHERE ($1::int IS NULL OR id <> $1) AND vendors && $2::text[]',
    [id, list]);
  if (others.rows.length) {
    const taken = list.filter(v => others.rows.some(o => o.vendors.includes(v)));
    throw new Error(`Already linked to another library: ${taken.join(', ')}`);
  }
  return list; // the library's own vendor is always in its vendor list
}

// ─── Codes / images ──────────────────────────────────────────────────────────
async function imageWithCodes(imageId) {
  const r = await pool.query(`
    SELECT i.*, COALESCE(array_agg(c.code ORDER BY c.code) FILTER (WHERE c.id IS NOT NULL), '{}') AS codes
    FROM swatch_images i LEFT JOIN swatch_codes c ON c.image_id = i.id
    WHERE i.id = $1 GROUP BY i.id`, [imageId]);
  return r.rows[0] || null;
}

async function listImages(libraryId) {
  const r = await pool.query(`
    SELECT i.*, COALESCE(array_agg(c.code ORDER BY c.code) FILTER (WHERE c.id IS NOT NULL), '{}') AS codes
    FROM swatch_images i LEFT JOIN swatch_codes c ON c.image_id = i.id
    WHERE i.library_id = $1 GROUP BY i.id ORDER BY i.original_name`, [libraryId]);
  return r.rows;
}

// Which of these codes already point to a different image? -> [{code, image_id, original_name}]
async function codeConflicts(libraryId, codes, imageId = null) {
  const keys = codes.map(codeKey);
  const r = await pool.query(`
    SELECT c.code, c.image_id, i.original_name FROM swatch_codes c JOIN swatch_images i ON i.id = c.image_id
    WHERE c.library_id = $1 AND c.code_key = ANY($2) AND ($3::int IS NULL OR c.image_id <> $3)`,
    [libraryId, keys, imageId]);
  return r.rows;
}

// Point these codes at imageId (moving them from another image if needed) and
// clear their Ignore flag (§5.6: a matched code is no longer ignored).
async function assignCodes(client, libraryId, imageId, codes) {
  for (const code of codes) {
    const key = codeKey(code);
    if (!key) continue;
    await client.query(`
      INSERT INTO swatch_codes (library_id, code, code_key, image_id) VALUES ($1, $2, $3, $4)
      ON CONFLICT (library_id, code_key) DO UPDATE SET image_id = EXCLUDED.image_id, code = EXCLUDED.code`,
      [libraryId, code, key, imageId]);
    await client.query('DELETE FROM swatch_ignored_codes WHERE library_id = $1 AND code_key = $2', [libraryId, key]);
  }
}

async function getScanMeta() {
  return getSetting(SCAN_META_KEY, { status: 'never' });
}
async function setScanMeta(meta) {
  await setSetting(SCAN_META_KEY, meta);
}

module.exports = {
  DEFAULT_CONFIG, getConfig, saveConfig, ruleOptionFor,
  listLibraries, getLibrary, libraryForVendor, validateLibrary,
  imageWithCodes, listImages, codeConflicts, assignCodes,
  getScanMeta, setScanMeta,
};
