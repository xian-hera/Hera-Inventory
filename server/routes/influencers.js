const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// ─── LIST ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*,
             (SELECT json_agg(p ORDER BY p.payment_date DESC)
              FROM influencer_payments p WHERE p.influencer_id = i.id) AS payment_history
      FROM influencers i
      ORDER BY i.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /api/influencers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── CREATE ──────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, email, platforms, code, commission_rate, type } = req.body;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      INSERT INTO influencers (name, email, platforms, code, commission_rate, type, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'draft')
      RETURNING *
    `, [name, email, JSON.stringify(platforms || []), code || null, commission_rate || null, type || null]);

    const influencer = rows[0];
    await client.query(`
      INSERT INTO influencer_history (influencer_id, action, detail)
      VALUES ($1, 'created', $2)
    `, [influencer.id, `Influencer "${name}" created`]);

    res.json(influencer);
  } catch (e) {
    console.error('POST /api/influencers error:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─── GET ONE ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM influencers WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const influencer = rows[0];
    const { rows: payments } = await pool.query(`
      SELECT * FROM influencer_payments WHERE influencer_id = $1 ORDER BY payment_date DESC
    `, [req.params.id]);
    const { rows: history } = await pool.query(`
      SELECT * FROM influencer_history WHERE influencer_id = $1 ORDER BY created_at DESC
    `, [req.params.id]);

    res.json({ ...influencer, payment_history: payments, history });
  } catch (e) {
    console.error('GET /api/influencers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── UPDATE INFO ─────────────────────────────────────────────────────────────
router.patch('/:id/info', async (req, res) => {
  const { name, email, platforms, code, commission_rate, type } = req.body;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      UPDATE influencers
      SET name=$1, email=$2, platforms=$3, code=$4, commission_rate=$5, type=$6, updated_at=NOW()
      WHERE id=$7 RETURNING *
    `, [name, email, JSON.stringify(platforms || []), code || null, commission_rate || null, type || null, req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    await client.query(`
      INSERT INTO influencer_history (influencer_id, action, detail)
      VALUES ($1, 'info_updated', 'Influencer info updated')
    `, [req.params.id]);

    res.json(rows[0]);
  } catch (e) {
    console.error('PATCH /api/influencers/:id/info error:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─── UPDATE STATUS ───────────────────────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['active', 'draft', 'archive'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const client = await pool.connect();
  try {
    const lastActiveClause = status === 'active' ? ', last_active_at=NOW()' : '';
    const { rows } = await client.query(`
      UPDATE influencers
      SET status=$1, updated_at=NOW()${lastActiveClause}
      WHERE id=$2 RETURNING *
    `, [status, req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    await client.query(`
      INSERT INTO influencer_history (influencer_id, action, detail)
      VALUES ($1, 'status_changed', $2)
    `, [req.params.id, `Status changed to "${status}"`]);

    res.json(rows[0]);
  } catch (e) {
    console.error('PATCH /api/influencers/:id/status error:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─── NOTES ───────────────────────────────────────────────────────────────────
router.patch('/:id/notes', async (req, res) => {
  const { notes, action } = req.body;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      UPDATE influencers SET notes=$1, updated_at=NOW() WHERE id=$2 RETURNING *
    `, [JSON.stringify(notes || []), req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const histAction = action === 'add' ? 'note_added' : 'note_deleted';
    const histDetail = action === 'add' ? 'Note added' : 'Note deleted';
    await client.query(`
      INSERT INTO influencer_history (influencer_id, action, detail)
      VALUES ($1, $2, $3)
    `, [req.params.id, histAction, histDetail]);

    res.json(rows[0]);
  } catch (e) {
    console.error('PATCH /api/influencers/:id/notes error:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─── PAYMENT INFO ────────────────────────────────────────────────────────────
router.patch('/:id/payment-info', async (req, res) => {
  const { payment_method, billing_address, phone_number } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE influencers
      SET payment_method=$1, billing_address=$2, phone_number=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [payment_method || null, JSON.stringify(billing_address || {}), phone_number || null, req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('PATCH /api/influencers/:id/payment-info error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── ADD PAYMENT RECORD ──────────────────────────────────────────────────────
router.post('/:id/payments', async (req, res) => {
  const { payment_date, amount, method } = req.body;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      INSERT INTO influencer_payments (influencer_id, payment_date, amount, method)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [req.params.id, payment_date, amount, method]);

    await client.query(`
      INSERT INTO influencer_history (influencer_id, action, detail)
      VALUES ($1, 'payment_added', $2)
    `, [req.params.id, `Payment of ${amount} added (${method})`]);

    res.json(rows[0]);
  } catch (e) {
    console.error('POST /api/influencers/:id/payments error:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─── SHOPIFY SALES STATS ─────────────────────────────────────────────────────
// POST /api/influencers/:id/refresh-stats  — body: { days: 7|30|180|365 }
router.post('/:id/refresh-stats', async (req, res) => {
  const { days = 180 } = req.body;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT code, commission_rate FROM influencers WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const { code, commission_rate } = rows[0];
    if (!code) return res.json({ orders: [], total_sale: 0, used_times: 0 });

    // Use session already loaded by the /api middleware in shopify.js
    const session = req.shopifySession;
    const shop    = session.shop;
    const token   = session.accessToken;

    const createdAtMin = new Date(Date.now() - days * 86400000).toISOString();
    let allOrders = [];
    let url = `https://${shop}/admin/api/2026-01/orders.json?status=any&limit=250`
            + `&created_at_min=${encodeURIComponent(createdAtMin)}`
            + `&discount_code=${encodeURIComponent(code)}`
            + `&fields=id,name,created_at,subtotal_price,discount_codes,shipping_address,customer`;

    // Paginate through all matching orders
    while (url) {
      const resp = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      });
      if (!resp.ok) throw new Error(`Shopify API error: ${resp.status}`);
      const data = await resp.json();
      allOrders = allOrders.concat(data.orders || []);

      // Follow Link header for next page
      const link = resp.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    // Secondary filter: confirm the code actually matches (Shopify query is case-insensitive but we double-check)
    const filtered = allOrders.filter(o =>
      Array.isArray(o.discount_codes) &&
      o.discount_codes.some(d => d.code.toUpperCase() === code.toUpperCase())
    );
// 在 while 循环结束后加
    console.log(`Total orders fetched: ${allOrders.length}`);
    console.log(`Filtered by code "${codeUpper}": ${filtered.length}`);
    const total_sale = filtered.reduce((sum, o) => sum + parseFloat(o.subtotal_price || 0), 0);

    // Cache results on the influencer row
    await client.query(`
      UPDATE influencers
      SET last_stats_days=$1, last_stats_total=$2, last_stats_used=$3,
          last_stats_refreshed_at=NOW(), updated_at=NOW()
      WHERE id=$4
    `, [days, total_sale.toFixed(2), filtered.length, req.params.id]);

    await client.query(`
      INSERT INTO influencer_history (influencer_id, action, detail)
      VALUES ($1, 'stats_refreshed', $2)
    `, [req.params.id, `Sales stats refreshed (last ${days} days)`]);

    // Return most recent 50 orders for the detail table
    const orders = filtered.slice(0, 50).map(o => ({
      id:             o.id,
      name:           o.name,
      created_at:     o.created_at,
      subtotal_price: o.subtotal_price,
      customer_name:  o.customer
        ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim()
        : '—',
      destination: o.shipping_address
        ? `${o.shipping_address.city || ''}, ${o.shipping_address.province_code || o.shipping_address.province || ''}`
        : '—',
    }));

    res.json({ orders, total_sale: total_sale.toFixed(2), used_times: filtered.length });
  } catch (e) {
    console.error('POST /api/influencers/:id/refresh-stats error:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ─── DELETE ──────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM influencers WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/influencers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;