import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Page, BlockStack, InlineStack, Text, Button, Banner, Modal, TextField, Select, Tooltip,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { useLocationMap } from '../shared/locationMap';
import {
  HQ, RoutePills, PbPill, LinkText, PoPopup, TransferPopup, truncate,
  useLocationOrder, useToast, refreshWarehouseBadges, setScheduleDirty,
} from './whShared';

// Warehouse › Schedule (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §2–§6).
//
// Cards: received POs (+ their splits), transfers, WH custom tasks. They are
// placed on Morning / Afternoon of the next 7 business days (today first;
// weekends are a narrow strip and can't take tasks) by "select, then Add
// Here" — no drag and drop.
//
// Placing / reordering / unscheduling only change a local draft until Save
// (Discard throws the draft away). Split, Delete and Create task are saved
// at once and keep the draft as it is.
//
// Desktop / iPad page: the content is a centred block a bit wider than the
// normal page (same technique as Online › New Products); title and tab bar
// stay at normal width.

const CONTENT_W = 1280; // to be tuned by eye (Hera 2026-10-21)
const CAP = 6;          // rows shown per half-day before "Show N more"
const HALVES = [{ id: 'AM', label: 'Morning', name: 'Morning' }, { id: 'PM', label: 'Afternoon', name: 'Afternoon' }];
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

// The location shown ON the card. A store → store transfer is two cards
// (Hera 2026-10-21): the 'pickup' card shows "➔ {from}" + green "Pickup",
// the 'deliver' card "➔ {to}". Both count as HQ-style cards for grouping.
function cardRoute(t) {
  if (t.kind === 'transfer' && t.leg === 'pickup') return { from: HQ, to: t.from };
  if (t.kind === 'transfer' && t.leg === 'deliver') return { from: HQ, to: t.to };
  if (t.kind === 'transfer') return { from: t.from, to: t.to };
  return { from: HQ, to: t.to };
}

// Hover box (Hera 2026-10-21): every card shows its full location relation
// "{from} ➔ {to}" (locations bold); custom cards also Type / Title / Note.
// Rendered in a portal with fixed position so the calendar's scroll box and
// the page's centring transform can't clip or shift it.
function HoverBox({ task, rect }) {
  if (!rect) return null;
  const from = task.kind === 'transfer' ? task.from : HQ;
  const to = task.to;
  const above = rect.top > 140;
  return createPortal(
    <div style={{
      position: 'fixed', zIndex: 700, left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
      top: above ? rect.top - 6 : rect.bottom + 6, transform: above ? 'translateY(-100%)' : 'none',
      maxWidth: 280, background: '#fff', color: '#303030', border: '1px solid #c9cccf', borderRadius: 8,
      boxShadow: '0 6px 18px rgba(0,0,0,0.15)', padding: '8px 10px', fontSize: 13, lineHeight: '18px', pointerEvents: 'none',
    }}>
      {task.kind === 'custom' && (
        <div style={{ marginBottom: 4 }}>
          <div>Type: {task.type || 'Custom'}</div>
          <div>Title: {task.title}</div>
          {task.note && <div style={{ whiteSpace: 'pre-wrap' }}>Note: {task.note}</div>}
        </div>
      )}
      <div><b>{from}</b> ➔ <b>{to}</b></div>
    </div>,
    document.body
  );
}

