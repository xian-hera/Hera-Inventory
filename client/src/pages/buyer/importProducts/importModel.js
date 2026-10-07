// Import Products — CSV model (2026-09-24).
// Pure functions: header recognition, preset filling, product grouping,
// validation, and building the payload sent to /api/import-products/import.
// Spec: claude/IMPORT_PRODUCTS_FEATURE_SPEC.md §4–§7.

export const MAX_ROWS = 500;
export const MAX_COLUMNS = 100;

// ─── Fields ──────────────────────────────────────────────────────────────────
// level: which Shopify object the value belongs to.
export const FIELDS = {
  handle: { level: 'product', label: 'Handle' },
  title: { level: 'product', label: 'Title' },
  descriptionHtml: { level: 'product', label: 'Description' },
  vendor: { level: 'product', label: 'Vendor' },
  category: { level: 'product', label: 'Product category' },
  productType: { level: 'product', label: 'Type' },
  tags: { level: 'product', label: 'Tags' },
  status: { level: 'product', label: 'Status' },
  seoTitle: { level: 'product', label: 'SEO title' },
  seoDescription: { level: 'product', label: 'SEO description' },
  giftCard: { level: 'product', label: 'Gift card' },
  option1Name: { level: 'product', label: 'Option1 name' },
  option2Name: { level: 'product', label: 'Option2 name' },
  option3Name: { level: 'product', label: 'Option3 name' },
  option1Value: { level: 'variant', label: 'Option1 value' },
  option2Value: { level: 'variant', label: 'Option2 value' },
  option3Value: { level: 'variant', label: 'Option3 value' },
  sku: { level: 'variant', label: 'SKU' },
  barcode: { level: 'variant', label: 'Barcode' },
  price: { level: 'variant', label: 'Price' },
  compareAtPrice: { level: 'variant', label: 'Compare-at price' },
  cost: { level: 'variant', label: 'Cost per item' },
  taxable: { level: 'variant', label: 'Charge tax' },
  taxCode: { level: 'variant', label: 'Tax code' },
  weight: { level: 'variant', label: 'Weight (grams)' },
  weightUnit: { level: 'variant', label: 'Weight unit' },
  tracked: { level: 'variant', label: 'Inventory tracker' },
  inventoryPolicy: { level: 'variant', label: 'Continue selling' },
  requiresShipping: { level: 'variant', label: 'Requires shipping' },
};

// Both Shopify CSV formats (new template + old export), lower-cased.
const ALIASES = {
  'url handle': 'handle', 'handle': 'handle',
  'title': 'title',
  'description': 'descriptionHtml', 'body (html)': 'descriptionHtml', 'body html': 'descriptionHtml',
  'vendor': 'vendor',
  'product category': 'category', 'category': 'category',
  'type': 'productType', 'product type': 'productType',
  'tags': 'tags',
  'status': 'status',
  'seo title': 'seoTitle', 'seo description': 'seoDescription',
  'gift card': 'giftCard',
  'option1 name': 'option1Name', 'option2 name': 'option2Name', 'option3 name': 'option3Name',
  'option1 value': 'option1Value', 'option2 value': 'option2Value', 'option3 value': 'option3Value',
  'sku': 'sku', 'variant sku': 'sku',
  'barcode': 'barcode', 'barcodes': 'barcode', 'variant barcode': 'barcode', 'variant barcodes': 'barcode',
  'price': 'price', 'variant price': 'price',
  'compare-at price': 'compareAtPrice', 'compare at price': 'compareAtPrice', 'variant compare at price': 'compareAtPrice',
  'cost per item': 'cost', 'cost': 'cost',
  'charge tax': 'taxable', 'variant taxable': 'taxable', 'taxable': 'taxable',
  'tax code': 'taxCode', 'variant tax code': 'taxCode',
  'weight value (grams)': 'weight', 'variant grams': 'weight', 'grams': 'weight',
  'weight unit for display': 'weightUnit', 'variant weight unit': 'weightUnit',
  'inventory tracker': 'tracked', 'variant inventory tracker': 'tracked',
  'continue selling when out of stock': 'inventoryPolicy', 'variant inventory policy': 'inventoryPolicy',
  'requires shipping': 'requiresShipping', 'variant requires shipping': 'requiresShipping',
};

// Columns deliberately not imported (spec §5.1): images, online-store
// publishing, market prices, stock quantity, Google Shopping, etc.
const IGNORED = [
  /^product image url$/, /^image src$/, /^image position$/, /^image alt text$/, /^variant image( url)?$/,
  /^published( on online store)?$/, /^option[123] linked to$/,
  /^inventory quantity$/, /^variant inventory qty$/,
  /^(variant )?fulfillment service$/,
  /^unit price /, /^(price|compare at price|included) \//,
  /^google shopping \//, /^gift card template/,
];

