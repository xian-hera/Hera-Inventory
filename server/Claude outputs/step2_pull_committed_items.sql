-- Step 2: pull every committed line item across the 15 affected invoices.
-- actual_qty_applied replicates commitInvoice's logic exactly:
--   COALESCE(store_count, quantity) — store_count wins when the manager
--   counted the invoice, otherwise falls back to the original invoice qty.
SELECT
  i.invoice_number,
  i.location,
  i.shopify_location_id,
  it.sku,
  it.quantity            AS invoice_qty,
  it.store_count,
  COALESCE(it.store_count, it.quantity) AS actual_qty_applied,
  it.committed
FROM po_invoice_items it
JOIN po_invoices i ON i.id = it.invoice_id
WHERE i.invoice_number IN (
  'PO-A085', 'PO-A097', 'PO-A082', 'PO-A083', 'PO-A089',
  'PO-A087', 'PO-A095', 'PO-A096', 'PO-A088', 'PO-A090',
  'PO-A094', 'PO-A086', 'PO-A091', 'PO-A093', 'PO-A092'
)
  AND it.committed = TRUE
  AND it.sku IS NOT NULL
ORDER BY i.invoice_number, it.sku;
