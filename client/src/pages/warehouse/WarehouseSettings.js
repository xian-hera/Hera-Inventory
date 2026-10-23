import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Page, Layout, Card, BlockStack, InlineStack, Text, Button, Banner, Modal, TextField, Checkbox } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { useLocationMap } from '../shared/locationMap';
import { LOC_PILL_DEFAULT, pillTextColor, setLocationColorsCache } from './whShared';
import { WarehouseGate, WH_ALL_TABS, WH_TAB_LABELS, WH_PIN_KEY, logoutWarehouse } from './whAccess';

// Warehouse Settings (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §10a).
// (Cards since: Sync Tasks, and Location Color 2026-10-22 — see LocationColorCard.)
// One card for now: "Custom Task" → Task Types, the options of the Type
// dropdown in Schedule › Create task.
//   • every type is a pill with × (delete)
//   • "Add type" adds a pill whose text is editable right away; click
//     elsewhere (or Enter) saves it
//   • click a pill's text to rename it
//   • empty text on save → the pill is removed; a duplicate name
//     (case-insensitive) is refused
//   • zero types is allowed
// Every change is saved at once (PUT /api/warehouse/task-types). Existing
// custom tasks keep the type text they were created with.

// ─── Location Color card (2026-10-22, Hera) ─────────────────────────────────
// One colour (HTML hex, e.g. #E32A69) per location from the shared location
// list; the Warehouse location pills use it (no colour → light grey). Type a
// hex, use the colour picker, or pick a preset. Saved with the card's Save
// (PUT /api/warehouse/location-colors).
const PRESETS = [
  ['Soft Pink', '#F6C9D5'], ['Peach', '#F7D4BC'], ['Apricot', '#F9DDAE'], ['Butter Yellow', '#F6E9A6'],
  ['Lime', '#E4EEB4'], ['Mint Green', '#C5EBD4'], ['Sage Green', '#C9DCC2'], ['Seafoam', '#BFE5DE'],
  ['Pale Cyan', '#C4E9F1'], ['Sky Blue', '#C9DDF5'], ['Periwinkle', '#D1D7F4'], ['Lavender', '#E1D2F4'],
  ['Lilac Pink', '#EBCFF0'], ['Dusty Rose', '#E8C7CE'], ['Sand', '#E9DDC9'], ['Warm Gray', '#DFDAD5'],
  ['Cool Gray', '#D7E0E6'], ['Pale Teal', '#BFDCD8'], ['Mauve', '#DCC9DF'],
];
const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
function normHex(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (!HEX_RE.test(t)) return null;
  let h = t.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return `#${h.toUpperCase()}`;
}

