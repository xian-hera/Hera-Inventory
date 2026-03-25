const express = require('express');
const router = express.Router();
const { getShopify, getSession } = require('../shopify');

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
        edges {
          node
        }
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

    const { department, types, typeCondition, metafieldKey, metafieldCondition, metafieldValue } = req.body;
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const hasMetafilter = metafieldKey && metafieldKey.trim() && metafieldValue && metafieldValue.trim();

    let queryParts = [];
    if (types && types.length > 0) {
      if (typeCondition === 'is') {
        queryParts.push(`(${types.map(t => `product_type:${t}`).join(' OR ')})`);
      } else {
        queryParts.push(`NOT (${types.map(t => `product_type:${t}`).join(' OR ')})`);
      }
    }
    const queryString = queryParts.join(' AND ') || 'status:active';

    let mfNamespace = null;
    let mfKey = null;
    if (hasMetafilter) {
      const parts = metafieldKey.trim().split('.');
      if (parts.length >= 2) {
        mfNamespace = parts[0];
        mfKey = parts.slice(1).join('.');
      }
    }

    const gqlQuery = `
      query getProducts($queryString: String!, $cursor: String) {
        products(first: 250, query: $queryString, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              productType
              ${hasMetafilter && mfNamespace && mfKey ? `
              metafield(namespace: "${mfNamespace}", key: "${mfKey}") {
                value
              }` : ''}
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    barcode
                    metafield(namespace: "custom", key: "name") {
                      value
                    }
                    ${hasMetafilter && mfNamespace && mfKey ? `
                    filterMetafield: metafield(namespace: "${mfNamespace}", key: "${mfKey}") {
                      value
                    }` : ''}
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

    const matchesMetafield = (mfValue) => {
      if (!hasMetafilter) return true;
      const val = (mfValue || '').toLowerCase().trim();
      const target = metafieldValue.trim().toLowerCase();

      switch (metafieldCondition) {
        case 'value matches exactly':
          return val === target;
        case "value doesn't match exactly":
          return val !== target;
        case 'value contains':
          return val.includes(target);
        case "value doesn't contain":
          return !val.includes(target);
        case 'exists with':
          return val === target;
        case "doesn't exist with":
          return !mfValue || val !== target;
        default:
          return true;
      }
    };

    let variants = [];
    for (const { node: product } of allProducts) {
      const dept = getDepartment(product.productType);
      if (department && department !== 'ALL' && dept !== department) continue;

      for (const { node: variant } of product.variants.edges) {
        if (hasMetafilter) {
          const productMfValue = product.metafield?.value || null;
          const variantMfValue = variant.filterMetafield?.value || null;
          const productMatches = matchesMetafield(productMfValue);
          const variantMatches = matchesMetafield(variantMfValue);
          if (!productMatches && !variantMatches) continue;
        }

        const name = variant.metafield?.value || product.title;
        variants.push({
          productId: product.id,
          variantId: variant.id,
          name,
          barcode: variant.barcode || variant.sku,
          department: dept,
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
        edges {
          node {
            id
            name
          }
        }
      }
    }`;

    const response = await shopifyRequest(client, query);
    const locations = response.data.locations.edges.map(e => ({
      id: e.node.id,
      name: e.node.name,
    }));
    res.json(locations);
  } catch (e) {
    console.error('GET /api/shopify/locations error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/shopify/inventory/:barcode/:locationId
router.get('/inventory/:barcode/:locationId', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const { barcode, locationId } = req.params;
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const variantQuery = `
      query getInventory($barcode: String!) {
        productVariants(first: 5, query: $barcode) {
          edges {
            node {
              id
              sku
              barcode
              inventoryItem {
                id
                inventoryLevels(first: 20) {
                  edges {
                    node {
                      location {
                        id
                      }
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                    }
                  }
                }
              }
              metafield(namespace: "custom", key: "name") {
                value
              }
              product {
                title
                productType
              }
            }
          }
        }
      }
    `;

    const response = await shopifyRequest(client, variantQuery, { barcode: `barcode:${barcode}` });
    const variants = response.data.productVariants.edges;

    if (variants.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const variant = variants[0].node;
    const decodedLocationId = decodeURIComponent(locationId);

    const levels = variant.inventoryItem.inventoryLevels.edges;
    const level = levels.find(e => e.node.location.id === decodedLocationId);
    const soh = level?.node.quantities.find(q => q.name === 'available')?.quantity ?? 0;

    const name = variant.metafield?.value || variant.product.title;
    const department = getDepartment(variant.product.productType);

    res.json({
      barcode: variant.barcode || variant.sku,
      name,
      soh,
      department,
      productType: variant.product.productType,
      variantId: variant.id,
      inventoryItemId: variant.inventoryItem.id,
    });
  } catch (e) {
    console.error('GET /api/shopify/inventory error:', e);
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
        edges {
          node {
            id
            name
          }
        }
      }
    }`;

    const response = await shopifyRequest(client, query);
    const locations = response.data.locations.edges.map(e => ({
      id: e.node.id,
      name: e.node.name,
    }));

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
              id
              title
              productType
              variants(first: 10) {
                edges {
                  node {
                    id
                    sku
                    barcode
                    metafield(namespace: "custom", key: "name") {
                      value
                    }
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
          department: getDepartment(product.productType),
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

    const vendorQuery = `{
      shop {
        productVendors(first: 250) {
          edges { node }
        }
      }
    }`;
    const vendorResponse = await shopifyRequest(client, vendorQuery);
    const vendors = vendorResponse.data.shop.productVendors.edges
      .map(e => e.node).filter(Boolean).sort();

    let allTags = [];
    let tagCursor = null;
    let hasMoreTags = true;

    while (hasMoreTags) {
      const afterClause = tagCursor ? `, after: "${tagCursor}"` : '';
      const tagQuery = `{
        productTags(first: 250${afterClause}) {
          edges {
            node
            cursor
          }
          pageInfo {
            hasNextPage
          }
        }
      }`;

      const tagResponse = await shopifyRequest(client, tagQuery);
      const edges = tagResponse.data.productTags.edges;
      allTags = [...allTags, ...edges.map(e => e.node).filter(Boolean)];
      hasMoreTags = tagResponse.data.productTags.pageInfo.hasNextPage;
      if (hasMoreTags && edges.length > 0) {
        tagCursor = edges[edges.length - 1].cursor;
      }
    }

    res.json({ vendors, tags: allTags.sort() });
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
    if (!barcodes || !locations || barcodes.length === 0 || locations.length === 0) {
      return res.json({});
    }

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
    for (const location of locations) {
      result[location] = [];
    }

    for (const barcode of barcodes) {
      const variantQuery = `
        query getInventory($barcode: String!) {
          productVariants(first: 5, query: $barcode) {
            edges {
              node {
                barcode
                sku
                inventoryItem {
                  inventoryLevels(first: 30) {
                    edges {
                      node {
                        location { id }
                        quantities(names: ["available"]) {
                          name
                          quantity
                        }
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
        if (soh === 0) {
          result[location].push(barcode);
        }
      }
    }

    res.json(result);
  } catch (e) {
    console.error('POST /api/shopify/soh-check error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/shopify/inventory-history/:barcode?locationId=gid://shopify/Location/xxx
// Returns the Shopify Admin URL for the variant's inventory history page at a specific location.
router.get('/inventory-history/:barcode', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });

    const { barcode } = req.params;
    const { locationId } = req.query; // optional Shopify location GID
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const variantQuery = `
      query getVariant($barcode: String!) {
        productVariants(first: 1, query: $barcode) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;

    const variantRes = await shopifyRequest(client, variantQuery, { barcode: `barcode:${barcode}` });
    const variantEdges = variantRes.data?.productVariants?.edges || [];
    if (variantEdges.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Extract numeric variant ID from GID: gid://shopify/ProductVariant/47280245408054 → 47280245408054
    const variantGid = variantEdges[0].node.id;
    const variantId = variantGid.split('/').pop();

    // Extract store name from shop domain: beaute-hera.myshopify.com → beaute-hera
    const storeName = session.shop.replace('.myshopify.com', '');

    // Build URL: https://admin.shopify.com/store/{storeName}/products/inventory/{variantId}/inventory_history
    let url = `https://admin.shopify.com/store/${storeName}/products/inventory/${variantId}/inventory_history`;

    // Append location_id if provided
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