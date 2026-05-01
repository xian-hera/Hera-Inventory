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
// POST /api/influencers/:id/refresh-stats
// Uses GraphQL codeDiscountNodeByCode — one request, accurate, no order pagination.
router.post('/:id/refresh-stats', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT code FROM influencers WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const { code } = rows[0];
    if (!code) return res.json({ total_sale: 0, used_times: 0 });

    const session = req.shopifySession;
    const shop    = session.shop;
    const token   = session.accessToken;

    const query = `{
      codeDiscountNodeByCode(code: "${code.trim().replace(/"/g, '')}") {
        codeDiscount {
          ... on DiscountCodeBasic {
            asyncUsageCount
            totalSales { amount currencyCode }
          }
          ... on DiscountCodeBxgy {
            asyncUsageCount
            totalSales { amount currencyCode }
          }
          ... on DiscountCodeFreeShipping {
            asyncUsageCount
            totalSales { amount currencyCode }
          }
        }
      }
    }`;

    const resp = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Shopify GraphQL error ${resp.status}: ${body}`);
    }

    const result = await resp.json();
    const discount = result?.data?.codeDiscountNodeByCode?.codeDiscount;

    if (!discount) {
      return res.status(404).json({ error: `Discount code "${code}" not found in Shopify` });
    }

    const used_times = discount.asyncUsageCount ?? 0;
    const total_sale = parseFloat(discount.totalSales?.amount ?? 0);

    await client.query(`
      UPDATE influencers
      SET last_stats_total=$1, last_stats_used=$2,
          last_stats_refreshed_at=NOW(), updated_at=NOW()
      WHERE id=$3
    `, [total_sale.toFixed(2), used_times, req.params.id]);

    await client.query(`
      INSERT INTO influencer_history (influencer_id, action, detail)
      VALUES ($1, 'stats_refreshed', $2)
    `, [req.params.id, `Sales stats refreshed: ${used_times} uses, $${total_sale.toFixed(2)}`]);

    res.json({ total_sale: total_sale.toFixed(2), used_times });
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