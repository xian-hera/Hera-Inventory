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
    image: variant.product.featuredMedia?.preview?.image?.url || null,
    productId: variant.product.id,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
    availableQty,
  };
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
          from: { locationId, name: fromName, changeFromQuantity: null },
          to: { locationId, name: toName, changeFromQuantity: null },
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
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/wig-demo/buyer error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/wig-demo/lookup?barcode=&locationId=&location= — resolves a
// barcode (from search-result "Add" or a raw scan) to the info the Add Demo
// modal needs. Also flags alreadyDemo so the frontend can block re-adding
// the exact same SKU that's already this location's current demo.
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

    const existing = await pool.query(
      'SELECT id FROM wig_demos WHERE location = $1 AND barcode = $2',
      [location, info.barcode]
    );

    res.json({ ...info, alreadyDemo: existing.rows.length > 0 });
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
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/wig-demo error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wig-demo — "Make DEMO". Moves 1 Available -> Unavailable for the
// new SKU, and — if this location already has a demo for the same product —
// releases that old demo's 1 unit back to Available and removes it first,
// since a product has at most one demo per location at any time.
router.post('/', async (req, res) => {
  try {
    const {
      location, shopifyLocationId, barcode, name, variantName,
      productId, variantId, inventoryItemId,
    } = req.body;
    if (!location || !shopifyLocationId || !barcode || !productId || !variantId || !inventoryItemId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existingSame = await pool.query(
      'SELECT id FROM wig_demos WHERE location = $1 AND barcode = $2',
      [location, barcode]
    );
    if (existingSame.rows.length > 0) {
      return res.status(400).json({ error: 'This SKU is already the current demo.' });
    }

    const client = await getClient();

    await moveInventory(client, {
      inventoryItemId,
      locationId: shopifyLocationId,
      fromName: 'available',
      toName: DEMO_UNAVAILABLE_STATE,
      reason: 'promotion',
      referenceDocumentUri: `wig-demo://${encodeURIComponent(location)}/${encodeURIComponent(barcode)}/${Date.now()}`,
    });

    // Same product already has a demo at this location — it's being
    // replaced: release its 1 unit back to Available and drop it from the
    // list. If the release call itself fails, don't block the new demo from
    // being recorded — surface it as a warning instead, so the manager can
    // deal with the stuck old row (e.g. via Cancel DEMO) rather than losing
    // the new demo they just made.
    let replaced = null;
    let replaceWarning = null;
    const existingProduct = await pool.query(
      'SELECT * FROM wig_demos WHERE location = $1 AND shopify_product_id = $2',
      [location, productId]
    );
    if (existingProduct.rows.length > 0) {
      const oldRow = existingProduct.rows[0];
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

// DELETE /api/wig-demo — "Cancel DEMO" (Buyer, and Manager as of this
// session). Releases each selected row's 1 unit back to Available and
// removes the row. No same-product check here — this is a manual override,
// not a replacement, so it just processes exactly what was selected.
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

// POST /api/wig-demo/import — bulk-import existing demos that are currently
// tracked on another platform, via CSV (client parses the file into
// {sku, location} rows; see IMPORT_CSV_HEADER_ALIASES in BuyerWigDemo.js for
// the accepted headers). Confirmed with Hera (2026-09-15): Shopify's
// Available count for these SKUs is still the full, un-adjusted number, so
// each row goes through the exact same lookup + inventoryMoveQuantities call
// as the normal "Make DEMO" flow (POST /) — it's not a DB-only insert, it
// actually moves 1 unit Available -> Unavailable to match reality. Also per
// Hera: unlike POST /, this deliberately skips the same-product "replace the
// old demo" logic — an import row isn't replacing anything, every row is
// just its own new demo. Runs serially with a small delay between rows to
// stay polite to Shopify's rate limits (same convention as
// server/jobs/syncVariantIndex.js), not a Promise.all batch.
router.post('/import', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided' });
    }

    const normalized = rows
      .map(r => ({
        sku: (r.sku || '').toString().trim(),
        location: (r.location || '').toString().trim().toUpperCase(),
      }))
      .filter(r => r.sku && r.location);

    // Duplicate (location, SKU) pairs within this one file: per Hera,
    // neither side gets imported, both are reported as errors — a duplicate
    // almost certainly means the same physical demo was listed twice, and
    // importing it twice would incorrectly move 2 units instead of 1.
    const keyCounts = {};
    normalized.forEach(r => {
      const key = `${r.location}|${r.sku}`;
      keyCounts[key] = (keyCounts[key] || 0) + 1;
    });

    const toProcess = [];
    const skipped = [];
    normalized.forEach(r => {
      const key = `${r.location}|${r.sku}`;
      if (keyCounts[key] > 1) {
        skipped.push({
          sku: r.sku,
          location: r.location,
          reason: `Duplicate: SKU ${r.sku} appears ${keyCounts[key]} times for location ${r.location} in this file — neither was imported.`,
        });
      } else {
        toProcess.push(r);
      }
    });

    // Resolve location codes -> Shopify location GIDs up front (one query),
    // same table/columns used elsewhere in server/routes/shopify.js.
    const distinctLocations = [...new Set(toProcess.map(r => r.location))];
    const locMap = distinctLocations.length > 0
      ? await pool.query(
          'SELECT location_name, shopify_location_id FROM location_map WHERE location_name = ANY($1)',
          [distinctLocations]
        )
      : { rows: [] };
    const locationIdByCode = {};
    locMap.rows.forEach(r => { locationIdByCode[r.location_name] = r.shopify_location_id; });

    const client = await getClient();
    const imported = [];

    for (const row of toProcess) {
      const { sku, location } = row;
      try {
        const shopifyLocationId = locationIdByCode[location];
        if (!shopifyLocationId) {
          skipped.push({ sku, location, reason: `Unknown location "${location}".` });
          continue;
        }

        const existing = await pool.query(
          'SELECT id FROM wig_demos WHERE location = $1 AND barcode = $2',
          [location, sku]
        );
        if (existing.rows.length > 0) {
          skipped.push({ sku, location, reason: 'Already the current demo for this location — skipped.' });
          continue;
        }

        const info = await fetchWigVariant(client, sku, shopifyLocationId);
        if (!info) {
          skipped.push({ sku, location, reason: 'Not found, not an Active product, or not a WIG.' });
          continue;
        }
        if (info.availableQty < 1) {
          skipped.push({ sku, location, reason: `No available stock (${info.availableQty}) at this location.` });
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
             inventory_item_id, barcode, name, variant_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`,
          [location, shopifyLocationId, info.productId, info.variantId, info.inventoryItemId, sku, info.name || null, info.variantName || null]
        );
        imported.push(inserted.rows[0]);
      } catch (e) {
        console.error('Wig Demo import row failed:', sku, location, e.message);
        skipped.push({ sku, location, reason: e.message });
      }

      // Polite delay between rows — same convention as syncVariantIndex.js.
      await new Promise(r => setTimeout(r, 350));
    }

    res.json({ success: true, imported, skipped });
  } catch (e) {
    console.error('POST /api/wig-demo/import error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
