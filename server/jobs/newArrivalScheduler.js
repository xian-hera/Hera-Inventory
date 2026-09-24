// New Arrival daily job (2026-09-24). Same node-cron pattern as
// birthdayScheduler.js. Runs once at startup (to catch up after a restart)
// and every day at 03:30 America/Toronto:
//   1. remove the New Arrival tag from products whose removal date passed
//      (rows in new_arrival_tag_removals, written by Finalized → Publish);
//   2. delete finalized-but-unpublished new_arrival rows older than 100 days
//      (counted from the finalized date — Hera 2026-09-24).
// Only ever removes the one tag it added; never touches other tags and never
// deletes Shopify products.
const cron = require('node-cron');
const { pool } = require('../database/init');
const { gql, userErrorText } = require('../services/shopifyGql');

const TIMEZONE = 'America/Toronto';
let task = null;
let running = false;

async function removeDueTags() {
  const due = await pool.query('SELECT id, shopify_product_id, tag FROM new_arrival_tag_removals WHERE remove_at <= NOW() ORDER BY id LIMIT 500');
  let removed = 0;
  for (const row of due.rows) {
    try {
      const data = await gql(
        `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`,
        { id: row.shopify_product_id, tags: [row.tag] }
      );
      const msg = userErrorText(data.tagsRemove);
      // A product deleted in Shopify can never succeed — drop the row too.
      if (msg && !/not found|does not exist/i.test(msg)) {
        console.error(`[new-arrival] tag removal failed for ${row.shopify_product_id}: ${msg}`);
        continue;
      }
      await pool.query('DELETE FROM new_arrival_tag_removals WHERE id = $1', [row.id]);
      removed++;
    } catch (e) {
      console.error(`[new-arrival] tag removal error for ${row.shopify_product_id}: ${e.message}`);
    }
  }
  return removed;
}

async function purgeOldFinalized() {
  const r = await pool.query(
    `DELETE FROM new_arrival WHERE status = 'finalized' AND finalized_at < NOW() - INTERVAL '100 days'`
  );
  return r.rowCount;
}

async function runNewArrivalJob() {
  if (running) return;
  running = true;
  try {
    const removed = await removeDueTags();
    const purged = await purgeOldFinalized();
    console.log(`[new-arrival] daily job: ${removed} tag(s) removed, ${purged} old finalized row(s) deleted`);
  } catch (e) {
    console.error('[new-arrival] daily job failed:', e.message);
  } finally {
    running = false;
  }
}

function startNewArrivalScheduler() {
  if (task) { task.stop(); task = null; }
  task = cron.schedule('30 3 * * *', () => { runNewArrivalJob(); }, { timezone: TIMEZONE });
  // Catch-up run shortly after boot (not awaited).
  setTimeout(() => { runNewArrivalJob(); }, 30 * 1000);
  console.log(`[new-arrival] scheduler started (${TIMEZONE}, daily 03:30)`);
}

module.exports = { startNewArrivalScheduler, runNewArrivalJob };
