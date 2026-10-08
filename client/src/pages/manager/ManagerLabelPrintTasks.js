import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, EmptyState, Modal, TextField,
  DataTable, Checkbox,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MobileModalSafeArea from '../../components/MobileModalSafeArea';
// Store location: remembered per Shopify account, loaded before this page
// renders by ManagerLocationGate (2026-09-29) — replaces reading
// localStorage 'managerLocation' directly. See client/src/accountMemory.js.
import { getManagerLocation } from '../../accountMemory';
// Task type dot + WIG part (2026-10-08, Hera) — spec:
// claude/PRICE_CHANGE_SCHEDULE_REVERSE_SPEC.md
import { TaskTypeLabel } from '../shared/priceChangeShared';

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ManagerLabelPrintTasks() {
  const navigate = useNavigate();
  const location = getManagerLocation() || '';

  const [tasks, setTasks]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [showNew, setShowNew]       = useState(false);
  const [newName, setNewName]       = useState('');
  const [creating, setCreating]     = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [deleteLoading, setDeleteLoading]     = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteAll, setDeleteAll]   = useState(false);

  const [priceTasks, setPriceTasks]       = useState([]);
  const [priceLoading, setPriceLoading]   = useState(true);
  // Track which price task IDs are currently being marked done (for loading state)
  const [doneLoadingIds, setDoneLoadingIds] = useState([]);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = location ? `?location=${encodeURIComponent(location)}` : '';
      const res = await fetch(`/api/label-print-tasks${params}`);
      if (!res.ok) throw new Error('Failed to load tasks');
      setTasks(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [location]);

  const fetchPriceTasks = useCallback(async () => {
    if (!location) { setPriceLoading(false); return; }
    setPriceLoading(true);
    try {
      const res = await fetch(`/api/price-change-tasks/manager?location=${encodeURIComponent(location)}`);
      if (!res.ok) throw new Error('Failed to load price change tasks');
      setPriceTasks(await res.json());
    } catch (e) {
      // silent fail
    } finally {
      setPriceLoading(false);
    }
  }, [location]);

  useEffect(() => { fetchTasks(); fetchPriceTasks(); }, [fetchTasks, fetchPriceTasks]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/label-print-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), location }),
      });
      if (!res.ok) throw new Error('Failed to create task');
      const created = await res.json();
      setShowNew(false);
      setNewName('');
      navigate(`/manager/label-print/${created.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteSelected = async () => {
    setDeleteLoading(true);
    try {
      const ids = deleteAll ? tasks.map(t => t.id) : selectedIds;
      await fetch('/api/label-print-tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      setSelectedIds([]);
      setShowDeleteConfirm(false);
      setDeleteAll(false);
      fetchTasks();
    } catch (e) {
      setError('Failed to delete tasks.');
    } finally {
      setDeleteLoading(false);
    }
  };

  // part (2026-10-08): 'main' or 'wig' — the WIG part of a task is Done on its own.
  const handleMarkDone = async (taskId, part = 'main') => {
    const key = `${taskId}:${part}`;
    setDoneLoadingIds(prev => [...prev, key]);
    try {
      const res = await fetch(`/api/price-change-tasks/${taskId}/done`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, part }),
      });
      if (!res.ok) throw new Error('Failed to mark as done');
      // Update local state so button immediately becomes "Done" text
      setPriceTasks(prev =>
        prev.map(t => t.id === taskId && (t.part || 'main') === part ? { ...t, location_status: 'done' } : t)
      );
    } catch (e) {
      setError('Failed to mark task as done.');
    } finally {
      setDoneLoadingIds(prev => prev.filter(id => id !== key));
    }
  };

  // Rows come per task part; group them: main row + optional "└ WIG" branch.
  // A task with only WIG items is one row with WIG in red bold (Hera 2026-10-08).
  const priceGroups = [];
  {
    const byId = new Map();
    for (const t of priceTasks) {
      if (!byId.has(t.id)) { byId.set(t.id, { id: t.id, main: null, wig: null }); priceGroups.push(byId.get(t.id)); }
      byId.get(t.id)[(t.part || 'main') === 'wig' ? 'wig' : 'main'] = t;
    }
  }
  const doneCell = (t) => {
    const part = t.part || 'main';
    if (t.location_status === 'done') return <Text tone="success" fontWeight="medium">Done</Text>;
    return (
      <Button size="slim" tone="success" loading={doneLoadingIds.includes(`${t.id}:${part}`)} onClick={() => handleMarkDone(t.id, part)}>
        Done
      </Button>
    );
  };
  const typesText = (t) => ((t.item_types || []).filter(Boolean).join(', ') || '-');
  const priceRows = [];
  for (const g of priceGroups) {
    const head = g.main || g.wig;
    const onlyWig = !g.main && !!g.wig;
    const mainUrl = `/manager/price-change/${g.id}${onlyWig ? '?part=wig' : g.wig ? '?part=main' : ''}`;
    priceRows.push([
      <Button variant="plain" onClick={() => navigate(mainUrl)}>{head.task_no}</Button>,
      <TaskTypeLabel type={head.task_type} fallback={head.label_type || 'Regular price'} />,
      onlyWig ? <span style={{ color: '#d72c0d', fontWeight: 700 }}>WIG</span> : typesText(head),
      String(head.item_count || 0),
      formatDate(head.published_at || head.created_at),
      head.note || '-',
      doneCell(head),
    ]);
    if (g.main && g.wig) {
      priceRows.push([
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: 8 }}>
          <span style={{ color: '#6d7175' }}>└</span>
          <Button variant="plain" onClick={() => navigate(`/manager/price-change/${g.id}?part=wig`)}>WIG</Button>
        </span>,
        '', '', String(g.wig.item_count || 0), '', '',
        doneCell(g.wig),
      ]);
    }
  }

  const toggleSelect = (id) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const allSelected = tasks.length > 0 && selectedIds.length === tasks.length;
  const toggleAll = () => setSelectedIds(allSelected ? [] : tasks.map(t => t.id));

  return (
    <Page
      // Plain title, no location suffix (2026-09-24, Hera).
      title="Label print tasks"
      backAction={{ onAction: () => navigate('/manager') }}
      primaryAction={{ content: 'New task', onAction: () => setShowNew(true) }}
      secondaryActions={[
        ...(selectedIds.length > 0 ? [{
          content: `Delete selected (${selectedIds.length})`,
          destructive: true,
          onAction: () => { setDeleteAll(false); setShowDeleteConfirm(true); },
        }] : []),
        ...(tasks.length > 0 ? [{
          content: 'Delete all',
          destructive: true,
          onAction: () => { setDeleteAll(true); setShowDeleteConfirm(true); },
        }] : []),
      ]}
    >
      <Layout>
        <Layout.Section>
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

          {/* ── Manager-created label print tasks ── */}
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
              <Spinner />
            </div>
          ) : tasks.length === 0 ? (
            <EmptyState
              heading="No print tasks yet"
              action={{ content: 'Create first task', onAction: () => setShowNew(true) }}
              image=""
            >
              <p>Create a task, scan products, then print labels.</p>
            </EmptyState>
          ) : (
            <Card padding="0">
              <DataTable
                columnContentTypes={['text', 'text', 'text', 'text']}
                headings={[
                  <Checkbox label="" labelHidden checked={allSelected} onChange={toggleAll} />,
                  'Task name', 'Items', 'Created',
                ]}
                rows={tasks.map(t => [
                  <Checkbox
                    label="" labelHidden
                    checked={selectedIds.includes(t.id)}
                    onChange={() => toggleSelect(t.id)}
                  />,
                  <Button variant="plain" onClick={() => navigate(`/manager/label-print/${t.id}`)}>
                    {t.name}
                  </Button>,
                  t.item_count || 0,
                  formatDate(t.created_at),
                ])}
              />
            </Card>
          )}

          {/* ── Price change tasks (from buyer) ── */}
          <div style={{ marginTop: '24px' }}>
            <BlockStack gap="300">
              <Text variant="headingSm">Price Change Tasks</Text>
              {priceLoading ? (
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '24px' }}>
                    <Spinner size="small" />
                  </div>
                </Card>
              ) : priceTasks.length === 0 ? (
                <Card>
                  <Text tone="subdued" alignment="center">No price change tasks assigned to this location.</Text>
                </Card>
              ) : (
                <Card padding="0">
                  <DataTable
                    columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text', 'text']}
                    headings={['Task', 'Task type', 'Types', 'Items', 'Published', 'Note', '']}
                    rows={priceRows}
                  />
                </Card>
              )}
            </BlockStack>
          </div>
        </Layout.Section>
      </Layout>

      {/* Lift the Polaris modals above Shopify's Android bottom buttons (2026-09-24) */}
      <MobileModalSafeArea />

      {/* New task modal */}
      <Modal
        open={showNew}
        onClose={() => { setShowNew(false); setNewName(''); }}
        title="New print task"
        primaryAction={{ content: 'Create', onAction: handleCreate, loading: creating, disabled: !newName.trim() }}
        secondaryActions={[{ content: 'Cancel', onAction: () => { setShowNew(false); setNewName(''); } }]}
      >
        <Modal.Section>
          <TextField
            label="Task name"
            value={newName}
            onChange={setNewName}
            onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) handleCreate(); }}
            placeholder="e.g. Restock labels Mar 31"
            autoComplete="off"
            autoFocus
          />
        </Modal.Section>
      </Modal>

      {/* Delete confirm modal */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => { setShowDeleteConfirm(false); setDeleteAll(false); }}
        title={deleteAll ? 'Delete all tasks' : 'Delete tasks'}
        primaryAction={{ content: 'Delete', destructive: true, onAction: handleDeleteSelected, loading: deleteLoading }}
        secondaryActions={[{ content: 'Cancel', onAction: () => { setShowDeleteConfirm(false); setDeleteAll(false); } }]}
      >
        <Modal.Section>
          <Text>
            {deleteAll
              ? `Delete all ${tasks.length} task${tasks.length > 1 ? 's' : ''} for ${location || 'this location'}? This cannot be undone.`
              : `Delete ${selectedIds.length} selected task${selectedIds.length > 1 ? 's' : ''}? This cannot be undone.`
            }
          </Text>
        </Modal.Section>
      </Modal>
      {/* Bottom safe area (2026-09-24, Hera): keeps the last content above
          Shopify's native bottom buttons on Android; same 80px spacer as the
          other manager pages, on every device. */}
      <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} aria-hidden="true" />
    </Page>
  );
}

export default ManagerLabelPrintTasks;