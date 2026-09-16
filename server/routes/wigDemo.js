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
    // Same partial-degradation handling as GET / above — a wig number lookup
    // failure must not block the export itself, rows just print blank.
    try {
      const client = await getClient();
      await attachWigNumbers(client, rows);
    } catch (e) {
      console.error('GET /api/wig-demo/export-pdf: wig number lookup failed:', e.message);
    }

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

    rows.forEach((row) => {
      // Row height adapts to however tall the tallest wrapped cell is (Name
      // is the one most likely to wrap), same approach as poInvoices.js's
      // export-pdf, so wrapped text never crowds into the next row.
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
    });

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
