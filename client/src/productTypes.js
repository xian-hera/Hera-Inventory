import { useEffect, useState } from 'react';

// Product Types — frontend side (2026-10-21, Hera).
// One central list for the whole Hub: /api/shopify/product-types returns the
// ENABLED types of the central table (Purchasing → Settings → Product Types).
// Dropdowns use this hook instead of their own hardcoded lists.
//
// useProductTypes(fallback, upper) → array of type names.
//   * while loading → [] (so a hardcoded name never flashes);
//   * if the request fails → `fallback` (the page's old hardcoded list);
//   * upper = true → names are upper-cased and de-duplicated (Stock Losses keeps
//     product types in upper case).

let cache = null; // promise of the list

export function invalidateProductTypes() { cache = null; }

function load() {
  if (!cache) {
    cache = fetch('/api/shopify/product-types')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (Array.isArray(d) ? d : null))
      .catch(() => null);
  }
  return cache;
}

export function useProductTypes(fallback = [], upper = false) {
  const [list, setList] = useState(null);
  useEffect(() => {
    let cancelled = false;
    load().then((d) => {
      if (cancelled) return;
      if (d === null) cache = null; // allow a retry next time
      setList(d === null ? (fallback || []) : d);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (list === null) return [];
  return upper ? [...new Set(list.map((t) => String(t).toUpperCase()))] : list;
}
