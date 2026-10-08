// Price Change runner (2026-10-08, Hera): every minute, apply the scheduled
// price changes that are due, then publish applied tasks to the stores 10
// minutes later. Logic in server/services/priceChange.js.
const cron = require('node-cron');
const { runDue } = require('../services/priceChange');

const TIMEZONE = 'America/Toronto';
let task = null;

function startPriceChangeScheduler() {
  if (task) { task.stop(); task = null; }
  task = cron.schedule('* * * * *', () => { runDue(); }, { timezone: TIMEZONE });
  // Catch up shortly after boot (tasks due while the server was down).
  setTimeout(() => { runDue(); }, 20 * 1000);
  console.log('[price-change] scheduler started (every minute)');
}

module.exports = { startPriceChangeScheduler };
