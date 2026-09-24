// Import Products — matching (precheck) + background import job.
// Added 2026-09-24. Spec: claude/IMPORT_PRODUCTS_FEATURE_SPEC.md §7.
//
// The client sends already-normalized products (presets applied, rows
// grouped into products). This file re-checks every identifier right before
// writing (the precheck the client showed may be minutes old), then writes
// in steps so a product can end "partial" instead of all-or-nothing:
//   Add new : 1 productSet (core + variants + 0 stock at chosen locations)
//             2 metafieldsSet  3 publish to Point of Sale  4 new_arrival row
//   Update  : 1 productUpdate  2 productVariantsBulkUpdate  3 metafields
//             4 publish to Point of Sale  5 activate chosen locations
// Hub never deletes Shopify products.
const crypto = require('crypto');
const { pool } = require('../database/init');
const { gql, userErrorText, searchQuote } = require('../services/shopifyGql');
const {
  getSetting, locationIdsByName, fetchAllDefinitions, findDefinition,
  toMetafieldValue, parseBool, findPosPublication,
} = require('../services/productData');
const { refreshRows } = require('../services/newArrival');

const STATUS_FILTER = '(product_status:active OR product_status:draft)';

// ─── Lookups ─────────────────────────────────────────────────────────────────
// Variants whose sku / barcode equals one of `values` (Active + Draft only —
// an Archived "OLD-xxx" duplicate that still carries the old barcode must
// never match or block anything; see claude/OLD_SKU_INCIDENT_FIX.md).
async function findVariants(field, values) {
  const result = new Map();
  const list = [...new Set(values.map(v => String(v || '').trim()).filter(Boolean))];
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    const parts = chunk.map((v, j) =>
      `a${j}: productVariants(first: 10, query: ${JSON.stringify(`${field}:${searchQuote(v)} AND ${STATUS_FILTER}`)}) {
        nodes { id sku barcode inventoryItem { id } product { id title handle status } }
      }`).join('\n');
    const data = await gql(`{ ${parts} }`);
    chunk.forEach((v, j) => {
      const nodes = ((data[`a${j}`] && data[`a${j}`].nodes) || [])
        .filter(n => n.product && n.product.status !== 'ARCHIVED')
        // SKU search is token based — keep exact matches only. Barcode search
        // matches ANY of a variant's barcodes (multi-barcode), so keep all.
        .filter(n => field !== 'sku' || String(n.sku || '').trim() === v);
      result.set(v, nodes);
    });
  }
  return result;
}

// handle → product (ANY status: Shopify handles are unique across statuses).
async function findHandles(handles) {
  const result = new Map();
  const list = [...new Set(handles.map(h => String(h || '').trim()).filter(Boolean))];
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    const parts = chunk.map((h, j) =>
      `h${j}: productByIdentifier(identifier: { handle: ${JSON.stringify(h)} }) {
        id title handle status
        variants(first: 2) { nodes { id sku barcode inventoryItem { id } } }
      }`).join('\n');
    const data = await gql(`{ ${parts} }`);
    chunk.forEach((h, j) => result.set(h, data[`h${j}`] || null));
  }
  return result;
}

// Pick a free handle: base, base-1, base-2 … not used in Shopify and not
// already taken by another product in this same import.
async function resolveAutoHandles(bases, reserved) {
  const out = new Map();
  const taken = new Set(reserved);
  for (const base of bases) {
    if (!base) continue;
    const candidates = [base, ...Array.from({ length: 9 }, (_, i) => `${base}-${i + 1}`)];
    const found = await findHandles(candidates);
    const pick = candidates.find(c => !found.get(c) && !taken.has(c)) || `${base}-${Date.now()}`;
    taken.add(pick);
    out.set(base, pick);
  }
  return out;
}

