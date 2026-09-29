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

// ─── Entry points used by other modules ─────────────────────────────────────
// Add products to the list. source: 'pos_only' | 'finalized'. Never throws.
async function addStoreNewArrivals(productIds, source) {
  const ids = [...new Set((productIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  try {
    const r = await pool.query(
      `INSERT INTO store_new_arrivals (shopify_product_id, source)
       SELECT UNNEST($1::text[]), $2
       ON CONFLICT (shopify_product_id) DO NOTHING`,
      [ids, source]
    );
    return r.rowCount;
  } catch (e) {
    console.error('[store-new-arrival] add failed:', e.message);
    return 0;
  }
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
  const tbd = await pool.query('SELECT id, shopify_product_id FROM store_new_arrivals WHERE shelf_started_at IS NULL');
  let started = 0;
  for (const row of tbd.rows) {
    try {
      if (await onShelfAnywhere(row.shopify_product_id, shelfIds)) {
        const u = await pool.query('UPDATE store_new_arrivals SET shelf_started_at = $1 WHERE id = $2 AND shelf_started_at IS NULL', [today, row.id]);
        started += u.rowCount;
      }
    } catch (e) {
      console.error(`[store-new-arrival] shelf check failed for ${row.shopify_product_id}: ${e.message}`);
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
// card = { type, items: [{ id, title, vendor, thumbUrl, imageUrl, newUntil|null, enteredAt }] }
router.get('/', async (req, res) => {
  try {
    const locationName = String(req.query.location || '');
    if (!locationName) return res.status(400).json({ error: 'location required' });
    const locs = await activeLocations();
    const loc = locs.find(l => l.name === locationName);
    if (!loc) return res.status(400).json({ error: `Location ${locationName} not found` });

    const settings = await getSettings();
    const today = todayLocal();
    const rows = (await pool.query(
      `SELECT a.id, a.shopify_product_id, a.entered_at, a.shelf_started_at, s.first_available_at
       FROM store_new_arrivals a
       LEFT JOIN store_new_arrival_seen s ON s.arrival_id = a.id AND s.location = $1
       ORDER BY a.entered_at DESC, a.id DESC`,
      [locationName]
    )).rows.filter(r => !r.shelf_started_at || addDays(ymd(r.shelf_started_at), settings.days) >= today);

    const info = await productInfo(rows.map(r => r.shopify_product_id));
    const excluded = new Set(settings.excludedTypes.map(t => t.toLowerCase()));
    const visible = rows.filter(r => {
      const p = info.get(r.shopify_product_id);
      return p && p.status === 'ACTIVE' && !excluded.has(String(p.productType || '').toLowerCase());
    });

    // Products not yet seen in stock at this store: check now (once).
    const unseen = visible.filter(r => !r.first_available_at);
    if (unseen.length) {
      const avail = await availableAt(unseen.map(r => r.shopify_product_id), loc.id);
      const shelf = await shelfLocationList(settings);
      const isShelfLocation = shelf.some(l => l.id === loc.id);
      for (const r of unseen) {
        if (!(avail.get(r.shopify_product_id) > 0)) continue;
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
      for (const r of list) {
        const p = info.get(r.shopify_product_id);
        const type = p.productType || 'No type';
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push({
          id: r.id,
          productId: r.shopify_product_id,
          title: p.title,
          vendor: p.vendor,
          thumbUrl: p.thumbUrl,
          imageUrl: p.imageUrl,
          newUntil: r.shelf_started_at ? addDays(ymd(r.shelf_started_at), settings.days) : null,
          enteredAt: r.entered_at,
        });
      }
      return [...byType.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
        .map(([type, items]) => ({ type, items })); // items already newest first
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

module.exports = { router, addStoreNewArrivals, runStoreNewArrivalDaily, _test: { addDays, todayLocal, getSettings, shelfLocationList } };