function LocationColorCard() {
  const { names } = useLocationMap();
  const [saved, setSaved] = useState({});
  const [draft, setDraft] = useState({});   // name → text as typed
  const [openFor, setOpenFor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);     // { tone, text }

  useEffect(() => {
    fetch('/api/warehouse/location-colors')
      .then(r => r.json())
      .then(d => { const c = (d && d.colors) || {}; setSaved(c); setDraft(c); })
      .catch(e => setMsg({ tone: 'critical', text: e.message }))
      .finally(() => setLoading(false));
  }, []);

  const bad = names.filter(n => normHex(draft[n]) === null);
  const cleaned = {};
  names.forEach(n => { const h = normHex(draft[n]); if (h) cleaned[n] = h; });
  // keep colours of locations no longer in the list untouched
  Object.keys(saved).forEach(n => { if (!names.includes(n)) cleaned[n] = saved[n]; });
  const dirty = JSON.stringify(Object.entries(cleaned).sort()) !== JSON.stringify(Object.entries(saved).sort());

  const save = async () => {
    if (bad.length) { setMsg({ tone: 'critical', text: `Not a colour like #E32A69: ${bad.join(', ')}` }); return; }
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/warehouse/location-colors', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ colors: cleaned }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Save failed');
      setSaved(d.colors); setDraft(d.colors); setLocationColorsCache(d.colors);
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'critical', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingMd" as="h2">Location Color</Text>
        <Text tone="subdued" variant="bodySm">
          Colour of each location's pill on the Warehouse pages (HTML colour code, e.g. #E32A69). A location without a colour is light grey.
        </Text>
        {msg && <Banner tone={msg.tone} onDismiss={() => setMsg(null)}>{msg.text}</Banner>}
        {loading ? <Text tone="subdued">Loading...</Text> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '8px 24px' }}>
            {names.map(n => {
              const h = normHex(draft[n]);
              const bg = h || LOC_PILL_DEFAULT;
              const invalid = h === null;
              return (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
                  <span style={{
                    display: 'inline-block', minWidth: 64, textAlign: 'center', padding: '2px 10px', borderRadius: 999,
                    background: invalid ? LOC_PILL_DEFAULT : bg, color: pillTextColor(invalid ? LOC_PILL_DEFAULT : bg),
                    fontSize: 13, fontWeight: 650, whiteSpace: 'nowrap',
                  }}>{n}</span>
                  <input
                    value={draft[n] || ''}
                    onChange={e => { setMsg(null); setDraft(prev => ({ ...prev, [n]: e.target.value })); }}
                    placeholder="#E32A69"
                    aria-label={`${n} colour`}
                    style={{
                      width: 96, padding: '6px 8px', fontSize: 14, borderRadius: 8, fontFamily: 'monospace',
                      border: `1px solid ${invalid ? '#d72c0d' : '#c9cccf'}`,
                    }}
                  />
                  <input
                    type="color"
                    value={h || '#E4E5E7'}
                    onChange={e => { setMsg(null); setDraft(prev => ({ ...prev, [n]: e.target.value.toUpperCase() })); }}
                    aria-label={`${n} colour picker`}
                    style={{ width: 32, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                  <Button size="slim" onClick={() => setOpenFor(openFor === n ? null : n)}>Presets</Button>
                  {draft[n] && <Button size="slim" variant="plain" onClick={() => setDraft(prev => ({ ...prev, [n]: '' }))}>Clear</Button>}
                  {openFor === n && (
                    <div style={{
                      position: 'absolute', zIndex: 20, top: 38, left: 0, background: '#fff', border: '1px solid #c9cccf',
                      borderRadius: 10, boxShadow: '0 6px 18px rgba(0,0,0,0.15)', padding: 10,
                      display: 'grid', gridTemplateColumns: 'repeat(5, 28px)', gap: 8,
                    }}>
                      {PRESETS.map(([label, hex]) => (
                        <button key={hex} type="button" title={`${label} ${hex}`}
                          onClick={() => { setDraft(prev => ({ ...prev, [n]: hex })); setOpenFor(null); setMsg(null); }}
                          style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid #c9cccf', background: hex, cursor: 'pointer' }} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <InlineStack align="end" gap="300" blockAlign="center">
          {dirty && <Text tone="subdued" variant="bodySm">Unsaved changes</Text>}
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

let keySeq = 0;
const withKeys = (list) => list.map(name => ({ key: `t${++keySeq}`, name }));

function EditablePill({ item, editing, onStartEdit, onCommit, onCancel, onDelete, busy }) {
  const [draft, setDraft] = useState(item.name);
  const inputRef = useRef(null);
  const doneRef = useRef(false);
  useEffect(() => {
    if (editing) {
      setDraft(item.name);
      doneRef.current = false;
      setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
    }
  }, [editing, item.name]);

  const finish = (save) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (save) onCommit(draft); else onCancel();
  };

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: 14,
      background: editing ? '#ffffff' : '#f1f2f3', border: editing ? '1px solid #8a8a8a' : '1px solid transparent',
      fontSize: 13,
    }}>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          maxLength={40}
          size={Math.max(6, draft.length + 1)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          }}
          style={{ border: 'none', outline: 'none', font: 'inherit', background: 'transparent', padding: 0 }}
          aria-label="Type name"
        />
      ) : (
        <span
          role="button"
          tabIndex={0}
          title="Click to rename"
          onClick={() => !busy && onStartEdit()}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) onStartEdit(); }}
          style={{ cursor: busy ? 'default' : 'text' }}
        >{item.name}</span>
      )}
      {!editing && (
        <span
          role="button"
          tabIndex={0}
          aria-label={`Delete ${item.name}`}
          onClick={() => !busy && onDelete()}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) onDelete(); }}
          style={{ cursor: busy ? 'default' : 'pointer', marginLeft: 8, color: '#d72c0d', opacity: busy ? 0.5 : 1 }}
        >×</span>
      )}
    </span>
  );
}

