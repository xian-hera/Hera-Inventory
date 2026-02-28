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

async function shopifyRequest(client, query, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await client.request(query);
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

    let queryParts = [];
    if (types && types.length > 0) {
      if (typeCondition === 'is') {
        queryParts.push(`(${types.map(t => `product_type:${t}`).join(' OR ')})`);
      } else {
        queryParts.push(`NOT (${types.map(t => `product_type:${t}`).join(' OR ')})`);
      }
    }

    const queryString = queryParts.join(' AND ') || 'status:active';

    const gqlQuery = `{
      products(first: 250, query: "${queryString}") {
        edges {
          node {
            id
            title
            productType
            variants(first: 100) {
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
    }`;

    const response = await shopifyRequest(client, gqlQuery);
    const products = response.data.products.edges;

    let variants = [];
    for (const { node: product } of products) {
      const dept = getDepartment(product.productType);
      if (department && department !== 'ALL' && dept !== department) continue;
      for (const { node: variant } of product.variants.edges) {
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

    const variantQuery = `{
      productVariants(first: 5, query: "barcode:${barcode}") {
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
    }`;

    const response = await shopifyRequest(client, variantQuery);
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
      const escapedVendors = vendorList.map(v => `vendor:"${v.replace(/"/g, '\\"')}"`);
      queryParts.push(`(${escapedVendors.join(' OR ')})`);
    }
    if (tag) queryParts.push(`tag:"${tag}"`);

    if (queryParts.length === 0) return res.json([]);

    const queryString = queryParts.join(' AND ');
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const gqlQuery = `{
      products(first: 20, query: "${queryString}") {
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
    }`;

    const response = await shopifyRequest(client, gqlQuery);
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

    // Fetch vendors
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

    // Fetch all tags with pagination
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

module.exports = { router, getDepartment };