// server/routes/birthday.js
// ─────────────────────────────────────────────────────────────
// 单一端点：POST /birthday/claim-tag
//   由 Netlify 函数 claim.js 调用，顾客点击生日邮件按钮后触发。
//   职责：验证 shared secret → 给顾客加 birthday_campaign tag →
//        在 birthday_campaign_log 写入记录（含到期时间）。
//   tag 的移除由 birthdayScheduler.js 的 Remove Job 自动处理。
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { pool } = require('../database/init');
const { getSession, getShopify } = require('../shopify');
const { calcTagRemoveAt } = require('../jobs/birthdayScheduler');

// Netlify 调用时携带的 shared secret，从环境变量读取（不得硬编码）
const BIRTHDAY_APP_SECRET = process.env.BIRTHDAY_APP_SECRET;

// ── 工具函数 ─────────────────────────────────────────────────

// 比较两个 secret，使用 timingSafeEqual 防止时序攻击
function verifySecret(provided) {
  if (!BIRTHDAY_APP_SECRET) {
    console.warn('[Birthday] BIRTHDAY_APP_SECRET 未设置，拒绝所有请求');
    return false;
  }
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(BIRTHDAY_APP_SECRET, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function getClient() {
  const session = await getSession();
  if (!session) throw new Error('未找到 Shopify session');
  const shopify = getShopify();
  return new shopify.clients.Graphql({ session });
}

// 给顾客加 tag（若已存在则跳过）
async function addTagToCustomer(client, customerId, tag) {
  const fetchRes = await client.request(
    `query getCustomerTags($id: ID!) {
       customer(id: $id) { tags email }
     }`,
    { variables: { id: customerId } }
  );
  const customer = fetchRes?.data?.customer;
  if (!customer) throw new Error(`找不到顾客 ${customerId}`);

  const existingTags = customer.tags || [];
  const email = customer.email || null;

  if (existingTags.includes(tag)) {
    console.log(`[Birthday] 顾客 ${customerId} 已有 tag "${tag}"，跳过加 tag`);
    return { email, alreadyTagged: true };
  }

  const newTags = [...existingTags, tag];
  const updateRes = await client.request(
    `mutation customerUpdate($input: CustomerInput!) {
       customerUpdate(input: $input) {
         customer { id tags }
         userErrors { field message }
       }
     }`,
    { variables: { input: { id: customerId, tags: newTags } } }
  );
  const errors = updateRes?.data?.customerUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join(', '));

  return { email, alreadyTagged: false };
}

// ── 读取配置（用于计算到期时间） ──────────────────────────────

async function getConfig() {
  const result = await pool.query('SELECT * FROM birthday_config WHERE id = 1');
  return result.rows[0];
}

// ── POST /birthday/claim-tag ──────────────────────────────────

router.post('/claim-tag', express.json(), async (req, res) => {
  // 1. 验证 secret
  if (!verifySecret(req.headers['x-birthday-secret'])) {
    console.warn('[Birthday] claim-tag: secret 验证失败');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 2. 校验 body
  const { customerId, tag } = req.body || {};
  if (!customerId || !tag) {
    return res.status(400).json({ error: 'Missing customerId or tag' });
  }
  if (!/^gid:\/\/shopify\/Customer\/\d+$/.test(customerId)) {
    return res.status(400).json({ error: 'Invalid customerId format' });
  }

  try {
    // 3. 读取配置，确认总开关
    const config = await getConfig();
    if (!config || !config.enabled) {
      console.log('[Birthday] claim-tag: 系统已禁用，拒绝');
      return res.status(503).json({ error: 'Birthday system disabled' });
    }

    // 4. 加 tag
    const client = await getClient();
    const { email } = await addTagToCustomer(client, customerId, tag);

    // 5. 计算到期时间：领取时间 + tag_delay_hours，取那天的 remove_job 时间
    const tagAddedAt   = new Date();
    const tagRemoveAt  = calcTagRemoveAt(
      tagAddedAt,
      config.tag_delay_hours,
      config.remove_job_hour,
      config.remove_job_minute
    );

    // 6. 写入 log（同一顾客已有 pending 记录则不重复插入）
    const existing = await pool.query(
      `SELECT id FROM birthday_campaign_log
       WHERE customer_id = $1 AND status = 'pending'`,
      [customerId]
    );

    if (existing.rows.length > 0) {
      console.log(`[Birthday] claim-tag: 顾客 ${customerId} 已有 pending 记录，仅更新到期时间`);
      await pool.query(
        `UPDATE birthday_campaign_log
         SET tag_remove_at = $1, email = COALESCE($2, email)
         WHERE id = $3`,
        [tagRemoveAt, email, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO birthday_campaign_log
           (customer_id, email, tag_added_at, tag_remove_at, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [customerId, email, tagAddedAt, tagRemoveAt]
      );
    }

    console.log(`[Birthday] claim-tag: ✓ ${customerId} | tag=${tag} | 到期=${tagRemoveAt.toISOString()}`);
    return res.status(200).json({ ok: true, tagRemoveAt });
  } catch (err) {
    console.error('[Birthday] claim-tag 处理失败:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;