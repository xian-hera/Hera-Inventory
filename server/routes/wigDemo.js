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
async function attachWigNumbers(client, items) {
  const skus = [...new Set(items.map(i => i.barcode).filter(Boolean))];
  if (skus.length === 0) return;
  const { activeFilter } = require('../shopify');
  const wigNumberBySku = new Map();
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
    if (!response) continue;
    const edges = response.data?.productVariants?.edges || [];
    edges.forEach(({ node }) => {
      if (node?.barcode && node?.product?.productType === 'WIG') {
        wigNumberBySku.set(node.barcode, node.product.wigNumber?.value || '');
      }
    });
  }
  items.forEach(item => {
    item.wig_number = item.barcode && wigNumberBySku.has(item.barcode) ? wigNumberBySku.get(item.barcode) : '';
  });
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
    // Wig Number column (see attachWigNumbers() above) — Buyer can view
    // demos across every location at once, so this list can be a lot bigger
    // than Manager's own-location one; attachWigNumbers already batches 50
    // SKUs per request so that scales fine. Same partial-degradation
    // handling as the Manager route: a lookup failure must not block the
    // list itself from loading.
    try {
      const client = await getClient();
      await attachWigNumbers(client, rows);
    } catch (e) {
      console.error('GET /api/wig-demo/buyer: wig number lookup failed:', e.message);
    }
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
    // Wig Number column (see attachWigNumbers() above; Buyer's /buyer route
    // above does the same, added 2026-09-15). A lookup failure here must not
    // break the list itself; rows just come back with an empty wig_number,
    // same partial-degradation approach used for this same lookup elsewhere
    // in the app.
    try {
      const client = await getClient();
      await attachWigNumbers(client, rows);
    } catch (e) {
      console.error('GET /api/wig-demo: wig number lookup failed:', e.message);
    }
    res.json(rows);
  } catch (e) {
    console.error('GET /api/wig-demo error:', e);
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
      productId, variantId, inventoryItemId,
    } = req.body;
    if (!location || !shopifyLocationId || !barcode || !productId || !variantId || !inventoryItemId) {
      return res.status(400).json({ error: 'Missing required fields' });
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
         inventory_item_id, barcode, name, variant_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [location, shopifyLocationId, productId, variantId, inventoryItemId, barcode, name || null, variantName || null]
    );

    res.json({ success: true, row: inserted.rows[0], replaced, replaceWarning });
  } catch (e) {
    console.error('POST /api/wig-demo error:', e);
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
