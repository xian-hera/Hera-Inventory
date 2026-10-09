// Purchase-order lock for inventory counts (2026-10, Hera).
//
// A SKU is "PO locked" at a location while some invoice for that location is
// not yet committed or archived (status pending / sent_to_store /
// store_counted, incl. while its background commit is running) and that
// invoice has a line item with that SKU. Counting such a SKU is pointless —
// its stock is about to change — so Weekly Count / Manual Count skip it and the
// buyer's commit ignores it. The lock lifts by itself when the invoice is
// committed, archived or deleted (nothing is stored; always computed live).
//
// SKU matching: po_invoice_items.sku vs the count item's barcode, trimmed and
// case-insensitive. Location matching: po_invoices.shopify_location_id.
// Any failure answers "nothing locked" so counting never gets blocked by it.
const { pool } = require('./database/init');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// → Set of normalized SKUs (from `barcodes`) that are locked at the location.
async function getPoLockedSet(shopifyLocationId, barcodes) {
  try {
    if (!shopifyLocationId || !Array.isArray(barcodes) || barcodes.length === 0) return new Set();
    const keys = [...new Set(barcodes.map(norm).filter(Boolean))];
    if (keys.length === 0) return new Set();
    const { rows } = await pool.query(
      `SELECT DISTINCT LOWER(TRIM(ii.sku)) AS k
         FROM po_invoice_items ii
         JOIN po_invoices i ON i.id = ii.invoice_id
        WHERE i.shopify_location_id = $1
          AND i.status NOT IN ('committed', 'archived')
          AND LOWER(TRIM(ii.sku)) = ANY($2::text[])`,
      [shopifyLocationId, keys]
    );
    return new Set(rows.map(r => r.k));
  } catch (e) {
    console.error('poLock.getPoLockedSet failed:', e.message);
    return new Set();
  }
}

module.exports = { getPoLockedSet, norm };
