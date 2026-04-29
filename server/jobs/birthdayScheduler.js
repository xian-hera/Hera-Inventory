// server/jobs/birthdayScheduler.js
// ─────────────────────────────────────────────────────────────
// 两个 Cron Job：
//   1. 每天 09:00 (Montreal) — 查找 24 小时后过生日的顾客，添加 birthday_campaign tag
//   2. 每天 23:50 (Montreal) — 扫描 log，移除到期的 birthday_campaign tag
// ─────────────────────────────────────────────────────────────

const cron = require('node-cron');
const { pool } = require('../database/init');
const { getSession, getShopify } = require('../shopify');

const TIMEZONE = 'America/Toronto'; // Montreal 与 Toronto 同时区

// ── Shopify GraphQL client ────────────────────────────────────

async function getClient() {
  const session = await getSession();
  if (!session) throw new Error('未找到 Shopify session，请先完成 OAuth 授权');
  const shopify = getShopify();
  return new shopify.clients.Graphql({ session });
}

// ── Shopify GraphQL 工具函数 ──────────────────────────────────

/**
 * 为顾客添加 tag
 * 先 fetch 现有 tags，再 append，避免覆盖其他 tag
 */
async function addTagToCustomer(client, customerId, tag) {
  const fetchRes = await client.request(
    `query getCustomerTags($id: ID!) {
       customer(id: $id) { tags }
     }`,
    { variables: { id: customerId } }
  );
  const existingTags = fetchRes?.data?.customer?.tags || [];

  if (existingTags.includes(tag)) {
    console.log(`[Birthday] 顾客 ${customerId} 已有 tag "${tag}"，跳过`);
    return;
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
}

/**
 * 为顾客移除 tag
 */
async function removeTagFromCustomer(client, customerId, tag) {
  const fetchRes = await client.request(
    `query getCustomerTags($id: ID!) {
       customer(id: $id) { tags }
     }`,
    { variables: { id: customerId } }
  );
  const existingTags = fetchRes?.data?.customer?.tags || [];

  if (!existingTags.includes(tag)) {
    console.log(`[Birthday] 顾客 ${customerId} 没有 tag "${tag}"，跳过`);
    return;
  }

  const newTags = existingTags.filter((t) => t !== tag);

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
}

// ── Job 1：每天 09:00 (Montreal) 添加 tag ─────────────────────

async function runAddTagJob() {
  console.log('[Birthday] [09:00 Job] 开始执行 — 查找 24 小时后过生日的顾客');

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const month    = tomorrow.getMonth() + 1;
  const day      = tomorrow.getDate();

  console.log(`[Birthday] [09:00 Job] 目标日期: ${month}月${day}日`);

  let subscribers;
  try {
    const result = await pool.query(
      `SELECT customer_id, email FROM birthday_subscribers
       WHERE birth_month = $1 AND birth_day = $2`,
      [month, day]
    );
    subscribers = result.rows;
  } catch (err) {
    console.error('[Birthday] [09:00 Job] 查询数据库失败:', err.message);
    return;
  }

  if (!subscribers.length) {
    console.log('[Birthday] [09:00 Job] 没有找到符合条件的顾客，结束');
    return;
  }

  console.log(`[Birthday] [09:00 Job] 找到 ${subscribers.length} 位顾客，开始添加 tag`);

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('[Birthday] [09:00 Job] 获取 Shopify client 失败:', err.message);
    return;
  }

  const tagRemoveAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

  for (const sub of subscribers) {
    try {
      await addTagToCustomer(client, sub.customer_id, 'birthday_campaign');

      await pool.query(
        `INSERT INTO birthday_campaign_log
           (customer_id, email, tag_added_at, tag_remove_at, status)
         VALUES ($1, $2, NOW(), $3, 'pending')`,
        [sub.customer_id, sub.email, tagRemoveAt]
      );

      console.log(`[Birthday] [09:00 Job] ✓ 已添加 tag: ${sub.email}`);
    } catch (err) {
      console.error(`[Birthday] [09:00 Job] ✗ 处理 ${sub.email} 失败:`, err.message);
    }
  }

  console.log('[Birthday] [09:00 Job] 执行完毕');
}

// ── Job 2：每天 23:50 (Montreal) 移除 tag ─────────────────────

async function runRemoveTagJob() {
  console.log('[Birthday] [23:50 Job] 开始执行 — 扫描待移除 tag');

  let records;
  try {
    const result = await pool.query(
      `SELECT id, customer_id, email FROM birthday_campaign_log
       WHERE status = 'pending' AND tag_remove_at <= NOW()`
    );
    records = result.rows;
  } catch (err) {
    console.error('[Birthday] [23:50 Job] 查询数据库失败:', err.message);
    return;
  }

  if (!records.length) {
    console.log('[Birthday] [23:50 Job] 没有待移除的 tag，结束');
    return;
  }

  console.log(`[Birthday] [23:50 Job] 找到 ${records.length} 条待移除记录`);

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('[Birthday] [23:50 Job] 获取 Shopify client 失败:', err.message);
    return;
  }

  for (const record of records) {
    try {
      await removeTagFromCustomer(client, record.customer_id, 'birthday_campaign');

      await pool.query(
        `UPDATE birthday_campaign_log
         SET status = 'removed', tag_removed_at = NOW()
         WHERE id = $1`,
        [record.id]
      );

      console.log(`[Birthday] [23:50 Job] ✓ 已移除 tag: ${record.email}`);
    } catch (err) {
      console.error(`[Birthday] [23:50 Job] ✗ 处理 ${record.email} 失败:`, err.message);

      await pool.query(
        `UPDATE birthday_campaign_log SET status = 'failed' WHERE id = $1`,
        [record.id]
      ).catch(() => {});
    }
  }

  console.log('[Birthday] [23:50 Job] 执行完毕');
}

// ── 注册 Cron ─────────────────────────────────────────────────

function startBirthdayScheduler() {
  cron.schedule('40 14 * * *', () => {
    runAddTagJob().catch((err) =>
      console.error('[Birthday] [09:00 Job] 未捕获异常:', err.message)
    );
  }, { timezone: TIMEZONE });

  cron.schedule('50 23 * * *', () => {
    runRemoveTagJob().catch((err) =>
      console.error('[Birthday] [23:50 Job] 未捕获异常:', err.message)
    );
  }, { timezone: TIMEZONE });

  console.log(`[Birthday] Scheduler 已启动 (时区: ${TIMEZONE} | 09:00 添加 tag / 23:50 移除 tag)`);
}

module.exports = { startBirthdayScheduler };