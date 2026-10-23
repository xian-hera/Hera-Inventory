import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, BlockStack, InlineStack, Text, Banner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '../shared/transferStatus';
import { useLocationMap } from '../shared/locationMap';

// Shared bits for the Warehouse Scheduler + Receive Shipments pages
// (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md):
// location / PB pills, the read-only PO and Transfer popups, truncation,
// location sort order, the badge-refresh event and a small toast.

export const HQ = 'HQ';

// Tab badges (WarehouseShell) reload when a page fires this event.
export function refreshWarehouseBadges() {
  window.dispatchEvent(new Event('warehouse-badges-refresh'));
}

// Cut a text to n characters with "…" (custom task Type / Title on cards —
// 12 for now, Hera 2026-10-21, to be tuned once the UI is in use).
export const CARD_TEXT_MAX = 12;
export function truncate(text, n = CARD_TEXT_MAX) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Location colours (2026-10-22, Hera — Warehouse › Settings › Location
// Color): each location's pill gets the colour set there; a location with no
// colour is light grey (before: every pill was light purple #f1edff). Loaded
// once per app load and shared by every pill; Settings updates the cache on
// Save.
export const LOC_PILL_DEFAULT = '#e4e5e7';
let locColors = null;          // { name: '#RRGGBB' } once loaded
let locColorsPromise = null;
const locColorListeners = new Set();
export function loadLocationColors() {
  if (!locColorsPromise) {
    locColorsPromise = fetch('/api/warehouse/location-colors')
      .then(r => r.json())
      .then(d => { setLocationColorsCache((d && d.colors) || {}); return locColors; })
      .catch(() => { locColorsPromise = null; return {}; });
  }
  return locColorsPromise;
}
export function setLocationColorsCache(colors) {
  locColors = { ...(colors || {}) };
  locColorListeners.forEach(fn => fn(locColors));
}
export function useLocationColors() {
  const [colors, setColors] = useState(locColors || {});
  useEffect(() => {
    locColorListeners.add(setColors);
    if (locColors) setColors(locColors); else loadLocationColors();
    return () => { locColorListeners.delete(setColors); };
  }, []);
  return colors;
}
// Dark text on light colours, white text on dark ones.
export function pillTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#303030';
  const n = parseInt(m[1], 16);
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.35 ? '#303030' : '#ffffff';
}

// Location pill (task-card style), in the location's colour.
export function LocPill({ name }) {
  const colors = useLocationColors();
  const bg = colors[name] || LOC_PILL_DEFAULT;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: bg,
      color: pillTextColor(bg), fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap', lineHeight: '18px',
    }}>{name}</span>
  );
}

const ARROW = <span aria-hidden="true" style={{ fontWeight: 700, fontSize: 13, lineHeight: '18px' }}>➔</span>;

// Location part of a card, by direction (HQ is never shown):
//   HQ → X   : ➔ [X]
//   X → HQ   : [X] ➔
//   X → Y    : [X] ➔ [Y]
//   HQ → HQ  : ➔ [HQ]   (a PO whose to location is HQ — before 2026-10-21 this
//                        showed only the arrow, i.e. an "empty" location)
export function RoutePills({ from, to }) {
  const fromHQ = !from || from === HQ;
  const toHQ = to === HQ;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', minWidth: 0 }}>
      {!fromHQ && <LocPill name={from} />}
      {ARROW}
      {(!toHQ || fromHQ) && to && <LocPill name={to} />}
    </span>
  );
}

