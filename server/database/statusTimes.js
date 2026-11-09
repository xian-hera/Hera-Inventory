// "Time of the current status" (2026-11-09, Hera).
//
// Store (MA) History cards and Purchasing (BY) lists show WHEN a row got its
// current status ("HH:MM, Oct. 12") instead of when it was created. Status
// changes happen in many places (tasks.js, poInvoices.js, transfers.js,
// reports.js, stockLosses.js, jobs …), so instead of touching every UPDATE a
// small Postgres trigger stamps the time whenever `status` changes:
//
//   tasks / po_invoices / transfers / zero_qty_reports / stock_losses
//     .status_changed_at — set on INSERT, and on UPDATE when status changes.
//   manager_history
//     .label_at — set on INSERT, and on UPDATE when label changes or the row
//     is bumped (created_at moved by a manager re-submit).
//
// Rows that existed before this change get a best-guess time once (the
// column is NULL only for them), from the timestamps each table already had.
// Called from initDatabase() inside its transaction.

const STATUS_TABLES = {
  tasks: `COALESCE(updated_at, created_at)`,
  po_invoices: `CASE
      WHEN status IN ('committed', 'archived') THEN COALESCE(committed_at, updated_at, created_at)
      WHEN status = 'store_counted' THEN COALESCE(store_counted_at, updated_at, created_at)
      WHEN status = 'sent_to_store' THEN COALESCE(sent_to_store_at, updated_at, created_at)
      ELSE COALESCE(created_at, updated_at) END`,
  transfers: `CASE
      WHEN status IN ('committed', 'archived') THEN COALESCE(committed_at, updated_at, created_at)
      WHEN status IN ('counted', 'not_counted') THEN COALESCE(counted_at, updated_at, created_at)
      WHEN status = 'receiving' THEN COALESCE(delivered_at, updated_at, created_at)
      WHEN status = 'in_transit' THEN COALESCE(dispatched_at, updated_at, created_at)
      ELSE COALESCE(updated_at, created_at) END`,
  zero_qty_reports: `CASE
      WHEN status IN ('committed', 'archived') THEN COALESCE(committed_at, submitted_at)
      ELSE submitted_at END`,
  stock_losses: `CASE
      WHEN status = 'archived' THEN COALESCE(archived_at, committed_at, submitted_at)
      WHEN status = 'committed' THEN COALESCE(committed_at, submitted_at)
      ELSE submitted_at END`,
};

async function ensureStatusTimes(client) {
  await client.query(`
    CREATE OR REPLACE FUNCTION hub_stamp_status_changed_at() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.status_changed_at := COALESCE(NEW.status_changed_at, NOW());
      ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        NEW.status_changed_at := NOW();
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  for (const [table, guess] of Object.entries(STATUS_TABLES)) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ`);
    await client.query(`UPDATE ${table} SET status_changed_at = ${guess} WHERE status_changed_at IS NULL`);
    await client.query(`DROP TRIGGER IF EXISTS trg_${table}_status_changed_at ON ${table}`);
    await client.query(`
      CREATE TRIGGER trg_${table}_status_changed_at
        BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION hub_stamp_status_changed_at()
    `);
  }

  // manager_history.label_at
  await client.query(`
    CREATE OR REPLACE FUNCTION hub_stamp_label_at() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.label_at := COALESCE(NEW.label_at, NOW());
      ELSIF NEW.label IS DISTINCT FROM OLD.label OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        NEW.label_at := NOW();
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await client.query(`ALTER TABLE manager_history ADD COLUMN IF NOT EXISTS label_at TIMESTAMPTZ`);
  // Existing rows: a committed Weekly Count / PO takes its commit time from
  // the source row; everything else its own date.
  await client.query(`
    UPDATE manager_history h SET label_at = COALESCE(
      CASE
        WHEN h.kind = 'task' AND h.label = 'Committed'
          THEN (SELECT t.status_changed_at FROM tasks t WHERE t.task_no = h.ref_no LIMIT 1)
        WHEN h.kind = 'po_invoice' AND h.label = 'Committed'
          THEN (SELECT i.committed_at FROM po_invoices i WHERE i.id::text = h.detail->>'invoice_id' LIMIT 1)
      END, h.created_at)
    WHERE h.label_at IS NULL
  `);
  await client.query(`DROP TRIGGER IF EXISTS trg_manager_history_label_at ON manager_history`);
  await client.query(`
    CREATE TRIGGER trg_manager_history_label_at
      BEFORE INSERT OR UPDATE ON manager_history
      FOR EACH ROW EXECUTE FUNCTION hub_stamp_label_at()
  `);
}

module.exports = { ensureStatusTimes };
