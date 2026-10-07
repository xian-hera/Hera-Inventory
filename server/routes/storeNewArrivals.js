// /api/store-new-arrivals — Store (manager) → New Arrival (2026-09-29, Hera).
// Spec: claude/STORE_NEW_ARRIVAL_FEATURE.md
//
// A product enters the list (table store_new_arrivals) when:
//   - Import Products → Add new creates it with POS only = true, or
//   - Online → New products marks it Finalized (POS only = false).
// Only products added after this feature went live are listed.
//
// "Shelf date" = first day any of the Settings "shelf locations" (default:
// every active location except HQ) has Available > 0. New until = shelf date
// + N days (Settings, default 90), the same for every store. Until then the
// product shows "New until TBD".
// Per store: the first time the store has Available > 0 the product moves
// from Incoming to Available in store, and never goes back.
// Title / Vendor / Type / first media / status are read live from Shopify
// each time the page opens; only ACTIVE products are shown.
//
// SKU level (2026-10-07, Hera): each row is one VARIANT (shopify_variant_id).
// Stock, Available/Incoming, shelf date and New until are all per SKU. The
// page shows "Product — Variant" and the variant's picture (else the
// product's first picture). Rows written before this change (one per
// product, no variant id) are split into one row per variant the next time
// the list is read (expandLegacyRows), keeping their dates and store status.
const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { gql } = require('../services/shopifyGql');
const { getSetting, setSetting } = require('../services/productData');

const SETTINGS_KEY = 'store_new_arrival_settings';
const DEFAULTS = { days: 90, tbdDeleteDays: 180, shelfLocations: null, excludedTypes: [] };
const MIN_DAYS = 10;
const MIN_TBD_DAYS = 90;
const TIMEZONE = 'America/Toronto';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function todayLocal() {
  // 'YYYY-MM-DD' in Toronto time.
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  // pg returns DATE as a JS Date at local midnight — format its local parts.
  const p = (n) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
}

async function activeLocations() {
  const r = await pool.query('SELECT location_name, shopify_location_id FROM location_map WHERE is_active = TRUE');
  return r.rows.map(x => ({ name: x.location_name, id: x.shopify_location_id }));
}

async function getSettings() {
  const v = (await getSetting(SETTINGS_KEY, {})) || {};
  const days = parseInt(v.days, 10);
  const tbd = parseInt(v.tbdDeleteDays, 10);
  return {
    days: days >= MIN_DAYS ? days : DEFAULTS.days,
    tbdDeleteDays: tbd >= MIN_TBD_DAYS ? tbd : DEFAULTS.tbdDeleteDays,
    // null = never saved → every active location except HQ.
    shelfLocations: Array.isArray(v.shelfLocations) ? v.shelfLocations.map(String) : null,
    excludedTypes: Array.isArray(v.excludedTypes) ? v.excludedTypes.map(String) : [],
  };
}

