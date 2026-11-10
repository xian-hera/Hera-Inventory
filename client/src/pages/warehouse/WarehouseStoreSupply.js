import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Page, BlockStack, InlineStack, Text, Button, Banner, Modal, TextField, Select, Card, Tabs } from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import { api, deadlineText, packText, Switch, QtyEditor, DeadlinePicker, StatusDot, STATUS_TEXT, HUB_BOX, SUBDUED } from './supplyShared';
import { SupplyRequests, ShoppingList } from './WarehouseSupplyBatch';

// Warehouse › Store Supply (2026-11-09, Hera — claude/STORE_SUPPLY_SPEC.md).
// Sub-tabs: Shopping List · Supply Requests · Supply Management · Inventory.
// Step 1 builds Supply Management (deadlines + items) and Inventory; Shopping
// List and Supply Requests come in step 2.
// Step 2 (2026-11-10): Supply Requests and Shopping List — WarehouseSupplyBatch.js.

const CONTENT_W = 1280; // same width as the Schedule tab
// Order 2026-11-10 (Hera): Supply Management moved after Inventory.
const SUBTABS = [
  { id: 'shopping-list', label: 'Shopping List' },
  { id: 'requests', label: 'Supply Requests' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'management', label: 'Supply Management' },
];
// Opening the tab without a sub-tab (2026-11-10, Hera): Shopping List when it
// has items, else Supply Requests when the Current Batch has requests, else
// Inventory — see GET /api/store-supply/overview. (Was always Supply
// Management while only step 1 existed.)
const DEFAULT_SUB = 'inventory';

const PILL = { display: 'inline-block', padding: '1px 9px', borderRadius: 999, fontSize: 12, fontWeight: 600, lineHeight: '18px' };
const GREEN = '#008060';
const RED_X = '#d72c0d';

// Polaris Tabs (2026-11-10, Hera: same look as the other Hub pages; was
// custom bold pill buttons).
function SubTabs({ sub, onSelect }) {
  return (
    <Tabs
      tabs={SUBTABS.map(t => ({ id: `ss-${t.id}`, content: t.label }))}
      selected={Math.max(0, SUBTABS.findIndex(t => t.id === sub))}
      onSelect={(i) => onSelect(SUBTABS[i].id)}
    />
  );
}

const XButton = ({ onClick, label }) => (
  <button type="button" aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); onClick(); }}
    style={{ border: 'none', background: 'none', color: RED_X, fontSize: 16, fontWeight: 600, lineHeight: 1, cursor: 'pointer', padding: 2 }}>×</button>
);

const ArrowBtn = ({ dir, disabled, onClick }) => (
  <button type="button" aria-label={dir < 0 ? 'Move up' : 'Move down'} disabled={disabled}
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    style={{
      width: 24, height: 24, borderRadius: 6, border: '1px solid #c9cccf', background: '#fff', padding: 0,
      color: disabled ? '#d0d0d0' : '#303030', cursor: disabled ? 'default' : 'pointer', fontSize: 13, lineHeight: '22px',
    }}>{dir < 0 ? '↑' : '↓'}</button>
);

// Inline text edit: saves on blur / Enter, Esc cancels.
function InlineEdit({ value, onSave, placeholder, width = '100%', fontSize = 13, bold, numeric }) {
  const [v, setV] = useState(value || '');
  const cancel = useRef(false);
  return (
    <input
      autoFocus
      value={v}
      placeholder={placeholder}
      inputMode={numeric ? 'numeric' : undefined}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(numeric ? e.target.value.replace(/[^0-9]/g, '') : e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur(); }
      }}
      onBlur={() => { if (cancel.current) { cancel.current = false; onSave(null); return; } onSave(v.trim()); }}
      style={{
        width, boxSizing: 'border-box', font: 'inherit', fontSize, fontWeight: bold ? 600 : 400, padding: '2px 6px',
        border: '1px solid #8a8a8a', borderRadius: 6, background: '#fff',
      }}
    />
  );
}

// ── Deadlines ───────────────────────────────────────────────────────────────

