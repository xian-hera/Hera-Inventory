// Online (Fulfiller) transfers (2026-10-23, Hera) —
// claude/FULFILLER_ONLINE_TRANSFER_SPEC.md.
//
// Fulfiller (Hera's other Shopify app) creates a store → store transfer in
// Shopify for online orders and hands it to Hub. Hub:
//   • creates the transfer (source 'fulfiller', tag Online, status Preparing),
//     visible ONLY to the from-store (Store › Transfers), WH › Delivery and
//     Online › Transfer — never to Purchasing, the WH Schedule or the to-store;
//   • puts ONE pickup on WH › Delivery at the stop Fulfiller chose;
//   • the store prepares (any qty, no Reviewing) → Ready to Ship; the driver's
//     Picked Up → In Transit. Hub's part ends there.
//   • if WH changes the Schedule so that stop no longer exists (removed, or
//     moved to another half-day / day) Hub tells Fulfiller (webhook) which
//     transfers need a new stop.
//
// Two routers:
//   integrationRouter → /api/integration     (server-to-server, Fulfiller;
//                       header X-Hub-Integration-Key = env HUB_INTEGRATION_KEY)
//   adminRouter       → /api/online-transfers (Hub's own pages)

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../database/init');
const { getShopify, getSession } = require('../shopify');

const HQ = 'HQ';
const ONLINE_TAG = 'Online';
const LIVE_STATUSES = ['loading', 'good_to_go', 'in_transit'];

// ─── helpers ─────────────────────────────────────────────────────────────────

function tx() { return require('./transfers'); }   // lazy: avoids a require cycle
function wh() { return require('./warehouse'); }

async function shopifyClient() {
  const session = await getSession();
  if (!session) throw new Error('No Shopify session');
  const shopify = getShopify();
  return new shopify.clients.Graphql({ session });
}

function shopHandle() { return (process.env.SHOP || '').replace(/\.myshopify\.com$/, ''); }
function adminUrl(kind, gid) {
  const m = /\/(\d+)$/.exec(gid || '');
  const h = shopHandle();
  return m && h ? `https://admin.shopify.com/store/${h}/${kind}/${m[1]}` : null;
}

const numericId = (gid) => { const m = /(\d+)$/.exec(String(gid || '')); return m ? m[1] : null; };

// location_map: Shopify location id → Hub location name
async function locationNameFor(locationGid, fallbackName) {
  const id = numericId(locationGid);
  const r = await pool.query('SELECT location_name, shopify_location_id FROM location_map');
  const hit = r.rows.find(x => numericId(x.shopify_location_id) === id);
  return hit ? hit.location_name : (fallbackName || null);
}

// Business days the integration may plan on: today and the next business day.
function planDays() {
  const { torontoToday, businessWindow } = wh();
  const today = torontoToday();
  const win = businessWindow(today);
  return { today, days: win.slice(0, 2) };
}

function stopKeyOf(p) { return p.occurrence > 1 ? `${p.half}|${p.location}|${p.occurrence}` : `${p.half}|${p.location}`; }
function parseStopKey(key) {
  const [half, location, occ] = String(key || '').split('|');
  if (!['AM', 'PM'].includes(half) || !location) return null;
  const occurrence = occ ? parseInt(occ, 10) : 1;
  if (!occurrence || occurrence < 1) return null;
  return { half, location, occurrence };
}

// ─── schedule (interface A) ─────────────────────────────────────────────────

async function scheduleView() {
  const { stopsForDay, truckStopKey, stopIsDone } = wh();
  const { today, days } = planDays();
  const out = [];
  for (const date of days) {
    const stops = await stopsForDay(date);
    const truck = date === today ? truckStopKey(stops) : null;
    const isToday = date === today;
    const view = (st, i) => ({
      key: st.key,
      position: i + 1,
      location: st.location,
      done: isToday ? stopIsDone(st) : false,
      truckHere: truck === st.key,
      hasDelivery: st.hasDeliver,
      hasPickup: st.hasPickup,
      onlineTransfers: (st.pickup || []).filter(t => t.online).map(t => t.transferId),
    });
    const list = stops.map(view);
    out.push({
      date,
      isToday,
      truckStopKey: truck,
      AM: list.filter(x => x.key.startsWith('AM|')),
      PM: list.filter(x => x.key.startsWith('PM|')),
    });
  }
  return { today, days: out };
}

// ─── import a Shopify transfer (interface B) ────────────────────────────────

async function readShopifyTransfer(client, transferGid) {
  const q = `
    query onlineTransfer($id: ID!) {
      inventoryTransfer(id: $id) {
        id name status
        origin { name location { id } }
        destination { name location { id } }
        lineItems(first: 250) { edges { node { id totalQuantity inventoryItem { id sku } } } }
      }
    }
  `;
  const data = await tx().shopifyGraphql(client, q, { id: transferGid });
  return data?.inventoryTransfer || null;
}

