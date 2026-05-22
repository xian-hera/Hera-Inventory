const express = require('express');
const router = express.Router();
const { getShopify, getSession } = require('../shopify');

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
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const {
      types,
      metafields,
      metafieldLogic,
    } = req.body;

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    let queryParts = [];
    if (types && types.length > 0) {
      queryParts.push(`(${types.map(t => `product_type:"${t}"`).join(' OR ')})`);
    }
    const queryString = queryParts.join(' AND ') || 'status:active';

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
      const response = await shopifyRequest(client, gqlQuery, { queryString, cursor });
      const page = response.data.products;
      allProducts = [...allProducts, ...page.edges];
      hasNextPage = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }

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

    let variants = [];
    for (const { node: product } of allProducts) {
      for (const { node: variant } of product.variants.edges) {
        if (!variantPassesMeta(product, variant)) continue;
        const name = variant.metafield?.value || product.title;
        variants.push({
          productId: product.id,
          variantId: variant.id,
          name,
          barcode: variant.barcode || variant.sku,
          productType: product.productType,
        });
      }
    }

    res.json(variants);
  } catch (e) {
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

// GET /api/shopify/inventory?barcode=XXX&locationId=YYY
router.get('/inventory', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const { barcode, locationId } = req.query;
    if (!barcode || !locationId) return res.status(400).json({ error: 'barcode and locationId required' });

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const variantQuery = `
      query getInventory($barcode: String!) {
        productVariants(first: 5, query: $barcode) {
          edges {
            node {
              id sku barcode
              inventoryItem {
                id
                inventoryLevels(first: 20) {
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
                mainSku: metafield(namespace: "custom", key: "main_sku") { value }
              }
            }
          }
        }
      }
    `;

    const response = await shopifyRequest(client, variantQuery, { barcode: `barcode:${barcode}` });
    const variants = response.data.productVariants.edges;
    if (variants.length === 0) return res.status(404).json({ error: 'Product not found' });

    let variant = variants[0].node;
    const decodedLocationId = decodeURIComponent(locationId);

    // main_sku redirect: if the product has a main_sku metafield, re-query using that SKU
    const mainSku = variant.product?.mainSku?.value;
    if (mainSku) {
      const redirectResponse = await shopifyRequest(client, variantQuery, { barcode: `sku:${mainSku}` });
      const redirectVariants = redirectResponse.data.productVariants.edges;
      if (redirectVariants.length > 0) {
        variant = redirectVariants[0].node;
      }
    }

    const levels = variant.inventoryItem.inventoryLevels.edges;
    const level = levels.find(e => e.node.location.id === decodedLocationId);
    const soh = level?.node.quantities.find(q => q.name === 'available')?.quantity ?? 0;
    const name = variant.metafield?.value || variant.product.title;

    res.json({
      barcode: variant.barcode || variant.sku,
      name,
      soh,
      productType: variant.product.productType,
      variantId: variant.id,
      inventoryItemId: variant.inventoryItem.id,
    });
  } catch (e) {
    console.error('[inventory] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/shopify/sync-locations
router.post('/sync-locations', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });
    const { pool } = require('../database/init');

    const query = `{
      locations(first: 50) {
        edges { node { id name } }
      }
    }`;

    const response = await shopifyRequest(client, query);
    const locations = response.data.locations.edges.map(e => ({ id: e.node.id, name: e.node.name }));

    for (const loc of locations) {
      await pool.query(
        `INSERT INTO location_map (location_name, shopify_location_id, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (location_name) DO UPDATE SET shopify_location_id = $2, updated_at = NOW()`,
        [loc.name, loc.id]
      );
    }

    res.json({ success: true, synced: locations });
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
router.get('/search', async (req, res) => {
  try {
    const { q, offset } = req.query;
    if (!q || q.trim().length < 2) return res.json({ total: 0, results: [] });

    const raw = q.trim();
    const { pool } = require('../database/init');
    const PAGE_SIZE = 50;
    const skip = parseInt(offset) || 0;

    // ── Rule 1: pure digits → SKU contains match ─────────────────────────────
    if (/^\d+$/.test(raw)) {
      const countRes = await pool.query(
        `SELECT COUNT(*) FROM variant_search_index WHERE sku LIKE $1`,
        [`%${raw}%`]
      );
      const total = parseInt(countRes.rows[0].count);

      const rows = await pool.query(
        `SELECT * FROM variant_search_index
         WHERE sku LIKE $1
         ORDER BY sku
         LIMIT $2 OFFSET $3`,
        [`%${raw}%`, PAGE_SIZE, skip]
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

    const whereClause = `(${titleConditions}) OR (${nameConditions})`;

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
                  inventoryLevels(first: 30) {
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
      const response = await shopifyRequest(client, variantQuery, { barcode: `barcode:${barcode}` });
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
      productVariants(first: 1, query: "sku:${sku.replace(/"/g, '')}") {
        edges {
          node {
            id title sku price compareAtPrice barcode
            product {
              id title vendor productType
              mainSku: metafield(namespace: "custom", key: "main_sku") { value }
              metafields(first: 50) { edges { node { namespace key value } } }
            }
            metafields(first: 50) { edges { node { namespace key value } } }
          }
        }
      }
    }`;

    const response = await shopifyRequest(client, query);
    let edge = response?.data?.productVariants?.edges?.[0];
    if (!edge) return res.status(404).json({ error: 'SKU not found' });

    // main_sku redirect: if the product has a main_sku metafield, re-query using that SKU
    const mainSku = edge.node.product?.mainSku?.value;
    if (mainSku) {
      const redirectQuery = `{
        productVariants(first: 1, query: "sku:${mainSku.replace(/"/g, '')}") {
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
      const redirectResponse = await shopifyRequest(client, redirectQuery);
      const redirectEdge = redirectResponse?.data?.productVariants?.edges?.[0];
      if (redirectEdge) edge = redirectEdge;
    }

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

    const variantRes = await shopifyRequest(client, variantQuery, { barcode: `barcode:${barcode}` });
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

module.exports = { router, getDepartment };