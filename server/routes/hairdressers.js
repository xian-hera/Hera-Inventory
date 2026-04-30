const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { getShopify, getSession } = require('../shopify');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Shared request helper matching the pattern in routes/shopify.js
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

// Get an initialised Shopify GraphQL client
const getClient = async () => {
  const session = await getSession();
  const shopify = getShopify();
  return new shopify.clients.Graphql({ session });
};

// Fetch firstName, lastName, email, phone from Shopify for a raw customer ID
const fetchShopifyCustomer = async (shopifyCustomerId) => {
  try {
    const client = await getClient();
    const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
    const query = `
      query getCustomer($id: ID!) {
        customer(id: $id) {
          firstName
          lastName
          email
          phone
        }
      }
    `;
    const response = await shopifyRequest(client, query, { id: gid });
    return response.data?.customer || {};
  } catch (e) {
    return {};
  }
};

// Build the referral URL for a hairdresser using their raw Shopify customer ID
const buildReferralUrl = (shopifyCustomerId) => {
  const baseUrl = process.env.STORE_URL || 'https://www.herabeauty.ca';
  return `${baseUrl}/pages/refer?ref=${shopifyCustomerId}`;
};

// Build the Shopify customer tag for a hairdresser
const buildTag = (name) =>
  `hairdresser_${name.toLowerCase().replace(/\s+/g, '_')}`;

// ── GET /api/hairdressers ─────────────────────────────────────────────────────
// Returns all hairdressers with live email/phone from Shopify and last generated_at
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        h.id,
        h.shopify_customer_id,
        h.name,
        h.created_at,
        rl.generated_at AS last_generated_at
      FROM hairdressers h
      LEFT JOIN referral_links rl
        ON rl.hairdresser_id = h.id AND rl.is_active = TRUE
      ORDER BY h.name ASC
    `);

    const enriched = await Promise.all(
      rows.map(async (h) => {
        const shopify = await fetchShopifyCustomer(h.shopify_customer_id);
        return {
          ...h,
          email: shopify.email || null,
          phone: shopify.phone || null,
        };
      })
    );

    res.json(enriched);
  } catch (e) {
    console.error('GET /api/hairdressers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/hairdressers/info/:shopify_customer_id ───────────────────────────
// Used by Shopify Theme /pages/refer — returns hairdresser name for display
// Must be defined BEFORE /:id to avoid route conflict
router.get('/info/:shopify_customer_id', async (req, res) => {
  try {
    const { shopify_customer_id } = req.params;
    const { rows } = await pool.query(
      `SELECT name FROM hairdressers WHERE shopify_customer_id = $1`,
      [shopify_customer_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ name: rows[0].name });
  } catch (e) {
    console.error('GET /api/hairdressers/info/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers/bind ───────────────────────────────────────────────
// Called by Shopify Theme when customer confirms binding
// Must be defined BEFORE /:id to avoid route conflict
router.post('/bind', async (req, res) => {
  try {
    const { customer_shopify_id, hairdresser_shopify_customer_id } = req.body;
    if (!customer_shopify_id || !hairdresser_shopify_customer_id) {
      return res.status(400).json({
        error: 'customer_shopify_id and hairdresser_shopify_customer_id are required',
      });
    }

    // Look up hairdresser by their Shopify customer ID
    const hdRes = await pool.query(
      `SELECT id, name FROM hairdressers WHERE shopify_customer_id = $1`,
      [String(hairdresser_shopify_customer_id)]
    );
    if (hdRes.rows.length === 0) {
      return res.status(404).json({ error: 'Hairdresser not found' });
    }
    const hairdresser = hdRes.rows[0];
    const tag = buildTag(hairdresser.name);

    // Verify the referral link is currently active
    const linkRes = await pool.query(
      `SELECT id FROM referral_links WHERE hairdresser_id = $1 AND is_active = TRUE LIMIT 1`,
      [hairdresser.id]
    );
    if (linkRes.rows.length === 0) {
      return res.status(403).json({ error: 'This referral link is no longer active' });
    }

    // Write binding record — always insert new row to preserve history
    await pool.query(
      `INSERT INTO customer_bindings (customer_shopify_id, hairdresser_id) VALUES ($1, $2)`,
      [String(customer_shopify_id), hairdresser.id]
    );

    // Apply Shopify tag to customer (fetch current tags first to avoid overwriting)
    const client = await getClient();
    const gid = `gid://shopify/Customer/${customer_shopify_id}`;

    const tagQuery = `
      query getCustomerTags($id: ID!) {
        customer(id: $id) { tags }
      }
    `;
    const tagRes = await shopifyRequest(client, tagQuery, { id: gid });
    const currentTags = tagRes.data?.customer?.tags || [];

    if (!currentTags.includes(tag)) {
      const mutation = `
        mutation updateCustomer($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id tags }
            userErrors { field message }
          }
        }
      `;
      await shopifyRequest(client, mutation, { input: { id: gid, tags: [...currentTags, tag] } });
    }

    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/hairdressers/bind error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/hairdressers/:id ─────────────────────────────────────────────────
