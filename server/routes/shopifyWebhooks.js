// Shopify app webhooks (2026-11-12, Hera — Employee Discount,
// claude/EMPLOYEE_DISCOUNT.md). Subscribed in shopify-app/shopify.app.toml:
//   orders/paid · orders/cancelled · refunds/create
//   → https://hera-inventory.onrender.com/webhooks/shopify
// When the order belongs to an active employee, Hub recounts her season
// spend and updates the customer metafield the discount Function reads, so
// her next checkout sees the new remaining cap.
// Mounted in index.js BEFORE express.json(): the HMAC is checked on the raw
// body with the app secret (header X-Shopify-Hmac-Sha256). Not under /api, so
// the session check there doesn't apply.
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

function validHmac(rawBody, header) {
  const secret = process.env.SHOPIFY_API_SECRET || '';
  if (!secret || !header) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

router.post('/', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!validHmac(raw, req.get('X-Shopify-Hmac-Sha256'))) return res.status(401).send('Bad HMAC');
  res.status(200).send('ok'); // answer at once; the work runs after

  const topic = String(req.get('X-Shopify-Topic') || '');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
  try {
    const employees = require('./employees');
    let customerId = body && body.customer && body.customer.id;
    if (!customerId && topic === 'refunds/create' && body.order_id) {
      const d = await employees.shopifyFetch(`/orders/${body.order_id}.json?fields=id,customer`);
      customerId = d && d.order && d.order.customer && d.order.customer.id;
    }
    if (!customerId) return;
    await sleep(3000); // let the order / refund show up in the orders list first
    const total = await employees.recomputeEmployeeSpend(customerId);
    if (total !== null) console.log(`[employee discount] ${topic}: customer ${customerId} season spend ${total}`);
  } catch (e) {
    console.error(`[shopify webhook] ${topic} failed:`, e.message);
  }
});

module.exports = router;