// ─── Precheck ────────────────────────────────────────────────────────────────
// rows: [{ rowNumber, groupKey, handle, handleIsAuto, sku, barcode }]
// Add:    { rows: { [rowNumber]: { errors: [] } }, autoHandles: { [groupKey]: handle } }
// Update: { rows: { [rowNumber]: { errors: [], productId, productTitle, variantId, inventoryItemId } } }
async function precheck(mode, rows) {
  const out = { rows: {}, autoHandles: {} };
  for (const r of rows) out.rows[r.rowNumber] = { errors: [] };

  const skus = await findVariants('sku', rows.map(r => r.sku));
  const barcodes = await findVariants('barcode', rows.map(r => r.barcode));
  const manualHandles = rows.filter(r => r.handle && !r.handleIsAuto).map(r => r.handle);
  const handles = await findHandles(manualHandles);

  if (mode === 'add') {
    for (const r of rows) {
      const res = out.rows[r.rowNumber];
      const h = String(r.handle || '').trim();
      if (h && !r.handleIsAuto && handles.get(h)) {
        const p = handles.get(h);
        res.errors.push(`Handle "${h}" already exists${p.status === 'ARCHIVED' ? ' (archived product)' : ''}`);
      }
      const sku = String(r.sku || '').trim();
      if (sku && (skus.get(sku) || []).length) res.errors.push(`SKU ${sku} already exists`);
      const bc = String(r.barcode || '').trim();
      if (bc && (barcodes.get(bc) || []).length) res.errors.push(`Barcode ${bc} already exists`);
    }
    // One auto handle per product group.
    const autoBases = [];
    const baseByGroup = {};
    for (const r of rows) {
      if (r.handleIsAuto && r.handle && !baseByGroup[r.groupKey]) {
        baseByGroup[r.groupKey] = r.handle;
        autoBases.push(r.handle);
      }
    }
    const reserved = manualHandles;
    const resolved = await resolveAutoHandles([...new Set(autoBases)], reserved);
    // Two groups can share the same base (same title) only if the client
    // grouped them apart; give each its own suffix.
    const used = new Set(reserved);
    for (const [groupKey, base] of Object.entries(baseByGroup)) {
      let pick = resolved.get(base);
      if (used.has(pick)) {
        const more = await resolveAutoHandles([base], [...used]);
        pick = more.get(base);
      }
      used.add(pick);
      out.autoHandles[groupKey] = pick;
    }
    return out;
  }

  // Update existing — every identifier given on the row must point to the
  // same variant, otherwise the row is not a match.
  for (const r of rows) {
    const res = out.rows[r.rowNumber];
    const sku = String(r.sku || '').trim();
    const bc = String(r.barcode || '').trim();
    const h = String(r.handle || '').trim();
    let variant = null;

    if (!sku && !bc && !h) { res.errors.push('No Handle, SKU or Barcode to match'); continue; }

    if (sku) {
      const list = skus.get(sku) || [];
      if (list.length === 0) { res.errors.push(`SKU ${sku} not found`); continue; }
      if (list.length > 1) { res.errors.push(`SKU ${sku} matches ${list.length} variants — skipped`); continue; }
      variant = list[0];
    }
    if (bc) {
      const list = barcodes.get(bc) || [];
      if (list.length === 0) { res.errors.push(`Barcode ${bc} not found`); continue; }
      if (list.length > 1) { res.errors.push(`Barcode ${bc} matches ${list.length} variants — skipped`); continue; }
      if (variant && variant.id !== list[0].id) { res.errors.push('SKU and Barcode point to different variants — not matched'); continue; }
      variant = variant || list[0];
    }
    if (h) {
      const p = handles.get(h);
      if (!p || p.status === 'ARCHIVED') { res.errors.push(`Handle "${h}" not found`); continue; }
      if (variant) {
        if (variant.product.id !== p.id) { res.errors.push(`Handle "${h}" and ${sku ? 'SKU' : 'Barcode'} point to different products — not matched`); continue; }
      } else {
        const vs = (p.variants && p.variants.nodes) || [];
        if (vs.length !== 1) { res.errors.push('Only Handle given and the product has several variants — add SKU or Barcode'); continue; }
        variant = { ...vs[0], product: p };
      }
    }
    res.productId = variant.product.id;
    res.productTitle = variant.product.title;
    res.variantId = variant.id;
    res.inventoryItemId = variant.inventoryItem && variant.inventoryItem.id;
  }
  return out;
}

// ─── Value helpers ───────────────────────────────────────────────────────────
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const str = (v) => String(v == null ? '' : v).trim();

function toStatus(v) {
  const s = str(v).toLowerCase();
  if (s === 'active') return 'ACTIVE';
  if (s === 'draft') return 'DRAFT';
  return null;
}

function toPolicy(v) {
  const s = str(v).toLowerCase();
  if (s === 'deny') return 'DENY';
  if (s === 'continue') return 'CONTINUE';
  return null;
}

