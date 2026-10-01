// Online › Dashboard — the team's daily work checklist (2026-10-01, Hera).
// Spec: claude/ONLINE_DASHBOARD_SPEC.md. Server: server/routes/onlineTasks.js.
//   - Regular tasks come back as "not done" every day at 07:00 (Montreal).
//   - Temp tasks stay until they are done (then gone after the next 07:00) or deleted.
//   - Tick the circle = done (card goes grey, below the line); tick again = not done.
//   - Edit: select not-done cards -> Move to Top / Delete, then Save or Cancel.
//   - Task history: what was not done each working day (recorded at 23:00).
import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, BlockStack, InlineStack, Text, Banner, Modal, Select, TextField, Checkbox,
} from '@shopify/polaris';

const DOT = { regular: '#36a849', normal: '#f5a623', urgent: '#e22b2b' };
const dotColor = t => (t.type === 'regular' ? DOT.regular : t.priority === 'urgent' ? DOT.urgent : DOT.normal);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const fmtDay = (d) => { const [y, m, day] = String(d).split('-'); return `${y}.${MONTHS[Number(m) - 1]}.${day}`; };

async function call(method, url, body) {
  const res = await fetch(`/api/online-tasks${url}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function Circle({ done, disabled, onClick }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={done ? 'Mark as not done' : 'Mark as done'}
      style={{
        width: 34, height: 34, borderRadius: '50%', flex: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0,
        border: done ? 'none' : '2px solid #c9cccf', background: done ? '#29845a' : '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1,
      }}>
      {done && (
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 10.5l4 4 8-9" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

function TaskCard({ task, done, editing, selected, onSelect, onToggle, busy }) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, minWidth: 0 }}>
      {editing && !done && (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Checkbox label="" labelHidden checked={selected} onChange={onSelect} />
        </div>
      )}
      <div style={{
        flex: 1, minWidth: 0, minHeight: 96, borderRadius: 12, padding: '14px 16px',
        background: done ? '#ebebeb' : '#fff', border: '1px solid #e1e3e5',
        boxShadow: done ? 'none' : '0 1px 0 rgba(0,0,0,0.05)', display: 'flex', gap: 12, alignItems: 'center',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            {!done && <span style={{ width: 12, height: 12, borderRadius: '50%', background: dotColor(task), flex: 'none' }} />}
            <span style={{ fontWeight: 650, fontSize: 14, color: done ? '#616161' : '#303030', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.name}</span>
            {task.link && (
              <a href={task.link} target="_blank" rel="noreferrer" title={task.link} style={{ color: '#616161', flex: 'none', lineHeight: 0 }}>
                <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M6 14L14 6M8 6h6v6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            )}
          </InlineStack>
          {task.description && (
            <div style={{ marginTop: 6, fontSize: 13, color: done ? '#8a8a8a' : '#616161', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{task.description}</div>
          )}
        </div>
        <Circle done={done} disabled={editing || busy} onClick={onToggle} />
      </div>
    </div>
  );
}

const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 };

function AddTaskModal({ open, onClose, onAdded }) {
  const empty = { type: 'temp', priority: 'normal', name: '', link: '', description: '' };
  const [f, setF] = useState(empty);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setF(empty); setErr(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async () => {
    setSaving(true);
    setErr('');
    try {
      await call('POST', '/', f);
      onAdded();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add task"
      primaryAction={{ content: 'Add', onAction: add, loading: saving, disabled: !f.name.trim() }}
      secondaryActions={[{ content: 'Discard', onAction: onClose }]}>
      <Modal.Section>
        <BlockStack gap="300">
          {err && <Banner tone="critical" onDismiss={() => setErr('')}>{err}</Banner>}
          <InlineStack gap="300" blockAlign="end">
            <div style={{ width: 160 }}>
              <Select label="Type" options={[{ label: 'Temp', value: 'temp' }, { label: 'Regular', value: 'regular' }]}
                value={f.type} onChange={(v) => setF({ ...f, type: v })} />
            </div>
            {f.type === 'temp' && (
              <InlineStack gap="200" blockAlign="end">
                <div style={{ width: 160 }}>
                  <Select label="Priority" options={[{ label: 'Normal', value: 'normal' }, { label: 'Urgent', value: 'urgent' }]}
                    value={f.priority} onChange={(v) => setF({ ...f, priority: v })} />
                </div>
                <span style={{ width: 14, height: 14, borderRadius: '50%', marginBottom: 9, background: f.priority === 'urgent' ? DOT.urgent : DOT.normal }} />
              </InlineStack>
            )}
          </InlineStack>
          <InlineStack gap="300" wrap>
            <div style={{ flex: 1, minWidth: 220 }}><TextField label="Task name" value={f.name} onChange={(v) => setF({ ...f, name: v })} autoComplete="off" /></div>
            <div style={{ flex: 1, minWidth: 220 }}><TextField label="Link" value={f.link} onChange={(v) => setF({ ...f, link: v })} autoComplete="off" placeholder="https://… (optional)" /></div>
          </InlineStack>
          <TextField label="Description" value={f.description} onChange={(v) => setF({ ...f, description: v })} multiline={4} autoComplete="off" />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function HistoryModal({ open, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setRows(null);
    call('GET', '/history').then(d => setRows(d.history)).catch(e => { setErr(e.message); setRows([]); });
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Task history — last 30 working days" size="large">
      <Modal.Section>
        {err && <Banner tone="critical">{err}</Banner>}
        {!rows ? <Text tone="subdued">Loading...</Text> : (
          <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                {rows.map(r => (
                  <tr key={r.day}>
                    <td style={{ padding: '10px 16px 10px 0', color: '#8a8a8a', whiteSpace: 'nowrap', verticalAlign: 'top', fontSize: 14 }}>{fmtDay(r.day)}</td>
                    <td style={{ padding: '10px 0', fontSize: 14, verticalAlign: 'top' }}>
                      {r.items.length === 0 ? "All tasks' done." : r.items.map((it, i) => (
                        <span key={i}>
                          {it.urgent && <span style={{ color: '#d72c0d' }}>[Urgent]</span>}{it.name} NOT done{i < r.items.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !err && <tr><td><Text tone="subdued">No record yet. A record is written every working day at 23:00.</Text></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Modal.Section>
    </Modal>
  );
}

function OnlineDashboard() {
  const [data, setData] = useState(null);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);       // not-done tasks in edit mode (order preview)
  const [deleted, setDeleted] = useState([]);   // ids deleted in edit mode
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await call('GET', '/'));
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (task, done) => {
    setBusy(task.id);
    // Move the card right away; the server confirms.
    setData(d => {
      const all = [...d.open, ...d.done].map(t => (t.id === task.id ? { ...t, done, doneAt: done ? new Date().toISOString() : null } : t));
      return { ...d, open: all.filter(t => !t.done).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id), done: all.filter(t => t.done).sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt)) };
    });
    try {
      await call('POST', `/${task.id}/done`, { done });
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setBusy(null);
      load();
    }
  };

  const startEdit = () => { setDraft(data.open); setDeleted([]); setSelected([]); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setDraft([]); setDeleted([]); setSelected([]); };
  const moveToTop = () => {
    const top = draft.filter(t => selected.includes(t.id));
    setDraft([...top, ...draft.filter(t => !selected.includes(t.id))]);
    setSelected([]);
  };
  const removeSelected = () => {
    const names = draft.filter(t => selected.includes(t.id));
    const regular = names.filter(t => t.type === 'regular');
    if (regular.length && !window.confirm(`Delete ${regular.length} regular task(s) for good? (${regular.map(t => t.name).join(', ')}) — they will not come back tomorrow. Nothing is deleted until you press Save.`)) return;
    setDeleted(d => [...d, ...selected]);
    setDraft(draft.filter(t => !selected.includes(t.id)));
    setSelected([]);
  };
  const saveEdit = async () => {
    setSaving(true);
    try {
      await call('POST', '/edit', { order: draft.map(t => t.id), deleted });
      cancelEdit();
      await load();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const openList = editing ? draft : (data ? data.open : []);
  const actions = editing
    ? [
      { content: 'Move to Top', onAction: moveToTop, disabled: !selected.length },
      { content: 'Delete', onAction: removeSelected, disabled: !selected.length, destructive: true },
      { content: 'Cancel', onAction: cancelEdit },
    ]
    : [
      { content: 'Edit', onAction: startEdit, disabled: !data || !data.open.length },
      { content: 'Task history', onAction: () => setHistory(true) },
    ];

  return (
    <Page
      primaryAction={editing ? { content: 'Save', onAction: saveEdit, loading: saving } : { content: 'Add task', onAction: () => setAdding(true) }}
      secondaryActions={actions}
    >
      <BlockStack gap="400">
        {banner && <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>}
        {editing && <Banner tone="info">Edit mode: select tasks, then Move to Top or Delete. Nothing changes until you press Save; Cancel discards everything.</Banner>}
        {!data ? <InlineStack align="center"><Text tone="subdued">Loading...</Text></InlineStack> : (
          <>
            <div style={GRID}>
              {openList.map(t => (
                <TaskCard key={t.id} task={t} done={false} editing={editing} busy={busy === t.id}
                  selected={selected.includes(t.id)}
                  onSelect={() => setSelected(s => (s.includes(t.id) ? s.filter(x => x !== t.id) : [...s, t.id]))}
                  onToggle={() => toggle(t, true)} />
              ))}
            </div>
            {openList.length === 0 && <Text tone="subdued" alignment="center">{data.done.length ? 'All tasks done for today.' : 'No task yet — use Add task.'}</Text>}
            <div style={{ borderTop: '1px solid #d4d4d4', margin: '8px 0' }} />
            <div style={GRID}>
              {data.done.map(t => (
                <TaskCard key={t.id} task={t} done editing={editing} busy={busy === t.id} onToggle={() => toggle(t, false)} />
              ))}
            </div>
          </>
        )}
      </BlockStack>
      <AddTaskModal open={adding} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />
      <HistoryModal open={history} onClose={() => setHistory(false)} />
    </Page>
  );
}

export default OnlineDashboard;
