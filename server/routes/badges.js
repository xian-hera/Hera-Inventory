const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// GET /api/badges/buyer
router.get('/buyer', async (req, res) => {
  try {
    // Weekly Inventory Count: tasks in 'reviewing' status
    const weeklyRes = await pool.query(
      `SELECT COUNT(*) FROM tasks WHERE status = 'reviewing'`
    );

    // Zero/Low Inventory Count: zero_qty_reports in 'reviewing' status
    const zeroLowRes = await pool.query(
      `SELECT COUNT(*) FROM zero_qty_reports WHERE status = 'reviewing'`
    );

    // Stock Losses: entries in 'reviewing' status
    const stockLossesRes = await pool.query(
      `SELECT COUNT(*) FROM stock_losses WHERE status = 'reviewing'`
    );

    // Price Change alert: any active price change task that has at least one
    // location with status = 'pending' (unfinished stores)
    let priceChangeAlert = false;
    try {
      const priceChangeRes = await pool.query(`
        SELECT COUNT(*) FROM price_change_tasks t
        WHERE t.status = 'active'
          AND EXISTS (
            SELECT 1 FROM price_change_location_status ls
            WHERE ls.task_id = t.id AND ls.status = 'pending'
          )
      `);
      priceChangeAlert = parseInt(priceChangeRes.rows[0].count) > 0;
    } catch (e) {
      // Table may not exist yet
    }

    res.json({
      weeklyReviewing:      parseInt(weeklyRes.rows[0].count),
      zeroLowReviewing:     parseInt(zeroLowRes.rows[0].count),
      stockLossesReviewing: parseInt(stockLossesRes.rows[0].count),
      priceChangeAlert,
    });
  } catch (e) {
    console.error('GET /api/badges/buyer error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/badges/manager?location=MTL01
router.get('/manager', async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'location required' });

    // Weekly counting tasks in 'counting' status for this location
    const weeklyRes = await pool.query(
      `SELECT COUNT(*) FROM tasks WHERE status = 'counting' AND location = $1`,
      [location]
    );

    // Label Print: active price change tasks with status = 'pending' for this location
    let labelPrintCount = 0;
    try {
      const labelRes = await pool.query(`
        SELECT COUNT(*) FROM price_change_location_status ls
        JOIN price_change_tasks t ON t.id = ls.task_id
        WHERE ls.location = $1
          AND ls.status = 'pending'
          AND t.status = 'active'
      `, [location]);
      labelPrintCount = parseInt(labelRes.rows[0].count);
    } catch (e) {
      // Table may not exist yet
    }

    // PO Receiving: invoices the buyer has sent to this location for
    // counting, still awaiting the manager's count.
    let poReceivingCount = 0;
    try {
      const poRes = await pool.query(
        `SELECT COUNT(*) FROM po_invoices WHERE status = 'sent_to_store' AND location = $1`,
        [location]
      );
      poReceivingCount = parseInt(poRes.rows[0].count);
    } catch (e) {
      // Table may not exist yet
    }

    // Transfer (2026-09-21, Hera): same rows Manager's Transfer Home shows
    // on the Receiving + Sending cards (History excluded) — this location
    // is either the to_location on an in_transit/receiving transfer, or the
    // from_location on a loading/good_to_go/pending one. See
    // GET /api/transfers/manager/home in transfers.js — kept in sync with
    // that route's two status lists.
    let transferCount = 0;
    try {
      const transferRes = await pool.query(
        `SELECT COUNT(*) FROM transfers
         WHERE (to_location = $1 AND status IN ('in_transit','receiving'))
            OR (from_location = $1 AND status IN ('loading','good_to_go','pending'))`,
        [location]
      );
      transferCount = parseInt(transferRes.rows[0].count);
    } catch (e) {
      // Table may not exist yet
    }

    res.json({
      weeklyCountingTasks: parseInt(weeklyRes.rows[0].count),
      labelPrintTasks:     labelPrintCount,
      poReceivingTasks:    poReceivingCount,
      transferTasks:       transferCount,
    });
  } catch (e) {
    console.error('GET /api/badges/manager error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;