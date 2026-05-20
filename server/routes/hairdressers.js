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

const PARTNER_TAG = 'hairdresser_partner';

// Add hairdresser_partner tag to a Shopify customer (best-effort, non-blocking)
const addPartnerTag = async (shopifyCustomerId) => {
  try {
    const client = await getClient();
    const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
    const tagQuery = `query getCustomerTags($id: ID!) { customer(id: $id) { tags } }`;
    const tagRes = await shopifyRequest(client, tagQuery, { id: gid });
    const currentTags = tagRes.data?.customer?.tags || [];
    if (currentTags.includes(PARTNER_TAG)) return;
    const mutation = `
      mutation updateCustomer($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }
    `;
    await shopifyRequest(client, mutation, {
      input: { id: gid, tags: [...currentTags, PARTNER_TAG] },
    });
  } catch (e) {
    console.error('addPartnerTag error:', e);
  }
};

// Remove hairdresser_partner tag from a Shopify customer (best-effort, non-blocking)
const removePartnerTag = async (shopifyCustomerId) => {
  try {
    const client = await getClient();
    const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
    const tagQuery = `query getCustomerTags($id: ID!) { customer(id: $id) { tags } }`;
    const tagRes = await shopifyRequest(client, tagQuery, { id: gid });
    const currentTags = tagRes.data?.customer?.tags || [];
    if (!currentTags.includes(PARTNER_TAG)) return;
    const mutation = `
      mutation updateCustomer($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }
    `;
    await shopifyRequest(client, mutation, {
      input: { id: gid, tags: currentTags.filter(t => t !== PARTNER_TAG) },
    });
  } catch (e) {
    console.error('removePartnerTag error:', e);
  }
};

// Write an activity log entry
const logActivity = async (hairdresserId, action, detail = null) => {
  try {
    await pool.query(
      `INSERT INTO hairdresser_activity_log (hairdresser_id, action, detail) VALUES ($1, $2, $3)`,
      [hairdresserId, action, detail]
    );
  } catch (e) {
    console.error('logActivity error:', e);
  }
};

// ── DB migration: ensure unbound_at column exists ─────────────────────────────
// Safe to run on every startup — does nothing if column already exists
pool.query(`
  ALTER TABLE customer_bindings ADD COLUMN IF NOT EXISTS unbound_at TIMESTAMPTZ DEFAULT NULL
`).catch(e => console.error('Migration error (unbound_at):', e));

// ── DB migration: ensure commission tables exist ───────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS commission_settings (
    id SERIAL PRIMARY KEY,
    rate NUMERIC(5,2) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS commission_payouts (
    id SERIAL PRIMARY KEY,
    paid_at TIMESTAMPTZ DEFAULT NOW(),
    date_from DATE NOT NULL,
    date_to DATE NOT NULL,
    hairdresser_count INTEGER NOT NULL,
    total_revenue NUMERIC(12,2) NOT NULL,
    total_paid NUMERIC(12,2) NOT NULL
  );

  CREATE TABLE IF NOT EXISTS commission_payout_items (
    id SERIAL PRIMARY KEY,
    payout_id INTEGER NOT NULL REFERENCES commission_payouts(id) ON DELETE CASCADE,
    hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
    hairdresser_name TEXT NOT NULL,
    hairdresser_email TEXT,
    revenue NUMERIC(12,2) NOT NULL,
    commission NUMERIC(12,2) NOT NULL
  );