const MF_IN_PARENS = /\((product|variant)\.metafields\.([^.()\s]+)\.([^()\s]+)\)\s*$/i;

// Header ↔ metafield display name (2026-10-06, Hera): "Package Qty",
// "package_qty" and "Package-Qty" all match the metafield named
// "Package_Qty". Case is ignored; spaces, "_" and "-" count as the same.
// Only the store's own "custom" metafields are matched this way (Shopify's
// standard category metafields also use names like "Material"/"Texture").
export const headerKey = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/[\s_\-]+/g, '');
const isImportableDef = (d) => d && !/reference/.test(d.type || '') && d.namespace !== 'shopify';

// Every field / metafield a column can be assigned to by hand
// (Manually Assign). value is a stable string id.
export function assignTargets(definitions) {
  const out = [];
  for (const [field, f] of Object.entries(FIELDS)) {
    out.push({ value: `field:${field}`, label: `${f.label} (${f.level})`, target: { kind: 'field', field } });
  }
  for (const d of definitions || []) {
    if (!isImportableDef(d)) continue;
    out.push({
      value: `mf:${d.level}.${d.namespace}.${d.key}`,
      label: `${d.name || d.key} (${d.level})`,
      target: { kind: 'metafield', level: d.level, namespace: d.namespace, key: d.key },
    });
  }
  return out;
}
export const columnTargetValue = (c) => (c.kind === 'field' ? `field:${c.field}`
  : c.kind === 'metafield' ? `mf:${c.level}.${c.namespace}.${c.key}` : '');
const MF_SHORT = /^(product|variant)\.(?:metafields\.)?([^.\s]+)\.([^.\s]+)$/i;

// ─── Presets ─────────────────────────────────────────────────────────────────
export const PRESETS = [
  { key: 'status', label: 'Status', level: 'product', options: ['Active', 'Draft'], defaultValue: 'Active' },
  { key: 'channel', label: 'Channel', level: 'product', options: ['Point of Sale'], defaultValue: 'Point of Sale', readOnly: true },
  { key: 'posOnly', label: 'POS only', level: 'product', options: ['True', 'False'], defaultValue: 'csv', mf: { namespace: 'custom', key: 'pos_only' } },
  { key: 'discontinued', label: 'Discontinued', level: 'variant', options: ['True', 'False'], defaultValue: 'csv', mf: { namespace: 'custom', key: 'discontinued' } },
  { key: 'chargeTax', label: 'Charge tax', level: 'variant', options: ['Yes', 'No'], defaultValue: 'Yes' },
];
export const PRESET_BY_KEY = Object.fromEntries(PRESETS.map(p => [p.key, p]));

// Dropdown columns backed by Settings pools (spec §6.4).
// 2026-09-25 (Hera): Sub collection and Display section were taken out of
// this map. Sub collection's options now depend on the row's Sub type
// (subCollectionOptions below); Display section offers the metafield's own
// choices and is only imported when the Type is HAIR & SKIN CARE.
export const POOL_METAFIELDS = {
  'product.custom.sub_type': 'subTypes',
};

const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

// ─── Sub type → Sub collection, Display section (2026-09-25, Hera) ──────────
export const DISPLAY_SECTION_TYPE = 'HAIR & SKIN CARE';
const isMf = (c, level, key) => c && c.kind === 'metafield' && c.level === level && lc(c.namespace) === 'custom' && lc(c.key) === key;
export const isSubTypeCol = (c) => isMf(c, 'product', 'sub_type');
export const isSubCollectionCol = (c) => isMf(c, 'product', 'sub_collection');
export const isDisplaySectionCol = (c) => isMf(c, 'variant', 'display_section');

export function subCollectionKey(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
}
// Same rule as the server: "KIDS" → "Kids", "lace front" → "Lace Front".
export function titleCase(v) {
  return subCollectionKey(v).replace(/(^|[\s\-/(])([a-z\u00e0-\u00ff])/g, (m, p, c) => p + c.toUpperCase());
}

// custom.sub_collection is a LIST metafield. A cell may hold one value,
// several ("Bang, Wrap" or "Bang; Wrap"), or Shopify's JSON ('["Bang"]').
// Items are shown and written as plain text joined by ", " — the server
// turns that into the JSON list Shopify expects (2026-09-25).
export function subCollectionItems(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    } catch (e) { /* not JSON */ }
  }
  return s.split(/[;,]/).map(x => x.trim()).filter(Boolean);
}
export function formatSubCollection(v) {
  return subCollectionItems(v).map(titleCase).join(', ');
}

