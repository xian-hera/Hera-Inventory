// server/routes/birthday.js
// ─────────────────────────────────────────────────────────────
// 接收 Shopify customers/update webhook
// 根据 email_subscribed + facts.birth_date 决定加入或移出
// birthday_subscribers 表
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { pool } = require('../database/init'); // 复用现有 pg pool

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ── 工具函数 ─────────────────────────────────────────────────

/**
 * 验证 Shopify Webhook HMAC 签名
 */
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

/**
 * 解析 facts.birth_date 格式 "2000-MM-DD"
 * 只取月和日，返回 { month, day } 或 null
 */
function parseBirthDate(value) {
  if (!value) return null;
  const match = String(value).match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const month = parseInt(match[1], 10);
  const day   = parseInt(match[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

/**
 * 从 customer payload 的 metafields 数组中找到 facts.birth_date 的值
 * Shopify webhook payload 中 metafields 格式：
 * [{ namespace, key, value, type }, ...]
 */
function extractBirthDate(customer) {
  const metafields = customer.metafields || [];
  const field = metafields.find(
    (m) => m.namespace === 'facts' && m.key === 'birth_date'
  );
  return field ? field.value : null;
}

// ── Webhook 端点 ──────────────────────────────────────────────

router.post(
  '/webhooks/customers-update',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const rawBody    = req.body; // Buffer，因为用了 express.raw

    // 1. 验证签名
    if (!verifyWebhookHmac(rawBody, hmacHeader)) {
      console.warn('[Birthday] Webhook HMAC 验证失败，已拒绝');
      return res.status(401).send('Unauthorized');
    }

    // 2. 解析 payload
    let customer;
    try {
      customer = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      console.error('[Birthday] Webhook payload 解析失败:', e.message);
      return res.status(400).send('Bad Request');
    }

    const customerId      = customer.admin_graphql_api_id;
    const email           = customer.email;
    const emailSubscribed = customer.email_marketing_consent?.state === 'subscribed';

    console.log(`[Birthday] Webhook 收到: customer ${customerId} | email_subscribed=${emailSubscribed}`);

    // 3. 检查生日 metafield
    const rawBirthDate = extractBirthDate(customer);
    const birthDate    = parseBirthDate(rawBirthDate);

    // 4. 决定加入或移出
    try {
      if (emailSubscribed && birthDate) {
        // 两个条件都满足 → upsert
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
        // 任一条件不满足 → 移出（不存在则忽略）
        const result = await pool.query(
          `DELETE FROM birthday_subscribers WHERE customer_id = $1`,
          [customerId]
        );
        if (result.rowCount > 0) {
          console.log(`[Birthday] 已移出订阅者: ${email || customerId} (原因: email_subscribed=${emailSubscribed}, birth_date=${rawBirthDate || '无'})`);
        }
      }
    } catch (err) {
      console.error('[Birthday] 数据库操作失败:', err.message);
      // 仍然返回 200，避免 Shopify 反复重试
    }

    // Shopify 要求在 5 秒内返回 200
    res.status(200).send('OK');
  }
);

module.exports = router;