// CSV weight is always grams ("Weight value (grams)" / "Variant Grams");
// the unit column only says how Shopify should display it.
function toWeight(gramsRaw, unitRaw) {
  const g = Number(str(gramsRaw));
  if (!isFinite(g) || str(gramsRaw) === '') return null;
  const u = str(unitRaw).toLowerCase();
  if (u === 'kg') return { value: g / 1000, unit: 'KILOGRAMS' };
  if (u === 'lb') return { value: Math.round((g / 453.59237) * 1000) / 1000, unit: 'POUNDS' };
  if (u === 'oz') return { value: Math.round((g / 28.349523125) * 1000) / 1000, unit: 'OUNCES' };
  return { value: g, unit: 'GRAMS' };
}

function splitTags(v) {
  return str(v).split(',').map(t => t.trim()).filter(Boolean);
}

// ─── Category resolution (fullName → taxonomy id) ────────────────────────────
async function makeCategoryResolver() {
  const cache = new Map();
  return async (fullName) => {
    const key = str(fullName).toLowerCase();
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    let id = null;
    const pool1 = await pool.query('SELECT category_id FROM import_category_pool WHERE LOWER(full_name) = $1 LIMIT 1', [key]);
    if (pool1.rows.length) id = pool1.rows[0].category_id;
    if (!id) {
      const leaf = str(fullName).split('>').pop().trim();
      const data = await gql(
        `query($s: String!) { taxonomy { categories(search: $s, first: 50) { nodes { id fullName } } } }`,
        { s: leaf }
      );
      const hit = data.taxonomy.categories.nodes.find(n => n.fullName.toLowerCase() === key);
      id = hit ? hit.id : null;
    }
    cache.set(key, id);
    return id;
  };
}

// ─── Metafield writes ────────────────────────────────────────────────────────
// entries: [{ ownerId, namespace, key, value, label }] (value = raw CSV text)
// Returns report lines for anything that could not be written.
async function writeMetafields(entries, defs, level) {
  const report = [];
  const inputs = [];
  for (const e of entries) {
    const def = findDefinition(defs, e.level || level, e.namespace, e.key);
    if (!def) { report.push(`${e.label}: Column "${e.namespace}.${e.key}" skipped — no metafield definition`); continue; }
    const conv = toMetafieldValue(def.type, e.value);
    if (conv.error) { report.push(`${e.label}: Column "${def.name || e.key}" skipped — ${conv.error}`); continue; }
    inputs.push({ input: { ownerId: e.ownerId, namespace: e.namespace, key: e.key, type: def.type, value: conv.value }, e, def });
  }
  const MUT = `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } } }`;
  for (let i = 0; i < inputs.length; i += 25) {
    const batch = inputs.slice(i, i + 25);
    let ok = false;
    try {
      const data = await gql(MUT, { m: batch.map(b => b.input) });
      ok = !userErrorText(data.metafieldsSet);
    } catch (err) { ok = false; }
    if (ok) continue;
    // A batch is all-or-nothing — retry one by one to find the bad column(s).
    for (const b of batch) {
      try {
        const data = await gql(MUT, { m: [b.input] });
        const msg = userErrorText(data.metafieldsSet);
        if (msg) report.push(`${b.e.label}: Column "${b.def.name || b.e.key}" skipped — ${msg}`);
      } catch (err) {
        report.push(`${b.e.label}: Column "${b.def.name || b.e.key}" skipped — ${err.message}`);
      }
    }
  }
  return report;
}

async function deleteMetafields(entries) {
  if (!entries.length) return [];
  const report = [];
  for (let i = 0; i < entries.length; i += 25) {
    const batch = entries.slice(i, i + 25);
    try {
      const data = await gql(
        `mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { field message } } }`,
        { m: batch.map(e => ({ ownerId: e.ownerId, namespace: e.namespace, key: e.key })) }
      );
      const msg = userErrorText(data.metafieldsDelete);
      if (msg) report.push(`Clearing metafields failed — ${msg}`);
    } catch (err) {
      report.push(`Clearing metafields failed — ${err.message}`);
    }
  }
  return report;
}