async function readVariants(client, variantIds) {
  if (variantIds.length === 0) return new Map();
  const q = `
    query onlineVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id title barcode sku
          inventoryItem { id }
          product {
            id title productType
            featuredMedia { preview { image { url } } }
            wigNumber: metafield(namespace: "custom", key: "wig_number") { value }
          }
        }
      }
    }
  `;
  const data = await tx().shopifyGraphql(client, q, { ids: variantIds });
  const map = new Map();
  (data?.nodes || []).filter(Boolean).forEach(n => map.set(n.id, n));
  return map;
}

// One transfer from Fulfiller: { shopifyTransferId, date, stopKey, reference,
// items: [{ variantId, inventoryItemId, quantity, orderId, orderName }] }
// → result { shopifyTransferId, status: 'accepted'|'reassigned'|'rejected', reason?, message?, hubTransferId? }
async function submitOne(t, ctx) {
  const shopifyTransferId = String(t && t.shopifyTransferId || '');
  const base = { shopifyTransferId };
  const reject = (reason, message) => ({ ...base, status: 'rejected', reason, message });
  if (!/^gid:\/\/shopify\/InventoryTransfer\/\d+$/.test(shopifyTransferId)) return reject('bad_request', 'shopifyTransferId must be an InventoryTransfer gid');
  if (!ctx.days.includes(t.date)) return reject('date_not_allowed', `date must be one of ${ctx.days.join(', ')}`);
  const anchor = parseStopKey(t.stopKey);
  if (!anchor) return reject('bad_request', 'stopKey is not a valid stop key');

  // the stop must exist on that day and (today) not be done yet
  const stops = ctx.stops[t.date];
  const st = stops.find(x => x.key === t.stopKey);
  if (!st) return reject('stop_not_found', `Stop ${t.stopKey} is not on the schedule of ${t.date}.`);
  if (t.date === ctx.today && wh().stopIsDone(st)) {
    return reject('stop_passed', `The truck already passed ${st.location} (${t.stopKey}). Re-assign the items to pick up there.`);
  }

  const existing = await pool.query('SELECT id, source, status, transfer_no FROM transfers WHERE shopify_transfer_id = $1', [shopifyTransferId]);
  if (existing.rows.length) {
    const row = existing.rows[0];
    if (row.source !== 'fulfiller') return reject('not_online_transfer', 'This Shopify transfer belongs to a normal Hub transfer.');
    const p = await pool.query(`SELECT *, to_char(pickup_date, 'YYYY-MM-DD') AS day FROM wh_online_pickups WHERE transfer_id = $1`, [row.id]);
    if (p.rows[0] && p.rows[0].picked_at) return reject('already_picked_up', 'Already picked up — nothing to change.');
    // 2026-10-24 (Fulfiller B/A4): the same transfer sent again for the stop it
    // already has (a retry after a lost answer) → the same "accepted" answer.
    const cur = p.rows[0];
    if (cur && !cur.needs_reassign_at && cur.day === t.date && cur.half === anchor.half
        && cur.location === anchor.location && Number(cur.occurrence) === anchor.occurrence) {
      return { ...base, status: 'accepted', hubTransferId: row.id, transferNo: row.transfer_no };
    }
    const fromLoc = (await pool.query('SELECT from_location FROM transfers WHERE id = $1', [row.id])).rows[0].from_location;
    if (fromLoc !== anchor.location) return reject('location_mismatch', `The transfer is from ${fromLoc}, the stop is ${anchor.location}.`);
    await pool.query(
      `INSERT INTO wh_online_pickups (transfer_id, pickup_date, half, location, occurrence, placed_at)
       VALUES ($1, $2::date, $3, $4, $5, NOW())
       ON CONFLICT (transfer_id) DO UPDATE SET pickup_date = EXCLUDED.pickup_date, half = EXCLUDED.half, location = EXCLUDED.location,
         occurrence = EXCLUDED.occurrence, placed_at = NOW(), needs_reassign_at = NULL, reassign_reason = NULL`,
      [row.id, t.date, anchor.half, anchor.location, anchor.occurrence]
    );
    return { ...base, status: 'reassigned', hubTransferId: row.id, transferNo: row.transfer_no };
  }

  // read the transfer + its products from Shopify
  const client = await ctx.client();
  const sTr = await readShopifyTransfer(client, shopifyTransferId);
  if (!sTr) return reject('shopify_transfer_not_found', 'Shopify transfer not found.');
  const fromName = await locationNameFor(sTr.origin?.location?.id, sTr.origin?.name);
  const toName = await locationNameFor(sTr.destination?.location?.id, sTr.destination?.name);
  if (!fromName || fromName !== anchor.location) {
    return reject('location_mismatch', `The transfer is from ${fromName || sTr.origin?.name || '?'}, the stop is ${anchor.location}.`);
  }
  if (fromName === HQ || toName === HQ) return reject('not_store_to_store', 'Online transfers must be store → store.');
  const lines = (sTr.lineItems?.edges || []).map(e => e.node);
  if (lines.length === 0) return reject('empty_transfer', 'The Shopify transfer has no line items.');

  const items = Array.isArray(t.items) ? t.items : [];
  const variantIds = [...new Set(items.map(i => i.variantId).filter(Boolean))];
  const variants = await readVariants(client, variantIds);
  const variantByInv = new Map();
  variants.forEach(v => { if (v.inventoryItem?.id) variantByInv.set(v.inventoryItem.id, v); });

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const transferNo = await tx().generateTransferNo(db);
    const tr = (await db.query(
      `INSERT INTO transfers
         (transfer_no, shopify_transfer_id, shopify_transfer_name, shopify_transfer_url, from_location, to_location,
          from_location_id, to_location_id, status, tags, source, fulfiller_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'loading', $9, 'fulfiller', $10) RETURNING id`,
      [transferNo, shopifyTransferId, sTr.name || null, tx().buildTransferAdminUrl(shopifyTransferId),
        fromName, toName, sTr.origin?.location?.id || null, sTr.destination?.location?.id || null,
        [ONLINE_TAG], t.reference ? String(t.reference) : null]
    )).rows[0];
    const itemIdByInv = new Map();
    for (const l of lines) {
      const invId = l.inventoryItem?.id;
      const v = variantByInv.get(invId);
      const p = v?.product || {};
      const hasVariants = v && v.title && v.title !== 'Default Title';
      const isWig = String(p.productType || '').toUpperCase() === 'WIG';
      const it = (await db.query(
        `INSERT INTO transfer_items
           (transfer_id, sku, name, quantity, requested_qty, inventory_item_id, variant_id, product_id,
            product_title, variant_title, product_type, image_url, wig_no)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [tr.id, (v && (v.barcode || v.sku)) || l.inventoryItem?.sku || null, p.title || null, Number(l.totalQuantity),
          invId, v?.id || null, p.id || null, p.title || null, hasVariants ? v.title : null, p.productType || null,
          p.featuredMedia?.preview?.image?.url || null, isWig ? (p.wigNumber?.value || null) : null]
      )).rows[0];
      itemIdByInv.set(invId, it.id);
    }
    // which order each unit is for (Fulfiller sends one row per order line)
    for (const i of items) {
      const inv = i.inventoryItemId || (variants.get(i.variantId)?.inventoryItem?.id);
      const itemId = itemIdByInv.get(inv);
      if (!itemId) continue;
      await db.query(
        `INSERT INTO transfer_item_orders (transfer_id, transfer_item_id, order_id, order_name, quantity) VALUES ($1, $2, $3, $4, $5)`,
        [tr.id, itemId, i.orderId || null, i.orderName || null, Number(i.quantity) || 0]
      );
    }
    await db.query(
      `INSERT INTO wh_online_pickups (transfer_id, pickup_date, half, location, occurrence) VALUES ($1, $2::date, $3, $4, $5)`,
      [tr.id, t.date, anchor.half, anchor.location, anchor.occurrence]
    );
    await db.query('COMMIT');
    return { ...base, status: 'accepted', hubTransferId: tr.id, transferNo };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

// ─── stop gone → re-assign (called after WH changes the Schedule) ───────────

async function checkOnlineAnchors() {
  try {
    const { torontoToday, stopsForDay } = wh();
    const today = torontoToday();
    const r = await pool.query(
      `SELECT p.*, to_char(p.pickup_date, 'YYYY-MM-DD') AS day, t.shopify_transfer_id, t.shopify_transfer_name, t.fulfiller_ref
         FROM wh_online_pickups p JOIN transfers t ON t.id = p.transfer_id
        WHERE p.picked_at IS NULL AND p.needs_reassign_at IS NULL AND p.pickup_date >= $1::date`,
      [today]
    );
    if (r.rows.length === 0) return 0;
    const byDay = {};
    const lost = [];
    for (const p of r.rows) {
      if (!byDay[p.day]) byDay[p.day] = await stopsForDay(p.day, { withOnline: false });
      if (!byDay[p.day].some(st => st.key === stopKeyOf(p))) lost.push(p);
    }
    if (lost.length === 0) return 0;
    await pool.query(
      `UPDATE wh_online_pickups SET needs_reassign_at = NOW(), reassign_reason = 'stop_removed' WHERE transfer_id = ANY($1)`,
      [lost.map(p => p.transfer_id)]
    );
    await enqueue('pickup.reassign_needed', {
      transfers: lost.map(p => ({
        shopifyTransferId: p.shopify_transfer_id,
        shopifyTransferName: p.shopify_transfer_name,
        reference: p.fulfiller_ref,
        previousDate: p.day,
        previousStopKey: stopKeyOf(p),
        location: p.location,
        reason: 'stop_removed',
      })),
    });
    return lost.length;
  } catch (e) {
    console.error('checkOnlineAnchors failed:', e.message);
    return 0;
  }
}

// ─── webhook to Fulfiller (outbox + retries) ────────────────────────────────

async function enqueue(event, payload) {
  await pool.query('INSERT INTO integration_outbox (event, payload) VALUES ($1, $2::jsonb)', [event, JSON.stringify(payload)]);
  sendPending().catch(() => {});
}

// ─── more messages (2026-10-24, Fulfiller's FULFILLER_TO_HUB_REQUESTS.md) ───
// transfer.deleted (B2), transfer.items_changed (B3), transfer.picked_up (B4).

const HUB_STATUS_LABEL = { loading: 'Preparing', good_to_go: 'Ready to Ship', in_transit: 'In Transit', archived: 'Received' };
// What the Shopify transfer should be in, from Hub's own status.
const SHOPIFY_STATUS_OF = { loading: 'DRAFT', good_to_go: 'READY_TO_SHIP', in_transit: 'IN_PROGRESS' };

async function onlineSummary(transferId) {
  const r = await pool.query(
    `SELECT t.id, t.status, t.transfer_no, t.shopify_transfer_id, t.shopify_transfer_name, t.fulfiller_ref, t.from_location,
            p.half, p.location, p.occurrence, p.picked_at, p.needs_reassign_at, to_char(p.pickup_date, 'YYYY-MM-DD') AS day
       FROM transfers t LEFT JOIN wh_online_pickups p ON p.transfer_id = t.id
      WHERE t.id = $1 AND t.source = 'fulfiller'`,
    [transferId]
  );
  return r.rows[0] || null;
}
function summaryPayload(s) {
  return {
    shopifyTransferId: s.shopify_transfer_id,
    shopifyTransferName: s.shopify_transfer_name,
    reference: s.fulfiller_ref,
    location: s.location || s.from_location,
    date: s.day || null,
    stopKey: s.half ? stopKeyOf(s) : null,
    hubStatus: HUB_STATUS_LABEL[s.status] || s.status,
    shopifyTransferStatus: SHOPIFY_STATUS_OF[s.status] || null,
  };
}
function itemPayload(r, newQuantity) {
  return {
    orderId: r.orderId || null,
    orderName: r.orderName || null,
    variantId: r.variantId || null,
    inventoryItemId: r.inventoryItemId || null,
    requestedQuantity: r.requested,
    newQuantity,
  };
}

// cause 'ready_to_ship': called once the store's Ready to Ship (or the
// driver's Picked Up while Preparing) has set the loaded quantities; sent only
// when some order line got less than requested. Rows = one per order line, in
// the order Fulfiller sent them (earlier rows are filled first).
async function notifyReadyToShip(transferId) {
  try {
    const s = await onlineSummary(transferId);
    if (!s) return;
    const items = (await pool.query(
      `SELECT * FROM transfer_items WHERE transfer_id = $1 AND edit_state IS DISTINCT FROM 'removed' ORDER BY id`, [transferId]
    )).rows;
    const orders = (await pool.query('SELECT * FROM transfer_item_orders WHERE transfer_id = $1 ORDER BY id', [transferId])).rows;
    const rows = rowsFor(s, items, orders);
    if (!rows.some(r => r.picked != null && r.picked !== r.requested)) return;
    await enqueue('transfer.items_changed', {
      ...summaryPayload(s),
      cause: 'ready_to_ship',
      items: rows.map(r => itemPayload(r, r.picked == null ? r.requested : r.picked)),
    });
  } catch (e) {
    console.error('notifyReadyToShip failed:', e.message);
  }
}

async function notifyPickedUp(transferIds) {
  try {
    const list = [];
    for (const id of transferIds) {
      const s = await onlineSummary(id);
      if (s) list.push({ ...summaryPayload(s), pickedAt: s.picked_at });
    }
    if (list.length) await enqueue('transfer.picked_up', { transfers: list });
  } catch (e) {
    console.error('notifyPickedUp failed:', e.message);
  }
}

let sending = false;
async function sendPending() {
  const url = process.env.FULFILLER_WEBHOOK_URL;
  const key = process.env.HUB_INTEGRATION_KEY;
  if (!url || !key || sending) return;
  sending = true;
  try {
    const r = await pool.query(
      `SELECT * FROM integration_outbox WHERE delivered_at IS NULL AND next_attempt_at <= NOW() AND attempts < 50 ORDER BY id LIMIT 20`
    );
    for (const m of r.rows) {
      const body = JSON.stringify({ id: m.id, event: m.event, createdAt: m.created_at, data: m.payload });
      let error = null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Hub-Integration-Key': key, 'X-Hub-Event': m.event },
          body,
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e.message;
      }
      if (!error) {
        await pool.query('UPDATE integration_outbox SET delivered_at = NOW(), attempts = attempts + 1, last_error = NULL WHERE id = $1', [m.id]);
      } else {
        // 1, 2, 4 … minutes, at most 60
        const wait = Math.min(60, 2 ** Math.min(m.attempts, 6));
        await pool.query(
          `UPDATE integration_outbox SET attempts = attempts + 1, last_error = $2, next_attempt_at = NOW() + ($3 || ' minutes')::interval WHERE id = $1`,
          [m.id, error, String(wait)]
        );
      }
    }
  } catch (e) {
    console.error('integration outbox send failed:', e.message);
  } finally {
    sending = false;
  }
}
const timer = setInterval(() => { sendPending().catch(() => {}); }, 60 * 1000);
if (timer.unref) timer.unref();

// ─── integration router (Fulfiller) ─────────────────────────────────────────

const integrationRouter = express.Router();

integrationRouter.use((req, res, next) => {
  const expected = process.env.HUB_INTEGRATION_KEY || '';
  if (!expected) return res.status(503).json({ error: 'Integration is not configured on Hub (HUB_INTEGRATION_KEY).' });
  const got = String(req.get('X-Hub-Integration-Key') || '');
  const a = Buffer.from(got); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Bad integration key' });
  next();
});

// GET /api/integration/schedule
integrationRouter.get('/schedule', async (req, res) => {
  try {
    res.json(await scheduleView());
  } catch (e) {
    console.error('GET /api/integration/schedule error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/integration/online-transfers { transfers: [...] }
// Also used to give a transfer a new stop (after pickup.reassign_needed).
integrationRouter.post('/online-transfers', async (req, res) => {
  const list = Array.isArray(req.body && req.body.transfers) ? req.body.transfers : null;
  if (!list || list.length === 0) return res.status(400).json({ error: 'transfers must be a non-empty list' });
  try {
    const { today, days } = planDays();
    const { stopsForDay } = wh();
    const stops = {};
    for (const d of days) stops[d] = await stopsForDay(d);
    let clientPromise = null;
    const ctx = { today, days, stops, client: () => (clientPromise = clientPromise || shopifyClient()) };
    const results = [];
    for (const t of list) {
      try {
        results.push(await submitOne(t, ctx));
      } catch (e) {
        console.error('integration submit failed:', e);
        results.push({ shopifyTransferId: t && t.shopifyTransferId, status: 'rejected', reason: 'error', message: e.message });
      }
    }
    const anyRejected = results.some(r => r.status === 'rejected');
    res.json({ results, schedule: anyRejected ? await scheduleView() : undefined });
  } catch (e) {
    console.error('POST /api/integration/online-transfers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/integration/reassign-needed — backup for the webhook
integrationRouter.get('/reassign-needed', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.shopify_transfer_id, t.shopify_transfer_name, t.fulfiller_ref, p.location, p.half, p.occurrence,
              to_char(p.pickup_date, 'YYYY-MM-DD') AS day, p.needs_reassign_at, p.reassign_reason
         FROM wh_online_pickups p JOIN transfers t ON t.id = p.transfer_id
        WHERE p.needs_reassign_at IS NOT NULL AND p.picked_at IS NULL
        ORDER BY p.needs_reassign_at`
    );
    res.json({
      transfers: r.rows.map(p => ({
        shopifyTransferId: p.shopify_transfer_id,
        shopifyTransferName: p.shopify_transfer_name,
        reference: p.fulfiller_ref,
        previousDate: p.day,
        previousStopKey: stopKeyOf(p),
        location: p.location,
        reason: p.reassign_reason,
        since: p.needs_reassign_at,
      })),
    });
  } catch (e) {
    console.error('GET /api/integration/reassign-needed error:', e);
    res.status(500).json({ error: e.message });
  }
});

