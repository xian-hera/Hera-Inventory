const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// Warehouse Scheduler + Receive Shipments (2026-10-21, Hera).
// Full spec: claude/SCHEDULER_FEATURE_SPEC.md in the project knowledge base.
//
//   Receive Shipments — every PO created after go-live waits here until WH
//     marks it Received (→ it becomes a Scheduler task) or deletes it (→ WH
//     never sees it again). The PO itself is never changed for BY / MA except
//     for the WH PB qty columns.
//   Schedule — cards (wh_tasks) for received POs (+ their splits), transfers
//     (created lazily here) and WH custom tasks, placed on Morning / Afternoon
//     of the next 7 business days. Saved as one batch (PUT /schedule).
//   Settings — custom task types (app_settings 'wh_task_types').
//
// No Shopify calls anywhere in this file.
//
// Route order: every fixed-path route is registered before any '/:id'
// style route (same lesson as transfers.js / boxPo.js).

const HQ = 'HQ';
const TZ = 'America/Toronto';
const WINDOW_DAYS = 7;

// ─── Small helpers ──────────────────────────────────────────────────────────

// Today's date in Toronto as 'YYYY-MM-DD' (en-CA formats as ISO).
function torontoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// The next 7 business days (Mon–Fri), starting with today when today is a
// weekday. Pure date arithmetic on 'YYYY-MM-DD' strings (UTC noon, so no DST
// edge can shift the day).
function businessWindow(today = torontoToday()) {
  const [y, m, d] = today.split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d, 12));
  const out = [];
  while (out.length < WINDOW_DAYS) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// "8 P" → { count: 8, unit: 'P' }; anything else → null.
function parsePb(text) {
  const m = /^\s*(\d+)\s*([PB])\s*$/i.exec(String(text || ''));
  if (!m) return null;
  return { count: parseInt(m[1], 10), unit: m[2].toUpperCase() };
}

// Same format as formatPbQty() in poInvoices.js: "{integer} P" / "{integer} B" or null.
function formatPb(mode, qty) {
  const q = String(qty == null ? '' : qty).trim();
  if (!/^\d+$/.test(q) || parseInt(q, 10) <= 0) return null;
  return `${parseInt(q, 10)} ${String(mode).toUpperCase() === 'B' ? 'B' : 'P'}`;
}

function toIdList(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(v => parseInt(v, 10))
    .filter(n => Number.isInteger(n) && n > 0);
}

async function getSetting(db, key, fallback) {
  const r = await db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}

// Go-live cutoff written by init.js on the first boot after deploy. Only POs
// / transfers created at or after it enter the Warehouse pages.
async function getGoLive(db) {
  const v = await getSetting(db, 'wh_schedule_go_live', null);
  return v || new Date().toISOString();
}

async function getTaskTypes(db) {
  const v = await getSetting(db, 'wh_task_types', []);
  return Array.isArray(v) ? v.filter(t => typeof t === 'string') : [];
}

// Effective PB text of a PO row (WH value once WH has set one, else BY's).
const EFFECTIVE_PB_SQL = `CASE WHEN i.pb_qty_wh_set THEN i.pb_qty_received ELSE i.pb_qty END`;

// Creates the root Scheduler task for a just-received PO (inside a tx).
// If WH deleted this PO's task earlier and Sync Tasks brought the PO back
// into Receive Shipments, the old (soft-removed) row is revived as a fresh,
// unscheduled, never-split task.
async function createPoTask(client, invoiceId, effectivePb) {
  const pb = parsePb(effectivePb);
  await client.query(
    `INSERT INTO wh_tasks (kind, po_invoice_id, pb_count, pb_unit, to_location)
     SELECT 'po', $1, $2, $3, location FROM po_invoices WHERE id = $1
     ON CONFLICT (po_invoice_id) WHERE kind = 'po' AND parent_task_id IS NULL
     DO UPDATE SET removed_at = NULL, pb_count = EXCLUDED.pb_count, pb_unit = EXCLUDED.pb_unit,
                   to_location = EXCLUDED.to_location, split_no = NULL, split_counter = 0,
                   sched_date = NULL, sched_half = NULL, sched_pos = NULL, updated_at = NOW()
     WHERE wh_tasks.removed_at IS NOT NULL`,
    [invoiceId, pb ? pb.count : null, pb ? pb.unit : null]
  );
}

