// Price Change › Scheduled Tasks card + its task modal (2026-10-08, Hera).
// Spec: claude/PRICE_CHANGE_SCHEDULE_REVERSE_SPEC.md
// Lists tasks not yet published: scheduled (waiting for their time),
// applying, applied (published to stores 10 minutes after the change) and
// failed. A reverse is its own scheduled task ("Reverse of 000123").
import React, { useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import {
  Card, BlockStack, InlineStack, Text, Button, Banner, DataTable, Checkbox, TextField, Select,
} from '@shopify/polaris';
import {
  TASK_TYPES, TaskTypeLabel, excludedText, formatToronto, torontoParts, money,
} from '../../shared/priceChangeShared';

const LOOP = '↻';
const typeOptions = [{ label: 'Choose', value: '' }, ...TASK_TYPES.map(t => ({ label: t.label, value: t.value }))];

async function postJson(url, body, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Request failed');
  return d;
}

function StatusLine({ t }) {
  if (t.status === 'applying') return <Text variant="bodySm" tone="subdued">Changing prices…</Text>;
  if (t.status === 'applied') return <Text variant="bodySm" tone="subdued">Changed — publishing to stores at {formatToronto(t.publish_at).slice(-5)}</Text>;
  if (t.status === 'failed') return <Text variant="bodySm" tone="critical">Failed: {t.error || 'nothing was changed'}</Text>;
  if (t.error) return <Text variant="bodySm" tone="critical">Last try failed: {t.error} — retrying</Text>;
  return null;
}

// ─── Modal ──────────────────────────────────────────────────────────────────
export function ScheduledTaskModal({ taskId, locationNames, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [edit, setEdit] = useState(null); // { field, date, time, taskType }

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch(`/api/price-change-tasks/${taskId}/detail`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Load failed');
      setData(d);
    } catch (e) { setError(e.message); }
  }, [taskId]);
  useEffect(() => { load(); }, [load]);

  const t = data && data.task;
  const editable = t && t.status === 'scheduled';
  const when = t ? torontoParts(t.scheduled_at) : {};
  const rev = t && t.reverse_at ? torontoParts(t.reverse_at) : null;

  const run = async (key, fn, close = false) => {
    setBusy(key); setError('');
    try {
      await fn();
      onChanged && onChanged();
      if (close) onClose(); else { setEdit(null); await load(); }
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const saveEdit = () => run('edit', () => {
    if (edit.field === 'date' || edit.field === 'time') {
      return postJson(`/api/price-change-tasks/${t.id}/schedule`, { when: { date: edit.date, time: edit.time } }, 'PATCH');
    }
    return postJson(`/api/price-change-tasks/${t.id}/schedule`, { reverse: { date: edit.date, time: edit.time, taskType: edit.taskType } }, 'PATCH');
  });

  const Edit = ({ field, children }) => (editable ? (
    <InlineStack gap="100" blockAlign="center">
      <span>{children}</span>
      <Button variant="plain" onClick={() => {
        const base = field.startsWith('rev') ? (rev || { date: '', time: '' }) : when;
        setEdit({ field, date: base.date, time: base.time, taskType: t.reverse_task_type || '' });
      }}>Edit</Button>
    </InlineStack>
  ) : <span>{children}</span>);

  const editor = edit && (
    <InlineStack gap="200" blockAlign="end" wrap>
      {(edit.field === 'date' || edit.field === 'revDate' || edit.field === 'addRev') && (
        <div style={{ width: 170 }}><TextField label="Date" type="date" value={edit.date} onChange={v => setEdit(e => ({ ...e, date: v }))} autoComplete="off" /></div>
      )}
      {(edit.field === 'time' || edit.field === 'revTime' || edit.field === 'addRev') && (
        <div style={{ width: 130 }}><TextField label="Time (Eastern)" type="time" value={edit.time} onChange={v => setEdit(e => ({ ...e, time: v }))} autoComplete="off" /></div>
      )}
      {(edit.field === 'revType' || edit.field === 'addRev') && (
        <div style={{ width: 200 }}><Select label="Stores see it as" options={typeOptions} value={edit.taskType} onChange={v => setEdit(e => ({ ...e, taskType: v }))} /></div>
      )}
      <Button onClick={() => setEdit(null)}>Cancel</Button>
      <Button variant="primary" loading={busy === 'edit'} disabled={!edit.date || !edit.time || (edit.field.startsWith('rev') || edit.field === 'addRev' ? !edit.taskType : false)} onClick={saveEdit}>Save</Button>
    </InlineStack>
  );

  // Portal: rendered inside a Card, the overlay was painted under the
  // cards that follow it.
  return ReactDOM.createPortal((
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
    }}>
      <div style={{ background: 'white', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '820px', maxHeight: '85vh', overflowY: 'auto' }}>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap={false}>
            <InlineStack gap="300" blockAlign="center">
              <Text variant="headingMd" fontWeight="bold">{t ? t.task_no : 'Task'}</Text>
              {t && <span style={{ background: '#f1f2f3', borderRadius: 12, padding: '2px 10px', fontSize: 13 }}><TaskTypeLabel type={t.task_type} /></span>}
              {t && t.reverse_of_no && <Text tone="subdued">Reverse of {t.reverse_of_no}</Text>}
              {editable && (
                <>
                  <Button tone="critical" variant="primary" loading={busy === 'delete'}
                    onClick={() => { if (window.confirm(`Delete task ${t.task_no}? Nothing has been changed in Shopify yet.`)) run('delete', () => postJson('/api/price-change-tasks/scheduled/delete', { ids: [t.id] }), true); }}>
                    Delete
                  </Button>
                  <Button variant="primary" loading={busy === 'now'}
                    onClick={() => run('now', () => postJson('/api/price-change-tasks/publish-now', { ids: [t.id] }), true)}>
                    Publish now
                  </Button>
                </>
              )}
            </InlineStack>
            <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer' }}>✕</button>
          </InlineStack>
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
          {!t && !error && <Text tone="subdued">Loading...</Text>}
          {t && (
            <>
              <InlineStack gap="600">
                <Text>{(t.product_types || []).join(', ')}</Text>
                <Text>{excludedText(t.locations, locationNames)}</Text>
              </InlineStack>
              <InlineStack gap="800" blockAlign="center" wrap>
                <InlineStack gap="400" blockAlign="center">
                  <Edit field="date">{when.date}</Edit>
                  <Edit field="time">{when.time}</Edit>
                </InlineStack>
                {!t.reverse_of && (rev ? (
                  <InlineStack gap="300" blockAlign="center">
                    <Text>{LOOP} Reverse</Text>
                    <Edit field="revDate">{rev.date}</Edit>
                    <Edit field="revTime">{rev.time}</Edit>
                    <Edit field="revType"><span style={{ color: '#6d7175' }}>Stores see: </span><TaskTypeLabel type={t.reverse_task_type} /></Edit>
                    {editable && (
                      <button type="button" aria-label="Remove reverse" title="Remove reverse"
                        onClick={() => run('rmrev', () => postJson(`/api/price-change-tasks/${t.id}/schedule`, { reverse: null }, 'PATCH'))}
                        style={{ border: 'none', background: 'none', color: '#d72c0d', fontWeight: 700, fontSize: 18, cursor: 'pointer' }}>✕</button>
                    )}
                  </InlineStack>
                ) : editable && (
                  <Button variant="plain" onClick={() => setEdit({ field: 'addRev', date: '', time: '', taskType: '' })}>Add reverse</Button>
                ))}
              </InlineStack>
              {editor}
              {t.note && <Text tone="subdued">{t.note}</Text>}
              {t.status !== 'scheduled' && <StatusLine t={t} />}
              <DataTable
                columnContentTypes={['text', 'text', 'text', 'text']}
                headings={['SKU', 'Name', 'Type', t.reverse_of ? 'Restores' : 'New price']}
                rows={data.items.map(it => [
                  it.sku,
                  it.name || '-',
                  it.product_type || '',
                  t.reverse_of ? 'Values before the price change'
                    : it.apply_status === 'done' ? `${money(it.old_price)} → ${money(it.new_price)}`
                      : it.csv_price ? money(it.csv_price) : (it.rule_text || 'Rule'),
                ])}
              />
            </>
          )}
        </BlockStack>
      </div>
    </div>
  ), document.body);
}