// One task card. `compact` = the calendar version (slightly smaller, with
// the order number in front).
function TaskCard({ task, selected, onToggle, onOpenNumber, order, compact }) {
  const fs = compact ? 12 : 13;
  const [hoverRect, setHoverRect] = useState(null);
  const route = cardRoute(task);
  let first;
  let second;
  if (task.kind === 'po') {
    first = (
      <>
        <LinkText onClick={() => onOpenNumber(task)}>{task.number}</LinkText>
        <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{task.supplier}</span>
      </>
    );
    second = <><RoutePills from={HQ} to={task.to} /><PbPill count={task.pbCount} unit={task.pbUnit} /></>;
  } else if (task.kind === 'transfer') {
    first = (
      <>
        <LinkText onClick={() => onOpenNumber(task)}>{task.number}</LinkText>
        {task.tag && <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{task.tag}</span>}
      </>
    );
    second = (
      <>
        <RoutePills from={route.from} to={route.to} />
        {task.leg === 'pickup' && <span style={{ marginLeft: 'auto', color: '#16a34a', fontWeight: 700 }}>Pickup</span>}
      </>
    );
  } else {
    first = (
      <>
        <span style={{ whiteSpace: 'nowrap', color: '#303030' }}>{truncate(task.type || 'Custom')}</span>
        <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{truncate(task.title)}</span>
      </>
    );
    second = <RoutePills from={HQ} to={task.to} />;
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onMouseEnter={(e) => setHoverRect(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setHoverRect(null)}
      onClick={() => onToggle(task.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(task.id); } }}
      style={{
        position: 'relative', boxSizing: 'border-box', cursor: 'pointer', textAlign: 'left',
        border: `${selected ? 2 : 1}px solid ${selected ? PINK : '#c9cccf'}`,
        padding: selected ? (compact ? '4px 7px' : '6px 9px') : (compact ? '5px 8px' : '7px 10px'),
        borderRadius: 10, background: '#fff', fontSize: fs, lineHeight: '18px',
        display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, paddingRight: selected ? 12 : 0 }}>
        {order != null && <span style={{ color: '#6d7175', fontSize: 11, minWidth: 12, fontVariantNumeric: 'tabular-nums' }}>{order}</span>}
        {first}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>{second}</div>
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
  const [to, setTo] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setType(''); setTo(''); setTitle(''); setNote(''); setError(''); setTypes(null);
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
        body: JSON.stringify({ type: noTypes ? '' : type, toLocation: to, title: title.trim(), note: note.trim() }),
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
          <InlineStack gap="300" wrap={false}>
            <div style={{ flex: 1 }}>
              <Select label="Type" options={typeOptions} value={type} onChange={setType} disabled={!types || noTypes} />
              {noTypes && (
                <div style={{ marginTop: 4 }}>
                  <Button variant="plain" onClick={() => navigate('/warehouse/settings')}>Create type in Settings</Button>
                </div>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <Select
                label="To Location"
                placeholder="Select"
                options={names.map(n => ({ label: n, value: n }))}
                value={to}
                onChange={setTo}
              />
            </div>
          </InlineStack>
          <TextField label="Title" value={title} onChange={setTitle} autoComplete="off" maxLength={120} requiredIndicator />
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

function WarehouseSchedule() {
  const compareLoc = useLocationOrder();
  const [data, setData] = useState(null);          // { today, days, version, tasks }
  const [saved, setSaved] = useState({});          // saved calendar
  const [slots, setSlots] = useState({});          // draft calendar
  const [sel, setSel] = useState([]);              // selected ids, in click order
  const [expanded, setExpanded] = useState({});
  const [filter, setFilter] = useState('all');
  const [groupBy, setGroupBy] = useState('location');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
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

  // keepDraft: after Split / Delete / Create the draft calendar stays as it
  // is (minus tasks that no longer exist); otherwise it is reset to saved.
  const load = useCallback(async ({ keepDraft = false } = {}) => {
    try {
      const r = await fetch('/api/warehouse/schedule');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load the schedule');
      const savedSlots = slotsFromTasks(d.tasks, d.days);
      const ids = new Set(d.tasks.map(t => t.id));
      const prev = dataRef.current;
      const draftDirty = prev && normSlots(slotsRef.current) !== normSlots(savedRef.current);
      if (keepDraft && prev && d.version !== prev.version && draftDirty) {
        // Someone else saved the schedule meanwhile and this page has its own
        // unsaved draft: keep the OLD version, so Save gets the 409 "reload"
        // answer instead of overwriting their work.
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
      } else if (keepDraft) {
        setSlots(savedSlots); // nothing unsaved → just show the latest calendar
      } else {
        setSlots(savedSlots);
        setExpanded({});
      }
      setSel(prev => prev.filter(id => ids.has(id)));
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
  const where = useMemo(() => {
    const w = {};
    Object.entries(slots).forEach(([k, list]) => list.forEach((id, i) => { w[id] = { key: k, index: i }; }));
    return w;
  }, [slots]);

  const unscheduled = useMemo(() => tasks.filter(t => !where[t.id]), [tasks, where]);
  const tray = useMemo(() => {
    const list = unscheduled.filter(t => filter === 'all' || t.kind === filter);
    if (groupBy !== 'location') return list;
    // Group by Location (spec §5): HQ → store (by to) · store → HQ (by from) ·
    // store → store (by from, then to). No titles — the pills show it.
    // Uses the location shown on the card: the two cards of a store → store
    // transfer (Pickup / delivery) sit in group 1 under their own location.
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
  }, [unscheduled, filter, groupBy, compareLoc]);

  // ── selection-dependent state (spec §4: A / B / C) ──
  const selTasks = sel.map(id => byId[id]).filter(Boolean);
  const selScheduled = selTasks.filter(t => where[t.id]);
  const allUnscheduled = selTasks.length > 0 && selScheduled.length === 0;   // A
  const single = selTasks.length === 1 ? selTasks[0] : null;
  const singleScheduled = single && where[single.id] ? where[single.id] : null; // C
  const canSplit = allUnscheduled && single && single.kind === 'po' && (single.pbCount || 0) > 1;
  const slotLen = singleScheduled ? (slots[singleScheduled.key] || []).length : 0;

  const toggle = (id) => setSel(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const place = (key, label) => {
    if (sel.length === 0) return;
    const ids = sel.filter(id => byId[id]);
    const next = {};
    Object.entries(slots).forEach(([k, list]) => { next[k] = list.filter(id => !ids.includes(id)); });
    next[key] = [...(next[key] || []), ...ids];
    setSlots(next);
    setSel([]);
    showToast(`${ids.length === 1 ? '1 task' : `${ids.length} tasks`} added to ${label}`);
  };

  const move = (dir) => {
    if (!singleScheduled) return;
    const list = [...(slots[singleScheduled.key] || [])];
    const i = singleScheduled.index; const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setSlots({ ...slots, [singleScheduled.key]: list });
  };

  const unschedule = () => {
    const ids = selScheduled.map(t => t.id);
    const next = {};
    Object.entries(slots).forEach(([k, list]) => { next[k] = list.filter(id => !ids.includes(id)); });
    setSlots(next);
    // stays selected (spec §4 B / C)
    showToast(`${ids.length === 1 ? '1 task' : `${ids.length} tasks`} moved back to Unscheduled`);
  };

  const save = async () => {
    if (!data) return;
    // A store → store delivery may not be earlier than its pickup (Hera
    // 2026-10-21) — checked here first, and again by the server.
    const rank = {};
    data.days.forEach((d, i) => { rank[d] = i; });
    const posOf = (id) => {
      const w = where[id];
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
      setError(`Delivery is scheduled before its pickup: ${late.join(', ')}. Move the delivery later or the pickup earlier.`);
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
      const savedSlots = slotsFromTasks(d.tasks, d.days);
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

  // Sync Tasks (Hera 2026-10-21): adds Draft / Pending / Ready to Ship
  // transfers (incl. ones from before go-live or deleted by mistake) and puts
  // matching POs into Receive Shipments. Saved at once; the draft stays.
  const [syncing, setSyncing] = useState(false);
  const syncTasks = async () => {
    setSyncing(true);
    setError('');
    try {
      const r = await fetch('/api/warehouse/sync', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Sync failed');
      await load({ keepDraft: true });
      refreshWarehouseBadges();
      const tr = (d.transfersAdded || 0) + (d.transfersRestored || 0);
      showToast(tr === 0 && !d.posAdded
        ? 'Everything is already in sync'
        : `Synced: ${tr} transfer card${tr === 1 ? '' : 's'} added · ${d.posAdded} PO${d.posAdded === 1 ? '' : 's'} added to Receive Shipments`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const discard = () => {
    setSlots(saved);
    setSel([]);
    setExpanded({});
    showToast('Changes discarded');
  };

  const deleteSelected = async () => {
    const ids = selTasks.map(t => t.id);
    const n = ids.length;
    const hasSplits = selTasks.some(t => t.kind === 'po' && t.hasChildren);
    const hasChildTask = selTasks.some(t => t.kind === 'po' && t.parentId);
    const lines = [`Delete ${n === 1 ? 'this task' : `these ${n} tasks`} from the Schedule?`];
    if (hasSplits) lines.push('Every task split from it will be deleted too, also split tasks that are already on the calendar.');
    if (hasChildTask) lines.push('A split task’s P / B qty goes back to the task it was split from.');
    if (selTasks.some(t => t.kind === 'transfer' && t.leg)) lines.push('The Pickup card and the delivery card of a store-to-store transfer are deleted together, also if the other one is already on the calendar.');
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

  const columns = buildColumns(data.days);
  const gridCols = columns.map(c => (c.weekend ? '40px' : 'minmax(0, 1fr)')).join(' ');
  const scheduledCount = Object.values(slots).reduce((a, l) => a + l.length, 0);
  const hasSel = sel.length > 0;

  const smallBtn = (label, onClick, extra = {}) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        font: 'inherit', fontSize: 13, padding: '5px 12px', minHeight: 32, borderRadius: 8,
        border: '1px solid #c9cccf', background: '#fff', color: '#303030', cursor: 'pointer', ...extra,
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

  return (
    <Page>
      <div style={{ position: 'relative', left: '50%', transform: 'translateX(-50%)', width: `min(${CONTENT_W}px, calc(100vw - 32px))` }}>
        <BlockStack gap="300">
          {/* Header */}
          <InlineStack align="space-between" blockAlign="start" gap="300" wrap>
            <BlockStack gap="100">
              <Text variant="headingLg" as="h2">Schedule</Text>
              <Text tone="subdued" as="p">
                Next 7 business days · {longDay(data.days[0])} – {longDay(data.days[data.days.length - 1])} · {scheduledCount} scheduled · {unscheduled.length} unscheduled
              </Text>
            </BlockStack>
            <InlineStack gap="200" blockAlign="center">
              {dirty && (
                <span style={{ fontSize: 12, fontWeight: 550, padding: '2px 8px', borderRadius: 8, background: '#ffd79d', color: '#5e4200' }}>Unsaved changes</span>
              )}
              <Tooltip content="Sync Transfer tasks, and PO tasks to Receive Shipments.">
                <Button onClick={syncTasks} loading={syncing} disabled={saving}>Sync Tasks</Button>
              </Tooltip>
              <Button onClick={discard} disabled={!dirty || saving}>Discard</Button>
              <Button variant="primary" onClick={save} disabled={!dirty || saving} loading={saving}>Save</Button>
            </InlineStack>
          </InlineStack>

          {error && (
            <Banner tone="critical" onDismiss={() => setError('')}
              action={conflict ? { content: 'Reload', onAction: () => { setError(''); load(); } } : undefined}>
              {error}
            </Banner>
          )}

          {/* Unscheduled — title, filters and buttons outside the card */}
          <InlineStack align="space-between" blockAlign="end" gap="200" wrap>
            <InlineStack gap="200" blockAlign="center">
              <Text variant="headingMd" as="h3">Unscheduled</Text>
              <span style={{ fontSize: 12, fontWeight: 650, padding: '1px 8px', borderRadius: 999, background: '#e3e3e3' }}>{unscheduled.length}</span>
            </InlineStack>
            <InlineStack gap="200" blockAlign="end" wrap>
              <InlineStack gap="100">
                {filterBtn('all', 'All')}{filterBtn('po', 'PO')}{filterBtn('transfer', 'Transfer')}{filterBtn('custom', 'Other')}
              </InlineStack>
              <div style={{ minWidth: 130 }}>
                <Select label="Group by" options={[{ label: 'Location', value: 'location' }]} value={groupBy} onChange={setGroupBy} />
              </div>
              <Button onClick={() => setCreateOpen(true)}>Create task</Button>
            </InlineStack>
          </InlineStack>

          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 0 rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.08)', padding: 14 }}>
            {tray.length === 0 ? (
              <Text tone="subdued">{unscheduled.length === 0 ? 'No unscheduled tasks.' : 'No unscheduled tasks match.'}</Text>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
                {tray.map(t => (
                  <TaskCard key={t.id} task={t} selected={sel.includes(t.id)} onToggle={toggle} onOpenNumber={openNumber} />
                ))}
              </div>
            )}
          </div>

          {/* Action bar (spec §4) */}
          <div style={{
            minHeight: 52, boxSizing: 'border-box', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
            padding: '8px 14px', borderRadius: 12,
            background: hasSel ? '#e0f2fe' : '#fff', border: `1px solid ${hasSel ? '#a8d1ff' : '#e1e3e5'}`,
          }}>
            {!hasSel ? (
              <span style={{ color: '#303030' }}>Select a task to manage it, you can add an unscheduled to calendar, or edit a scheduled one.</span>
            ) : (
              <>
                <span style={{ fontWeight: 700 }}>{sel.length} selected</span>
                <span>Choose the day and morning or afternoon then click <b>Add Here</b></span>
                <span style={{ flex: 1 }} />
                {canSplit && smallBtn('Split', () => setSplitTask(single))}
                {singleScheduled && singleScheduled.index > 0 && smallBtn('↑ Up', () => move(-1))}
                {singleScheduled && singleScheduled.index < slotLen - 1 && smallBtn('↓ Down', () => move(1))}
                {selScheduled.length > 0 && smallBtn('Unschedule', unschedule, { color: '#c70a24' })}
                {allUnscheduled && smallBtn(busy ? 'Deleting...' : 'Delete', deleteSelected, { color: '#c70a24', opacity: busy ? 0.6 : 1 })}
                {smallBtn('Cancel', () => setSel([]), { border: '1px solid transparent', background: 'transparent' })}
              </>
            )}
          </div>

          {/* Calendar */}
          <div style={{ overflowX: 'auto', paddingTop: 8 }}>
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
                return (
                  <section key={col.key} aria-label={longDay(col.date)} style={{
                    background: '#fff', borderRadius: 12, border: '1px solid #c9cccf', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 300,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '8px 10px 6px', borderBottom: '1px solid #e1e3e5' }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{p.dow}</span>
                      <span style={{ color: '#303030' }}>{mmdd(col.date)}</span>
                      {col.date === data.today && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6d7175' }}>Today</span>}
                    </div>
                    {HALVES.map((h, hi) => {
                      const key = slotKey(col.date, h.id);
                      const ids = (slots[key] || []).filter(id => byId[id]);
                      const exp = !!expanded[key];
                      const vis = exp ? ids : ids.slice(0, CAP);
                      return (
                        <div key={h.id} style={{
                          display: 'flex', flexDirection: 'column', gap: 6, padding: 8,
                          borderTop: hi === 0 ? 'none' : '1px solid #e1e3e5', flex: hi === 1 ? 1 : '0 0 auto',
                          background: hasSel ? '#fbfdff' : '#fff',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#303030' }}>
                            <span>{h.label}</span>
                            {ids.length > 0 && <span style={{ color: '#6d7175' }}>{ids.length}</span>}
                          </div>
                          {vis.map((id, i) => (
                            <TaskCard key={id} task={byId[id]} compact order={i + 1} selected={sel.includes(id)} onToggle={toggle} onOpenNumber={openNumber} />
                          ))}
                          {ids.length > CAP && (
                            <button type="button" onClick={() => setExpanded({ ...expanded, [key]: !exp })} style={{
                              font: 'inherit', fontSize: 12, fontWeight: 550, textAlign: 'left', padding: '4px 6px', border: 'none',
                              borderRadius: 8, background: '#f1f1f1', cursor: 'pointer',
                            }}>{exp ? 'Show less' : `Show ${ids.length - CAP} more`}</button>
                          )}
                          {ids.length === 0 && !hasSel && <span style={{ fontSize: 12, color: '#8a8a8a' }}>No tasks</span>}
                          {hasSel && (
                            <button type="button" onClick={() => place(key, `${longDay(col.date)} · ${h.name}`)} style={{
                              font: 'inherit', fontSize: 13, fontWeight: 650, minHeight: 32, borderRadius: 8,
                              border: '1.5px dashed #2c6ecb', background: '#eaf4ff', color: '#1f5199', cursor: 'pointer',
                            }}>Add Here</button>
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
