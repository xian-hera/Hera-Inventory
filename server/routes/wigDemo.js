const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../database/init');

// Shopify shows inventory quantities sitting in the reserved / damaged /
// safety_stock / quality_control states collectively as "Unavailable" to
// merchants (there is no single "unavailable" quantity name in the API).
// "reserved" is the closest generic bucket — it's what Admin's manual
// "Adjust > Other" destination maps to — so that's what a wig demo occupies.
// See claude/DEMO_WIG_FEATURE_SPEC.md for the full research trail.
const DEMO_UNAVAILABLE_STATE = 'reserved';

async function getClient() {
  const { getShopify, getSession } = require('../shopify');
  const session = await getSession();
  const shopify = getShopify();
  return new shopify.clients.Graphql({ session });
}

// Looks up a variant by barcode for a given location, restricted to WIG
// product type + Active status (the "hidden" search condition for this
// feature — enforced here too so a direct barcode scan can't bypass it the
// way it could if this check only lived in the search results endpoint).
// Returns null if not found, not a WIG, or not Active.
async function fetchWigVariant(client, barcode, locationId) {
  const { activeFilter } = require('../shopify');
  // subType below (2026-09-17, Hera: Manager's Wig DEMO page groups demos
  // into cards by this metafield — see categorizeRow() below). Fetched in
  // the same request as wig_number rather than a second round-trip, same
  // reasoning as everywhere else metafields are batched onto this query.
  const query = `
    query getWigVariant($q: String!) {
      productVariants(first: 5, query: $q) {
        edges {
          node {
            id
            title
            sku
            barcode
            inventoryItem {
              id
              inventoryLevels(first: 20, includeInactive: true) {
                edges {
                  node {
                    location { id }
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
            metafield(namespace: "custom", key: "name") { value }
            product {
              id
              title
              productType
              featuredMedia {
                preview { image { url } }
              }
              wigNumber: metafield(namespace: "custom", key: "wig_number") { value }
              subType: metafield(namespace: "custom", key: "sub_type") { value }
            }
          }
        }
      }
    }
  `;
  const response = await client.request(query, {
    variables: { q: activeFilter(`barcode:${barcode}`) },
  });
  const variants = response.data?.productVariants?.edges || [];
  if (variants.length === 0) return null;

  const variant = variants[0].node;
  if ((variant.product.productType || '').toUpperCase() !== 'WIG') return null;

  const decodedLocationId = decodeURIComponent(locationId);
  const levels = variant.inventoryItem.inventoryLevels.edges;
  const level = levels.find(e => e.node.location.id === decodedLocationId);
  const availableQty = level?.node.quantities.find(q => q.name === 'available')?.quantity ?? 0;

  return {
    barcode: variant.barcode || variant.sku,
    name: variant.metafield?.value || variant.product.title,
    variantName: variant.title,
    wigNumber: variant.product.wigNumber?.value || '',
    subType: variant.product.subType?.value || '',
    image: variant.product.featuredMedia?.preview?.image?.url || null,
    productId: variant.product.id,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
    availableQty,
  };
}

// Wig Number: the same product-level custom.wig_number metafield already
// used elsewhere in this codebase (see attachWigNumbers() in transfers.js
// and attachPoWigNumbers() in poInvoices.js) — a manufacturer-assigned
// number Hera tracks per WIG product, read live from Shopify and never
// persisted (same "never store, always re-read" convention as custom.name
// display names throughout the app; see claude/DEMO_WIG_FEATURE_SPEC.md).
// Every row passed in here is already known to be a WIG (only WIG products
// can ever become a wig_demos row, enforced by fetchWigVariant above at
// creation time), so unlike attachPoWigNumbers() there's no "does this
// supplier/product carry WIG" gate — every row's barcode is just looked up
// directly, same as transfers.js's attachWigNumbers(). Batched 50 SKUs per
// request to stay within Shopify's rate limits, same chunk size used there.
//
// One retry per chunk on failure (2026-09-15, after Hera saw a demo show a
// real Wig number on one page load and "-" on another for the exact same
// item): this query is identical in shape to transfers.js's already-proven
// attachWigNumbers(), so a logic bug was unlikely — the more likely
// explanation is a transient Shopify throttling/network error on that one
// request, which this function was silently swallowing and treating as "no
// value" with no way to tell the two apart from the UI. A single retry
// after a short pause doesn't fix a real, persistent problem, but it does
// paper over exactly this kind of one-off hiccup instead of guessing.
// 2026-09-17 update (Hera: wig_number is now persisted on the row itself —
// see the wig_demos.wig_number migration in server/database/init.js — so
// this function is no longer called by every list-view page load, only by
// GET /export-pdf and POST /refresh-wig-numbers below, both of which are
// about to UPDATE the DB with whatever this resolves). That changes what
// "couldn't resolve a SKU" should mean: the old behavior set item.wig_number
// to '' whenever a SKU wasn't found in wigNumberBySku, which conflated two
// very different cases — "Shopify answered and genuinely has no value for
// this SKU" vs "the whole batched request for this SKU's chunk failed
// (network hiccup) and we simply never asked". Blanking a value on the
// latter was harmless when the result was just redisplayed and dropped, but
// would be a real data loss for a caller about to UPDATE it into the
// database — an already-known-good wig_number must not be overwritten with
// '' just because one Shopify request hiccupped. So this now only touches
// item.wig_number for SKUs whose chunk actually got a response (added to
// `resolved`, returned to the caller); every other item is left completely
// untouched, keeping whatever wig_number it already had (e.g. from the
// wig_demos.wig_number column the caller's SELECT * already read).
//
// 2026-09-17 update (Hera: Manager's Wig DEMO page now groups demos into
// cards by product custom.sub_type): this function now resolves sub_type in
// the exact same batched request as wig_number, rather than adding a second
// round of Shopify calls — every caller of this function already wants both
// fields refreshed together (see GET /, GET /export-pdf and
// POST /refresh-wig-numbers below). item.sub_type follows the identical
// resolved/unresolved rule as item.wig_number: only touched for SKUs whose
// chunk got a real response, left untouched otherwise, so a transient
// network failure never overwrites an already-known-good sub_type with ''.
async function attachWigNumbers(client, items) {
  const skus = [...new Set(items.map(i => i.barcode).filter(Boolean))];
  const resolved = new Set();
  if (skus.length === 0) return resolved;
  const { activeFilter } = require('../shopify');
  const wigNumberBySku = new Map();
  const subTypeBySku = new Map();
  const CHUNK_SIZE = 50;
  for (let i = 0; i < skus.length; i += CHUNK_SIZE) {
    const chunk = skus.slice(i, i + CHUNK_SIZE);
    const filter = activeFilter(chunk.map(s => `barcode:${s}`).join(' OR '));
    const query = `
      query wigNumbers($filter: String!) {
        productVariants(first: ${chunk.length}, query: $filter) {
          edges { node {
            barcode
            product {
              productType
              wigNumber: metafield(namespace: "custom", key: "wig_number") { value }
              subType: metafield(namespace: "custom", key: "sub_type") { value }
            }
          } }
        }
      }
    `;
    let response = null;
    for (let attempt = 1; attempt <= 2 && !response; attempt++) {
      try {
        response = await client.request(query, { variables: { filter } });
      } catch (e) {
        console.error(`wigDemo attachWigNumbers: batched lookup failed (attempt ${attempt}):`, e.message);
        if (attempt === 1) await new Promise(r => setTimeout(r, 400));
      }
    }
    if (!response) continue; // whole chunk failed both attempts — its SKUs stay unresolved
    chunk.forEach(sku => resolved.add(sku));
    const edges = response.data?.productVariants?.edges || [];
    edges.forEach(({ node }) => {
      if (node?.barcode && node?.product?.productType === 'WIG') {
        wigNumberBySku.set(node.barcode, node.product.wigNumber?.value || '');
        subTypeBySku.set(node.barcode, node.product.subType?.value || '');
      }
    });
  }
  items.forEach(item => {
    if (item.barcode && resolved.has(item.barcode)) {
      item.wig_number = wigNumberBySku.has(item.barcode) ? wigNumberBySku.get(item.barcode) : '';
      item.sub_type = subTypeBySku.has(item.barcode) ? subTypeBySku.get(item.barcode) : '';
    }
  });
  return resolved;
}

