/**
 * server/routes/employees.js
 */

const express = require('express');
const router  = express.Router();
const { pool }       = require('../database/init');
const { getSession } = require('../shopify');

const SHOPIFY_STORE = process.env.SHOP;
const EMPLOYEE_TAG  = 'employee';
// Employee Discount (2026-11-12) — Shopify discount + customer cap metafields.
const ED = require('../services/employeeDiscount');

// ─── Season helpers ───────────────────────────────────────────────────────────

// Seasons follow Toronto time (2026-11-12, Hera): was UTC, so an order on
// the evening of Dec 31 / Mar 31 / … (Toronto) fell into the next season. The
// employee discount Function decides the season by the shop's local date, so
// both must agree.
const SEASON_TZ = 'America/Toronto';

function torontoYMD(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SEASON_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

// The instant of 00:00 Toronto time on y-m-d.
function torontoMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 12);
  const p = new Intl.DateTimeFormat('en-US', { timeZone: SEASON_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  const offset = wall - guess; // Toronto − UTC, e.g. −5 h
  return new Date(Date.UTC(y, m - 1, d) - offset);
}

function getSeason(date) {
  const { y, m } = torontoYMD(date || new Date());
  const s = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
  return `${y}-S${s}`;
}

// start = 00:00 Toronto on the season's first day; end = 1 ms before the next
// season starts.
function seasonDateRange(seasonStr) {
  const [year, sq] = seasonStr.split('-S');
  const y = parseInt(year, 10);
  const s = parseInt(sq, 10);
  const startMonth = [1, 4, 7, 10][s - 1];
  const start = torontoMidnight(y, startMonth, 1);
  const next  = s === 4 ? torontoMidnight(y + 1, 1, 1) : torontoMidnight(y, startMonth + 3, 1);
  return { start, end: new Date(next.getTime() - 1) };
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

/**
 * A qualifying employee discount is a discount_application on the order that matches
 * EITHER of the following two rules (union — matching either one qualifies):
 *
 * Rule 1 — Order-level manual percentage discount (original rule):
 *   - type === 'manual'            → manually added by the manager, not a discount code / automatic / script
 *   - value_type === 'percentage'  → a percentage-off discount, not a fixed-amount discount
 *   - target_selection === 'all'   → an ORDER-level discount applied to every line item,
 *                                    as opposed to a PRODUCT-level discount applied to select items only
 *   All three must hold simultaneously. The exact percentage value is NOT checked here.
 *
 * Rule 2 — Product-level manual percentage discount at a known employee-discount rate:
 *   - type === 'manual'
 *   - value_type === 'percentage'
 *   - target_selection !== 'all'   → applied to selected line items (cashier selects all cart items)
 *   - value is 18 or 20            → these two percentages are treated as employee-discount signatures
 *
 * Note: this function is only ever evaluated against orders already scoped to a single
 * employee's shopify_customer_id (see fetchCustomerPurchaseTotal), so there is no risk of
 * picking up non-employee customers' orders here — only which of an employee's own orders count.
 */
function hasEmployeeDiscount(order) {
  const apps = order.discount_applications || [];
  return apps.some(app => {
    // Rule 3 (2026-11-12): Hub's automatic "Employee Discount" (Shopify
    // discount Function) — any value, it may be a fixed amount when only part
    // of the order was under the cap.
    if (app.title === ED.TITLE && app.type !== 'manual') return true;

    if (app.type !== 'manual' || app.value_type !== 'percentage') return false;

    // Rule 1: order-level discount, any percentage value
    if (app.target_selection === 'all') return true;

    // Rule 2: product-level discount, but only 18% or 20% counts as an employee discount
    const pct = parseFloat(app.value);
    return pct === 18 || pct === 20;
  });
}

// Amount of one order that counts toward the cap (2026-11-12, Hera): the
// price BEFORE discounts and before tax, gift cards left out, returns taken
// off — Σ line price × quantity still kept. (Was the order's subtotal after
// discounts, before or after tax per the "cap_tax_mode" setting, which is no
// longer used.)
function capAmountOfOrder(order) {
  const refunded = {};
  for (const r of order.refunds || []) {
    for (const rl of r.refund_line_items || []) {
      refunded[rl.line_item_id] = (refunded[rl.line_item_id] || 0) + Number(rl.quantity || 0);
    }
  }
  let sum = 0;
  for (const li of order.line_items || []) {
    if (li.gift_card) continue;
    const qty = li.current_quantity != null
      ? Number(li.current_quantity)
      : Math.max(0, Number(li.quantity || 0) - (refunded[li.id] || 0));
    sum += parseFloat(li.price || 0) * qty;
  }
  return sum;
}

async function fetchCustomerPurchaseTotal(shopifyCustomerId, startDate, endDate) {
  let total = 0;
  const url = `/orders.json?customer_id=${shopifyCustomerId}&status=any`
    + `&created_at_min=${startDate.toISOString()}`
    + `&created_at_max=${endDate.toISOString()}`
    + `&limit=250&fields=subtotal_price,total_price,current_subtotal_price,current_total_price,financial_status,discount_applications,line_items,refunds`;

  const data   = await shopifyFetch(url);
  const orders = data.orders || [];

  for (const order of orders) {
    if (!['paid','partially_refunded'].includes(order.financial_status)) continue;
    // 只统计使用了店长手动添加的整单18%折扣的订单；未使用该折扣的订单一律排除。
    if (!hasEmployeeDiscount(order)) continue;
    // 用 current_* 字段（退货/换货/编辑后的实际净额），而非订单原始金额，
    // 否则已退货但未产生 refund（如 exchange）的商品会被重复计入。
    // ?? 做兜底：极少数情况下 Shopify 未返回 current_* 字段时，退回原始金额。
    // (Was current_subtotal_price / current_total_price by cap_tax_mode —
    // replaced 2026-11-12 by the price before discounts, see capAmountOfOrder.)
    total += capAmountOfOrder(order);
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
// (cap_tax_mode is no longer accepted — the cap always counts the price
// before discounts and tax, 2026-11-12.)
router.put('/settings', async (req, res) => {
  const { cap_amount } = req.body;
  try {
    if (cap_amount !== undefined) {
      await pool.query(`
        INSERT INTO employee_settings (key, value, updated_at)
        VALUES ('cap_amount', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [JSON.stringify({ value: Number(cap_amount) })]);
    }
    // A new cap goes to the Shopify discount's settings too (2026-11-12).
    let warning = null;
    if (cap_amount !== undefined) {
      try {
        const s = await ED.getDiscountSettings();
        if (s.discountId) await ED.syncDiscount();
      } catch (e) { warning = `Saved, but the Shopify discount was not updated: ${e.message}`; }
    }
    res.json({ ok: true, warning });
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

// POST /api/employees/refresh — body { scope: 'all' } (Operation › Employee Cap).
// 2026-11-13 (Hera): the one-store refresh (scope = a store code, used only by
// Store › Employee Cap) was removed with that page; any other scope is refused.
router.post('/refresh', async (req, res) => {
  const { scope = 'all' } = req.body;
  if (scope !== 'all') return res.status(400).json({ error: 'Only a full refresh (scope "all") is supported.' });
  try {
    const empQuery  = `SELECT id, shopify_customer_id FROM employees WHERE status = 'active' AND shopify_customer_id IS NOT NULL`;
    const empParams = [];

    const empResult = await pool.query(empQuery, empParams);
    const employees = empResult.rows;

    const currentSeason = getSeason(new Date());
    const seasons       = [currentSeason, prevSeason(currentSeason)];
    let   refreshed     = 0;
    const capRows       = []; // this season's spend → customer metafields (Employee Discount)

    for (const emp of employees) {
      for (const season of seasons) {
        try {
          const { start, end } = seasonDateRange(season);
          const total = await fetchCustomerPurchaseTotal(
            emp.shopify_customer_id, start, end
          );
          if (season === currentSeason) capRows.push({ customerId: emp.shopify_customer_id, season, spent: total });
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

    // Employee Discount: the discount Function reads each employee's spend
    // from her customer metafield (2026-11-12).
    let warning = null;
    try { await ED.writeCapMetafields(capRows); }
    catch (e) { warning = `Spend refreshed, but it could not be sent to Shopify for the discount: ${e.message}`; }

    res.json({ ok: true, refreshed, scope, warning });
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

// ─── Employee Discount (2026-11-12, Hera — claude/EMPLOYEE_DISCOUNT.md) ──────

// GET /api/employees/discount → { enabled, rate, combine, cap, discountId, shopifyStatus, error }
router.get('/discount', async (req, res) => {
  try {
    const s = await ED.getDiscountSettings();
    let shopifyStatus = null;
    let error = null;
    try { const d = await ED.readDiscount(s.discountId); shopifyStatus = d ? d.status : null; }
    catch (e) { error = e.message; }
    res.json({ ...s, shopifyStatus, error });
  } catch (e) {
    console.error('GET /employees/discount:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/employees/discount { enabled?, rate?, combine? } — saved in Hub,
// then the Shopify discount is created / updated / turned on or off.
router.put('/discount', async (req, res) => {
  try {
    await ED.saveDiscountSettings(req.body || {});
    let sync = null;
    let error = null;
    try { sync = await ED.syncDiscount(); } catch (e) { error = e.message; }
    const s = await ED.getDiscountSettings();
    res.json({ ...s, shopifyStatus: sync ? sync.status : null, error });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('PUT /employees/discount:', e);
    res.status(500).json({ error: e.message });
  }
});

// Recount one customer's spend of the current season (if she is an active
// employee) and send it to her customer metafield. Called by the Shopify
// order webhooks (routes/shopifyWebhooks.js). Returns the new total or null.
async function recomputeEmployeeSpend(shopifyCustomerId) {
  if (!shopifyCustomerId) return null;
  const r = await pool.query(
    `SELECT id, shopify_customer_id FROM employees WHERE shopify_customer_id = $1 AND status = 'active' LIMIT 1`,
    [String(shopifyCustomerId)]
  );
  const emp = r.rows[0];
  if (!emp) return null;
  const season = getSeason(new Date());
  const { start, end } = seasonDateRange(season);
  const total = await fetchCustomerPurchaseTotal(emp.shopify_customer_id, start, end);
  await pool.query(`
    INSERT INTO employee_purchases (employee_id, season, total_amount, last_refreshed_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (employee_id, season) DO UPDATE SET
      total_amount      = EXCLUDED.total_amount,
      last_refreshed_at = NOW()
  `, [emp.id, season, total]);
  await ED.writeCapMetafields([{ customerId: emp.shopify_customer_id, season, spent: total }]);
  return total;
}

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

    // Archived / restored events carry only the id: data = [{ "id": 9063791 }]
    // (Connecteam docs, users webhook). Until 2026-11-12 this read
    // entry.userId, which those events don't have, so every archive / restore
    // was silently ignored — archived staff stayed active with the employee tag.
    else if (eventType === 'user_archived') {
      const entries = Array.isArray(body?.data) ? body.data : [];
      for (const entry of entries) {
        const userId = entry?.id ?? entry?.userId ?? (typeof entry === 'object' ? null : entry);
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
      const entries = Array.isArray(body?.data) ? body.data : [];
      for (const entry of entries) {
        const userId = entry?.id ?? entry?.userId ?? (typeof entry === 'object' ? null : entry);
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
module.exports.recomputeEmployeeSpend = recomputeEmployeeSpend; // Shopify order webhooks (2026-11-12)
module.exports.shopifyFetch = shopifyFetch;