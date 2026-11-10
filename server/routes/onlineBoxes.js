// Online Boxes — Fulfiller integration (2026-11-10, Hera —
// claude/FULFILLER_ONLINE_BOXES.md).
//
// Fulfiller sends a list of boxes to bring from HQ to a store. Hub shows it
// as one "Online Boxes" card in WH › Schedule › Unscheduled (wh_tasks kind
// 'online_boxes'; hover = the list). WH schedules it like any card; it can't
// be split or deleted by WH. Whenever the card's date or half-day (AM / PM)
// changes after a Schedule save, Hub sends `online_boxes.scheduled` with the
// new date + half (null = back in Unscheduled). Nothing else is sent.
// Fulfiller may change (resend) or cancel a box order only while it is NOT
// scheduled in Hub (Hera 2026-11-10); cancel deletes the card.
//
// Mounted at /api/integration/online-boxes (index.js), same key check as the
// Online Transfer integration (onlineTransfers.integrationAuth).
//   POST /           { orders: [{ boxOrderId, locationId, rows: [{ code, dimension, quantity }] }] }
//   POST /cancel     { orders: [{ boxOrderId }] }

const express = require('express');
const { pool } = require('../database/init');

const HQ = 'HQ';
const ot = () => require('./onlineTransfers'); // lazy: avoids a require cycle

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// Validate one box order → { error } | { value }. (Inside: requestId = the
// order's boxOrderId; stored in wh_tasks.ob_request_id, rows in ob_items.)
async function clean(r) {
  if (!r || typeof r !== 'object') return { error: ['bad_request', 'Each order must be an object.'] };
  const requestId = text(r.boxOrderId, 200);
  if (!requestId) return { error: ['bad_request', 'boxOrderId is required.'] };
  const locationId = text(r.locationId, 200);
  if (!locationId) return { requestId, error: ['bad_request', 'locationId is required.'] };
  const location = await ot().locationNameFor(locationId, null);
  if (!location) return { requestId, error: ['unknown_location', `Hub has no store for ${locationId}.`] };
  if (location === HQ) return { requestId, error: ['hq_not_allowed', 'Online Boxes always go from HQ to a store; the store can’t be HQ.'] };
  if (!Array.isArray(r.rows) || r.rows.length === 0) return { requestId, error: ['bad_request', 'rows must have at least one row.'] };
  if (r.rows.length > 500) return { requestId, error: ['bad_request', 'At most 500 rows.'] };
  const items = [];
  for (const it of r.rows) {
    const code = text(it && it.code, 100);
    const dimension = text(it && it.dimension, 100);
    const quantity = Number(it && it.quantity);
    if (!code) return { requestId, error: ['bad_request', 'Every row needs a code.'] };
    if (!Number.isInteger(quantity) || quantity < 1) return { requestId, error: ['bad_request', `Quantity of “${code}” must be a whole number of 1 or more.`] };
    items.push({ code, dimension: dimension || null, quantity });
  }
  return { requestId, value: { requestId, location, items, note: null } };
}

async function submitOne(r) {
  const c = await clean(r);
  const requestId = c.requestId || (r && r.boxOrderId) || null;
  if (c.error) return { boxOrderId: requestId, status: 'rejected', reason: c.error[0], message: c.error[1] };
  const v = c.value;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query(
      `SELECT id, sched_date, gone_at, delivered_at FROM wh_tasks WHERE kind = 'online_boxes' AND ob_request_id = $1 FOR UPDATE`, [v.requestId]
    )).rows[0];
    // Changing an order is allowed only while it is not scheduled in Hub.
    if (cur && (cur.sched_date || cur.gone_at || cur.delivered_at)) {
      await client.query('ROLLBACK');
      return { boxOrderId: requestId, status: 'rejected', reason: 'already_scheduled', message: 'WH already scheduled this box order; it can’t be changed.', hubTaskId: cur.id };
    }
    let id;
    let status;
    if (cur) {
      await client.query(
        `UPDATE wh_tasks SET to_location = $2, ob_items = $3::jsonb, ob_note = $4, updated_at = NOW() WHERE id = $1`,
        [cur.id, v.location, JSON.stringify(v.items), v.note]
      );
      id = cur.id; status = 'updated';
    } else {
      id = (await client.query(
        `INSERT INTO wh_tasks (kind, from_location, to_location, ob_request_id, ob_items, ob_note)
         VALUES ('online_boxes', 'HQ', $1, $2, $3::jsonb, $4) RETURNING id`,
        [v.location, v.requestId, JSON.stringify(v.items), v.note]
      )).rows[0].id;
      status = 'accepted';
    }
    await client.query('COMMIT');
    return { boxOrderId: requestId, status, hubTaskId: id, location: v.location };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('online boxes submit failed:', e);
    return { boxOrderId: requestId, status: 'rejected', reason: 'error', message: e.message };
  } finally {
    client.release();
  }
}