// A PO is listed in Receive Shipments when it was created after go-live or
// put there by Sync Tasks, and WH has neither received nor deleted it.
const IN_RECEIVE_SHIPMENTS_SQL = (alias, goLiveParam) =>
  `(${alias}.created_at >= ${goLiveParam}::timestamptz OR ${alias}.wh_synced_at IS NOT NULL)
   AND ${alias}.wh_received_at IS NULL AND ${alias}.wh_removed_at IS NULL`;

// ─── Badges (tab counts) ────────────────────────────────────────────────────

// GET /api/warehouse/badges → { receiveShipments, hqDraft }
//   receiveShipments = POs waiting in Receive Shipments (grey badge)
//   hqDraft          = HQ-origin transfers in Draft (internal 'loading') (red badge)
router.get('/badges', async (req, res) => {
  try {
    const goLive = await getGoLive(pool);
    const [rs, hq] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS n FROM po_invoices
         WHERE ${IN_RECEIVE_SHIPMENTS_SQL('po_invoices', '$1')}`,
        [goLive]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM transfers WHERE from_location = $1 AND status = 'loading'`, [HQ]),
    ]);
    res.json({ receiveShipments: rs.rows[0].n, hqDraft: hq.rows[0].n });
  } catch (e) {
    console.error('GET /api/warehouse/badges error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Settings: custom task types ────────────────────────────────────────────

router.get('/task-types', async (req, res) => {
  try {
    res.json({ types: await getTaskTypes(pool) });
  } catch (e) {
    console.error('GET /api/warehouse/task-types error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/warehouse/task-types { types: [string] } — replaces the list.
// Empty names are dropped; duplicates (case-insensitive) are refused.
// Existing custom tasks keep the type text they were created with.
router.put('/task-types', async (req, res) => {
  try {
    const raw = Array.isArray(req.body && req.body.types) ? req.body.types : null;
    if (!raw) return res.status(400).json({ error: 'types must be a list' });
    const types = raw.map(t => String(t == null ? '' : t).trim()).filter(Boolean);
    const seen = new Set();
    for (const t of types) {
      if (t.length > 40) return res.status(400).json({ error: `Type "${t.slice(0, 40)}…" is too long (max 40 characters).` });
      const k = t.toLowerCase();
      if (seen.has(k)) return res.status(400).json({ error: `Type "${t}" already exists.` });
      seen.add(k);
    }
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('wh_task_types', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(types)]
    );
    res.json({ types });
  } catch (e) {
    console.error('PUT /api/warehouse/task-types error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Receive Shipments ──────────────────────────────────────────────────────

// GET /api/warehouse/receive-shipments — POs waiting for delivery, oldest
// first (the page re-sorts by supplier when asked).
router.get('/receive-shipments', async (req, res) => {
  try {
    const goLive = await getGoLive(pool);
    const r = await pool.query(
      `SELECT i.id, i.po_number, i.location, i.created_at, i.pb_qty,
              ${EFFECTIVE_PB_SQL} AS pb_effective,
              s.name AS supplier_name
       FROM po_invoices i
       JOIN po_suppliers s ON s.id = i.supplier_id
       WHERE ${IN_RECEIVE_SHIPMENTS_SQL('i', '$1')}
       ORDER BY i.created_at ASC, i.id ASC`,
      [goLive]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/warehouse/receive-shipments error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/warehouse/receive-shipments/receive-many { ids } — "Mark selected
// as Received": every PO keeps its current PB value (may be empty).
router.post('/receive-shipments/receive-many', async (req, res) => {
  const ids = toIdList(req.body && req.body.ids);
  if (ids.length === 0) return res.status(400).json({ error: 'Nothing selected' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      `UPDATE po_invoices i SET wh_received_at = NOW()
       WHERE i.id = ANY($1) AND i.wh_received_at IS NULL AND i.wh_removed_at IS NULL
       RETURNING i.id, ${EFFECTIVE_PB_SQL} AS pb_effective`,
      [ids]
    );
    for (const row of rows.rows) await createPoTask(client, row.id, row.pb_effective);
    await client.query('COMMIT');
    res.json({ received: rows.rows.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/warehouse/receive-shipments/receive-many error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/warehouse/receive-shipments/delete { ids } — removes POs from
// Receive Shipments (WH only; the PO itself is untouched).
router.post('/receive-shipments/delete', async (req, res) => {
  const ids = toIdList(req.body && req.body.ids);
  if (ids.length === 0) return res.status(400).json({ error: 'Nothing selected' });
  try {
    const r = await pool.query(
      `UPDATE po_invoices SET wh_removed_at = NOW()
       WHERE id = ANY($1) AND wh_received_at IS NULL AND wh_removed_at IS NULL`,
      [ids]
    );
    res.json({ deleted: r.rowCount });
  } catch (e) {
    console.error('POST /api/warehouse/receive-shipments/delete error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/warehouse/receive-shipments/:id/receive { mode: 'P'|'B', qty }
// — the Received modal. The value WH confirms is the delivered PB qty:
//   same as BY's value → nothing extra stored (BY sees no change);
//   different (incl. empty when BY had one) → stored as WH's value, BY's
//   own value stays in pb_qty as the reference.
router.post('/receive-shipments/:id/receive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const { mode, qty } = req.body || {};
  const qtyText = String(qty == null ? '' : qty).trim();
  if (qtyText !== '' && !/^\d+$/.test(qtyText)) return res.status(400).json({ error: 'PB qty must be a whole number.' });
  const value = formatPb(mode, qtyText);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT id, pb_qty FROM po_invoices WHERE id = $1 AND wh_received_at IS NULL AND wh_removed_at IS NULL FOR UPDATE',
      [id]
    );
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This PO is no longer waiting in Receive Shipments.' });
    }
    const byValue = cur.rows[0].pb_qty || null;
    const whSet = value !== byValue;
    await client.query(
      `UPDATE po_invoices SET wh_received_at = NOW(), pb_qty_wh_set = $2, pb_qty_received = $3 WHERE id = $1`,
      [id, whSet, whSet ? value : null]
    );
    await createPoTask(client, id, value);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/warehouse/receive-shipments/:id/receive error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── PO popup (Receive Shipments + Schedule) ────────────────────────────────

// GET /api/warehouse/po/:id — read-only content for the PO popup.
router.get('/po/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const inv = await pool.query(
      `SELECT i.id, i.po_number, i.invoice_number, i.location, i.status, i.invoice_date,
              ${EFFECTIVE_PB_SQL} AS pb_effective, s.name AS supplier_name
       FROM po_invoices i JOIN po_suppliers s ON s.id = i.supplier_id WHERE i.id = $1`,
      [id]
    );
    if (inv.rows.length === 0) return res.status(404).json({ error: 'PO not found' });
    const items = await pool.query(
      'SELECT id, sku, code, name, quantity FROM po_invoice_items WHERE invoice_id = $1 ORDER BY id ASC',
      [id]
    );
    res.json({ invoice: inv.rows[0], items: items.rows });
  } catch (e) {
    console.error('GET /api/warehouse/po/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Schedule ───────────────────────────────────────────────────────────────

// Adds a task row for every transfer created after go-live that has none yet.
// (A transfer whose task WH deleted keeps its row with removed_at, so it is
// never re-added.)
// A store → store transfer gets TWO rows: leg 'pickup' and leg 'deliver'
// (Hera 2026-10-21); every other transfer one row (leg NULL).
// `where` picks the transfers (alias t); $2 is always 'HQ'.
async function insertTransferTasks(db, where, params) {
  const r = await db.query(
    `INSERT INTO wh_tasks (kind, transfer_id, to_location, leg)
     SELECT 'transfer', t.id, t.to_location, l.leg
     FROM transfers t
     CROSS JOIN LATERAL (
       SELECT unnest(CASE WHEN t.from_location <> $2 AND t.to_location <> $2
                          THEN ARRAY['pickup', 'deliver']::text[] ELSE ARRAY[NULL]::text[] END) AS leg
     ) l
     WHERE ${where}
       AND NOT EXISTS (SELECT 1 FROM wh_tasks w
                       WHERE w.kind = 'transfer' AND w.transfer_id = t.id AND COALESCE(w.leg, '') = COALESCE(l.leg, ''))
     ON CONFLICT DO NOTHING`,
    params
  );
  return r.rowCount;
}

async function ensureTransferTasks(db) {
  const goLive = await getGoLive(db);
  await insertTransferTasks(db, 't.created_at >= $1::timestamptz', [goLive, HQ]);
}

// Schedule › "Sync Tasks" (Hera 2026-10-21): brings in work from before
// go-live and puts back tasks WH deleted by mistake. Anything already there
// is skipped.
//   Transfers in Draft / Pending / Ready to Ship → task card(s) added; a
//     deleted card of such a transfer comes back (unscheduled).
//   POs that are not Store counted / Committed / Archived (i.e. pending or
//     sent to store) → into Receive Shipments, unless already listed there
//     or already a live task on the Schedule.
const SYNC_TRANSFER_STATUSES = ['loading', 'pending', 'good_to_go'];
const SYNC_PO_STATUSES = ['pending', 'sent_to_store'];

// Everything the Schedule page shows: unscheduled tasks + tasks placed on
// today or later. (Tasks placed on past days are history — not shown.)
async function loadSchedule(db) {
  const today = torontoToday();
  const days = businessWindow(today);
  const [rowsRes, tagRes, versionVal] = await Promise.all([
    db.query(
      `SELECT w.*, to_char(w.sched_date, 'YYYY-MM-DD') AS sched_day,
              i.po_number, i.location AS po_location, s.name AS supplier_name,
              tr.shopify_transfer_name, tr.transfer_no, tr.from_location AS tr_from, tr.to_location AS tr_to,
              tr.status AS tr_status, tr.tags AS tr_tags, tr.on_hold AS tr_on_hold,
              EXISTS (SELECT 1 FROM wh_tasks c WHERE c.parent_task_id = w.id) AS has_children
       FROM wh_tasks w
       LEFT JOIN po_invoices i ON i.id = w.po_invoice_id
       LEFT JOIN po_suppliers s ON s.id = i.supplier_id
       LEFT JOIN transfers tr ON tr.id = w.transfer_id
       WHERE w.removed_at IS NULL AND (w.sched_date IS NULL OR w.sched_date >= $1::date)
       ORDER BY w.created_at ASC, w.id ASC`,
      [today]
    ),
    db.query('SELECT LOWER(tag) AS tag FROM transfer_tag_types'),
    getSetting(db, 'wh_schedule_version', 0),
  ]);
  const mappedTags = new Set(tagRes.rows.map(r => r.tag));
  const tasks = rowsRes.rows.map(w => {
    const base = {
      id: w.id,
      kind: w.kind,
      date: w.sched_day || null, // text, so the server's time zone can't shift the day
      half: w.sched_half,
      pos: w.sched_pos,
      createdAt: w.created_at,
    };
    if (w.kind === 'po') {
      return {
        ...base,
        poInvoiceId: w.po_invoice_id,
        parentId: w.parent_task_id,
        splitNo: w.split_no,
        hasChildren: w.has_children,
        number: `${w.po_number || ''}${w.split_no ? `-${w.split_no}` : ''}`,
        supplier: w.supplier_name || '',
        from: HQ,
        to: w.po_location || w.to_location || '',
        pbCount: w.pb_count,
        pbUnit: w.pb_unit,
      };
    }
    if (w.kind === 'transfer') {
      const tags = Array.isArray(w.tr_tags) ? w.tr_tags.flat(Infinity) : [];
      const tag = tags.find(t => mappedTags.has(String(t).toLowerCase())) || '';
      return {
        ...base,
        transferId: w.transfer_id,
        leg: w.leg || null, // 'pickup' | 'deliver' | null
        number: w.shopify_transfer_name || w.transfer_no || '',
        tag,
        status: w.tr_status,
        onHold: !!w.tr_on_hold,
        from: w.tr_from || '',
        to: w.tr_to || '',
      };
    }
    return {
      ...base,
      type: w.custom_type || '',
      title: w.custom_title || '',
      note: w.custom_note || '',
      from: HQ,
      to: w.to_location || '',
    };
  });
  return { today, days, version: Number(versionVal) || 0, tasks };
}

// POST /api/warehouse/sync → { transfersAdded, transfersRestored, posAdded }
router.post('/sync', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transfersAdded = await insertTransferTasks(client, 't.status = ANY($1)', [SYNC_TRANSFER_STATUSES, HQ]);
    const restored = await client.query(
      `UPDATE wh_tasks w SET removed_at = NULL, sched_date = NULL, sched_half = NULL, sched_pos = NULL, updated_at = NOW()
       FROM transfers t
       WHERE w.kind = 'transfer' AND w.transfer_id = t.id AND w.removed_at IS NOT NULL AND t.status = ANY($1)`,
      [SYNC_TRANSFER_STATUSES]
    );
    const goLive = await getGoLive(client);
    const pos = await client.query(
      `UPDATE po_invoices i SET wh_synced_at = NOW(), wh_removed_at = NULL, wh_received_at = NULL
       WHERE i.status = ANY($1)
         AND NOT (${IN_RECEIVE_SHIPMENTS_SQL('i', '$2')})
         AND NOT EXISTS (SELECT 1 FROM wh_tasks w
                         WHERE w.kind = 'po' AND w.po_invoice_id = i.id AND w.parent_task_id IS NULL AND w.removed_at IS NULL)`,
      [SYNC_PO_STATUSES, goLive]
    );
    await client.query('COMMIT');
    res.json({ transfersAdded, transfersRestored: restored.rowCount, posAdded: pos.rowCount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/warehouse/sync error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/warehouse/schedule
router.get('/schedule', async (req, res) => {
  try {
    await ensureTransferTasks(pool);
    res.json(await loadSchedule(pool));
  } catch (e) {
    console.error('GET /api/warehouse/schedule error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/warehouse/schedule { version, slots: { 'YYYY-MM-DD|AM': [taskId, …], … } }
// The FULL calendar of the current 7-business-day window as the page now has
// it. Every task listed is placed there in that order; every task currently
// on today or later that is not listed becomes Unscheduled. Refused with 409
// when someone else saved in between (version changed).
router.put('/schedule', async (req, res) => {
  const { version, slots } = req.body || {};
  if (!slots || typeof slots !== 'object') return res.status(400).json({ error: 'slots missing' });
  const today = torontoToday();
  const allowed = new Set(businessWindow(today));
  const placements = []; // { id, date, half, pos }
  const seen = new Set();
  for (const [key, list] of Object.entries(slots)) {
    const [date, half] = String(key).split('|');
    if (!allowed.has(date) || (half !== 'AM' && half !== 'PM')) {
      return res.status(400).json({ error: `${date} ${half || ''} is not one of the next 7 business days. Reload the page.` });
    }
    toIdList(list).forEach((id, pos) => {
      if (seen.has(id)) return; // a task can only sit in one place
      seen.add(id);
      placements.push({ id, date, half, pos });
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const v = await client.query("SELECT value FROM app_settings WHERE key = 'wh_schedule_version' FOR UPDATE");
    const current = v.rows.length ? Number(v.rows[0].value) || 0 : 0;
    if (Number(version) !== current) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Someone else saved the schedule in the meantime. Reload the page and make your changes again.' });
    }
    const ids = placements.map(p => p.id);
    // Unschedule what is no longer on the calendar (today and later only).
    await client.query(
      `UPDATE wh_tasks SET sched_date = NULL, sched_half = NULL, sched_pos = NULL, updated_at = NOW()
       WHERE removed_at IS NULL AND sched_date >= $1::date AND NOT (id = ANY($2))`,
      [today, ids]
    );
    for (const p of placements) {
      await client.query(
        `UPDATE wh_tasks SET sched_date = $2::date, sched_half = $3, sched_pos = $4, updated_at = NOW()
         WHERE id = $1 AND removed_at IS NULL`,
        [p.id, p.date, p.half, p.pos]
      );
    }
    // A store → store delivery may not be scheduled before its pickup
    // (Hera 2026-10-21). Compared by day, then Morning < Afternoon, then the
    // order inside the half-day. A delivery whose pickup is still
    // unscheduled is allowed.
    const bad = await client.query(
      `SELECT COALESCE(tr.shopify_transfer_name, tr.transfer_no) AS number
       FROM wh_tasks d
       JOIN wh_tasks p ON p.kind = 'transfer' AND p.transfer_id = d.transfer_id AND p.leg = 'pickup' AND p.removed_at IS NULL
       JOIN transfers tr ON tr.id = d.transfer_id
       WHERE d.kind = 'transfer' AND d.leg = 'deliver' AND d.removed_at IS NULL
         AND d.sched_date IS NOT NULL AND p.sched_date IS NOT NULL
         AND (d.sched_date, CASE d.sched_half WHEN 'AM' THEN 0 ELSE 1 END, d.sched_pos)
           < (p.sched_date, CASE p.sched_half WHEN 'AM' THEN 0 ELSE 1 END, p.sched_pos)`
    );
    if (bad.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Delivery is scheduled before its pickup: ${bad.rows.map(r => r.number).join(', ')}. Move the delivery later or the pickup earlier.` });
    }
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('wh_schedule_version', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(current + 1)]
    );
    await client.query('COMMIT');
    res.json(await loadSchedule(pool));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /api/warehouse/schedule error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/warehouse/tasks { type, title, note, toLocation } — custom task
// (always from HQ). Saved immediately.
router.post('/tasks', async (req, res) => {
  try {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    const toLocation = String(body.toLocation || '').trim();
    const note = String(body.note || '').trim();
    let type = String(body.type || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (!toLocation) return res.status(400).json({ error: 'To Location is required.' });
    const types = await getTaskTypes(pool);
    if (types.length > 0 && !type) return res.status(400).json({ error: 'Type is required.' });
    if (types.length === 0) type = ''; // no types in Settings → shown as "Custom"
    const r = await pool.query(
      `INSERT INTO wh_tasks (kind, custom_type, custom_title, custom_note, to_location)
       VALUES ('custom', $1, $2, $3, $4) RETURNING id`,
      [type || null, title, note || null, toLocation]
    );
    res.json({ id: r.rows[0].id });
  } catch (e) {
    console.error('POST /api/warehouse/tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// All descendant task ids of a task (split children, grandchildren, …).
async function descendantIds(client, id) {
  const r = await client.query(
    `WITH RECURSIVE d AS (
       SELECT id FROM wh_tasks WHERE parent_task_id = $1
       UNION ALL
       SELECT w.id FROM wh_tasks w JOIN d ON w.parent_task_id = d.id
     ) SELECT id FROM d`,
    [id]
  );
  return r.rows.map(x => x.id);
}

// POST /api/warehouse/tasks/delete { ids } — the page offers it for
// Unscheduled tasks only. Saved immediately.
//   custom          → deleted
//   transfer        → hidden for good (row kept with removed_at)
//   PO (not split / original)  → hidden for good, every task split from it deleted
//   PO split child  → deleted together with anything split from it; its PB
//                     goes back to the task it was split from. When no split
//                     is left, the original goes back to its plain number.
router.post('/tasks/delete', async (req, res) => {
  const ids = toIdList(req.body && req.body.ids);
  if (ids.length === 0) return res.status(400).json({ error: 'Nothing selected' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Children before parents, so a selected child returns its PB before its
    // parent is looked at (a parent selected too is then deleted anyway).
    const rows = (await client.query(
      'SELECT id, parent_task_id FROM wh_tasks WHERE id = ANY($1) AND removed_at IS NULL ORDER BY parent_task_id IS NULL, id DESC',
      [ids]
    )).rows;
    let deleted = 0;
    for (const { id } of rows) {
      const tr = await client.query(
        'SELECT * FROM wh_tasks WHERE id = $1 AND removed_at IS NULL FOR UPDATE',
        [id]
      );
      if (tr.rows.length === 0) continue; // already gone with a parent
      const t = tr.rows[0];
      // No "on the calendar" refusal here: the page only offers Delete for
      // tasks that are Unscheduled in its draft, and a saved placement simply
      // goes away with the task (2026-10-21 review — refusing forced a Save of
      // the whole draft first).
      if (t.kind === 'custom') {
        await client.query('DELETE FROM wh_tasks WHERE id = $1', [id]);
      } else if (t.kind === 'transfer') {
        // Both cards of a store → store transfer go together (Hera 2026-10-21).
        await client.query(
          `UPDATE wh_tasks SET removed_at = NOW(), sched_date = NULL, sched_half = NULL, sched_pos = NULL, updated_at = NOW()
           WHERE kind = 'transfer' AND transfer_id = $1 AND removed_at IS NULL`,
          [t.transfer_id]
        );
      } else {
        // Everything split from it is deleted too (Hera 2026-10-20), also
        // splits that are already on the calendar — the page warns first.
        const desc = await descendantIds(client, id);
        if (!t.parent_task_id) {
          // The original PO task: hide it for good, delete every split.
          if (desc.length > 0) await client.query('DELETE FROM wh_tasks WHERE id = ANY($1)', [desc]);
          await client.query(
            'UPDATE wh_tasks SET removed_at = NOW(), split_no = NULL, split_counter = 0, sched_date = NULL, sched_half = NULL, sched_pos = NULL, updated_at = NOW() WHERE id = $1',
            [id]
          );
        } else {
          // A split child: give its PB (incl. everything split from it) back.
          const sum = await client.query(
            'SELECT COALESCE(SUM(pb_count), 0)::int AS n FROM wh_tasks WHERE id = ANY($1)',
            [[id, ...desc]]
          );
          await client.query('DELETE FROM wh_tasks WHERE id = $1', [id]); // CASCADE removes the descendants
          await client.query(
            'UPDATE wh_tasks SET pb_count = COALESCE(pb_count, 0) + $2, updated_at = NOW() WHERE id = $1',
            [t.parent_task_id, sum.rows[0].n]
          );
          // No split left → the original goes back to its plain number.
          const left = await client.query(
            `SELECT COUNT(*)::int AS n FROM wh_tasks WHERE kind = 'po' AND po_invoice_id = $1 AND parent_task_id IS NOT NULL`,
            [t.po_invoice_id]
          );
          if (left.rows[0].n === 0) {
            await client.query(
              `UPDATE wh_tasks SET split_no = NULL, split_counter = 0, updated_at = NOW()
               WHERE kind = 'po' AND po_invoice_id = $1 AND parent_task_id IS NULL`,
              [t.po_invoice_id]
            );
          }
        }
      }
      deleted += 1;
    }
    await client.query('COMMIT');
    res.json({ deleted });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('POST /api/warehouse/tasks/delete error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/warehouse/tasks/:id/split { count } — split `count` pallets/boxes
// off a PO task into a new task. 1 ≤ count ≤ PB − 1. Saved immediately.
// Numbering: one counter per PO. First split → original "-1", new "-2";
// later splits "-3", "-4", … (numbers of deleted splits are not reused).
router.post('/tasks/:id/split', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const count = parseInt(req.body && req.body.count, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tr = await client.query(`SELECT * FROM wh_tasks WHERE id = $1 AND removed_at IS NULL AND kind = 'po' FOR UPDATE`, [id]);
    if (tr.rows.length === 0) throw Object.assign(new Error('PO task not found.'), { status: 404 });
    const t = tr.rows[0];
    const pb = t.pb_count || 0;
    if (pb <= 1) throw Object.assign(new Error('Only a PO task with a PB qty above 1 can be split.'), { status: 400 });
    if (!Number.isInteger(count) || count < 1 || count > pb - 1) {
      throw Object.assign(new Error(`Enter a number from 1 to ${pb - 1}.`), { status: 400 });
    }
    const rootRes = await client.query(
      `SELECT * FROM wh_tasks WHERE kind = 'po' AND po_invoice_id = $1 AND parent_task_id IS NULL FOR UPDATE`,
      [t.po_invoice_id]
    );
    const root = rootRes.rows[0];
    let counter = root.split_counter || 0;
    if (counter === 0) {
      await client.query('UPDATE wh_tasks SET split_no = 1, updated_at = NOW() WHERE id = $1', [root.id]);
      counter = 1;
    }
    const newNo = counter + 1;
    await client.query('UPDATE wh_tasks SET split_counter = $2, updated_at = NOW() WHERE id = $1', [root.id, newNo]);
    await client.query('UPDATE wh_tasks SET pb_count = pb_count - $2, updated_at = NOW() WHERE id = $1', [id, count]);
    const ins = await client.query(
      `INSERT INTO wh_tasks (kind, po_invoice_id, parent_task_id, split_no, pb_count, pb_unit, to_location)
       VALUES ('po', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [t.po_invoice_id, id, newNo, count, t.pb_unit, t.to_location]
    );
    await client.query('COMMIT');
    res.json({ id: ins.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('POST /api/warehouse/tasks/:id/split error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.torontoToday = torontoToday;
module.exports.businessWindow = businessWindow;