// Natural-sort compare for two wig numbers (2026-09-16, Hera follow-up: the
// first cut of this used a plain alphabetical string compare per her first
// wording ("字母顺序"), which put "W10" before "W9" — wrong, since Hera's
// actual wig numbers are letters-then-digits (e.g. "W9", "W10") and she wants
// same-letter groups ordered by the numeric part, not lexicographically).
// This splits each string into alternating runs of digits and non-digits
// (e.g. "W10" -> ["W", "10"]) and compares run-by-run: digit runs numerically,
// everything else case-insensitively as text. That correctly handles the
// documented "letters + number" format (same-letter rows fall back to
// comparing their digit run as a number) and degrades gracefully for any
// value that doesn't fit that shape instead of assuming it always will.
function naturalCompare(a, b) {
  const tokenize = (s) => s.match(/(\d+)|(\D+)/g) || [];
  const ta = tokenize(a);
  const tb = tokenize(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const pa = ta[i];
    const pb = tb[i];
    if (pa === undefined) return -1; // a ran out of tokens first -> a is a "prefix" of b, sorts first
    if (pb === undefined) return 1;
    const isNumA = /^\d+$/.test(pa);
    const isNumB = /^\d+$/.test(pb);
    if (isNumA && isNumB) {
      const diff = parseInt(pa, 10) - parseInt(pb, 10);
      if (diff !== 0) return diff;
    } else {
      const cmp = pa.localeCompare(pb, undefined, { sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

// Sort order for every wig-demo list view (2026-09-16, Hera: "让列表里的所有
// 条目总是按照 wig number 来排列...用自然排序，我们的 wig number 会是字母加
// 数字的格式，字母相同的条目，要按照数字大小排列") — call this after
// attachWigNumbers() has populated wig_number on every row (it reads
// item.wig_number, so it's a no-op / falls back to the existing order if the
// lookup above failed). A row with no wig_number (lookup failed, or
// genuinely never set) sorts to the very end rather than first, since an
// empty string would otherwise be treated as alphabetically smallest and
// bury every real value under a block of blanks. Sort is stable, so rows
// that tie (equal wig_number, or several blanks) keep whatever order the SQL
// query above already put them in.
function sortByWigNumber(rows) {
  rows.sort((a, b) => {
    const wa = (a.wig_number || '').toString().trim();
    const wb = (b.wig_number || '').toString().trim();
    if (!wa && !wb) return 0;
    if (!wa) return 1;
    if (!wb) return -1;
    return naturalCompare(wa, wb);
  });
}

// ─── Manager Wig DEMO card grouping (2026-09-17, Hera) ─────────────────────
// Manager's page groups demos into cards by product custom.sub_type, split
// further by whether wig_number marks the demo as cleared-out stock
// ("SOLDE"). See claude/DEMO_WIG_FEATURE_SPEC.md §32 for the full design
// discussion this implements. Kept here (not just client-side) so GET /,
// GET /export-pdf and the frontend all agree on exactly the same rule — the
// JSON response from GET / carries the computed `category`/`section` back to
// the client (see categorizeRow below) instead of the client re-deriving it,
// so there's only one place this mapping can ever drift.

// Hera's word-for-word sub_type -> card name mapping. Matched case-
// insensitively (Hera: Shopify always stores these upper-case, but match
// loosely anyway rather than assume that never changes). Returns null for
// blank or unrecognized values — callers treat that the same as "sub type
// not found", since both mean this row can't be placed in one of the 6
// known cards.
const SUB_TYPE_TO_CARD = {
  'FULL WIGS': 'FULL',
  'HALF WIGS': 'HALF',
  'LACE WIGS': 'LACE',
  'HUMAN HAIR WIGS': 'HUMAN HAIR',
  'HUMAN MIX WIGS': 'HUMAN HAIR', // union with HUMAN HAIR WIGS, per Hera
  'TOPPERS': 'TOPPERS',
};
function subTypeToCard(subType) {
  const key = (subType || '').toString().trim().toUpperCase();
  return SUB_TYPE_TO_CARD[key] || null;
}

// Card display order (Hera's explicit order) and, within the SOLDE card, the
// section order for its 5 divided sub-lists (same 5 names, SOLDE excluded
// since it isn't a sub_type — it's the purchase-status card itself).
const CARD_ORDER = ['FULL', 'HALF', 'LACE', 'HUMAN HAIR', 'TOPPERS', 'SOLDE'];
const SOLDE_SECTION_ORDER = ['FULL', 'HALF', 'LACE', 'HUMAN HAIR', 'TOPPERS'];

// wig_number === "SOLDE" (exact match, case-insensitive per Hera) marks a
// demo as cleared-out stock — checked before sub_type in the placement rule,
// per Hera's §32 spec: "首先看这个 wig 的 wig number 是否为 SOLDE".
function isSoldeWigNumber(wigNumber) {
  return (wigNumber || '').toString().trim().toUpperCase() === 'SOLDE';
}

// Returns { card, section } for one wig_demos row — `card` is one of
// CARD_ORDER or 'UNKNOWN' ("Sub type not found" — Hera, 2026-09-17: a demo
// whose sub_type Shopify itself has no value for; see the sub_type migration
// note in server/database/init.js for the NULL-vs-'' distinction this reads).
// `section` is only meaningful when card === 'SOLDE' (one of
// SOLDE_SECTION_ORDER); null otherwise.
function categorizeRow(row) {
  const baseCard = subTypeToCard(row.sub_type);
  if (!baseCard) return { card: 'UNKNOWN', section: null };
  if (isSoldeWigNumber(row.wig_number)) return { card: 'SOLDE', section: baseCard };
  return { card: baseCard, section: null };
}

// Moves exactly 1 unit between two named quantity states for one inventory
// item at one location, without touching on_hand — this is deliberately
// inventoryMoveQuantities, not inventoryAdjustQuantities (the latter is a
// real physical delta and would change on_hand too, which is wrong here:
// the wig physically stays in the store). changeFromQuantity is passed null
// on both terminals (opts out of the API's compare-and-swap check) — same
// convention as stockLosses.js's inventoryAdjustQuantities calls elsewhere
// in this codebase, since we don't have a fresh per-state quantity in hand
// at call time. @idempotent is required as of Shopify API 2026-04.
//
// Two *different* URI fields are involved here, confirmed against
// shopify.dev (2026-09-15, after a live "A ledger document URI is required
// except when adjusting available" error surfaced this): `referenceDocumentUri`
// is a top-level, freeform audit field on the whole input; `ledgerDocumentUri`
// is a separate field that must be set on whichever terminal (from/to) has a
// `name` other than "available" — required on that terminal, not allowed to
// be omitted, and NOT satisfied by the top-level referenceDocumentUri alone.
// Since this app's moves are always available<->reserved, exactly one of
// from/to is ever the non-"available" side; we reuse the same URI value for
// both fields since they're independent but nothing here calls for them to
// differ.
async function moveInventory(client, { inventoryItemId, locationId, fromName, toName, reason, referenceDocumentUri }) {
  const mutation = `
    mutation moveQty($input: InventoryMoveQuantitiesInput!, $idempotencyKey: String!) {
      inventoryMoveQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup { id }
        userErrors { field message code }
      }
    }
  `;
  const response = await client.request(mutation, {
    variables: {
      input: {
        reason,
        referenceDocumentUri,
        changes: [{
          quantity: 1,
          inventoryItemId,
          from: {
            locationId, name: fromName, changeFromQuantity: null,
            ...(fromName !== 'available' ? { ledgerDocumentUri: referenceDocumentUri } : {}),
          },
          to: {
            locationId, name: toName, changeFromQuantity: null,
            ...(toName !== 'available' ? { ledgerDocumentUri: referenceDocumentUri } : {}),
          },
        }],
      },
      idempotencyKey: crypto.randomUUID(),
    },
  });
  const userErrors = response.data?.inventoryMoveQuantities?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map(e => e.message).join('; '));
  }
  return response;
}

// GET /api/wig-demo/buyer?locations=MTL01,MTL02 — grouped-by-location list
// for the Buyer supervise page. Registered before the bare GET / below so
// "buyer" can never be swallowed as a :param (mirrors the ordering lesson
// already documented for Box PO's routes elsewhere in this codebase).
router.get('/buyer', async (req, res) => {
  try {
    const { locations } = req.query;
    let result;
    if (locations) {
      const locs = locations.split(',').filter(Boolean);
      if (locs.length === 0) return res.json([]);
      result = await pool.query(
        'SELECT * FROM wig_demos WHERE location = ANY($1) ORDER BY location, created_at DESC',
        [locs]
      );
    } else {
      result = await pool.query('SELECT * FROM wig_demos ORDER BY location, created_at DESC');
    }
    const rows = result.rows;
    // wig_number now comes straight off the wig_demos.wig_number column
    // (2026-09-17, Hera — this route used to call attachWigNumbers() here on
    // every single load, which is what made Buyer's page take 7-11s to open:
    // ~20 sequential Shopify round-trips for the ~955 distinct SKUs across
    // every location. wig_number is persisted at creation time (POST / and
    // POST /import below) and kept fresh via the "Refresh Wig Number" button
    // (POST /refresh-wig-numbers below) and GET /export-pdf, so this route no
    // longer needs to talk to Shopify at all — see
    // claude/DEMO_WIG_FEATURE_SPEC.md for the full before/after.
    // Sorted globally by wig_number (see sortByWigNumber() above) rather than
    // per-location — the frontend buckets this flat list into one card per
    // location afterwards (BuyerWigDemo.js's byLocation grouping), and since
    // Array#sort is stable, each location's bucket ends up in wig_number
    // order too once it's filtered out of this single sorted array.
    sortByWigNumber(rows);
    res.json(rows);
  } catch (e) {
    console.error('GET /api/wig-demo/buyer error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/wig-demo/lookup?barcode=&locationId=&location= — resolves a
// barcode (from search-result "Add" or a raw scan) to the info the Add Demo
// modal needs. Used to also flag alreadyDemo so the frontend could block
// re-adding a SKU that's already this location's current demo — that block
// is gone (Hera, 2026-09-16): the demo that just sold and the new demo
// being made can legitimately be the exact same variant, so making a new
// demo for an already-demoed SKU is now just a normal replace. See the
// same-SKU shortcut in the POST handler below.
router.get('/lookup', async (req, res) => {
  try {
    const { barcode, locationId, location } = req.query;
    if (!barcode || !locationId || !location) {
      return res.status(400).json({ error: 'barcode, locationId and location required' });
    }

    const client = await getClient();
    const info = await fetchWigVariant(client, barcode, locationId);
    if (!info) return res.status(404).json({ error: 'WIG product not found (or not Active) for this barcode' });

    if (info.availableQty < 1) {
      return res.status(400).json({ error: `No available stock (${info.availableQty}) at this location to make into a demo.` });
    }

    // Sub type gate (Hera, 2026-09-17): Manager's page groups demos into
    // cards by custom.sub_type, and per Hera every WIG product should always
    // have this metafield set — a blank value here means it was never filled
    // in on the Shopify side. Rather than letting a demo get created that
    // then can't be placed in any of the 6 cards, this is blocked at the
    // same lookup step "No available stock" already blocks at, before the
    // Add Demo modal even opens.
    if (!info.subType) {
      return res.status(400).json({ error: 'Sub type not found, please contact Buyer' });
    }

    res.json(info);
  } catch (e) {
    console.error('GET /api/wig-demo/lookup error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/wig-demo?location=MTL01 — Manager's own-location list.
router.get('/', async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'location required' });
    const result = await pool.query(
      'SELECT * FROM wig_demos WHERE location = $1 ORDER BY created_at DESC',
      [location]
    );
    const rows = result.rows;
    // wig_number now comes straight off the wig_demos.wig_number column,
    // same as GET /buyer above (2026-09-17, Hera — no more per-load Shopify
    // call here either).

    // sub_type self-heal (2026-09-17, Hera): this page now groups demos into
    // cards by sub_type, so unlike wig_number (a purely decorative field that
    // can sit blank until someone clicks Refresh) a row with no sub_type
    // can't be placed in any card at all. Hera's explicit choice here (over
    // the lighter background-patch approach used for wig_number's own
    // straggler auto-heal in ManagerWigDemo.js): resolve it right now, before
    // responding, so the page always renders fully categorized. NULL means
    // "never checked" (every pre-existing row, until this runs once for it);
    // '' means "checked, Shopify confirmed no value" and is deliberately NOT
    // re-checked here every load (see the sub_type migration note in
    // server/database/init.js) — those go to the "Sub type not found" card
    // instead. Scoped to just this location's own never-checked rows, so
    // each location only ever pays this cost once (the first load after this
    // deploys, or after a genuinely new row that failed this lookup earlier),
    // not on every page open.
    const uncheckedSubType = rows.filter(r => r.sub_type === null);
    if (uncheckedSubType.length > 0) {
      try {
        const client = await getClient();
        const resolved = await attachWigNumbers(client, uncheckedSubType);
        const toUpdate = uncheckedSubType.filter(r => r.barcode && resolved.has(r.barcode));
        if (toUpdate.length > 0) {
          await Promise.all(toUpdate.map(r =>
            pool.query(
              'UPDATE wig_demos SET wig_number = $1, sub_type = $2 WHERE id = $3',
              [r.wig_number || null, r.sub_type != null ? r.sub_type : null, r.id]
            )
          ));
        }
      } catch (e) {
        // Best-effort — a Shopify hiccup here just leaves these rows with
        // sub_type still NULL (they'll fall into "Sub type not found" for
        // this load and be retried on the next one, same as any other
        // unresolved-chunk case in attachWigNumbers).
        console.error('GET /api/wig-demo: sub_type self-heal failed:', e.message);
      }
    }

    sortByWigNumber(rows);
    // Category/section is computed here (not on the client) so GET /,
    // GET /export-pdf and the frontend can never disagree about which card a
    // row belongs in — see categorizeRow() above.
    rows.forEach(r => {
      const { card, section } = categorizeRow(r);
      r.category = card;
      r.section = section;
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /api/wig-demo error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/wig-demo/export-pdf?location=MTL01 — same list as GET / above
// (Manager's own-location current demos), rendered as a printable PDF table
// so Manager can print it and walk the floor doing a physical check against
// what the app currently thinks is on demo (Hera, 2026-09-16: "方便 manager
// 进行打印并实物检查", "格式上，就是列表内容就好" — just the list content, no
// extra formatting). Reuses the same pdfkit table-drawing approach already
// proven in poInvoices.js's GET /:id/export-pdf rather than inventing a new
// PDF layout from scratch. Columns match what the Manager list actually
// shows (SKU, Name, Color, Wig number, Demo date) rather than the mobile
// screen's merged single-column layout (§16) — that merge only exists to
// cope with narrow phone width, a printed LETTER page has plenty of room for
// separate columns.
router.get('/export-pdf', async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'location required' });
    const result = await pool.query(
      'SELECT * FROM wig_demos WHERE location = $1 ORDER BY created_at DESC',
      [location]
    );
    const rows = result.rows;
    // Unlike the on-screen list views (GET /buyer, GET / above), which now
    // read wig_number straight from the DB for speed, this export still
    // queries Shopify live and updates the DB before rendering (Hera,
    // 2026-09-17: "导出 PDF 这一步，可以查 shopify，更新一下 wig number，而不是
    // 读库") — a Manager printing this to physically check the floor wants
    // the current value, not whatever was last persisted. A row whose lookup
    // fails (see attachWigNumbers()'s `resolved` tracking above) just keeps
    // printing whatever wig_number is already in the DB rather than blocking
    // the export or blanking it.
    try {
      const client = await getClient();
      const resolved = await attachWigNumbers(client, rows);
      const toUpdate = rows.filter(r => r.barcode && resolved.has(r.barcode));
      if (toUpdate.length > 0) {
        // sub_type refreshed together with wig_number here too (2026-09-17,
        // Hera — same reasoning as POST /refresh-wig-numbers below: one
        // Shopify call updates both, and this route already queries Shopify
        // live on every export anyway). r.sub_type is a resolved string ('
        // included) for every row in toUpdate, written as-is rather than
        // `|| null` — see the sub_type migration note in
        // server/database/init.js for why '' is a meaningful state here, not
        // something to collapse away.
        await Promise.all(toUpdate.map(r =>
          pool.query(
            'UPDATE wig_demos SET wig_number = $1, sub_type = $2 WHERE id = $3',
            [r.wig_number || null, r.sub_type, r.id]
          )
        ));
      }
    } catch (e) {
      console.error('GET /api/wig-demo/export-pdf: wig number refresh failed:', e.message);
    }
    // Same wig_number ordering as the on-screen Manager list (GET / above) —
    // so a Manager printing this to physically check the floor sees the same
    // row order on paper as they do on screen.
    sortByWigNumber(rows);
    // Category/section (2026-09-17, Hera: "PDF 也分组打印...每个 type 有标题...
    // SOLDE 区的 type 也有小标题...标题后面跟上数目" — grouped the same way as
    // the on-screen Manager cards; see categorizeRow() above and the grouped
    // rendering below).
    rows.forEach(r => {
      const { card, section } = categorizeRow(r);
      r.category = card;
      r.section = section;
    });

    const PDFDocument = require('pdfkit');

    const dateForFile = new Date().toISOString().slice(0, 10);
    const filename = `wig-demo_${location}_${dateForFile}.pdf`;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    doc.pipe(res);

    doc.fontSize(16).text(`Wig DEMO — ${location}`, { continued: false });
    doc.fontSize(9).fillColor('#6d7175').text(new Date().toLocaleDateString('en-US'));
    doc.moveDown(0.5);

    // Check column (2026-09-16, Hera: "可以加一个空白 column 在最右侧") — a blank
    // hand-fill column so Manager can tick/note each row while physically
    // walking the floor comparing it against this printed list, same idea as
    // the blank "Count" column on PO Receiving's export-pdf (poInvoices.js).
    // key: null means cellValue() below always renders it empty.
    const cols = [
      { label: 'SKU', width: 80, key: 'barcode' },
      { label: 'Name', width: 125, key: 'name' },
      { label: 'Color', width: 75, key: 'variant_name' },
      { label: 'Wig number', width: 60, key: 'wig_number' },
      { label: 'Demo date', width: 60, key: '__date' },
      { label: 'Check', width: 130, key: null },
    ];
    const startX = doc.page.margins.left;
    const tableWidth = cols.reduce((s, c) => s + c.width, 0);
    const rowVPad = 8; // top+bottom padding inside each row, on top of the wrapped text height
    const headerHeight = 20;

    const drawHeader = (y) => {
      let x = startX;
      doc.fontSize(9).fillColor('#6d7175');
      cols.forEach(c => { doc.text(c.label, x, y, { width: c.width }); x += c.width; });
      doc.moveTo(startX, y + headerHeight - 6).lineTo(startX + tableWidth, y + headerHeight - 6)
        .strokeColor('#c9cccf').lineWidth(1).stroke();
    };

    const cellValue = (row, col) => {
      if (col.key === '__date') {
        return row.created_at ? new Date(row.created_at).toLocaleDateString('en-US') : '';
      }
      return row[col.key] || '';
    };

    let y = doc.y;
    drawHeader(y);
    y += headerHeight;
    doc.fillColor('#000');

    // Row height adapts to however tall the tallest wrapped cell is (Name is
    // the one most likely to wrap), same approach as poInvoices.js's
    // export-pdf, so wrapped text never crowds into the next row.
    const drawRow = (row) => {
      doc.fontSize(9);
      // Check column has no content (key: null) so it's excluded here, same
      // as poInvoices.js's blank Count column — it never drives row height.
      const cellHeights = cols.map(c => (c.key === null ? 0 : doc.heightOfString(cellValue(row, c), { width: c.width })));
      const contentHeight = Math.max(...cellHeights, 10);
      const rowHeight = contentHeight + rowVPad;

      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader(y);
        y += headerHeight;
        doc.fillColor('#000');
      }

      let x = startX;
      cols.forEach(c => {
        if (c.key !== null) doc.text(cellValue(row, c), x, y, { width: c.width });
        x += c.width;
      });
      y += rowHeight;

      doc.moveTo(startX, y - 4).lineTo(startX + tableWidth, y - 4)
        .strokeColor('#f1f1f1').lineWidth(0.5).stroke();
      doc.fillColor('#000');
    };

    // Group title line (2026-09-17, Hera: "PDF 也分组打印...每个 type 有标题...
    // 不用像 card 那么华丽,只要区分开...标题后面跟上数目"). Plain bold-ish text,
    // no border/box like the on-screen cards. `indent`/smaller `fontSize` is
    // used for SOLDE's 5 inner sub-type sections so they read as nested
    // under the SOLDE heading rather than as their own top-level cards.
    const drawGroupTitle = (text, { indent = 0, fontSize = 11, color = '#202223' } = {}) => {
      const titleHeight = fontSize + 10;
      if (y + titleHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader(y);
        y += headerHeight;
      }
      doc.fontSize(fontSize).fillColor(color).text(text, startX + indent, y + 4, { width: tableWidth - indent });
      y += titleHeight;
      doc.fillColor('#000');
    };

    const byCard = {};
    rows.forEach(r => {
      if (!byCard[r.category]) byCard[r.category] = [];
      byCard[r.category].push(r);
    });

    // Same 6-card order as the on-screen Manager cards (CARD_ORDER above),
    // and — per Hera — every card gets a title line even with 0 demos in it,
    // same as the screen.
    CARD_ORDER.forEach(card => {
      if (card !== 'SOLDE') {
        const items = byCard[card] || [];
        drawGroupTitle(`${card} (${items.length})`, { fontSize: 12 });
        items.forEach(drawRow);
        return;
      }
      // SOLDE — split into the same 5 sub-type sections as the on-screen
      // SOLDE card, each with its own small title + count, 0-count sections
      // included.
      const soldeItems = byCard.SOLDE || [];
      drawGroupTitle(`SOLDE (${soldeItems.length})`, { fontSize: 12 });
      SOLDE_SECTION_ORDER.forEach(section => {
        const sectionItems = soldeItems.filter(r => r.section === section);
        drawGroupTitle(`${section} (${sectionItems.length})`, { indent: 14, fontSize: 10, color: '#6d7175' });
        sectionItems.forEach(drawRow);
      });
    });

    // "Sub type not found" (Hera, 2026-09-17): demos whose product has no
    // custom.sub_type value in Shopify at all. Not one of Hera's 6 official
    // cards, so — unlike those 6 — this is only printed when non-empty
    // rather than always showing a permanent "(0)" line.
    const unknownItems = byCard.UNKNOWN || [];
    if (unknownItems.length > 0) {
      drawGroupTitle(`Sub type not found — contact Buyer (${unknownItems.length})`, { fontSize: 12, color: '#d82c0d' });
      unknownItems.forEach(drawRow);
    }

    doc.end();
  } catch (e) {
    console.error('GET /api/wig-demo/export-pdf error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wig-demo — "Make DEMO". If this location already has a demo for
// the same product, that old demo is replaced (a product has at most one
// demo per location at any time): released back to Available and removed,
// then the new one is added. Two cases:
//   - Different variant of the same product: 2 inventoryMoveQuantities
//     calls — release the old one (reserved -> available), then move the
//     new one (available -> reserved).
//   - The *exact same SKU* as the demo being replaced (Hera, 2026-09-16 —
//     this used to be blocked outright with a 400 "This SKU is already the
//     current demo" error, but that was wrong: the demo that just sold and
//     the new demo being made can legitimately be the identical variant,
//     e.g. restocked and re-demoed in the same color). In that case no
//     Shopify call is made at all — releasing the unit and immediately
//     re-occupying the same state on the same inventory item nets to
//     exactly zero, so this just swaps the DB row (delete old, insert new)
//     so the demo's created_at still reflects that a new demo was made.
// If there's no existing demo for this product yet, it's just a normal
// Available -> Unavailable move for the new SKU.
router.post('/', async (req, res) => {
  try {
    const {
      location, shopifyLocationId, barcode, name, variantName,
      productId, variantId, inventoryItemId, wigNumber, subType,
    } = req.body;
    if (!location || !shopifyLocationId || !barcode || !productId || !variantId || !inventoryItemId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // Defensive re-check (2026-09-17, Hera): GET /lookup already blocks the
    // Add Demo modal from ever opening for a product with no sub_type, so
    // this should never actually trigger — kept anyway so this route can't
    // insert an uncategorizable row even if something upstream changes.
    if (!subType) {
      return res.status(400).json({ error: 'Sub type not found, please contact Buyer' });
    }

    const client = await getClient();

    const existingProduct = await pool.query(
      'SELECT * FROM wig_demos WHERE location = $1 AND shopify_product_id = $2',
      [location, productId]
    );
    const oldRow = existingProduct.rows[0] || null;
    const sameSkuReplace = !!(oldRow && oldRow.barcode === barcode);

    let replaced = null;
    let replaceWarning = null;

    if (sameSkuReplace) {
      // Same variant already occupying the 1 unit — no Shopify call needed,
      // see the route comment above. A DB failure here (rare) just falls
      // through to the outer catch and a 500, same as any other query in
      // this handler.
      await pool.query('DELETE FROM wig_demos WHERE id = $1', [oldRow.id]);
      replaced = oldRow;
    } else {
      await moveInventory(client, {
        inventoryItemId,
        locationId: shopifyLocationId,
        fromName: 'available',
        toName: DEMO_UNAVAILABLE_STATE,
        reason: 'promotion',
        referenceDocumentUri: `wig-demo://${encodeURIComponent(location)}/${encodeURIComponent(barcode)}/${Date.now()}`,
      });

      if (oldRow) {
        // Different variant of the same product — it's being replaced:
        // release its 1 unit back to Available and drop it from the list.
        // If the release call itself fails, don't block the new demo from
        // being recorded — surface it as a warning instead, so the manager
        // can deal with the stuck old row (e.g. via Cancel DEMO) rather
        // than losing the new demo they just made.
        try {
          await moveInventory(client, {
            inventoryItemId: oldRow.inventory_item_id,
            locationId: oldRow.shopify_location_id,
            fromName: DEMO_UNAVAILABLE_STATE,
            toName: 'available',
            reason: 'restock',
            referenceDocumentUri: `wig-demo-release://${encodeURIComponent(oldRow.location)}/${encodeURIComponent(oldRow.barcode)}/${Date.now()}`,
          });
          await pool.query('DELETE FROM wig_demos WHERE id = $1', [oldRow.id]);
          replaced = oldRow;
        } catch (e) {
          console.error('Wig Demo: failed to release replaced demo', oldRow.id, e.message);
          replaceWarning = `Could not release the previous demo (${oldRow.barcode}) back to Available: ${e.message}. Please Cancel DEMO on it manually.`;
        }
      }
    }

    const inserted = await pool.query(
      `INSERT INTO wig_demos
        (location, shopify_location_id, shopify_product_id, shopify_variant_id,
         inventory_item_id, barcode, name, variant_name, wig_number, sub_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [location, shopifyLocationId, productId, variantId, inventoryItemId, barcode, name || null, variantName || null, wigNumber || null, subType]
    );

    res.json({ success: true, row: inserted.rows[0], replaced, replaceWarning });
  } catch (e) {
    console.error('POST /api/wig-demo error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wig-demo/import — one-time bulk migration tool (Hera,
// 2026-09-15): bring in the wig demo list Hera was tracking elsewhere.
// Removed 2026-09-16 once that migration was done, then restored the same
// day per Hera's request ("一切照原样"). At restore time this route's
// removal (and everything committed after it — §19.2, §22, §23 in
// claude/DEMO_WIG_FEATURE_SPEC.md) had never been committed, so pulling the
// exact original bytes from git would have meant reverting all of that too;
// Hera opted instead to have this rebuilt from the spec's §13 design notes.
// Behavior should match what was there before — exact comment wording may
// not.
//
// Body: { rows: [{ sku, location }, ...] } — CSV already parsed client-side
// (see BuyerWigDemo.js's handleImportFileSelected). Each (location, sku)
// pair is an independent new demo — unlike Make DEMO (POST / above), this
// does NOT check for/replace an existing demo of the same *product*; a row
// is only skipped if that exact SKU is already this location's current
// demo.
//
// Business rules (Hera, 2026-09-15):
//  - A (location, SKU) pair that appears more than once in the same request
//    is skipped entirely — every occurrence of it, not just the extras.
//  - A SKU already the current demo at its location: skipped.
//  - SKU not found / not Active / not a WIG product / 0 available stock at
//    that location: skipped (reusing fetchWigVariant, same WIG+Active gate
//    as everywhere else in this file).
// Rows are processed serially (not Promise.all), with a 350ms politeness
// delay between each one's Shopify calls — same convention as
// server/jobs/syncVariantIndex.js — since a real import batch can be large
// enough to risk Shopify rate limiting if fired all at once.
router.post('/import', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows required' });
    }

    // Count (location, sku) occurrences up front so every row sharing a
    // duplicated pair can be skipped, not just the ones after the first.
    const pairCounts = new Map();
    rows.forEach(r => {
      const key = `${r.location}::${r.sku}`;
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    });

    // Resolve every distinct location code to its Shopify location GID up
    // front in one query — same location_map table used elsewhere in this
    // codebase (poInvoices.js, transfers.js).
    const distinctLocations = [...new Set(rows.map(r => r.location).filter(Boolean))];
    const locMapRes = distinctLocations.length > 0
      ? await pool.query('SELECT location_name, shopify_location_id FROM location_map WHERE location_name = ANY($1)', [distinctLocations])
      : { rows: [] };
    const shopifyLocationIdByName = new Map(locMapRes.rows.map(r => [r.location_name, r.shopify_location_id]));

    const client = await getClient();
    const imported = [];
    const skipped = [];

    for (const r of rows) {
      const sku = (r.sku || '').toString().trim();
      const location = (r.location || '').toString().trim();
      if (!sku || !location) {
        skipped.push({ sku, location, reason: 'missing SKU or location' });
        continue;
      }

      const key = `${location}::${sku}`;
      if (pairCounts.get(key) > 1) {
        skipped.push({ sku, location, reason: 'duplicate (location, SKU) in this import' });
        continue;
      }

      const shopifyLocationId = shopifyLocationIdByName.get(location);
      if (!shopifyLocationId) {
        skipped.push({ sku, location, reason: 'unknown location' });
        continue;
      }

      try {
        const existing = await pool.query(
          'SELECT id FROM wig_demos WHERE location = $1 AND barcode = $2',
          [location, sku]
        );
        if (existing.rows.length > 0) {
          skipped.push({ sku, location, reason: 'already the current demo at this location' });
          continue;
        }

        const info = await fetchWigVariant(client, sku, shopifyLocationId);
        if (!info) {
          skipped.push({ sku, location, reason: 'not found, not Active, or not a WIG product' });
          continue;
        }
        if (info.availableQty < 1) {
          skipped.push({ sku, location, reason: `no available stock (${info.availableQty})` });
          continue;
        }
        // Sub type gate (Hera, 2026-09-17) — same rule as the single-item
        // GET /lookup above, but skipping this one row rather than rejecting
        // the whole import batch, same as every other per-row skip reason in
        // this loop.
        if (!info.subType) {
          skipped.push({ sku, location, reason: 'sub type not found, contact buyer' });
          continue;
        }

        await moveInventory(client, {
          inventoryItemId: info.inventoryItemId,
          locationId: shopifyLocationId,
          fromName: 'available',
          toName: DEMO_UNAVAILABLE_STATE,
          reason: 'promotion',
          referenceDocumentUri: `wig-demo-import://${encodeURIComponent(location)}/${encodeURIComponent(sku)}/${Date.now()}`,
        });

        const inserted = await pool.query(
          `INSERT INTO wig_demos
            (location, shopify_location_id, shopify_product_id, shopify_variant_id,
             inventory_item_id, barcode, name, variant_name, wig_number, sub_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [location, shopifyLocationId, info.productId, info.variantId, info.inventoryItemId, sku, info.name || null, info.variantName || null, info.wigNumber || null, info.subType]
        );
        imported.push(inserted.rows[0]);
      } catch (e) {
        // Partial-failure handling, same approach as everywhere else in this
        // file: one row's Shopify error doesn't stop the rest of the batch.
        console.error(`POST /api/wig-demo/import: row failed (${location}/${sku}):`, e.message);
        skipped.push({ sku, location, reason: e.message });
      }

      await new Promise(r => setTimeout(r, 350));
    }

    res.json({ success: true, imported, skipped });
  } catch (e) {
    console.error('POST /api/wig-demo/import error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wig-demo/refresh-wig-numbers — "Refresh Wig Number" button (Hera,
// 2026-09-17): re-queries Shopify live for wig_number and updates the DB for
// the demos in scope, then returns the refreshed list in the same shape as
// GET /buyer / GET / above, so the caller can just replace its on-screen
// list with the response.
// Body: { location } — omitted/blank means every location (Buyer's button;
// per Hera this also doubles as the one-time backfill for the rows that
// predate the wig_number column — she runs it once after this deploys).
// Provided means only that one location (Manager's button, scoped the same
// way as the rest of Manager's own page — per Hera's answer, it does NOT
// cover every location).
// Unlike GET /buyer, GET / and GET /export-pdf, a Shopify failure here is
// NOT swallowed — surfaced as a 500 instead, since the whole point of
// clicking this button is to refresh, so silently doing nothing would be
// misleading.
router.post('/refresh-wig-numbers', async (req, res) => {
  try {
    const { location } = req.body || {};
    const result = location
      ? await pool.query('SELECT * FROM wig_demos WHERE location = $1 ORDER BY created_at DESC', [location])
      : await pool.query('SELECT * FROM wig_demos ORDER BY location, created_at DESC');
    const rows = result.rows;

    const client = await getClient();
    const resolved = await attachWigNumbers(client, rows);
    const toUpdate = rows.filter(r => r.barcode && resolved.has(r.barcode));
    if (toUpdate.length > 0) {
      // sub_type is refreshed together with wig_number now (2026-09-17, Hera
      // — this button doubles as the sub_type refresh too, one Shopify call
      // covers both). r.sub_type is a resolved string ('' included) for
      // every row in toUpdate since attachWigNumbers() just set it above, so
      // this is written as-is (not `|| null`) — unlike wig_number, '' here is
      // a meaningful, intentionally-persisted "Shopify confirmed no value"
      // state, not "blank because we skip it" (see the sub_type migration
      // note in server/database/init.js).
      await Promise.all(toUpdate.map(r =>
        pool.query(
          'UPDATE wig_demos SET wig_number = $1, sub_type = $2 WHERE id = $3',
          [r.wig_number || null, r.sub_type, r.id]
        )
      ));
    }

    sortByWigNumber(rows);
    // Same category/section annotation as GET / above, so Manager's
    // "Refresh Wig Number" button can re-render its cards straight from this
    // response without re-deriving the mapping itself.
    rows.forEach(r => {
      const { card, section } = categorizeRow(r);
      r.category = card;
      r.section = section;
    });
    res.json(rows);
  } catch (e) {
    console.error('POST /api/wig-demo/refresh-wig-numbers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/wig-demo — "Cancel DEMO", Buyer-only (Manager had this too for
// a while, but Hera had it removed 2026-09-16 — Manager can no longer cancel
// a demo on their own; see claude/DEMO_WIG_FEATURE_SPEC.md §18). The route
// itself is untouched, since Buyer still needs it — only ManagerWigDemo.js's
// UI access to it was removed. Releases each selected row's 1 unit back to
// Available and removes the row. No same-product check here — this is a
// manual override, not a replacement, so it just processes exactly what was
// selected.
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });

    const client = await getClient();
    const deletedIds = [];
    const errors = [];

    for (const id of ids) {
      try {
        const rowRes = await pool.query('SELECT * FROM wig_demos WHERE id = $1', [id]);
        if (rowRes.rows.length === 0) { errors.push(`ID ${id}: not found`); continue; }
        const row = rowRes.rows[0];

        await moveInventory(client, {
          inventoryItemId: row.inventory_item_id,
          locationId: row.shopify_location_id,
          fromName: DEMO_UNAVAILABLE_STATE,
          toName: 'available',
          reason: 'restock',
          referenceDocumentUri: `wig-demo-cancel://${encodeURIComponent(row.location)}/${encodeURIComponent(row.barcode)}/${Date.now()}`,
        });

        await pool.query('DELETE FROM wig_demos WHERE id = $1', [id]);
        deletedIds.push(id);
      } catch (e) {
        errors.push(`ID ${id}: ${e.message}`);
      }
    }

    res.json({ success: true, deletedIds, errors });
  } catch (e) {
    console.error('DELETE /api/wig-demo error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