// Shelf locations as [{ name, id }] (active ones only).
async function shelfLocationList(settings) {
  const all = await activeLocations();
  if (settings.shelfLocations === null) return all.filter(l => l.name.toUpperCase() !== 'HQ');
  const wanted = new Set(settings.shelfLocations);
  return all.filter(l => wanted.has(l.name));
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// Per-product helpers below (availableAt, onShelfAnywhere, productInfo) are
// no longer called since the list became per SKU (2026-10-07); kept for
// reference. The per-variant versions follow further down.
// Available at ONE location, summed over the product's variants.
// Uses productVariants filtered by product ids and pages through every
// variant (no per-product variant limit). Query cost ≈ 150 × 4 < 1000.
// Returns Map productId → number.
const numericId = (gid) => String(gid).split('/').pop();
async function availableAt(productIds, locationId) {
  const out = new Map(productIds.map(id => [id, 0]));
  for (const ids of chunk(productIds, 30)) {
    const q = ids.map(id => `product_id:${numericId(id)}`).join(' OR ');
    let after = null;
    for (;;) {
      const data = await gql(
        `query($q: String!, $loc: ID!, $after: String) {
          productVariants(first: 150, query: $q, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { product { id } inventoryItem { inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } } } }
          }
        }`,
        { q, loc: locationId, after }
      );
      const page = data.productVariants;
      for (const v of page.nodes) {
        const pid = v.product && v.product.id;
        if (!out.has(pid)) continue;
        const lvl = v.inventoryItem && v.inventoryItem.inventoryLevel;
        const qty = lvl && lvl.quantities && lvl.quantities[0] && lvl.quantities[0].quantity;
        if (qty > 0) out.set(pid, out.get(pid) + qty);
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
  }
  return out;
}

// True if any shelf location has Available > 0 for the product.
// Throws on Shopify errors (callers then leave the product TBD).
// 10 variants × 30 levels per page keeps the query cost under 1000.
async function onShelfAnywhere(productId, shelfLocationIds) {
  if (!shelfLocationIds.size) return false;
  let after = null;
  for (;;) {
    const data = await gql(
      `query($id: ID!, $after: String) {
        product(id: $id) {
          variants(first: 10, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { inventoryItem { inventoryLevels(first: 30) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } }
          }
        }
      }`,
      { id: productId, after }
    );
    const p = data.product;
    if (!p) return false;
    for (const v of p.variants.nodes) {
      for (const lvl of (v.inventoryItem && v.inventoryItem.inventoryLevels.nodes) || []) {
        const q = lvl.quantities && lvl.quantities[0];
        if (shelfLocationIds.has(lvl.location.id) && q && q.quantity > 0) return true;
      }
    }
    if (!p.variants.pageInfo.hasNextPage) return false;
    after = p.variants.pageInfo.endCursor;
  }
}

// Title / vendor / type / status / first media for many products.
async function productInfo(productIds) {
  const out = new Map();
  for (const ids of chunk(productIds, 50)) {
    const data = await gql(
      `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id title vendor productType status
            media(first: 1) { nodes { preview { image {
              thumb: url(transform: { maxWidth: 200, maxHeight: 200 })
              full: url(transform: { maxWidth: 1200, maxHeight: 1200 })
            } } } }
          }
        }
      }`,
      { ids }
    );
    for (const n of data.nodes || []) {
      if (!n || !n.id) continue;
      const img = n.media && n.media.nodes[0] && n.media.nodes[0].preview && n.media.nodes[0].preview.image;
      out.set(n.id, {
        title: n.title, vendor: n.vendor, productType: n.productType, status: n.status,
        thumbUrl: img ? img.thumb : null, imageUrl: img ? img.full : null,
      });
    }
  }
  return out;
}

// ─── Per variant (2026-10-07) ────────────────────────────────────────────────
// Every variant id of a product (paged).
async function productVariantIds(productId) {
  const out = [];
  let after = null;
  for (;;) {
    const data = await gql(
      `query($id: ID!, $after: String) { product(id: $id) { variants(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id } } } }`,
      { id: productId, after }
    );
    if (!data.product) return null; // deleted in Shopify
    out.push(...data.product.variants.nodes.map(v => v.id));
    if (!data.product.variants.pageInfo.hasNextPage) break;
    after = data.product.variants.pageInfo.endCursor;
  }
  return out;
}

// Available at ONE location per variant. Returns Map variantId → number.
async function availableAtVariants(variantIds, locationId) {
  const out = new Map(variantIds.map(id => [id, 0]));
  for (const ids of chunk(variantIds, 100)) {
    const data = await gql(
      `query($ids: [ID!]!, $loc: ID!) {
        nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } } } } }
      }`,
      { ids, loc: locationId }
    );
    for (const v of data.nodes || []) {
      if (!v || !v.id) continue;
      const lvl = v.inventoryItem && v.inventoryItem.inventoryLevel;
      const qty = lvl && lvl.quantities && lvl.quantities[0] && lvl.quantities[0].quantity;
      if (qty > 0) out.set(v.id, qty);
    }
  }
  return out;
}

// Variants with Available > 0 at any shelf location. Returns a Set of ids.
// 15 variants × 30 levels per query keeps the cost under 1000.
async function variantsOnShelf(variantIds, shelfLocationIds) {
  const out = new Set();
  if (!shelfLocationIds.size) return out;
  for (const ids of chunk(variantIds, 15)) {
    const data = await gql(
      `query($ids: [ID!]!) {
        nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { inventoryLevels(first: 30) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } } }
      }`,
      { ids }
    );
    for (const v of data.nodes || []) {
      if (!v || !v.id) continue;
      for (const lvl of (v.inventoryItem && v.inventoryItem.inventoryLevels.nodes) || []) {
        const q = lvl.quantities && lvl.quantities[0];
        if (shelfLocationIds.has(lvl.location.id) && q && q.quantity > 0) { out.add(v.id); break; }
      }
    }
  }
  return out;
}

// Title / vendor / type / status / picture per variant.
async function variantInfo(variantIds) {
  const out = new Map();
  const IMG = `preview { image {
    thumb: url(transform: { maxWidth: 200, maxHeight: 200 })
    full: url(transform: { maxWidth: 1200, maxHeight: 1200 })
  } }`;
  for (const ids of chunk(variantIds, 50)) {
    const data = await gql(
      `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id title selectedOptions { name value }
            media(first: 1) { nodes { ${IMG} } }
            product { id title vendor productType status hasOnlyDefaultVariant media(first: 1) { nodes { ${IMG} } } }
          }
        }
      }`,
      { ids }
    );
    for (const n of data.nodes || []) {
      if (!n || !n.id || !n.product) continue;
      const vImg = n.media && n.media.nodes[0] && n.media.nodes[0].preview && n.media.nodes[0].preview.image;
      const pImg = n.product.media && n.product.media.nodes[0] && n.product.media.nodes[0].preview && n.product.media.nodes[0].preview.image;
      // One picture per product on the page (Hera 2026-10-07, rev.): the
      // product's first picture, else the variant's.
      const img = pImg || vImg;
      const vt = String(n.title || '').trim();
      out.set(n.id, {
        productId: n.product.id,
        productTitle: n.product.title,
        hasOptions: !n.product.hasOnlyDefaultVariant,
        options: (n.selectedOptions || []).map(o => ({ name: o.name, value: o.value })),
        title: vt && vt !== 'Default Title' ? `${n.product.title} — ${vt}` : n.product.title,
        vendor: n.product.vendor, productType: n.product.productType, status: n.product.status,
        thumbUrl: img ? img.thumb : null, imageUrl: img ? img.full : null,
      });
    }
  }
  return out;
}

// Split rows written before 2026-10-07 (one per product, no variant id)
// into one row per variant, keeping source / entered date / shelf date.
// The per-store "seen" status is NOT copied: it was recorded for the
// product as a whole, so each SKU is checked again on the next page visit
// (a SKU in stock there goes straight to Available). A product deleted in
// Shopify can never be shown, so its old row is removed. Never throws.
async function expandLegacyRows() {
  let legacy;
  try {
    legacy = (await pool.query('SELECT * FROM store_new_arrivals WHERE shopify_variant_id IS NULL')).rows;
  } catch (e) {
    console.error('[store-new-arrival] legacy read failed:', e.message);
    return 0;
  }
  let split = 0;
  for (const row of legacy) {
    try {
      const vids = await productVariantIds(row.shopify_product_id);
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        if (vids && vids.length) {
          for (const vid of vids) {
            await db.query(
              `INSERT INTO store_new_arrivals (shopify_product_id, shopify_variant_id, source, entered_at, shelf_started_at)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT (shopify_variant_id) DO NOTHING`,
              [row.shopify_product_id, vid, row.source, row.entered_at, row.shelf_started_at]
            );
          }
        }
        // The old product row (and its seen rows, by cascade) is replaced by
        // the per-variant rows above — or, when the product was deleted in
        // Shopify (vids null), simply removed.
        await db.query('DELETE FROM store_new_arrivals WHERE id = $1', [row.id]);
        await db.query('COMMIT');
        split++;
      } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        db.release();
      }
    } catch (e) {
      console.error(`[store-new-arrival] could not split ${row.shopify_product_id}: ${e.message}`);
    }
  }
  return split;
}

// ─── Entry points used by other modules ─────────────────────────────────────
// Add SKUs to the list. source: 'pos_only' | 'finalized' | 'new_variant'
// (variant added to an existing product) | 'manual' (Add New Arrival). Never throws.
// items: product id strings (= every variant of the product) or
// { productId, variantIds } (variantIds null/empty = every variant).
// Returns the number of variant rows added (2026-10-07: one row per SKU).
async function addStoreNewArrivals(items, source) {
  const list = (items || []).filter(Boolean).map(x => (typeof x === 'string' ? { productId: x, variantIds: null } : x))
    .filter(x => x.productId);
  if (!list.length) return 0;
  let added = 0;
  for (const it of list) {
    try {
      let vids = Array.isArray(it.variantIds) && it.variantIds.length ? [...new Set(it.variantIds)] : await productVariantIds(it.productId);
      if (!vids || !vids.length) continue;
      const r = await pool.query(
        `INSERT INTO store_new_arrivals (shopify_product_id, shopify_variant_id, source)
         SELECT $1, UNNEST($2::text[]), $3
         ON CONFLICT (shopify_variant_id) DO NOTHING`,
        [it.productId, vids, source]
      );
      added += r.rowCount;
    } catch (e) {
      console.error(`[store-new-arrival] add failed for ${it.productId}:`, e.message);
    }
  }
  return added;
}

// Daily job (called from jobs/newArrivalScheduler.js):
//   1. TBD products that are now on a shelf location → shelf date = today
//   2. delete products whose New until has passed
//   3. delete products still TBD after tbdDeleteDays (from entering the list)
async function runStoreNewArrivalDaily() {
  const settings = await getSettings();
  const today = todayLocal();
  const shelf = await shelfLocationList(settings);
  const shelfIds = new Set(shelf.map(l => l.id));
  await expandLegacyRows(); // 2026-10-07: per-SKU rows
  const tbd = await pool.query('SELECT id, shopify_product_id, shopify_variant_id FROM store_new_arrivals WHERE shelf_started_at IS NULL');
  let started = 0;
  // Per SKU since 2026-10-07 (onShelfAnywhere above is the per-product
  // version, kept for reference).
  const tbdVariants = tbd.rows.filter(r => r.shopify_variant_id);
  for (const part of chunk(tbdVariants, 150)) {
    try {
      const onShelf = await variantsOnShelf(part.map(r => r.shopify_variant_id), shelfIds);
      for (const row of part) {
        if (!onShelf.has(row.shopify_variant_id)) continue;
        const u = await pool.query('UPDATE store_new_arrivals SET shelf_started_at = $1 WHERE id = $2 AND shelf_started_at IS NULL', [today, row.id]);
        started += u.rowCount;
      }
    } catch (e) {
      console.error(`[store-new-arrival] shelf check failed: ${e.message}`);
    }
  }
  const expired = await pool.query(
    `DELETE FROM store_new_arrivals WHERE shelf_started_at IS NOT NULL AND shelf_started_at + $1::int < $2::date`,
    [settings.days, today]
  );
  const staleTbd = await pool.query(
    `DELETE FROM store_new_arrivals WHERE shelf_started_at IS NULL AND entered_at < NOW() - make_interval(days => $1::int)`,
    [settings.tbdDeleteDays]
  );
  return { started, expired: expired.rowCount, staleTbd: staleTbd.rowCount };
}

// ─── Settings (Buyer → Settings → New Arrival) ──────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const s = await getSettings();
    const shelf = await shelfLocationList(s);
    res.json({ ...s, shelfLocationsEffective: shelf.map(l => l.name), minDays: MIN_DAYS, minTbdDeleteDays: MIN_TBD_DAYS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const cur = await getSettings();
    const b = req.body || {};
    const next = { ...cur };
    if (b.days !== undefined) {
      const d = parseInt(b.days, 10);
      if (!(d >= MIN_DAYS)) return res.status(400).json({ error: `Days must be ${MIN_DAYS} or more.` });
      next.days = d;
    }
    if (b.tbdDeleteDays !== undefined) {
      const d = parseInt(b.tbdDeleteDays, 10);
      if (!(d >= MIN_TBD_DAYS)) return res.status(400).json({ error: `Days must be ${MIN_TBD_DAYS} or more.` });
      next.tbdDeleteDays = d;
    }
    if (b.shelfLocations !== undefined) {
      if (!Array.isArray(b.shelfLocations) || !b.shelfLocations.length) return res.status(400).json({ error: 'Select at least one location.' });
      next.shelfLocations = b.shelfLocations.map(String);
    }
    if (b.excludedTypes !== undefined) {
      next.excludedTypes = Array.isArray(b.excludedTypes) ? b.excludedTypes.map(String) : [];
    }
    await setSetting(SETTINGS_KEY, next);
    const shelf = await shelfLocationList(next);
    res.json({ ...next, shelfLocationsEffective: shelf.map(l => l.name), minDays: MIN_DAYS, minTbdDeleteDays: MIN_TBD_DAYS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Store page ──────────────────────────────────────────────────────────────
// GET /?location=MTL01 → { days, available: [card], incoming: [card] }
// card = { type, items: [product] } (Hera 2026-10-07, rev.): rows are per SKU,
// but SKUs are always shown under their product:
// product = { id, productId, title, vendor, thumbUrl, imageUrl, enteredAt,
//             hasOptions, newUntil|null (products without options),
//             variants: [{ id, variantId, options: [{ name, value }], newUntil|null }] }
// A product whose SKUs are split between the tabs appears in both, each
// time with only that tab's SKUs.
router.get('/', async (req, res) => {
  try {
    const locationName = String(req.query.location || '');
    if (!locationName) return res.status(400).json({ error: 'location required' });
    const locs = await activeLocations();
    const loc = locs.find(l => l.name === locationName);
    if (!loc) return res.status(400).json({ error: `Location ${locationName} not found` });

    const settings = await getSettings();
    const today = todayLocal();
    await expandLegacyRows(); // 2026-10-07: per-SKU rows
    // Variants of the same product stay together (same entered_at).
    const rows = (await pool.query(
      `SELECT a.id, a.shopify_product_id, a.shopify_variant_id, a.entered_at, a.shelf_started_at, s.first_available_at
       FROM store_new_arrivals a
       LEFT JOIN store_new_arrival_seen s ON s.arrival_id = a.id AND s.location = $1
       WHERE a.shopify_variant_id IS NOT NULL
       ORDER BY a.entered_at DESC, a.shopify_product_id, a.id`,
      [locationName]
    )).rows.filter(r => !r.shelf_started_at || addDays(ymd(r.shelf_started_at), settings.days) >= today);

    const info = await variantInfo(rows.map(r => r.shopify_variant_id));
    const excluded = new Set(settings.excludedTypes.map(t => t.toLowerCase()));
    const visible = rows.filter(r => {
      const p = info.get(r.shopify_variant_id);
      return p && p.status === 'ACTIVE' && !excluded.has(String(p.productType || '').toLowerCase());
    });

    // SKUs not yet seen in stock at this store: check now (once).
    const unseen = visible.filter(r => !r.first_available_at);
    if (unseen.length) {
      const avail = await availableAtVariants(unseen.map(r => r.shopify_variant_id), loc.id);
      const shelf = await shelfLocationList(settings);
      const isShelfLocation = shelf.some(l => l.id === loc.id);
      for (const r of unseen) {
        if (!(avail.get(r.shopify_variant_id) > 0)) continue;
        await pool.query(
          `INSERT INTO store_new_arrival_seen (arrival_id, location, first_available_at) VALUES ($1, $2, NOW())
           ON CONFLICT (arrival_id, location) DO NOTHING`,
          [r.id, locationName]
        );
        r.first_available_at = new Date();
        // In stock at a shelf location → the shelf date starts today, if not
        // set yet (the daily job does the same for every shelf location).
        if (!r.shelf_started_at && isShelfLocation) {
          await pool.query('UPDATE store_new_arrivals SET shelf_started_at = $1 WHERE id = $2 AND shelf_started_at IS NULL', [today, r.id]);
          r.shelf_started_at = today;
        }
      }
    }

    const cards = (list) => {
      const byType = new Map();
      const byProduct = new Map();
      for (const r of list) { // newest first
        const p = info.get(r.shopify_variant_id);
        const type = p.productType || 'No type';
        if (!byType.has(type)) byType.set(type, []);
        const newUntil = r.shelf_started_at ? addDays(ymd(r.shelf_started_at), settings.days) : null;
        let item = byProduct.get(r.shopify_product_id);
        if (!item) {
          item = {
            id: r.shopify_product_id,
            productId: r.shopify_product_id,
            title: p.productTitle,
            vendor: p.vendor,
            thumbUrl: p.thumbUrl,
            imageUrl: p.imageUrl,
            enteredAt: r.entered_at,
            hasOptions: p.hasOptions,
            newUntil: null,
            variants: [],
          };
          byProduct.set(r.shopify_product_id, item);
          byType.get(type).push(item);
        }
        item.variants.push({ id: r.id, variantId: r.shopify_variant_id, options: p.hasOptions ? p.options : [], newUntil });
        // No options → the product line itself shows New until.
        if (!p.hasOptions) item.newUntil = newUntil;
      }
      // SKUs inside a product: in the order they were added.
      for (const item of byProduct.values()) item.variants.sort((a, b) => a.id - b.id);
      return [...byType.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
        .map(([type, items]) => ({ type, items })); // products already newest first
    };

    res.json({
      days: settings.days,
      available: cards(visible.filter(r => r.first_available_at)),
      incoming: cards(visible.filter(r => !r.first_available_at)),
    });
  } catch (e) {
    console.error('[store-new-arrival] GET failed:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, addStoreNewArrivals, runStoreNewArrivalDaily, _test: { addDays, todayLocal, getSettings, shelfLocationList, expandLegacyRows } };
