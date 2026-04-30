// server/jobs/birthdayScheduler.js
// ─────────────────────────────────────────────────────────────
// 两个 Cron Job，从 birthday_config 表读取配置，支持动态重启
// ─────────────────────────────────────────────────────────────

const cron = require('node-cron');
const { pool } = require('../database/init');
const { getSession, getShopify } = require('../shopify');

const TIMEZONE = 'America/Toronto';

let addTagTask    = null;
let removeTagTask = null;

// ── 读取配置 ──────────────────────────────────────────────────

async function getConfig() {
  const result = await pool.query('SELECT * FROM birthday_config WHERE id = 1');
  return result.rows[0];
}

// ── Shopify GraphQL client ────────────────────────────────────

async function getClient() {
  const session = await getSession();
  if (!session) throw new Error('未找到 Shopify session，请先完成 OAuth 授权');
  const shopify = getShopify();
  return new shopify.clients.Graphql({ session });
}

// ── Shopify GraphQL 工具函数 ──────────────────────────────────

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

// ── Job 1：添加 tag ───────────────────────────────────────────

async function runAddTagJob() {
  const config = await getConfig();
  if (!config.enabled || !config.add_job_enabled) {
    console.log('[Birthday] [Add Job] 已禁用，跳过');
    return;
  }

  const tag     = config.campaign_tag;
  const delayMs = config.tag_delay_hours * 60 * 60 * 1000;

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const month    = tomorrow.getMonth() + 1;
  const day      = tomorrow.getDate();

  console.log(`[Birthday] [Add Job] 开始执行 — 目标日期: ${month}月${day}日 | tag: ${tag}`);

  let subscribers;
  try {
    const result = await pool.query(
      `SELECT customer_id, email FROM birthday_subscribers
       WHERE birth_month = $1 AND birth_day = $2`,
      [month, day]
    );
    subscribers = result.rows;
  } catch (err) {
    console.error('[Birthday] [Add Job] 查询数据库失败:', err.message);
    return;
  }

  if (!subscribers.length) {
    console.log('[Birthday] [Add Job] 没有找到符合条件的顾客，结束');
    return;
  }

  console.log(`[Birthday] [Add Job] 找到 ${subscribers.length} 位顾客，开始添加 tag`);

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('[Birthday] [Add Job] 获取 Shopify client 失败:', err.message);
    return;
  }

  const tagRemoveAt = new Date(Date.now() + delayMs);

  for (const sub of subscribers) {
    try {
      await addTagToCustomer(client, sub.customer_id, tag);
      await pool.query(
        `INSERT INTO birthday_campaign_log
           (customer_id, email, tag_added_at, tag_remove_at, status)
         VALUES ($1, $2, NOW(), $3, 'pending')`,
        [sub.customer_id, sub.email, tagRemoveAt]
      );
      console.log(`[Birthday] [Add Job] ✓ 已添加 tag: ${sub.email}`);
    } catch (err) {
      console.error(`[Birthday] [Add Job] ✗ 处理 ${sub.email} 失败:`, err.message);
    }
  }

  console.log('[Birthday] [Add Job] 执行完毕');
}

// ── Job 2：移除 tag ───────────────────────────────────────────

async function runRemoveTagJob() {
  const config = await getConfig();
  if (!config.enabled || !config.remove_job_enabled) {
    console.log('[Birthday] [Remove Job] 已禁用，跳过');
    return;
  }

  const tag = config.campaign_tag;
  console.log('[Birthday] [Remove Job] 开始执行 — 扫描待移除 tag');

  let records;
  try {
    const result = await pool.query(
      `SELECT id, customer_id, email FROM birthday_campaign_log
       WHERE status = 'pending' AND tag_remove_at <= NOW()`
    );
    records = result.rows;
  } catch (err) {
    console.error('[Birthday] [Remove Job] 查询数据库失败:', err.message);
    return;
  }

  if (!records.length) {
    console.log('[Birthday] [Remove Job] 没有待移除的 tag，结束');
    return;
  }

  console.log(`[Birthday] [Remove Job] 找到 ${records.length} 条待移除记录`);

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('[Birthday] [Remove Job] 获取 Shopify client 失败:', err.message);
    return;
  }

  for (const record of records) {
    try {
      await removeTagFromCustomer(client, record.customer_id, tag);
      await pool.query(
        `UPDATE birthday_campaign_log
         SET status = 'removed', tag_removed_at = NOW()
         WHERE id = $1`,
        [record.id]
      );
      console.log(`[Birthday] [Remove Job] ✓ 已移除 tag: ${record.email}`);
    } catch (err) {
      console.error(`[Birthday] [Remove Job] ✗ 处理 ${record.email} 失败:`, err.message);
      await pool.query(
        `UPDATE birthday_campaign_log SET status = 'failed' WHERE id = $1`,
        [record.id]
      ).catch(() => {});
    }
  }

  console.log('[Birthday] [Remove Job] 执行完毕');
}

// ── 启动 / 重启 Scheduler ─────────────────────────────────────

async function startBirthdayScheduler() {
  if (addTagTask)    { addTagTask.stop();    addTagTask    = null; }
  if (removeTagTask) { removeTagTask.stop(); removeTagTask = null; }

  let config;
  try {
    config = await getConfig();
  } catch (err) {
    console.error('[Birthday] 读取配置失败，使用默认值:', err.message);
    config = {
      add_job_hour: 9, add_job_minute: 0,
      remove_job_hour: 23, remove_job_minute: 50,
    };
  }

  const addCron    = `${config.add_job_minute} ${config.add_job_hour} * * *`;
  const removeCron = `${config.remove_job_minute} ${config.remove_job_hour} * * *`;

  addTagTask = cron.schedule(addCron, () => {
    runAddTagJob().catch((err) =>
      console.error('[Birthday] [Add Job] 未捕获异常:', err.message)
    );
  }, { timezone: TIMEZONE });

  removeTagTask = cron.schedule(removeCron, () => {
    runRemoveTagJob().catch((err) =>
      console.error('[Birthday] [Remove Job] 未捕获异常:', err.message)
    );
  }, { timezone: TIMEZONE });

  console.log(`[Birthday] Scheduler 已启动 (时区: ${TIMEZONE} | Add: ${addCron} / Remove: ${removeCron})`);
}

module.exports = { startBirthdayScheduler };