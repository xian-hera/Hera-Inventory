import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Page, BlockStack, InlineStack, Text, Button, Banner, Modal, TextField, Select,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { useLocationMap } from '../shared/locationMap';
import {
  HQ, PbPill, LinkText, PoPopup, TransferPopup, truncate, LocPill, PickupTruck,
  useLocationOrder, useToast, refreshWarehouseBadges, setScheduleDirty, confirmLeaveSchedule,
} from './whShared';

// Warehouse › Schedule (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md).
//
// Cards: received POs (+ their splits), transfers, WH custom tasks. They are
// placed on Morning / Afternoon of the next 7 business days (today first;
// weekends are a narrow strip and can't take tasks) by "select, then Add
// Here" — no drag and drop.
//
// Placing / reordering / unscheduling only change a local draft until Save
// (Discard throws the draft away). Split, Delete, Create task, track back
// and Go! are saved at once and keep the draft as it is.
//
// LOCKED days — every day of the "Past 7 days" view, and today once Go! was
// pressed: their tasks can't be moved or reordered. The only thing allowed is
// "track back": adding Unscheduled tasks to the bottom of a half-day (to
// record work that was done but never scheduled); only tracked-back tasks can
// be taken off again (Unschedule / Delete).
//
// Unscheduled shows transfers only when they are Ready to Ship.
// Desktop / iPad page: the content is a centred block a bit wider than the
// normal page (same technique as Online › New Products); title and tab bar
// stay at normal width.

const CONTENT_W = 1280; // to be tuned by eye (Hera 2026-10-21)
// (2026-10-22, Hera) Half-days are never folded any more — every card is
// shown and the page simply gets longer. The "Show N more" button and its
// 6-card limit (CAP) were removed.
const HALF_PILL = {
  display: 'inline-block', padding: '2px 10px', borderRadius: 999, background: '#ebebeb',
  color: '#303030', fontSize: 14, fontWeight: 700, lineHeight: '20px', whiteSpace: 'nowrap',
};
// label = calendar pill text (AM / PM since 2026-10-23); name = used in
// messages ("Wed, Oct 21 · Morning").
const HALVES = [{ id: 'AM', label: 'AM', name: 'Morning' }, { id: 'PM', label: 'PM', name: 'Afternoon' }];
const PINK = '#e0336f';

const slotKey = (date, half) => `${date}|${half}`;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return { dow: WEEKDAY[dt.getUTCDay()], mon: MONTH[m - 1], m, d, dt };
}
const mmdd = (iso) => { const p = dateParts(iso); return `${String(p.m).padStart(2, '0')}.${String(p.d).padStart(2, '0')}`; };
const longDay = (iso) => { const p = dateParts(iso); return `${p.dow}, ${p.mon} ${p.d}`; };

// Days → calendar columns, with each run of non-business days between two
// business days merged into one narrow strip.
function buildColumns(days) {
  const cols = [];
  days.forEach((iso, i) => {
    if (i > 0) {
      const prev = dateParts(days[i - 1]).dt;
      const cur = dateParts(iso).dt;
      const gap = Math.round((cur - prev) / 86400000);
      if (gap > 1) {
        const first = new Date(prev.getTime() + 86400000);
        const last = new Date(cur.getTime() - 86400000);
        const fmt = (dt) => `${WEEKDAY[dt.getUTCDay()]} ${String(dt.getUTCMonth() + 1).padStart(2, '0')}.${String(dt.getUTCDate()).padStart(2, '0')}`;
        cols.push({ weekend: true, key: `w-${iso}`, label: gap === 2 ? fmt(first) : `${fmt(first)} – ${fmt(last)}` });
      }
    }
    cols.push({ weekend: false, key: iso, date: iso });
  });
  return cols;
}

// Saved calendar (from the server task list) → { 'date|half': [ids in order] }.
function slotsFromTasks(tasks, days) {
  const inWindow = new Set(days);
  const slots = {};
  tasks
    .filter(t => t.date && t.half && inWindow.has(t.date))
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.id - b.id)
    .forEach(t => { const k = slotKey(t.date, t.half); (slots[k] = slots[k] || []).push(t.id); });
  return slots;
}
const normSlots = (slots) => {
  const out = {};
  Object.keys(slots).sort().forEach(k => { if (slots[k] && slots[k].length) out[k] = slots[k]; });
  return JSON.stringify(out);
};

// The location shown ON the card. A store → store transfer is split into two
// cards (Hera 2026-10-21, second version): 'pickup' = store → HQ ("MTL01 ➔"),
// 'deliver' = HQ → store ("➔ MTL02"). They share one colour stripe so they
// can be found even though grouping puts them in different places.
function cardRoute(t) {
  if (t.kind === 'transfer' && t.leg === 'pickup') return { from: t.from, to: HQ };
  if (t.kind === 'transfer' && t.leg === 'deliver') return { from: HQ, to: t.to };
  if (t.kind === 'transfer') return { from: t.from, to: t.to };
  if (t.kind === 'custom') return { from: t.from || HQ, to: t.to }; // custom From (2026-10-23)
  return { from: HQ, to: t.to };
}

// One colour per split transfer (stripe on both of its cards).
const PAIR_COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#84cc16', '#0ea5e9', '#d946ef'];
const pairColor = (transferId) => PAIR_COLORS[Math.abs(Number(transferId) || 0) % PAIR_COLORS.length];

