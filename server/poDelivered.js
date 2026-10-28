// Inventory count × purchase orders (2026-10-28, Hera — replaces the old
// "PO lock", server/poLock.js, which is no longer used).
//
// When a Weekly Inventory Count task is created / published, a line item is
// left OUT of a location's task when ALL of these hold:
//   A. its SKU is in a purchase order for that location that is not committed
//      yet (po_invoices.status not committed / archived);
//   B. WH has received that PO (it has a Schedule card → a DD pill);
//   C. one of the PO's Schedule cards (any part of a split PO counts for the
//      whole PO) is on TODAY's schedule, or was already marked Delivered.
// Reason: those goods are (or will be today) on the store's shelf, but
// Shopify's System qty only includes them once the PO is committed, so the
// count could never match.
//
// SKU matching: po_invoice_items.sku vs the item's barcode, trimmed and
// case-insensitive. Location matching: po_invoices.location (name).
// Any failure answers "nothing excluded", so creating a task never fails on it.
const { pool } = require('./database/init');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// → { byLocation: { [location]: { [barcode]: [poId, …] } }, poIds: [poId, …] }
//   barcodes are returned exactly as given.
async function getDeliveredPoItems(locations, barcodes) {
  const out = { byLocation: {}, poIds: [] };
  try {
    const locs = [...new Set((locations || []).filter(Boolean))];
    const byKey = new Map(); // normalized → original barcodes
    (barcodes || []).forEach(b => {
      const k = norm(b);
      if (!k) return;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(b);
    });
    if (locs.length === 0 || byKey.size === 0) return out;
    const { torontoToday } = require('./routes/warehouse');
    const { rows } = await pool.query(
      `SELECT DISTINCT i.id, i.location, LOWER(TRIM(ii.sku)) AS k
         FROM po_invoice_items ii
         JOIN po_invoices i ON i.id = ii.invoice_id
        WHERE i.location = ANY($1::text[])
          AND i.status NOT IN ('committed', 'archived')
          AND LOWER(TRIM(ii.sku)) = ANY($2::text[])
          AND EXISTS (SELECT 1 FROM wh_tasks w
                       WHERE w.kind = 'po' AND w.po_invoice_id = i.id AND w.removed_at IS NULL
                         AND (w.sched_date = $3::date OR w.delivered_at IS NOT NULL))`,
      [locs, [...byKey.keys()], torontoToday()]
    );
    const poIds = new Set();
    for (const r of rows) {
      poIds.add(r.id);
      const loc = out.byLocation[r.location] || (out.byLocation[r.location] = {});
      for (const b of byKey.get(r.k) || []) {
        if (!loc[b]) loc[b] = [];
        if (!loc[b].includes(r.id)) loc[b].push(r.id);
      }
    }
    out.poIds = [...poIds];
  } catch (e) {
    console.error('poDelivered.getDeliveredPoItems failed:', e.message);
  }
  return out;
}

module.exports = { getDeliveredPoItems, norm };
