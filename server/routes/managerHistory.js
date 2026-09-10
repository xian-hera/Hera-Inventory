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

module.exports = { router, insertManagerHistory };