function NextControls({ mode, weeks, next, current, onChange, busy }) {
  const auto = mode === 'auto';
  return (
    <InlineStack gap="300" blockAlign="center" wrap>
      <Text variant="headingMd" as="span">{next ? deadlineText(next) : '—'}</Text>
      {!auto && <DeadlinePicker value={next} afterIso={current} onPick={(iso) => onChange({ mode: 'manual', next: iso })} label="Choose the Next Deadline" />}
      <InlineStack gap="150" blockAlign="center">
        <Switch on={auto} label={auto ? 'Auto' : 'Manual'} disabled={busy}
          onChange={(on) => onChange(on ? { mode: 'auto', weeks } : { mode: 'manual', next })} />
        {auto ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: SUBDUED, fontSize: 13 }}>
            Repeat every
            <input type="number" min={1} max={9} value={weeks} disabled={busy}
              onChange={(e) => { const n = Math.min(9, Math.max(1, parseInt(e.target.value, 10) || 1)); onChange({ mode: 'auto', weeks: n }); }}
              style={{ width: 44, font: 'inherit', fontSize: 13, padding: '2px 6px', border: '1px solid #8a8a8a', borderRadius: 6, color: '#303030' }} />
            weeks
          </span>
        ) : (
          <span style={{ color: SUBDUED, fontSize: 13 }}>Select date manually</span>
        )}
      </InlineStack>
    </InlineStack>
  );
}

function Deadlines({ settings, onSaved, setError }) {
  const [busy, setBusy] = useState(false);
  // first use: choose Current + Next
  const [setup, setSetup] = useState({ current: '', mode: 'auto', weeks: 2, next: '' });
  const put = async (url, body) => {
    setBusy(true);
    setError('');
    try { onSaved(await api('PUT', url, body)); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  if (!settings.setUp) {
    const nextShown = setup.mode === 'auto' && setup.current ? addDaysIso(setup.current, setup.weeks * 7) : setup.next;
    return (
      <Card>
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">Set Up Deadlines</Text>
          <InlineStack gap="300" blockAlign="center">
            <span style={{ color: SUBDUED, fontSize: 13, minWidth: 110 }}>Current Deadline</span>
            <Text variant="headingMd" as="span">{setup.current ? deadlineText(setup.current) : '—'}</Text>
            <DeadlinePicker value={setup.current} afterIso={addDaysIso(settings.today, -1)} onPick={(iso) => setSetup(s => ({ ...s, current: iso }))} label="Choose the Current Deadline" />
          </InlineStack>
          <InlineStack gap="300" blockAlign="center">
            <span style={{ color: SUBDUED, fontSize: 13, minWidth: 110 }}>Next Deadline</span>
            <NextControls mode={setup.mode} weeks={setup.weeks} next={nextShown} current={setup.current || settings.today}
              onChange={(c) => setSetup(s => ({ ...s, ...c }))} busy={busy} />
          </InlineStack>
          <InlineStack>
            <Button variant="primary" loading={busy} disabled={!setup.current || (setup.mode === 'manual' && !setup.next)}
              onClick={() => put('/settings/setup', setup)}>Save</Button>
          </InlineStack>
        </BlockStack>
      </Card>
    );
  }
  return (
    <InlineStack gap="300" blockAlign="stretch" wrap>
      <div style={{ background: '#e3e3e3', borderRadius: 12, padding: '10px 16px', minWidth: 170 }}>
        <InlineStack gap="300" blockAlign="center">
          <span style={{ color: SUBDUED, fontSize: 12 }}>Current Deadline</span>
          <span style={{ ...PILL, background: GREEN, color: '#fff' }}>Open</span>
        </InlineStack>
        <div style={{ marginTop: 6 }}><Text variant="headingMd" as="span">{deadlineText(settings.current)}</Text></div>
      </div>
      <div style={{ ...HUB_BOX, padding: '10px 16px' }}>
        <InlineStack gap="300" blockAlign="center">
          <span style={{ color: SUBDUED, fontSize: 12 }}>Next Deadline</span>
          <span style={{ ...PILL, background: '#e3e3e3', color: '#303030' }}>Incoming</span>
        </InlineStack>
        <div style={{ marginTop: 6 }}>
          <NextControls mode={settings.mode} weeks={settings.weeks} next={settings.next} current={settings.current}
            onChange={(c) => put('/settings/next', c)} busy={busy} />
        </div>
      </div>
    </InlineStack>
  );
}

function addDaysIso(iso, n) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n, 12));
  return dt.toISOString().slice(0, 10);
}

// ── Supply Management ───────────────────────────────────────────────────────

