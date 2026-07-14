/**
 * server/routes/employees.js
 */

const express = require('express');
const router  = express.Router();
const { pool }       = require('../database/init');
const { getSession } = require('../shopify');

const SHOPIFY_STORE = process.env.SHOP;
const EMPLOYEE_TAG  = 'employee';

// ─── Season helpers ───────────────────────────────────────────────────────────

function getSeason(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const s = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
  return `${y}-S${s}`;
}

function seasonDateRange(seasonStr) {
  const [year, sq] = seasonStr.split('-S');
  const y = parseInt(year, 10);
  const s = parseInt(sq, 10);
  const starts = [[1,1],[4,1],[7,1],[10,1]];
  const ends   = [[3,31],[6,30],[9,30],[12,31]];
  const [sm, sd] = starts[s - 1];
  const [em, ed] = ends[s - 1];
  return {
    start: new Date(`${y}-${String(sm).padStart(2,'0')}-${String(sd).padStart(2,'0')}T00:00:00Z`),
    end:   new Date(`${y}-${String(em).padStart(2,'0')}-${String(ed).padStart(2,'0')}T23:59:59Z`),
  };
}

function prevSeason(seasonStr) {
  const [year, sq] = seasonStr.split('-S');
  let y = parseInt(year, 10);
  let s = parseInt(sq, 10) - 1;
  if (s < 1) { s = 4; y -= 1; }
  return `${y}-S${s}`;
}

// ─── Shopify helper ───────────────────────────────────────────────────────────

