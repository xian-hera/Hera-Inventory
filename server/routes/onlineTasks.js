// /api/online-tasks — Online › Dashboard work checklist (2026-10-01, Hera).
// Spec: claude/ONLINE_DASHBOARD_SPEC.md.
//
// Day ("cycle") = from 07:00 Montreal time to the next 07:00. A task is done
// for the current cycle when done_cycle = current cycle, so the 07:00
// refresh needs no job:
//   - Regular: done_cycle becomes "yesterday" -> shows as not done again.
//   - Temp done in an earlier cycle -> gone (deleted on the next read).
//   - Temp not done -> simply stays until done or deleted.
// The 23:00 history snapshot lives in jobs/onlineTaskHistory.js.
const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

const TZ = 'America/Toronto'; // same zone as Montreal; used by every Hub scheduler
const CYCLE_SQL = `((NOW() AT TIME ZONE '${TZ}') - INTERVAL '7 hours')::date`;

function cleanLink(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch (e) {
    return null;
  }
}

const toTask = (r) => ({
  id: r.id, type: r.type, priority: r.type === 'temp' ? r.priority : null,
  name: r.name, link: r.link, description: r.description,
  sortOrder: r.sort_order, done: !!r.done, doneAt: r.done ? r.done_at : null, createdAt: r.created_at,
});

async function currentCycle() {
  const r = await pool.query(`SELECT to_char(${CYCLE_SQL}, 'YYYY-MM-DD') AS c`);
  return r.rows[0].c;
}

// GET / -> { cycle, open: [...], done: [...] }
router.get('/', async (req, res) => {
  try {
    // Temp tasks finished before today's 07:00 refresh are removed.
    await pool.query(`DELETE FROM online_tasks WHERE type = 'temp' AND done_cycle IS NOT NULL AND done_cycle < ${CYCLE_SQL}`);
    const r = await pool.query(`
      SELECT *, (done_cycle IS NOT NULL AND done_cycle = ${CYCLE_SQL}) AS done
      FROM online_tasks ORDER BY sort_order, id`);
    const tasks = r.rows.map(toTask);
    res.json({
      cycle: await currentCycle(),
      open: tasks.filter(t => !t.done),
      done: tasks.filter(t => t.done).sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt)),
    });
  } catch (e) {
    console.error('GET /api/online-tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST / { type: 'regular'|'temp', priority: 'normal'|'urgent', name, link, description }
// New tasks go to the top of the not-done area.
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const type = b.type === 'regular' ? 'regular' : 'temp';
    const priority = type === 'temp' && b.priority === 'urgent' ? 'urgent' : 'normal';
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Task name is required' });
    const link = cleanLink(b.link);
    if (String(b.link || '').trim() && !link) return res.status(400).json({ error: 'The link is not a valid web address' });
    const r = await pool.query(`
      INSERT INTO online_tasks (type, priority, name, link, description, sort_order)
      VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM online_tasks))
      RETURNING *, FALSE AS done`,
    [type, priority, name, link, String(b.description || '').trim() || null]);
    res.json({ task: toTask(r.rows[0]) });
  } catch (e) {
    console.error('POST /api/online-tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/done { done: true|false }
router.post('/:id/done', async (req, res) => {
  try {
    const done = !!(req.body && req.body.done);
    const r = await pool.query(
      done
        ? `UPDATE online_tasks SET done_cycle = ${CYCLE_SQL}, done_at = NOW() WHERE id = $1 RETURNING id`
        : 'UPDATE online_tasks SET done_cycle = NULL, done_at = NULL WHERE id = $1 RETURNING id',
      [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Task not found (it may have been deleted)' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /edit { order: [ids of not-done tasks, new order], deleted: [ids] }
// = Save in edit mode. Deleting is permanent (regular tasks too — Hera
// 2026-10-01). Done tasks are never touched here.
router.post('/edit', async (req, res) => {
  const order = (req.body && Array.isArray(req.body.order) ? req.body.order : []).map(Number).filter(Boolean);
  const deleted = (req.body && Array.isArray(req.body.deleted) ? req.body.deleted : []).map(Number).filter(Boolean);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (deleted.length) {
      await client.query(`
        DELETE FROM online_tasks WHERE id = ANY($1)
          AND NOT (done_cycle IS NOT NULL AND done_cycle = ${CYCLE_SQL})`, [deleted]);
    }
    // Not-done tasks get 1..n in the given order; any not-done task missing
    // from the list (e.g. added by someone else meanwhile) keeps its place
    // after them.
    for (let i = 0; i < order.length; i++) {
      await client.query('UPDATE online_tasks SET sort_order = $2 WHERE id = $1', [order[i], i + 1]);
    }
    await client.query(`
      UPDATE online_tasks SET sort_order = sort_order + $2 + 1
      WHERE NOT (id = ANY($1::int[]))`, [order, order.length]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/online-tasks/edit error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /history -> last 30 working-day records, newest first.
router.get('/history', async (req, res) => {
  try {
    const r = await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, items, recorded_at FROM online_task_history ORDER BY online_task_history.day DESC LIMIT 30`);
    res.json({ history: r.rows.map(x => ({ day: x.day, items: x.items, recordedAt: x.recorded_at })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.CYCLE_SQL = CYCLE_SQL;
module.exports.TZ = TZ;
