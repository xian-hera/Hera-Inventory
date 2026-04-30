// server/routes/birthdayConfig.js
// ─────────────────────────────────────────────────────────────
// 读写 birthday_config 表，并在保存时通知 scheduler 重启
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../database/init');

let _restartScheduler = null;

// 由 birthdayScheduler.js 注入重启函数
function registerRestartFn(fn) {
  _restartScheduler = fn;
}

// GET /api/birthday-config
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM birthday_config WHERE id = 1');
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[BirthdayConfig] GET 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/birthday-config
router.patch('/', async (req, res) => {
  const {
    enabled,
    add_job_enabled,
    add_job_hour,
    add_job_minute,
    remove_job_enabled,
    remove_job_hour,
    remove_job_minute,
    tag_delay_hours,
    campaign_tag,
  } = req.body;

  try {
    await pool.query(
      `UPDATE birthday_config SET
         enabled            = COALESCE($1,  enabled),
         add_job_enabled    = COALESCE($2,  add_job_enabled),
         add_job_hour       = COALESCE($3,  add_job_hour),
         add_job_minute     = COALESCE($4,  add_job_minute),
         remove_job_enabled = COALESCE($5,  remove_job_enabled),
         remove_job_hour    = COALESCE($6,  remove_job_hour),
         remove_job_minute  = COALESCE($7,  remove_job_minute),
         tag_delay_hours    = COALESCE($8,  tag_delay_hours),
         campaign_tag       = COALESCE($9,  campaign_tag),
         updated_at         = NOW()
       WHERE id = 1`,
      [
        enabled ?? null,
        add_job_enabled ?? null,
        add_job_hour ?? null,
        add_job_minute ?? null,
        remove_job_enabled ?? null,
        remove_job_hour ?? null,
        remove_job_minute ?? null,
        tag_delay_hours ?? null,
        campaign_tag ?? null,
      ]
    );

    // 通知 scheduler 重启以应用新配置
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

// GET /api/birthday-config/subscribers
// 返回 birthday_subscribers 表（含是否持有 tag 的状态）
router.get('/subscribers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         bs.customer_id,
         bs.email,
         bs.birth_month,
         bs.birth_day,
         bs.created_at,
         CASE WHEN bcl.id IS NOT NULL THEN true ELSE false END AS has_tag
       FROM birthday_subscribers bs
       LEFT JOIN birthday_campaign_log bcl
         ON bs.customer_id = bcl.customer_id AND bcl.status = 'pending'
       ORDER BY bs.birth_month, bs.birth_day`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[BirthdayConfig] GET /subscribers 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, registerRestartFn };