// Hover box (rules changed 2026-10-23, Hera):
//   PO              → full Supplier name + PB qty
//   transfer        → nothing, except a split store → store card → the real
//                     route "{from} ➔ {to}" (locations bold)
//   custom          → Title + Note
// "Tracked back" is added under any box that is shown. Rendered in a portal
// with fixed position so the calendar's scroll box and the page's centring
// transform can't clip or shift it.
function HoverBox({ task, rect }) {
  if (!rect) return null;
  let body = null;
  if (task.kind === 'po') {
    body = (
      <>
        <div style={{ fontWeight: 700 }}>{task.supplier || '—'}</div>
        {task.pbCount && task.pbUnit
          ? <div style={{ marginTop: 4 }}><PbPill count={task.pbCount} unit={task.pbUnit} /></div>
          : <div style={{ marginTop: 2, color: '#6d7175', fontSize: 12 }}>No P / B qty</div>}
      </>
    );
  } else if (task.kind === 'transfer') {
    if (task.leg) body = <div><b>{task.from}</b> ➔ <b>{task.to}</b></div>;
  } else {
    body = (
      <>
        <div style={{ fontWeight: 700 }}>{task.title}</div>
        {task.note && <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{task.note}</div>}
      </>
    );
  }
  if (!body) return null;
  const above = rect.top > 140;
  return createPortal(
    <div style={{
      position: 'fixed', zIndex: 700, left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
      top: above ? rect.top - 6 : rect.bottom + 6, transform: above ? 'translateY(-100%)' : 'none',
      maxWidth: 280, background: '#fff', color: '#303030', border: '1px solid #c9cccf', borderRadius: 8,
      boxShadow: '0 6px 18px rgba(0,0,0,0.15)', padding: '8px 10px', fontSize: 13, lineHeight: '18px', pointerEvents: 'none',
    }}>
      {body}
      {task.trackedBack && <div style={{ marginTop: 4, color: '#6d7175', fontSize: 12 }}>Tracked back</div>}
    </div>,
    document.body
  );
}

// Pickup card = WH goes to a store and brings the goods to HQ: a store → HQ
// transfer, or part 1 of a split store → store transfer (2026-10-23, Hera).
// Also a custom task To HQ (From a store), 2026-10-23.
const isPickup = (t) => (t.kind === 'transfer' || t.kind === 'custom') && cardRoute(t).to === HQ && cardRoute(t).from !== HQ;
const PICKUP_BG = '#fff3d6';
const PICKUP_BORDER = '#e2ac0c';

// One task card. `compact` = the calendar version (slightly smaller, with
// the order number in front). `partnerLit` = the other card of the same
// split transfer is hovered or selected → this one gets a glow in the pair
// colour. `locked` = on a locked day and not tracked back → not selectable.
function TaskCard({ task, selected, onToggle, onOpenNumber, order, compact, locked, partnerLit, onHoverPair }) {
  const fs = compact ? 12 : 13;
  const [hoverRect, setHoverRect] = useState(null);
  const route = cardRoute(task);
  const pc = task.kind === 'transfer' && task.leg ? pairColor(task.transferId) : null;
  // Cards show only the location now — no arrows (2026-10-23, Hera). The
  // location is the store the truck goes to: `to` for deliveries, `from` for
  // pickups (followed by the ➔ truck mark).
  const pickup = isPickup(task);
  const where = pickup ? route.from : route.to;
  const locLine = (
    <>
      <LocPill name={where} />
      {pickup && <PickupTruck height={compact ? 16 : 18} />}
    </>
  );
  let first;
  let second;
  if (task.kind === 'po') {
    // PO: Supplier on top, PO number + location below; no PB pill on the
    // card any more (shown on hover) — 2026-10-23, Hera.
    first = <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{task.supplier}</span>;
    // Location first, PO number after it (2026-10-23) — like transfers, the
    // location is always at the bottom-left.
    second = (
      <>
        {locLine}
        <LinkText onClick={() => onOpenNumber(task)}>{task.number}</LinkText>
      </>
    );
  } else if (task.kind === 'transfer') {
    first = (
      <>
        <LinkText onClick={() => onOpenNumber(task)}>{task.number}</LinkText>
        {task.tag && <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{task.tag}</span>}
        {/* 1/2 · 2/2 on the first line now (2026-10-23); a long tag is cut
            (…) instead of wrapping. */}
        {pc && <span style={{ marginLeft: 'auto', flex: 'none', paddingLeft: 4, fontSize: 11, fontWeight: 700, color: pc }}>{task.leg === 'pickup' ? '1/2' : '2/2'}</span>}
      </>
    );
    second = locLine;
  } else {
    first = (
      <>
        <span style={{ whiteSpace: 'nowrap', color: '#303030' }}>{truncate(task.type || 'Custom')}</span>
        <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{truncate(task.title)}</span>
      </>
    );
    second = locLine;
  }
  // Pickup: whole card #fff3d6 with a #e2ac0c border of the normal width.
  const borderColor = selected ? PINK : pickup ? PICKUP_BORDER : '#c9cccf';
  const bw = selected ? 2 : 1;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-disabled={locked || undefined}
      onMouseEnter={(e) => { setHoverRect(e.currentTarget.getBoundingClientRect()); if (pc && onHoverPair) onHoverPair(task.transferId); }}
      onMouseLeave={() => { setHoverRect(null); if (pc && onHoverPair) onHoverPair(null); }}
      onClick={() => { if (!locked) onToggle(task.id); }}
      onKeyDown={(e) => { if (!locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle(task.id); } }}
      style={{
        position: 'relative', boxSizing: 'border-box', cursor: locked ? 'default' : 'pointer', textAlign: 'left',
        border: `${bw}px solid ${borderColor}`,
        borderLeft: pc ? `5px solid ${pc}` : `${bw}px solid ${borderColor}`,
        boxShadow: partnerLit && pc ? `0 0 0 3px ${pc}55` : 'none',
        padding: `${compact ? 5 - (bw - 1) : 7 - (bw - 1)}px ${compact ? 8 - (bw - 1) : 10 - (bw - 1)}px`,
        borderRadius: 10, background: pickup ? PICKUP_BG : locked ? '#f7f7f7' : '#fff', fontSize: fs, lineHeight: '18px',
        display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, paddingRight: selected ? 12 : 0 }}>
        {order != null && <span style={{ color: '#6d7175', fontSize: 11, minWidth: 12, fontVariantNumeric: 'tabular-nums' }}>{order}</span>}
        {first}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, rowGap: 4 }}>{second}</div>
      <HoverBox task={task} rect={hoverRect} />
      {selected && (
        <span aria-hidden="true" style={{
          position: 'absolute', top: -8, right: -8, width: 18, height: 18, borderRadius: '50%', background: PINK,
          display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 2px #fff',
        }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="1.8"><path d="M2 5.2l2 2 4-4.4" /></svg>
        </span>
      )}
    </div>
  );
}

