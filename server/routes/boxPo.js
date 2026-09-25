const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// BOX PO feature — Buyer creates a task (Supplier/optional Date + a list of
// Destination Location/BOX qty rows; total_boxes is derived from that list,
// not entered separately), publishes it (status: incoming). From there,
// either Warehouse OR the Buyer can count what actually arrived per location
// and submit (status: received) — the /:id/count and /:id/submit endpoints
// below don't distinguish who calls them. Buyer then reviews and confirms
// (status: confirmed). Purely internal to this app — no Shopify API calls
// anywhere in this file. See claude/BOX_PO_FEATURE_SPEC.md in the project's
// Claude knowledge base for the full narrated spec every endpoint below
// implements (note: that doc predates the Buyer-can-also-count change and
// the single-step Create flow, both from 2026-09-25).
//
// IMPORTANT — route registration order: GET '/:id' below must stay AFTER
// every other GET route with a fixed path (recent/ongoing/past/warehouse/home)
// — Express matches routes in registration order, so a fixed-path GET
// registered after '/:id' would never be reached (it would match '/:id'
// first, with the fixed segment treated as the id). This bit us once already
// in transfers.js — see that file's comment for the same lesson.

const PAST_RETENTION_DAYS = 90;
const RECENT_LIMIT = 30;

async function generateBoxPoNumber(client) {
  const result = await client.query('SELECT last_number, last_letter FROM box_po_number_counter WHERE id = 1 FOR UPDATE');
  let { last_number, last_letter } = result.rows[0];

  last_number += 1;
  if (last_number > 9999) {
    last_number = 0;
    last_letter = String.fromCharCode(last_letter.charCodeAt(0) + 1);
  }

  await client.query(
    'UPDATE box_po_number_counter SET last_number = $1, last_letter = $2 WHERE id = 1',
    [last_number, last_letter]
  );

  return `BOX_${last_letter}${String(last_number).padStart(4, '0')}`;
}

async function fetchBoxPoWithItems(id) {
  const boxPoRes = await pool.query('SELECT * FROM box_pos WHERE id = $1', [id]);
  if (boxPoRes.rows.length === 0) return null;
  const itemsRes = await pool.query('SELECT * FROM box_po_items WHERE box_po_id = $1 ORDER BY id ASC', [id]);
  return { boxPo: boxPoRes.rows[0], items: itemsRes.rows };
}

// Deletes confirmed BOX POs whose confirmed_at is older than the 90-day
// retention window. Lazy cleanup (no cron job) — run on every read of the
// lists that would show confirmed records (recent/past), same pattern
// po_invoices uses for its 200-row retention (cleaned up on commit, not on
// a schedule).
async function cleanupExpiredConfirmed() {
  await pool.query(
    `DELETE FROM box_pos WHERE status = 'confirmed' AND confirmed_at < NOW() - INTERVAL '${PAST_RETENTION_DAYS} days'`
  );
}

