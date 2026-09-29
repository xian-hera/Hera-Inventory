// Per-account memory (2026-09-29, Hera) — mounted at /api/account-memory.
//
// Remembers, per Shopify staff account (see server/accountAuth.js):
//   1. PIN sections (buyer_pin / crm_pin / online_pin): entered the correct
//      PIN → no PIN again for 30 days on ANY device logged into that account.
//   2. Store (manager) location: confirmed once → remembered forever, until
//      the account confirms a different one (overwrite).
//
// Every response carries `identified`. identified: false means the request
// had no valid session token (App Bridge not loaded, token expired, not
// opened inside Shopify Admin...). The frontend then falls back to the old
// localStorage behaviour, so nothing is ever blocked by this file. For the
// same reason this file never answers 401 — client/src/index.js turns a
// 401 { reauth } into a full-page OAuth redirect.

const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { getAccountId } = require('../accountAuth');

// Same keys as VALID_PIN_KEYS in routes/settings.js (kept separate to avoid
// a require cycle — settings.js requires this file).
const PIN_KEYS = ['buyer_pin', 'crm_pin', 'online_pin'];
const PIN_REMEMBER_DAYS = 30;

// ── helpers used by routes/settings.js ───────────────────────────────────────

// Called after a successful /pin/verify. Returns true if it was remembered
// for the account, false if there is no account (caller doesn't care why).
async function rememberPinForAccount(req, key) {
  if (!PIN_KEYS.includes(key)) return false;
  const accountId = await getAccountId(req);
  if (!accountId) return false;
  try {
    await pool.query(
      `INSERT INTO pin_sessions (account_id, pin_key, expires_at, updated_at)
       VALUES ($1, $2, NOW() + make_interval(days => $3::int), NOW())
       ON CONFLICT (account_id, pin_key)
       DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
      [accountId, key, PIN_REMEMBER_DAYS]
    );
    return true;
  } catch (e) {
    console.error('[account-memory] rememberPinForAccount failed:', e.message);
    return false;
  }
}

// Called after a successful /pin/update: a new PIN logs every account out
// of that section.
async function forgetPinForAllAccounts(key) {
  try {
    await pool.query(`DELETE FROM pin_sessions WHERE pin_key = $1`, [key]);
  } catch (e) {
    console.error('[account-memory] forgetPinForAllAccounts failed:', e.message);
  }
}

// ── GET /api/account-memory/pin-status?key=buyer_pin ────────────────────────
// → { identified, verified }
router.get('/pin-status', async (req, res) => {
  try {
    const { key } = req.query;
    if (!PIN_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid key' });
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, verified: false });
    const { rows } = await pool.query(
      `SELECT 1 FROM pin_sessions WHERE account_id = $1 AND pin_key = $2 AND expires_at > NOW()`,
      [accountId, key]
    );
    res.json({ identified: true, verified: rows.length > 0 });
  } catch (e) {
    console.error('GET /api/account-memory/pin-status error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/account-memory/pin-logout  Body: { key } ───────────────────────
// Settings → Log out: forget this account's PIN for that one section.
router.post('/pin-logout', async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!PIN_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid key' });
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, success: false });
    await pool.query(
      `DELETE FROM pin_sessions WHERE account_id = $1 AND pin_key = $2`,
      [accountId, key]
    );
    res.json({ identified: true, success: true });
  } catch (e) {
    console.error('POST /api/account-memory/pin-logout error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/account-memory/location → { identified, location } ─────────────
// location is '' when this account has never confirmed one.
router.get('/location', async (req, res) => {
  try {
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, location: '' });
    const { rows } = await pool.query(
      `SELECT location FROM manager_locations WHERE account_id = $1`,
      [accountId]
    );
    res.json({ identified: true, location: rows[0]?.location || '' });
  } catch (e) {
    console.error('GET /api/account-memory/location error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/account-memory/location  Body: { location } ─────────────────────
// Manager Home → Confirm. Overwrites whatever was saved before.
router.put('/location', async (req, res) => {
  try {
    const location = String((req.body && req.body.location) || '').trim();
    if (!location || location.length > 64) return res.status(400).json({ error: 'Invalid location' });
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, success: false });
    await pool.query(
      `INSERT INTO manager_locations (account_id, location, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (account_id) DO UPDATE SET location = EXCLUDED.location, updated_at = NOW()`,
      [accountId, location]
    );
    res.json({ identified: true, success: true });
  } catch (e) {
    console.error('PUT /api/account-memory/location error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, rememberPinForAccount, forgetPinForAllAccounts };
