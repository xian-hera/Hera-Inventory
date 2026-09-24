// new_arrival table helpers (2026-09-24). Rows are created by Import Products
// (Add new, POS only != true) and used by Online → New products / Finalized.
// "Refresh" pulls the listed fields from Shopify and caches them in the row
// (new_arrival.cached). Hub never deletes Shopify products.
const { pool } = require('../database/init');
const { gql } = require('./shopifyGql');
const { getSetting, locationIdsByName, sanitizeHtml, htmlToText } = require('./productData');

const SETTINGS = {
  publish: 'online_np_publish_channels',
  inventory: 'online_np_inventory_locations',
  tag: 'online_np_new_arrival_tag',
};
const DEFAULT_TAG = { tag: 'New_arrival', days: 60 };

async function getGroups() {
  const r = await pool.query('SELECT id, name, sort_order, product_types, metafields FROM online_np_groups ORDER BY sort_order, id');
  return r.rows;
}

function groupForType(groups, productType) {
  const t = String(productType || '').trim().toLowerCase();
  if (!t) return null;
  return groups.find(g => (g.product_types || []).some(x => String(x).trim().toLowerCase() === t)) || null;
}

function mfKey(m) {
  return `${m.level}.${m.namespace}.${m.key}`;
}

// Display string for a metafield value.
function displayMetafield(value, type) {
  if (value == null || value === '') return '';
  const s = String(value);
  if (/reference/.test(type || '') || s.startsWith('gid://')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return `${arr.length} linked`;
    } catch (e) { /* single ref */ }
    return '1 linked';
  }
  if (type === 'boolean') return s === 'true' ? 'True' : s === 'false' ? 'False' : s;
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
    } catch (e) { /* fall through */ }
  }
  return s;
}

const UNIT_LABEL = { GRAMS: 'g', KILOGRAMS: 'kg', OUNCES: 'oz', POUNDS: 'lb' };

// Fetch one product with every configured metafield (product + variant level)
// and, optionally, Available at the given locations. Variants are paged so
// the query cost stays well under Shopify's 1000-point single-query limit.
async function fetchProductSnapshot(productId, metafields, locations) {
  const pm = metafields.filter(m => m.level === 'product');
  const vm = metafields.filter(m => m.level === 'variant');
  const pmAliases = pm.map((m, i) =>
    `pm${i}: metafield(namespace: ${JSON.stringify(m.namespace)}, key: ${JSON.stringify(m.key)}) { value type }`).join('\n');
  const vmAliases = vm.map((m, i) =>
    `vm${i}: metafield(namespace: ${JSON.stringify(m.namespace)}, key: ${JSON.stringify(m.key)}) { value type }`).join('\n');
  const locAliases = locations.map((l, i) =>
    `l${i}: inventoryLevel(locationId: ${JSON.stringify(l.id)}) { quantities(names: ["available"]) { quantity } }`).join('\n');
  const perVariantCost = 3 + vm.length + locations.length * 2;
  const pageSize = Math.max(5, Math.min(100, Math.floor(700 / perVariantCost)));

  const query = `query($id: ID!, $after: String) {
    product(id: $id) {
      id title handle status productType tags descriptionHtml
      mediaCount { count }
      ${pmAliases}
      variants(first: ${pageSize}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id sku
          ${vmAliases}
          inventoryItem {
            measurement { weight { value unit } }
            ${locAliases}
          }
        }
      }
    }
  }`;

  let after = null;
  let product = null;
  const variants = [];
  for (;;) {
    const data = await gql(query, { id: productId, after });
    if (!data.product) return null; // deleted in Shopify
    if (!product) product = data.product;
    variants.push(...data.product.variants.nodes);
    if (!data.product.variants.pageInfo.hasNextPage) break;
    after = data.product.variants.pageInfo.endCursor;
  }

  // Weight: empty if ANY variant has no weight (Hera 2026-09-24).
  let weight = '';
  const weights = variants.map(v => v.inventoryItem && v.inventoryItem.measurement && v.inventoryItem.measurement.weight);
  if (weights.length && weights.every(w => w && Number(w.value) > 0)) {
    const labels = [...new Set(weights.map(w => `${Number(w.value)} ${UNIT_LABEL[w.unit] || w.unit}`))];
    weight = labels.join(', ');
  }

  const mfValues = {};
  pm.forEach((m, i) => {
    const node = product[`pm${i}`];
    mfValues[mfKey(m)] = node ? displayMetafield(node.value, node.type) : '';
  });
  vm.forEach((m, i) => {
    const distinct = [];
    for (const v of variants) {
      const node = v[`vm${i}`];
      const val = node ? displayMetafield(node.value, node.type) : '';
      if (val && !distinct.includes(val)) distinct.push(val);
    }
    mfValues[mfKey(m)] = distinct.join(', ');
  });

  let available = null;
  if (locations.length) {
    available = 0;
    for (const v of variants) {
      locations.forEach((l, i) => {
        const lvl = v.inventoryItem && v.inventoryItem[`l${i}`];
        const q = lvl && lvl.quantities && lvl.quantities[0];
        if (q && typeof q.quantity === 'number') available += q.quantity;
      });
    }
  }

  const descriptionHtml = sanitizeHtml(product.descriptionHtml);
  return {
    title: product.title,
    handle: product.handle,
    status: product.status,
    productType: product.productType,
    tags: product.tags || [],
    mediaCount: product.mediaCount ? product.mediaCount.count : 0,
    descriptionHtml,
    descriptionText: htmlToText(descriptionHtml),
    weight,
    metafields: mfValues,
    available,
    skus: variants.map(v => v.sku).filter(Boolean),
  };
}

