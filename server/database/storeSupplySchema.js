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
}

module.exports = { ensureStoreSupplyTables };