// Truck icon (2026-10-23, Hera), truck always facing right:
//   arrow 'in'   → "➔ truck"  — load / pick up (pickup cards, Delivery › Picked up)
//   arrow 'out'  → "← truck"  — unload (Delivery › Delivered)
//   arrow 'none' → truck only (Delivery › the stop the truck is at)
// `bg` = colour behind the icon (cut-outs for the window and wheel rims).
// Drawn by Claude from Hera's mock-up until her own SVG file replaces it.
export function TruckIcon({ height = 18, color = '#231f20', bg = '#ffffff', arrow = 'in', label }) {
  const withArrow = arrow !== 'none';
  const x0 = withArrow ? 0 : 98; // viewBox starts at the truck when there is no arrow
  const vbW = 320 - x0;
  return (
    <svg width={Math.round(height * vbW / 128)} height={height} viewBox={`${x0} 0 ${vbW} 128`} role="img" aria-label={label || 'Truck'} style={{ flex: 'none', display: 'block' }}>
      {arrow === 'in' && <path d="M0 64h86M50 26l40 38-40 38" fill="none" stroke={color} strokeWidth="20" />}
      {arrow === 'out' && <path d="M8 64h86M46 26L8 64l38 38" fill="none" stroke={color} strokeWidth="20" />}
      <path d="M108 4h120a6 6 0 0 1 6 6v94H108a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6z" fill={color} />
      <path d="M240 26h44a10 10 0 0 1 8 4l22 28a10 10 0 0 1 2 6v34a6 6 0 0 1-6 6h-70z" fill={color} />
      <path d="M254 38h26l16 22h-42z" fill={bg} />
      <circle cx="146" cy="110" r="16" fill={color} stroke={bg} strokeWidth="5" />
      <circle cx="270" cy="110" r="16" fill={color} stroke={bg} strokeWidth="5" />
    </svg>
  );
}

// Pickup mark on Schedule cards: "➔ truck" right of the location, height
// follows the location pill (card fill #fff3d6 behind it).
export function PickupTruck({ height = 18 }) {
  return <TruckIcon height={height} bg="#fff3d6" arrow="in" label="Pickup" />;
}

// Pink PB pill on PO cards: "P 4" / "B 12". Nothing when there is no PB qty.
export function PbPill({ count, unit }) {
  if (!count || !unit) return null;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: '#fde0df',
      color: '#5c1414', fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap', lineHeight: '18px',
    }}>{unit} {count}</span>
  );
}

// Location sort order = the order of the shared location map (canonical:
// HQ → MTL → OTT → QC → CAL → EDM → other, numeric within a prefix; defined
// in server/routes/shopify.js compareLocationNames; editable in Purchasing →
// Settings → Locations since 2026-10-22).
// Unknown names go last, alphabetically.
export function useLocationOrder() {
  const { names } = useLocationMap();
  return useMemo(() => {
    const idx = new Map(names.map((n, i) => [n, i]));
    return (a, b) => {
      const ia = idx.has(a) ? idx.get(a) : Number.MAX_SAFE_INTEGER;
      const ib = idx.has(b) ? idx.get(b) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return String(a || '').localeCompare(String(b || ''));
    };
  }, [names]);
}

// True on phone-width screens (≤ 767px, same breakpoint as Home.js).
const PHONE_QUERY = '(max-width: 767px)';
export function useIsPhone() {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_QUERY).matches : false);
  const [phone, setPhone] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on); };
  }, []);
  return phone;
}

// Small bottom toast (the Hub has no Polaris Frame, so no Polaris Toast).
// Each call gets its own id, so the same text twice in a row still shows for
// the full time.
let toastSeq = 0;
export function useToast() {
  const [toast, setToast] = useState(null); // { text, id }
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  const msg = toast ? toast.text : '';
  const show = useCallback((text) => setToast(text ? { text, id: ++toastSeq } : null), []);
  const node = msg ? (
    <div role="status" style={{
      position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 600,
      background: '#303030', color: '#fff', padding: '10px 16px', borderRadius: 10,
      boxShadow: '0 8px 24px rgba(0,0,0,0.2)', fontWeight: 550, fontSize: 13, maxWidth: 'calc(100vw - 32px)',
    }}>{msg}</div>
  ) : null;
  return [node, show];
}

// Unsaved Schedule draft guard (2026-10-21): the Schedule page reports
// whether it has unsaved changes; the tab bar, Settings button, back arrow
// and "Jump to Transfer" ask before leaving it.
let scheduleDirty = false;
export function setScheduleDirty(v) { scheduleDirty = !!v; }
export function confirmLeaveSchedule() {
  if (!scheduleDirty) return true;
  const ok = window.confirm('The Schedule has unsaved changes. Leave without saving?');
  if (ok) scheduleDirty = false;
  return ok;
}

