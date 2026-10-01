// server/routes/birthdayConfig.js
// ─────────────────────────────────────────────────────────────
// 读写 birthday_config 表（仅保留 Remove Job 相关配置），
// 并提供前端所需的数据查询端点：
//   GET    /api/birthday-config              读取配置
//   PATCH  /api/birthday-config              保存配置（保存后重启 scheduler）
//   GET    /api/birthday-config/active       当前持有 tag 的顾客列表
//   GET    /api/birthday-config/orders       tag 期间的消费记录（?range=30 | all）
//   DELETE /api/birthday-config/orders/purge 删除 365 天前的记录
//   GET    /api/birthday-config/failed-count 处理失败的记录数（2026-10-01）
//   POST   /api/birthday-config/retry-failed 把 failed 改回 pending，下次 Remove Job 重试（2026-10-01）
//   GET    /api/birthday-config/cleanup-stale-tags/preview  扫描过期 tag 数量（2026-10-01）
//   POST   /api/birthday-config/cleanup-stale-tags          后台清理过期 tag（2026-10-01）
//   GET    /api/birthday-config/cleanup-stale-tags/status   清理进度（2026-10-01）
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../database/init');

let _restartScheduler = null;

// 由 birthdayScheduler.js 注入重启函数
function registerRestartFn(fn) {
  _restartScheduler = fn;
}

// ── GET /api/birthday-config ──────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM birthday_config WHERE id = 1');
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[BirthdayConfig] GET 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/birthday-config ────────────────────────────────
// 仅接受：enabled, remove_job_enabled, remove_job_hour,
//        remove_job_minute, tag_delay_hours, campaign_tag

