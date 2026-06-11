// server/jobs/birthdayScheduler.js
// ─────────────────────────────────────────────────────────────
// Remove Tag Cron Job
// 每天在配置的时间运行，移除已到期的 birthday_campaign tag，
// 并在移除前拉取该顾客在 tag 期间的订单记录存入 birthday_orders 表
// ─────────────────────────────────────────────────────────────

const cron = require('node-cron');
const { pool } = require('../database/init');
const { getSession, getShopify } = require('../shopify');

const TIMEZONE = 'America/Toronto';

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

// ── 从 Shopify 移除 tag ───────────────────────────────────────

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

// ── 拉取顾客在指定时间段内的订单 ─────────────────────────────

async function fetchOrdersDuringTagPeriod(client, customerId, tagAddedAt, tagRemovedAt) {
  const orders = [];
  let cursor = null;
  const addedAtISO  = new Date(tagAddedAt).toISOString();
  const removedAtISO = new Date(tagRemovedAt).toISOString();

  // 用 created_at 过滤，拉取 tag 期间的订单
  const queryFilter = `customer_id:${customerId.replace('gid://shopify/Customer/', '')} created_at:>=${addedAtISO} created_at:<=${removedAtISO}`;

  do {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const res = await client.request(
      `query getOrders($query: String!) {
         orders(first: 50, query: $query${afterClause}) {
           pageInfo { hasNextPage endCursor }
           nodes {
             id
             name
             createdAt
             currentTotalPriceSet {
               shopMoney { amount currencyCode }
             }
             financialStatus
           }
         }
       }`,
      { variables: { query: queryFilter } }
    );

    const page = res?.data?.orders;
    if (!page) break;

    for (const order of page.nodes) {
      // 只记录已支付的订单
      if (['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.financialStatus)) {
        orders.push({
          orderId:    order.id,
          orderName:  order.name,
          createdAt:  order.createdAt,
          amount:     parseFloat(order.currentTotalPriceSet?.shopMoney?.amount || 0),
          currency:   order.currentTotalPriceSet?.shopMoney?.currencyCode || 'CAD',
        });
      }
    }

    if (page.pageInfo.hasNextPage) {
      cursor = page.pageInfo.endCursor;
    } else {
      break;
    }
  } while (true);

  return orders;
}

// ── 将订单记录写入 birthday_orders 表 ────────────────────────

async function saveOrderRecords(logId, customerId, orders) {
  for (const order of orders) {
    try {
      await pool.query(
        `INSERT INTO birthday_orders
           (log_id, customer_id, order_id, order_name, order_amount, currency, order_created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (order_id) DO NOTHING`,
        [logId, customerId, order.orderId, order.orderName, order.amount, order.currency, order.createdAt]
      );
    } catch (err) {
      console.error(`[Birthday] 保存订单 ${order.orderName} 失败:`, err.message);
    }
  }
}

// ── 计算 tag_remove_at ────────────────────────────────────────
// 领取时间 + delayHours 后，取那一天的 removeHour:removeMinute (Toronto 时区)
//
// 注意：蒙特利尔有夏令时 (EDT, UTC-4) 与冬令时 (EST, UTC-5) 之分，
// 这里用 Intl 动态计算目标当天的真实偏移量，避免写死偏移导致冬季偏差一小时。

function calcTagRemoveAt(tagAddedAt, delayHours, removeHour, removeMinute) {
  // 1. 领取时间 + delay，得到目标时刻
  const targetDate = new Date(new Date(tagAddedAt).getTime() + delayHours * 60 * 60 * 1000);

  // 2. 取该时刻在 Toronto 时区对应的“日历日期”(YYYY-MM-DD)
  const torontoStr = targetDate.toLocaleDateString('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [year, month, day] = torontoStr.split('-').map(Number);

  // 3. 计算 Toronto 在“那一天”相对 UTC 的真实偏移（自动区分夏/冬令时）
  const offsetMs = torontoOffsetMs(year, month, day, removeHour, removeMinute);

  // 4. 构造一个“看起来像 Toronto 本地时间”的 UTC 时间，再减去偏移得到真正的 UTC 时刻
  const asUtc = Date.UTC(year, month - 1, day, removeHour, removeMinute, 0);
  return new Date(asUtc - offsetMs);
}

// 计算给定本地时间在 America/Toronto 的 UTC 偏移（毫秒）。
// 正数表示该地领先 UTC（不可能为正），实际返回负值，如 EDT = -4h、EST = -5h。
function torontoOffsetMs(year, month, day, hour, minute) {
  // 先用该“本地时间”的数字构造一个临时 UTC 时间点
  const tentative = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  // 用 Intl 把这个时间点格式化成 Toronto 的钟面时间
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(tentative).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = parseInt(p.value, 10);
    return acc;
  }, {});
  // Toronto 钟面时间（作为 UTC 数值）与 tentative（同样作为 UTC 数值）之差即为偏移
  const asTorontoClock = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour % 24, parts.minute, parts.second
  );
  return asTorontoClock - tentative.getTime();
}

// ── Remove Tag Job ────────────────────────────────────────────

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
      `SELECT id, customer_id, tag_added_at, tag_remove_at
       FROM birthday_campaign_log
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
      // 1. 拉取该顾客在 tag 期间的订单
      console.log(`[Birthday] [Remove Job] 拉取顾客 ${record.customer_id} 的订单...`);
      const orders = await fetchOrdersDuringTagPeriod(
        client,
        record.customer_id,
        record.tag_added_at,
        record.tag_remove_at
      );
      console.log(`[Birthday] [Remove Job] 找到 ${orders.length} 笔订单`);

      // 2. 保存订单记录
      if (orders.length > 0) {
        await saveOrderRecords(record.id, record.customer_id, orders);
      }

      // 3. 移除 Shopify tag
      await removeTagFromCustomer(client, record.customer_id, tag);

      // 4. 更新 log 状态
      await pool.query(
        `UPDATE birthday_campaign_log
         SET status = 'removed', tag_removed_at = NOW()
         WHERE id = $1`,
        [record.id]
      );

      console.log(`[Birthday] [Remove Job] ✓ 处理完成: ${record.customer_id}`);
    } catch (err) {
      console.error(`[Birthday] [Remove Job] ✗ 处理 ${record.customer_id} 失败:`, err.message);
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
  if (removeTagTask) { removeTagTask.stop(); removeTagTask = null; }

  let config;
  try {
    config = await getConfig();
  } catch (err) {
    console.error('[Birthday] 读取配置失败，使用默认值:', err.message);
    config = { remove_job_hour: 23, remove_job_minute: 30 };
  }

  const removeCron = `${config.remove_job_minute} ${config.remove_job_hour} * * *`;

  removeTagTask = cron.schedule(removeCron, () => {
    runRemoveTagJob().catch((err) =>
      console.error('[Birthday] [Remove Job] 未捕获异常:', err.message)
    );
  }, { timezone: TIMEZONE });

  console.log(`[Birthday] Scheduler 已启动 (时区: ${TIMEZONE} | Remove: ${removeCron})`);
}

module.exports = { startBirthdayScheduler, calcTagRemoveAt };