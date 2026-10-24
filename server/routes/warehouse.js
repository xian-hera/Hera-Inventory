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

// The 7 business days BEFORE today ("Past 7 days" view), oldest first.
function pastWindow(today = torontoToday()) {
  const [y, m, d] = today.split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d, 12));
  const out = [];
  while (out.length < WINDOW_DAYS) {
    cur.setUTCDate(cur.getUTCDate() - 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(cur.toISOString().slice(0, 10));
  }
  return out;
}

async function isGoneToday(db, today = torontoToday()) {
  const r = await db.query('SELECT 1 FROM wh_go_days WHERE day = $1::date', [today]);
  return r.rows.length > 0;
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
// A PO whose to location is HQ needs no delivery, so it gets no task
// (Hera 2026-10-21) — receiving it is all WH does.
// If WH deleted this PO's task earlier and Sync Tasks brought the PO back
// into Receive Shipments, the old (soft-removed) row is revived as a fresh,
// unscheduled, never-split task.
async function createPoTask(client, invoiceId, effectivePb) {
  const pb = parsePb(effectivePb);
  await client.query(
    `INSERT INTO wh_tasks (kind, po_invoice_id, pb_count, pb_unit, to_location)
     SELECT 'po', $1, $2, $3, location FROM po_invoices WHERE id = $1 AND location <> 'HQ'
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
   AND ${alias}.wh_received_at IS NULL AND ${alias}.wh_removed_at IS NULL
   AND ${alias}.wh_ship_to_hq IS NOT FALSE`; // NOT shipping to HQ (2026-10-22, Purchasing › Settings › Ship to HQ)

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

// GET /api/warehouse/location-colors → { colors: { name: '#RRGGBB' } }
// PUT { colors } (2026-10-22, Hera — Warehouse › Settings › Location Color).
// The whole map is saved at once; empty / missing = no colour (light grey).
router.get('/location-colors', async (req, res) => {
  try {
    const v = await getSetting(pool, 'wh_location_colors', {});
    res.json({ colors: v && typeof v === 'object' && !Array.isArray(v) ? v : {} });
  } catch (e) {
    console.error('GET /api/warehouse/location-colors error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/location-colors', async (req, res) => {
  const raw = req.body && req.body.colors;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return res.status(400).json({ error: 'colors must be an object' });
  const colors = {};
  for (const [name, value] of Object.entries(raw)) {
    const n = String(name || '').trim();
    let c = String(value || '').trim();
    if (!n || !c) continue;
    if (!c.startsWith('#')) c = `#${c}`;
    if (/^#[0-9a-f]{3}$/i.test(c)) c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    if (!/^#[0-9a-f]{6}$/i.test(c)) return res.status(400).json({ error: `${n}: "${value}" is not a colour like #E32A69.` });
    colors[n] = c.toUpperCase();
  }
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('wh_location_colors', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(colors)]
    );
    res.json({ colors });
  } catch (e) {
    console.error('PUT /api/warehouse/location-colors error:', e);
    res.status(500).json({ error: e.message });
  }
});

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
       AND COALESCE(t.source, 'hub') <> 'fulfiller' -- Online transfers: never on the Schedule (2026-10-23)
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
// view 'current' = the next 7 business days (today first); 'past' = the 7
// business days before today. lockedDays = days that can only take
// track-back additions: every past day. (Until 2026-10-23 also today after
// Go!; now today stays editable — cards that went out with Go! are `gone` and
// fixed, new cards can still be added and sent with another Go!.)
async function loadSchedule(db, view = 'current') {
  const today = torontoToday();
  const past = view === 'past';
  const days = past ? pastWindow(today) : businessWindow(today);
  const goneToday = await isGoneToday(db, today);
  const lockedDays = past ? days : [];
  const dateFilter = past
    ? `(w.sched_date IS NULL OR (w.sched_date >= $1::date AND w.sched_date < $2::date))`
    : `(w.sched_date IS NULL OR w.sched_date >= $1::date)`;
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
       WHERE w.removed_at IS NULL AND ${dateFilter}
       ORDER BY w.created_at ASC, w.id ASC`,
      past ? [days[0], today] : [today]
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
      trackedBack: !!w.tracked_back,
      gone: !!w.gone_at, // went out with a Go! (2026-10-23) — fixed
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
      from: w.from_location || HQ, // custom From (2026-10-23); older tasks: HQ
      to: w.to_location || '',
    };
  });
  return { view: past ? 'past' : 'current', today, days, lockedDays, goneToday, version: Number(versionVal) || 0, tasks };
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
         AND NOT (i.location = 'HQ' AND i.wh_received_at IS NOT NULL)
         AND i.wh_ship_to_hq IS NOT FALSE
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
    res.json(await loadSchedule(pool, req.query.view === 'past' ? 'past' : 'current'));
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
  // Today stays editable after Go! (2026-10-23, Hera): cards that went out
  // (gone) must stay on today, in the same half-day and the same order among
  // themselves; new cards may be added anywhere around them.
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
    const gone = await client.query(
      `SELECT id, sched_half FROM wh_tasks
        WHERE removed_at IS NULL AND gone_at IS NOT NULL AND sched_date = $1::date
        ORDER BY CASE sched_half WHEN 'AM' THEN 0 ELSE 1 END, sched_pos, id`,
      [today]
    );
    for (const half of ['AM', 'PM']) {
      const want = gone.rows.filter(r => r.sched_half === half).map(r => r.id);
      const goneSet = new Set(want);
      const got = placements.filter(p => p.date === today && p.half === half && goneSet.has(p.id)).map(p => p.id);
      if (want.join(',') !== got.join(',')) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: "Tasks that already went out with Go! can't be moved or removed. Reload the page." });
      }
    }
    const ids = placements.map(p => p.id);
    // Unschedule what is no longer on the calendar — editable days only
    // (a locked today keeps what it has).
    await client.query(
      `UPDATE wh_tasks SET sched_date = NULL, sched_half = NULL, sched_pos = NULL, updated_at = NOW()
       WHERE removed_at IS NULL AND sched_date = ANY($1::date[]) AND NOT (id = ANY($2))`,
      [[...allowed], ids]
    );
    for (const p of placements) {
      await client.query(
        `UPDATE wh_tasks SET sched_date = $2::date, sched_half = $3, sched_pos = $4, updated_at = NOW(),
                sched_set_at = CASE WHEN sched_date IS DISTINCT FROM $2::date OR sched_half IS DISTINCT FROM $3
                                    THEN NOW() ELSE sched_set_at END
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
    // An Online pickup whose stop is gone now → Fulfiller must re-assign (2026-10-23)
    await require('./onlineTransfers').checkOnlineAnchors();
    res.json(await loadSchedule(pool));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /api/warehouse/schedule error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/warehouse/tasks/track-back { ids, date, half } — "track back"
// (Hera 2026-10-21): add Unscheduled tasks to a LOCKED day (one of the 7
// past business days, or today after Go!), at the bottom of that half-day,
// to record work that was done but never scheduled. Saved immediately.
router.post('/tasks/track-back', async (req, res) => {
  const ids = toIdList(req.body && req.body.ids);
  const { date, half } = req.body || {};
  if (ids.length === 0) return res.status(400).json({ error: 'Nothing selected' });
  if (half !== 'AM' && half !== 'PM') return res.status(400).json({ error: 'Bad half-day' });
  const today = torontoToday();
  // Past days only since 2026-10-23 (today stays editable after Go!).
  const ok = pastWindow(today).includes(date);
  if (!ok) return res.status(400).json({ error: 'Tasks can only be tracked back to the past 7 business days.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const max = await client.query(
      'SELECT COALESCE(MAX(sched_pos), -1)::int AS m FROM wh_tasks WHERE removed_at IS NULL AND sched_date = $1::date AND sched_half = $2',
      [date, half]
    );
    let pos = max.rows[0].m + 1;
    let added = 0;
    for (const id of ids) {
      const r = await client.query(
        `UPDATE wh_tasks SET sched_date = $2::date, sched_half = $3, sched_pos = $4, tracked_back = TRUE, updated_at = NOW(), sched_set_at = NOW()
         WHERE id = $1 AND removed_at IS NULL AND sched_date IS NULL`,
        [id, date, half, pos]
      );
      if (r.rowCount) { pos += 1; added += 1; }
    }
    await client.query('COMMIT');
    res.json({ added });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/warehouse/tasks/track-back error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/warehouse/tasks/untrack { ids } — take tracked-back tasks off
// their locked day, back to Unscheduled. Other tasks on a locked day can't
// be moved. Saved immediately.
router.post('/tasks/untrack', async (req, res) => {
  const ids = toIdList(req.body && req.body.ids);
  if (ids.length === 0) return res.status(400).json({ error: 'Nothing selected' });
  try {
    const r = await pool.query(
      `UPDATE wh_tasks SET sched_date = NULL, sched_half = NULL, sched_pos = NULL, tracked_back = FALSE, updated_at = NOW()
       WHERE id = ANY($1) AND removed_at IS NULL AND tracked_back = TRUE`,
      [ids]
    );
    await require('./onlineTransfers').checkOnlineAnchors(); // stop gone → Fulfiller re-assigns (2026-10-23)
    res.json({ moved: r.rowCount });
  } catch (e) {
    console.error('POST /api/warehouse/tasks/untrack error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/warehouse/go — "Go!" (Hera 2026-10-21): today's trucks have left.
//   1. today's schedule is locked (only track-back from now on);
//   2. every transfer with a card on today's schedule that is Ready to Ship
//      gets "Mark as In Transit" — the same action as on the transfer page
//      (dispatchOne in transfers.js). A store → store transfer is still ONE
//      transfer with ONE status: it is marked once, whichever of its two
//      cards is on today (normally part 1, the pickup). Its part 2 card then
//      stays on the Schedule while In Transit (exception, Hera 2026-10-21).
//      Changed 2026-10-23 (Hera, final): only transfers FROM HQ (cards
//      without a leg, from HQ) are marked here; every transfer from a store
//      goes In Transit on Delivery › Picked Up.
// Once per day → since 2026-10-23: again whenever new cards were added to
// today after the last Go! (only those are handled).
router.post('/go', async (req, res) => {
  const today = torontoToday();
  if (!businessWindow(today).includes(today)) return res.status(400).json({ error: 'Today is not a business day.' });
  try {
    // Go! can be pressed again for cards added to today after the last Go!
    // (2026-10-23, Hera); each press only handles cards not gone yet.
    const fresh = await pool.query(
      'SELECT COUNT(*)::int AS n FROM wh_tasks WHERE removed_at IS NULL AND sched_date = $1::date AND gone_at IS NULL',
      [today]
    );
    if (fresh.rows[0].n === 0) return res.status(409).json({ error: 'Nothing new on today\'s schedule since the last Go!.' });
    await pool.query('INSERT INTO wh_go_days (day) VALUES ($1::date) ON CONFLICT (day) DO UPDATE SET gone_at = NOW()', [today]);
    // Saved schedules from other pages must reload (today changed to locked).
    await pool.query(
      `UPDATE app_settings SET value = to_jsonb(COALESCE(value::text::int, 0) + 1), updated_at = NOW() WHERE key = 'wh_schedule_version'`
    );
    const rows = (await pool.query(
      `SELECT DISTINCT tr.id, tr.status, COALESCE(tr.shopify_transfer_name, tr.transfer_no) AS number
       FROM wh_tasks w JOIN transfers tr ON tr.id = w.transfer_id
       WHERE w.kind = 'transfer' AND w.removed_at IS NULL AND w.sched_date = $1::date AND w.gone_at IS NULL
         -- part 1 (pickup) of a store → store transfer no longer changes
         -- the Shopify status (2026-10-23, Hera): it goes In Transit when its
         -- part 2 (deliver) card goes out with Go!.
         -- 2026-10-23 (Hera, final): Go! only sends out transfers FROM HQ.
         -- A transfer from a store (to HQ, or part 1 / 2 of store → store)
         -- goes In Transit when the driver presses Picked Up on the Delivery
         -- tab (part 2 of store → store is then already In Transit).
         AND w.leg IS NULL AND tr.from_location = 'HQ'`,
      [today]
    )).rows;
    const results = { inTransit: [], skipped: [], failed: [] };
    for (const t of rows) {
      if (t.status !== 'good_to_go') { results.skipped.push({ number: t.number, status: t.status }); continue; }
      try {
        const { dispatchOne } = require('./transfers'); // loaded here: transfers.js pulls in the Shopify client
        await dispatchOne(t.id);
        results.inTransit.push(t.number);
      } catch (e) {
        results.failed.push({ number: t.number, error: e.message });
      }
    }
    await pool.query('UPDATE wh_go_days SET results = $2 WHERE day = $1::date', [today, JSON.stringify(results)]);
    await pool.query(
      'UPDATE wh_tasks SET gone_at = NOW() WHERE removed_at IS NULL AND sched_date = $1::date AND gone_at IS NULL',
      [today]
    );
    res.json(results);
  } catch (e) {
    console.error('POST /api/warehouse/go error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/warehouse/tasks { type, title, note, toLocation } — custom task
// (always from HQ). Saved immediately.
router.post('/tasks', async (req, res) => {
  try {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    const toLocation = String(body.toLocation || '').trim();
    // From (2026-10-23, Hera): default HQ. One side must be HQ — From = HQ is
    // a delivery to To; To = HQ is a pickup at From (no store → store).
    const fromLocation = String(body.fromLocation || HQ).trim() || HQ;
    const note = String(body.note || '').trim();
    let type = String(body.type || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (!toLocation) return res.status(400).json({ error: 'To Location is required.' });
    if (fromLocation === toLocation) return res.status(400).json({ error: 'From and To can not be the same location.' });
    if (fromLocation !== HQ && toLocation !== HQ) return res.status(400).json({ error: 'From or To must be HQ.' });
    const types = await getTaskTypes(pool);
    if (types.length > 0 && !type) return res.status(400).json({ error: 'Type is required.' });
    if (types.length === 0) type = ''; // no types in Settings → shown as "Custom"
    const r = await pool.query(
      `INSERT INTO wh_tasks (kind, custom_type, custom_title, custom_note, to_location, from_location)
       VALUES ('custom', $1, $2, $3, $4, $5) RETURNING id`,
      [type || null, title, note || null, toLocation, fromLocation]
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
    await require('./onlineTransfers').checkOnlineAnchors(); // stop gone → Fulfiller re-assigns (2026-10-23)
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

// ─── DD (delivery date) for Purchasing / Store pages ────────────────────────
//
// POST /api/warehouse/dd { poIds: [], transferIds: [] } (Hera 2026-10-21,
// claude/SCHEDULER_FEATURE_SPEC.md §7). Read live from the SAVED schedule.
// → { today, pos: { [id]: { entries, pb } }, transfers: { [id]: { entries } } }
// One entry per Schedule card (a split PO / a store → store transfer can have
// several), sorted: scheduled by date / half / order, then TBD:
//   { state: 'scheduled' | 'tbd' | 'received', date, half, position,
//     location, leg, pbCount, pbUnit, past }
//   scheduled — on the calendar. position = rank of the card's store among
//               the DIFFERENT stores of that half-day, in schedule order (each
//               store counted once, at its first card; every kind counts; HQ
//               never counts).
//   tbd       — in the Schedule's Unscheduled section (a transfer only while
//               it is shown there: Ready to Ship, or the deliver card of an In
//               Transit store → store transfer).
//   received  — a PO to HQ that WH received (it never gets a Schedule card):
//               date = the day it was received. Before that: no entry.
//   No entry at all: PO not received yet, transfer not shown in Unscheduled,
//   task deleted, or nothing from before go-live.
// pb (PO only) = { by, whSet, wh } for Purchasing's grey PB pill.

// The store a card goes to (or picks up from) — the "location" of the card.
const CARD_STORE_SQL = `CASE
  WHEN w.kind = 'po' THEN i.location
  WHEN w.kind = 'custom' THEN (CASE WHEN COALESCE(w.from_location, 'HQ') = 'HQ' THEN w.to_location ELSE w.from_location END)
  WHEN w.leg = 'pickup' THEN tr.from_location
  WHEN w.leg = 'deliver' THEN tr.to_location
  WHEN tr.from_location = 'HQ' THEN tr.to_location
  ELSE tr.from_location END`;

// Shared by POST /dd and GET /store-custom. customIds = wh_tasks ids of
// custom tasks (2026-10-22, Store › Dashboard) → out.custom[id].
async function computeDD({ poIds = [], transferIds = [], customIds = [] }) {
  const today = torontoToday();
  const out = { today, pos: {}, transfers: {}, custom: {} };
  if (poIds.length === 0 && transferIds.length === 0 && customIds.length === 0) return out;
  {
    if (transferIds.length) await ensureTransferTasks(pool);
    const [taskRes, poRes] = await Promise.all([
      pool.query(
        `SELECT w.id, w.kind, w.po_invoice_id, w.transfer_id, w.leg, w.pb_count, w.pb_unit,
                w.sched_half, w.sched_pos, to_char(w.sched_date, 'YYYY-MM-DD') AS sched_day,
                tr.status AS tr_status, ${CARD_STORE_SQL} AS store
         FROM wh_tasks w
         LEFT JOIN po_invoices i ON i.id = w.po_invoice_id
         LEFT JOIN transfers tr ON tr.id = w.transfer_id
         WHERE w.removed_at IS NULL
           AND ((w.kind = 'po' AND w.po_invoice_id = ANY($1::int[]))
             OR (w.kind = 'transfer' AND w.transfer_id = ANY($2::int[]))
             OR (w.kind = 'custom' AND w.id = ANY($3::int[])))`,
        [poIds, transferIds, customIds]
      ),
      poIds.length ? pool.query(
        `SELECT id, location, pb_qty, pb_qty_wh_set, pb_qty_received, wh_received_at IS NOT NULL AS wh_received,
                to_char(wh_received_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS received_day
         FROM po_invoices WHERE id = ANY($1::int[])`,
        [poIds]
      ) : Promise.resolve({ rows: [] }),
    ]);

    // Positions: every half-day that one of these cards is on.
    const slotKeys = [...new Set(taskRes.rows.filter(t => t.sched_day && t.sched_half).map(t => `${t.sched_day}|${t.sched_half}`))];
    const rank = new Map(); // 'day|half' → Map(store → 1-based rank)
    if (slotKeys.length) {
      const days = slotKeys.map(k => k.split('|')[0]);
      const halves = slotKeys.map(k => k.split('|')[1]);
      const slotRes = await pool.query(
        `SELECT to_char(w.sched_date, 'YYYY-MM-DD') AS day, w.sched_half AS half, ${CARD_STORE_SQL} AS store
         FROM wh_tasks w
         JOIN UNNEST($1::date[], $2::text[]) AS s(day, half) ON s.day = w.sched_date AND s.half = w.sched_half
         LEFT JOIN po_invoices i ON i.id = w.po_invoice_id
         LEFT JOIN transfers tr ON tr.id = w.transfer_id
         WHERE w.removed_at IS NULL
         ORDER BY w.sched_date, w.sched_half, w.sched_pos NULLS LAST, w.id`,
        [days, halves]
      );
      for (const r of slotRes.rows) {
        const k = `${r.day}|${r.half}`;
        if (!rank.has(k)) rank.set(k, new Map());
        const m = rank.get(k);
        if (r.store && r.store !== HQ && !m.has(r.store)) m.set(r.store, m.size + 1);
      }
    }

    const halfOrder = { AM: 0, PM: 1 };
    const sortEntries = (list) => list.sort((a, b) => {
      if (!a.date !== !b.date) return a.date ? -1 : 1;
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.half !== b.half) return (halfOrder[a.half] || 0) - (halfOrder[b.half] || 0);
      return (a.order || 0) - (b.order || 0);
    });

    for (const t of taskRes.rows) {
      let entry;
      if (t.sched_day) {
        const m = rank.get(`${t.sched_day}|${t.sched_half}`);
        entry = {
          state: 'scheduled', date: t.sched_day, half: t.sched_half, order: t.sched_pos,
          position: m && m.get(t.store) ? m.get(t.store) : null, past: t.sched_day < today,
        };
      } else {
        if (t.kind === 'transfer'
          && !(t.tr_status === 'good_to_go' || (t.leg === 'deliver' && t.tr_status === 'in_transit'))) continue;
        entry = { state: 'tbd', date: null, half: null, position: null, past: false };
      }
      entry.location = t.store || null;
      entry.leg = t.leg || null;
      entry.pbCount = t.kind === 'po' ? t.pb_count : null;
      entry.pbUnit = t.kind === 'po' ? t.pb_unit : null;
      const bucket = t.kind === 'po' ? out.pos : t.kind === 'custom' ? out.custom : out.transfers;
      const id = t.kind === 'po' ? t.po_invoice_id : t.kind === 'custom' ? t.id : t.transfer_id;
      if (!bucket[id]) bucket[id] = { entries: [] };
      bucket[id].entries.push(entry);
    }
    for (const p of poRes.rows) {
      if (!out.pos[p.id]) out.pos[p.id] = { entries: [] };
      // received (2026-10-22): WH received it → Purchasing's PB pill turns green / red.
      out.pos[p.id].pb = { by: p.pb_qty || null, whSet: !!p.pb_qty_wh_set, wh: p.pb_qty_received || null, received: !!p.wh_received };
      if (p.location === HQ && p.received_day) {
        out.pos[p.id].entries = [{
          state: 'received', date: p.received_day, half: null, position: null,
          past: p.received_day < today, location: HQ, leg: null, pbCount: null, pbUnit: null,
        }];
      }
    }
    for (const b of [...Object.values(out.pos), ...Object.values(out.transfers), ...Object.values(out.custom)]) {
      sortEntries(b.entries);
      b.entries.forEach(e => { delete e.order; });
    }
  }
  return out;
}

router.post('/dd', async (req, res) => {
  try {
    const out = await computeDD({
      poIds: toIdList(req.body && req.body.poIds),
      transferIds: toIdList(req.body && req.body.transferIds),
    });
    delete out.custom;
    res.json(out);
  } catch (e) {
    console.error('POST /api/warehouse/dd error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/warehouse/store-custom?location=MTL01 (2026-10-22, Hera — Store ›
// Dashboard › Incoming Delivery): WH custom tasks going to this store that
// carry a DD — unscheduled (TBD) or scheduled today or later.
// → [{ id, type, title, entry }]
router.get('/store-custom', async (req, res) => {
  const location = String(req.query.location || '').trim();
  if (!location) return res.status(400).json({ error: 'location required' });
  try {
    const today = torontoToday();
    const r = await pool.query(
      `SELECT id, custom_type, custom_title FROM wh_tasks
        WHERE kind = 'custom' AND removed_at IS NULL AND to_location = $1
          AND (sched_date IS NULL OR sched_date >= $2::date)
        ORDER BY sched_date NULLS LAST, sched_half, sched_pos, id`,
      [location, today]
    );
    const dd = await computeDD({ customIds: r.rows.map(x => x.id) });
    res.json(r.rows.map(x => ({
      id: x.id, type: x.custom_type || 'Custom', title: x.custom_title || '',
      entry: ((dd.custom[x.id] || {}).entries || [])[0] || null,
    })).filter(x => x.entry));
  } catch (e) {
    console.error('GET /api/warehouse/store-custom error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Delivery tab (2026-10-23, Hera) ─────────────────────────────────────────
// For the truck driver, on a phone. Today's saved Schedule, as a list of
// stops: per half-day, the cards grouped by the store they go to / pick up
// from, in schedule order (first card of each store decides its place).
// A stop has "deliver" tasks (PO, HQ → store transfer, part 2 of a split
// store → store, custom from HQ) and/or "pickup" tasks (store → HQ transfer,
// part 1 of a split store → store, custom to HQ).
//   Delivered (blue button) — every deliver task of the stop: wh_tasks.delivered_at;
//     transfer In Transit → Receiving (same as the Store's "Delivered");
//     a transfer still Ready to Ship is first marked In Transit in Shopify.
//     PO: no status change (Sent to store stays; the store counts it).
//   Picked up (green button) — every pickup task: wh_tasks.picked_at;
//     store → HQ transfer and part 1 of a split store → store
//     Ready to Ship → In Transit (Shopify) (part 1: since 2026-10-23).
//   When the LAST stop of the day is done, today's store → HQ transfers
//     In Transit → Receiving (back at HQ).
// A task whose status change fails is NOT marked, so the button can be
// pressed again.
const deliveryRole = (w) => {
  if (w.kind === 'po') return { role: 'deliver', store: w.po_location || w.to_location };
  if (w.kind === 'custom') {
    const from = w.from_location || HQ;
    return from === HQ ? { role: 'deliver', store: w.to_location } : { role: 'pickup', store: from };
  }
  if (w.leg === 'pickup') return { role: 'pickup', store: w.tr_from };
  if (w.leg === 'deliver') return { role: 'deliver', store: w.tr_to };
  if (w.tr_to === HQ) return { role: 'pickup', store: w.tr_from };
  return { role: 'deliver', store: w.tr_to };
};

async function loadDeliveryRows(day) {
  const r = await pool.query(
    `SELECT w.*, i.po_number, i.location AS po_location,
            tr.shopify_transfer_name, tr.transfer_no, tr.from_location AS tr_from, tr.to_location AS tr_to,
            tr.status AS tr_status, tr.on_hold AS tr_on_hold
       FROM wh_tasks w
       LEFT JOIN po_invoices i ON i.id = w.po_invoice_id
       LEFT JOIN transfers tr ON tr.id = w.transfer_id
      WHERE w.removed_at IS NULL AND w.sched_date = $1::date
      ORDER BY CASE w.sched_half WHEN 'AM' THEN 0 ELSE 1 END, w.sched_pos, w.id`,
    [day]
  );
  return r.rows.map(w => ({ ...w, ...deliveryRole(w) }));
}

// Online (Fulfiller) pickups anchored to a stop of `day` (2026-10-23, Hera),
// with their items for the driver's modal. Not shown once the stop they
// belong to is gone (needs_reassign_at).
async function loadOnlinePickups(day) {
  const r = await pool.query(
    `SELECT p.*, t.status AS tr_status, t.shopify_transfer_name, t.transfer_no
       FROM wh_online_pickups p JOIN transfers t ON t.id = p.transfer_id
      WHERE p.pickup_date = $1::date AND p.needs_reassign_at IS NULL
      ORDER BY p.placed_at, p.transfer_id`,
    [day]
  );
  if (r.rows.length === 0) return [];
  const items = await pool.query(
    `SELECT transfer_id, id, sku, name, product_title, variant_title, image_url, quantity, requested_qty, qty_loaded, loaded_confirmed
       FROM transfer_items WHERE transfer_id = ANY($1) AND edit_state IS DISTINCT FROM 'removed' ORDER BY id`,
    [r.rows.map(x => x.transfer_id)]
  );
  return r.rows.map(p => ({
    ...p,
    stopKey: p.occurrence > 1 ? `${p.half}|${p.location}|${p.occurrence}` : `${p.half}|${p.location}`,
    items: items.rows.filter(i => i.transfer_id === p.transfer_id).map(i => ({
      id: i.id, sku: i.sku, name: i.product_title || i.name, variant: i.variant_title || '', image: i.image_url || null,
      // driver sees the loaded qty once the store prepared it, else the requested qty
      qty: i.loaded_confirmed && i.qty_loaded != null ? Number(i.qty_loaded) : Number(i.requested_qty != null ? i.requested_qty : i.quantity),
    })),
  }));
}

// Stops in schedule order, one per store per half-day — except (2026-10-23,
// Hera) a card put on today AFTER that store's stop was already finished
// starts a new stop for the same store at its own place in the order (e.g.
// stops 1-3 done, truck at 4, a new card for store 3 placed after 4 → a
// second "3" after 4, not inside the grey 3). Keys: 'AM|MTL03', then
// 'AM|MTL03|2', … (stable while the order doesn't change).
// online = Online (Fulfiller) pickups of the day; each joins the stop whose
// key it is anchored to (pickup tasks with online: true, all merged into ONE
// "Online" chip on the page).
function buildStops(rows, online = []) {
  const stops = [];
  const lastOf = {};   // half|store → latest stop of that store
  const countOf = {};  // half|store → number of stops so far
  const doneTime = (t) => (t.role === 'deliver' ? t.delivered_at : t.picked_at);
  for (const w of rows) {
    const base = `${w.sched_half}|${w.store}`;
    let st = lastOf[base];
    if (st) {
      const all = [...st.rawDeliver, ...st.rawPickup];
      const finishedAt = all.every(t => doneTime(t)) ? new Date(Math.max(...all.map(t => new Date(doneTime(t)).getTime()))) : null;
      if (finishedAt && w.sched_set_at && new Date(w.sched_set_at) > finishedAt) st = null;
    }
    if (!st) {
      countOf[base] = (countOf[base] || 0) + 1;
      st = { key: countOf[base] === 1 ? base : `${base}|${countOf[base]}`, half: w.sched_half, location: w.store, rawDeliver: [], rawPickup: [], rawOnline: [] };
      lastOf[base] = st;
      stops.push(st);
    }
    (w.role === 'deliver' ? st.rawDeliver : st.rawPickup).push(w);
  }
  for (const p of online) {
    const st = stops.find(x => x.key === p.stopKey);
    if (st) st.rawOnline.push(p);
  }
  const view = (w) => ({
    id: w.id, kind: w.kind,
    number: w.kind === 'po' ? `${w.po_number || ''}${w.split_no ? `-${w.split_no}` : ''}`
      : w.kind === 'transfer' ? (w.shopify_transfer_name || w.transfer_no || '')
      : (w.custom_title || ''),
    online: false,
    delivered: !!w.delivered_at, picked: !!w.picked_at,
    doneAt: w.delivered_at || w.picked_at || null,
  });
  const onlineView = (p) => ({
    id: `online-${p.transfer_id}`, transferId: p.transfer_id, kind: 'transfer', online: true,
    number: p.shopify_transfer_name || p.transfer_no || '',
    picked: !!p.picked_at, delivered: false, doneAt: p.picked_at || null, items: p.items,
  });
  return stops.map(({ rawDeliver, rawPickup, rawOnline, ...st }) => {
    const deliver = rawDeliver.map(view);
    const pickup = [...rawOnline.map(onlineView), ...rawPickup.map(view)];
    const out = {
      ...st, deliver, pickup, taskIds: [...rawDeliver, ...rawPickup].map(w => w.id),
      onlineTransferIds: rawOnline.map(p => p.transfer_id),
      hasDeliver: deliver.length > 0,
      hasPickup: pickup.length > 0,
      delivered: deliver.length > 0 && deliver.every(t => t.delivered),
      pickedUp: pickup.length > 0 && pickup.every(t => t.picked),
    };
    // When the stop was finished (latest mark of its tasks) — the Delivery
    // page moves the truck to the stop after the one finished last.
    const done = (!out.hasDeliver || out.delivered) && (!out.hasPickup || out.pickedUp);
    const times = [...deliver, ...pickup].map(t => t.doneAt).filter(Boolean).map(t => new Date(t).toISOString());
    return { ...out, doneAt: done && times.length ? times.sort().pop() : null };
  });
}

// All stops of a day, Online pickups included (Delivery page, integration).
async function stopsForDay(day, { withOnline = true } = {}) {
  const [rows, online] = await Promise.all([loadDeliveryRows(day), withOnline ? loadOnlinePickups(day) : []]);
  return buildStops(rows, online);
}

const stopIsDone = (st) => (!st.hasDeliver || st.delivered) && (!st.hasPickup || st.pickedUp);
// The truck's stop: the first unfinished stop after the stop finished last
// (stops may be done out of order); none after it → first unfinished.
function truckStopKey(stops) {
  let last = -1; let lastAt = '';
  stops.forEach((st, i) => { if (st.doneAt && st.doneAt > lastAt) { lastAt = st.doneAt; last = i; } });
  const next = (last >= 0 && stops.slice(last + 1).find(st => !stopIsDone(st))) || stops.find(st => !stopIsDone(st));
  return next ? next.key : null;
}

// GET /api/warehouse/delivery → { today, stops: [...] }
router.get('/delivery', async (req, res) => {
  try {
    const today = torontoToday();
    res.json({ today, stops: await stopsForDay(today) });
  } catch (e) {
    console.error('GET /api/warehouse/delivery error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/warehouse/delivery/done { half, location, action: 'deliver' | 'pickup' }
// → { done: n, failed: [{ number, error }], stops }
router.post('/delivery/done', async (req, res) => {
  // key = the stop's key from GET /delivery (a store can have two stops in
  // one half-day since 2026-10-23); half + location still accepted.
  const { key, half, location, action } = req.body || {};
  if (!['deliver', 'pickup'].includes(action) || !(key || (['AM', 'PM'].includes(half) && location))) {
    return res.status(400).json({ error: 'key (or half and location) and action are required' });
  }
  try {
    const today = torontoToday();
    const all = await loadDeliveryRows(today);
    const online = await loadOnlinePickups(today);
    const stop = buildStops(all, online).find(st => (key ? st.key === key : st.half === half && st.location === location));
    if (!stop) return res.status(404).json({ error: 'This stop is not on today\'s schedule any more. Reload the page.' });
    const inStop = new Set(stop.taskIds);
    const rows = all.filter(w => inStop.has(w.id) && w.role === action
      && !(action === 'deliver' ? w.delivered_at : w.picked_at));
    const failed = [];
    let done = 0;
    for (const w of rows) {
      const number = w.shopify_transfer_name || w.transfer_no || w.po_number || w.custom_title || String(w.id);
      try {
        if (w.kind === 'transfer') {
          const { dispatchOne } = require('./transfers'); // Shopify client lives there
          if (action === 'deliver') {
            if (w.tr_status === 'good_to_go') { await dispatchOne(w.transfer_id); w.tr_status = 'in_transit'; }
            if (w.tr_status === 'in_transit') {
              await pool.query(
                "UPDATE transfers SET status = 'receiving', delivered_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'in_transit'",
                [w.transfer_id]
              );
            }
          } else if (w.tr_status === 'good_to_go') {
            // Picked up = In Transit: store → HQ, and (2026-10-23, Hera) also
            // part 1 of a store → store transfer.
            await dispatchOne(w.transfer_id);
          }
        }
        await pool.query(
          `UPDATE wh_tasks SET ${action === 'deliver' ? 'delivered_at' : 'picked_at'} = NOW(), updated_at = NOW() WHERE id = $1`,
          [w.id]
        );
        done++;
      } catch (e) {
        failed.push({ number, error: e.message });
      }
    }
    // Online (Fulfiller) pickups of this stop (2026-10-23, Hera): Picked Up
    // takes them Preparing → Ready to Ship (if the store hasn't) → In Transit.
    if (action === 'pickup') {
      const { onlineReadyToShip, dispatchOne } = require('./transfers');
      const pickedOnline = [];
      for (const p of online.filter(x => stop.onlineTransferIds.includes(x.transfer_id) && !x.picked_at)) {
        const number = p.shopify_transfer_name || p.transfer_no || String(p.transfer_id);
        try {
          if (p.tr_status === 'loading') { await onlineReadyToShip(p.transfer_id); p.tr_status = 'good_to_go'; }
          if (p.tr_status === 'good_to_go') await dispatchOne(p.transfer_id);
          await pool.query('UPDATE wh_online_pickups SET picked_at = NOW() WHERE transfer_id = $1', [p.transfer_id]);
          pickedOnline.push(p.transfer_id);
          done++;
        } catch (e) {
          failed.push({ number: `Online ${number}`, error: e.message });
        }
      }
      // 2026-10-24 (Fulfiller B4): transfer.picked_up message. Never fails.
      if (pickedOnline.length) await require('./onlineTransfers').notifyPickedUp(pickedOnline);
    }
    // End of the day (2026-10-23, Hera): once EVERY stop of today is done the
    // truck heads back to HQ → today's store → HQ transfers that were picked
    // up (In Transit) become Receiving, like a "Delivered" at HQ.
    let stops = await stopsForDay(today);
    let backAtHq = 0;
    const allDone = stops.length > 0 && stops.every(st => (!st.hasDeliver || st.delivered) && (!st.hasPickup || st.pickedUp));
    if (allDone) {
      const r = await pool.query(
        `UPDATE transfers t SET status = 'receiving', delivered_at = NOW(), updated_at = NOW()
          WHERE t.status = 'in_transit' AND t.to_location = $2
            AND EXISTS (SELECT 1 FROM wh_tasks w WHERE w.transfer_id = t.id AND w.kind = 'transfer'
                         AND w.leg IS NULL AND w.removed_at IS NULL AND w.sched_date = $1::date)`,
        [today, HQ]
      );
      backAtHq = r.rowCount;
      if (backAtHq) stops = await stopsForDay(today);
    }
    res.json({ done, failed, backAtHq, stops });
  } catch (e) {
    console.error('POST /api/warehouse/delivery/done error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Warehouse user groups (2026-10-23, Hera) ────────────────────────────────
// Up to 3 groups; each = a name + the Warehouse tabs it may open (Settings is
// one of the choices). A Shopify account picks a group the first time it
// enters Warehouse and keeps it until "Reset User" (or the group is deleted).
// No groups → everybody sees everything. Like accountMemory.js these routes
// never answer 401: no account → { identified: false } and the page falls
// back to localStorage.
const { getAccountId } = require('../accountAuth');
const WH_GROUP_TABS = ['schedule', 'receive-shipments', 'hq-transfers', 'delivery', 'settings'];
const WH_GROUPS_MAX = 3;

async function readWhGroups() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'wh_user_groups'`);
  const v = r.rows[0] ? r.rows[0].value : [];
  return Array.isArray(v) ? v : [];
}

router.get('/user-groups', async (req, res) => {
  try {
    res.json({ groups: await readWhGroups(), tabs: WH_GROUP_TABS, max: WH_GROUPS_MAX });
  } catch (e) {
    console.error('GET /api/warehouse/user-groups error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT { groups: [{ id?, name, tabs }] } — replaces the whole list. Kept ids
// stay (accounts keep their choice); new groups get new ids; accounts whose
// group was removed have to choose again.
router.put('/user-groups', async (req, res) => {
  try {
    const input = Array.isArray(req.body && req.body.groups) ? req.body.groups : null;
    if (!input) return res.status(400).json({ error: 'groups must be a list' });
    if (input.length > WH_GROUPS_MAX) return res.status(400).json({ error: `At most ${WH_GROUPS_MAX} groups.` });
    const current = await readWhGroups();
    let nextId = current.reduce((m, g) => Math.max(m, Number(g.id) || 0), 0) + 1;
    const seen = new Set();
    const out = [];
    for (const g of input) {
      const name = String((g && g.name) || '').trim();
      if (!name) return res.status(400).json({ error: 'Every group needs a name.' });
      if (name.length > 30) return res.status(400).json({ error: 'Group name is too long (max 30).' });
      if (seen.has(name.toLowerCase())) return res.status(400).json({ error: `Group name "${name}" is used twice.` });
      seen.add(name.toLowerCase());
      const tabs = WH_GROUP_TABS.filter(t => Array.isArray(g.tabs) && g.tabs.includes(t));
      if (tabs.length === 0) return res.status(400).json({ error: `Group "${name}" needs at least one tab.` });
      const id = current.some(c => Number(c.id) === Number(g.id)) ? Number(g.id) : nextId++;
      out.push({ id, name, tabs });
    }
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('wh_user_groups', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(out)]
    );
    const ids = out.map(g => g.id);
    await pool.query(`DELETE FROM wh_account_groups WHERE NOT (group_id = ANY($1::int[]))`, [ids]);
    res.json({ groups: out, tabs: WH_GROUP_TABS, max: WH_GROUPS_MAX });
  } catch (e) {
    console.error('PUT /api/warehouse/user-groups error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET → { identified, groupId } (groupId null when none / group gone)
router.get('/user-groups/my', async (req, res) => {
  try {
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, groupId: null });
    const r = await pool.query(`SELECT group_id FROM wh_account_groups WHERE account_id = $1`, [accountId]);
    const groups = await readWhGroups();
    const gid = r.rows[0] ? Number(r.rows[0].group_id) : null;
    res.json({ identified: true, groupId: gid && groups.some(g => Number(g.id) === gid) ? gid : null });
  } catch (e) {
    console.error('GET /api/warehouse/user-groups/my error:', e);
    res.json({ identified: false, groupId: null });
  }
});

// PUT { groupId }
router.put('/user-groups/my', async (req, res) => {
  try {
    const gid = parseInt(req.body && req.body.groupId, 10);
    const groups = await readWhGroups();
    if (!groups.some(g => Number(g.id) === gid)) return res.status(400).json({ error: 'Unknown group.' });
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, success: false });
    await pool.query(
      `INSERT INTO wh_account_groups (account_id, group_id, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (account_id) DO UPDATE SET group_id = $2, updated_at = NOW()`,
      [accountId, gid]
    );
    res.json({ identified: true, success: true });
  } catch (e) {
    console.error('PUT /api/warehouse/user-groups/my error:', e);
    res.json({ identified: false, success: false });
  }
});

// DELETE — "Reset User": forget this account's group.
router.delete('/user-groups/my', async (req, res) => {
  try {
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, success: false });
    await pool.query(`DELETE FROM wh_account_groups WHERE account_id = $1`, [accountId]);
    res.json({ identified: true, success: true });
  } catch (e) {
    console.error('DELETE /api/warehouse/user-groups/my error:', e);
    res.json({ identified: false, success: false });
  }
});

module.exports = router;
module.exports.torontoToday = torontoToday;
// Online (Fulfiller) integration (2026-10-23) — routes/onlineTransfers.js
module.exports.stopsForDay = stopsForDay;
module.exports.truckStopKey = truckStopKey;
module.exports.stopIsDone = stopIsDone;
module.exports.businessWindow = businessWindow;