router.patch('/', async (req, res) => {
  const {
    enabled,
    remove_job_enabled,
    remove_job_hour,
    remove_job_minute,
    tag_delay_hours,
    campaign_tag,
  } = req.body;

  try {
    await pool.query(
      `UPDATE birthday_config SET
         enabled            = COALESCE($1, enabled),
         remove_job_enabled = COALESCE($2, remove_job_enabled),
         remove_job_hour    = COALESCE($3, remove_job_hour),
         remove_job_minute  = COALESCE($4, remove_job_minute),
         tag_delay_hours    = COALESCE($5, tag_delay_hours),
         campaign_tag       = COALESCE($6, campaign_tag),
         updated_at         = NOW()
       WHERE id = 1`,
      [
        enabled ?? null,
        remove_job_enabled ?? null,
        remove_job_hour ?? null,
        remove_job_minute ?? null,
        tag_delay_hours ?? null,
        campaign_tag ?? null,
      ]
    );

    // 通知 scheduler 重启以应用新配置（cron 时间可能变了）
    if (_restartScheduler) {
      await _restartScheduler();
    }

    const result = await pool.query('SELECT * FROM birthday_config WHERE id = 1');
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[BirthdayConfig] PATCH 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/birthday-config/active ───────────────────────────
// 当前持有 tag 的顾客（status = 'pending'）

router.get('/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         customer_id,
         email,
         tag_added_at,
         tag_remove_at
       FROM birthday_campaign_log
       WHERE status = 'pending'
       ORDER BY tag_added_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[BirthdayConfig] GET /active 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/birthday-config/failed-count ─────────────────────
// 2026-10-01：处理失败（status = 'failed'）的记录数。
// 这些顾客在 Shopify 上很可能仍持有 tag，前端据此提示并提供重试。

router.get('/failed-count', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM birthday_campaign_log WHERE status = 'failed'`
    );
    res.json({ count: result.rows[0]?.count || 0 });
  } catch (err) {
    console.error('[BirthdayConfig] GET /failed-count 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/birthday-config/retry-failed ────────────────────
// 2026-10-01：把 failed 记录改回 pending。它们的 tag_remove_at 已过，
// 下一次 Remove Job 运行时会重新拉取订单并移除 tag（不在此处立即执行）。

router.post('/retry-failed', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE birthday_campaign_log SET status = 'pending' WHERE status = 'failed'`
    );
    console.log(`[BirthdayConfig] retry-failed: ${result.rowCount} 条 failed 记录已改回 pending`);
    res.json({ reset: result.rowCount });
  } catch (err) {
    console.error('[BirthdayConfig] POST /retry-failed 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 清理过期 tag（2026-10-01） ────────────────────────────────
// 直接从 Shopify 扫描所有带 campaign tag 的顾客，移除不在有效期内的 tag。
// “有效期内” = birthday_campaign_log 中 status = 'pending' 且 tag_remove_at > NOW()。
// 只移除 tag，不改 birthday_campaign_log：failed 记录仍需 Retry failed
// 才会补记订单（届时 Remove Job 发现 tag 已不在会跳过移除步骤）。
//
//   GET  /api/birthday-config/cleanup-stale-tags/preview  扫描并返回数量（不修改）
//   POST /api/birthday-config/cleanup-stale-tags          后台开始清理，立即返回
//   GET  /api/birthday-config/cleanup-stale-tags/status   查询进度

const { getSession, getShopify } = require('../shopify');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getShopifyClient() {
  const session = await getSession();
  if (!session) throw new Error('未找到 Shopify session，请先完成 OAuth 授权');
  const shopify = getShopify();
  return new shopify.clients.Graphql({ session });
}

// Shopify 限流时等待后重试
async function requestWithRetry(client, query, variables, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await client.request(query, { variables });
    } catch (err) {
      const msg = String(err?.message || '') + JSON.stringify(err?.body || err?.response || '');
      if (i < attempts && /THROTTLED|Throttled|429/i.test(msg)) {
        await sleep(2000 * i);
        continue;
      }
      throw err;
    }
  }
}

// 扫描：返回 { tag, tagged, keepIds, toRemove: [customerId] }
async function scanStaleTags(client) {
  const config = (await pool.query('SELECT campaign_tag FROM birthday_config WHERE id = 1')).rows[0];
  const tag = config?.campaign_tag;
  if (!tag) throw new Error('campaign_tag 未配置');

  // 有效期内的顾客：保留 tag
  const keepRes = await pool.query(
    `SELECT DISTINCT customer_id FROM birthday_campaign_log
     WHERE status = 'pending' AND tag_remove_at > NOW()`
  );
  const keepIds = new Set(keepRes.rows.map((r) => r.customer_id));

  // 先完整收集所有带 tag 的顾客，再统一处理（避免边改边翻页导致漏掉）
  const tagged = [];
  let cursor = null;
  do {
    const res = await requestWithRetry(
      client,
      `query staleTagScan($query: String!, $after: String) {
         customers(first: 250, query: $query, after: $after) {
           pageInfo { hasNextPage endCursor }
           nodes { id tags }
         }
       }`,
      { query: `tag:'${tag.replace(/'/g, "\\'")}'`, after: cursor }
    );
    const page = res?.data?.customers;
    if (!page) break;
    for (const c of page.nodes) {
      // 搜索可能是模糊匹配，这里再精确确认一次
      if ((c.tags || []).includes(tag)) tagged.push(c.id);
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  const toRemove = tagged.filter((id) => !keepIds.has(id));
  return { tag, tagged: tagged.length, keep: tagged.length - toRemove.length, toRemove };
}

// 进度（内存中，服务重启后清空）
let cleanupState = { running: false };

router.get('/cleanup-stale-tags/preview', async (req, res) => {
  try {
    const client = await getShopifyClient();
    const { tag, tagged, keep, toRemove } = await scanStaleTags(client);
    res.json({ tag, tagged, keep, toRemove: toRemove.length });
  } catch (err) {
    console.error('[BirthdayConfig] cleanup preview 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/cleanup-stale-tags/status', (req, res) => {
  res.json(cleanupState);
});

router.post('/cleanup-stale-tags', async (req, res) => {
  if (cleanupState.running) {
    return res.status(409).json({ error: 'Cleanup already running', state: cleanupState });
  }
  cleanupState = {
    running: true, phase: 'scanning', startedAt: new Date().toISOString(),
    total: 0, removed: 0, failed: 0, errors: [], finishedAt: null,
  };
  res.status(202).json(cleanupState);

  // 后台执行
  (async () => {
    try {
      const client = await getShopifyClient();
      const { tag, toRemove } = await scanStaleTags(client);
      cleanupState.total = toRemove.length;
      cleanupState.phase = 'removing';
      console.log(`[Birthday] [Cleanup] 开始移除 ${toRemove.length} 个过期 tag (${tag})`);

      for (const id of toRemove) {
        try {
          const r = await requestWithRetry(
            client,
            `mutation removeTag($id: ID!, $tags: [String!]!) {
               tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
             }`,
            { id, tags: [tag] }
          );
          const errs = r?.data?.tagsRemove?.userErrors || [];
          if (errs.length) throw new Error(errs.map((e) => e.message).join(', '));
          cleanupState.removed++;
        } catch (err) {
          cleanupState.failed++;
          if (cleanupState.errors.length < 20) {
            cleanupState.errors.push({ customerId: id, message: err.message });
          }
          console.error(`[Birthday] [Cleanup] ✗ ${id}:`, err.message);
        }
        await sleep(250); // 控制速率，避免触发限流
      }
      console.log(`[Birthday] [Cleanup] 完成：移除 ${cleanupState.removed}，失败 ${cleanupState.failed}`);
    } catch (err) {
      console.error('[Birthday] [Cleanup] 中止:', err.message);
      cleanupState.errors.push({ message: err.message });
    } finally {
      cleanupState.running = false;
      cleanupState.phase = 'done';
      cleanupState.finishedAt = new Date().toISOString();
    }
  })();
});

// ── GET /api/birthday-config/orders ───────────────────────────
// tag 期间的消费记录，按 log 周期聚合
// query 参数 range: '30'（默认，过去 30 天）| 'all'（全部）
// 同时返回表内最早记录日期（earliest），供前端显示“Records since”

router.get('/orders', async (req, res) => {
  const range = req.query.range === 'all' ? 'all' : '30';

  // 时间过滤条件：以 tag_added_at 为准
  const whereClause = range === 'all'
    ? ''
    : `WHERE bcl.tag_added_at >= NOW() - INTERVAL '30 days'`;

  try {
    const result = await pool.query(
      `SELECT
         bcl.id              AS log_id,
         bcl.customer_id,
         bcl.email,
         bcl.tag_added_at,
         bcl.tag_remove_at,
         bcl.status,
         COALESCE(o.order_count, 0)  AS order_count,
         COALESCE(o.total_amount, 0) AS total_amount,
         o.currency,
         COALESCE(o.orders, '[]'::json) AS orders
       FROM birthday_campaign_log bcl
       LEFT JOIN (
         SELECT
           log_id,
           COUNT(*)            AS order_count,
           SUM(order_amount)   AS total_amount,
           MAX(currency)       AS currency,
           json_agg(json_build_object(
             'orderName',  order_name,
             'orderId',    order_id,
             'amount',     order_amount,
             'currency',   currency,
             'createdAt',  order_created_at
           ) ORDER BY order_created_at) AS orders
         FROM birthday_orders
         GROUP BY log_id
       ) o ON o.log_id = bcl.id
       ${whereClause}
       ORDER BY bcl.tag_added_at DESC`
    );

    // 表内最早一条记录的日期（不受 range 影响，反映“数据从何时开始”）
    const earliestRes = await pool.query(
      `SELECT MIN(tag_added_at) AS earliest FROM birthday_campaign_log`
    );

    res.json({
      range,
      earliest: earliestRes.rows[0]?.earliest || null,
      records: result.rows,
    });
  } catch (err) {
    console.error('[BirthdayConfig] GET /orders 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/birthday-config/orders/purge ──────────────────
// 删除 365 天前的记录（按 tag_added_at）。
// birthday_orders 通过 ON DELETE CASCADE 会随 log 一并删除。

router.delete('/orders/purge', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM birthday_campaign_log
       WHERE tag_added_at < NOW() - INTERVAL '365 days'`
    );
    console.log(`[BirthdayConfig] purge: 删除了 ${result.rowCount} 条 365 天前的记录`);
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('[BirthdayConfig] DELETE /orders/purge 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, registerRestartFn };