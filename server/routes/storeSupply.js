// Store Supply API (2026-11-09, Hera — claude/STORE_SUPPLY_SPEC.md).
// Step 1: deadlines, Supply Management (groups / items), Inventory, and the
// Store's request page (draft / submit). Supply Requests, Shopping List and
// the Schedule tasks come in the next steps.
//
// WH:
//   GET    /settings                         → deadlines + switches
//   PUT    /settings/setup  { current, mode, weeks, next }   first use only
//   PUT    /settings/next   { mode, weeks, next }
//   GET    /items                            → { groups: [{ id, name, items: [...] }] }
//   POST   /groups { name } · PATCH /groups/:id { name } · DELETE /groups/:id · POST /groups/:id/move { dir }
//   POST   /items { groupId, name, packSize, max } · PATCH /items/:id { name?, packSize?, max?, inventory? }
//   DELETE /items/:id · POST /items/:id/move { dir }
// Store:
//   GET    /store?location=MTL01             → deadline, last submission, items, this cycle's request
//   PUT    /store/draft  { location, lines: [{ itemId, qty }] }
//   POST   /store/submit { location, lines: [{ itemId, qty }] }
const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const SS = require('../services/storeSupply');

const HQ = 'HQ';
const text = (v, max = 120) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const fail = (res, e, where) => { console.error(`${where} error:`, e); res.status(500).json({ error: e.message }); };

// Every answer starts from an up-to-date cycle.
router.use(async (req, res, next) => {
  try { await SS.rollCycle(); } catch (e) { console.error('store supply rollCycle failed:', e.message); }
  next();
});

async function settingsPayload() {
  const s = await SS.getSettings();
  return { today: SS.torontoToday(), setUp: !!s.current, current: s.current, next: s.next, mode: s.mode, weeks: SS.clampWeeks(s.weeks), useStock: s.useStock !== false };
}

// ── Deadlines ───────────────────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  try { res.json(await settingsPayload()); } catch (e) { fail(res, e, 'GET /api/store-supply/settings'); }
});

// Next from the body: Auto → Current + N weeks; Manual → the chosen date.
function nextFromBody(current, b) {
  const mode = b.mode === 'auto' ? 'auto' : 'manual';
  const weeks = SS.clampWeeks(b.weeks);
  if (mode === 'auto') return { mode, weeks, next: SS.addDays(current, weeks * 7), error: null };
  const next = String(b.next || '');
  return { mode, weeks, next, error: SS.nextError(current, next) };
}

router.put('/settings/setup', async (req, res) => {
  try {
    const s = await SS.getSettings();
    if (s.current) return res.status(409).json({ error: 'Deadlines are already set up.' });
    const b = req.body || {};
    const current = String(b.current || '');
    if (!SS.isoDate(current)) return res.status(400).json({ error: 'Choose the Current Deadline.' });
    if (current < SS.torontoToday()) return res.status(400).json({ error: 'The Current Deadline can’t be in the past.' });
    if (SS.isWeekend(current)) return res.status(400).json({ error: 'The Current Deadline can’t be on a weekend.' });
    const n = nextFromBody(current, b);
    if (n.error) return res.status(400).json({ error: n.error });
    await SS.saveSettings(pool, { ...s, current, next: n.next, mode: n.mode, weeks: n.weeks });
    await pool.query('INSERT INTO supply_deadlines (deadline) VALUES ($1::date) ON CONFLICT DO NOTHING', [current]);
    res.json(await settingsPayload());
  } catch (e) { fail(res, e, 'PUT /api/store-supply/settings/setup'); }
});

router.put('/settings/next', async (req, res) => {
  try {
    const s = await SS.getSettings();
    if (!s.current) return res.status(400).json({ error: 'Set up the deadlines first.' });
    const n = nextFromBody(s.current, req.body || {});
    if (n.error) return res.status(400).json({ error: n.error });
    await SS.saveSettings(pool, { ...s, next: n.next, mode: n.mode, weeks: n.weeks });
    res.json(await settingsPayload());
  } catch (e) { fail(res, e, 'PUT /api/store-supply/settings/next'); }
});

