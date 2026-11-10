// Store Supply tables (2026-11-09, Hera — claude/STORE_SUPPLY_SPEC.md).
// Called from initDatabase() inside its transaction.
//
//   supply_groups / supply_items — WH's item list (Supply Management). Order
//     = sort_order (groups, then items inside a group); it is also the order
//     on the Store page, Shopping List and Inventory. inventory_qty = WH stock
//     (packs).
//   supply_deadlines — every date that has been the Current Deadline; a batch
//     is (previous deadline, this deadline]. closed_at set when it closed.
//   supply_requests — one per store per deadline: 'draft' (Store still
//     choosing) → 'submitted' → 'approved' (WH). auto_submitted = submitted by
//     the cycle close.
//   supply_request_lines — the items of a request. item_name / pack_size are
//     a snapshot (kept when WH renames or deletes the item later); qty =
//     what the store asked; approved_qty = WH's changed qty (NULL = unchanged).
// Deadline settings live in app_settings key 'store_supply'.
async function ensureStoreSupplyTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS supply_groups (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS supply_items (
      id            SERIAL PRIMARY KEY,
      group_id      INTEGER NOT NULL REFERENCES supply_groups(id),
      name          TEXT NOT NULL,
      pack_size     TEXT,
      max_qty       INTEGER,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      inventory_qty INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS supply_deadlines (
      deadline   DATE PRIMARY KEY,
      closed_at  TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS supply_requests (
      id             SERIAL PRIMARY KEY,
      location       TEXT NOT NULL,
      deadline       DATE NOT NULL,
      status         TEXT NOT NULL DEFAULT 'draft',
      submitted_at   TIMESTAMPTZ,
      auto_submitted BOOLEAN NOT NULL DEFAULT FALSE,
      approved_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (location, deadline)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS supply_request_lines (
      id           SERIAL PRIMARY KEY,
      request_id   INTEGER NOT NULL REFERENCES supply_requests(id) ON DELETE CASCADE,
      item_id      INTEGER REFERENCES supply_items(id) ON DELETE SET NULL,
      item_name    TEXT NOT NULL,
      pack_size    TEXT,
      qty          INTEGER NOT NULL,
      approved_qty INTEGER,
      sort_order   INTEGER NOT NULL DEFAULT 0
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS idx_supply_lines_request ON supply_request_lines (request_id)');
  // Item status (2026-11-10, Hera):
  //   'available'    — Stores can request it;
  //   'out_of_stock' — shown greyed to Stores, can't be requested. Set by the
  //                    system only: Hera Stock is on and inventory is 0
  //                    (back to available when stock comes back);
  //   'archived'     — WH's own; Stores don't see it.
  // hera_stock = "Hera Stock" checkbox. See services/storeSupply.refreshItemStatus.
  await client.query(`ALTER TABLE supply_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'available'`);
  await client.query(`ALTER TABLE supply_items ADD COLUMN IF NOT EXISTS hera_stock BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query('CREATE INDEX IF NOT EXISTS idx_supply_requests_deadline ON supply_requests (deadline)');
  // Step 2 (2026-11-10): a closed batch is finished when its shopping is done
  // (the Store Supply tasks come from its approved requests). Closed batches
  // not finished yet together form the Current Batch.
  await client.query('ALTER TABLE supply_deadlines ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ');
  // The Shopping List's own state, one row per item (only one list exists at
  // a time — the Current Batch's): WH's changed Qty to Buy (buy_qty, valid
  // while the requested total is still base_requested) and Bought (bought_qty
  // = the qty when it was checked). Cleared when shopping is finished.
  await client.query(`
    CREATE TABLE IF NOT EXISTS supply_shopping (
      item_id        INTEGER PRIMARY KEY REFERENCES supply_items(id) ON DELETE CASCADE,
      buy_qty        INTEGER,
      base_requested INTEGER,
      bought         BOOLEAN NOT NULL DEFAULT FALSE,
      bought_qty     INTEGER,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Step 3 (2026-11-10): Store Supply tasks on the WH Schedule — wh_tasks
  // kind 'supply', one per approved request (with something to deliver) of a
  // finished batch (services/storeSupply.ensureSupplyTasks). From HQ to the
  // store (to_location); can't be split or deleted. supply_deducted_at = its
  // quantities were taken off Inventory (Go!, or tracked back to a past day).
  const kc = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'wh_tasks'::regclass AND conname = 'wh_tasks_kind_check'`
  );
  // 'online_boxes' added 2026-11-10 (Fulfiller Online Boxes — onlineBoxesSchema.js).
  if (!kc.rows.length || !kc.rows[0].def.includes('supply') || !kc.rows[0].def.includes('online_boxes')) {
    await client.query('ALTER TABLE wh_tasks DROP CONSTRAINT IF EXISTS wh_tasks_kind_check');
    await client.query(`ALTER TABLE wh_tasks ADD CONSTRAINT wh_tasks_kind_check CHECK (kind IN ('po', 'transfer', 'custom', 'supply', 'online_boxes'))`);
  }
  await client.query('ALTER TABLE wh_tasks ADD COLUMN IF NOT EXISTS supply_request_id INTEGER REFERENCES supply_requests(id) ON DELETE CASCADE');
  await client.query('ALTER TABLE wh_tasks ADD COLUMN IF NOT EXISTS supply_deducted_at TIMESTAMPTZ');
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wh_tasks_supply ON wh_tasks (supply_request_id) WHERE kind = 'supply'`);
}

module.exports = { ensureStoreSupplyTables };