// Blue underlined text button (PO / transfer numbers).
export function LinkText({ children, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick && onClick(); }}
      style={{
        border: 'none', background: 'none', padding: 0, margin: 0, cursor: 'pointer', font: 'inherit',
        color: '#005bd3', textDecoration: 'underline', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  );
}

const TH = { padding: '6px 8px', textAlign: 'left', color: '#6d7175', fontWeight: 550, fontSize: 12, borderBottom: '1px solid #e1e3e5' };
const TD = { padding: '6px 8px', fontSize: 13, borderBottom: '1px solid #f1f1f1', verticalAlign: 'top' };

function ItemsTable({ rows }) {
  if (rows.length === 0) return <Text tone="subdued">No line items.</Text>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={TH}>SKU</th><th style={TH}>Name</th><th style={{ ...TH, textAlign: 'right' }}>Qty</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td style={{ ...TD, whiteSpace: 'nowrap' }}>{r.sku || '—'}</td>
              <td style={TD}>{r.name || ''}</td>
              <td style={{ ...TD, textAlign: 'right' }}>{r.quantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Read-only PO content (header + line items), like the PO Export PDF.
export function PoDetailContent({ invoiceId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setData(null); setError('');
    fetch(`/api/warehouse/po/${invoiceId}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to load PO'); return d; })
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [invoiceId]);
  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return <Text tone="subdued">Loading...</Text>;
  const inv = data.invoice;
  return (
    <BlockStack gap="300">
      <InlineStack gap="200" blockAlign="center" wrap>
        <Text variant="headingMd" as="h3">{inv.supplier_name}</Text>
        <RoutePills from={HQ} to={inv.location} />
      </InlineStack>
      <ItemsTable rows={data.items} />
    </BlockStack>
  );
}

// PO popup (click a PO number) — read-only.
export function PoPopup({ invoiceId, number, onClose }) {
  return (
    <Modal open={!!invoiceId} onClose={onClose} title={number || 'PO'}>
      <Modal.Section>
        {invoiceId ? <PoDetailContent invoiceId={invoiceId} /> : null}
      </Modal.Section>
    </Modal>
  );
}

// Transfer popup (click a transfer number) — read-only, shows the status.
// From HQ → extra "Jump to Transfer" button to the Warehouse detail page.
export function TransferPopup({ transferId, onClose, returnTo = '/warehouse' }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!transferId) return undefined;
    let cancelled = false;
    setData(null); setError('');
    fetch(`/api/transfers/${transferId}?role=warehouse`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to load transfer'); return d; })
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [transferId]);
  const tr = data && data.transfer;
  const items = data && Array.isArray(data.items) ? data.items.filter(i => i.edit_state !== 'removed') : [];
  const fromHQ = tr && tr.from_location === HQ;
  return (
    <Modal
      open={!!transferId}
      onClose={onClose}
      title={tr ? (tr.shopify_transfer_name || tr.transfer_no) : 'Transfer'}
      secondaryActions={fromHQ ? [{
        content: 'Jump to Transfer',
        onAction: () => { if (confirmLeaveSchedule()) navigate(`/warehouse/transfer/${transferId}`, { state: { from: returnTo } }); },
      }] : undefined}
    >
      <Modal.Section>
        {error ? <Banner tone="critical">{error}</Banner> : !tr ? <Text tone="subdued">Loading...</Text> : (
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center" wrap>
              <StatusBadge status={tr.status} />
              <Text as="span">From <b>{tr.from_location}</b> to <b>{tr.to_location}</b></Text>
            </InlineStack>
            <ItemsTable rows={items} />
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );
}

// Big one-of-many filter buttons (iPad): "All" + one per value. Exactly one
// is always selected.
export function FilterButtons({ values, value, onChange, allLabel = 'All' }) {
  const opts = [{ v: '__all__', label: allLabel }, ...values.map(v => ({ v, label: v }))];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {opts.map(o => {
        const on = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.v)}
            style={{
              font: 'inherit', fontSize: 15, fontWeight: on ? 650 : 500, padding: '10px 18px', minHeight: 44,
              borderRadius: 10, cursor: 'pointer', border: `1px solid ${on ? '#303030' : '#c9cccf'}`,
              background: on ? '#303030' : '#fff', color: on ? '#fff' : '#303030',
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}
export const FILTER_ALL = '__all__';