// ─── User Group card (2026-10-23, Hera) ─────────────────────────────────────
// Up to 3 groups: name + the tabs it may open (Settings is one of them).
// Edited as a draft, stored with the card's Save (PUT /api/warehouse/user-groups).
// Accounts of a deleted group choose again on their next visit.
function UserGroupCard() {
  const [saved, setSaved] = useState([]);
  const [draft, setDraft] = useState([]);
  const [max, setMax] = useState(3);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const tmpId = useRef(-1);

  useEffect(() => {
    fetch('/api/warehouse/user-groups')
      .then(r => r.json())
      .then(d => { const g = (d && d.groups) || []; setSaved(g); setDraft(g); if (d && d.max) setMax(d.max); })
      .catch(e => setMsg({ tone: 'critical', text: e.message }))
      .finally(() => setLoading(false));
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const update = (id, patch) => { setDraft(prev => prev.map(g => (g.id === id ? { ...g, ...patch } : g))); setMsg(null); };
  const add = () => { setDraft(prev => [...prev, { id: tmpId.current--, name: '', tabs: [] }]); setMsg(null); };
  const remove = (id) => { setDraft(prev => prev.filter(g => g.id !== id)); setMsg(null); };
  const toggleTab = (g, t) => update(g.id, { tabs: g.tabs.includes(t) ? g.tabs.filter(x => x !== t) : WH_ALL_TABS.filter(x => x === t || g.tabs.includes(x)) });

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/warehouse/user-groups', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: draft.map(g => ({ id: g.id > 0 ? g.id : undefined, name: g.name, tabs: g.tabs })) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Save failed');
      setSaved(d.groups); setDraft(d.groups);
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'critical', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingMd" as="h2">User Group</Text>
        <Text tone="subdued" variant="bodySm">
          Up to {max} groups. Each user picks a group the first time they open Warehouse and only sees that group's tabs.
          With no groups, everyone sees every tab.
        </Text>
        {msg && <Banner tone={msg.tone} onDismiss={() => setMsg(null)}>{msg.text}</Banner>}
        {loading ? <Text tone="subdued">Loading...</Text> : (
          <BlockStack gap="300">
            {draft.length === 0 && <Text tone="subdued">No groups yet.</Text>}
            {draft.map(g => (
              <div key={g.id} style={{ border: '1px solid #e1e3e5', borderRadius: 10, padding: 12 }}>
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="end" wrap={false}>
                    <div style={{ flex: 1 }}>
                      <TextField label="Group name" value={g.name} onChange={(v) => update(g.id, { name: v })} autoComplete="off" maxLength={30} />
                    </div>
                    <Button tone="critical" variant="plain" onClick={() => remove(g.id)}>Delete</Button>
                  </InlineStack>
                  <InlineStack gap="400" wrap>
                    {WH_ALL_TABS.map(t => (
                      <Checkbox key={t} label={WH_TAB_LABELS[t]} checked={g.tabs.includes(t)} onChange={() => toggleTab(g, t)} />
                    ))}
                  </InlineStack>
                </BlockStack>
              </div>
            ))}
            <InlineStack align="space-between">
              <Button onClick={add} disabled={draft.length >= max}>Add group</Button>
              <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save</Button>
            </InlineStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

// ─── PIN card (2026-10-23, Hera) — same as Online / Purchasing ───────────────
function PinCard() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState('verify');
  const [current, setCurrent] = useState('');
  const [verified, setVerified] = useState('');
  const [newPin, setNewPin] = useState('');
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const openModal = () => { setStep('verify'); setCurrent(''); setVerified(''); setNewPin(''); setHint(''); setError(''); setDone(false); setOpen(true); };
  const close = () => setOpen(false);

  const verify = async () => {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/settings/pin/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: WH_PIN_KEY, pin: current }),
      });
      if (r.ok) {
        const h = await fetch(`/api/settings/pin/hint?key=${WH_PIN_KEY}`).then(x => x.json()).catch(() => ({}));
        setHint(h.hint || ''); setVerified(current); setStep('set'); setCurrent('');
      } else { setError('Incorrect PIN.'); setCurrent(''); }
    } catch (e) {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const savePin = async () => {
    if (!/^\d{4}$/.test(newPin)) { setError('PIN must be exactly 4 digits.'); return; }
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/settings/pin/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: WH_PIN_KEY, currentPin: verified, newPin, hint }),
      });
      if (r.ok) { setDone(true); setTimeout(close, 1400); }
      else { const d = await r.json().catch(() => ({})); setError(d.error || 'Failed to update PIN.'); }
    } catch (e) {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => { await logoutWarehouse(); navigate('/'); };

  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingMd" as="h2">PIN</Text>
        <InlineStack gap="200">
          <Button onClick={openModal}>Set PIN</Button>
          <Button tone="critical" onClick={logout}>Log out</Button>
        </InlineStack>
      </BlockStack>
      <Modal
        open={open}
        onClose={close}
        title="Set PIN"
        primaryAction={step === 'verify'
          ? { content: 'Verify', onAction: verify, disabled: current.length !== 4 || busy, loading: busy }
          : { content: 'Save PIN', onAction: savePin, disabled: newPin.length !== 4 || busy || done, loading: busy }}
        secondaryActions={[{ content: 'Cancel', onAction: close }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {done && <Banner tone="success">PIN updated successfully.</Banner>}
            {step === 'verify' && !done && (
              <TextField
                label="Current PIN" type="password" value={current} autoComplete="off" maxLength={4} placeholder="Enter current PIN"
                onChange={(v) => { if (/^\d{0,4}$/.test(v)) setCurrent(v); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && current.length === 4) verify(); }}
                helpText="Default PIN is 3591 if it has never been changed."
              />
            )}
            {step === 'set' && !done && (
              <>
                <TextField
                  label="New PIN (4 digits)" type="password" value={newPin} autoComplete="off" maxLength={4} placeholder="Choose a 4-digit PIN"
                  onChange={(v) => { if (/^\d{0,4}$/.test(v)) setNewPin(v); setError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newPin.length === 4) savePin(); }}
                />
                <TextField
                  label="Hint (optional)" value={hint} onChange={setHint} autoComplete="off" multiline={2}
                  placeholder="e.g. Year + first initial" helpText="This hint is shown on the PIN login screen. Keep it vague."
                />
                <Text variant="bodySm" tone="subdued">Changing the PIN will sign out all devices. They will need to re-enter the new PIN.</Text>
              </>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Card>
  );
}

function WarehouseSettings() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]); // [{ key, name }] — '' name = new, not saved yet
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingKey, setEditingKey] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    return fetch('/api/warehouse/task-types')
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to load'); return d; })
      .then(d => setItems(withKeys(d.types || [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (nextItems) => {
    const names = nextItems.map(i => i.name).filter(Boolean);
    setItems(nextItems.filter(i => i.name));
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/warehouse/task-types', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ types: names }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to save');
      setItems(withKeys(d.types || []));
    } catch (e) {
      setError(e.message);
      await load(); // back to what is really saved
    } finally {
      setSaving(false);
    }
  };

  const commit = (key, raw) => {
    setEditingKey(null);
    const name = String(raw || '').trim();
    const current = items.find(i => i.key === key);
    if (!current) return;
    if (!name) { // empty → remove the pill
      if (!current.name) { setItems(items.filter(i => i.key !== key)); return; }
      save(items.filter(i => i.key !== key));
      return;
    }
    if (name === current.name) return; // nothing changed
    const dup = items.some(i => i.key !== key && i.name.toLowerCase() === name.toLowerCase());
    if (dup) {
      setError(`Type "${name}" already exists.`);
      if (!current.name) setItems(items.filter(i => i.key !== key));
      return;
    }
    save(items.map(i => (i.key === key ? { ...i, name } : i)));
  };

  const cancel = (key) => {
    setEditingKey(null);
    setItems(prev => prev.filter(i => i.key !== key || i.name)); // drop an unsaved new pill
  };

  // Sync Tasks (moved here from the Schedule 2026-10-21, Hera — "so it can't
  // be clicked by accident"): adds Draft / Pending / Ready to Ship transfers
  // as Schedule cards (incl. ones from before go-live or deleted by mistake)
  // and puts Pending / Sent to store POs into Receive Shipments. Anything
  // already there is skipped.
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null); // { tone, text }
  const syncTasks = async () => {
    if (!window.confirm('Sync Transfer tasks to the Schedule, and PO tasks to Receive Shipments?\n\nTasks that are already there are skipped.')) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await fetch('/api/warehouse/sync', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Sync failed');
      const tr = (d.transfersAdded || 0) + (d.transfersRestored || 0);
      setSyncMsg({
        tone: 'success',
        text: tr === 0 && !d.posAdded
          ? 'Everything is already in sync.'
          : `Synced: ${tr} transfer card${tr === 1 ? '' : 's'} added to the Schedule, ${d.posAdded} PO${d.posAdded === 1 ? '' : 's'} added to Receive Shipments.`,
      });
    } catch (e) {
      setSyncMsg({ tone: 'critical', text: e.message });
    } finally {
      setSyncing(false);
    }
  };

  const addType = () => {
    const item = { key: `t${++keySeq}`, name: '' };
    setItems(prev => [...prev, item]);
    setEditingKey(item.key);
  };

  return (
    <Page title="Warehouse Settings" backAction={{ onAction: () => navigate('/warehouse') }}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Custom Task</Text>
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
              <BlockStack gap="200">
                <Text as="h3" fontWeight="semibold">Task Types</Text>
                <Text tone="subdued" variant="bodySm">
                  Options of the Type dropdown when creating a custom task on the Schedule. Click a type to rename it.
                  Renaming or deleting a type does not change tasks already created.
                </Text>
                {loading ? (
                  <Text tone="subdued">Loading...</Text>
                ) : (
                  <InlineStack gap="150" wrap blockAlign="center">
                    {items.length === 0 && <Text tone="subdued">No types yet.</Text>}
                    {items.map(item => (
                      <EditablePill
                        key={item.key}
                        item={item}
                        editing={editingKey === item.key}
                        busy={saving}
                        onStartEdit={() => setEditingKey(item.key)}
                        onCommit={(v) => commit(item.key, v)}
                        onCancel={() => cancel(item.key)}
                        onDelete={() => save(items.filter(i => i.key !== item.key))}
                      />
                    ))}
                    <Button onClick={addType} disabled={saving || editingKey !== null}>Add type</Button>
                  </InlineStack>
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Sync Tasks</Text>
              <Text tone="subdued" variant="bodySm">
                Sync Transfer tasks, and PO tasks to Receive Shipments. Adds Draft / Pending / Ready to Ship transfers to the
                Schedule and Pending / Sent to store POs to Receive Shipments — including ones from before the Schedule
                started and ones deleted by mistake. Tasks that are already there are skipped.
              </Text>
              {syncMsg && <Banner tone={syncMsg.tone} onDismiss={() => setSyncMsg(null)}>{syncMsg.text}</Banner>}
              <InlineStack>
                <Button onClick={syncTasks} loading={syncing}>Sync Tasks</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <LocationColorCard />
        </Layout.Section>
        <Layout.Section>
          <UserGroupCard />
        </Layout.Section>
        <Layout.Section>
          <PinCard />
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// PIN + user group gate (2026-10-23): a group without Settings is sent to its
// first tab.
function WarehouseSettingsGated() {
  return <WarehouseGate tab="settings">{() => <WarehouseSettings />}</WarehouseGate>;
}

export default WarehouseSettingsGated;