// Display section is only imported for HAIR & SKIN CARE: for any other Type
// its column is shown greyed out and ignored (and named in the report).
export function applyTypeRules(columns, productType) {
  const hsc = lc(productType) === lc(DISPLAY_SECTION_TYPE);
  return columns.map(c => (isDisplaySectionCol(c) && !hsc
    ? { ...c, kind: 'unmatched', typeSkipped: true, reason: `Display section is only imported for ${DISPLAY_SECTION_TYPE}` }
    : c));
}

// Sub collection values from the CSV are shown/imported in Title Case.
export function normalizeSubCollections(rows, columns) {
  const sc = columns.find(isSubCollectionCol);
  if (!sc) return rows;
  return rows.map(r => {
    const v = r.values[sc.id];
    if (isBlank(v)) return r;
    return { ...r, values: { ...r.values, [sc.id]: formatSubCollection(v) } };
  });
}

// Options for a row's Sub collection cell: the values assigned (in Import
// Settings) to the row's Sub type. null = the row has no Sub type yet.
export function subCollectionOptions(row, columns, pools, isFirstOfGroup, presets) {
  const stCol = columns.find(isSubTypeCol);
  if (!stCol) return null;
  const st = String(effectiveCell(row, stCol, { isFirstOfGroup, presets: presets || {} }).value).trim();
  if (!st) return null;
  const map = pools.subCollectionsBySubType || {};
  const hit = Object.keys(map).find(k => lc(k) === lc(st));
  return hit ? map[hit] : [];
}