// ── Groups / items ──────────────────────────────────────────────────────────

async function loadGroups(db = pool) {
  const g = await db.query('SELECT id, name FROM supply_groups ORDER BY sort_order, id');
  const i = await db.query(
    `SELECT id, group_id, name, pack_size, max_qty, inventory_qty FROM supply_items ORDER BY sort_order, id`
  );
  const byGroup = new Map(g.rows.map(r => [r.id, { id: r.id, name: r.name, items: [] }]));
  i.rows.forEach(r => {
    const grp = byGroup.get(r.group_id);
    if (grp) grp.items.push({ id: r.id, groupId: r.group_id, name: r.name, packSize: r.pack_size || '', max: r.max_qty, inventory: r.inventory_qty });
  });
  return [...byGroup.values()];
}

router.get('/items', async (req, res) => {
  try { res.json({ groups: await loadGroups() }); } catch (e) { fail(res, e, 'GET /api/store-supply/items'); }
});

router.post('/groups', async (req, res) => {
  try {
    const name = text(req.body && req.body.name, 80);
    if (!name) return res.status(400).json({ error: 'Enter a group name.' });
    await pool.query(
      `INSERT INTO supply_groups (name, sort_order) VALUES ($1, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM supply_groups))`,
      [name]
    );
    res.json({ groups: await loadGroups() });
  } catch (e) { fail(res, e, 'POST /api/store-supply/groups'); }
});

router.patch('/groups/:id', async (req, res) => {
  try {
    const name = text(req.body && req.body.name, 80);
    if (!name) return res.status(400).json({ error: 'Enter a group name.' });
    await pool.query('UPDATE supply_groups SET name = $2 WHERE id = $1', [req.params.id, name]);
    res.json({ groups: await loadGroups() });
  } catch (e) { fail(res, e, 'PATCH /api/store-supply/groups/:id'); }
});

router.delete('/groups/:id', async (req, res) => {
  try {
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM supply_items WHERE group_id = $1', [req.params.id]);
    if (n.rows[0].n > 0) return res.status(409).json({ error: 'Empty the items in this group first.' });
    await pool.query('DELETE FROM supply_groups WHERE id = $1', [req.params.id]);
    res.json({ groups: await loadGroups() });
  } catch (e) { fail(res, e, 'DELETE /api/store-supply/groups/:id'); }
});

// Swap with the neighbour above (dir -1) / below (dir 1); the list is
// renumbered 0..n-1 first so old equal sort_orders can't get stuck.
async function moveInList(client, table, where, params, id, dir) {
  const rows = (await client.query(`SELECT id FROM ${table} WHERE ${where} ORDER BY sort_order, id`, params)).rows.map(r => r.id);
  const i = rows.indexOf(Number(id));
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  for (let k = 0; k < rows.length; k += 1) await client.query(`UPDATE ${table} SET sort_order = $2 WHERE id = $1`, [rows[k], k]);
}

router.post('/groups/:id/move', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await moveInList(client, 'supply_groups', 'TRUE', [], req.params.id, Number(req.body && req.body.dir));
    await client.query('COMMIT');
    res.json({ groups: await loadGroups() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e, 'POST /api/store-supply/groups/:id/move');
  } finally { client.release(); }
});

// max: '' / null → no limit; otherwise a whole number ≥ 1.
function parseMax(v) {
  if (v === '' || v === null || v === undefined) return { value: null };
  const n = posInt(v);
  return n ? { value: n } : { error: 'Max per Request must be a whole number of 1 or more (or empty).' };
}

router.post('/items', async (req, res) => {
  try {
    const b = req.body || {};
    const groupId = posInt(b.groupId);
    const name = text(b.name);
    if (!groupId) return res.status(400).json({ error: 'Choose a group.' });
    if (!name) return res.status(400).json({ error: 'Enter a name.' });
    const max = parseMax(b.max);
    if (max.error) return res.status(400).json({ error: max.error });
    const g = await pool.query('SELECT id FROM supply_groups WHERE id = $1', [groupId]);
    if (!g.rows.length) return res.status(400).json({ error: 'That group no longer exists.' });
    await pool.query(
      `INSERT INTO supply_items (group_id, name, pack_size, max_qty, sort_order)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM supply_items WHERE group_id = $1))`,
      [groupId, name, text(b.packSize, 60) || null, max.value]
    );
    res.json({ groups: await loadGroups() });
  } catch (e) { fail(res, e, 'POST /api/store-supply/items'); }
});