// After any Schedule change: every Online Boxes card whose date or half-day
// differs from what Fulfiller last got → online_boxes.scheduled (AM ↔ PM on
// the same day counts too, Hera 2026-11-10). A card that was never scheduled
// and is still unscheduled sends nothing. Never throws.
async function notifyOnlineBoxes() {
  try {
    const r = await pool.query(
      `UPDATE wh_tasks SET ob_sent = TRUE, ob_sent_date = sched_date, ob_sent_half = sched_half
        WHERE kind = 'online_boxes' AND removed_at IS NULL
          AND (sched_date IS DISTINCT FROM ob_sent_date OR sched_half IS DISTINCT FROM ob_sent_half)
          AND (ob_sent OR sched_date IS NOT NULL)
        RETURNING id, ob_request_id, to_location, to_char(sched_date, 'YYYY-MM-DD') AS day, sched_half`
    );
    for (const w of r.rows) {
      await ot().enqueue('online_boxes.scheduled', {
        boxOrderId: w.ob_request_id,
        hubTaskId: w.id,
        location: w.to_location,
        date: w.day || null,      // null = back in Unscheduled (no date any more)
        half: w.sched_half || null, // 'AM' | 'PM' (null with date null)
      });
    }
    return r.rows.length;
  } catch (e) {
    console.error('notifyOnlineBoxes failed:', e.message);
    return 0;
  }
}

const router = express.Router();
router.use((req, res, next) => ot().integrationAuth(req, res, next));

// POST /api/integration/online-boxes
router.post('/', async (req, res) => {
  const list = req.body && Array.isArray(req.body.orders) ? req.body.orders : null;
  if (!list || list.length === 0) return res.status(400).json({ error: 'orders must be a non-empty array' });
  if (list.length > 200) return res.status(400).json({ error: 'At most 200 orders per call' });
  try {
    const results = [];
    for (const r of list) results.push(await submitOne(r));
    res.json({ results });
  } catch (e) {
    console.error('POST /api/integration/online-boxes error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/integration/online-boxes/cancel — only while the box order is
// NOT scheduled in Hub (Hera 2026-11-10); the card is then deleted.
router.post('/cancel', async (req, res) => {
  const list = req.body && Array.isArray(req.body.orders) ? req.body.orders : null;
  if (!list || list.length === 0) return res.status(400).json({ error: 'orders must be a non-empty array' });
  try {
    const results = [];
    for (const r of list) {
      const requestId = text(r && r.boxOrderId, 200);
      if (!requestId) { results.push({ boxOrderId: null, status: 'bad_request' }); continue; }
      const del = await pool.query(
        `DELETE FROM wh_tasks WHERE kind = 'online_boxes' AND ob_request_id = $1
            AND sched_date IS NULL AND gone_at IS NULL AND delivered_at IS NULL RETURNING id`, [requestId]
      );
      if (del.rowCount) { results.push({ boxOrderId: requestId, status: 'cancelled' }); continue; }
      const cur = (await pool.query(
        `SELECT to_char(sched_date, 'YYYY-MM-DD') AS day FROM wh_tasks WHERE kind = 'online_boxes' AND ob_request_id = $1`, [requestId]
      )).rows[0];
      results.push(cur ? { boxOrderId: requestId, status: 'already_scheduled', date: cur.day } : { boxOrderId: requestId, status: 'not_found' });
    }
    res.json({ results });
  } catch (e) {
    console.error('POST /api/integration/online-boxes/cancel error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, notifyOnlineBoxes };
