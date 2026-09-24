// Shared data helpers for Import Products (buyer) and New Products (online),
// added 2026-09-24. See claude/IMPORT_PRODUCTS_FEATURE_SPEC.md.
const { pool } = require('../database/init');
const { gql } = require('./shopifyGql');

// ─── app_settings helpers ────────────────────────────────────────────────────
async function getSetting(key, fallback) {
  const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// ─── Shared location map ─────────────────────────────────────────────────────
// name → shopify location gid, active rows only (same table every page uses).
async function locationIdsByName(names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const r = await pool.query(
    'SELECT location_name, shopify_location_id FROM location_map WHERE is_active = TRUE AND location_name = ANY($1)',
    [names]
  );
  const byName = new Map(r.rows.map(x => [x.location_name, x.shopify_location_id]));
  return names.filter(n => byName.has(n)).map(n => ({ name: n, id: byName.get(n) }));
}

// ─── Metafield definitions ───────────────────────────────────────────────────
async function fetchDefinitions(ownerType) {
  const out = [];
  let after = null;
  for (;;) {
    const data = await gql(
      `query($owner: MetafieldOwnerType!, $after: String) {
        metafieldDefinitions(first: 250, ownerType: $owner, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { namespace key name type { name } validations { name value } }
        }
      }`,
      { owner: ownerType, after }
    );
    const page = data.metafieldDefinitions;
    for (const d of page.nodes) {
      let choices = null;
      const v = (d.validations || []).find(x => x.name === 'choices');
      if (v) {
        try { choices = JSON.parse(v.value); } catch (e) { choices = null; }
      }
      out.push({
        level: ownerType === 'PRODUCT' ? 'product' : 'variant',
        namespace: d.namespace,
        key: d.key,
        name: d.name,
        type: d.type && d.type.name,
        choices: Array.isArray(choices) ? choices.map(String) : null,
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return out;
}

async function fetchAllDefinitions() {
  const [p, v] = await Promise.all([fetchDefinitions('PRODUCT'), fetchDefinitions('PRODUCTVARIANT')]);
  return [...p, ...v];
}

function findDefinition(defs, level, namespace, key) {
  return defs.find(d => d.level === level && d.namespace === namespace && d.key === key) || null;
}

// Convert a CSV cell (string) into the value string Shopify expects for this
// metafield type. Returns { value } or { error }.
function toMetafieldValue(type, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!type) return { error: 'unknown metafield type' };
  if (/reference/.test(type)) return { error: `type ${type} is not supported by import` };
  if (type === 'boolean') {
    const b = parseBool(s);
    if (b === null) return { error: `"${s}" is not true/false` };
    return { value: b ? 'true' : 'false' };
  }
  if (type === 'number_integer') {
    if (!/^-?\d+$/.test(s)) return { error: `"${s}" is not a whole number` };
    return { value: s };
  }
  if (type === 'number_decimal') {
    if (!/^-?\d+(\.\d+)?$/.test(s)) return { error: `"${s}" is not a number` };
    return { value: s };
  }
  if (type.startsWith('list.')) {
    // Already JSON (e.g. copied from another export)?
    if (s.startsWith('[')) {
      try { JSON.parse(s); return { value: s }; } catch (e) { return { error: 'invalid list JSON' }; }
    }
    const parts = s.split(/[;,]/).map(x => x.trim()).filter(Boolean);
    const inner = type.slice(5);
    if (inner === 'number_integer' || inner === 'number_decimal') {
      if (parts.some(p => isNaN(Number(p)))) return { error: `"${s}" contains a non-number` };
      return { value: JSON.stringify(parts.map(Number)) };
    }
    return { value: JSON.stringify(parts) };
  }
  if (['json', 'rating', 'dimension', 'weight', 'volume', 'money', 'rich_text_field'].includes(type)) {
    try { JSON.parse(s); return { value: s }; } catch (e) { return { error: `type ${type} needs a JSON value` }; }
  }
  return { value: s };
}

function parseBool(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

// ─── Publications (sales channels) ───────────────────────────────────────────
// Publication.name is deprecated; try it first and fall back to catalog.title.
async function listPublications() {
  const withName = `{ publications(first: 50) { nodes { id name catalog { title } } } }`;
  const withoutName = `{ publications(first: 50) { nodes { id catalog { title } } } }`;
  let data;
  try {
    data = await gql(withName);
  } catch (e) {
    data = await gql(withoutName);
  }
  return data.publications.nodes.map(p => ({
    id: p.id,
    name: p.name || (p.catalog && p.catalog.title) || p.id,
  }));
}

async function findPosPublication() {
  const pubs = await listPublications();
  return pubs.find(p => /point of sale/i.test(p.name)) || null;
}

// ─── HTML helpers (description tooltip) ──────────────────────────────────────
const ALLOWED_TAGS = new Set(['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'blockquote', 'table', 'tr', 'td', 'th', 'tbody', 'thead']);

// Images → {picture}; drop script/style/iframe blocks; keep only a small set
// of formatting tags and strip ALL attributes, so the stored HTML is safe to
// render in the tooltip.
function sanitizeHtml(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style|iframe|object|embed|svg|noscript)[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<img\b[^>]*>/gi, '{picture}');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g, (m, tag) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (t === 'br') return '<br>';
    return m.startsWith('</') ? `</${t}>` : `<${t}>`;
  });
  return s.trim();
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|div|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  getSetting, setSetting, locationIdsByName,
  fetchAllDefinitions, fetchDefinitions, findDefinition, toMetafieldValue, parseBool,
  listPublications, findPosPublication,
  sanitizeHtml, htmlToText,
};
