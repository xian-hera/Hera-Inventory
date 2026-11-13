// Scan matching with secondary barcodes (2026-11-13, Hera).
// A product can carry several barcodes; Hub's SKU is always its first
// (primary) one. Pages that match a scan against their own item list by SKU
// first try the scanned code as-is; only when nothing matches they ask the
// server which product the code belongs to (GET /api/shopify/resolve-barcode,
// Shopify's barcode: search matches any of a variant's barcodes) and try
// again with its primary barcode. Answers are kept for the page session.

const cache = new Map(); // scanned code → Promise<string[]> (primary barcodes / SKUs)

export function primaryBarcodesFor(code) {
  if (!cache.has(code)) {
    const p = fetch(`/api/shopify/resolve-barcode?barcode=${encodeURIComponent(code)}`)
      .then(r => (r.ok ? r.json() : { barcodes: [] }))
      .then(d => (Array.isArray(d.barcodes) ? d.barcodes : []))
      .catch(() => { cache.delete(code); return []; }); // network error → try again next scan
    cache.set(code, p);
  }
  return cache.get(code);
}

// getList: () => current items (read again after the server answers);
// key: the item field holding the SKU / primary barcode ('sku' or 'barcode').
// Resolves to the matching item, or null.
export async function findScannedItem(getList, code, key) {
  const same = (v) => String(v == null ? '' : v).trim();
  const direct = (getList() || []).find(i => same(i[key]) === code);
  if (direct) return direct;
  const primaries = await primaryBarcodesFor(code);
  if (primaries.length === 0) return null;
  return (getList() || []).find(i => primaries.includes(same(i[key]))) || null;
}
