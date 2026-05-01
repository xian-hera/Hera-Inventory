const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../database/init');

// PIN is stored as a SHA-256 hash in app_settings table
// key: 'buyer_pin' or 'crm_pin'
// value: { hash: <sha256>, hint: <string> }

const hashPin = (pin) => crypto.createHash('sha256').update(pin).digest('hex');

const DEFAULT_PIN = '3591';
const DEFAULT_HASH = hashPin(DEFAULT_PIN);

// ── POST /api/settings/pin/verify ─────────────────────────────────────────────
// Body: { key: 'buyer_pin' | 'crm_pin', pin: '1234' }
// Returns: { success: true } or 401
router.post('/pin/verify', async (req, res) => {
  try {
    const { key, pin } = req.body;
    if (!key || !pin) return res.status(400).json({ error: 'key and pin are required' });
    if (!['buyer_pin', 'crm_pin'].includes(key)) return res.status(400).json({ error: 'Invalid key' });

    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [key]
    );

    const stored = rows[0]?.value || { hash: DEFAULT_HASH, hint: '' };
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
    if (!key || !['buyer_pin', 'crm_pin'].includes(key)) {
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
    if (!['buyer_pin', 'crm_pin'].includes(key)) {
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
    const stored = rows[0]?.value || { hash: DEFAULT_HASH, hint: '' };
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