export function parseBool(v) {
  const s = lc(v);
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

// ─── Columns ─────────────────────────────────────────────────────────────────
// Returns { columns, ignoredHeaders }.
// column: { id, header, csvIndex, kind: 'field'|'metafield'|'shopifyMf'|'unmatched'|'preset',
//           field?, level, namespace?, key?, def?, preset?, synthetic? }
// manual (2026-10-06): { [csvIndex]: target } from Manually Assign, where
// target = { kind: 'field', field } | { kind: 'metafield', level, namespace, key }.
// A manual choice wins over automatic matching for that column.
export function buildColumns(headers, definitions, manual = {}) {
  const columns = [];
  const ignoredHeaders = [];
  const usedFields = new Set();
  // Custom metafields by display name (see headerKey). A name used at both
  // product and variant level is ambiguous → left for Manually Assign.
  const byName = new Map();
  for (const d of definitions || []) {
    if (!isImportableDef(d) || d.namespace !== 'custom') continue;
    const k = headerKey(d.name);
    if (!k) continue;
    byName.set(k, byName.has(k) ? 'ambiguous' : d);
  }
  // Fields claimed by hand are not given to another column automatically.
  for (const t of Object.values(manual || {})) if (t && t.kind === 'field') usedFields.add(t.field);

  headers.forEach((raw, csvIndex) => {
    const header = String(raw == null ? '' : raw).trim();
    const l = lc(header);
    const id = `c${csvIndex}`;
    if (!header) { ignoredHeaders.push(`(blank column ${csvIndex + 1})`); return; }
    const m0 = manual && manual[csvIndex];
    if (m0 && m0.kind === 'field' && FIELDS[m0.field]) {
      columns.push({ id, header, csvIndex, kind: 'field', field: m0.field, level: FIELDS[m0.field].level, manual: true });
      return;
    }
    if (m0 && m0.kind === 'metafield') {
      const def = (definitions || []).find(d => d.level === m0.level && d.namespace === m0.namespace && d.key === m0.key);
      if (def) { columns.push({ id, header, csvIndex, kind: 'metafield', level: def.level, namespace: def.namespace, key: def.key, def, manual: true }); return; }
    }
    if (IGNORED.some(re => re.test(l))) { ignoredHeaders.push(header); return; }

    const field = ALIASES[l];
    if (field && !usedFields.has(field)) {
      usedFields.add(field);
      columns.push({ id, header, csvIndex, kind: 'field', field, level: FIELDS[field].level });
      return;
    }
    const m = header.match(MF_IN_PARENS) || header.match(MF_SHORT);
    if (m) {
      const level = m[1].toLowerCase();
      const namespace = m[2];
      const key = m[3];
      if (namespace === 'shopify') {
        columns.push({ id, header, csvIndex, kind: 'shopifyMf', level, namespace, key });
        return;
      }
      const def = definitions.find(d => d.level === level && d.namespace === namespace && d.key === key);
      if (def && !/reference/.test(def.type || '')) {
        columns.push({ id, header, csvIndex, kind: 'metafield', level, namespace, key, def });
      } else {
        columns.push({ id, header, csvIndex, kind: 'unmatched', level, namespace, key,
          reason: def ? `Metafield type ${def.type} can't be imported` : 'No matching metafield definition in Shopify' });
      }
      return;
    }
    // Metafield display name (2026-10-06).
    const named = byName.get(headerKey(header));
    if (named && named !== 'ambiguous') {
      columns.push({ id, header, csvIndex, kind: 'metafield', level: named.level, namespace: named.namespace, key: named.key, def: named });
      return;
    }
    columns.push({ id, header, csvIndex, kind: 'unmatched', level: 'variant',
      reason: named === 'ambiguous' ? 'Matches both a product and a variant metafield — use Manually Assign' : 'Not a Shopify field or metafield' });
  });

  // Always have a Handle column, so auto-generated handles can be shown and
  // edited (spec §5.2) even when the CSV has no Handle column.
  if (!usedFields.has('handle')) {
    columns.unshift({ id: 'x_handle', header: 'Handle', csvIndex: null, kind: 'field', field: 'handle', level: 'product', synthetic: true });
  }

  // Sub type and Sub collection are always in the table (Hera 2026-10-08):
  // a CSV column (with or without values) is used as it is; when the CSV
  // has none, an empty column is added so the buyer can pick values from
  // the dropdowns. Empty added cells send nothing to Shopify.
  for (const [key, label] of [['sub_type', 'Sub type'], ['sub_collection', 'Sub collection']]) {
    const present = columns.some(c => c.kind === 'metafield' && c.level === 'product' && lc(c.namespace) === 'custom' && lc(c.key) === key);
    if (present) continue;
    const def = (definitions || []).find(d => d.level === 'product' && d.namespace === 'custom' && d.key === key);
    if (!def) continue;
    columns.push({ id: `x_${key}`, header: label, csvIndex: null, kind: 'metafield', level: 'product', namespace: 'custom', key, def, synthetic: true });
  }

  // Attach presets to their matching CSV column, or add a synthetic column.
  for (const p of PRESETS) {
    let col = null;
    if (p.key === 'status') col = columns.find(c => c.kind === 'field' && c.field === 'status');
    if (p.key === 'chargeTax') col = columns.find(c => c.kind === 'field' && c.field === 'taxable');
    if (p.mf) col = columns.find(c => c.kind === 'metafield' && c.level === p.level && lc(c.namespace) === p.mf.namespace && lc(c.key) === p.mf.key);
    if (col) {
      col.preset = p.key;
    } else {
      columns.push({ id: `p_${p.key}`, header: p.label, csvIndex: null, kind: 'preset', preset: p.key, level: p.level, synthetic: true,
        ...(p.mf ? { namespace: p.mf.namespace, key: p.mf.key } : {}) });
    }
  }
  return { columns, ignoredHeaders };
}

// Normalize a CSV value for a preset column so it matches the dropdown
// options (TRUE → True, active → Active …). Unknown values stay as-is and
// are flagged by validation.
export function normalizePresetValue(presetKey, v) {
  if (isBlank(v)) return '';
  const p = PRESET_BY_KEY[presetKey];
  if (presetKey === 'status') {
    const hit = p.options.find(o => lc(o) === lc(v));
    return hit || String(v).trim();
  }
  if (presetKey === 'posOnly' || presetKey === 'discontinued') {
    const b = parseBool(v);
    return b === null ? String(v).trim() : b ? 'True' : 'False';
  }
  if (presetKey === 'chargeTax') {
    const b = parseBool(v);
    return b === null ? String(v).trim() : b ? 'Yes' : 'No';
  }
  return String(v).trim();
}

// ─── Rows ────────────────────────────────────────────────────────────────────
// Raw CSV data rows → row objects. Blank rows and image-only rows (a Handle
// plus nothing but ignored image columns) are dropped.
export function buildRows(dataRows, columns) {
  const rows = [];
  dataRows.forEach((cells, i) => {
    const values = {};
    let meaningful = 0;
    for (const c of columns) {
      if (c.csvIndex == null) continue;
      let v = cells[c.csvIndex] == null ? '' : String(cells[c.csvIndex]);
      if (c.preset) v = normalizePresetValue(c.preset, v);
      values[c.id] = v;
      if (!isBlank(v) && !(c.kind === 'field' && c.field === 'handle')) meaningful++;
    }
    if (meaningful === 0) return;
    rows.push({ id: `r${i}`, rowNumber: i + 2, values, edits: {} });
  });
  return rows;
}

export function cellValue(row, col) {
  if (Object.prototype.hasOwnProperty.call(row.edits, col.id)) return row.edits[col.id];
  return row.values[col.id] == null ? '' : row.values[col.id];
}

export function colFor(columns, field) {
  return columns.find(c => c.kind === 'field' && c.field === field) || null;
}

export function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Add new grouping (spec §5.2): Handle → Title → "belongs to the row above".
// Update grouping: by the product each row matched in Shopify (precheck).
export function groupRows(rows, columns, mode, precheckRows) {
  const handleCol = colFor(columns, 'handle');
  const titleCol = colFor(columns, 'title');
  const groups = [];

  if (mode === 'update') {
    const byProduct = new Map();
    for (const r of rows) {
      const pc = precheckRows && precheckRows[r.rowNumber];
      const pid = pc && !pc.errors.length ? pc.productId : null;
      if (pid && byProduct.has(pid)) { byProduct.get(pid).rows.push(r); continue; }
      const g = { key: pid ? `p:${pid}` : `row:${r.id}`, rows: [r], productId: pid, productTitle: pc && pc.productTitle };
      if (pid) byProduct.set(pid, g);
      groups.push(g);
    }
    return groups;
  }

  const byKey = new Map();
  const byTitle = new Map();
  let prev = null;
  for (const r of rows) {
    const h = handleCol ? String(cellValue(r, handleCol)).trim() : '';
    const t = titleCol ? String(cellValue(r, titleCol)).trim() : '';
    let g = null;
    if (h) {
      g = byKey.get(`h:${lc(h)}`);
      if (!g) { g = { key: `h:${lc(h)}`, rows: [], handle: h, handleIsAuto: false }; byKey.set(g.key, g); groups.push(g); }
    } else if (t) {
      g = byTitle.get(lc(t)) || byKey.get(`t:${lc(t)}`);
      if (!g) { g = { key: `t:${lc(t)}`, rows: [], handle: slugify(t), handleIsAuto: true }; byKey.set(g.key, g); groups.push(g); }
    } else if (prev) {
      g = prev;
    } else {
      g = { key: `row:${r.id}`, rows: [], handle: '', handleIsAuto: true };
      groups.push(g);
    }
    if (g.rows.length === 0 && t) byTitle.set(lc(t), g);
    g.rows.push(r);
    prev = g;
  }
  return groups;
}

// ─── Effective values (CSV / edit / preset fill) ─────────────────────────────
// Returns { value, source: 'csv'|'edit'|'preset'|'empty' }.
export function effectiveCell(row, col, { isFirstOfGroup, presets }) {
  const edited = Object.prototype.hasOwnProperty.call(row.edits, col.id);
  const raw = cellValue(row, col);
  if (edited) return { value: raw, source: 'edit' };
  if (!isBlank(raw)) return { value: raw, source: 'csv' };
  if (col.preset) {
    const p = PRESET_BY_KEY[col.preset];
    const productLevelOk = p.level === 'variant' || isFirstOfGroup;
    const chosen = presets[col.preset];
    if (productLevelOk && chosen && chosen !== 'csv') return { value: chosen, source: 'preset' };
  }
  return { value: '', source: 'empty' };
}

// ─── Validation ──────────────────────────────────────────────────────────────
// Returns { cellErrors: {rowId: {colId: msg}}, rowErrors: {rowId: [msg]} (block),
//           skip: {groupKey: [msg]} (group will be skipped, not blocking),
//           notes: {rowId: [msg]} (grey info), existingRows: {rowId: true}
//           (first rows of groups that add variants to an existing product) }
export function validate({ rows, columns, groups, mode, presets, pools, precheck }) {
  const cellErrors = {};
  // Non-blocking notes (orange) — e.g. a Sub collection not listed under the
  // row's Sub type: it is still imported (Hera 2026-09-25).
  const cellWarnings = {};
  const addWarn = (r, c, m) => { (cellWarnings[r.id] = cellWarnings[r.id] || {})[c.id] = m; };
  const rowErrors = {};
  const skip = {};
  const addCell = (r, c, m) => { (cellErrors[r.id] = cellErrors[r.id] || {})[c.id] = m; };
  const addRow = (r, m) => { (rowErrors[r.id] = rowErrors[r.id] || []).push(m); };
  const addSkip = (g, m) => { (skip[g.key] = skip[g.key] || []).push(m); };
  // Add new with a filled Handle of an existing product (2026-10-07, Hera).
  const notes = {};
  const existingRows = {};
  const addNote = (r, m) => { (notes[r.id] = notes[r.id] || []).push(m); };
  const handleColV = colFor(columns, 'handle');
  const optNameCols = [1, 2, 3].map(i => colFor(columns, `option${i}Name`));

  const firstIds = new Set(groups.map(g => g.rows[0] && g.rows[0].id));
  // First rows of groups that add variants to an existing product: their
  // product-level cells are not imported, so they are not checked either.
  const existingFirstIds = new Set(mode === 'add' && precheck && precheck.existing
    ? groups.filter(g => precheck.existing[g.key] && g.rows[0]).map(g => g.rows[0].id) : []);
  const skuCol = colFor(columns, 'sku');
  const bcCol = colFor(columns, 'barcode');
  const titleCol = colFor(columns, 'title');
  const priceCols = ['price', 'compareAtPrice', 'cost', 'weight'].map(f => colFor(columns, f)).filter(Boolean);
  const optCols = [1, 2, 3].map(i => colFor(columns, `option${i}Value`));

  const seenSku = new Map();
  const seenBc = new Map();

  for (const r of rows) {
    const isFirst = firstIds.has(r.id);
    for (const c of columns) {
      const { value } = effectiveCell(r, c, { isFirstOfGroup: isFirst, presets });
      const v = String(value).trim();
      if (!v) continue;
      // Product-level values only count on a product's first row.
      if (c.level === 'product' && !isFirst && mode === 'add') continue;
      if (c.level === 'product' && existingFirstIds.has(r.id) && !(c.kind === 'field' && /^(handle|option\dName)$/.test(c.field))) continue;
      if (c.preset) {
        const p = PRESET_BY_KEY[c.preset];
        if (!p.options.includes(v)) addCell(r, c, `"${v}" is not one of: ${p.options.join(', ')}`);
        continue;
      }
      if (c.kind === 'metafield') {
        const poolName = POOL_METAFIELDS[`${c.level}.${c.namespace}.${c.key}`];
        if (isSubCollectionCol(c)) {
          const opts = subCollectionOptions(r, columns, pools, isFirst, presets);
          const missing = opts === null ? [] : subCollectionItems(v).filter(item => !opts.some(x => subCollectionKey(x) === subCollectionKey(item)));
          if (opts === null) addWarn(r, c, 'No Sub type on this row — will still be imported');
          else if (missing.length) addWarn(r, c, `${missing.map(m => `"${m}"`).join(', ')} not assigned to this Sub type in Import Settings — will still be imported`);
        } else if (poolName) {
          const pool = pools[poolName] || [];
          if (!pool.some(x => lc(x) === lc(v))) addCell(r, c, `"${v}" is not assigned to this Type in Import Settings`);
        } else if (c.def && c.def.type === 'boolean' && parseBool(v) === null) {
          addCell(r, c, `"${v}" is not true/false`);
        } else if (c.def && c.def.choices && c.def.choices.length && !c.def.type.startsWith('list.') && !c.def.choices.some(x => lc(x) === lc(v))) {
          addCell(r, c, `"${v}" is not one of the metafield's preset choices`);
        }
      }
      if (priceCols.includes(c) && !/^-?\d+(\.\d+)?$/.test(v.replace(/,/g, ''))) addCell(r, c, `"${v}" is not a number`);
      // Shopify rejects negative prices / costs / weights (2026-10-06, Hera:
      // block them here so the buyer fixes them before importing).
      else if (priceCols.includes(c) && Number(v.replace(/,/g, '')) < 0) addCell(r, c, `${FIELDS[c.field].label} "${v}" can't be negative`);
      if (c === bcCol && /[;,|]/.test(v)) addCell(r, c, 'Only one barcode per variant can be imported for now');
    }

    const sku = skuCol ? String(cellValue(r, skuCol)).trim() : '';
    const bc = bcCol ? String(cellValue(r, bcCol)).trim() : '';
    if (sku) { if (seenSku.has(sku)) { addCell(r, skuCol, `Duplicate SKU (also row ${seenSku.get(sku)})`); } else seenSku.set(sku, r.rowNumber); }
    if (bc) { if (seenBc.has(bc)) { addCell(r, bcCol, `Duplicate barcode (also row ${seenBc.get(bc)})`); } else seenBc.set(bc, r.rowNumber); }
  }

  if (mode === 'add') {
    for (const g of groups) {
      const first = g.rows[0];
      const pcFirst = precheck && precheck.rows ? precheck.rows[first.rowNumber] : null;
      const ex = precheck && precheck.existing ? precheck.existing[g.key] : null;
      // Handle filled but not in Shopify → red, blocks (2026-10-07).
      if (pcFirst && pcFirst.handleError && handleColV) addCell(first, handleColV, pcFirst.handleError);
      // Auto handle already used by another product → orange note only.
      const col = precheck && precheck.autoHandleCollisions ? precheck.autoHandleCollisions[g.key] : null;
      if (col && handleColV) addWarn(first, handleColV, `A product with this handle already exists (${col.title}). To add variants to it, fill in its Handle.`);
      if (ex) {
        existingRows[first.id] = true;
        addNote(first, `Adds ${g.rows.length} new variant(s) to "${ex.title}" — the product's own fields are not changed`);
        if (!ex.hasOptions) {
          addRow(first, `"${ex.title}" has no options in Shopify — add options to it in Shopify first`);
        } else {
          const n = ex.optionNames.length;
          // Option names are required and case sensitive (Hera 2026-10-07).
          optNameCols.forEach((c, i) => {
            const v = c ? String(effectiveCell(first, c, { isFirstOfGroup: true, presets }).value).trim() : '';
            if (i < n && !c) { addRow(first, `Add the column Option${i + 1} name ("${ex.optionNames[i]}")`); return; }
            if (i < n && !v) { addCell(first, c, `Option${i + 1} name is required: "${ex.optionNames[i]}"`); return; }
            if (!v) return;
            if (i >= n) addCell(first, c, `"${ex.title}" has only ${n} option(s)`);
            else if (v !== ex.optionNames[i]) {
              addCell(first, c, lc(v) === lc(ex.optionNames[i])
                ? `Option names are case sensitive — use "${ex.optionNames[i]}", not "${v}"`
                : `Option${i + 1} name must be "${ex.optionNames[i]}" (the product's option)`);
            }
          });
          const existingCombos = new Set(ex.combos || []);
          const combos = new Set();
          for (const r of g.rows) {
            const vals = optCols.map(c => (c ? String(cellValue(r, c)).trim() : ''));
            if (vals.slice(0, n).some(x => !x)) { addRow(r, `Needs a value for every option: ${ex.optionNames.join(', ')}`); continue; }
            if (vals.slice(n).some(x => x)) { addRow(r, `"${ex.title}" has only ${n} option(s)`); continue; }
            const k = vals.slice(0, n).map(lc).join('|');
            if (existingCombos.has(k)) addRow(r, `Variant "${vals.slice(0, n).join(' / ')}" already exists in "${ex.title}"`);
            else if (combos.has(k)) addRow(r, 'Multiple variants need unique option values');
            combos.add(k);
          }
        }
        if (precheck) {
          const msgs = [];
          for (const r of g.rows) {
            const pc = precheck.rows[r.rowNumber];
            if (pc && pc.errors.length) msgs.push(...pc.errors);
          }
          if (msgs.length) addSkip(g, `No variants will be added to this product — ${[...new Set(msgs)].join('; ')}`);
        }
        continue;
      }
      const t = titleCol ? String(effectiveCell(first, titleCol, { isFirstOfGroup: true, presets }).value).trim() : '';
      // (No Title message when the Handle itself is wrong — fix that first.)
      if (!t && !(pcFirst && pcFirst.handleError)) addRow(first, 'First row of a product needs a Title');
      // An option value needs its option name on the product's first row
      // (Hera 2026-10-07).
      optCols.forEach((vc, i) => {
        if (!vc || !g.rows.some(r => String(cellValue(r, vc)).trim())) return;
        const nc = optNameCols[i];
        const name = nc ? String(effectiveCell(first, nc, { isFirstOfGroup: true, presets }).value).trim() : '';
        if (!nc) addRow(first, `Add the column Option${i + 1} name (Option${i + 1} value is used)`);
        else if (!name) addCell(first, nc, `Option${i + 1} name is required when Option${i + 1} value is used`);
      });
      if (g.rows.length > 1) {
        const combos = new Set();
        for (const r of g.rows) {
          const vals = optCols.map(c => (c ? String(cellValue(r, c)).trim() : ''));
          if (vals.every(x => !x)) { addRow(r, 'Multiple variants need option values'); continue; }
          const k = vals.join('|').toLowerCase();
          if (combos.has(k)) addRow(r, 'Multiple variants need unique option values');
          combos.add(k);
        }
      }
      if (precheck) {
        const msgs = [];
        for (const r of g.rows) {
          const pc = precheck.rows[r.rowNumber];
          if (pc && pc.errors.length) msgs.push(...pc.errors);
        }
        if (msgs.length) addSkip(g, `Whole product will be skipped — ${[...new Set(msgs)].join('; ')}`);
      }
    }
  } else if (precheck) {
    for (const g of groups) {
      for (const r of g.rows) {
        const pc = precheck.rows[r.rowNumber];
        if (pc && pc.errors.length) addSkip(g, `Row ${r.rowNumber} will be skipped — ${pc.errors.join('; ')}`);
      }
    }
  }
  return { cellErrors, cellWarnings, rowErrors, skip, notes, existingRows };
}

// Product-level value conflicts inside a group (first row wins, highlighted).
export function productLevelConflicts(groups, columns) {
  const out = {};
  for (const g of groups) {
    if (g.rows.length < 2) continue;
    for (const c of columns) {
      if (c.level !== 'product' || c.csvIndex == null || (c.kind === 'field' && c.field === 'handle')) continue;
      const firstVal = String(cellValue(g.rows[0], c)).trim();
      for (const r of g.rows.slice(1)) {
        const v = String(cellValue(r, c)).trim();
        if (v && v !== firstVal) (out[r.id] = out[r.id] || {})[c.id] = `Differs from the first row ("${firstVal}") — the first row is used`;
      }
    }
  }
  return out;
}

// ─── Payload ─────────────────────────────────────────────────────────────────
function presetToField(presetKey, value) {
  const v = String(value).trim();
  if (presetKey === 'status') return v;
  if (presetKey === 'chargeTax') return v === 'Yes' ? 'true' : v === 'No' ? 'false' : v;
  if (presetKey === 'posOnly' || presetKey === 'discontinued') return v === 'True' ? 'true' : v === 'False' ? 'false' : v;
  return v;
}

export function buildPayload({ groups, columns, mode, presets, precheck, skip }) {
  const products = [];
  for (const g of groups) {
    if (skip[g.key] && mode === 'add') continue;
    const first = g.rows[0];
    const ctxFirst = { isFirstOfGroup: true, presets };
    const fields = {};
    const productMetafields = [];
    const optionNames = [];

    for (const c of columns) {
      if (c.level !== 'product') continue;
      const cell = effectiveCell(first, c, ctxFirst);
      // A synthetic preset column left on "Read from CSV" has nothing to send.
      if (c.synthetic && cell.source === 'empty') continue;
      if (c.preset === 'channel') continue;
      if (c.preset === 'status' || (c.kind === 'field')) {
        const f = c.preset === 'status' ? 'status' : c.field;
        if (f === 'handle' && mode === 'update') continue;
        const m = f && f.match(/^option(\d)Name$/);
        if (m) { optionNames[Number(m[1]) - 1] = String(cell.value).trim(); continue; }
        fields[f] = c.preset ? presetToField(c.preset, cell.value) : cell.value;
      } else if (c.kind === 'metafield' || (c.kind === 'preset' && c.namespace)) {
        let value = c.preset ? presetToField(c.preset, cell.value) : cell.value;
        if (isSubCollectionCol(c) && !isBlank(value)) value = formatSubCollection(value); // plain items, Title Case (2026-09-25)
        productMetafields.push({ namespace: c.namespace, key: c.key, value });
      }
    }

    const variants = g.rows.map((r, idx) => {
      const ctx = { isFirstOfGroup: idx === 0, presets };
      const vf = {};
      const vm = [];
      const optionValues = [];
      for (const c of columns) {
        if (c.level !== 'variant') continue;
        const cell = effectiveCell(r, c, ctx);
        if (c.synthetic && cell.source === 'empty') continue;
        if (c.kind === 'field' || c.preset === 'chargeTax') {
          const f = c.preset === 'chargeTax' ? 'taxable' : c.field;
          const m = f.match(/^option(\d)Value$/);
          if (m) { optionValues[Number(m[1]) - 1] = String(cell.value).trim(); continue; }
          vf[f] = c.preset ? presetToField(c.preset, cell.value) : cell.value;
        } else if (c.kind === 'metafield' || (c.kind === 'preset' && c.namespace)) {
          vm.push({ namespace: c.namespace, key: c.key, value: c.preset ? presetToField(c.preset, cell.value) : cell.value });
        }
      }
      // Update matching uses the row's own Handle (product-level column).
      if (mode === 'update') {
        const hc = colFor(columns, 'handle');
        if (hc) vf.handle = String(cellValue(r, hc)).trim();
      }
      return { rowNumber: r.rowNumber, fields: vf, metafields: vm, optionValues };
    });

    const handleCol = colFor(columns, 'handle');
    const manualHandle = handleCol ? String(cellValue(first, handleCol)).trim() : '';
    const autoHandle = precheck && precheck.autoHandles ? precheck.autoHandles[g.key] : '';
    // New variants for an existing product (2026-10-07): the server uses the
    // product's own option names and never changes its product fields.
    const ex = mode === 'add' && precheck && precheck.existing ? precheck.existing[g.key] : null;
    if (ex) {
      products.push({
        key: g.key,
        title: ex.title,
        productId: null,
        handle: manualHandle,
        handleIsAuto: false,
        existing: { productId: ex.productId, title: ex.title, optionNames: ex.optionNames },
        fields: {},
        optionNames: ex.optionNames,
        metafields: [],
        variants,
      });
      continue;
    }
    products.push({
      key: g.key,
      title: String(fields.title || g.productTitle || '').trim(),
      productId: g.productId || null,
      handle: mode === 'add' ? (manualHandle || autoHandle || g.handle || '') : '',
      handleIsAuto: mode === 'add' && !manualHandle,
      fields,
      optionNames,
      metafields: productMetafields,
      variants,
    });
  }
  return products;
}