// Status (2026-11-10, Hera): a yellow (Out of Stock) / grey (Archived) dot
// before the name, its name on hover. A selected card shows, on hover, a
// box above it: Available / Archive (the current one pressed and not
// clickable) and the Hera Stock checkbox (no stock → Out of Stock by itself).
const STATUS_CSS = `
  .ssm-card .ssm-tip, .ssm-card .ssm-pop { display: none; }
  .ssm-card:hover .ssm-tip, .ssm-card:hover .ssm-pop { display: block; }
`;
function StatusPopover({ item, onChange }) {
  const btn = (label, active, onClick) => (
    <button type="button" disabled={active} onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        display: 'block', width: '100%', font: 'inherit', fontSize: 13, fontWeight: 450, padding: '4px 10px', borderRadius: 8,
        // current status (2026-11-10, Hera): light grey fill like the Current
        // Deadline box, dark grey label, not clickable; the other one stays white.
        border: `1px solid ${active ? '#e3e3e3' : '#c9cccf'}`, background: active ? '#e3e3e3' : '#fff',
        color: active ? '#616161' : '#303030', cursor: active ? 'default' : 'pointer',
      }}>{label}</button>
  );
  return (
    <div className="ssm-pop" onClick={(e) => e.stopPropagation()}
      style={{ position: 'absolute', left: 0, bottom: '100%', paddingBottom: 6, zIndex: 30 }}>
      <div style={{ width: 150, background: '#fff', border: '1px solid #c9cccf', borderRadius: 10, boxShadow: '0 6px 18px rgba(0,0,0,0.15)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {item.status === 'out_of_stock' && <span style={{ fontSize: 12, color: '#8a6200', fontWeight: 600 }}>Out of Stock</span>}
        {btn('Available', item.status === 'available', () => onChange({ status: 'available' }))}
        {btn('Archive', item.status === 'archived', () => onChange({ status: 'archived' }))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', marginTop: 2 }}>
          <input type="checkbox" checked={!!item.heraStock} onChange={(e) => onChange({ heraStock: e.target.checked })} />
          Hera Stock
        </label>
      </div>
    </div>
  );
}

function ItemCard({ item, selected, editing, onSelect, onEdit, onSave, onDelete, onStatus }) {
  const field = editing && editing.id === item.id ? editing.kind : null;
  const click = (kind) => (e) => { e.stopPropagation(); onSelect(); onEdit(kind); };
  return (
    <div
      className="ssm-card"
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      style={{
        // Same card as the Schedule's task cards (2026-11-10, Hera): 1 px
        // border, 2 px only while selected, 13 px text.
        position: 'relative', background: '#fff', borderRadius: 10, padding: selected ? '6px 9px' : '7px 10px', minHeight: 58, boxSizing: 'border-box',
        border: `${selected ? 2 : 1}px solid ${selected ? GREEN : '#c9cccf'}`, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13,
      }}
    >
      {selected && <span style={{ position: 'absolute', top: 4, right: 6 }}><XButton label="Delete item" onClick={onDelete} /></span>}
      {selected
        ? <StatusPopover item={item} onChange={onStatus} />
        : STATUS_TEXT[item.status] && (
          <div className="ssm-tip" style={{ position: 'absolute', left: 0, bottom: '100%', paddingBottom: 4, zIndex: 30, pointerEvents: 'none' }}>
            <span style={{ background: '#303030', color: '#fff', fontSize: 12, borderRadius: 6, padding: '3px 8px', whiteSpace: 'nowrap' }}>{STATUS_TEXT[item.status]}</span>
          </div>
        )}
      <div style={{ paddingRight: selected ? 18 : 0, display: 'flex', alignItems: 'center' }}>
        <StatusDot status={item.status} />
        {field === 'name'
          ? <InlineEdit value={item.name} bold onSave={(v) => onSave(v === null ? null : { name: v })} />
          : <span onClick={click('name')} style={{ fontWeight: 600, wordBreak: 'break-word' }}>{item.name}</span>}
      </div>
      <div style={{ fontSize: 12, color: SUBDUED, minHeight: 18 }}>
        {field === 'pack'
          ? <InlineEdit value={item.packSize} placeholder="Pack size" fontSize={12} width="80%" onSave={(v) => onSave(v === null ? null : { packSize: v })} />
          : (item.packSize
            ? <span onClick={click('pack')}>{packText(item.packSize)}</span>
            : selected && <span onClick={click('pack')} style={{ color: '#b5b5b5' }}>Pack size</span>)}
      </div>
      <div style={{ position: 'absolute', right: 10, bottom: 6, fontSize: 12, color: SUBDUED }}>
        {field === 'max'
          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Max <InlineEdit value={item.max == null ? '' : String(item.max)} numeric fontSize={12} width={56} placeholder="None" onSave={(v) => onSave(v === null ? null : { max: v })} /></span>
          : (item.max != null
            ? <span onClick={click('max')}>Max {item.max}</span>
            : selected && <span onClick={click('max')} style={{ color: '#b5b5b5' }}>Max</span>)}
      </div>
    </div>
  );
}

function SupplyManagement({ setError, setNotice }) {
  const [settings, setSettings] = useState(null);
  const [groups, setGroups] = useState(null);
  const [sel, setSel] = useState({ groupId: null, itemId: null });
  const [editing, setEditing] = useState(null); // { kind: 'group' | 'name' | 'pack' | 'max', id }
  const [addOpen, setAddOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [notEmpty, setNotEmpty] = useState(false);
  const zoneRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([api('GET', '/settings'), api('GET', '/items')]);
      setSettings(s); setGroups(i.groups);
    } catch (e) { setError(e.message); }
  }, [setError]);
  useEffect(() => { load(); }, [load]);

  // Click anywhere outside a group (and outside modals / popovers) → nothing selected.
  useEffect(() => {
    const down = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-sg]') || t.closest('.Polaris-Modal-Dialog') || t.closest('.Polaris-Popover') || t.closest('[data-portal-id]')) return;
      setSel({ groupId: null, itemId: null });
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, []);

  const run = async (method, url, body) => {
    setError('');
    setNotice('');
    try {
      const d = await api(method, url, body);
      if (d.groups) setGroups(d.groups);
      if (d.notice) setNotice(d.notice);
      return d;
    } catch (e) { setError(e.message); return null; }
  };
  const saveItem = async (id, change) => { setEditing(null); if (change) await run('PATCH', `/items/${id}`, change); };

  if (!settings || !groups) return <Text tone="subdued">Loading...</Text>;

  return (
    <BlockStack gap="400">
      <style>{STATUS_CSS}</style>
      <Deadlines settings={settings} onSaved={setSettings} setError={setError} />

      <InlineStack align="end">
        <Button onClick={() => setAddOpen(true)} disabled={groups.length === 0}>Add</Button>
      </InlineStack>

      <div ref={zoneRef}>
        <BlockStack gap="400">
          {groups.length === 0 && <Text tone="subdued">No groups yet. Use Add Group to create the first one.</Text>}
          {groups.map((g, gi) => {
            const gSel = sel.groupId === g.id;
            const selItem = gSel && sel.itemId ? g.items.findIndex(x => x.id === sel.itemId) : -1;
            return (
              <div key={g.id} data-sg="1" style={{ position: 'relative', paddingLeft: 36 }}
                onClick={() => setSel({ groupId: g.id, itemId: null })}>
                {gSel && (
                  <div style={{ position: 'absolute', left: 0, top: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <ArrowBtn dir={-1} disabled={gi === 0} onClick={() => run('POST', `/groups/${g.id}/move`, { dir: -1 })} />
                    <ArrowBtn dir={1} disabled={gi === groups.length - 1} onClick={() => run('POST', `/groups/${g.id}/move`, { dir: 1 })} />
                  </div>
                )}
                <div style={{
                  // selected group = white Hub box (was a 2 px border, 2026-11-10)
                  position: 'relative', borderRadius: 12, padding: 12, cursor: 'pointer',
                  ...(gSel ? HUB_BOX : { background: 'transparent' }),
                }}>
                  {gSel && <span style={{ position: 'absolute', top: 8, right: 12 }}><XButton label="Delete group" onClick={async () => {
                    if (g.items.length > 0) { setNotEmpty(true); return; }
                    await run('DELETE', `/groups/${g.id}`);
                    setSel({ groupId: null, itemId: null });
                  }} /></span>}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, minHeight: 26 }}>
                    {editing && editing.kind === 'group' && editing.id === g.id
                      ? <div style={{ width: 260 }}><InlineEdit value={g.name} fontSize={14} bold onSave={async (v) => { setEditing(null); if (v) await run('PATCH', `/groups/${g.id}`, { name: v }); }} /></div>
                      : <span onClick={(e) => { e.stopPropagation(); setSel({ groupId: g.id, itemId: null }); setEditing({ kind: 'group', id: g.id }); }}>
                          <Text variant="headingMd" as="span">{g.name}</Text>
                        </span>}
                    {selItem >= 0 && (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <ArrowBtn dir={-1} disabled={selItem === 0} onClick={() => run('POST', `/items/${sel.itemId}/move`, { dir: -1 })} />
                        <ArrowBtn dir={1} disabled={selItem === g.items.length - 1} onClick={() => run('POST', `/items/${sel.itemId}/move`, { dir: 1 })} />
                      </span>
                    )}
                  </div>
                  {g.items.length === 0 ? (
                    <Text tone="subdued">No items in this group.</Text>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                      {g.items.map(it => (
                        <ItemCard
                          key={it.id}
                          item={it}
                          selected={sel.itemId === it.id}
                          editing={editing}
                          onSelect={() => setSel({ groupId: g.id, itemId: it.id })}
                          onEdit={(kind) => setEditing({ kind, id: it.id })}
                          onSave={(change) => {
                            if (change && 'name' in change && !change.name) { setEditing(null); return; }
                            saveItem(it.id, change);
                          }}
                          onStatus={(change) => run('PATCH', `/items/${it.id}`, change)}
                          onDelete={async () => {
                            if (!window.confirm(`Delete “${it.name}”?`)) return;
                            await run('DELETE', `/items/${it.id}`);
                            setSel({ groupId: g.id, itemId: null });
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </BlockStack>
      </div>

      <InlineStack>
        <div style={{ paddingLeft: 36 }}><Button onClick={() => setGroupOpen(true)}>Add Group</Button></div>
      </InlineStack>

      {addOpen && <AddItemModal groups={groups} defaultGroup={sel.groupId} onClose={() => setAddOpen(false)}
        onAdd={async (body) => { const d = await run('POST', '/items', body); if (d) setAddOpen(false); return d; }} />}
      {groupOpen && <AddGroupModal onClose={() => setGroupOpen(false)}
        onAdd={async (name) => { const d = await run('POST', '/groups', { name }); if (d) setGroupOpen(false); }} />}
      <Modal open={notEmpty} onClose={() => setNotEmpty(false)} title="Can’t Delete This Group"
        primaryAction={{ content: 'OK', onAction: () => setNotEmpty(false) }}>
        <Modal.Section><Text as="p">Empty the items in this group first.</Text></Modal.Section>
      </Modal>
    </BlockStack>
  );
}

function AddItemModal({ groups, defaultGroup, onClose, onAdd }) {
  const [groupId, setGroupId] = useState(String(defaultGroup || (groups[0] && groups[0].id) || ''));
  const [name, setName] = useState('');
  const [pack, setPack] = useState('');
  const [max, setMax] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => { setSaving(true); await onAdd({ groupId: Number(groupId), name: name.trim(), packSize: pack.trim(), max: max.trim() }); setSaving(false); };
  return (
    <Modal open onClose={onClose} title="Add Item" size="small"
      primaryAction={{ content: 'Confirm', onAction: submit, disabled: !groupId || !name.trim() || saving, loading: saving }}>
      <Modal.Section>
        <BlockStack gap="300">
          <Select label="Group" options={groups.map(g => ({ label: g.name, value: String(g.id) }))} value={groupId} onChange={setGroupId} />
          <TextField label="Name" value={name} onChange={setName} autoComplete="off" maxLength={120} />
          <TextField label="Pack Size" value={pack} onChange={setPack} autoComplete="off" maxLength={60} placeholder="e.g. 9 bottles — empty = 1 item" />
          <TextField label="Max per Request" value={max} onChange={(v) => setMax(v.replace(/[^0-9]/g, ''))} autoComplete="off" inputMode="numeric" placeholder="Empty = no limit" />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function AddGroupModal({ onClose, onAdd }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <Modal open onClose={onClose} title="Add Group" size="small"
      primaryAction={{ content: 'Confirm', disabled: !name.trim() || saving, loading: saving, onAction: async () => { setSaving(true); await onAdd(name.trim()); setSaving(false); } }}>
      <Modal.Section>
        <TextField label="Group Name" value={name} onChange={setName} autoComplete="off" maxLength={80} />
      </Modal.Section>
    </Modal>
  );
}

// ── Inventory ───────────────────────────────────────────────────────────────

function Inventory({ setError }) {
  const [groups, setGroups] = useState(null);
  useEffect(() => { api('GET', '/items').then(d => setGroups(d.groups)).catch(e => setError(e.message)); }, [setError]);
  if (!groups) return <Text tone="subdued">Loading...</Text>;
  const rows = groups.flatMap(g => g.items.map(it => ({ ...it, group: g.name })));
  // Hub table look (2026-11-10): 12 px grey headers, 13 px rows.
  const TH = { textAlign: 'left', fontWeight: 550, color: SUBDUED, fontSize: 12, padding: '8px 12px', borderBottom: '1px solid #e3e3e3' };
  const TD = { padding: '4px 12px', height: 40, boxSizing: 'border-box', borderBottom: '1px solid #f1f1f1', fontSize: 13, verticalAlign: 'middle' };
  // Qty column (2026-11-10): wide enough for − [qty] + from the start (the
  // buttons are only hidden), and kept off the right edge.
  const QTY_COL = { width: 140, paddingRight: 28, textAlign: 'center' };
  return (
    <div style={{ ...HUB_BOX, padding: '4px 8px', overflowX: 'auto' }}>
      {rows.length === 0 ? <div style={{ padding: 12 }}><Text tone="subdued">No items yet — add them in Supply Management.</Text></div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            {/* "Title" → "Name" (2026-11-10, Hera) */}
            <tr><th style={TH}>Name</th><th style={TH}>Pack Size</th><th style={TH}>Group</th><th style={{ ...TH, ...QTY_COL }}>Qty</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td style={TD} title={STATUS_TEXT[r.status] || undefined}><StatusDot status={r.status} />{r.name}</td>
                <td style={{ ...TD, color: r.packSize ? '#303030' : '#b5b5b5' }}>{r.packSize || '—'}</td>
                <td style={TD}>{r.group}</td>
                <td style={{ ...TD, ...QTY_COL }}>
                  <QtyEditor value={r.inventory} min={0} onCommit={async (n) => {
                    setError('');
                    try { const d = await api('PATCH', `/items/${r.id}`, { inventory: n }); setGroups(d.groups); } catch (e) { setError(e.message); }
                  }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

function WarehouseStoreSupply() {
  const navigate = useNavigate();
  const params = useParams();
  const sub = SUBTABS.some(t => t.id === params.sub) ? params.sub : null;
  useEffect(() => {
    if (sub) return undefined;
    let gone = false;
    api('GET', '/overview')
      .then(d => { if (!gone) navigate(`/warehouse/store-supply/${d.shoppingCount > 0 ? 'shopping-list' : d.currentBatchCount > 0 ? 'requests' : 'inventory'}`, { replace: true }); })
      .catch(() => { if (!gone) navigate(`/warehouse/store-supply/${DEFAULT_SUB}`, { replace: true }); });
    return () => { gone = true; };
  }, [sub, navigate]);
  const [error, setErrorState] = useState('');
  const setError = useCallback((m) => setErrorState(m), []);
  const [notice, setNoticeState] = useState('');
  const setNotice = useCallback((m) => setNoticeState(m), []);
  if (!sub) return <Page><Text tone="subdued">Loading...</Text></Page>;
  return (
    <Page>
      <div style={{ position: 'relative', left: '50%', transform: 'translateX(-50%)', width: `min(${CONTENT_W}px, calc(100vw - 32px))` }}>
        <BlockStack gap="400">
          <SubTabs sub={sub} onSelect={(id) => { setErrorState(''); setNoticeState(''); navigate(`/warehouse/store-supply/${id}`); }} />
          {error && <Banner tone="critical" onDismiss={() => setErrorState('')}>{error}</Banner>}
          {notice && <Banner tone="warning" onDismiss={() => setNoticeState('')}>{notice}</Banner>}
          {sub === 'management' && <SupplyManagement setError={setError} setNotice={setNotice} />}
          {sub === 'inventory' && <Inventory setError={setError} />}
          {sub === 'requests' && <SupplyRequests setError={setError} />}
          {sub === 'shopping-list' && <ShoppingList setError={setError} />}
        </BlockStack>
      </div>
    </Page>
  );
}

export default WarehouseStoreSupply;
