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
router.get('/search', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const { q, vendors, tag } = req.query;
    let queryParts = [];
    if (q && q.trim().length >= 2) queryParts.push(`(title:*${q}* OR sku:*${q}*)`);
    if (vendors) {
      const vendorList = vendors.split(',');
      const escapedVendors = vendorList.map(v => `vendor:"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      queryParts.push(`(${escapedVendors.join(' OR ')})`);
    }
    if (tag) queryParts.push(`tag:"${tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    if (queryParts.length === 0) return res.json([]);

    const queryString = queryParts.join(' AND ');
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const gqlQuery = `
      query searchProducts($queryString: String!) {
        products(first: 20, query: $queryString) {
          edges {
            node {
              id title productType
              variants(first: 10) {
                edges {
                  node {
                    id sku barcode
                    metafield(namespace: "custom", key: "name") { value }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await shopifyRequest(client, gqlQuery, { queryString });
    const products = response.data.products.edges;

    let variants = [];
    for (const { node: product } of products) {
      for (const { node: variant } of product.variants.edges) {
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

    res.json(variants.slice(0, 50));
  } catch (e) {
    console.error('GET /api/shopify/search error:', e);
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
              metafields(first: 20) { edges { node { namespace key value } } }
            }
            metafields(first: 20) { edges { node { namespace key value } } }
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
                metafields(first: 20) { edges { node { namespace key value } } }
              }
              metafields(first: 20) { edges { node { namespace key value } } }
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

module.exports = { router, getDepartment };