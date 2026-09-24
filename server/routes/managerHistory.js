const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// Manager History — a frozen record of manager actions (Weekly Inventory
// Count submit, PO Receiving submit, Transfer received/sent), kept for 15
// days per location so a manager can look back at what they submitted after
// it leaves the live counting-task/PO-receiving/transfer list. See
// server/database/init.js's manager_history migration comment for the full
// rationale. This file only reads/deletes the table; every INSERT happens at
// the point of the manager's actual action, in tasks.js/poInvoices.js/
// transfers.js — see insertManagerHistory below, exported for those files to
// call.

const RETENTION_DAYS = 15;

// Writes one frozen history row. Callers wrap this in try/catch and only log
// on failure (never let a history-recording problem block the real action —
// same "secondary bookkeeping shouldn't break the primary flow" precedent as
// po_supplier_skus' write-back in poInvoices.js's commitInvoice).
async function insertManagerHistory({ kind, location, ref_no, label, summary, detail }) {
  await pool.query(
    `INSERT INTO manager_history (kind, location, ref_no, label, summary, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [kind, location, ref_no || null, label, JSON.stringify(summary || {}), JSON.stringify(detail || {})]
  );
}

// One History row per task (2026-09-24, Hera): Weekly Inventory Count keeps
// a single entry per task that always follows the task's latest state —
// re-submitted after "Send Back to Store", buyer commit, etc. Updates the
// newest existing row for (kind, location, ref_no) and drops any older
// duplicates; inserts when there is none. bumpCreatedAt moves the row's
// date (and its 15-day retention clock) to now — used on manager submits,
// not on buyer-side updates.
async function upsertManagerHistory({ kind, location, ref_no, label, summary, detail, bumpCreatedAt = false }) {
  const existing = await pool.query(
    `SELECT id FROM manager_history WHERE kind = $1 AND location = $2 AND ref_no = $3 ORDER BY created_at DESC, id DESC`,
    [kind, location, ref_no]
  );
  if (existing.rows.length === 0) {
    await insertManagerHistory({ kind, location, ref_no, label, summary, detail });
    return;
  }
  const keepId = existing.rows[0].id;
  await pool.query(
    `UPDATE manager_history
        SET label = $2, summary = $3, detail = $4${bumpCreatedAt ? ', created_at = NOW()' : ''}
      WHERE id = $1`,
    [keepId, label, JSON.stringify(summary || {}), JSON.stringify(detail || {})]
  );
  const extra = existing.rows.slice(1).map(r => r.id);
  if (extra.length) await pool.query('DELETE FROM manager_history WHERE id = ANY($1)', [extra]);
}

// Lazy cleanup (no cron job) — run on every list read, same pattern box_pos'
// 90-day retention (boxPo.js) and po_invoices' 200-row retention use.
async function pruneExpired() {
  await pool.query(`DELETE FROM manager_history WHERE created_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`);
}

// GET /api/manager-history?kind=task&location=MTL01 — list rows for one
// History section (list-row fields only: ref_no/label/summary/created_at).
router.get('/', async (req, res) => {
  try {
    const { kind, location } = req.query;
    if (!kind || !location) return res.status(400).json({ error: 'kind and location are required' });
    await pruneExpired();
    const result = await pool.query(
      `SELECT id, ref_no, label, summary, created_at
       FROM manager_history
       WHERE kind = $1 AND location = $2
       ORDER BY created_at DESC`,
      [kind, location]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/manager-history error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/manager-history/:id — full frozen snapshot (including `detail`)
// for one History detail page. `kind` comes back on the row too, so a
// detail page that covers more than one kind (Transfer's Received vs Sent)
// can branch on it.
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM manager_history WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'History entry not found' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('GET /api/manager-history/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, insertManagerHistory, upsertManagerHistory };