async function fetchFrTranslations(productIds) {
  const out = {};
  for (let i = 0; i < productIds.length; i += 50) {
    const ids = productIds.slice(i, i + 50);
    const data = await gql(
      `query($ids: [ID!]!) {
        translatableResourcesByIds(first: 50, resourceIds: $ids) {
          nodes { resourceId translations(locale: "fr") { key value } }
        }
      }`,
      { ids }
    );
    for (const n of data.translatableResourcesByIds.nodes) {
      const t = {};
      for (const tr of n.translations || []) t[tr.key] = tr.value;
      const frHtml = sanitizeHtml(t.body_html || '');
      out[n.resourceId] = {
        titleFr: (t.title || '').trim(),
        descriptionFrHtml: frHtml,
        descriptionFrText: htmlToText(frHtml),
      };
    }
  }
  return out;
}

// Refresh rows (by new_arrival.id). withInventory = Finalized page.
// Returns { refreshed, errors: [{ id, title, error }] }.
async function refreshRows(rowIds, { withInventory = false } = {}) {
  if (!rowIds.length) return { refreshed: 0, errors: [] };
  const r = await pool.query('SELECT id, shopify_product_id, title, product_type, cached FROM new_arrival WHERE id = ANY($1)', [rowIds]);
  const rows = r.rows;
  const groups = await getGroups();
  let locations = [];
  if (withInventory) {
    const names = await getSetting(SETTINGS.inventory, []);
    locations = await locationIdsByName(Array.isArray(names) ? names : []);
  }

  let fr = {};
  let frError = '';
  try {
    fr = await fetchFrTranslations(rows.map(x => x.shopify_product_id));
  } catch (e) {
    frError = e.message;
  }

  const errors = [];
  let refreshed = 0;
  // Small concurrency — enough to be quick, gentle on Shopify's rate limit.
  const queue = [...rows];
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      try {
        const group = groupForType(groups, (row.cached && row.cached.productType) || row.product_type);
        // Only the metafields configured for this product's group are fetched.
        const metafields = group ? (group.metafields || []) : [];
        const snap = await fetchProductSnapshot(row.shopify_product_id, metafields, locations);
        if (!snap) {
          await pool.query(
            `UPDATE new_arrival SET refresh_error = $2, refreshed_at = NOW() WHERE id = $1`,
            [row.id, 'Product not found in Shopify']
          );
          errors.push({ id: row.id, title: row.title, error: 'Product not found in Shopify' });
          continue;
        }
        const prev = row.cached || {};
        const t = fr[row.shopify_product_id] || (frError ? {
          titleFr: prev.titleFr || '', descriptionFrHtml: prev.descriptionFrHtml || '', descriptionFrText: prev.descriptionFrText || '',
        } : { titleFr: '', descriptionFrHtml: '', descriptionFrText: '' });
        const cached = {
          ...prev,
          ...snap,
          ...t,
          // Keep the previous inventory figure when this refresh didn't ask for it.
          available: withInventory ? snap.available : (prev.available == null ? null : prev.available),
        };
        await pool.query(
          `UPDATE new_arrival
             SET cached = $2::jsonb, title = $3, product_type = $4, skus = $5,
                 refreshed_at = NOW(), refresh_error = $6
           WHERE id = $1`,
          [row.id, JSON.stringify(cached), snap.title, snap.productType, snap.skus, frError ? `FR translations: ${frError}` : null]
        );
        refreshed++;
      } catch (e) {
        await pool.query('UPDATE new_arrival SET refresh_error = $2, refreshed_at = NOW() WHERE id = $1', [row.id, e.message]).catch(() => {});
        errors.push({ id: row.id, title: row.title, error: e.message });
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return { refreshed, errors };
}

module.exports = { SETTINGS, DEFAULT_TAG, getGroups, groupForType, mfKey, refreshRows };
