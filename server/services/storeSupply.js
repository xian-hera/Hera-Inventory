// Store Supply — deadlines / cycles (2026-11-09, Hera — claude/STORE_SUPPLY_SPEC.md).
//
// Settings (app_settings 'store_supply'):
//   { current: 'YYYY-MM-DD', next: 'YYYY-MM-DD', mode: 'manual' | 'auto',
//     weeks: 1–9, useStock: true }
// The deadline day itself still counts: a deadline of the 4th closes when the
// 5th starts (Toronto time). rollCycle() closes every deadline that has
// passed, in order:
//   • drafts of that deadline with at least one item are submitted
//     (auto_submitted); empty drafts are dropped;
//   • Next becomes Current; the new Next = Current + N weeks (Auto) or the
//     same gap as the cycle that just closed (Manual; WH can change it).
// It runs before every Store Supply API answer and every 10 minutes.
const { pool } = require('../database/init');

const TZ = 'America/Toronto';
const KEY = 'store_supply';
const DEFAULTS = { current: null, next: null, mode: 'manual', weeks: 2, useStock: true };

function torontoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const isoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const toUtc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
const fromUtc = (dt) => dt.toISOString().slice(0, 10);
const addDays = (iso, n) => fromUtc(new Date(toUtc(iso).getTime() + n * 86400000));
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
const isWeekend = (iso) => { const d = toUtc(iso).getUTCDay(); return d === 0 || d === 6; };
// Saturday / Sunday → the Monday after.
const toWeekday = (iso) => (toUtc(iso).getUTCDay() === 6 ? addDays(iso, 2) : toUtc(iso).getUTCDay() === 0 ? addDays(iso, 1) : iso);
const clampWeeks = (n) => Math.min(9, Math.max(1, parseInt(n, 10) || 2));

async function getSettings(db = pool) {
  const r = await db.query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
  return { ...DEFAULTS, ...(r.rows[0] ? r.rows[0].value : {}) };
}
async function saveSettings(db, s) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, JSON.stringify(s)]
  );
}

// Close everything that has passed. Safe to call any time (advisory lock).
async function rollCycle() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('store_supply_cycle'))");
    const s = await getSettings(client);
    if (!s.current) { await client.query('COMMIT'); return s; }
    const today = torontoToday();
    let changed = false;
    let guard = 0;
    while (s.current < today && guard < 200) {
      guard += 1;
      const closing = s.current;
      // drafts with items → submitted by the cycle close; empty drafts dropped
      await client.query(
        `UPDATE supply_requests r SET status = 'submitted', submitted_at = NOW(), auto_submitted = TRUE, updated_at = NOW()
          WHERE r.deadline = $1::date AND r.status = 'draft'
            AND EXISTS (SELECT 1 FROM supply_request_lines l WHERE l.request_id = r.id)`,
        [closing]
      );
      await client.query(`DELETE FROM supply_requests WHERE deadline = $1::date AND status = 'draft'`, [closing]);
      await client.query(
        `INSERT INTO supply_deadlines (deadline, closed_at) VALUES ($1::date, NOW())
         ON CONFLICT (deadline) DO UPDATE SET closed_at = COALESCE(supply_deadlines.closed_at, NOW())`,
        [closing]
      );
      const gap = s.next && s.next > closing ? daysBetween(closing, s.next) : clampWeeks(s.weeks) * 7;
      const newCurrent = s.next && s.next > closing ? s.next : toWeekday(addDays(closing, gap));
      const step = s.mode === 'auto' ? clampWeeks(s.weeks) * 7 : gap;
      s.current = newCurrent;
      s.next = toWeekday(addDays(newCurrent, step));
      await client.query('INSERT INTO supply_deadlines (deadline) VALUES ($1::date) ON CONFLICT DO NOTHING', [s.current]);
      changed = true;
    }
    if (changed) await saveSettings(client, s);
    await client.query('COMMIT');
    return s;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Validate a Next date against Current: later than Current, not a weekend.
function nextError(current, next) {
  if (!isoDate(next)) return 'Choose a date.';
  if (current && next <= current) return 'The Next Deadline must be after the Current Deadline.';
  if (isWeekend(next)) return 'The Next Deadline can’t be on a weekend.';
  return null;
}

let timer = null;
function startCycleJob() {
  if (timer) return;
  timer = setInterval(() => { rollCycle().catch(e => console.error('store supply rollCycle failed:', e.message)); }, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  TZ, torontoToday, isoDate, addDays, daysBetween, isWeekend, clampWeeks,
  getSettings, saveSettings, rollCycle, nextError, startCycleJob,
};
