// server/routes/birthday.js
// ─────────────────────────────────────────────────────────────
// 两个 Webhook 端点：
//   POST /webhooks/consent-update   — customers/email_marketing_consent_update
//   POST /webhooks/metafield-update — metafields/update
//
// 一个临时注册路由（用完即删）：
//   GET  /setup-webhooks            — 注册 metafields/update webhook
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { pool } = require('../database/init');
const { getSession, getShopify } = require('../shopify');

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ── 工具函数 ─────────────────────────────────────────────────

function verifyWebhookHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET) {
    console.warn('[Birthday] SHOPIFY_WEBHOOK_SECRET 未设置，跳过签名验证');
    return true;
  }
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || ''));
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

// ── Webhook 1：consent 变更 ───────────────────────────────────

router.post(
  '/webhooks/consent-update',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!verifyWebhookHmac(req.body, req.headers['x-shopify-hmac-sha256'])) {
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
      await syncSubscriber(customerId, customerData.email, emailSubscribed, customerData.metafield?.value || null);
    } catch (err) {
      console.error('[Birthday] consent-update 处理失败:', err.message);
    }
  }
);

// ── Webhook 2：metafield 变更 ─────────────────────────────────

router.post(
  '/webhooks/metafield-update',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!verifyWebhookHmac(req.body, req.headers['x-shopify-hmac-sha256'])) {
      console.warn('[Birthday] metafield-update: HMAC 验证失败');
      return res.status(401).send('Unauthorized');
    }
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      console.error('[Birthday] metafield-update: payload 解析失败:', e.message);
      return res.status(400).send('Bad Request');
    }
    res.status(200).send('OK');
    try {
      const { owner_resource, namespace, key, value, owner_id } = payload;
      if (owner_resource !== 'customer' || namespace !== 'facts' || key !== 'birth_date') return;
      const customerId = `gid://shopify/Customer/${owner_id}`;
      console.log(`[Birthday] metafield-update: ${customerId} | birth_date=${value}`);
      const customerData = await fetchConsentState(customerId);
      if (!customerData) {
        console.warn(`[Birthday] metafield-update: 找不到顾客 ${customerId}`);
        return;
      }
      const emailSubscribed = customerData.emailMarketingConsent?.marketingState === 'SUBSCRIBED';
      await syncSubscriber(customerId, customerData.email, emailSubscribed, value);
    } catch (err) {
      console.error('[Birthday] metafield-update 处理失败:', err.message);
    }
  }
);

// ── 临时路由：注册 metafields/update webhook ──────────────────
// 访问一次后请删除此路由

router.get('/setup-webhooks', async (req, res) => {
  try {
    const session = await getSession();
    if (!session) return res.status(401).json({ error: '未找到 Shopify session' });
    const shopify    = getShopify();
    const client     = new shopify.clients.Graphql({ session });
    const callbackUrl = `https://${process.env.HOST.replace(/https?:\/\//, '')}/api/birthday/webhooks/metafield-update`;
    const response = await client.request(
      `mutation createWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
         webhookSubscriptionCreate(
           topic: $topic
           webhookSubscription: { format: JSON, callbackUrl: $callbackUrl }
         ) {
           webhookSubscription { id }
           userErrors { field message }
         }
       }`,
      { variables: { topic: 'METAFIELDS_UPDATE', callbackUrl } }
    );
    const errors = response?.data?.webhookSubscriptionCreate?.userErrors || [];
    if (errors.length) return res.json({ success: false, errors });
    const webhookId = response?.data?.webhookSubscriptionCreate?.webhookSubscription?.id;
    console.log(`[Birthday] metafields/update webhook 注册成功: ${webhookId}`);
    res.json({ success: true, webhookId, callbackUrl });
  } catch (err) {
    console.error('[Birthday] setup-webhooks 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;