// ─── Card ───────────────────────────────────────────────────────────────────
export default function ScheduledTasksCard({ locationNames, version, onChanged }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState('');
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/price-change-tasks/scheduled');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Load failed');
      setTasks(d);
      setSelected(sel => sel.filter(id => d.some(t => t.id === id)));
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load, version]);
  // Tasks change state on their own (applied, published) — refresh each minute.
  useEffect(() => { const h = setInterval(load, 60000); return () => clearInterval(h); }, [load]);

  const selectable = tasks.filter(t => t.status === 'scheduled' || t.status === 'failed');
  const toggle = (id) => setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
  const act = async (key, fn) => {
    setBusy(key); setError('');
    try { await fn(); await load(); onChanged && onChanged(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const publishable = selected.filter(id => (tasks.find(t => t.id === id) || {}).status === 'scheduled');

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingMd" fontWeight="bold">Scheduled Tasks</Text>
          <InlineStack gap="200">
            <Button tone="critical" variant="primary" disabled={!selected.length} loading={busy === 'delete'}
              onClick={() => { if (window.confirm(`Delete ${selected.length} task(s)? Nothing has been changed in Shopify for them.`)) act('delete', () => postJson('/api/price-change-tasks/scheduled/delete', { ids: selected })); }}>
              Delete Selected
            </Button>
            <Button variant="primary" disabled={!publishable.length} loading={busy === 'now'}
              onClick={() => act('now', () => postJson('/api/price-change-tasks/publish-now', { ids: publishable }))}>
              Publish Selected Now
            </Button>
          </InlineStack>
        </InlineStack>
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {loading ? <Text tone="subdued">Loading...</Text> : tasks.length === 0 ? (
          <Text tone="subdued">No scheduled tasks.</Text>
        ) : (
          <DataTable
            columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text', 'text']}
            headings={[
              <Checkbox label="" labelHidden checked={selectable.length > 0 && selected.length === selectable.length}
                onChange={() => setSelected(selected.length === selectable.length ? [] : selectable.map(t => t.id))} />,
              'Task', 'Price type', 'Types', 'Items', 'Date & Time', 'Locations',
            ]}
            rows={tasks.map(t => [
              (t.status === 'scheduled' || t.status === 'failed')
                ? <Checkbox label="" labelHidden checked={selected.includes(t.id)} onChange={() => toggle(t.id)} /> : '',
              <BlockStack gap="050" inlineAlign="start">
                <Button variant="plain" onClick={() => setOpenId(t.id)}>{t.task_no}</Button>
                {t.reverse_of_no && <Text variant="bodySm" tone="subdued">Reverse of {t.reverse_of_no}</Text>}
                <StatusLine t={t} />
              </BlockStack>,
              <TaskTypeLabel type={t.task_type} />,
              (t.product_types || []).join(', '),
              String(t.item_count || 0),
              <span>{formatToronto(t.scheduled_at)}{t.reverse_at ? <span title={`Reverse ${formatToronto(t.reverse_at)}`}> {LOOP}</span> : ''}</span>,
              excludedText(t.locations, locationNames),
            ])}
          />
        )}
      </BlockStack>
      {openId && (
        <ScheduledTaskModal
          taskId={openId}
          locationNames={locationNames}
          onClose={() => setOpenId(null)}
          onChanged={() => { load(); onChanged && onChanged(); }}
        />
      )}
    </Card>
  );
}

