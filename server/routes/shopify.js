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

// GET /api/shopify/product-types
router.get('/product-types', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });
    console.log('Session accessToken:', session?.accessToken ? 'present' : 'MISSING');

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const query = `{
      productTypes(first: 50) {
        edges {
          node
        }
      }
    }`;

    const response = await client.query({ data: query });
    const types = response.body.data.productTypes.edges.map(e => e.node).filter(Boolean);
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
    console.log('Session accessToken:', session?.accessToken ? 'present' : 'MISSING');

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

    const response = await client.query({ data: gqlQuery });
    const products = response.body.data.products.edges;

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
    console.log('Session accessToken:', session?.accessToken ? 'present' : 'MISSING');

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

    const response = await client.query({ data: query });
    const locations = response.body.data.locations.edges.map(e => ({
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
    console.log('Session accessToken:', session?.accessToken ? 'present' : 'MISSING');

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

    const response = await client.query({ data: variantQuery });
    const variants = response.body.data.productVariants.edges;

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
    console.log('Session accessToken:', session?.accessToken ? 'present' : 'MISSING');

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

    const response = await client.query({ data: query });
    const locations = response.body.data.locations.edges.map(e => ({
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

module.exports = { router, getDepartment };