// Shared location map (2026-09-24, Hera).
//
// The ONE place every frontend page gets its list of locations from. Backed
// by the server's location_map table (GET /api/shopify/location-map), which
// the Buyer Settings "Sync Locations" button (and one automatic run at each
// server startup) refreshes from Shopify.
//
// This replaced two older sources that had drifted apart:
//   1. a hardcoded 19-code LOCATIONS / BRANCHES constant copied into ~10
//      pages (CreatingTask, CountingTasksList, ZeroQtyReport, BuyerPriceChange,
//      BuyerPOImportInvoice, BuyerStockLosses, BuyerWigDemo, ManagerHome,
//      EmployeeCap) — adding a store meant editing every one of them;
//   2. per-page live calls to GET /api/shopify/locations (Transfer, BOX PO,
//      Manager task/stock-loss/restock/zero-qty/wig-demo pages).
//
// The server already returns the list in canonical order (MTL → EDM → CAL →
// OTT → QC → other → HQ, numeric within a prefix) — the same order the old
// hardcoded lists used — so pages must NOT re-sort it.
//
// Fetched once per app load and shared by every page (module-level cache);
// clearLocationMapCache() is called after a manual Sync so the next page
// picks up the new list.

import { useEffect, useMemo, useState } from 'react';

let cachePromise = null;

export function fetchLocationMap() {
  if (!cachePromise) {
    cachePromise = fetch('/api/shopify/location-map')
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
        return Array.isArray(data) ? data : [];
      })
      .catch((e) => {
        // Never cache a failure — the next caller retries.
        cachePromise = null;
        throw e;
      });
  }
  return cachePromise;
}

export function clearLocationMapCache() {
  cachePromise = null;
}

// Resolve one location code (e.g. "MTL01") to { id, name }. Returns
// undefined when the code isn't in the map (same "not found" outcome the
// pages used to get from searching the live Shopify list).
export async function findLocationByName(name) {
  const list = await fetchLocationMap();
  return list.find((l) => l.name === name);
}

// React hook. `excludeHQ` exists for Zero Qty Report, which has never
// listed HQ (by design, confirmed by Hera 2026-09-24).
//   locations: [{ id, name }]   names: ['MTL01', ...]
//   loading: true until the first answer; error: message string or ''
export function useLocationMap({ excludeHQ = false } = {}) {
  const [state, setState] = useState({ locations: [], loading: true, error: '' });

  useEffect(() => {
    let cancelled = false;
    fetchLocationMap()
      .then((list) => { if (!cancelled) setState({ locations: list, loading: false, error: '' }); })
      .catch((e) => { if (!cancelled) setState({ locations: [], loading: false, error: e.message || 'Failed to load locations' }); });
    return () => { cancelled = true; };
  }, []);

  // Memoized so `locations` / `names` keep the same identity between renders
  // (safe to use in useEffect/useCallback dependency lists).
  const locations = useMemo(
    () => (excludeHQ ? state.locations.filter((l) => l.name !== 'HQ') : state.locations),
    [state.locations, excludeHQ]
  );
  const names = useMemo(() => locations.map((l) => l.name), [locations]);
  return { locations, names, loading: state.loading, error: state.error };
}
