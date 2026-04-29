// server/routes/birthday.js
// ─────────────────────────────────────────────────────────────
// 两个 Webhook 端点：
//   POST /webhooks/customers-update — customers/update（GraphQL API 注册，用 SHOPIFY_API_SECRET 验签）
//   POST /webhooks/consent-update   — customers/email_marketing_consent_update（Admin UI 注册，用 SHOPIFY_WEBHOOK_SECRET 验签）
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { pool } = require('../database/init');
const { getSession, getShopify } = require('../shopify');

// GraphQL API 注册的 webhook → 用 App client secret 验签
const SHOPIFY_API_SECRET     = process.env.SHOPIFY_API_SECRET;
// Admin UI 手动注册的 webhook → 用 Notifications 页面的 signing secret 验签
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ── 工具函数 ─────────────────────────────────────────────────

function verifyHmac(rawBody, hmacHeader, secret) {
  if (!secret) {
    console.warn('[Birthday] 签名 secret 未设置，跳过验证');
    return true;
  }
  try {
    const digest = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'base64'),
      Buffer.from(hmacHeader || '', 'base64')
    );
  } catch {
    return false;
  }
}

function parseBirthDate(value) {
  if (!value) return null;
  const match = String(value).match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const month = parseInt(match[1], 10);
  const day   = parseInt(match[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

function extractBirthDateFromPayload(payload) {
  const metafields = payload.metafields || [];
  const field = metafields.find(
    (m) => m.namespace === 'facts' && m.key === 'birth_date'
  );
  return field ? field.value : null;
}

async function fetchBirthDate(customerId) {
  const session = await getSession();
  if (!session) throw new Error('未找到 Shopify session');
  const shopify = getShopify();
  const client  = new shopify.clients.Graphql({ session });
  const response = await client.request(
    `query getCustomerBirthDate($id: ID!) {
       customer(id: $id) {
         email
         metafield(namespace: "facts", key: "birth_date") { value }
       }
     }`,
    { variables: { id: customerId } }
  );
  return response?.data?.customer || null;
}

async function fetchConsentState(customerId) {
  const session = await getSession();
  if (!session) throw new Error('未找到 Shopify session');
  const shopify = getShopify();
  const client  = new shopify.clients.Graphql({ session });
  const response = await client.request(
    `query getCustomerConsent($id: ID!) {
       customer(id: $id) {
         email
         emailMarketingConsent { marketingState }
       }
     }`,
    { variables: { id: customerId } }
  );
  return response?.data?.customer || null;
}

async function syncSubscriber(customerId, email, emailSubscribed, rawBirthDate) {
  const birthDate = parseBirthDate(rawBirthDate);
  if (emailSubscribed && birthDate) {
    await pool.query(
      `INSERT INTO birthday_subscribers
         (customer_id, email, birth_month, birth_day, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (customer_id) DO UPDATE SET
         email       = EXCLUDED.email,
         birth_month = EXCLUDED.birth_month,
         birth_day   = EXCLUDED.birth_day,
         updated_at  = NOW()`,
      [customerId, email, birthDate.month, birthDate.day]
    );
    console.log(`[Birthday] Upserted 订阅者: ${email} (生日: ${birthDate.month}月${birthDate.day}日)`);
  } else {
    const result = await pool.query(
      `DELETE FROM birthday_subscribers WHERE customer_id = $1`,
      [customerId]
    );
    if (result.rowCount > 0) {
      console.log(`[Birthday] 已移出订阅者: ${email || customerId} (email_subscribed=${emailSubscribed}, birth_date=${rawBirthDate || '无'})`);
    }
  }
}

// ── Webhook 1：customers/update ───────────────────────────────
// GraphQL API 注册 → 用 SHOPIFY_API_SECRET 验签

router.post(
  '/webhooks/customers-update',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!verifyHmac(req.body, req.headers['x-shopify-hmac-sha256'], SHOPIFY_API_SECRET)) {
      console.warn('[Birthday] customers-update: HMAC 验证失败');
      return res.status(401).send('Unauthorized');
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      console.error('[Birthday] customers-update: payload 解析失败:', e.message);
      return res.status(400).send('Bad Request');
    }

    res.status(200).send('OK');

    try {
      const rawBirthDate = extractBirthDateFromPayload(payload);
      if (!rawBirthDate) return;

      const customerId = payload.admin_graphql_api_id;
      const email      = payload.email;
      console.log(`[Birthday] customers-update: ${customerId} | birth_date=${rawBirthDate}`);

      const customerData = await fetchConsentState(customerId);
      if (!customerData) {
        console.warn(`[Birthday] customers-update: 找不到顾客 ${customerId}`);
        return;
      }

      const emailSubscribed = customerData.emailMarketingConsent?.marketingState === 'SUBSCRIBED';
      await syncSubscriber(customerId, email || customerData.email, emailSubscribed, rawBirthDate);
    } catch (err) {
      console.error('[Birthday] customers-update 处理失败:', err.message);
    }
  }
);

// ── Webhook 2：customers/email_marketing_consent_update ───────
// Admin UI 注册 → 用 SHOPIFY_WEBHOOK_SECRET 验签

router.post(
  '/webhooks/consent-update',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!verifyHmac(req.body, req.headers['x-shopify-hmac-sha256'], SHOPIFY_WEBHOOK_SECRET)) {
      console.warn('[Birthday] consent-update: HMAC 验证失败');
      return res.status(401).send('Unauthorized');
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      console.error('[Birthday] consent-update: payload 解析失败:', e.message);
      return res.status(400).send('Bad Request');
    }

    res.status(200).send('OK');

    try {
      const customerId      = payload.admin_graphql_api_id;
      const marketingState  = payload.email_marketing_consent?.state || '';
      const emailSubscribed = marketingState.toUpperCase() === 'SUBSCRIBED';
      console.log(`[Birthday] consent-update: ${customerId} | state=${marketingState}`);

      const customerData = await fetchBirthDate(customerId);
      if (!customerData) {
        console.warn(`[Birthday] consent-update: 找不到顾客 ${customerId}`);
        return;
      }

      await syncSubscriber(
        customerId,
        customerData.email,
        emailSubscribed,
        customerData.metafield?.value || null
      );
    } catch (err) {
      console.error('[Birthday] consent-update 处理失败:', err.message);
    }
  }
);

module.exports = router;