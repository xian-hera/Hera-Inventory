import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Popover, DatePicker, Button, InlineStack } from '@shopify/polaris';

// Store Supply — shared bits for the WH tab and the Store page
// (2026-11-09, Hera — claude/STORE_SUPPLY_SPEC.md).

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

const parseIso = (iso) => { const [y, m, d] = String(iso || '').split('-').map(Number); return y && m && d ? { y, m, d } : null; };

// 'TUE. Jan. 17' — deadlines.
export function deadlineText(iso) {
  const p = parseIso(iso);
  if (!p) return '—';
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay();
  return `${WEEKDAYS[dow]}. ${MONTHS[p.m - 1]} ${p.d}`;
}

// 'Oct. 12' — a timestamp, in this device's time zone.
export function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export async function api(method, url, body) {
  const r = await fetch(`/api/store-supply${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Something went wrong'); e.status = r.status; throw e; }
  return d;
}

// "1 = 9 bottles" (nothing when the pack size is empty)
export const packText = (packSize) => (packSize ? `1 = ${packSize}` : '');

// On / off switch with only the current option's name next to it — same
// look as the Pallet / Box switch (Receive Shipments).
export function Switch({ on, onChange, label, disabled }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        role="switch"
        aria-checked={!!on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        style={{
          width: 36, height: 20, borderRadius: 10, border: 'none', padding: 0, position: 'relative',
          background: on ? '#303030' : '#8a8a8a', cursor: disabled ? 'default' : 'pointer', flex: '0 0 auto',
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: on ? 19 : 3, width: 14, height: 14,
          borderRadius: '50%', background: 'white', transition: 'left 0.15s',
        }} />
      </button>
      <span style={{ fontSize: 14, fontWeight: 700, color: '#303030' }}>{label}</span>
    </span>
  );
}

const ROUND = {
  width: 26, height: 26, borderRadius: '50%', border: 'none', background: '#e3e3e3', color: '#303030',
  fontSize: 18, lineHeight: '26px', padding: 0, cursor: 'pointer', flex: '0 0 auto', touchAction: 'manipulation',
};

// Qty shown as plain text; a tap opens − [qty] + (bigger on phones). Leaving
// it (tap elsewhere / Enter) saves; Esc cancels. min / max are enforced.
// The − / + buttons always take their space (hidden while not editing) and
// the number sits in a box of the input's size, so opening the editor
// never moves other columns or changes the row height (2026-11-10, Hera).
export function QtyEditor({ value, onCommit, min = 0, max = null, big = false, renderValue }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ''));
  const boxRef = useRef(null);
  const cancelRef = useRef(false);
  useEffect(() => { if (!editing) setDraft(String(value ?? '')); }, [value, editing]);
  const clamp = (n) => Math.max(min, max != null ? Math.min(max, n) : n);
  const finish = () => {
    if (!editing) return;
    setEditing(false);
    if (cancelRef.current) { cancelRef.current = false; return; }
    const n = parseInt(draft, 10);
    if (!Number.isInteger(n)) return;
    const v = clamp(n);
    if (v !== Number(value)) onCommit(v);
  };
  const step = (d) => setDraft(s => String(clamp((parseInt(s, 10) || 0) + d)));
  const size = big ? 34 : 26;
  const box = {
    width: big ? 56 : 48, height: big ? 36 : 28, boxSizing: 'border-box', margin: 0, padding: 0,
    font: 'inherit', fontSize: big ? 16 : 14, borderRadius: 8, textAlign: 'center',
  };
  const roundBtn = (label, d) => (
    <button type="button" aria-label={label} tabIndex={editing ? 0 : -1} aria-hidden={!editing}
      onMouseDown={(e) => e.preventDefault()} onClick={() => step(d)}
      style={{ ...ROUND, width: size, height: size, lineHeight: `${size}px`, visibility: editing ? 'visible' : 'hidden' }}>
      {d < 0 ? '−' : '+'}
    </button>
  );
  return (
    <span
      ref={boxRef}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => { if (!boxRef.current || !boxRef.current.contains(e.relatedTarget)) finish(); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }}
    >
      {roundBtn('Less', -1)}
      {editing ? (
        <input
          autoFocus
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { cancelRef.current = true; e.currentTarget.blur(); }
          }}
          style={{ ...box, border: '1px solid #c9cccf', background: '#fff' }}
        />
      ) : (
        <button type="button" onClick={() => setEditing(true)} style={{ ...box, border: '1px solid transparent', background: 'none', cursor: 'pointer' }}>
          {renderValue ? renderValue(value) : value}
        </button>
      )}
      {roundBtn('More', 1)}
    </span>
  );
}

// Item status dot (2026-11-10): yellow = Out of Stock, grey = Archived; the
// name of the status shows on hover. Nothing for Available.
export const STATUS_TEXT = { out_of_stock: 'Out of Stock', archived: 'Archived' };
export function StatusDot({ status }) {
  if (status !== 'out_of_stock' && status !== 'archived') return null;
  return (
    <span title={STATUS_TEXT[status]} aria-label={STATUS_TEXT[status]} style={{
      display: 'inline-block', width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', marginRight: 6, verticalAlign: 'middle',
      background: status === 'out_of_stock' ? '#e2ac0c' : '#8a8a8a', position: 'relative', top: -1,
    }} />
  );
}

// Confirm dialog placed high on the screen (Polaris Modal rises from the
// bottom on phones, where Shopify's own bottom bar can cover its buttons).
export function ConfirmBox({ open, title, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel, busy }) {
  if (!open) return null;
  return createPortal(
    <div onClick={() => { if (!busy) onCancel(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 520, background: 'rgba(0,0,0,0.45)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '12vh 12px 0' }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(440px, 100%)', background: '#fff', borderRadius: 14, padding: 16, boxSizing: 'border-box', boxShadow: '0 10px 30px rgba(0,0,0,0.25)' }}>
        <div style={{ fontSize: 16, fontWeight: 650, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 14, color: '#303030', marginBottom: 16 }}>{children}</div>
        <InlineStack align="end" gap="200">
          {cancelLabel && <Button onClick={onCancel} disabled={busy}>{cancelLabel}</Button>}
          <Button variant="primary" onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
        </InlineStack>
      </div>
    </div>,
    document.body
  );
}

// Calendar button + month picker; `afterIso` and weekends can't be picked.
export function DeadlinePicker({ value, afterIso, onPick, label = 'Choose a date' }) {
  const [open, setOpen] = useState(false);
  const start = parseIso(value) || parseIso(afterIso) || (() => { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() }; })();
  const [view, setView] = useState({ month: start.m - 1, year: start.y });
  const toDate = (iso) => { const p = parseIso(iso); return p ? new Date(p.y, p.m - 1, p.d) : null; };
  const after = toDate(afterIso);
  const weekends = [];
  const days = new Date(view.year, view.month + 1, 0).getDate();
  for (let d = 1; d <= days; d += 1) {
    const dt = new Date(view.year, view.month, d);
    if (dt.getDay() === 0 || dt.getDay() === 6) weekends.push(dt);
  }
  const sel = toDate(value);
  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      activator={(
        <button type="button" aria-label={label} title={label} onClick={() => setOpen(o => !o)}
          style={{ border: 'none', background: 'none', padding: 2, cursor: 'pointer', display: 'inline-flex' }}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="#2c6ecb" strokeWidth="1.6">
            <rect x="3" y="4.5" width="14" height="12.5" rx="2" /><path d="M3 8.5h14M7 2.5v4M13 2.5v4" />
          </svg>
        </button>
      )}
    >
      <div style={{ padding: 12 }}>
        <DatePicker
          month={view.month}
          year={view.year}
          onMonthChange={(month, year) => setView({ month, year })}
          selected={sel || undefined}
          disableDatesBefore={after ? new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1) : undefined}
          disableSpecificDates={weekends}
          onChange={({ start: s }) => {
            const iso = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
            setOpen(false);
            onPick(iso);
          }}
        />
      </div>
    </Popover>
  );
}