// Returns single hairdresser with live contact info and active referral link
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT * FROM hairdressers WHERE id = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const hairdresser = rows[0];
    const shopify = await fetchShopifyCustomer(hairdresser.shopify_customer_id);

    const linkRes = await pool.query(
      `SELECT url, generated_at FROM referral_links
       WHERE hairdresser_id = $1 AND is_active = TRUE
       ORDER BY generated_at DESC LIMIT 1`,
      [id]
    );

    res.json({
      ...hairdresser,
      email: shopify.email || null,
      phone: shopify.phone || null,
      active_link: linkRes.rows[0] || null,
    });
  } catch (e) {
    console.error('GET /api/hairdressers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers ────────────────────────────────────────────────────
// Add a hairdresser — body: { shopify_customer_id }
router.post('/', async (req, res) => {
  try {
    const { shopify_customer_id } = req.body;
    if (!shopify_customer_id) {
      return res.status(400).json({ error: 'shopify_customer_id is required' });
    }

    const rawId = String(shopify_customer_id).replace('gid://shopify/Customer/', '');
    const shopify = await fetchShopifyCustomer(rawId);

    if (!shopify.firstName && !shopify.lastName && !shopify.email) {
      return res.status(404).json({ error: 'Shopify customer not found' });
    }

    const name =
      [shopify.firstName, shopify.lastName].filter(Boolean).join(' ') ||
      shopify.email ||
      'Unknown';

    const { rows } = await pool.query(
      `INSERT INTO hairdressers (shopify_customer_id, name)
       VALUES ($1, $2)
       ON CONFLICT (shopify_customer_id) DO NOTHING
       RETURNING *`,
      [rawId, name]
    );

    if (rows.length === 0) {
      return res.status(409).json({ error: 'Hairdresser already exists' });
    }

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /api/hairdressers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/hairdressers/:id ──────────────────────────────────────────────
// Delete hairdresser and all related data (CASCADE handles child tables)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(`DELETE FROM hairdressers WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/hairdressers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers/:id/generate-link ──────────────────────────────────
// Deactivate all previous links, generate new active URL
router.post('/:id/generate-link', async (req, res) => {
  const dbClient = await pool.connect();
  try {
    const { id } = req.params;

    const hdRes = await dbClient.query(
      `SELECT shopify_customer_id FROM hairdressers WHERE id = $1`,
      [id]
    );
    if (hdRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const url = buildReferralUrl(hdRes.rows[0].shopify_customer_id);

    await dbClient.query('BEGIN');

    // Mark all previous links inactive
    await dbClient.query(
      `UPDATE referral_links SET is_active = FALSE WHERE hairdresser_id = $1`,
      [id]
    );

    // Insert new active link
    const { rows } = await dbClient.query(
      `INSERT INTO referral_links (hairdresser_id, url, is_active)
       VALUES ($1, $2, TRUE)
       RETURNING url, generated_at`,
      [id, url]
    );

    await dbClient.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await dbClient.query('ROLLBACK');
    console.error('POST /api/hairdressers/:id/generate-link error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// ── GET /api/hairdressers/:id/customers ───────────────────────────────────────
// Returns up to 100 currently bound customers with live Shopify name + email
router.get('/:id/customers', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (customer_shopify_id)
         customer_shopify_id, bound_at
       FROM customer_bindings
       WHERE hairdresser_id = $1
       ORDER BY customer_shopify_id, bound_at DESC
       LIMIT 100`,
      [id]
    );

    const enriched = await Promise.all(
      rows.map(async (row) => {
        const shopify = await fetchShopifyCustomer(row.customer_shopify_id);
        const fullName = [shopify.firstName, shopify.lastName].filter(Boolean).join(' ');
        return {
          customer_shopify_id: row.customer_shopify_id,
          bound_at: row.bound_at,
          name: fullName || null,
          email: shopify.email || null,
        };
      })
    );

    res.json(enriched);
  } catch (e) {
    console.error('GET /api/hairdressers/:id/customers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/hairdressers/:id/tags ─────────────────────────────────────────
// Unbind all customers: delete customer_bindings rows + remove Shopify tags
router.delete('/:id/tags', async (req, res) => {
  const dbClient = await pool.connect();
  try {
    const { id } = req.params;

    const hdRes = await dbClient.query(
      `SELECT name FROM hairdressers WHERE id = $1`,
      [id]
    );
    if (hdRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const tag = buildTag(hdRes.rows[0].name);

    // Collect all bound customer IDs before deleting
    const bindRes = await dbClient.query(
      `SELECT DISTINCT customer_shopify_id FROM customer_bindings WHERE hairdresser_id = $1`,
      [id]
    );
    const customerIds = bindRes.rows.map((r) => r.customer_shopify_id);

    await dbClient.query('BEGIN');
    await dbClient.query(`DELETE FROM customer_bindings WHERE hairdresser_id = $1`, [id]);
    await dbClient.query('COMMIT');

    // Remove Shopify tags — best-effort, failures don't block the response
    const client = await getClient();
    const tagQuery = `
      query getCustomerTags($id: ID!) {
        customer(id: $id) { tags }
      }
    `;
    const mutation = `
      mutation updateCustomer($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }
    `;

    await Promise.allSettled(
      customerIds.map(async (customerId) => {
        const gid = `gid://shopify/Customer/${customerId}`;
        const tagRes = await shopifyRequest(client, tagQuery, { id: gid });
        const currentTags = tagRes.data?.customer?.tags || [];
        const updatedTags = currentTags.filter((t) => t !== tag);
        await shopifyRequest(client, mutation, { input: { id: gid, tags: updatedTags } });
      })
    );

    res.json({ success: true, unbound: customerIds.length });
  } catch (e) {
    await dbClient.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/hairdressers/:id/tags error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// ── POST /api/hairdressers/:id/statistics ────────────────────────────────────
// Calculate revenue for all bound customers from date_from to today
router.post('/:id/statistics', async (req, res) => {
  try {
    const { id } = req.params;
    const { date_from } = req.body;
    if (!date_from) return res.status(400).json({ error: 'date_from is required' });

    const hdRes = await pool.query(`SELECT id FROM hairdressers WHERE id = $1`, [id]);
    if (hdRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const bindRes = await pool.query(
      `SELECT DISTINCT customer_shopify_id FROM customer_bindings WHERE hairdresser_id = $1`,
      [id]
    );
    const customerIds = bindRes.rows.map((r) => r.customer_shopify_id);

    const client = await getClient();
    let totalRevenue = 0;

    const ordersQuery = `
      query getCustomerOrders($id: ID!, $query: String!) {
        customer(id: $id) {
          orders(first: 250, query: $query) {
            edges {
              node {
                totalPriceSet { shopMoney { amount } }
                financialStatus
              }
            }
          }
        }
      }
    `;

    await Promise.allSettled(
      customerIds.map(async (customerId) => {
        const gid = `gid://shopify/Customer/${customerId}`;
        const queryStr = `created_at:>='${date_from}' financial_status:paid`;
        const response = await shopifyRequest(client, ordersQuery, { id: gid, query: queryStr });
        const edges = response.data?.customer?.orders?.edges || [];
        edges.forEach(({ node }) => {
          totalRevenue += parseFloat(node.totalPriceSet?.shopMoney?.amount || 0);
        });
      })
    );

    const dateToStr = new Date().toISOString().split('T')[0];

    // Upsert — one row per hairdresser, replaced on each recalculation
    const { rows } = await pool.query(
      `INSERT INTO statistics_cache
         (hairdresser_id, date_from, date_to, total_customers, total_revenue, calculated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (hairdresser_id)
       DO UPDATE SET
         date_from       = EXCLUDED.date_from,
         date_to         = EXCLUDED.date_to,
         total_customers = EXCLUDED.total_customers,
         total_revenue   = EXCLUDED.total_revenue,
         calculated_at   = NOW()
       RETURNING *`,
      [id, date_from, dateToStr, customerIds.length, totalRevenue.toFixed(2)]
    );

    res.json(rows[0]);
  } catch (e) {
    console.error('POST /api/hairdressers/:id/statistics error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/hairdressers/:id/statistics ─────────────────────────────────────
// Return the last cached statistics result for a hairdresser
router.get('/:id/statistics', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM statistics_cache
       WHERE hairdresser_id = $1
       ORDER BY calculated_at DESC LIMIT 1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'No statistics yet' });
    res.json(rows[0]);
  } catch (e) {
    console.error('GET /api/hairdressers/:id/statistics error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;