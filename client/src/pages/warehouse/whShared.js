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

// Purple location pill (task-card style).
export function LocPill({ name }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: '#e6deff',
      color: '#2b1a66', fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap', lineHeight: '18px',
    }}>{name}</span>
  );
}

const ARROW = <span aria-hidden="true" style={{ fontWeight: 700, fontSize: 13, lineHeight: '18px' }}>➔</span>;

// Location part of a card, by direction (HQ is never shown):
//   HQ → X   : ➔ [X]
//   X → HQ   : [X] ➔
//   X → Y    : [X] ➔ [Y]
export function RoutePills({ from, to }) {
  const fromHQ = !from || from === HQ;
  const toHQ = to === HQ;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', minWidth: 0 }}>
      {!fromHQ && <LocPill name={from} />}
      {ARROW}
      {!toHQ && to && <LocPill name={to} />}
    </span>
  );
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
// MTL → EDM → CAL → OTT → QC → other → HQ, numeric within a prefix).
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
