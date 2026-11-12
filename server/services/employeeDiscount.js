// Employee Discount (2026-11-12, Hera — claude/EMPLOYEE_DISCOUNT.md).
//
// Hub side of the Shopify Discount Function "employee-discount"
// (shopify-app/extensions/employee-discount):
//   • the automatic app discount "Employee Discount" — created, updated,
//     activated and deactivated from Operation › Employee Cap. Its settings
//     (rate %, cap $) go to the discount's $app.function-configuration
//     metafield, which the Function reads;
//   • each employee's spend of the season → customer metafield
//     $app.employee_cap = { season, spent } (read by the Function).
// Settings in employee_settings (JSON { value }):
//   discount_enabled (bool) · discount_rate (number, default 18) ·
//   discount_combine (bool: combines with other discounts) ·
//   discount_id (the DiscountAutomaticNode gid once created) · cap_amount.

const { pool } = require('../database/init');
const { gql, userErrorText } = require('./shopifyGql');

const TITLE = 'Employee Discount';
const FUNCTION_HANDLE = 'employee-discount';
const CONFIG_KEY = 'function-configuration';
const CAP_KEY = 'employee_cap';

async function readSetting(key, fallback) {
  const r = await pool.query('SELECT value FROM employee_settings WHERE key = $1', [key]);
  const v = r.rows[0] && r.rows[0].value;
  return v && v.value !== undefined ? v.value : fallback;
}
async function writeSetting(key, value) {
  await pool.query(
    `INSERT INTO employee_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify({ value })]
  );
}

async function getDiscountSettings() {
  return {
    enabled: (await readSetting('discount_enabled', false)) === true,
    rate: Number(await readSetting('discount_rate', 18)) || 18,
    combine: (await readSetting('discount_combine', true)) === true,
    discountId: (await readSetting('discount_id', null)) || null,
    cap: Number(await readSetting('cap_amount', 600)) || 600,
  };
}

function discountInput(s) {
  return {
    title: TITLE,
    combinesWith: { orderDiscounts: s.combine, productDiscounts: s.combine, shippingDiscounts: s.combine },
    metafields: [{
      namespace: '$app', key: CONFIG_KEY, type: 'json',
      value: JSON.stringify({ rate: s.rate, cap: s.cap }),
    }],
  };
}

// The discount as Shopify has it now (null = it doesn't exist any more).
async function readDiscount(id) {
  if (!id) return null;
  const d = await gql(`query($id: ID!) {
    discountNode(id: $id) { id discount { __typename ... on DiscountAutomaticApp { title status } } }
  }`, { id });
  const node = d && d.discountNode;
  if (!node || !node.discount) return null;
  return { id: node.id, title: node.discount.title, status: node.discount.status };
}

async function createDiscount(s) {
  const run = async (fn) => {
    const d = await gql(`mutation($d: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $d) {
        automaticAppDiscount { discountId status }
        userErrors { field message }
      }
    }`, { d: { ...discountInput(s), ...fn, discountClasses: ['ORDER'], startsAt: new Date().toISOString() } });
    const p = d.discountAutomaticAppCreate;
    const err = userErrorText(p);
    if (err) throw new Error(err);
    return p.automaticAppDiscount.discountId;
  };
  try {
    return await run({ functionHandle: FUNCTION_HANDLE });
  } catch (e) {
    // Older API shape: find the function's id instead of its handle.
    if (!/functionHandle/i.test(e.message)) throw e;
    const f = await gql(`{ shopifyFunctions(first: 50) { nodes { id title apiType } } }`);
    const fn = ((f.shopifyFunctions && f.shopifyFunctions.nodes) || [])
      .find(n => n.title === TITLE && /discount/i.test(n.apiType || ''));
    if (!fn) throw new Error('The Employee Discount function is not deployed yet (run shopify app deploy).');
    return run({ functionId: fn.id });
  }
}

async function updateDiscount(id, s) {
  const d = await gql(`mutation($id: ID!, $d: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $d) {
      automaticAppDiscount { discountId status }
      userErrors { field message }
    }
  }`, { id, d: discountInput(s) });
  const err = userErrorText(d.discountAutomaticAppUpdate);
  if (err) throw new Error(err);
}

async function setActive(id, on) {
  const m = on ? 'discountAutomaticActivate' : 'discountAutomaticDeactivate';
  const d = await gql(`mutation($id: ID!) { ${m}(id: $id) { automaticDiscountNode { id } userErrors { field message } } }`, { id });
  const err = userErrorText(d[m]);
  if (err) throw new Error(err);
}

// Make Shopify match Hub's settings. Returns { status, discountId }.
//   enabled + no discount (or deleted in the admin) → create it
//   discount exists → update rate / cap / combining, then activate / deactivate
//   disabled + no discount → nothing to do
async function syncDiscount() {
  const s = await getDiscountSettings();
  let current = await readDiscount(s.discountId);
  if (!current) {
    if (!s.enabled) return { status: null, discountId: null };
    const id = await createDiscount(s);
    await writeSetting('discount_id', id);
    current = await readDiscount(id);
    return { status: current ? current.status : 'ACTIVE', discountId: id };
  }
  await updateDiscount(current.id, s);
  const active = current.status === 'ACTIVE';
  if (s.enabled && !active) await setActive(current.id, true);
  if (!s.enabled && active) await setActive(current.id, false);
  const after = await readDiscount(current.id);
  return { status: after ? after.status : null, discountId: current.id };
}

async function saveDiscountSettings({ enabled, rate, combine }) {
  if (enabled !== undefined) await writeSetting('discount_enabled', !!enabled);
  if (rate !== undefined) {
    const n = Number(rate);
    if (!Number.isFinite(n) || n <= 0 || n > 100) throw Object.assign(new Error('Rate must be between 0 and 100.'), { status: 400 });
    await writeSetting('discount_rate', Math.round(n * 100) / 100);
  }
  if (combine !== undefined) await writeSetting('discount_combine', !!combine);
}

// Customer metafields: [{ customerId, season, spent }] → $app.employee_cap.
// metafieldsSet takes at most 25 at a time.
async function writeCapMetafields(list) {
  const rows = list.filter(x => x.customerId);
  for (let i = 0; i < rows.length; i += 25) {
    const metafields = rows.slice(i, i + 25).map(x => ({
      ownerId: `gid://shopify/Customer/${x.customerId}`,
      namespace: '$app', key: CAP_KEY, type: 'json',
      value: JSON.stringify({ season: x.season, spent: Math.round(Number(x.spent || 0) * 100) / 100 }),
    }));
    const d = await gql(`mutation($m: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } }
    }`, { m: metafields });
    const err = userErrorText(d.metafieldsSet);
    if (err) throw new Error(err);
  }
}

module.exports = {
  TITLE, getDiscountSettings, saveDiscountSettings, syncDiscount, readDiscount, writeCapMetafields,
};