// ─── Modals ──────────────────────────────────────────────────────────────────

function CreateTaskModal({ open, onClose, onCreated }) {
  const navigate = useNavigate();
  const { names } = useLocationMap({ excludeHQ: true });
  const [types, setTypes] = useState(null);
  const [type, setType] = useState('');
  // From (2026-10-23, Hera): default HQ. One side must be HQ, so a store as
  // From makes To = HQ (a pickup); From = HQ → To is any store.
  const [from, setFrom] = useState(HQ);
  const [to, setTo] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setType(''); setFrom(HQ); setTo(''); setTitle(''); setNote(''); setError(''); setTypes(null);
    fetch('/api/warehouse/task-types')
      .then(r => r.json())
      .then(d => { const list = Array.isArray(d.types) ? d.types : []; setTypes(list); if (list.length) setType(list[0]); })
      .catch(() => setTypes([]));
  }, [open]);

  const noTypes = types && types.length === 0;
  const valid = (noTypes || type) && to && title.trim() && types !== null;

  const create = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/warehouse/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: noTypes ? '' : type, fromLocation: from, toLocation: to, title: title.trim(), note: note.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to create the task');
      onCreated();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const typeOptions = types === null
    ? [{ label: 'Loading...', value: '', disabled: true }]
    : noTypes
      ? [{ label: 'Create type in Settings', value: '', disabled: true }]
      : types.map(t => ({ label: t, value: t }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create task"
      primaryAction={{ content: 'Create', onAction: create, disabled: !valid || saving, loading: saving }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {error && <Banner tone="critical">{error}</Banner>}
          {/* Layout 2026-10-23 (Hera): Type | Title, then From | To. */}
          <InlineStack gap="300" wrap={false} blockAlign="start">
            <div style={{ flex: 1 }}>
              <Select label="Type" options={typeOptions} value={type} onChange={setType} disabled={!types || noTypes} />
              {noTypes && (
                <div style={{ marginTop: 4 }}>
                  <Button variant="plain" onClick={() => navigate('/warehouse/settings')}>Create type in Settings</Button>
                </div>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <TextField label="Title" value={title} onChange={setTitle} autoComplete="off" maxLength={120} requiredIndicator />
            </div>
          </InlineStack>
          <InlineStack gap="300" wrap={false}>
            <div style={{ flex: 1 }}>
              <Select
                label="From Location"
                options={[HQ, ...names].map(n => ({ label: n, value: n }))}
                value={from}
                onChange={(v) => { setFrom(v); setTo(v === HQ ? '' : HQ); }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <Select
                label="To Location"
                placeholder="Select"
                options={(from === HQ ? names : [HQ]).map(n => ({ label: n, value: n }))}
                value={to}
                onChange={setTo}
              />
            </div>
          </InlineStack>
          <TextField label="Note" value={note} onChange={setNote} autoComplete="off" placeholder="optional" maxLength={500} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function SplitModal({ task, onClose, onDone }) {
  const max = (task.pbCount || 0) - 1;
  const [value, setValue] = useState(String(Math.max(1, max)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const n = parseInt(value, 10);
  const valid = Number.isInteger(n) && n >= 1 && n <= max;

  const split = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await fetch(`/api/warehouse/tasks/${task.id}/split`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: n }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to split');
      onDone(n);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  const step = (delta) => {
    const cur = Number.isInteger(n) ? n : 1;
    setValue(String(Math.min(max, Math.max(1, cur + delta))));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Split ${task.number}`}
      size="small"
      primaryAction={{ content: 'Split', onAction: split, disabled: !valid || saving, loading: saving }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {error && <Banner tone="critical">{error}</Banner>}
          <Text as="p">
            {task.pbUnit} {task.pbCount} now. How many {task.pbUnit === 'B' ? 'boxes' : 'pallets'} go to the new task? (1 – {max})
          </Text>
          <InlineStack gap="200" blockAlign="center">
            <Button onClick={() => step(-1)} disabled={!Number.isInteger(n) || n <= 1} accessibilityLabel="Less">−</Button>
            <div style={{ width: 90 }}>
              <TextField
                label="Split quantity"
                labelHidden
                value={value}
                onChange={(v) => setValue(String(v).replace(/\D/g, ''))}
                inputMode="numeric"
                autoComplete="off"
                error={value !== '' && !valid ? `1 – ${max}` : undefined}
              />
            </div>
            <Button onClick={() => step(1)} disabled={!Number.isInteger(n) || n >= max} accessibilityLabel="More">+</Button>
          </InlineStack>
          {valid && (
            <Text tone="subdued" as="p">
              Result: {task.pbUnit} {task.pbCount - n} stays on this task, a new task gets {task.pbUnit} {n}.
            </Text>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

// Unscheduled transfers are only shown when Ready to Ship (Hera 2026-10-21);
// both cards of a split transfer share the transfer's status — it is ONE
// transfer with ONE status in the system.
// Exception (Hera 2026-10-21): once a store → store transfer is In Transit
// (its pickup is done), its part 2 card (deliver, HQ → store) must stay so
// the delivery can still be scheduled.
const showInUnscheduled = (t) => t.kind !== 'transfer' || t.status === 'good_to_go'
  || (t.leg === 'deliver' && t.status === 'in_transit');

function WarehouseSchedule() {
  const compareLoc = useLocationOrder();
  const [view, setView] = useState('current');     // 'current' | 'past'
  const [data, setData] = useState(null);          // { view, today, days, lockedDays, goneToday, version, tasks }
  const [saved, setSaved] = useState({});          // saved calendar (editable days only)
  const [slots, setSlots] = useState({});          // draft calendar (editable days only)
  const [sel, setSel] = useState([]);              // selected ids, in click order
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);      // { tone, text } — Go! result
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [going, setGoing] = useState(false);
  const [hoverPair, setHoverPair] = useState(null); // transferId of a hovered split card
  const [createOpen, setCreateOpen] = useState(false);
  const [splitTask, setSplitTask] = useState(null);
  const [poPopup, setPoPopup] = useState(null);     // { id, number }
  const [transferPopup, setTransferPopup] = useState(null); // transfer id
  const [toast, showToast] = useToast();
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const dataRef = useRef(data);
  dataRef.current = data;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const viewRef = useRef(view);
  viewRef.current = view;

  // keepDraft: after Split / Delete / Create / track back the draft calendar
  // stays as it is (minus tasks that no longer exist); otherwise it is reset
  // to saved.
  const load = useCallback(async ({ keepDraft = false, nextView } = {}) => {
    const v = nextView || viewRef.current;
    try {
      const r = await fetch(`/api/warehouse/schedule${v === 'past' ? '?view=past' : ''}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load the schedule');
      const locked = new Set(d.lockedDays || []);
      const editableDays = d.days.filter(x => !locked.has(x));
      const savedSlots = slotsFromTasks(d.tasks, editableDays);
      const ids = new Set(d.tasks.map(t => t.id));
      const prev = dataRef.current;
      const draftDirty = prev && prev.view === d.view && normSlots(slotsRef.current) !== normSlots(savedRef.current);
      if (keepDraft && draftDirty && d.version !== prev.version) {
        // Someone else saved meanwhile and this page has its own unsaved
        // draft: keep the OLD version, so Save gets the 409 "reload" answer
        // instead of overwriting their work.
        setData({ ...d, version: prev.version });
        setError('Someone else saved the schedule in the meantime. Reload the page and make your changes again.');
        setConflict(true);
        const next = {};
        Object.entries(slotsRef.current).forEach(([k, list]) => { next[k] = list.filter(id => ids.has(id)); });
        setSlots(next);
        setSel(p => p.filter(id => ids.has(id)));
        return;
      }
      setData(d);
      setSaved(savedSlots);
      if (keepDraft && draftDirty) {
        const next = {};
        Object.entries(slotsRef.current).forEach(([k, list]) => { next[k] = list.filter(id => ids.has(id)); });
        setSlots(next);
      } else {
        setSlots(savedSlots);
      }
      setSel(p => p.filter(id => ids.has(id)));
      setConflict(false);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const dirty = data ? normSlots(slots) !== normSlots(saved) : false;
  useEffect(() => { setScheduleDirty(dirty); }, [dirty]);
  useEffect(() => () => setScheduleDirty(false), []);

  // Leaving the page with unsaved changes → browser warning.
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const tasks = useMemo(() => (data ? data.tasks : []), [data]);
  const byId = useMemo(() => Object.fromEntries(tasks.map(t => [t.id, t])), [tasks]);
  const lockedSet = useMemo(() => new Set(data ? data.lockedDays || [] : []), [data]);
  // Draft positions (editable days).
  const where = useMemo(() => {
    const w = {};
    Object.entries(slots).forEach(([k, list]) => list.forEach((id, i) => { w[id] = { key: k, index: i }; }));
    return w;
  }, [slots]);
  // Read-only positions on locked days (straight from the server).
  const lockedSlots = useMemo(() => {
    if (!data) return {};
    return slotsFromTasks(tasks, data.days.filter(x => lockedSet.has(x)));
  }, [data, tasks, lockedSet]);
  const lockedWhere = useMemo(() => {
    const w = {};
    Object.entries(lockedSlots).forEach(([k, list]) => list.forEach((id, i) => { w[id] = { key: k, index: i }; }));
    return w;
  }, [lockedSlots]);

  const unscheduledAll = useMemo(() => tasks.filter(t => !where[t.id] && !lockedWhere[t.id]), [tasks, where, lockedWhere]);
  const unscheduled = useMemo(() => unscheduledAll.filter(showInUnscheduled), [unscheduledAll]);
  const tray = useMemo(() => {
    const list = unscheduled.filter(t => filter === 'all' || t.kind === filter);
    // Always grouped by location (spec §5): HQ → store (by to) · store → HQ
    // (by from) · store → store (by from, then to) — by the location shown on
    // the card, so the two halves of a split transfer land in groups 1 and 2.
    const group = (t) => { const r = cardRoute(t); return r.from === HQ ? 0 : r.to === HQ ? 1 : 2; };
    return [...list].sort((a, b) => {
      const ga = group(a); const gb = group(b);
      if (ga !== gb) return ga - gb;
      const ra = cardRoute(a); const rb = cardRoute(b);
      const la = ga === 0 ? ra.to : ra.from;
      const lb = gb === 0 ? rb.to : rb.from;
      return compareLoc(la, lb)
        || (ga === 2 ? compareLoc(ra.to, rb.to) : 0)
        || new Date(a.createdAt) - new Date(b.createdAt)
        || a.id - b.id;
    });
  }, [unscheduled, filter, compareLoc]);

  // ── selection-dependent state ──
  const selTasks = sel.map(id => byId[id]).filter(Boolean);
  const selUn = selTasks.filter(t => !where[t.id] && !lockedWhere[t.id]);
  const selEdit = selTasks.filter(t => where[t.id]);                       // on an editable day (draft)
  const selTracked = selTasks.filter(t => lockedWhere[t.id] && t.trackedBack); // tracked back on a locked day
  const allUnscheduled = selTasks.length > 0 && selUn.length === selTasks.length;
  const single = selTasks.length === 1 ? selTasks[0] : null;
  const singleScheduled = single && where[single.id] ? where[single.id] : null;
  const canSplit = allUnscheduled && single && single.kind === 'po' && (single.pbCount || 0) > 1;
  const slotLen = singleScheduled ? (slots[singleScheduled.key] || []).length : 0;
  const canDelete = selTasks.length > 0 && selUn.length + selTracked.length === selTasks.length;
  // Partner highlight: the other card of a split transfer that is hovered / selected.
  const litPairs = useMemo(() => {
    const s = new Set(selTasks.filter(t => t.kind === 'transfer' && t.leg).map(t => t.transferId));
    if (hoverPair != null) s.add(hoverPair);
    return s;
  }, [selTasks, hoverPair]);

  const toggle = (id) => setSel(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  // Add Here on an editable half-day: draft move.
  const place = (key, label) => {
    if (sel.length === 0) return;
    const ids = sel.filter(id => byId[id] && !lockedWhere[id]);
    const next = {};
    Object.entries(slots).forEach(([k, list]) => { next[k] = list.filter(id => !ids.includes(id)); });
    next[key] = [...(next[key] || []), ...ids];
    setSlots(next);
    setSel([]);
    showToast(`${ids.length === 1 ? '1 task' : `${ids.length} tasks`} added to ${label}`);
  };

  // Add Here on a locked half-day: track back (saved at once).
  const trackBack = async (date, half, label) => {
    const ids = selUn.map(t => t.id);
    if (ids.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/warehouse/tasks/track-back', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, date, half }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to track back');
      setSel([]);
      await load({ keepDraft: true });
      showToast(`${d.added === 1 ? '1 task' : `${d.added} tasks`} tracked back to ${label}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const move = (dir) => {
    if (!singleScheduled) return;
    const list = [...(slots[singleScheduled.key] || [])];
    const i = singleScheduled.index; const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setSlots({ ...slots, [singleScheduled.key]: list });
  };

  // Draft-unschedule what is on editable days; tracked-back tasks on locked
  // days are taken off at once (server). They stay selected.
  const unschedule = async () => {
    const editIds = selEdit.map(t => t.id);
    const trackedIds = selTracked.map(t => t.id);
    if (editIds.length) {
      const next = {};
      Object.entries(slots).forEach(([k, list]) => { next[k] = list.filter(id => !editIds.includes(id)); });
      setSlots(next);
    }
    if (trackedIds.length) {
      setBusy(true);
      try {
        const r = await fetch('/api/warehouse/tasks/untrack', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: trackedIds }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to move back');
        await load({ keepDraft: true });
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }
    const n = editIds.length + trackedIds.length;
    showToast(`${n === 1 ? '1 task' : `${n} tasks`} moved back to Unscheduled`);
  };

  const save = async () => {
    if (!data) return;
    // A store → store delivery may not be earlier than its pickup — checked
    // here first, and again by the server.
    const rank = {};
    data.days.forEach((d, i) => { rank[d] = i; });
    const posOf = (id) => {
      const w = where[id] || lockedWhere[id];
      if (!w) return null;
      const [d, h] = w.key.split('|');
      return [rank[d] ?? -1, h === 'AM' ? 0 : 1, w.index];
    };
    const late = [];
    tasks.filter(t => t.kind === 'transfer' && t.leg === 'deliver').forEach(dv => {
      const pk = tasks.find(t => t.kind === 'transfer' && t.leg === 'pickup' && t.transferId === dv.transferId);
      const a = posOf(dv.id); const b = pk && posOf(pk.id);
      if (a && b && (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0) late.push(dv.number);
    });
    if (late.length > 0) {
      setError(`Delivery is scheduled before its pickup: ${late.join(', ')}. Move the delivery (➔ store) later or the pickup (store ➔) earlier.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/warehouse/schedule', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: data.version, slots }),
      });
      const d = await r.json();
      if (r.status === 409) { setConflict(true); throw new Error(d.error); }
      if (!r.ok) throw new Error(d.error || 'Failed to save');
      const locked = new Set(d.lockedDays || []);
      const savedSlots = slotsFromTasks(d.tasks, d.days.filter(x => !locked.has(x)));
      setData(d);
      setSaved(savedSlots);
      setSlots(savedSlots);
      setSel(prev => prev.filter(id => d.tasks.some(t => t.id === id)));
      showToast('Schedule saved');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setSlots(saved);
    setSel([]);
    showToast('Changes discarded');
  };

  // Past 7 days ⇄ Current 7 days. Unsaved changes would be lost → ask.
  const switchView = async () => {
    if (!confirmLeaveSchedule()) return;
    const next = view === 'past' ? 'current' : 'past';
    setSel([]);
    setView(next);
    setData(null);
    await load({ nextView: next });
  };

  // Go! — today's trucks have left: today's cards become fixed (gone) and
  // today's Ready to Ship transfers from HQ are marked In Transit (server).
  // Can be pressed again for cards added to today afterwards (2026-10-23).
  const go = async () => {
    const todayKeys = [slotKey(data.today, 'AM'), slotKey(data.today, 'PM')];
    // One transfer = one status: count each transfer once, whichever of its
    // cards is on today's schedule.
    // only cards that did not go out yet (Go! again, 2026-10-23)
    const todayTransfers = todayKeys.flatMap(k => saved[k] || []).map(id => byId[id]).filter(t => t && !t.gone)
      // pickups (part 1 of store → store, store → HQ) don't change the status
      // on Go! (2026-10-23) — store → HQ goes In Transit on the Delivery tab.
      // only transfers FROM HQ (2026-10-23, Hera) — from a store: Delivery › Picked Up
      .filter(t => t && t.kind === 'transfer' && !t.leg && t.from === HQ);
    const ready = new Set(todayTransfers.filter(t => t.status === 'good_to_go').map(t => t.transferId)).size;
    if (!window.confirm(`Go! — today's schedule is done and the trucks have left?\n\nToday's cards will be fixed (new tasks can still be added to today and sent with another Go!), and ${ready} Ready to Ship transfer${ready === 1 ? '' : 's'} on today's schedule from HQ will be marked In Transit (transfers from a store go In Transit when picked up on the Delivery tab).`)) return;
    setGoing(true);
    setError('');
    setNotice(null);
    try {
      const r = await fetch('/api/warehouse/go', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Go! failed');
      const parts = [`${d.inTransit.length} transfer${d.inTransit.length === 1 ? '' : 's'} marked In Transit.`];
      if (d.skipped.length) parts.push(`Not Ready to Ship, left as is: ${d.skipped.map(x => x.number).join(', ')}.`);
      if (d.failed.length) parts.push(`Failed: ${d.failed.map(x => `${x.number} (${x.error})`).join('; ')}.`);
      setNotice({ tone: d.failed.length ? 'warning' : 'success', text: `Go! done. ${parts.join(' ')}` });
      await load({ keepDraft: true });
      refreshWarehouseBadges();
    } catch (e) {
      setError(e.message);
    } finally {
      setGoing(false);
    }
  };

  const deleteSelected = async () => {
    const ids = selTasks.map(t => t.id);
    const n = ids.length;
    const hasSplits = selTasks.some(t => t.kind === 'po' && t.hasChildren);
    const hasChildTask = selTasks.some(t => t.kind === 'po' && t.parentId);
    const lines = [`Delete ${n === 1 ? 'this task' : `these ${n} tasks`} from the Schedule?`];
    if (hasSplits) lines.push('Every task split from it will be deleted too, also split tasks that are already on the calendar.');
    if (hasChildTask) lines.push('A split task’s P / B qty goes back to the task it was split from.');
    if (selTasks.some(t => t.kind === 'transfer' && t.leg)) lines.push('Both cards of a store-to-store transfer (store ➔ HQ and HQ ➔ store) are deleted together, also if the other one is already on the calendar.');
    lines.push('Deleted tasks do not come back. POs and Transfers themselves are not changed.');
    if (!window.confirm(lines.join('\n\n'))) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/warehouse/tasks/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to delete');
      setSel([]);
      await load({ keepDraft: true });
      showToast(`${d.deleted === 1 ? '1 task' : `${d.deleted} tasks`} deleted`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openNumber = (t) => {
    if (t.kind === 'po') setPoPopup({ id: t.poInvoiceId, number: t.number });
    else if (t.kind === 'transfer') setTransferPopup(t.transferId);
  };

  if (!data) {
    return (
      <Page>
        {error ? <Banner tone="critical">{error}</Banner> : <Text tone="subdued">Loading...</Text>}
      </Page>
    );
  }

  const past = data.view === 'past';
  const columns = buildColumns(data.days);
  const gridCols = columns.map(c => (c.weekend ? '40px' : 'minmax(0, 1fr)')).join(' ');
  const scheduledCount = Object.values(slots).reduce((a, l) => a + l.length, 0)
    + Object.values(lockedSlots).reduce((a, l) => a + l.length, 0);
  const hasSel = sel.length > 0;
  const todayIsWorkday = data.days[0] === data.today && !past;
  // Go! again (2026-10-23, Hera): enabled while today has saved cards that
  // did not go out yet.
  const newToday = todayIsWorkday
    ? [slotKey(data.today, 'AM'), slotKey(data.today, 'PM')].flatMap(k => saved[k] || []).filter(id => byId[id] && !byId[id].gone).length
    : 0;
  const goDisabled = !todayIsWorkday || newToday === 0 || dirty || going || saving;
  const goTitle = dirty ? 'Save the schedule first.' : !todayIsWorkday ? 'Today is not a business day.'
    : newToday === 0 ? (data.goneToday ? 'Nothing new on today’s schedule since the last Go!.' : 'Nothing on today’s schedule yet.')
    : 'Today’s schedule is done, the trucks have left.';

  const smallBtn = (label, onClick, extra = {}) => (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        font: 'inherit', fontSize: 13, padding: '5px 12px', minHeight: 32, borderRadius: 8,
        border: '1px solid #c9cccf', background: '#fff', color: '#303030', cursor: 'pointer', opacity: busy ? 0.6 : 1, ...extra,
      }}
    >{label}</button>
  );
  const filterBtn = (id, label) => (
    <button
      key={id}
      type="button"
      aria-pressed={filter === id}
      onClick={() => setFilter(id)}
      style={{
        font: 'inherit', fontSize: 13, padding: '5px 12px', minHeight: 32, borderRadius: 8, cursor: 'pointer',
        border: `1px solid ${filter === id ? '#303030' : '#c9cccf'}`,
        background: filter === id ? '#303030' : '#fff', color: filter === id ? '#fff' : '#303030',
      }}
    >{label}</button>
  );

  const renderCard = (id, i, isLockedDay) => {
    const t = byId[id];
    return (
      <TaskCard
        key={id}
        task={t}
        compact
        // no order number on calendar cards (2026-10-22, Hera) — TaskCard
        // still supports `order` if it is ever wanted back
        selected={sel.includes(id)}
        // gone = went out with Go! → fixed (2026-10-23)
        locked={(isLockedDay && !t.trackedBack) || t.gone}
        partnerLit={t.kind === 'transfer' && t.leg && litPairs.has(t.transferId) && !sel.includes(id)}
        onHoverPair={setHoverPair}
        onToggle={toggle}
        onOpenNumber={openNumber}
      />
    );
  };

  return (
    <Page>
      <div style={{ position: 'relative', left: '50%', transform: 'translateX(-50%)', width: `min(${CONTENT_W}px, calc(100vw - 32px))` }}>
        <BlockStack gap="300">
          {/* Header */}
          <InlineStack align="space-between" blockAlign="start" gap="300" wrap>
            <BlockStack gap="100">
              {/* no "Schedule" title under the tab bar (2026-10-23, Hera — same as HQ Transfers) */}
              <Text tone="subdued" as="p">
                {past ? 'Past 7 business days' : 'Next 7 business days'} · {longDay(data.days[0])} – {longDay(data.days[data.days.length - 1])} · {scheduledCount} scheduled · {unscheduled.length} unscheduled
              </Text>
            </BlockStack>
            {!past && (
              <InlineStack gap="200" blockAlign="center">
                {dirty && (
                  <span style={{ fontSize: 12, fontWeight: 550, padding: '2px 8px', borderRadius: 8, background: '#ffd79d', color: '#5e4200' }}>Unsaved changes</span>
                )}
                <button
                  type="button"
                  title={goTitle}
                  onClick={go}
                  disabled={goDisabled}
                  style={{
                    font: 'inherit', fontSize: 14, fontWeight: 700, padding: '6px 18px', minHeight: 32, borderRadius: 8,
                    border: 'none', cursor: goDisabled ? 'default' : 'pointer',
                    background: goDisabled ? '#d4d4d4' : '#16a34a', color: goDisabled ? '#6d7175' : '#fff',
                  }}
                >{going ? 'Going...' : 'Go!'}</button>
                <Button onClick={discard} disabled={!dirty || saving}>Discard</Button>
                <Button variant="primary" onClick={save} disabled={!dirty || saving} loading={saving}>Save</Button>
              </InlineStack>
            )}
          </InlineStack>

          {error && (
            <Banner tone="critical" onDismiss={() => setError('')}
              action={conflict ? { content: 'Reload', onAction: () => { setError(''); load(); } } : undefined}>
              {error}
            </Banner>
          )}
          {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}

          {/* Unscheduled — title, filters and buttons outside the card */}
          <InlineStack align="space-between" blockAlign="end" gap="200" wrap>
            {/* One list again (2026-10-23, Hera) — the Delivery / Pickup tabs of
                2026-10-22 were removed; pickup cards are amber instead. */}
            <InlineStack gap="200" blockAlign="center">
              <Text variant="headingMd" as="h3">Unscheduled</Text>
              <span style={{ fontSize: 12, fontWeight: 650, padding: '1px 8px', borderRadius: 999, background: '#e3e3e3' }}>{unscheduled.length}</span>
            </InlineStack>
            <InlineStack gap="200" blockAlign="end" wrap>
              <InlineStack gap="100">
                {filterBtn('all', 'All')}{filterBtn('po', 'PO')}{filterBtn('transfer', 'Transfer')}{filterBtn('custom', 'Other')}
              </InlineStack>
              <Button onClick={() => setCreateOpen(true)}>Create task</Button>
            </InlineStack>
          </InlineStack>

          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 0 rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.08)', padding: 14 }}>
            {tray.length === 0 ? (
              <Text tone="subdued">{unscheduled.length === 0 ? 'No unscheduled tasks.' : 'No unscheduled tasks match.'}</Text>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
                {tray.map(t => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    selected={sel.includes(t.id)}
                    partnerLit={t.kind === 'transfer' && t.leg && litPairs.has(t.transferId) && !sel.includes(t.id)}
                    onHoverPair={setHoverPair}
                    onToggle={toggle}
                    onOpenNumber={openNumber}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Action bar — empty while nothing is selected (Hera 2026-10-21) */}
          <div style={{
            minHeight: 52, boxSizing: 'border-box', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
            padding: '8px 14px', borderRadius: 12,
            background: hasSel ? '#e0f2fe' : '#fff', border: `1px solid ${hasSel ? '#a8d1ff' : '#e1e3e5'}`,
          }}>
            {hasSel && (
              <>
                <span style={{ fontWeight: 700 }}>{sel.length} selected</span>
                {selTracked.length === 0 && <span>Choose the day and morning or afternoon then click <b>{past ? 'Track back here' : 'Add Here'}</b></span>}
                <span style={{ flex: 1 }} />
                {canSplit && smallBtn('Split', () => setSplitTask(single))}
                {singleScheduled && singleScheduled.index > 0 && smallBtn('↑ Up', () => move(-1))}
                {singleScheduled && singleScheduled.index < slotLen - 1 && smallBtn('↓ Down', () => move(1))}
                {(selEdit.length > 0 || selTracked.length > 0) && smallBtn('Unschedule', unschedule, { color: '#c70a24' })}
                {canDelete && smallBtn(busy ? 'Working...' : 'Delete', deleteSelected, { color: '#c70a24' })}
                {smallBtn('Cancel', () => setSel([]), { border: '1px solid transparent', background: 'transparent' })}
              </>
            )}
          </div>

          {/* Calendar — Past 7 days / Current 7 days toggle at the top left */}
          <InlineStack>
            <Button onClick={switchView} disabled={saving || busy}>{past ? 'Current 7 Days' : 'Past 7 Days'}</Button>
          </InlineStack>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 980, display: 'grid', gridTemplateColumns: gridCols, gap: 8, alignItems: 'stretch' }}>
              {columns.map(col => {
                if (col.weekend) {
                  return (
                    <div key={col.key} style={{ borderRadius: 12, background: '#c9cccf', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '14px 0', minHeight: 300 }}>
                      <span style={{ writingMode: 'vertical-rl', color: '#303030', fontSize: 12, fontWeight: 650, letterSpacing: 0.3 }}>{col.label}</span>
                    </div>
                  );
                }
                const p = dateParts(col.date);
                const isLockedDay = lockedSet.has(col.date);
                return (
                  <section key={col.key} aria-label={longDay(col.date)} style={{
                    background: isLockedDay ? '#fafafa' : '#fff', borderRadius: 12, border: '1px solid #c9cccf',
                    display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 300,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '8px 10px 6px', borderBottom: '1px solid #e1e3e5' }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{p.dow}</span>
                      <span style={{ color: '#303030' }}>{mmdd(col.date)}</span>
                      {col.date === data.today && !data.goneToday && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6d7175' }}>Today</span>}
                      {col.date === data.today && data.goneToday && (
                        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#16a34a' }}>
                          Gone{newToday > 0 ? ` · ${newToday} new` : ''}
                        </span>
                      )}
                    </div>
                    {HALVES.map((h, hi) => {
                      const key = slotKey(col.date, h.id);
                      const source = isLockedDay ? lockedSlots : slots;
                      const ids = (source[key] || []).filter(id => byId[id]);
                      const vis = ids; // never folded (2026-10-22)
                      // Add Here: editable day → draft move (anything except
                      // tracked-back tasks); locked day → track back
                      // (Unscheduled tasks only).
                      const showAdd = hasSel && (isLockedDay ? allUnscheduled : selTracked.length === 0);
                      const label = `${longDay(col.date)} · ${h.name}`;
                      return (
                        <div key={h.id} style={{
                          display: 'flex', flexDirection: 'column', gap: 6, padding: 8,
                          // 2× space above and below the Morning / Afternoon line (2026-10-22)
                          ...(hi === 0 ? { paddingBottom: 16 } : { paddingTop: 16 }),
                          // black line between Morning and Afternoon (2026-10-22)
                          borderTop: hi === 0 ? 'none' : '1px solid #000', flex: hi === 1 ? 1 : '0 0 auto',
                          background: showAdd ? '#fbfdff' : 'transparent',
                        }}>
                          {/* Morning / Afternoon: same size as the weekday, in a
                              light grey pill (2026-10-22). Task count removed
                              (2026-10-22, Hera). */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={HALF_PILL}>{h.label}</span>
                          </div>
                          {vis.map((id, i) => renderCard(id, i, isLockedDay))}
                          {ids.length === 0 && !showAdd && <span style={{ fontSize: 12, color: '#8a8a8a' }}>No tasks</span>}
                          {showAdd && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => (isLockedDay ? trackBack(col.date, h.id, label) : place(key, label))}
                              title={isLockedDay ? 'Track back: record these tasks on this day (added at the bottom)' : undefined}
                              style={{
                                font: 'inherit', fontSize: 13, fontWeight: 650, minHeight: 32, borderRadius: 8,
                                border: '1.5px dashed #2c6ecb', background: '#eaf4ff', color: '#1f5199', cursor: 'pointer',
                              }}
                            >{isLockedDay ? 'Track back here' : 'Add Here'}</button>
                          )}
                        </div>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          </div>
        </BlockStack>
      </div>

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async () => { setCreateOpen(false); await load({ keepDraft: true }); showToast('Task created'); }}
      />
      {splitTask && (
        <SplitModal
          task={splitTask}
          onClose={() => setSplitTask(null)}
          onDone={async () => { setSplitTask(null); setSel([]); await load({ keepDraft: true }); refreshWarehouseBadges(); showToast('Task split'); }}
        />
      )}
      <PoPopup invoiceId={poPopup && poPopup.id} number={poPopup && poPopup.number} onClose={() => setPoPopup(null)} />
      <TransferPopup transferId={transferPopup} onClose={() => setTransferPopup(null)} returnTo="/warehouse" />
      {toast}
    </Page>
  );
}

export default WarehouseSchedule;