`).catch(e => console.error('Migration error (commission tables):', e));


// ── GET /api/hairdressers ─────────────────────────────────────────────────────
// Returns all hairdressers with live email/phone from Shopify, last generated_at,
// and bound_customers count (only currently active bindings: unbound_at IS NULL)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        h.id,
        h.shopify_customer_id,
        h.name,
        h.created_at,
        rl.generated_at AS last_generated_at,
        COUNT(DISTINCT cb.customer_shopify_id)
          FILTER (WHERE cb.unbound_at IS NULL) AS bound_customers
      FROM hairdressers h
      LEFT JOIN referral_links rl
        ON rl.hairdresser_id = h.id AND rl.is_active = TRUE
      LEFT JOIN customer_bindings cb
        ON cb.hairdresser_id = h.id
      GROUP BY h.id, h.name, h.created_at, rl.generated_at
      ORDER BY h.name ASC
    `);

    const enriched = await Promise.all(
      rows.map(async (h) => {
        const shopify = await fetchShopifyCustomer(h.shopify_customer_id);
        return {
          ...h,
          bound_customers: parseInt(h.bound_customers, 10),
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

// ── GET /api/hairdressers/portal/:shopify_customer_id ────────────────────────
// Used by Shopify Theme hairdresser portal page
// Returns: { is_hairdresser, has_link, url, generated_at }
// Must be defined BEFORE /:id to avoid route conflict
router.get('/portal/:shopify_customer_id', async (req, res) => {
  try {
    const { shopify_customer_id } = req.params;

    const hdRes = await pool.query(
      `SELECT id, name FROM hairdressers WHERE shopify_customer_id = $1`,
      [String(shopify_customer_id)]
    );

    if (hdRes.rows.length === 0) {
      return res.json({ is_hairdresser: false });
    }

    const hairdresser = hdRes.rows[0];

    const linkRes = await pool.query(
      `SELECT url, generated_at FROM referral_links
       WHERE hairdresser_id = $1 AND is_active = TRUE
       ORDER BY generated_at DESC LIMIT 1`,
      [hairdresser.id]
    );

    if (linkRes.rows.length === 0) {
      return res.json({ is_hairdresser: true, has_link: false });
    }

    res.json({
      is_hairdresser: true,
      has_link: true,
      url: linkRes.rows[0].url,
      generated_at: linkRes.rows[0].generated_at,
    });
  } catch (e) {
    console.error('GET /api/hairdressers/portal/:id error:', e);
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

    // ── Self-binding guard ────────────────────────────────────────────────────
    if (String(customer_shopify_id) === String(hairdresser_shopify_customer_id)) {
      return res.status(403).json({ error: 'A hairdresser cannot bind themselves as a customer' });
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
    const newTag = buildTag(hairdresser.name);

    // Verify the referral link is currently active
    const linkRes = await pool.query(
      `SELECT id FROM referral_links WHERE hairdresser_id = $1 AND is_active = TRUE LIMIT 1`,
      [hairdresser.id]
    );
    if (linkRes.rows.length === 0) {
      return res.status(403).json({ error: 'This referral link is no longer active' });
    }

    // ── Soft-delete any existing active bindings for this customer ────────────
    // (preserves history for accurate commission calculation)
    await pool.query(
      `UPDATE customer_bindings
       SET unbound_at = NOW()
       WHERE customer_shopify_id = $1
         AND hairdresser_id != $2
         AND unbound_at IS NULL`,
      [String(customer_shopify_id), hairdresser.id]
    );

    // Check if this customer already has an active binding to the same hairdresser
    const existingBinding = await pool.query(
      `SELECT id FROM customer_bindings
       WHERE customer_shopify_id = $1 AND hairdresser_id = $2 AND unbound_at IS NULL`,
      [String(customer_shopify_id), hairdresser.id]
    );

    if (existingBinding.rows.length === 0) {
      // Insert new active binding record
      await pool.query(
        `INSERT INTO customer_bindings (customer_shopify_id, hairdresser_id) VALUES ($1, $2)`,
        [String(customer_shopify_id), hairdresser.id]
      );
    }

    // Update Shopify tags: remove all hairdresser_ tags, then add the new one
    const client = await getClient();
    const gid = `gid://shopify/Customer/${customer_shopify_id}`;

    const tagQuery = `
      query getCustomerTags($id: ID!) {
        customer(id: $id) { tags }
      }
    `;
    const tagRes = await shopifyRequest(client, tagQuery, { id: gid });
    const currentTags = tagRes.data?.customer?.tags || [];

    // Strip all existing hairdresser_ tags, then add the new one
    const filteredTags = currentTags.filter((t) => !t.startsWith('hairdresser_'));
    const updatedTags = [...filteredTags, newTag];

    const mutation = `
      mutation updateCustomer($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }
    `;
    await shopifyRequest(client, mutation, { input: { id: gid, tags: updatedTags } });

    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/hairdressers/bind error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers/import-csv ────────────────────────────────────────
// Bulk-add hairdressers from a list of emails
// Body: { emails: string[] }
// Returns: { added: [], already_exists: [], not_found: [], errors: [] }
router.post('/import-csv', async (req, res) => {
  try {
    const { emails } = req.body;
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'emails array is required' });
    }

    const results = { added: [], already_exists: [], not_found: [], errors: [] };
    const client = await getClient();

    // Search Shopify for each email using the customers query
    const searchQuery = `
      query searchCustomer($query: String!) {
        customers(first: 1, query: $query) {
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

    for (const rawEmail of emails) {
      const email = rawEmail.trim().toLowerCase();
      if (!email) continue;

      try {
        const response = await shopifyRequest(client, searchQuery, { query: `email:${email}` });
        const edges = response.data?.customers?.edges || [];

        if (edges.length === 0) {
          results.not_found.push(email);
          continue;
        }

        const customer = edges[0].node;
        // Strip the GID prefix to get the raw numeric ID
        const rawId = customer.id.replace('gid://shopify/Customer/', '');
        const name =
          [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
          customer.email ||
          'Unknown';

        const { rows } = await pool.query(
          `INSERT INTO hairdressers (shopify_customer_id, name)
           VALUES ($1, $2)
           ON CONFLICT (shopify_customer_id) DO NOTHING
           RETURNING *`,
          [rawId, name]
        );

        if (rows.length === 0) {
          results.already_exists.push(email);
        } else {
          await logActivity(rows[0].id, 'created');
          await addPartnerTag(rawId);
          results.added.push(email);
        }
      } catch (e) {
        results.errors.push({ email, message: e.message });
      }
    }

    res.json(results);
  } catch (e) {
    console.error('POST /api/hairdressers/import-csv error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers/bulk-generate-links ────────────────────────────────
// Generate referral links for all hairdressers who have never had one
// Already-generated hairdressers are not affected
router.post('/bulk-generate-links', async (req, res) => {
  const dbClient = await pool.connect();
  try {
    // Find all hairdressers who have never had a referral link
    const { rows: hairdressers } = await pool.query(`
      SELECT h.id, h.shopify_customer_id, h.name
      FROM hairdressers h
      WHERE NOT EXISTS (
        SELECT 1 FROM referral_links rl WHERE rl.hairdresser_id = h.id
      )
    `);

    if (hairdressers.length === 0) {
      return res.json({ generated: 0, message: 'All hairdressers already have links' });
    }

    let generated = 0;

    for (const h of hairdressers) {
      try {
        const url = buildReferralUrl(h.shopify_customer_id);

        await dbClient.query('BEGIN');
        // No previous links to deactivate since this is first-ever generation
        await dbClient.query(
          `INSERT INTO referral_links (hairdresser_id, url, is_active)
           VALUES ($1, $2, TRUE)`,
          [h.id, url]
        );
        await dbClient.query('COMMIT');

        // Log bulk generation in activity log
        await logActivity(h.id, 'bulk_link_generated');
        generated++;
      } catch (e) {
        await dbClient.query('ROLLBACK').catch(() => {});
        console.error(`bulk-generate-links: failed for hairdresser ${h.id}:`, e);
      }
    }

    res.json({ generated });
  } catch (e) {
    console.error('POST /api/hairdressers/bulk-generate-links error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// ── DELETE /api/hairdressers/unbind-all ──────────────────────────────────────
// Unbind ALL customers from ALL hairdressers
// Soft-deletes all active bindings and removes hairdresser_ tags from Shopify
router.delete('/unbind-all', async (req, res) => {
  const dbClient = await pool.connect();
  try {
    // Get all hairdressers that have at least one active binding
    const hdRes = await dbClient.query(`
      SELECT DISTINCT h.id, h.name
      FROM hairdressers h
      INNER JOIN customer_bindings cb ON cb.hairdresser_id = h.id AND cb.unbound_at IS NULL
    `);

    if (hdRes.rows.length === 0) {
      return res.json({ success: true, unbound: 0 });
    }

    let totalUnbound = 0;

    const client = await getClient();
    const tagQuery = `query getCustomerTags($id: ID!) { customer(id: $id) { tags } }`;
    const mutation = `
      mutation updateCustomer($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }
    `;

    for (const h of hdRes.rows) {
      try {
        const tag = buildTag(h.name);

        // Collect currently bound customer IDs for this hairdresser
        const bindRes = await dbClient.query(
          `SELECT DISTINCT customer_shopify_id FROM customer_bindings
           WHERE hairdresser_id = $1 AND unbound_at IS NULL`,
          [h.id]
        );
        const customerIds = bindRes.rows.map(r => r.customer_shopify_id);

        // Soft-delete all active bindings for this hairdresser
        await dbClient.query(
          `UPDATE customer_bindings SET unbound_at = NOW()
           WHERE hairdresser_id = $1 AND unbound_at IS NULL`,
          [h.id]
        );

        totalUnbound += customerIds.length;

        // Remove Shopify tags — best-effort
        await Promise.allSettled(
          customerIds.map(async (customerId) => {
            const gid = `gid://shopify/Customer/${customerId}`;
            const tagRes = await shopifyRequest(client, tagQuery, { id: gid });
            const currentTags = tagRes.data?.customer?.tags || [];
            const updatedTags = currentTags.filter(t => t !== tag);
            await shopifyRequest(client, mutation, { input: { id: gid, tags: updatedTags } });
          })
        );
      } catch (e) {
        console.error(`unbind-all: failed for hairdresser ${h.id}:`, e);
      }
    }

    res.json({ success: true, unbound: totalUnbound });
  } catch (e) {
    console.error('DELETE /api/hairdressers/unbind-all error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// ── GET /api/hairdressers/commission/settings ─────────────────────────────────
router.get('/commission/settings', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rate, updated_at FROM commission_settings ORDER BY updated_at DESC LIMIT 1`
    );
    if (rows.length === 0) return res.json({ rate: null });
    res.json(rows[0]);
  } catch (e) {
    console.error('GET /api/hairdressers/commission/settings error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers/commission/settings ────────────────────────────────
// Body: { rate: number }  e.g. { rate: 5 } for 5%
router.post('/commission/settings', async (req, res) => {
  try {
    const { rate } = req.body;
    if (rate == null || isNaN(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: 'rate must be a number between 0 and 100' });
    }
    // Truncate table and insert new value (we only ever need one current rate)
    await pool.query(`DELETE FROM commission_settings`);
    const { rows } = await pool.query(
      `INSERT INTO commission_settings (rate) VALUES ($1) RETURNING rate, updated_at`,
      [parseFloat(rate)]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('POST /api/hairdressers/commission/settings error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers/commission/calculate ───────────────────────────────
// Calculate revenue for ALL hairdressers with at least 1 active bound customer
// Body: { date_from: 'YYYY-MM-DD' }
// Returns: array of { hairdresser_id, name, email, phone, customer_count, revenue }
router.post('/commission/calculate', async (req, res) => {
  try {
    const { date_from } = req.body;
    if (!date_from) return res.status(400).json({ error: 'date_from is required' });

    // Get all hairdressers that have at least 1 currently active binding
    const { rows: hairdressers } = await pool.query(`
      SELECT DISTINCT h.id, h.name, h.shopify_customer_id
      FROM hairdressers h
      INNER JOIN customer_bindings cb ON cb.hairdresser_id = h.id AND cb.unbound_at IS NULL
    `);

    if (hairdressers.length === 0) {
      return res.json([]);
    }

    const client = await getClient();

    // GraphQL query that fetches line items so we can exclude gift cards
    const ordersQuery = `
      query getCustomerOrders($id: ID!, $query: String!) {
        customer(id: $id) {
          orders(first: 250, query: $query) {
            edges {
              node {
                displayFinancialStatus
                lineItems(first: 100) {
                  edges {
                    node {
                      quantity
                      isGiftCard
                      originalUnitPriceSet { shopMoney { amount } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const results = await Promise.all(
      hairdressers.map(async (h) => {
        // Get ALL binding records for this hairdresser (including historical)
        const { rows: bindings } = await pool.query(
          `SELECT customer_shopify_id, bound_at, unbound_at
           FROM customer_bindings
           WHERE hairdresser_id = $1`,
          [h.id]
        );

        const today = new Date().toISOString().split('T')[0];
        let totalRevenue = 0;

        // For each binding, calculate the effective time window
        await Promise.allSettled(
          bindings.map(async (binding) => {
            const boundAt = new Date(binding.bound_at).toISOString().split('T')[0];
            const unboundAt = binding.unbound_at
              ? new Date(binding.unbound_at).toISOString().split('T')[0]
              : today;

            // Effective window: from MAX(date_from, bound_at) to unbound_at (or today)
            const effectiveFrom = boundAt > date_from ? boundAt : date_from;
            const effectiveTo = unboundAt;

            // Skip if window is invalid (binding started after unbound, or after today)
            if (effectiveFrom >= effectiveTo) return;

            const gid = `gid://shopify/Customer/${binding.customer_shopify_id}`;
            const queryStr = `created_at:>='${effectiveFrom}' created_at:<='${effectiveTo}' financial_status:paid`;
            console.log('[calculate] querying customer:', binding.customer_shopify_id, 'window:', effectiveFrom, '->', effectiveTo, 'query:', queryStr);

            let response;
            try {
              response = await shopifyRequest(client, ordersQuery, { id: gid, query: queryStr });
            } catch (reqErr) {
              console.error('[calculate] shopifyRequest threw:', reqErr?.message, reqErr?.response?.status);
              return;
            }

            console.log('[calculate] response.data keys:', Object.keys(response.data || {}));
            console.log('[calculate] customer node:', JSON.stringify(response.data?.customer)?.slice(0, 300));
            const edges = response.data?.customer?.orders?.edges || [];
            console.log('[calculate] orders returned:', edges.length, 'errors:', JSON.stringify(response.errors || null));
            if (edges.length > 0) {
              console.log('[calculate] first order displayFinancialStatus:', edges[0].node.displayFinancialStatus, 'lineItems:', edges[0].node.lineItems?.edges?.length);
            }

            edges.forEach(({ node }) => {
              if (node.displayFinancialStatus !== 'PAID') return;
              // Sum line items, excluding gift cards
              node.lineItems.edges.forEach(({ node: item }) => {
                if (item.isGiftCard) return;
                const unitPrice = parseFloat(item.originalUnitPriceSet?.shopMoney?.amount || 0);
                totalRevenue += unitPrice * item.quantity;
              });
            });
          })
        );

        // Get live contact info from Shopify
        const shopify = await fetchShopifyCustomer(h.shopify_customer_id);

        return {
          hairdresser_id: h.id,
          name: h.name,
          email: shopify.email || null,
          phone: shopify.phone || null,
          customer_count: bindings.filter(b => b.unbound_at === null).length,
          revenue: parseFloat(totalRevenue.toFixed(2)),
        };
      })
    );

    res.json(results);
  } catch (e) {
    console.error('POST /api/hairdressers/commission/calculate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers/commission/pay ─────────────────────────────────────
// Issue store credit to all hairdressers based on calculated revenues
// Body: { date_from, results: [{ hairdresser_id, name, email, revenue }] }
router.post('/commission/pay', async (req, res) => {
  try {
    const { date_from, results } = req.body;
    if (!date_from || !Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: 'date_from and results are required' });
    }

    // Get current commission rate
    const rateRes = await pool.query(
      `SELECT rate FROM commission_settings ORDER BY updated_at DESC LIMIT 1`
    );
    if (rateRes.rows.length === 0) {
      return res.status(400).json({ error: 'Commission rate not set' });
    }
    const rate = parseFloat(rateRes.rows[0].rate);

    const today = new Date().toISOString().split('T')[0];
    // date_to for the log is yesterday (day before pay date) to match the period
    const dateTo = new Date();
    dateTo.setDate(dateTo.getDate() - 1);
    const dateToStr = dateTo.toISOString().split('T')[0];

    const client = await getClient();

    let totalRevenue = 0;
    let totalPaid = 0;
    let hairdresserCount = 0;
    const payoutItems = [];

    // Issue store credit to each hairdresser via Shopify storeCreditAccountCredit mutation
    // Using Customer GID directly — Shopify auto-creates the account if it doesn't exist yet.
    // Requires scope: write_store_credit_account_transactions
    const storeCreditMutation = `
      mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
        storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
          storeCreditAccountTransaction {
            id
            amount { amount currencyCode }
          }
          userErrors { field message }
        }
      }
    `;

    for (const item of results) {
      if (!item.revenue || item.revenue <= 0) continue;

      const commission = parseFloat((item.revenue * (rate / 100)).toFixed(2));
      if (commission <= 0) continue;

      try {
        // Fetch hairdresser's Shopify customer ID
        const hdRow = await pool.query(
          `SELECT shopify_customer_id FROM hairdressers WHERE id = $1`,
          [item.hairdresser_id]
        );
        if (!hdRow.rows[0]) continue;

        const customerGid = `gid://shopify/Customer/${hdRow.rows[0].shopify_customer_id}`;

        // Pass Customer GID directly — no need to pre-fetch the store credit account.
        // Shopify creates the CAD account automatically on first credit.
        await shopifyRequest(client, storeCreditMutation, {
          id: customerGid,
          creditInput: { creditAmount: { amount: commission.toString(), currencyCode: 'CAD' } },
        });

        // Log in activity log
        const fromLabel = formatPeriodDate(date_from);
        const toLabel = formatPeriodDate(dateToStr);
        await logActivity(
          item.hairdresser_id,
          'commission_paid',
          `$${commission.toFixed(2)} store credit issued for ${fromLabel} to ${toLabel}`
        );

        totalRevenue += item.revenue;
        totalPaid += commission;
        hairdresserCount++;
        payoutItems.push({
          hairdresser_id: item.hairdresser_id,
          hairdresser_name: item.name,
          hairdresser_email: item.email || null,
          revenue: item.revenue,
          commission,
        });
      } catch (e) {
        console.error(`commission/pay: failed for hairdresser ${item.hairdresser_id}:`, e);
      }
    }

    // Save payout record
    const payoutRes = await pool.query(
      `INSERT INTO commission_payouts
         (date_from, date_to, hairdresser_count, total_revenue, total_paid)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [date_from, dateToStr, hairdresserCount, totalRevenue.toFixed(2), totalPaid.toFixed(2)]
    );
    const payoutId = payoutRes.rows[0].id;

    for (const item of payoutItems) {
      await pool.query(
        `INSERT INTO commission_payout_items
           (payout_id, hairdresser_id, hairdresser_name, hairdresser_email, revenue, commission)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [payoutId, item.hairdresser_id, item.hairdresser_name, item.hairdresser_email, item.revenue, item.commission]
      );
    }

    res.json({
      success: true,
      hairdresser_count: hairdresserCount,
      total_revenue: parseFloat(totalRevenue.toFixed(2)),
      total_paid: parseFloat(totalPaid.toFixed(2)),
    });
  } catch (e) {
    console.error('POST /api/hairdressers/commission/pay error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/hairdressers/commission/history ──────────────────────────────────
router.get('/commission/history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, paid_at, date_from, date_to, hairdresser_count, total_revenue, total_paid
      FROM commission_payouts
      ORDER BY paid_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /api/hairdressers/commission/history error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/hairdressers/commission/history/:payoutId/items ─────────────────
router.get('/commission/history/:payoutId/items', async (req, res) => {
  try {
    const { payoutId } = req.params;
    const { rows } = await pool.query(
      `SELECT hairdresser_name, hairdresser_email, revenue, commission
       FROM commission_payout_items
       WHERE payout_id = $1
       ORDER BY hairdresser_name ASC`,
      [payoutId]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/hairdressers/commission/history/:payoutId/items error:', e);
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

    // Log creation
    await logActivity(rows[0].id, 'created');

    // Add hairdresser_partner tag so storefront portal can identify this customer
    await addPartnerTag(rawId);

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

    // Fetch shopify_customer_id before deleting so we can remove the partner tag
    const hdRes = await pool.query(`SELECT shopify_customer_id FROM hairdressers WHERE id = $1`, [id]);
    if (hdRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const shopifyCustomerId = hdRes.rows[0].shopify_customer_id;

    const { rowCount } = await pool.query(`DELETE FROM hairdressers WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });

    // Remove hairdresser_partner tag now that this customer is no longer a hairdresser
    await removePartnerTag(shopifyCustomerId);

    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/hairdressers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers/:id/generate-link ──────────────────────────────────
// Deactivate all previous links, generate new active URL
// Logs only the first-ever link generation
router.post('/:id/generate-link', async (req, res) => {
  const dbClient = await pool.connect();
  try {
    const { id } = req.params;

    const hdRes = await dbClient.query(
      `SELECT shopify_customer_id FROM hairdressers WHERE id = $1`,
      [id]
    );
    if (hdRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    // Check if this is the first-ever link for this hairdresser
    const existingLinks = await dbClient.query(
      `SELECT COUNT(*) AS cnt FROM referral_links WHERE hairdresser_id = $1`,
      [id]
    );
    const isFirst = parseInt(existingLinks.rows[0].cnt, 10) === 0;

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

    // Log only the first generation
    if (isFirst) {
      await logActivity(id, 'first_link_generated');
    }

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
// Returns up to 100 currently bound customers (unbound_at IS NULL) with live
// Shopify name, email, phone
router.get('/:id/customers', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT customer_shopify_id, bound_at
       FROM customer_bindings
       WHERE hairdresser_id = $1 AND unbound_at IS NULL
       ORDER BY bound_at DESC
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
          phone: shopify.phone || null,
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
// Unbind all customers: soft-delete bindings (set unbound_at) + remove Shopify tags
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

    // Collect all currently bound customer IDs before unbinding
    const bindRes = await dbClient.query(
      `SELECT DISTINCT customer_shopify_id FROM customer_bindings
       WHERE hairdresser_id = $1 AND unbound_at IS NULL`,
      [id]
    );
    const customerIds = bindRes.rows.map((r) => r.customer_shopify_id);

    await dbClient.query('BEGIN');
    // Soft-delete: set unbound_at instead of deleting rows
    await dbClient.query(
      `UPDATE customer_bindings SET unbound_at = NOW()
       WHERE hairdresser_id = $1 AND unbound_at IS NULL`,
      [id]
    );
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
// Calculate revenue for this hairdresser's customers using time-windowed bindings
// and excluding gift card line items
router.post('/:id/statistics', async (req, res) => {
  try {
    const { id } = req.params;
    const { date_from } = req.body;
    if (!date_from) return res.status(400).json({ error: 'date_from is required' });

    const hdRes = await pool.query(`SELECT id FROM hairdressers WHERE id = $1`, [id]);
    if (hdRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    // Get ALL binding records (including historical) for accurate time-windowed stats
    const { rows: bindings } = await pool.query(
      `SELECT customer_shopify_id, bound_at, unbound_at
       FROM customer_bindings
       WHERE hairdresser_id = $1`,
      [id]
    );

    const today = new Date().toISOString().split('T')[0];
    const client = await getClient();
    let totalRevenue = 0;

    // Count distinct currently-bound customers for the stat display
    const currentCustomerCount = bindings.filter(b => b.unbound_at === null).length;

    // GraphQL query with line items to filter out gift cards
    const ordersQuery = `
      query getCustomerOrders($id: ID!, $query: String!) {
        customer(id: $id) {
          orders(first: 250, query: $query) {
            edges {
              node {
                displayFinancialStatus
                lineItems(first: 100) {
                  edges {
                    node {
                      quantity
                      isGiftCard
                      originalUnitPriceSet { shopMoney { amount } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    await Promise.allSettled(
      bindings.map(async (binding) => {
        const boundAt = new Date(binding.bound_at).toISOString().split('T')[0];
        const unboundAt = binding.unbound_at
          ? new Date(binding.unbound_at).toISOString().split('T')[0]
          : today;

        // Effective window: MAX(date_from, bound_at) → unbound_at (or today)
        const effectiveFrom = boundAt > date_from ? boundAt : date_from;
        const effectiveTo = unboundAt;

        if (effectiveFrom >= effectiveTo) return;

        const gid = `gid://shopify/Customer/${binding.customer_shopify_id}`;
        const queryStr = `created_at:>='${effectiveFrom}' created_at:<='${effectiveTo}' financial_status:paid`;

        const response = await shopifyRequest(client, ordersQuery, { id: gid, query: queryStr });
        const edges = response.data?.customer?.orders?.edges || [];

        edges.forEach(({ node }) => {
          node.lineItems.edges.forEach(({ node: item }) => {
            if (item.isGiftCard) return; // exclude gift cards
            const unitPrice = parseFloat(item.originalUnitPriceSet?.shopMoney?.amount || 0);
            totalRevenue += unitPrice * item.quantity;
          });
        });
      })
    );

    const dateToStr = today;

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
      [id, date_from, dateToStr, currentCustomerCount, totalRevenue.toFixed(2)]
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

// ── GET /api/hairdressers/:id/notes ──────────────────────────────────────────
// Return all notes for a hairdresser
router.get('/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM hairdresser_notes
       WHERE hairdresser_id = $1
       ORDER BY created_at DESC`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/hairdressers/:id/notes error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hairdressers/:id/notes ─────────────────────────────────────────
// Add a note for a hairdresser
router.post('/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO hairdresser_notes (hairdresser_id, content)
       VALUES ($1, $2)
       RETURNING *`,
      [id, content.trim()]
    );

    await logActivity(id, 'note_added', content.trim());

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /api/hairdressers/:id/notes error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/hairdressers/:id/notes/:noteId ───────────────────────────────
// Delete a note for a hairdresser
router.delete('/:id/notes/:noteId', async (req, res) => {
  try {
    const { id, noteId } = req.params;

    // Fetch note content before deleting (for activity log)
    const noteRes = await pool.query(
      `SELECT content FROM hairdresser_notes WHERE id = $1 AND hairdresser_id = $2`,
      [noteId, id]
    );
    if (noteRes.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const content = noteRes.rows[0].content;

    await pool.query(
      `DELETE FROM hairdresser_notes WHERE id = $1 AND hairdresser_id = $2`,
      [noteId, id]
    );

    await logActivity(id, 'note_deleted', content);

    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/hairdressers/:id/notes/:noteId error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/hairdressers/:id/activity ───────────────────────────────────────
// Return activity log for a hairdresser
router.get('/:id/activity', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM hairdresser_activity_log
       WHERE hairdresser_id = $1
       ORDER BY created_at DESC`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/hairdressers/:id/activity error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Utility: format a date string as "2026, JAN. 1" for activity log ─────────
function formatPeriodDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  return `${year}, ${month}. ${day}`;
}

module.exports = router;