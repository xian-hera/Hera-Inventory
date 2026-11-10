// Online Boxes (2026-11-10, Hera — claude/FULFILLER_ONLINE_BOXES.md).
// Fulfiller asks the WH truck to bring boxes from HQ to a store. Each request
// is one wh_tasks row, kind 'online_boxes' (the kind is allowed by the CHECK
// constraint set in storeSupplySchema.js), from HQ to to_location.
//   ob_request_id  Fulfiller's requestId (unique among online_boxes rows)
//   ob_items       [{ label, quantity, orderId, orderName }] — the hover list
//   ob_note        optional note (hover)
//   ob_sent_date / ob_sent_half — the schedule last sent to Fulfiller
//                  (online_boxes.scheduled); ob_sent = a message was sent at all.
// Called from initDatabase() inside its transaction, after storeSupplySchema.
async function ensureOnlineBoxesColumns(client) {
  await client.query('ALTER TABLE wh_tasks ADD COLUMN IF NOT EXISTS ob_request_id TEXT');
  await client.query('ALTER TABLE wh_tasks ADD COLUMN IF NOT EXISTS ob_items JSONB');
  await client.query('ALTER TABLE wh_tasks ADD COLUMN IF NOT EXISTS ob_note TEXT');
  await client.query('ALTER TABLE wh_tasks ADD COLUMN IF NOT EXISTS ob_sent BOOLEAN NOT NULL DEFAULT FALSE');
  await client.query('ALTER TABLE wh_tasks ADD COLUMN IF NOT EXISTS ob_sent_date DATE');
  await client.query('ALTER TABLE wh_tasks ADD COLUMN IF NOT EXISTS ob_sent_half TEXT');
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wh_tasks_online_boxes ON wh_tasks (ob_request_id) WHERE kind = 'online_boxes'`);
}

module.exports = { ensureOnlineBoxesColumns };