// POST /api/box-po — Create BOX PO's "Create" button (publish).
// body: { supplierId, date, note, items: [{ location, boxQty }] }
// total_boxes is no longer collected from the Buyer (Create BOX PO's
// simplified single-step flow, 2026-09-25, Hera) — it's computed here as the
// sum of the submitted line items' boxQty, which also happens to retire the
// old "Total BOXES doesn't match the line items" mismatch case entirely,
// since the two can no longer disagree.
router.post('/', async (req, res) => {
  const { supplierId, date, note, items } = req.body;

  if (!supplierId) return res.status(400).json({ error: 'Supplier is required' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one line item is required' });
  }
  const totalBoxesNum = items.reduce((sum, item) => {
    const qty = Number(item.boxQty);
    return sum + (Number.isFinite(qty) && qty > 0 ? qty : 0);
  }, 0);

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const supplierRes = await dbClient.query('SELECT id, name FROM po_suppliers WHERE id = $1', [supplierId]);
    if (supplierRes.rows.length === 0) {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'Supplier not found' });
    }
    const supplier = supplierRes.rows[0];

    const boxPoNumber = await generateBoxPoNumber(dbClient);
    const boxPoRes = await dbClient.query(
      `INSERT INTO box_pos (box_po_number, supplier_id, supplier_name, total_boxes, box_date, buyer_note, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'incoming')
       RETURNING *`,
      [boxPoNumber, supplier.id, supplier.name, totalBoxesNum, date || null, note || null]
    );
    const boxPo = boxPoRes.rows[0];

    for (const item of items) {
      const qty = Number(item.boxQty);
      // Defense in depth — the frontend already floors CSV/manual entry at 0,
      // but guard here too so a negative box_qty can never land in the DB.
      if (!item.location || !Number.isFinite(qty) || qty < 0) continue;
      await dbClient.query(
        `INSERT INTO box_po_items (box_po_id, location, box_qty) VALUES ($1, $2, $3)`,
        [boxPo.id, item.location, qty]
      );
    }

    await dbClient.query('COMMIT');
    res.json({ success: true, boxPo });
  } catch (e) {
    await dbClient.query('ROLLBACK');
    console.error('POST /api/box-po error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// GET /api/box-po/recent — BOX PO home page's last-30-confirmed list.
router.get('/recent', async (req, res) => {
  try {
    await cleanupExpiredConfirmed();
    const result = await pool.query(
      `SELECT * FROM box_pos WHERE status = 'confirmed' ORDER BY confirmed_at DESC LIMIT $1`,
      [RECENT_LIMIT]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/box-po/recent error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/box-po/ongoing — Ongoing BOX PO page: everything not yet confirmed.
router.get('/ongoing', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, EXISTS (
         SELECT 1 FROM box_po_items i
         WHERE i.box_po_id = b.id AND i.counted_confirmed AND i.box_received != i.box_qty
       ) AS has_mismatch
       FROM box_pos b
       WHERE b.status != 'confirmed'
       ORDER BY b.created_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/box-po/ongoing error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/box-po/past — Past BOX PO page: all confirmed within the 90-day window.
router.get('/past', async (req, res) => {
  try {
    await cleanupExpiredConfirmed();
    const result = await pool.query(
      `SELECT * FROM box_pos WHERE status = 'confirmed' ORDER BY confirmed_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/box-po/past error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/box-po/warehouse/home — Warehouse home's BOX PO section: only
// Incoming tasks. Once a task becomes Received it disappears from here.
router.get('/warehouse/home', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM box_pos WHERE status = 'incoming' ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/box-po/warehouse/home error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/box-po/confirm-selected — Ongoing BOX PO's bulk Confirm.
// Rows that aren't 'received' are skipped (with a per-row error) — same
// behavior as Transfer's Commit selected.
router.post('/confirm-selected', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids is required' });

  const results = [];
  for (const id of ids) {
    try {
      const boxPoRes = await pool.query('SELECT * FROM box_pos WHERE id = $1', [id]);
      const boxPo = boxPoRes.rows[0];
      if (!boxPo) { results.push({ id, success: false, error: 'Not found' }); continue; }
      if (boxPo.status !== 'received') {
        results.push({ id, success: false, error: `Cannot confirm a task that is still ${boxPo.status}` });
        continue;
      }
      await pool.query(`UPDATE box_pos SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`, [id]);
      results.push({ id, success: true });
    } catch (e) {
      results.push({ id, success: false, error: e.message });
    }
  }
  res.json({ results });
});

// POST /api/box-po/delete-selected — Ongoing/Past BOX PO's bulk Delete.
// Any status can be deleted (Delete selected is offered on both pages
// regardless of status).
router.post('/delete-selected', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids is required' });
  try {
    await pool.query('DELETE FROM box_pos WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/box-po/delete-selected error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/box-po/:id — detail (Buyer incoming/received/confirmed views,
// Warehouse counting page). Must stay after all the fixed-path GET routes
// above (see file-level comment).
router.get('/:id', async (req, res) => {
  try {
    const found = await fetchBoxPoWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'BOX PO not found' });
    res.json({ boxPo: found.boxPo, items: found.items });
  } catch (e) {
    console.error('GET /api/box-po/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/box-po/:id/note — { role: 'buyer'|'warehouse', text }
// Buyer note and Warehouse note are two independent fields (unlike
// Transfer's single shared note) — each role can have at most 1 of their
// own, and both can exist at the same time.
router.post('/:id/note', async (req, res) => {
  try {
    const { role, text } = req.body;
    if (role !== 'buyer' && role !== 'warehouse') return res.status(400).json({ error: 'Invalid role' });
    const trimmed = (text || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'Note text is required' });
    const column = role === 'buyer' ? 'buyer_note' : 'warehouse_note';
    const result = await pool.query(
      `UPDATE box_pos SET ${column} = $1 WHERE id = $2 RETURNING *`,
      [trimmed, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'BOX PO not found' });
    res.json({ boxPo: result.rows[0] });
  } catch (e) {
    console.error('POST /api/box-po/:id/note error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/box-po/:id/note — { role: 'buyer'|'warehouse' }
router.delete('/:id/note', async (req, res) => {
  try {
    const { role } = req.body;
    if (role !== 'buyer' && role !== 'warehouse') return res.status(400).json({ error: 'Invalid role' });
    const column = role === 'buyer' ? 'buyer_note' : 'warehouse_note';
    const result = await pool.query(
      `UPDATE box_pos SET ${column} = NULL WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'BOX PO not found' });
    res.json({ boxPo: result.rows[0] });
  } catch (e) {
    console.error('DELETE /api/box-po/:id/note error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/box-po/:id/count — Warehouse's per-row check-button confirm.
// body: { itemId, boxReceived }
router.post('/:id/count', async (req, res) => {
  try {
    const { itemId, boxReceived } = req.body;
    const qty = Number(boxReceived);
    if (!Number.isFinite(qty)) return res.status(400).json({ error: 'boxReceived is required' });
    const result = await pool.query(
      `UPDATE box_po_items SET box_received = $1, counted_confirmed = TRUE
       WHERE id = $2 AND box_po_id = $3 RETURNING *`,
      [qty, itemId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Line item not found' });
    res.json({ item: result.rows[0] });
  } catch (e) {
    console.error('POST /api/box-po/:id/count error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/box-po/:id/submit — Warehouse's Submit button.
// Requires every line item to already be counted_confirmed. Flips status
// incoming -> received; the task disappears from the Warehouse home list.
router.post('/:id/submit', async (req, res) => {
  try {
    const found = await fetchBoxPoWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'BOX PO not found' });
    if (found.boxPo.status !== 'incoming') {
      return res.status(400).json({ error: `Cannot submit a task that is already ${found.boxPo.status}` });
    }
    const unconfirmed = found.items.filter(i => !i.counted_confirmed);
    if (unconfirmed.length > 0) {
      return res.status(400).json({ error: 'Every location must be counted before submitting' });
    }
    const result = await pool.query(
      `UPDATE box_pos SET status = 'received', received_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json({ boxPo: result.rows[0] });
  } catch (e) {
    console.error('POST /api/box-po/:id/submit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/box-po/:id/confirm — Buyer's Confirm button (single task).
router.post('/:id/confirm', async (req, res) => {
  try {
    const boxPoRes = await pool.query('SELECT * FROM box_pos WHERE id = $1', [req.params.id]);
    const boxPo = boxPoRes.rows[0];
    if (!boxPo) return res.status(404).json({ error: 'BOX PO not found' });
    if (boxPo.status !== 'received') {
      return res.status(400).json({ error: `Cannot confirm a task that is still ${boxPo.status}` });
    }
    const result = await pool.query(
      `UPDATE box_pos SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json({ boxPo: result.rows[0] });
  } catch (e) {
    console.error('POST /api/box-po/:id/confirm error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
