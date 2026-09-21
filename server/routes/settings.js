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
// value: { hash: <sha256>, hint: <string>, plain?: <string> }
//
// `plain` (2026-09-21, Hera): the PIN list feature on Online Settings needs
// to *display* each section's current PIN, not just verify it — and a
// SHA-256 hash is one-way, so the actual digits can't be recovered from it.
// Every /pin/update from now on stores the new PIN's plain digits alongside
// its hash so GET /pin/list can show it. Hera confirmed this tradeoff is
// fine (these PINs are just an internal section divider, not a real
// security boundary). A row saved before this change (hash only, no
// `plain`) can't be retroactively decrypted — see BACKFILL_KNOWN_PLAIN
// below for the one-time, hash-verified exception made for crm_pin, which
// Hera confirmed was already customized to 2877 before this feature
// existed. buyer_pin and online_pin were both confirmed still at their
// defaults (3591 / 0000) at the time of writing, so /pin/list's fallback to
// DEFAULT_PINS already covers them correctly without needing a backfill.

const hashPin = (pin) => crypto.createHash('sha256').update(pin).digest('hex');

const VALID_PIN_KEYS = ['buyer_pin', 'crm_pin', 'online_pin'];

// Per-key default PIN (used only when no row exists yet for that key, i.e.
// it has never been changed). buyer_pin/crm_pin keep the original 3591;
// online_pin's default is 0000, per Hera's spec for the new Online section.
const DEFAULT_PINS = { buyer_pin: '3591', crm_pin: '3591', online_pin: '0000' };
const defaultStoredValue = (key) => ({ hash: hashPin(DEFAULT_PINS[key]), hint: '' });

// One-time, hash-verified backfill (2026-09-21): crm_pin was customized to
// 2877 before the `plain` field existed, so it has a saved hash but no
// plain digits. This runs once at startup, re-hashes '2877', and only ever
// writes `plain` back if that hash matches what's already stored for
// crm_pin — if Hera changes the PIN again before this runs, or the stored
// hash doesn't match for any other reason, it does nothing rather than
// guess. Safe to leave in permanently: once `plain` is set, the `stored.plain`
// check below makes every later run a no-op.
const BACKFILL_KNOWN_PLAIN = { crm_pin: '2877' };

async function backfillKnownPlainPins() {
  for (const [key, knownPlain] of Object.entries(BACKFILL_KNOWN_PLAIN)) {
    try {
      const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
      const stored = rows[0]?.value;
      if (!stored || stored.plain) continue; // no row yet, or already backfilled
      if (stored.hash !== hashPin(knownPlain)) continue; // PIN has since changed — don't guess
      const newValue = { ...stored, plain: knownPlain };
      await pool.query(
        `UPDATE app_settings SET value = $2, updated_at = NOW() WHERE key = $1`,
        [key, JSON.stringify(newValue)]
      );
      console.log(`settings.js: backfilled plain PIN for ${key}`);
    } catch (e) {
      console.error(`settings.js: backfillKnownPlainPins failed for ${key}:`, e.message);
    }
  }
}
backfillKnownPlainPins();

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

    // Update with new PIN — `plain` stored alongside the hash from now on
    // so GET /pin/list can display it later (see the comment at the top of
    // this file for why that's needed and the tradeoff Hera accepted).
    const newValue = { hash: hashPin(String(newPin)), hint: (hint || '').trim(), plain: String(newPin) };
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

// ── GET /api/settings/pin/list ────────────────────────────────────────────────
// Returns the current plain-text PIN for all three sections at once — used
// by the "PIN List" button on Online Settings (2026-09-21, Hera) so she
// doesn't have to remember all three. Reached only from inside Online
// Settings, which itself already sits behind online_pin — same trust level
// as everywhere else in this app (no separate auth layer on any /api route).
// For each key: prefer the stored `plain` digits; if there's no row at all
// (never changed), fall back to that key's DEFAULT_PINS value; if a row
// exists but predates the `plain` field and isn't one of the known
// backfilled PINs above, digits genuinely can't be recovered — reports
// `null` and the frontend shows "Unknown — re-set to record it" for that
// one section rather than guessing.
router.get('/pin/list', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
      [VALID_PIN_KEYS]
    );
    const byKey = {};
    for (const row of rows) byKey[row.key] = row.value;

    const result = {};
    for (const key of VALID_PIN_KEYS) {
      const stored = byKey[key];
      if (!stored) {
        result[key] = DEFAULT_PINS[key]; // never changed from default
      } else if (stored.plain) {
        result[key] = stored.plain;
      } else {
        result[key] = null; // customized before `plain` existed — unrecoverable
      }
    }
    res.json(result);
  } catch (e) {
    console.error('GET /api/settings/pin/list error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;