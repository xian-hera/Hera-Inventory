const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../database/init');

// PIN is stored as a SHA-256 hash in app_settings table
// key: 'buyer_pin', 'crm_pin' (displayed as "Operation" on the frontend,
// 2026-09-21 — see claude/PROJECT_CONTEXT.md-style note in App Home: the
// key/route/localStorage name was kept as "crm" to match the existing
// Buyer/Manager-style internal-name-vs-display-name convention, only the
// front-end label changed), or 'online_pin' (new section added 2026-09-21,
// holds Birthday Reward + Influencer Management, moved out of crm_pin's
// gate — its own independent PIN/login state, default PIN 0000 instead of
// the 3591 the other two keys default to).
// value: { hash: <sha256>, hint: <string> }

const hashPin = (pin) => crypto.createHash('sha256').update(pin).digest('hex');

const VALID_PIN_KEYS = ['buyer_pin', 'crm_pin', 'online_pin'];

// Per-key default PIN (used only when no row exists yet for that key, i.e.
// it has never been changed). buyer_pin/crm_pin keep the original 3591;
// online_pin's default is 0000, per Hera's spec for the new Online section.
const DEFAULT_PINS = { buyer_pin: '3591', crm_pin: '3591', online_pin: '0000' };
const defaultStoredValue = (key) => ({ hash: hashPin(DEFAULT_PINS[key]), hint: '' });

// ── POST /api/settings/pin/verify ─────────────────────────────────────────────
// Body: { key: 'buyer_pin' | 'crm_pin', pin: '1234' }
// Returns: { success: true } or 401
router.post('/pin/verify', async (req, res) => {
  try {
    const { key, pin } = req.body;
    if (!key || !pin) return res.status(400).json({ error: 'key and pin are required' });
    if (!VALID_PIN_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid key' });

    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [key]
    );

    const stored = rows[0]?.value || defaultStoredValue(key);
    const inputHash = hashPin(String(pin));

    if (inputHash !== stored.hash) {
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    res.json({ success: true, hint: stored.hint || '' });
  } catch (e) {
    console.error('POST /api/settings/pin/verify error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/settings/pin/hint ────────────────────────────────────────────────
// Query: ?key=buyer_pin or ?key=crm_pin
// Returns: { hint: '...' } — safe to expose, no PIN hash
router.get('/pin/hint', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key || !VALID_PIN_KEYS.includes(key)) {
      return res.status(400).json({ error: 'Invalid key' });
    }

    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [key]
    );

    const stored = rows[0]?.value || { hint: '' };
    res.json({ hint: stored.hint || '' });
  } catch (e) {
    console.error('GET /api/settings/pin/hint error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/settings/pin/update ─────────────────────────────────────────────
// Body: { key, currentPin, newPin, hint }
// Verifies current PIN first, then updates
router.post('/pin/update', async (req, res) => {
  try {
    const { key, currentPin, newPin, hint } = req.body;
    if (!key || !currentPin || !newPin) {
      return res.status(400).json({ error: 'key, currentPin, and newPin are required' });
    }
    if (!VALID_PIN_KEYS.includes(key)) {
      return res.status(400).json({ error: 'Invalid key' });
    }
    if (!/^\d{4}$/.test(newPin)) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }

    // Verify current PIN
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [key]
    );
    const stored = rows[0]?.value || defaultStoredValue(key);
    const currentHash = hashPin(String(currentPin));

    if (currentHash !== stored.hash) {
      return res.status(401).json({ error: 'Incorrect current PIN' });
    }

    // Update with new PIN
    const newValue = { hash: hashPin(String(newPin)), hint: (hint || '').trim() };
    await pool.query(
      `INSERT INTO app_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(newValue)]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/settings/pin/update error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;