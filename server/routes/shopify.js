const express = require('express');
const router = express.Router();
const { getShopify, getSession, activeFilter } = require('../shopify');

// 保留 getDepartment 供其他地方兼容调用，但新逻辑不再依赖它
const DEPARTMENT_MAP = {
  'BRAID': 'HAIR',
  'HAIR': 'HAIR',
  'WIG': 'HAIR',
  'HAIR & SKIN CARE': 'CARE',
  'JEWELRY': 'GENM',
  'MAKEUP': 'GENM',
  'K-BEAUTY': 'GENM',
  'TOOLS & ACCESSORIES': 'GENM',
};

function getDepartment(productType) {
  if (!productType) return null;
  return DEPARTMENT_MAP[productType.toUpperCase().trim()] || null;
}

async function shopifyRequest(client, query, variables = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = variables
        ? await client.request(query, { variables })
        : await client.request(query);
      if (response?.errors?.graphQLErrors?.length > 0) {
        console.error('GraphQL errors:', JSON.stringify(response.errors.graphQLErrors));
      }
      return response;
    } catch (e) {
      if (e?.response?.errors) {
        console.error('GraphQL errors detail:', JSON.stringify(e.response.errors));
      }
      const is429 =
        e?.response?.status === 429 ||
        e?.message?.includes('throttled') ||
        e?.message?.includes('Throttled');
      if (is429 && i < retries - 1) {
        const wait = (i + 1) * 1000;
        console.log(`Rate limited, retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

// GET /api/shopify/product-types
router.get('/product-types', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const query = `{
      productTypes(first: 50) {
        edges { node }
      }
    }`;

    const response = await shopifyRequest(client, query);
    const types = response.data.productTypes.edges.map(e => e.node).filter(Boolean);
    res.json(types);
  } catch (e) {
    console.error('GET /api/shopify/product-types error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/shopify/products
router.post('/products', async (req, res) => {
  let aborted = false;
  req.on('close', () => {
    if (!res.writableEnded) aborted = true;
  });
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const {
      types,
      metafields,
      metafieldLogic,
      relaxMetafieldFilter,
    } = req.body;

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    let queryParts = ['status:active'];
    if (types && types.length > 0) {
      queryParts.push(`(${types.map(t => `product_type:"${t}"`).join(' OR ')})`);
    }
    const queryString = queryParts.join(' AND ');

    const parsedMeta = (metafields || [])
      .map(mf => {
        if (!mf.key || !mf.key.trim()) return null;
        const parts = mf.key.trim().split('.');
        if (parts.length < 2) return null;
        return {
          level: mf.level || 'product',
          namespace: parts[0],
          key: parts.slice(1).join('.'),
          condition: mf.condition,
          value: mf.value || '',
        };
      })
      .filter(Boolean);

    const hasMetafilter = parsedMeta.length > 0;
    const logic = metafieldLogic === 'any' ? 'any' : 'all';

    const productMetaFields = parsedMeta
      .filter(m => m.level === 'product')
      .map((m, i) => `pMf${i}: metafield(namespace: "${m.namespace}", key: "${m.key}") { value }`)
      .join('\n');

    const variantMetaFields = parsedMeta
      .filter(m => m.level === 'variant')
      .map((m, i) => `vMf${i}: metafield(namespace: "${m.namespace}", key: "${m.key}") { value }`)
      .join('\n');

    const gqlQuery = `
      query getProducts($queryString: String!, $cursor: String) {
        products(first: 250, query: $queryString, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              productType
              ${productMetaFields}
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    barcode
                    metafield(namespace: "custom", key: "name") { value }
                    ${variantMetaFields}
                  }
                }
              }
            }
          }
        }
      }
    `;

    let allProducts = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      if (aborted) return;
      const response = await shopifyRequest(client, gqlQuery, { queryString, cursor });
      const page = response.data.products;
      allProducts = [...allProducts, ...page.edges];
      hasNextPage = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }

    if (aborted) return;

    const matchesCondition = (mfValue, condition, target) => {
      const val = (mfValue || '').toLowerCase().trim();
      const tgt = (target || '').trim().toLowerCase();
      switch (condition) {
        case 'value matches exactly':       return val === tgt;
        case "value doesn't match exactly": return val !== tgt;
        case 'value contains':              return val.includes(tgt);
        case "value doesn't contain":       return !val.includes(tgt);
        case 'exists with':                 return val === tgt;
        case "doesn't exist with":          return !mfValue || val !== tgt;
        default:                            return true;
      }
    };

    const variantPassesMeta = (product, variant) => {
      if (!hasMetafilter) return true;

      const productMetaNodes = parsedMeta.filter(m => m.level === 'product');
      const variantMetaNodes = parsedMeta.filter(m => m.level === 'variant');

      const results = parsedMeta.map((mf, i) => {
        if (mf.level === 'product') {
          const idx = productMetaNodes.indexOf(mf);
          const val = product[`pMf${idx}`]?.value || null;
          return matchesCondition(val, mf.condition, mf.value);
        } else {
          const idx = variantMetaNodes.indexOf(mf);
          const val = variant[`vMf${idx}`]?.value || null;
          return matchesCondition(val, mf.condition, mf.value);
        }
      });

      return logic === 'any' ? results.some(Boolean) : results.every(Boolean);
    };

    // When the caller is going to combine metafield matching with a quantity
    // filter under "any" (OR) semantics, it needs items that fail the metafield
    // conditions to still come through — they might still qualify via quantity.
    // Hard-excluding them here (as we do by default) would make that impossible,
    // since a later step can't OR in something it never received.
    const shouldRelax = !!relaxMetafieldFilter && hasMetafilter && logic === 'any';

    let variants = [];
    for (const { node: product } of allProducts) {
      for (const { node: variant } of product.variants.edges) {
        const matchesMetafield = variantPassesMeta(product, variant);
        if (!shouldRelax && !matchesMetafield) continue;
        const name = variant.metafield?.value || product.title;
        variants.push({
          productId: product.id,
          variantId: variant.id,
          name,
          barcode: variant.barcode || variant.sku,
          productType: product.productType,
          matchesMetafield,
        });
      }
    }

    res.json(variants);
  } catch (e) {
    if (aborted) return;
    console.error('POST /api/shopify/products error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/shopify/locations
router.get('/locations', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const query = `{
      locations(first: 50) {
        edges { node { id name } }
      }
    }`;

    const response = await shopifyRequest(client, query);
    const locations = response.data.locations.edges.map(e => ({ id: e.node.id, name: e.node.name }));
    res.json(locations);
  } catch (e) {
    console.error('GET /api/shopify/locations error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Shared helper: resolves a barcode to its Shopify product/variant info and
// current "available" quantity at a given location. Extracted from GET
// /inventory below so that other counting-task flows — specifically the Scan
// Count "Complete Scan & Submit" step in server/routes/tasks.js — can look up
// System quantity for many items without duplicating this GraphQL query.
//
// Used to also honor a "main_sku" product metafield redirect, from when some
// products had multiple physical barcodes represented as separate bundle
// products pointing at a "main" SKU (Shopify didn't support multiple barcodes
// per variant at the time). That metafield and those bundle products no
// longer exist — Shopify now supports multiple barcodes on a single variant
// directly (added 2026-09), and `barcode:` search already matches any of a
// variant's barcodes — so the redirect step was removed 2026-09 as dead code.
async function fetchInventoryForBarcode(client, barcode, locationId) {
  const variantQuery = `
    query getInventory($barcode: String!) {
      productVariants(first: 5, query: $barcode) {
        edges {
          node {
            id sku barcode
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
              title productType
            }
          }
        }
      }
    }
  `;

  const response = await shopifyRequest(client, variantQuery, { barcode: activeFilter(`barcode:${barcode}`) });
  const variants = response.data.productVariants.edges;
  if (variants.length === 0) return null;

  const variant = variants[0].node;
  const decodedLocationId = decodeURIComponent(locationId);

  const levels = variant.inventoryItem.inventoryLevels.edges;
  const level = levels.find(e => e.node.location.id === decodedLocationId);
  const soh = level?.node.quantities.find(q => q.name === 'available')?.quantity ?? 0;
  const name = variant.metafield?.value || variant.product.title;

  return {
    barcode: variant.barcode || variant.sku,
    name,
    soh,
    productType: variant.product.productType,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
  };
}

// GET /api/shopify/inventory?barcode=XXX&locationId=YYY
router.get('/inventory', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const { barcode, locationId } = req.query;
    if (!barcode || !locationId) return res.status(400).json({ error: 'barcode and locationId required' });

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const result = await fetchInventoryForBarcode(client, barcode, locationId);
    if (!result) return res.status(404).json({ error: 'Product not found' });

    res.json(result);
  } catch (e) {
    console.error('[inventory] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ─── Shared location map (2026-09-24, Hera) ─────────────────────────────────
// location_map is the ONE location list every frontend page reads (via GET
// /location-map below) — it replaced the 19-code LOCATIONS constants that
// used to be hardcoded in ~10 pages, and the per-page live calls to GET
// /locations above. Kept up to date by syncLocationMap(): the "Sync
// Locations" button in Buyer Settings, plus one automatic run at server
// startup (see server/index.js) so every deploy self-heals.

// Canonical display order, identical to the order the old hardcoded lists
// used: MTL → EDM → CAL → OTT → QC → any other prefix (alphabetical) → HQ
// last; numeric order within a prefix (MTL02 before MTL10). A brand-new
// code like MTL12 or TOR01 slots in automatically.
const LOCATION_PREFIX_ORDER = ['MTL', 'EDM', 'CAL', 'OTT', 'QC'];
function locationSortKey(name) {
  const upper = String(name || '').toUpperCase().trim();
  if (upper === 'HQ') return [LOCATION_PREFIX_ORDER.length + 1, '', 0, upper];
  const m = upper.match(/^([A-Z]+)(\d*)$/);
  const prefix = m ? m[1] : upper;
  const num = m && m[2] ? parseInt(m[2], 10) : 0;
  const idx = LOCATION_PREFIX_ORDER.indexOf(prefix);
  // Unknown prefixes share one group, ordered alphabetically by prefix.
  return [idx === -1 ? LOCATION_PREFIX_ORDER.length : idx, idx === -1 ? prefix : '', num, upper];
}
function compareLocationNames(a, b) {
  const ka = locationSortKey(a);
  const kb = locationSortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

// Pulls every Shopify location (active AND inactive, so we can tell which
// is which) and reconciles location_map inside one transaction:
//   - upsert name → id for every location Shopify returns, is_active = Shopify's isActive
//   - any row whose name Shopify no longer returns (deleted / renamed) → is_active = false
// Rows are NEVER deleted: tasks.js / poInvoices.js / reports.js / wigDemo.js
// still resolve a stored location name to its shopify id through this table
// for older records.
async function syncLocationMap() {
  const session = await getSession();
  if (!session) throw new Error('No session');

  const shopify = getShopify();
  const client = new shopify.clients.Graphql({ session });
  const { pool } = require('../database/init');

  const query = `{
    locations(first: 250, includeInactive: true) {
      edges { node { id name isActive } }
    }
  }`;

  const response = await shopifyRequest(client, query);
  const edges = response?.data?.locations?.edges;
  if (!Array.isArray(edges)) throw new Error('Unexpected response from Shopify locations query');
  const locations = edges
    .map(e => ({ id: e.node.id, name: (e.node.name || '').trim(), isActive: e.node.isActive !== false }))
    .filter(l => l.name);

  // Safety net: an empty/zero-active answer is almost certainly a Shopify-side
  // problem, not "we closed every store" — refuse rather than hide everything.
  if (!locations.some(l => l.isActive)) {
    throw new Error('Shopify returned no active locations — location map left unchanged');
  }

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const before = await db.query('SELECT location_name, is_active FROM location_map');
    const wasActive = new Map(before.rows.map(r => [r.location_name, r.is_active]));

    for (const loc of locations) {
      await db.query(
        `INSERT INTO location_map (location_name, shopify_location_id, is_active, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (location_name) DO UPDATE
           SET shopify_location_id = $2, is_active = $3, updated_at = NOW()`,
        [loc.name, loc.id, loc.isActive]
      );
    }
    const returnedNames = locations.map(l => l.name);
    await db.query(
      `UPDATE location_map SET is_active = FALSE, updated_at = NOW()
       WHERE is_active = TRUE AND NOT (location_name = ANY($1))`,
      [returnedNames]
    );
    await db.query('COMMIT');

    const activeNow = locations.filter(l => l.isActive).map(l => l.name);
    const added = activeNow.filter(n => wasActive.get(n) !== true);
    const deactivated = [...wasActive.entries()]
      .filter(([n, act]) => act === true && !activeNow.includes(n))
      .map(([n]) => n);

    return {
      active: activeNow.sort(compareLocationNames),
      added: added.sort(compareLocationNames),
      deactivated: deactivated.sort(compareLocationNames),
    };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

// GET /api/shopify/location-map — active locations, canonical order.
// Same { id, name } shape as GET /locations so pages could switch over as a
// drop-in replacement.
router.get('/location-map', async (req, res) => {
  try {
    const { pool } = require('../database/init');
    const result = await pool.query(
      'SELECT location_name, shopify_location_id FROM location_map WHERE is_active = TRUE'
    );
    const list = result.rows
      .map(r => ({ id: r.shopify_location_id, name: r.location_name }))
      .sort((a, b) => compareLocationNames(a.name, b.name));
    res.json(list);
  } catch (e) {
    console.error('GET /api/shopify/location-map error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/shopify/sync-locations — Buyer Settings "Sync Locations" button.
router.post('/sync-locations', async (req, res) => {
  try {
    const result = await syncLocationMap();
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('POST /api/shopify/sync-locations error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/shopify/search
// Searches the local variant_search_index table.
// Rule 1 — pure digits: SKU contains match (no same-product bleed)
// Rule 2 — contains letters: all words must appear in product_title OR all words in custom_name (ILIKE, AND per word)
// Special chars / [ ] - @ # are treated as literals.
// Supports pagination: ?q=...&offset=0  returns { total, results[] }
//
// Rule 1 fallback (added 2026-09-23): if the local-index search above finds
// nothing (only tried on the first page, offset 0), fall back to a live
// Shopify barcode: search — the same approach the barcode-scanner path
// already uses (fetchWigVariant in wigDemo.js / fetchInventoryForBarcode
// above). This exists because variant_search_index can only ever store the
// single "primary" barcode Shopify's GraphQL API exposes per variant (see
// syncVariantIndex.js), so a variant's non-primary/secondary barcode can
// never be found via the local index no matter what — only a live query
// against Shopify itself (whose barcode: search matches ANY barcode
// attached to a variant) can find it.
router.get('/search', async (req, res) => {
  try {
    const { q, offset, types } = req.query;
    if (!q || q.trim().length < 2) return res.json({ total: 0, results: [] });

    const raw = q.trim();
    const { pool } = require('../database/init');
    const PAGE_SIZE = 50;
    const skip = parseInt(offset) || 0;
    // Optional product-type filter, comma-separated (e.g. Wig Demo's search
    // box passes types=WIG so it only ever offers WIG variants). Additive —
    // every existing caller that omits `types` keeps its current behavior.
    const typeList = types ? types.split(',').map(t => t.trim()).filter(Boolean) : [];

    // ── Rule 1: pure digits → SKU contains match ─────────────────────────────
    if (/^\d+$/.test(raw)) {
      const skuParams = [`%${raw}%`];
      let skuWhere = `sku LIKE $1`;
      if (typeList.length > 0) {
        skuParams.push(typeList);
        skuWhere += ` AND product_type = ANY($${skuParams.length})`;
      }

      const countRes = await pool.query(
        `SELECT COUNT(*) FROM variant_search_index WHERE ${skuWhere}`,
        skuParams
      );
      const total = parseInt(countRes.rows[0].count);

      const rows = await pool.query(
        `SELECT * FROM variant_search_index
         WHERE ${skuWhere}
         ORDER BY sku
         LIMIT $${skuParams.length + 1} OFFSET $${skuParams.length + 2}`,
        [...skuParams, PAGE_SIZE, skip]
      );

      // Local index found nothing — fall back to a live Shopify barcode:
      // search (see the comment above this route for why). Only attempted
      // on the first page: this is a fallback for "nothing found locally",
      // not a paginated data source in its own right.
      if (total === 0 && skip === 0) {
        try {
          const session = await getSession();
          if (session) {
            const shopify = getShopify();
            const client = new shopify.clients.Graphql({ session });
            const gqlQuery = `
              query searchByBarcode($barcode: String!) {
                productVariants(first: 10, query: $barcode) {
                  edges {
                    node {
                      id sku barcode
                      metafield(namespace: "custom", key: "name") { value }
                      product { id title productType }
                    }
                  }
                }
              }
            `;
            const response = await shopifyRequest(client, gqlQuery, { barcode: activeFilter(`barcode:${raw}`) });
            let liveResults = (response.data?.productVariants?.edges || []).map(({ node: v }) => ({
              productId: v.product.id,
              variantId: v.id,
              name: v.metafield?.value || v.product.title,
              barcode: v.barcode || v.sku,
              productType: v.product.productType,
            }));
            if (typeList.length > 0) {
              liveResults = liveResults.filter(r => typeList.includes(r.productType));
            }
            if (liveResults.length > 0) {
              return res.json({ total: liveResults.length, results: liveResults });
            }
          }
        } catch (e) {
          console.error('GET /api/shopify/search: live Shopify barcode fallback failed:', e.message);
          // Fall through to the (empty) local result below rather than
          // failing the whole search because the fallback attempt errored.
        }
      }

      return res.json({
        total,
        results: rows.rows.map(v => ({
          productId: v.shopify_product_id,
          variantId: v.shopify_variant_id,
          name: v.custom_name || v.product_title,
          barcode: v.barcode || v.sku,
          productType: v.product_type,
        })),
      });
    }

    // ── Rule 2: contains letters → multi-word ILIKE match ────────────────────
    // Split on whitespace; every word must appear in the field (AND).
    // title match → all variants of that product are included.
    // name match  → only that specific variant is included.
    // Special chars are passed through as literals (LIKE does not treat / [ ] - @ # specially).
    const words = raw.split(/\s+/).filter(Boolean);

    // Build parameterised conditions: one $N per word
    const titleConditions = words.map((_, i) => `product_title ILIKE $${i + 1}`).join(' AND ');
    const nameConditions  = words.map((_, i) => `custom_name  ILIKE $${i + 1}`).join(' AND ');
    const params = words.map(w => `%${w}%`);

    let whereClause = `(${titleConditions}) OR (${nameConditions})`;
    if (typeList.length > 0) {
      params.push(typeList);
      whereClause = `(${whereClause}) AND product_type = ANY($${params.length})`;
    }

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM variant_search_index WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].count);

    const rows = await pool.query(
      `SELECT * FROM variant_search_index
       WHERE ${whereClause}
       ORDER BY product_title, custom_name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, PAGE_SIZE, skip]
    );

    return res.json({
      total,
      results: rows.rows.map(v => ({
        productId: v.shopify_product_id,
        variantId: v.shopify_variant_id,
        name: v.custom_name || v.product_title,
        barcode: v.barcode || v.sku,
        productType: v.product_type,
      })),
    });
  } catch (e) {
    console.error('GET /api/shopify/search error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/shopify/soh-check
router.post('/soh-check', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const { barcodes, locations } = req.body;
    if (!barcodes || !locations || barcodes.length === 0 || locations.length === 0) return res.json({});

    const { pool } = require('../database/init');
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const locMap = await pool.query(
      'SELECT location_name, shopify_location_id FROM location_map WHERE location_name = ANY($1)',
      [locations]
    );
    const locationIdMap = {};
    locMap.rows.forEach(r => { locationIdMap[r.location_name] = r.shopify_location_id; });

    const result = {};
    for (const location of locations) result[location] = [];

    for (const barcode of barcodes) {
      const variantQuery = `
        query getInventory($barcode: String!) {
          productVariants(first: 5, query: $barcode) {
            edges {
              node {
                barcode sku
                inventoryItem {
                  inventoryLevels(first: 30, includeInactive: true) {
                    edges {
                      node {
                        location { id }
                        quantities(names: ["available"]) { name quantity }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const response = await shopifyRequest(client, variantQuery, { barcode: activeFilter(`barcode:${barcode}`) });
      const variants = response.data?.productVariants?.edges || [];
      if (variants.length === 0) continue;

      const variant = variants[0].node;
      const levels = variant.inventoryItem?.inventoryLevels?.edges || [];

      for (const location of locations) {
        const shopifyLocationId = locationIdMap[location];
        if (!shopifyLocationId) continue;
        const level = levels.find(e => e.node.location.id === shopifyLocationId);
        const soh = level?.node.quantities.find(q => q.name === 'available')?.quantity ?? 0;
        if (soh === 0) result[location].push(barcode);
      }
    }

    res.json(result);
  } catch (e) {
    console.error('POST /api/shopify/soh-check error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/shopify/quantity-check
// Body: { barcodes, locations, condition, value }
// Evaluates the condition against each location's own "available" quantity.
// Returns { location: [barcodes that do NOT satisfy the condition at that location] }
// so the caller can exclude them from that specific store's task.
router.post('/quantity-check', async (req, res) => {
  let aborted = false;
  req.on('close', () => {
    if (!res.writableEnded) aborted = true;
  });
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const { barcodes, locations, condition, value } = req.body;
    if (!barcodes || !locations || barcodes.length === 0 || locations.length === 0) return res.json({});

    const targetValue = Number(value);
    if (!condition || value === undefined || value === null || value === '' || isNaN(targetValue)) {
      return res.json({});
    }

    const passesCondition = (qty) => {
      switch (condition) {
        case 'equal':         return qty === targetValue;
        case 'not equal':     return qty !== targetValue;
        case 'more than':     return qty > targetValue;
        case 'more or equal': return qty >= targetValue;
        case 'less than':     return qty < targetValue;
        case 'less or equal': return qty <= targetValue;
        default:              return true;
      }
    };

    const { pool } = require('../database/init');
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const locMap = await pool.query(
      'SELECT location_name, shopify_location_id FROM location_map WHERE location_name = ANY($1)',
      [locations]
    );
    const locationIdMap = {};
    locMap.rows.forEach(r => { locationIdMap[r.location_name] = r.shopify_location_id; });
    const validLocations = locations.filter(l => locationIdMap[l]);

    const result = {};
    for (const location of locations) result[location] = [];

    if (validLocations.length === 0) return res.json(result);

    // Batch size is derived from Shopify's documented GraphQL cost model for this
    // query shape: requestedCost ≈ 2 * F * (1 + L), where F = batch size (first)
    // and L = number of location aliases per variant. A single query can't exceed
    // 1000 cost points, so we target ~500 (half) as a safety margin, and clamp to
    // a practical range — Shopify support advised against very long OR chains
    // (tens/~100, not hundreds) even though nothing hard-fails below that.
    // Confirmed with Shopify support (Plus plan): productVariants max `first` is
    // 250 regardless of plan; Plus only raises the per-second cost budget (1000
    // pts/sec), not the per-query ceiling or per-connection page size.
    const TARGET_COST = 500;
    const MIN_BATCH_SIZE = 20;
    const MAX_BATCH_SIZE = 100;
    const numLocations = validLocations.length;
    const BATCH_SIZE = Math.max(
      MIN_BATCH_SIZE,
      Math.min(MAX_BATCH_SIZE, Math.floor(TARGET_COST / (2 * (1 + numLocations))))
    );

    // Batches are sized to ~half the per-query cost ceiling (TARGET_COST = 500),
    // so running 2 of them concurrently stays close to, but under, both the
    // 1000-point per-query ceiling (each request is separate, so this doesn't
    // apply here) and a sensible slice of the Plus 1000-points/sec throughput
    // budget. This is a wave-based concurrency: fire CONCURRENCY batches at
    // once, wait for that wave to finish, then fire the next wave.
    const CONCURRENCY = 2;

    const locationFields = validLocations.map((loc, idx) => {
      const locId = locationIdMap[loc];
      return `loc${idx}: inventoryLevel(locationId: "${locId}", includeInactive: true) {
        quantities(names: ["available"]) { name quantity }
      }`;
    }).join('\n');

    const runBatch = async (batch, batchIndex) => {
      const barcodeQuery = activeFilter(batch.map(b => `barcode:${b}`).join(' OR '));
      const batchQuery = `
        query getBatchInventory($barcodeQuery: String!) {
          productVariants(first: ${BATCH_SIZE}, query: $barcodeQuery) {
            edges {
              node {
                barcode
                inventoryItem {
                  ${locationFields}
                }
              }
            }
          }
        }
      `;
      try {
        const response = await shopifyRequest(client, batchQuery, { barcodeQuery });
        const edges = response.data?.productVariants?.edges || [];

        for (const { node: variant } of edges) {
          if (!variant.barcode) continue;

          validLocations.forEach((loc, idx) => {
            const levelData = variant.inventoryItem[`loc${idx}`];
            const qty = levelData?.quantities?.find(q => q.name === 'available')?.quantity ?? 0;
            if (!passesCondition(qty)) result[loc].push(variant.barcode);
          });
        }
      } catch (e) {
        // skip batch errors and continue with the next batch, same as negative-inventory did
        console.error(`[quantity-check] batch error at index ${batchIndex}:`, e.message);
      }
    };

    const batches = [];
    for (let i = 0; i < barcodes.length; i += BATCH_SIZE) {
      batches.push(barcodes.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      if (aborted) return;
      const wave = batches.slice(i, i + CONCURRENCY);
      await Promise.all(wave.map((batch, idx) => runBatch(batch, i + idx)));
    }

    if (aborted) return;
    res.json(result);
  } catch (e) {
    if (aborted) return;
    console.error('POST /api/shopify/quantity-check error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/shopify/variant-by-sku
router.get('/variant-by-sku', async (req, res) => {
  try {
    const { sku } = req.query;
    if (!sku) return res.status(400).json({ error: 'sku is required' });

    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const query = `{
      productVariants(first: 1, query: "${activeFilter(`sku:${sku.replace(/"/g, '')}`)}") {
        edges {
          node {
            id title sku price compareAtPrice barcode
            product {
              id title vendor productType
              metafields(first: 50) { edges { node { namespace key value } } }
            }
            metafields(first: 50) { edges { node { namespace key value } } }
          }
        }
      }
    }`;

    const response = await shopifyRequest(client, query);
    const edge = response?.data?.productVariants?.edges?.[0];
    if (!edge) return res.status(404).json({ error: 'SKU not found' });

    // Formerly had a "main_sku redirect" here for bundle products (see
    // fetchInventoryForBarcode above for why); removed 2026-09, dead code
    // since the main_sku metafield and bundle products no longer exist.

    const v = edge.node;
    res.json({
      variant: {
        id: v.id, title: v.title, sku: v.sku, price: v.price,
        compare_at_price: v.compareAtPrice, barcode: v.barcode,
        metafields: (v.metafields?.edges || []).map(e => e.node),
      },
      product: {
        id: v.product.id, title: v.product.title, vendor: v.product.vendor,
        product_type: v.product.productType,
        metafields: (v.product.metafields?.edges || []).map(e => e.node),
      },
    });
  } catch (e) {
    console.error('GET /api/shopify/variant-by-sku error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/shopify/inventory-by-sku?sku=XXX&fromLocationId=gid://shopify/Location/1&toLocationId=gid://shopify/Location/2
// Used by Buyer Transfer's Create Transfer page (search-add and CSV upload):
// resolves a SKU to its variant name plus "available" quantity at both the
// origin and destination location in one call. Same GraphQL shape as
// fetchInventoryForBarcode above, just keyed by sku (like /variant-by-sku)
// and reading both locations' levels instead of one.
router.get('/inventory-by-sku', async (req, res) => {
  try {
    const { sku, fromLocationId, toLocationId } = req.query;
    if (!sku || !fromLocationId || !toLocationId) {
      return res.status(400).json({ error: 'sku, fromLocationId and toLocationId are required' });
    }

    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const query = `{
      productVariants(first: 1, query: "${activeFilter(`sku:${sku.replace(/"/g, '')}`)}") {
        edges {
          node {
            id sku
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
            product { title }
          }
        }
      }
    }`;

    const response = await shopifyRequest(client, query);
    const edge = response?.data?.productVariants?.edges?.[0];
    if (!edge) return res.status(404).json({ error: 'SKU not found' });

    const v = edge.node;
    const levels = v.inventoryItem.inventoryLevels.edges;
    const decodedFrom = decodeURIComponent(fromLocationId);
    const decodedTo = decodeURIComponent(toLocationId);
    const fromLevel = levels.find(e => e.node.location.id === decodedFrom);
    const toLevel = levels.find(e => e.node.location.id === decodedTo);
    const fromQty = fromLevel?.node.quantities.find(q => q.name === 'available')?.quantity ?? 0;
    const toQty = toLevel?.node.quantities.find(q => q.name === 'available')?.quantity ?? 0;

    res.json({
      sku: v.sku,
      name: v.metafield?.value || v.product.title,
      variantId: v.id,
      inventoryItemId: v.inventoryItem.id,
      fromQty,
      toQty,
    });
  } catch (e) {
    console.error('GET /api/shopify/inventory-by-sku error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/shopify/inventory-history/:barcode?locationId=gid://shopify/Location/xxx
router.get('/inventory-history/:barcode', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const { barcode } = req.params;
    const { locationId } = req.query;
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const variantQuery = `
      query getVariant($barcode: String!) {
        productVariants(first: 1, query: $barcode) {
          edges {
            node {
              id
              inventoryItem { id }
            }
          }
        }
      }
    `;

    const variantRes = await shopifyRequest(client, variantQuery, { barcode: activeFilter(`barcode:${barcode}`) });
    const variantEdges = variantRes.data?.productVariants?.edges || [];
    if (variantEdges.length === 0) return res.status(404).json({ error: 'Product not found' });

    const inventoryItemGid = variantEdges[0].node.inventoryItem?.id;
    if (!inventoryItemGid) return res.status(404).json({ error: 'Inventory item not found' });

    const inventoryItemId = inventoryItemGid.split('/').pop();
    const storeName = session.shop.replace('.myshopify.com', '');
    let url = `https://admin.shopify.com/store/${storeName}/products/inventory/${inventoryItemId}/inventory_history`;

    if (locationId) {
      const numericLocationId = locationId.split('/').pop();
      url += `?location_id=${numericLocationId}`;
    }

    res.json({ url });
  } catch (e) {
    console.error('GET /api/shopify/inventory-history error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/shopify/search-customers?q=xxx
router.get('/search-customers', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const queryString = `${q.trim()}`;
    const gqlQuery = `
      query searchCustomers($query: String!) {
        customers(first: 20, query: $query) {
          edges {
            node {
              id
              firstName
              lastName
              email
              phone
            }
          }
        }
      }
    `;

    const response = await shopifyRequest(client, gqlQuery, { query: queryString });
    const customers = response.data?.customers?.edges || [];

    const result = customers.map(({ node }) => ({
      id: node.id.replace('gid://shopify/Customer/', ''),
      name: [node.firstName, node.lastName].filter(Boolean).join(' ') || node.email || 'Unknown',
      email: node.email || null,
      phone: node.phone || null,
    }));

    res.json(result);
  } catch (e) {
    console.error('GET /api/shopify/search-customers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/shopify/vendors-tags
router.get('/vendors-tags', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    // Vendors: traverse all products to collect unique vendors
    const vendorSet = new Set();
    let productCursor = null, hasMoreProducts = true;
    while (hasMoreProducts) {
      const afterClause = productCursor ? `, after: "${productCursor}"` : '';
      const productQuery = `{
        products(first: 250${afterClause}) {
          pageInfo { hasNextPage endCursor }
          edges { node { vendor } }
        }
      }`;
      const productResponse = await shopifyRequest(client, productQuery);
      const page = productResponse.data.products;
      for (const { node } of page.edges) {
        if (node.vendor) vendorSet.add(node.vendor);
      }
      hasMoreProducts = page.pageInfo.hasNextPage;
      productCursor = page.pageInfo.endCursor;
    }
    const allVendors = Array.from(vendorSet).sort();

    // Fetch all tags with pagination
    let allTags = [], tagCursor = null, hasMoreTags = true;
    while (hasMoreTags) {
      const afterClause = tagCursor ? `, after: "${tagCursor}"` : '';
      const tagQuery = `{
        productTags(first: 250${afterClause}) {
          edges { node cursor }
          pageInfo { hasNextPage }
        }
      }`;
      const tagResponse = await shopifyRequest(client, tagQuery);
      const edges = tagResponse.data.productTags.edges;
      allTags = [...allTags, ...edges.map(e => e.node).filter(Boolean)];
      hasMoreTags = tagResponse.data.productTags.pageInfo.hasNextPage;
      if (hasMoreTags && edges.length > 0) tagCursor = edges[edges.length - 1].cursor;
    }

    res.json({ vendors: allVendors.sort(), tags: allTags.sort() });
  } catch (e) {
    console.error('GET /api/shopify/vendors-tags error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Product Database Settings ───────────────────────────────────────────────

// GET /api/shopify/product-db-settings
// Returns current sync interval (hours), last synced time, total variants in index,
// and whether a sync is currently running.
router.get('/product-db-settings', async (req, res) => {
  try {
    const { pool } = require('../database/init');
    const { getSyncStatus } = require('../jobs/syncVariantIndex');

    const settingRes = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'variant_sync_interval_hours'`
    );
    const intervalHours = settingRes.rows.length > 0
      ? parseInt(settingRes.rows[0].value)
      : 12;

    const countRes = await pool.query(`SELECT COUNT(*) FROM variant_search_index`);
    const totalVariants = parseInt(countRes.rows[0].count);

    const status = getSyncStatus();

    res.json({
      intervalHours,
      totalVariants,
      isSyncing: status.isSyncing,
      lastSyncedAt: status.lastSyncedAt,
      lastSyncCount: status.lastSyncCount,
    });
  } catch (e) {
    console.error('GET /api/shopify/product-db-settings error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/shopify/product-db-settings
// Saves a new sync interval and restarts the scheduler.
// Body: { intervalHours: number }
router.post('/product-db-settings', async (req, res) => {
  try {
    const { intervalHours } = req.body;
    const hours = parseInt(intervalHours);
    if (isNaN(hours) || hours < 1 || hours > 168) {
      return res.status(400).json({ error: 'intervalHours must be between 1 and 168' });
    }

    const { pool } = require('../database/init');
    const { startSyncScheduler } = require('../jobs/syncVariantIndex');

    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('variant_sync_interval_hours', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(hours)]
    );

    // Restart scheduler with new interval (does NOT trigger an immediate sync)
    await startSyncScheduler({ skipInitialSync: true });

    res.json({ success: true, intervalHours: hours });
  } catch (e) {
    console.error('POST /api/shopify/product-db-settings error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/shopify/sync-variant-index
// Manually triggers an immediate sync. Returns immediately; sync runs in background.
router.post('/sync-variant-index', async (req, res) => {
  try {
    const { syncVariantIndex, getSyncStatus } = require('../jobs/syncVariantIndex');
    const status = getSyncStatus();
    if (status.isSyncing) {
      return res.status(409).json({ error: 'Sync already in progress' });
    }
    // Fire and forget — client polls /product-db-settings for status
    syncVariantIndex().catch(e => console.error('[sync-variant-index] Error:', e.message));
    res.json({ started: true });
  } catch (e) {
    console.error('POST /api/shopify/sync-variant-index error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { router, getDepartment, fetchInventoryForBarcode, syncLocationMap };