import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, EmptyState, Modal, TextField,
  DataTable, Checkbox,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ManagerLabelPrintTasks() {
  const navigate = useNavigate();
  const location = localStorage.getItem('managerLocation') || '';

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
      // 静默失败
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

  const toggleSelect = (id) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const allSelected = tasks.length > 0 && selectedIds.length === tasks.length;
  const toggleAll = () => setSelectedIds(allSelected ? [] : tasks.map(t => t.id));

  return (
    <Page
      title={`Label print tasks${location ? ` — ${location}` : ''}`}
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
                    columnContentTypes={['text', 'text', 'text', 'text', 'text']}
                    headings={['Task', 'Type', 'Items', 'Published', 'Note']}
                    rows={priceTasks.map(t => [
                      <Button
                        variant="plain"
                        onClick={() => navigate(`/manager/price-change/${t.id}`)}
                      >
                        {t.task_no}
                      </Button>,
                      t.label_type || 'Regular price',
                      String(t.item_count || 0),
                      formatDate(t.created_at),
                      t.note || '-',
                    ])}
                  />
                </Card>
              )}
            </BlockStack>
          </div>
        </Layout.Section>
      </Layout>

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
    </Page>
  );
}

export default ManagerLabelPrintTasks;