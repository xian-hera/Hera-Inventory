// Online › Dashboard — daily Task history snapshot (2026-10-01, Hera).
// Every working day (Mon–Fri) at 23:00 Montreal time, write one row with the
// tasks that are NOT done in the current cycle. Urgent temp tasks first.
// Weekends get no row. If the server was down at 23:00, the boot catch-up
// writes today's row when it starts between 23:00 and the next 07:00
// refresh (later than that the day's state is gone, so nothing is written).
const cron = require('node-cron');
const { pool } = require('../database/init');
const { CYCLE_SQL, TZ } = require('../routes/onlineTasks');

let task = null;

async function writeSnapshot() {
  const r = await pool.query(`
    SELECT ${CYCLE_SQL} AS cycle, EXTRACT(ISODOW FROM ${CYCLE_SQL})::int AS dow,
      EXTRACT(HOUR FROM (NOW() AT TIME ZONE '${TZ}'))::int AS hour`);
  const { cycle, dow, hour } = r.rows[0];
  if (dow > 5) return { skipped: 'weekend' };
  // Only between 23:00 and the 07:00 refresh, i.e. after the record time.
  if (hour < 23 && hour >= 7) return { skipped: 'too early' };
  const t = await pool.query(`
    SELECT name, type, priority FROM online_tasks
    WHERE NOT (done_cycle IS NOT NULL AND done_cycle = ${CYCLE_SQL})
    ORDER BY (type = 'temp' AND priority = 'urgent') DESC, sort_order, id`);
  const items = t.rows.map(x => ({ name: x.name, urgent: x.type === 'temp' && x.priority === 'urgent' }));
  await pool.query(`
    INSERT INTO online_task_history (day, items, recorded_at) VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (day) DO UPDATE SET items = EXCLUDED.items, recorded_at = NOW()`,
  [cycle, JSON.stringify(items)]);
  return { day: cycle, notDone: items.length };
}

async function runSnapshot(source) {
  try {
    const r = await writeSnapshot();
    if (!r.skipped) console.log(`[online-tasks] history ${source}: ${r.day} — ${r.notDone} not done`);
  } catch (e) {
    console.error('[online-tasks] history snapshot failed:', e.message);
  }
}

function startOnlineTaskHistoryScheduler() {
  if (task) { task.stop(); task = null; }
  task = cron.schedule('0 23 * * 1-5', () => { runSnapshot('23:00'); }, { timezone: TZ });
  // Boot catch-up (only writes when today's 23:00 already passed and no row yet).
  setTimeout(async () => {
    try {
      const done = await pool.query(`SELECT 1 FROM online_task_history WHERE day = ${CYCLE_SQL}`);
      if (!done.rows.length) await runSnapshot('catch-up');
    } catch (e) {
      console.error('[online-tasks] history catch-up failed:', e.message);
    }
  }, 40 * 1000);
  console.log(`[online-tasks] history scheduler started (${TZ}, Mon–Fri 23:00)`);
}

module.exports = { startOnlineTaskHistoryScheduler, writeSnapshot };