async function publishTo(productId, publicationIds) {
  if (!publicationIds.length) return '';
  try {
    const data = await gql(
      `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
      { id: productId, input: publicationIds.map(p => ({ publicationId: p })) }
    );
    return userErrorText(data.publishablePublish);
  } catch (e) {
    return e.message;
  }
}

async function activateLocations(inventoryItemId, locationIds) {
  if (!inventoryItemId || !locationIds.length) return '';
  try {
    const data = await gql(
      `mutation($id: ID!, $u: [InventoryBulkToggleActivationInput!]!) {
        inventoryBulkToggleActivation(inventoryItemId: $id, inventoryItemUpdates: $u) { userErrors { field message } }
      }`,
      { id: inventoryItemId, u: locationIds.map(l => ({ locationId: l, activate: true })) }
    );
    return userErrorText(data.inventoryBulkToggleActivation);
  } catch (e) {
    return e.message;
  }
}

// ─── Add new ─────────────────────────────────────────────────────────────────
async function addProduct(p, ctx) {
  const report = [];

  // 0. Re-check identifiers right before creating.
  const check = await precheck('add', p.variants.map((v, i) => ({
    rowNumber: v.rowNumber, groupKey: 'g', handle: i === 0 ? p.handle : '', handleIsAuto: !!p.handleIsAuto,
    sku: v.fields.sku, barcode: v.fields.barcode,
  })));
  const conflicts = [].concat(...Object.values(check.rows).map(r => r.errors));
  if (conflicts.length) return { result: 'failed', report: [`Skipped whole product — ${conflicts.join('; ')}`] };
  const handle = p.handleIsAuto ? (check.autoHandles.g || p.handle) : p.handle;

  const f = p.fields;
  const input = {
    title: str(f.title),
    productType: str(f.productType) || ctx.productType,
    status: toStatus(f.status) || 'ACTIVE',
  };
  if (has(handle)) input.handle = str(handle);
  if (has(f.descriptionHtml)) input.descriptionHtml = String(f.descriptionHtml);
  if (has(f.vendor)) input.vendor = str(f.vendor);
  if (has(f.tags)) input.tags = splitTags(f.tags);
  if (has(f.seoTitle) || has(f.seoDescription)) input.seo = { title: str(f.seoTitle) || undefined, description: str(f.seoDescription) || undefined };
  if (has(f.giftCard)) { const b = parseBool(f.giftCard); if (b !== null) input.giftCard = b; }
  if (has(f.category)) {
    const id = await ctx.resolveCategory(f.category);
    if (id) input.category = id;
    else report.push(`Column "Product category" skipped — "${str(f.category)}" not found in Shopify taxonomy`);
  }

  const optionNames = (p.optionNames || []).map(str).filter(Boolean);
  const useDefault = optionNames.length === 0;
  const names = useDefault ? ['Title'] : optionNames;
  input.productOptions = names.map((n, i) => ({
    name: n,
    position: i + 1,
    values: useDefault
      ? [{ name: 'Default Title' }]
      : [...new Set(p.variants.map(v => str((v.optionValues || [])[i])))].filter(Boolean).map(x => ({ name: x })),
  }));
  input.variants = p.variants.map(v => {
    const vf = v.fields;
    const out = {
      optionValues: useDefault
        ? [{ optionName: 'Title', name: 'Default Title' }]
        : names.map((n, i) => ({ optionName: n, name: str((v.optionValues || [])[i]) })),
    };
    if (has(vf.sku)) out.sku = str(vf.sku);
    if (has(vf.barcode)) out.barcode = str(vf.barcode);
    if (has(vf.price)) out.price = str(vf.price);
    if (has(vf.compareAtPrice)) out.compareAtPrice = str(vf.compareAtPrice);
    if (has(vf.taxable)) { const b = parseBool(vf.taxable); if (b !== null) out.taxable = b; }
    if (has(vf.taxCode)) out.taxCode = str(vf.taxCode);
    const pol = toPolicy(vf.inventoryPolicy);
    if (pol) out.inventoryPolicy = pol;
    const item = {};
    if (has(vf.cost)) item.cost = str(vf.cost);
    // Tracked unless the CSV explicitly says otherwise (blank tracker cell on a
    // CSV that has the column = not tracked, same as Shopify's own import).
    const tracked = vf.tracked === undefined ? true : str(vf.tracked).toLowerCase() === 'shopify' || parseBool(vf.tracked) === true;
    item.tracked = tracked;
    if (has(vf.requiresShipping)) { const b = parseBool(vf.requiresShipping); if (b !== null) item.requiresShipping = b; }
    const w = toWeight(vf.weight, vf.weightUnit);
    if (w) item.measurement = { weight: w };
    out.inventoryItem = item;
    if (tracked && ctx.locations.length) {
      out.inventoryQuantities = ctx.locations.map(l => ({ locationId: l.id, name: 'available', quantity: 0 }));
    }
    return out;
  });

  // 1. Create.
  let product;
  try {
    const data = await gql(
      `mutation($input: ProductSetInput!) {
        productSet(input: $input, synchronous: true) {
          product { id title handle variants(first: 250) { nodes { id sku selectedOptions { name value } inventoryItem { id } } } }
          userErrors { field message }
        }
      }`,
      { input }
    );
    const msg = userErrorText(data.productSet);
    if (msg || !data.productSet.product) return { result: 'failed', report: [`Not created — ${msg || 'unknown error'}`] };
    product = data.productSet.product;
  } catch (e) {
    return { result: 'failed', report: [`Not created — ${e.message}`] };
  }

  // Map CSV variants → created variants (by SKU, else by option values).
  const created = product.variants.nodes;
  const variantFor = (v) => {
    const sku = str(v.fields.sku);
    if (sku) { const hit = created.find(c => str(c.sku) === sku); if (hit) return hit; }
    const want = useDefault ? ['Default Title'] : names.map((n, i) => str((v.optionValues || [])[i]));
    return created.find(c => want.every((val, i) => c.selectedOptions[i] && str(c.selectedOptions[i].value) === val)) || null;
  };

  // 2. Metafields.
  const entries = [];
  for (const m of p.metafields || []) {
    if (has(m.value)) entries.push({ ownerId: product.id, level: 'product', namespace: m.namespace, key: m.key, value: m.value, label: 'Product' });
  }
  for (const v of p.variants) {
    const target = variantFor(v);
    for (const m of v.metafields || []) {
      if (!has(m.value)) continue;
      if (!target) { report.push(`Row ${v.rowNumber}: variant metafields skipped — variant not found after create`); break; }
      entries.push({ ownerId: target.id, level: 'variant', namespace: m.namespace, key: m.key, value: m.value, label: `SKU ${str(v.fields.sku) || `row ${v.rowNumber}`}` });
    }
  }
  report.push(...await writeMetafields(entries, ctx.defs));

  // 3. Point of Sale.
  if (ctx.posPublicationId) {
    const msg = await publishTo(product.id, [ctx.posPublicationId]);
    if (msg) report.push(`Publish to Point of Sale failed — ${msg}`);
  } else {
    report.push('Publish to Point of Sale skipped — Point of Sale channel not found');
  }

  // 4. new_arrival (Add new only, POS only != true).
  const posOnly = (p.metafields || []).find(m => m.namespace === 'custom' && m.key === 'pos_only');
  if (!(posOnly && parseBool(posOnly.value) === true)) {
    try {
      const ins = await pool.query(
        `INSERT INTO new_arrival (shopify_product_id, title, product_type, skus)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (shopify_product_id) DO NOTHING RETURNING id`,
        [product.id, product.title, input.productType, created.map(c => c.sku).filter(Boolean)]
      );
      if (ins.rows.length) ctx.newArrivalIds.push(ins.rows[0].id);
    } catch (e) {
      report.push(`Could not add to New products list — ${e.message}`);
    }
  }

  return { result: report.length ? 'partial' : 'success', report, productId: product.id, title: product.title };
}

// ─── Update existing ─────────────────────────────────────────────────────────
const CLEARABLE_PRODUCT = new Set(['descriptionHtml', 'vendor', 'tags', 'seoTitle', 'seoDescription', 'category']);
const CLEARABLE_VARIANT = new Set(['compareAtPrice', 'cost', 'taxCode']);

async function updateProduct(p, ctx) {
  const report = [];
  let anySuccess = false;
  let anyAttempt = false;
  const clear = ctx.blankMode === 'clear';

  // 0. Re-match every row right before writing.
  const check = await precheck('update', p.variants.map(v => ({
    rowNumber: v.rowNumber, groupKey: 'g', handle: v.fields.handle, handleIsAuto: false,
    sku: v.fields.sku, barcode: v.fields.barcode,
  })));
  const matched = [];
  for (const v of p.variants) {
    const c = check.rows[v.rowNumber];
    if (c.errors.length) { report.push(`Row ${v.rowNumber} skipped — ${c.errors.join('; ')}`); continue; }
    if (p.productId && c.productId !== p.productId) { report.push(`Row ${v.rowNumber} skipped — now matches a different product`); continue; }
    matched.push({ ...v, variantId: c.variantId, inventoryItemId: c.inventoryItemId, productId: c.productId, productTitle: c.productTitle });
  }
  if (!matched.length) return { result: 'failed', report, productId: p.productId, title: p.title };
  const productId = matched[0].productId;
  const title = matched[0].productTitle;

  // 1. Product fields.
  const f = p.fields;
  const pin = { id: productId };
  const setOrClear = (key, value, clearValue) => {
    if (f[key] === undefined) return;
    if (has(f[key])) pin[key === 'seoTitle' || key === 'seoDescription' ? `__${key}` : key] = value;
    else if (clear && CLEARABLE_PRODUCT.has(key)) pin[key === 'seoTitle' || key === 'seoDescription' ? `__${key}` : key] = clearValue;
  };
  setOrClear('title', str(f.title), undefined);
  setOrClear('descriptionHtml', String(f.descriptionHtml || ''), '');
  setOrClear('vendor', str(f.vendor), '');
  setOrClear('productType', str(f.productType), undefined);
  setOrClear('tags', splitTags(f.tags), []);
  setOrClear('seoTitle', str(f.seoTitle), '');
  setOrClear('seoDescription', str(f.seoDescription), '');
  if (f.status !== undefined && toStatus(f.status)) pin.status = toStatus(f.status);
  if (f.category !== undefined) {
    if (has(f.category)) {
      const id = await ctx.resolveCategory(f.category);
      if (id) pin.category = id;
      else report.push(`Column "Product category" skipped — "${str(f.category)}" not found in Shopify taxonomy`);
    } else if (clear) {
      pin.category = null;
    }
  }
  if (pin.__seoTitle !== undefined || pin.__seoDescription !== undefined) {
    pin.seo = {};
    if (pin.__seoTitle !== undefined) pin.seo.title = pin.__seoTitle;
    if (pin.__seoDescription !== undefined) pin.seo.description = pin.__seoDescription;
  }
  delete pin.__seoTitle; delete pin.__seoDescription;
  Object.keys(pin).forEach(k => pin[k] === undefined && delete pin[k]);

  if (Object.keys(pin).length > 1) {
    anyAttempt = true;
    try {
      const data = await gql(
        `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id } userErrors { field message } } }`,
        { p: pin }
      );
      const msg = userErrorText(data.productUpdate);
      if (msg) report.push(`Product fields not updated — ${msg}`); else anySuccess = true;
    } catch (e) {
      report.push(`Product fields not updated — ${e.message}`);
    }
  }

  // 2. Variant fields.
  const vinputs = [];
  for (const v of matched) {
    const vf = v.fields;
    const out = { id: v.variantId };
    const item = {};
    const pick = (key, apply, clearApply) => {
      if (vf[key] === undefined) return;
      if (has(vf[key])) apply();
      else if (clear && CLEARABLE_VARIANT.has(key)) clearApply();
    };
    pick('price', () => { out.price = str(vf.price); });
    pick('compareAtPrice', () => { out.compareAtPrice = str(vf.compareAtPrice); }, () => { out.compareAtPrice = null; });
    pick('taxable', () => { const b = parseBool(vf.taxable); if (b !== null) out.taxable = b; });
    pick('taxCode', () => { out.taxCode = str(vf.taxCode); }, () => { out.taxCode = ''; });
    pick('inventoryPolicy', () => { const pol = toPolicy(vf.inventoryPolicy); if (pol) out.inventoryPolicy = pol; });
    pick('cost', () => { item.cost = str(vf.cost); }, () => { item.cost = null; });
    pick('tracked', () => { item.tracked = str(vf.tracked).toLowerCase() === 'shopify' || parseBool(vf.tracked) === true; });
    pick('requiresShipping', () => { const b = parseBool(vf.requiresShipping); if (b !== null) item.requiresShipping = b; });
    if (has(vf.weight)) { const w = toWeight(vf.weight, vf.weightUnit); if (w) item.measurement = { weight: w }; }
    if (Object.keys(item).length) out.inventoryItem = item;
    if (Object.keys(out).length > 1) vinputs.push(out);
  }
  if (vinputs.length) {
    anyAttempt = true;
    try {
      const data = await gql(
        `mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $pid, variants: $v) { productVariants { id } userErrors { field message } }
        }`,
        { pid: productId, v: vinputs }
      );
      const msg = userErrorText(data.productVariantsBulkUpdate);
      if (msg) report.push(`Variant fields not updated — ${msg}`); else anySuccess = true;
    } catch (e) {
      report.push(`Variant fields not updated — ${e.message}`);
    }
  }

  // 3. Metafields (set non-empty; clear mode deletes empty ones).
  const setEntries = [];
  const delEntries = [];
  for (const m of p.metafields || []) {
    if (has(m.value)) setEntries.push({ ownerId: productId, level: 'product', namespace: m.namespace, key: m.key, value: m.value, label: 'Product' });
    else if (clear) delEntries.push({ ownerId: productId, namespace: m.namespace, key: m.key });
  }
  for (const v of matched) {
    for (const m of v.metafields || []) {
      if (has(m.value)) setEntries.push({ ownerId: v.variantId, level: 'variant', namespace: m.namespace, key: m.key, value: m.value, label: `SKU ${str(v.fields.sku) || `row ${v.rowNumber}`}` });
      else if (clear) delEntries.push({ ownerId: v.variantId, namespace: m.namespace, key: m.key });
    }
  }
  if (setEntries.length || delEntries.length) {
    anyAttempt = true;
    const lines = [...await writeMetafields(setEntries, ctx.defs), ...await deleteMetafields(delEntries)];
    report.push(...lines);
    if (lines.length < setEntries.length + (delEntries.length ? 1 : 0)) anySuccess = true;
  }

  // 4. Point of Sale (only adds; never unpublishes other channels).
  if (ctx.posPublicationId) {
    anyAttempt = true;
    const msg = await publishTo(productId, [ctx.posPublicationId]);
    if (msg) report.push(`Publish to Point of Sale failed — ${msg}`); else anySuccess = true;
  }

  // 5. Locations (only activates; never deactivates).
  if (ctx.locations.length) {
    for (const v of matched) {
      anyAttempt = true;
      const msg = await activateLocations(v.inventoryItemId, ctx.locations.map(l => l.id));
      if (msg) report.push(`SKU ${str(v.fields.sku) || `row ${v.rowNumber}`}: location activation failed — ${msg}`); else anySuccess = true;
    }
  }

  const result = !anyAttempt ? 'success' : !anySuccess ? 'failed' : report.length ? 'partial' : 'success';
  return { result, report, productId, title };
}

// ─── Jobs (in memory; results are not saved — spec §8) ──────────────────────
const jobs = new Map();

function getJob(id) {
  return jobs.get(id) || null;
}

function startImport(payload) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, status: 'running', mode: payload.mode, total: payload.products.length, done: 0,
    results: [], fatal: '', startedAt: Date.now(),
  };
  jobs.set(id, job);
  // Forget jobs after 6h so memory can't grow.
  for (const [k, j] of jobs) if (Date.now() - j.startedAt > 6 * 3600 * 1000) jobs.delete(k);

  runJob(job, payload).catch(e => {
    job.status = 'failed';
    job.fatal = e.message;
    console.error('[import-products] job failed:', e);
  });
  return job;
}

async function runJob(job, payload) {
  const ctx = {
    productType: str(payload.productType),
    blankMode: (await getSetting('import_update_blank_mode', 'keep')) === 'clear' ? 'clear' : 'keep',
    locations: await locationIdsByName(payload.locations || []),
    defs: await fetchAllDefinitions(),
    resolveCategory: await makeCategoryResolver(),
    posPublicationId: null,
    newArrivalIds: [],
  };
  const pos = await findPosPublication().catch(() => null);
  ctx.posPublicationId = pos ? pos.id : null;

  for (const p of payload.products) {
    let r;
    try {
      r = payload.mode === 'update' ? await updateProduct(p, ctx) : await addProduct(p, ctx);
    } catch (e) {
      r = { result: 'failed', report: [`Unexpected error — ${e.message}`] };
    }
    job.results.push({
      key: p.key,
      title: r.title || p.title || p.handle || '',
      productId: r.productId || p.productId || null,
      result: r.result,
      report: r.report || [],
      rowNumbers: p.variants.map(v => v.rowNumber),
    });
    job.done++;
  }

  // First pull for the New products page (spec §15.3). Failures only log.
  if (ctx.newArrivalIds.length) {
    await refreshRows(ctx.newArrivalIds).catch(e => console.error('[import-products] new_arrival first pull failed:', e.message));
  }
  job.status = 'done';
}

module.exports = { precheck, startImport, getJob };
