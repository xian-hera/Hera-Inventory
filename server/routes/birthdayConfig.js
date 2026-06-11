// server/routes/birthdayConfig.js
// ─────────────────────────────────────────────────────────────
// 读写 birthday_config 表（仅保留 Remove Job 相关配置），
// 并提供前端所需的数据查询端点：
//   GET    /api/birthday-config              读取配置
//   PATCH  /api/birthday-config              保存配置（保存后重启 scheduler）
//   GET    /api/birthday-config/active       当前持有 tag 的顾客列表
//   GET    /api/birthday-config/orders       tag 期间的消费记录（?range=30 | all）
//   DELETE /api/birthday-config/orders/purge 删除 365 天前的记录
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