const GID_RE = /^gid:\/\/shopify\/InventoryTransfer\/\d+$/;
function transferList(req) {
  return Array.isArray(req.body && req.body.transfers) ? req.body.transfers : null;
}

// POST /api/integration/online-transfers/cancel  (2026-10-24, Fulfiller B1)
// { transfers: [{ shopifyTransferId, reason? }] } → per transfer
// cancelled | not_found | too_late | bad_request. Only while Preparing and
// not picked up. Hub removes its transfer + pickup; Shopify is not touched
// (Fulfiller deletes its draft). Safe to call again.
integrationRouter.post('/online-transfers/cancel', async (req, res) => {
  const list = transferList(req);
  if (!list || list.length === 0) return res.status(400).json({ error: 'transfers must be a non-empty list' });
  try {
    const results = [];
    for (const t of list) {
      const shopifyTransferId = String(t && t.shopifyTransferId || '');
      if (!GID_RE.test(shopifyTransferId)) { results.push({ shopifyTransferId, status: 'bad_request', message: 'shopifyTransferId must be an InventoryTransfer gid' }); continue; }
      const r = await pool.query(
        `SELECT t.id, t.status, p.picked_at FROM transfers t LEFT JOIN wh_online_pickups p ON p.transfer_id = t.id
          WHERE t.shopify_transfer_id = $1 AND t.source = 'fulfiller'`,
        [shopifyTransferId]
      );
      const row = r.rows[0];
      if (!row) { results.push({ shopifyTransferId, status: 'not_found' }); continue; }
      if (row.status !== 'loading' || row.picked_at) {
        results.push({ shopifyTransferId, status: 'too_late', hubStatus: HUB_STATUS_LABEL[row.status] || row.status });
        continue;
      }
      // re-check the status in the DELETE itself (the store may press Ready to Ship meanwhile)
      const d = await pool.query(`DELETE FROM transfers WHERE id = $1 AND status = 'loading' AND source = 'fulfiller'`, [row.id]);
      if (d.rowCount === 0) { results.push({ shopifyTransferId, status: 'too_late' }); continue; }
      console.log(`Online transfer ${shopifyTransferId} cancelled by Fulfiller (${t.reason || 'no reason'})`);
      results.push({ shopifyTransferId, status: 'cancelled' });
    }
    res.json({ results });
  } catch (e) {
    console.error('POST /api/integration/online-transfers/cancel error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/integration/online-transfers/received  (2026-10-24, Hera)
// { transfers: [{ shopifyTransferId }] } — Fulfiller finished receiving → the
// Hub transfer leaves Online › Transfer (status archived). Per transfer:
// done | not_found | not_in_transit | bad_request. Safe to call again.
integrationRouter.post('/online-transfers/received', async (req, res) => {
  const list = transferList(req);
  if (!list || list.length === 0) return res.status(400).json({ error: 'transfers must be a non-empty list' });
  try {
    const results = [];
    for (const t of list) {
      const shopifyTransferId = String(t && t.shopifyTransferId || '');
      if (!GID_RE.test(shopifyTransferId)) { results.push({ shopifyTransferId, status: 'bad_request', message: 'shopifyTransferId must be an InventoryTransfer gid' }); continue; }
      const r = await pool.query(`SELECT id, status FROM transfers WHERE shopify_transfer_id = $1 AND source = 'fulfiller'`, [shopifyTransferId]);
      const row = r.rows[0];
      if (!row) { results.push({ shopifyTransferId, status: 'not_found' }); continue; }
      if (row.status === 'archived') { results.push({ shopifyTransferId, status: 'done' }); continue; }
      if (row.status !== 'in_transit') {
        results.push({ shopifyTransferId, status: 'not_in_transit', hubStatus: HUB_STATUS_LABEL[row.status] || row.status });
        continue;
      }
      await pool.query(`UPDATE transfers SET status = 'archived', updated_at = NOW() WHERE id = $1`, [row.id]);
      results.push({ shopifyTransferId, status: 'done' });
    }
    res.json({ results });
  } catch (e) {
    console.error('POST /api/integration/online-transfers/received error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/integration/messages?since=<id>&limit=<n>  (2026-10-24)
// Every message Hub has made for Fulfiller (sent or not), oldest first —
// the polling backup for the webhook. Same { id, event, createdAt, data }.
integrationRouter.get('/messages', async (req, res) => {
  try {
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const r = await pool.query(
      'SELECT id, event, created_at, payload FROM integration_outbox WHERE id > $1 ORDER BY id LIMIT $2', [since, limit]
    );
    const messages = r.rows.map(m => ({ id: m.id, event: m.event, createdAt: m.created_at, data: m.payload }));
    res.json({ messages, lastId: messages.length ? messages[messages.length - 1].id : since, more: messages.length === limit });
  } catch (e) {
    console.error('GET /api/integration/messages error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── admin router (Hub pages: Online › Transfer) ────────────────────────────

const adminRouter = express.Router();

// GET /api/online-transfers → Preparing / Ready to Ship / In Transit
adminRouter.get('/', async (req, res) => {
  try {
    const tr = await pool.query(
      `SELECT t.id, t.transfer_no, t.shopify_transfer_id, t.shopify_transfer_name, t.shopify_transfer_url,
              t.from_location, t.to_location, t.status, t.created_at, t.fulfiller_ref,
              p.pickup_date, p.half, p.location AS pickup_location, p.occurrence, p.picked_at, p.needs_reassign_at
         FROM transfers t LEFT JOIN wh_online_pickups p ON p.transfer_id = t.id
        WHERE t.source = 'fulfiller' AND t.status = ANY($1)
        ORDER BY t.created_at DESC`,
      [LIVE_STATUSES]
    );
    if (tr.rows.length === 0) return res.json([]);
    const ids = tr.rows.map(r => r.id);
    const items = (await pool.query(
      `SELECT * FROM transfer_items WHERE transfer_id = ANY($1) AND edit_state IS DISTINCT FROM 'removed' ORDER BY id`, [ids]
    )).rows;
    const orders = (await pool.query(`SELECT * FROM transfer_item_orders WHERE transfer_id = ANY($1) ORDER BY id`, [ids])).rows;
    res.json(tr.rows.map(t => ({
      ...t,
      pickup_date: t.pickup_date ? new Date(t.pickup_date).toISOString().slice(0, 10) : null,
      rows: rowsFor(t, items.filter(i => i.transfer_id === t.id), orders.filter(o => o.transfer_id === t.id)),
    })));
  } catch (e) {
    console.error('GET /api/online-transfers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// One row per order line (Fulfiller splits by order). Picked qty of a line
// is shared out over its orders in order. Lines without order info → one row.
function rowsFor(t, items, orders) {
  const rows = [];
  for (const i of items) {
    const picked = i.loaded_confirmed && i.qty_loaded != null ? Number(i.qty_loaded) : null;
    const os = orders.filter(o => o.transfer_item_id === i.id);
    const list = os.length ? os : [{ id: null, order_id: null, order_name: null, quantity: Number(i.requested_qty != null ? i.requested_qty : i.quantity) }];
    let left = picked;
    for (const o of list) {
      const share = left == null ? null : Math.min(left, Number(o.quantity));
      if (left != null) left -= share;
      rows.push({
        rowId: o.id ? `o${o.id}` : `i${i.id}`,
        itemId: i.id,
        title: i.product_title || i.name || i.sku,
        productUrl: adminUrl('products', i.product_id),
        variant: i.variant_title || '',
        orderName: o.order_name,
        orderUrl: adminUrl('orders', o.order_id),
        // gids as Fulfiller sent them (used by transfer.items_changed)
        orderId: o.order_id,
        inventoryItemId: i.inventory_item_id,
        variantId: i.variant_id,
        requested: Number(o.quantity),
        picked: share,
      });
    }
  }
  return rows;
}

// DELETE /api/online-transfers/:id — gone from Hub (store, Delivery, this
// tab). Shopify is not touched. 2026-10-24 (Hera): allowed in every status,
// and Fulfiller is told with a transfer.deleted message (it deletes a DRAFT
// itself, anything later goes to a person on its Dashboard).
adminRouter.delete('/:id', async (req, res) => {
  try {
    const s = await onlineSummary(req.params.id);
    const r = await pool.query(`DELETE FROM transfers WHERE id = $1 AND source = 'fulfiller'`, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Online transfer not found' });
    if (s) await enqueue('transfer.deleted', { transfers: [summaryPayload(s)] });
    res.json({ deleted: true });
  } catch (e) {
    console.error('DELETE /api/online-transfers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/online-transfers/:id/ready-to-ship  (2026-10-24, Hera)
// For when the store forgot Ready to Ship. Same as the store's button: lines
// the store did not pick count as the requested qty.
adminRouter.post('/:id/ready-to-ship', async (req, res) => {
  try {
    const s = await onlineSummary(req.params.id);
    if (!s) return res.status(404).json({ error: 'Online transfer not found' });
    if (s.status !== 'loading') return res.status(400).json({ error: `This transfer is ${HUB_STATUS_LABEL[s.status] || s.status}, not Preparing.` });
    await tx().onlineReadyToShip(s.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/online-transfers/:id/ready-to-ship error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/online-transfers/:id/in-transit  (2026-10-24, Hera)
// For when the driver forgot Picked Up. Same as the driver's button:
// Preparing → Ready to Ship (if needed) → In Transit, the pickup counts as
// done (gone from Delivery / re-assign), Fulfiller gets transfer.picked_up.
adminRouter.post('/:id/in-transit', async (req, res) => {
  try {
    const s = await onlineSummary(req.params.id);
    if (!s) return res.status(404).json({ error: 'Online transfer not found' });
    if (!['loading', 'good_to_go'].includes(s.status)) {
      return res.status(400).json({ error: `This transfer is ${HUB_STATUS_LABEL[s.status] || s.status} already.` });
    }
    if (s.status === 'loading') await tx().onlineReadyToShip(s.id);
    await tx().dispatchOne(s.id);
    await pool.query('UPDATE wh_online_pickups SET picked_at = NOW() WHERE transfer_id = $1 AND picked_at IS NULL', [s.id]);
    await notifyPickedUp([s.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/online-transfers/:id/in-transit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/online-transfers/:id/delete-rows { rowIds: ['o12', 'i5', …] }
// Preparing: any row; the Shopify transfer line is lowered / removed.
// Ready to Ship / In Transit: only rows with picked qty 0 (nothing to change
// in Shopify — those units are not on the transfer any more).
adminRouter.post('/:id/delete-rows', async (req, res) => {
  const rowIds = Array.isArray(req.body && req.body.rowIds) ? req.body.rowIds.map(String) : [];
  if (rowIds.length === 0) return res.status(400).json({ error: 'Nothing selected' });
  try {
    const found = await tx().fetchTransferWithItems(req.params.id);
    if (!found || found.transfer.source !== 'fulfiller') return res.status(404).json({ error: 'Online transfer not found' });
    const { transfer } = found;
    if (!LIVE_STATUSES.includes(transfer.status)) return res.status(400).json({ error: 'This transfer can not be changed any more.' });
    const items = found.items.filter(i => i.edit_state !== 'removed');
    const orders = (await pool.query('SELECT * FROM transfer_item_orders WHERE transfer_id = $1 ORDER BY id', [transfer.id])).rows;
    const rows = rowsFor(transfer, items, orders);
    const chosen = rows.filter(r => rowIds.includes(r.rowId));
    if (chosen.length === 0) return res.status(400).json({ error: 'Rows not found' });
    if (transfer.status !== 'loading' && chosen.some(r => r.picked !== 0)) {
      return res.status(400).json({ error: 'After Ready to Ship only rows with Picked Qty 0 can be deleted.' });
    }
    // new requested qty per line
    const newQty = new Map(items.map(i => [i.id, Number(i.requested_qty != null ? i.requested_qty : i.quantity)]));
    chosen.forEach(r => newQty.set(r.itemId, newQty.get(r.itemId) - r.requested));
    if (transfer.status === 'loading') {
      const client = await shopifyClient();
      const changed = items.filter(i => newQty.get(i.id) !== Number(i.requested_qty != null ? i.requested_qty : i.quantity));
      const toRemove = changed.filter(i => newQty.get(i.id) <= 0);
      const toLower = changed.filter(i => newQty.get(i.id) > 0);
      if (toLower.length) {
        const m = `
          mutation inventoryTransferSetItems($input: InventoryTransferSetItemsInput!, $idempotencyKey: String!) {
            inventoryTransferSetItems(input: $input) @idempotent(key: $idempotencyKey) {
              inventoryTransfer { id }
              userErrors { field message }
            }
          }
        `;
        const d = await tx().shopifyGraphql(client, m, {
          input: { id: transfer.shopify_transfer_id, lineItems: toLower.map(i => ({ inventoryItemId: i.inventory_item_id, quantity: newQty.get(i.id) })) },
          idempotencyKey: crypto.randomUUID(),
        });
        const errs = d?.inventoryTransferSetItems?.userErrors || [];
        if (errs.length) return res.status(400).json({ error: errs.map(e => e.message).join('; ') });
      }
      if (toRemove.length) {
        const m = `
          mutation inventoryTransferRemoveItems($input: InventoryTransferRemoveItemsInput!, $idempotencyKey: String!) {
            inventoryTransferRemoveItems(input: $input) @idempotent(key: $idempotencyKey) {
              inventoryTransfer { id }
              userErrors { field message }
            }
          }
        `;
        const d = await tx().shopifyGraphql(client, m, {
          input: { id: transfer.shopify_transfer_id, lineItems: toRemove.map(i => ({ inventoryItemId: i.inventory_item_id, quantity: Number(i.quantity) })) },
          idempotencyKey: crypto.randomUUID(),
        });
        const errs = d?.inventoryTransferRemoveItems?.userErrors || [];
        if (errs.length) return res.status(400).json({ error: errs.map(e => e.message).join('; ') });
      }
    }
    // Hub side
    const orderIds = chosen.filter(r => r.rowId.startsWith('o')).map(r => Number(r.rowId.slice(1)));
    if (orderIds.length) await pool.query('DELETE FROM transfer_item_orders WHERE id = ANY($1)', [orderIds]);
    for (const i of items) {
      const q = newQty.get(i.id);
      const before = Number(i.requested_qty != null ? i.requested_qty : i.quantity);
      if (q === before) continue;
      if (q <= 0) await pool.query('DELETE FROM transfer_items WHERE id = $1', [i.id]);
      else if (transfer.status === 'loading') await pool.query('UPDATE transfer_items SET requested_qty = $1, quantity = $1 WHERE id = $2', [q, i.id]);
      else await pool.query('UPDATE transfer_items SET requested_qty = $1 WHERE id = $2', [q, i.id]);
    }
    // 2026-10-24 (Fulfiller B3): while Preparing the Shopify lines changed →
    // tell Fulfiller which order lines went to 0. (After Ready to Ship these
    // rows were already 0 and already reported with cause ready_to_ship.)
    if (transfer.status === 'loading') {
      const s = await onlineSummary(transfer.id);
      if (s) {
        await enqueue('transfer.items_changed', {
          ...summaryPayload(s),
          cause: 'admin_edit',
          items: chosen.map(r => itemPayload(r, 0)),
        });
      }
    }
    res.json({ deleted: chosen.length });
  } catch (e) {
    console.error('POST /api/online-transfers/:id/delete-rows error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = {
  integrationRouter, adminRouter, checkOnlineAnchors, scheduleView, rowsFor, sendPending,
  // 2026-10-24: messages sent from transfers.js / warehouse.js
  notifyReadyToShip, notifyPickedUp,
};