async function shopifyFetch(path, options = {}) {
  const session = await getSession();
  if (!session || !session.accessToken) {
    throw new Error('No valid Shopify session');
  }
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': session.accessToken,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Connecteam helper ────────────────────────────────────────────────────────

async function connecteamFetch(path, options = {}) {
  const url = `https://api.connecteam.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY':    process.env.CONNECTEAM_API_KEY,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Connecteam ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Branch field lookup (cached) ─────────────────────────────────────────────

let _branchFieldId = null;

async function getBranchFieldId() {
  if (_branchFieldId !== null) return _branchFieldId;

  const data   = await connecteamFetch('/users/v1/custom-fields?limit=100');
  const fields = data?.data?.customFields || [];
  const field  = fields.find(f => f.name && f.name.toLowerCase() === 'branch');

  if (!field) throw new Error('Branch custom field not found in Connecteam');

  _branchFieldId = field.id;
  console.log(`[employees] Branch field ID resolved: ${_branchFieldId} (type: ${field.type})`);
  return _branchFieldId;
}

// ─── Branch extraction & normalisation ───────────────────────────────────────

const KNOWN_PREFIXES = ['MTL','OTT','CAL','QC','EDM'];

function extractBranches(customFields, branchFieldId) {
  if (!customFields || !branchFieldId) return [];
  const field = customFields.find(f => f.customFieldId === branchFieldId);
  if (!field || field.value === null || field.value === undefined) return [];

  const val = field.value;

  // Dropdown: array of { id, value } objects
  if (Array.isArray(val)) {
    return val.map(v => (typeof v === 'object' ? v.value : String(v))).filter(Boolean);
  }

  // String: possibly comma-separated
  if (typeof val === 'string') {
    return val.split(',').map(s => s.trim()).filter(Boolean);
  }

  return [];
}

function normalizeBranches(rawBranches) {
  return rawBranches.map(b => {
    const upper = b.toUpperCase().trim();
    if (upper === 'HQ') return 'HQ';
    return KNOWN_PREFIXES.some(p => upper.startsWith(p)) ? upper : 'HQ';
  });
}

// ─── Shopify tag management ───────────────────────────────────────────────────

async function updateShopifyEmployeeTag(customerId, addTag) {
  const data     = await shopifyFetch(`/customers/${customerId}.json`);
  const customer = data.customer;
  if (!customer) throw new Error(`Customer ${customerId} not found`);

  const current = customer.tags
    ? customer.tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  let next;
  if (addTag) {
    if (current.includes(EMPLOYEE_TAG)) return;
    next = [...current, EMPLOYEE_TAG];
  } else {
    next = current.filter(t => t !== EMPLOYEE_TAG);
    if (next.length === current.length) return;
  }

  await shopifyFetch(`/customers/${customerId}.json`, {
    method: 'PUT',
    body:   JSON.stringify({ customer: { id: customerId, tags: next.join(', ') } }),
  });
}

/**
 * Find a Shopify customer by exact email using /customers.json?email=
 * This is more reliable than /customers/search.json which uses full-text search.
 * Returns the customer object or null.
 */
async function findShopifyCustomerByEmail(email) {
  const data      = await shopifyFetch(
    `/customers.json?email=${encodeURIComponent(email)}&limit=1`
  );
  const customers = data.customers || [];
  return customers.length > 0 ? customers[0] : null;
}

/**
 * Create a new Shopify customer with the given name and email.
 * Returns the created customer object.
 */
async function createShopifyCustomer(name, email) {
  const parts     = name.trim().split(' ');
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ') || '';

  const data = await shopifyFetch('/customers.json', {
    method: 'POST',
    body:   JSON.stringify({
      customer: {
        first_name:            firstName,
        last_name:             lastName,
        email:                 email,
        verified_email:        true,
        send_email_welcome:    false,
      },
    }),
  });

  return data.customer;
}

// ─── Core upsert ─────────────────────────────────────────────────────────────

/**
 * Upsert an employee from Connecteam user data.
 *
 * shopify_customer_id resolution order:
 *   1. If already in DB → keep it, never overwrite with null
 *   2. If not in DB and email exists → look up by exact email in Shopify
 *   3. If still not found → create a new Shopify customer
 *   4. No email → leave shopify_customer_id as null
 */
async function upsertEmployee(connecteamUser, branchFieldId, opts = {}) {
  const { forceStatus } = opts;

  const rawBranches = extractBranches(connecteamUser.customFields, branchFieldId);
  const branches    = normalizeBranches(rawBranches);
  const status      = forceStatus ?? (connecteamUser.isArchived ? 'archived' : 'active');
  const name        = `${connecteamUser.firstName || ''} ${connecteamUser.lastName || ''}`.trim();
  const email       = connecteamUser.email || null;
  const ctUserId    = String(connecteamUser.userId);

  // Always prefer the existing shopify_customer_id from the DB
  const existing        = await pool.query(
    'SELECT id, shopify_customer_id FROM employees WHERE connecteam_user_id = $1',
    [ctUserId]
  );
  const existingShopifyId = existing.rows[0]?.shopify_customer_id || null;
  let   shopifyCustomerId = existingShopifyId;

  // Only attempt Shopify lookup/creation if we don't already have an ID
  if (!shopifyCustomerId && email) {
    try {
      // 1. Try exact email lookup first
      const sc = await findShopifyCustomerByEmail(email);
      if (sc) {
        shopifyCustomerId = String(sc.id);
        console.log(`[sync] Found Shopify customer for ${email}: ${shopifyCustomerId}`);
      } else {
        // 2. Not found — create a new customer
        const created = await createShopifyCustomer(name, email);
        shopifyCustomerId = String(created.id);
        console.log(`[sync] Created Shopify customer for ${email}: ${shopifyCustomerId}`);
      }
    } catch (e) {
      // Do NOT set shopifyCustomerId to null — leave it as is (null or existing)
      console.warn(`upsertEmployee: Shopify lookup/create failed for ${email}:`, e.message);
    }
  }

  // Upsert employee — never overwrite an existing shopify_customer_id with null
  await pool.query(`
    INSERT INTO employees
      (connecteam_user_id, name, email, branches, status, shopify_customer_id, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (connecteam_user_id) DO UPDATE SET
      name                = EXCLUDED.name,
      email               = EXCLUDED.email,
      branches            = EXCLUDED.branches,
      status              = EXCLUDED.status,
      shopify_customer_id = COALESCE(employees.shopify_customer_id, EXCLUDED.shopify_customer_id),
      updated_at          = NOW()
  `, [ctUserId, name, email, branches, status, shopifyCustomerId]);

  // Manage Shopify employee tag
  if (shopifyCustomerId) {
    try {
      await updateShopifyEmployeeTag(shopifyCustomerId, status === 'active');
    } catch (e) {
      console.warn(`upsertEmployee: tag update failed for ${shopifyCustomerId}:`, e.message);
    }
  }
}

// ─── Purchase refresh ─────────────────────────────────────────────────────────

async function fetchCustomerPurchaseTotal(shopifyCustomerId, startDate, endDate, taxMode) {
  let total = 0;
  const url = `/orders.json?customer_id=${shopifyCustomerId}&status=any`
    + `&created_at_min=${startDate.toISOString()}`
    + `&created_at_max=${endDate.toISOString()}`
    + `&limit=250&fields=subtotal_price,total_price,current_subtotal_price,current_total_price,financial_status`;

  const data   = await shopifyFetch(url);
  const orders = data.orders || [];

  for (const order of orders) {
    if (!['paid','partially_refunded'].includes(order.financial_status)) continue;
    // 用 current_* 字段（退货/换货/编辑后的实际净额），而非订单原始金额，
    // 否则已退货但未产生 refund（如 exchange）的商品会被重复计入。
    // ?? 做兜底：极少数情况下 Shopify 未返回 current_* 字段时，退回原始金额。
    const amount = taxMode === 'before_tax'
      ? parseFloat(order.current_subtotal_price ?? order.subtotal_price ?? 0)
      : parseFloat(order.current_total_price   ?? order.total_price   ?? 0);
    total += amount;
  }

  return Math.round(total * 100) / 100;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/employees/settings
router.get('/settings', async (req, res) => {
  try {
    const result   = await pool.query(`SELECT key, value FROM employee_settings`);
    const settings = {};
    for (const row of result.rows) settings[row.key] = row.value;
    res.json(settings);
  } catch (e) {
    console.error('GET /employees/settings:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/employees/settings
router.put('/settings', async (req, res) => {
  const { cap_amount, cap_tax_mode } = req.body;
  try {
    if (cap_amount !== undefined) {
      await pool.query(`
        INSERT INTO employee_settings (key, value, updated_at)
        VALUES ('cap_amount', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [JSON.stringify({ value: Number(cap_amount) })]);
    }
    if (cap_tax_mode !== undefined) {
      await pool.query(`
        INSERT INTO employee_settings (key, value, updated_at)
        VALUES ('cap_tax_mode', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [JSON.stringify({ value: cap_tax_mode })]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /employees/settings:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/employees/sync
router.post('/sync', async (req, res) => {
  try {
    const branchFieldId = await getBranchFieldId();
    let offset = 0;
    let synced = 0;

    while (true) {
      const data  = await connecteamFetch(`/users/v1/users?limit=500&offset=${offset}&userStatus=all`);
      const users = data?.data?.users || [];
      if (users.length === 0) break;

      for (const user of users) {
        try {
          await upsertEmployee(user, branchFieldId);
          synced++;
        } catch (e) {
          console.warn(`sync: failed for user ${user.userId}:`, e.message);
        }
      }

      if (users.length < 500) break;
      offset += 500;
    }

    res.json({ ok: true, synced });
  } catch (e) {
    console.error('POST /employees/sync:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/employees/count
router.get('/count', async (req, res) => {
  try {
    const { branch } = req.query;
    let q, params;
    if (branch) {
      q      = `SELECT COUNT(*) FROM employees WHERE status = 'active' AND branches @> ARRAY[$1]::TEXT[]`;
      params = [branch];
    } else {
      q      = `SELECT COUNT(*) FROM employees WHERE status = 'active'`;
      params = [];
    }
    const result = await pool.query(q, params);
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (e) {
    console.error('GET /employees/count:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/employees
router.get('/', async (req, res) => {
  try {
    const {
      season   = 'current',
      branches = 'ALL',
      status   = 'all',
      page     = 1,
      per_page = 50,
    } = req.query;

    const currentSeason = getSeason(new Date());
    const targetSeason  = season === 'last' ? prevSeason(currentSeason) : currentSeason;

    const settingsRes = await pool.query(
      `SELECT value FROM employee_settings WHERE key = 'cap_amount'`
    );
    const capAmount = settingsRes.rows[0]?.value?.value ?? 600;

    const conditions = [`emp.status = 'active'`];
    const params     = [targetSeason];

    if (branches !== 'ALL') {
      const branchList = branches.split(',').map(b => b.trim()).filter(Boolean);
      params.push(branchList);
      conditions.push(`emp.branches && $${params.length}::TEXT[]`);
    }

    if (status === 'exceeded') {
      conditions.push(`COALESCE(ep.total_amount, 0) > ${Number(capAmount)}`);
    }

    const where  = conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(per_page);
    params.push(Number(per_page), offset);

    const dataQ = `
      SELECT
        emp.id,
        emp.connecteam_user_id,
        emp.name,
        emp.email,
        emp.branches,
        emp.status,
        emp.shopify_customer_id,
        COALESCE(ep.total_amount, 0) AS total_amount,
        ep.last_refreshed_at
      FROM employees emp
      LEFT JOIN employee_purchases ep
        ON ep.employee_id = emp.id AND ep.season = $1
      WHERE ${where}
      ORDER BY emp.name ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const countParams = params.slice(0, params.length - 2);
    const countQ = `
      SELECT COUNT(*)
      FROM employees emp
      LEFT JOIN employee_purchases ep
        ON ep.employee_id = emp.id AND ep.season = $1
      WHERE ${where}
    `;

    const [rows, countRow] = await Promise.all([
      pool.query(dataQ, params),
      pool.query(countQ, countParams),
    ]);

    res.json({
      employees:  rows.rows,
      total:      parseInt(countRow.rows[0].count, 10),
      cap_amount: capAmount,
      season:     targetSeason,
      page:       Number(page),
      per_page:   Number(per_page),
    });
  } catch (e) {
    console.error('GET /employees:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/employees/tag-check
router.post('/tag-check', async (req, res) => {
  try {
    const dbResult     = await pool.query(
      `SELECT email FROM employees WHERE status = 'active' AND email IS NOT NULL`
    );
    const activeEmails = new Set(dbResult.rows.map(r => r.email.toLowerCase()));

    const unexpected = [];
    const data       = await shopifyFetch(
      `/customers/search.json?query=tag:${EMPLOYEE_TAG}&limit=250&fields=id,first_name,last_name,email`
    );
    const customers = data.customers || [];

    for (const c of customers) {
      const email = (c.email || '').toLowerCase();
      if (!activeEmails.has(email)) {
        unexpected.push({
          shopify_customer_id: String(c.id),
          name:  `${c.first_name || ''} ${c.last_name || ''}`.trim(),
          email: c.email || '',
        });
      }
    }

    res.json({ unexpected });
  } catch (e) {
    console.error('POST /employees/tag-check:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/employees/refresh
router.post('/refresh', async (req, res) => {
  const { scope = 'all' } = req.body;
  try {
    const settingsRes = await pool.query(
      `SELECT key, value FROM employee_settings WHERE key = 'cap_tax_mode'`
    );
    const taxMode = settingsRes.rows[0]?.value?.value || 'before_tax';

    let empQuery, empParams;
    if (scope === 'all') {
      empQuery  = `SELECT id, shopify_customer_id FROM employees WHERE status = 'active' AND shopify_customer_id IS NOT NULL`;
      empParams = [];
    } else {
      empQuery  = `SELECT id, shopify_customer_id FROM employees WHERE status = 'active' AND shopify_customer_id IS NOT NULL AND branches @> ARRAY[$1]::TEXT[]`;
      empParams = [scope];
    }

    const empResult = await pool.query(empQuery, empParams);
    const employees = empResult.rows;

    const currentSeason = getSeason(new Date());
    const seasons       = [currentSeason, prevSeason(currentSeason)];
    let   refreshed     = 0;

    for (const emp of employees) {
      for (const season of seasons) {
        try {
          const { start, end } = seasonDateRange(season);
          const total = await fetchCustomerPurchaseTotal(
            emp.shopify_customer_id, start, end, taxMode
          );
          await pool.query(`
            INSERT INTO employee_purchases (employee_id, season, total_amount, last_refreshed_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (employee_id, season) DO UPDATE SET
              total_amount      = EXCLUDED.total_amount,
              last_refreshed_at = NOW()
          `, [emp.id, season, total]);
        } catch (e) {
          console.warn(`refresh: emp ${emp.id} season ${season}:`, e.message);
        }
      }
      refreshed++;
    }

    const settingKey = scope === 'all' ? 'last_refresh_all' : `last_refresh_${scope}`;
    await pool.query(`
      INSERT INTO employee_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [settingKey, JSON.stringify({ refreshed_at: new Date().toISOString() })]);

    res.json({ ok: true, refreshed, scope });
  } catch (e) {
    console.error('POST /employees/refresh:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Re-link ──────────────────────────────────────────────────────────────────

/**
 * POST /api/employees/relink
 * For every active employee with an email, re-query Shopify by exact email
 * and update shopify_customer_id if it has changed or was missing.
 * Safe to run at any time — does not touch Connecteam data.
 */
router.post('/relink', async (req, res) => {
  try {
    const result    = await pool.query(
      `SELECT id, name, email, shopify_customer_id FROM employees WHERE status = 'active' AND email IS NOT NULL`
    );
    const employees = result.rows;

    let updated = 0;
    let skipped = 0;
    let failed  = 0;

    for (const emp of employees) {
      try {
        const sc = await findShopifyCustomerByEmail(emp.email);
        if (!sc) { skipped++; continue; }

        const newId = String(sc.id);
        if (newId === emp.shopify_customer_id) { skipped++; continue; }

        // ID has changed or was null — update it
        await pool.query(
          `UPDATE employees SET shopify_customer_id = $1, updated_at = NOW() WHERE id = $2`,
          [newId, emp.id]
        );

        // Re-apply employee tag with correct ID
        try {
          await updateShopifyEmployeeTag(newId, true);
        } catch (e) {
          console.warn(`relink: tag update failed for ${newId}:`, e.message);
        }

        console.log(`[relink] ${emp.name} (${emp.email}): ${emp.shopify_customer_id || 'null'} → ${newId}`);
        updated++;
      } catch (e) {
        console.warn(`relink: failed for ${emp.email}:`, e.message);
        failed++;
      }
    }

    res.json({ ok: true, updated, skipped, failed });
  } catch (e) {
    console.error('POST /employees/relink:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Connecteam Webhook ───────────────────────────────────────────────────────

router.post('/webhook/connecteam', async (req, res) => {
  res.status(200).json({ received: true });

  const body      = req.body;
  const eventType = body?.eventType;
  if (!eventType) return;

  console.log(`[Connecteam Webhook] ${eventType}`);

  try {
    const branchFieldId = await getBranchFieldId();

    if (eventType === 'user_created' || eventType === 'user_updated') {
      const users = body?.data || [];
      for (const user of users) {
        if (!user.userId) continue;
        await upsertEmployee(user, branchFieldId);
      }
    }

    else if (eventType === 'user_archived') {
      const entries = body?.data || [];
      for (const entry of entries) {
        const userId = entry?.userId ?? entry;
        if (!userId) continue;
        const row = await pool.query(
          `SELECT id, shopify_customer_id FROM employees WHERE connecteam_user_id = $1`,
          [String(userId)]
        );
        if (row.rows.length === 0) continue;
        const emp = row.rows[0];
        await pool.query(
          `UPDATE employees SET status = 'archived', updated_at = NOW() WHERE id = $1`,
          [emp.id]
        );
        if (emp.shopify_customer_id) {
          try { await updateShopifyEmployeeTag(emp.shopify_customer_id, false); }
          catch (e) { console.warn('webhook archived tag:', e.message); }
        }
      }
    }

    else if (eventType === 'user_restored') {
      const entries = body?.data || [];
      for (const entry of entries) {
        const userId = entry?.userId ?? entry;
        if (!userId) continue;
        const row = await pool.query(
          `SELECT id, shopify_customer_id FROM employees WHERE connecteam_user_id = $1`,
          [String(userId)]
        );
        if (row.rows.length === 0) continue;
        const emp = row.rows[0];
        await pool.query(
          `UPDATE employees SET status = 'active', updated_at = NOW() WHERE id = $1`,
          [emp.id]
        );
        if (emp.shopify_customer_id) {
          try { await updateShopifyEmployeeTag(emp.shopify_customer_id, true); }
          catch (e) { console.warn('webhook restored tag:', e.message); }
        }
      }
    }

  } catch (e) {
    console.error(`[Connecteam Webhook] ${eventType} error:`, e);
  }
});

module.exports = router;