router.patch('/items/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    const params = [req.params.id];
    if ('name' in b) {
      const name = text(b.name);
      if (!name) return res.status(400).json({ error: 'The name can’t be empty.' });
      params.push(name); sets.push(`name = $${params.length}`);
    }
    if ('packSize' in b) { params.push(text(b.packSize, 60) || null); sets.push(`pack_size = $${params.length}`); }
    if ('max' in b) {
      const max = parseMax(b.max);
      if (max.error) return res.status(400).json({ error: max.error });
      params.push(max.value); sets.push(`max_qty = $${params.length}`);
    }
    if ('inventory' in b) {
      const n = Number(b.inventory);
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'Qty must be a whole number of 0 or more.' });
      params.push(n); sets.push(`inventory_qty = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    await pool.query(`UPDATE supply_items SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
    res.json({ groups: await loadGroups() });
  } catch (e) { fail(res, e, 'PATCH /api/store-supply/items/:id'); }
});

// Deleting an item takes it out of every Store draft; submitted requests
// keep their copy of its name / pack size.
router.delete('/items/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM supply_request_lines l USING supply_requests r
        WHERE l.request_id = r.id AND r.status = 'draft' AND l.item_id = $1`,
      [req.params.id]
    );
    await client.query('DELETE FROM supply_items WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ groups: await loadGroups() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e, 'DELETE /api/store-supply/items/:id');
  } finally { client.release(); }
});

router.post('/items/:id/move', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const it = await client.query('SELECT group_id FROM supply_items WHERE id = $1', [req.params.id]);
    if (it.rows.length) {
      await moveInList(client, 'supply_items', 'group_id = $1', [it.rows[0].group_id], req.params.id, Number(req.body && req.body.dir));
    }
    await client.query('COMMIT');
    res.json({ groups: await loadGroups() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e, 'POST /api/store-supply/items/:id/move');
  } finally { client.release(); }
});

// ── Store (MA) ──────────────────────────────────────────────────────────────

function storeLocation(req) {
  const loc = text((req.query && req.query.location) || (req.body && req.body.location), 40);
  return loc && loc !== HQ ? loc : null;
}

// The store's request for the current deadline (+ its lines). A draft is
// shown with the items' live name / pack size / max; quantities above a
// (lowered) Max are cut back and flagged `capped`.
async function storeView(location) {
  const s = await SS.getSettings();
  const groups = await loadGroups();
  const lastRes = await pool.query(
    `SELECT submitted_at, auto_submitted FROM supply_requests
      WHERE location = $1 AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 1`,
    [location]
  );
  const last = lastRes.rows[0] ? { at: lastRes.rows[0].submitted_at, auto: lastRes.rows[0].auto_submitted } : null;
  if (!s.current) return { setUp: false, groups, lastSubmission: last };
  const reqRes = await pool.query('SELECT * FROM supply_requests WHERE location = $1 AND deadline = $2::date', [location, s.current]);
  const r = reqRes.rows[0] || null;
  let lines = [];
  if (r) {
    const l = await pool.query(
      `SELECT l.id, l.item_id, l.item_name, l.pack_size, l.qty, i.name AS live_name, i.pack_size AS live_pack, i.max_qty
         FROM supply_request_lines l LEFT JOIN supply_items i ON i.id = l.item_id
        WHERE l.request_id = $1 ORDER BY l.sort_order, l.id`,
      [r.id]
    );
    if (r.status === 'draft') {
      for (const x of l.rows) {
        if (x.item_id == null) continue;
        let qty = x.qty;
        let capped = false;
        if (x.max_qty && qty > x.max_qty) {
          qty = x.max_qty; capped = true;
          await pool.query('UPDATE supply_request_lines SET qty = $2 WHERE id = $1', [x.id, qty]);
        }
        lines.push({ itemId: x.item_id, name: x.live_name, packSize: x.live_pack || '', max: x.max_qty, qty, capped });
      }
    } else {
      lines = l.rows.map(x => ({ itemId: x.item_id, name: x.item_name, packSize: x.pack_size || '', qty: x.qty }));
    }
  }
  return {
    setUp: true, today: SS.torontoToday(), deadline: s.current, groups, lastSubmission: last,
    request: r ? { status: r.status, submittedAt: r.submitted_at, lines } : { status: 'none', lines: [] },
  };
}

router.get('/store', async (req, res) => {
  try {
    const location = storeLocation(req);
    if (!location) return res.status(400).json({ error: 'location required' });
    res.json(await storeView(location));
  } catch (e) { fail(res, e, 'GET /api/store-supply/store'); }
});

// Save the draft (whole list); submit = save + submit. Lines: known items
// only, qty a whole number ≥ 1, cut back to the item's Max.
async function saveDraft(client, location, linesIn, submit) {
  const s = await SS.getSettings(client);
  if (!s.current) return { status: 400, error: 'Store Supply is not open yet.' };
  const ex = await client.query(
    'SELECT * FROM supply_requests WHERE location = $1 AND deadline = $2::date FOR UPDATE', [location, s.current]
  );
  if (ex.rows[0] && ex.rows[0].status !== 'draft') return { status: 409, error: 'You have already submitted a request for this cycle.' };
  const ids = [...new Set((Array.isArray(linesIn) ? linesIn : []).map(l => posInt(l && l.itemId)).filter(Boolean))];
  const items = ids.length ? (await client.query('SELECT id, name, pack_size, max_qty FROM supply_items WHERE id = ANY($1)', [ids])).rows : [];
  const byId = new Map(items.map(i => [i.id, i]));
  const lines = [];
  for (const l of (Array.isArray(linesIn) ? linesIn : [])) {
    const it = byId.get(posInt(l && l.itemId));
    if (!it || lines.some(x => x.item.id === it.id)) continue;
    let qty = posInt(l.qty);
    if (!qty) continue;
    if (it.max_qty && qty > it.max_qty) qty = it.max_qty;
    lines.push({ item: it, qty });
  }
  if (submit && lines.length === 0) return { status: 400, error: 'Add at least one item first.' };
  let id;
  if (ex.rows[0]) {
    id = ex.rows[0].id;
    await client.query('DELETE FROM supply_request_lines WHERE request_id = $1', [id]);
  } else {
    id = (await client.query(
      'INSERT INTO supply_requests (location, deadline) VALUES ($1, $2::date) RETURNING id', [location, s.current]
    )).rows[0].id;
  }
  for (let k = 0; k < lines.length; k += 1) {
    const { item, qty } = lines[k];
    await client.query(
      `INSERT INTO supply_request_lines (request_id, item_id, item_name, pack_size, qty, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, item.id, item.name, item.pack_size, qty, k]
    );
  }
  if (submit) {
    await client.query(`UPDATE supply_requests SET status = 'submitted', submitted_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
  } else {
    await client.query('UPDATE supply_requests SET updated_at = NOW() WHERE id = $1', [id]);
  }
  return null;
}

for (const [path, submit] of [['/store/draft', false], ['/store/submit', true]]) {
  router[submit ? 'post' : 'put'](path, async (req, res) => {
    const location = storeLocation(req);
    if (!location) return res.status(400).json({ error: 'location required' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('store_supply_cycle'))"); // not while a cycle closes
      const err = await saveDraft(client, location, req.body && req.body.lines, submit);
      if (err) { await client.query('ROLLBACK'); return res.status(err.status).json({ error: err.error }); }
      await client.query('COMMIT');
      res.json(await storeView(location));
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      fail(res, e, `${submit ? 'POST' : 'PUT'} /api/store-supply${path}`);
    } finally { client.release(); }
  });
}

SS.startCycleJob();

module.exports = router;
