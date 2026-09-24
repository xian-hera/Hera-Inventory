import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, Text, Banner, Spinner, EmptyState, Modal, TextField,
  DataTable, Checkbox, BlockStack,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

// Restock tasks (2026-09-24, Hera) — a layer above the Restock page, modeled
// on ManagerLabelPrintTasks.js. Several managers at the same location can
// each keep their own restock list: New task (name + optional creator),
// tap a task name to open it (ManagerRestockPlan.js, unchanged behavior),
// select tasks to delete. Tasks never expire; managers delete them here.
function ManagerRestockTasks() {
  const navigate = useNavigate();
  const location = localStorage.getItem('managerLocation') || '';

  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCreator, setNewCreator] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchTasks = useCallback(async () => {
    if (!location) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/reports/restock-tasks?location=${encodeURIComponent(location)}`);
      const data = await res.json();
      if (!res.ok || !Array.isArray(data)) throw new Error((data && data.error) || 'Failed to load tasks');
      setTasks(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [location]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const closeNew = () => { setShowNew(false); setNewName(''); setNewCreator(''); };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/reports/restock-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, name: newName.trim(), creator: newCreator.trim() }),
      });
      const created = await res.json();
      if (!res.ok) throw new Error(created.error || 'Failed to create task');
      closeNew();
      navigate(`/manager/restock-plan/${created.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    setDeleteLoading(true);
    try {
      const res = await fetch('/api/reports/restock-tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      if (!res.ok) throw new Error('Failed to delete tasks.');
      setSelectedIds([]);
      setShowDeleteConfirm(false);
      fetchTasks();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  const toggleSelect = (id) => setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const allSelected = tasks.length > 0 && selectedIds.length === tasks.length;
  const toggleAll = () => setSelectedIds(allSelected ? [] : tasks.map(t => t.id));

  return (
    <Page
      title={`Restock${location ? ` — ${location}` : ''}`}
      backAction={{ onAction: () => navigate('/manager') }}
      primaryAction={{ content: 'New task', onAction: () => setShowNew(true), disabled: !location }}
      secondaryActions={selectedIds.length > 0 ? [{
        content: `Delete selected (${selectedIds.length})`,
        destructive: true,
        onAction: () => setShowDeleteConfirm(true),
      }] : []}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
            {!location && <Banner tone="warning">Select your location on the Store home page first.</Banner>}
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner /></div>
            ) : tasks.length === 0 ? (
              <EmptyState
                heading="No restock tasks yet"
                action={location ? { content: 'Create first task', onAction: () => setShowNew(true) } : undefined}
                image=""
              >
                <p>Create a task, scan the products that need restocking, then pick them from the stock room.</p>
              </EmptyState>
            ) : (
              <Card padding="0">
                <DataTable
                  columnContentTypes={['text', 'text', 'numeric', 'text']}
                  headings={[
                    <Checkbox label="" labelHidden checked={allSelected} onChange={toggleAll} />,
                    'Name', 'Line items', 'Creator',
                  ]}
                  rows={tasks.map(t => [
                    <Checkbox label="" labelHidden checked={selectedIds.includes(t.id)} onChange={() => toggleSelect(t.id)} />,
                    <Button variant="plain" onClick={() => navigate(`/manager/restock-plan/${t.id}`)}>{t.name}</Button>,
                    t.item_count || 0,
                    t.creator || '',
                  ])}
                />
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={showNew}
        onClose={closeNew}
        title="New restock task"
        primaryAction={{ content: 'Create', onAction: handleCreate, loading: creating, disabled: !newName.trim() }}
        secondaryActions={[{ content: 'Cancel', onAction: closeNew }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField label="Task name" value={newName} onChange={setNewName} autoComplete="off" autoFocus
              placeholder="e.g. Shampoo aisle" />
            <TextField label="Creator name (optional)" value={newCreator} onChange={setNewCreator} autoComplete="off"
              onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) handleCreate(); }} />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Delete tasks"
        primaryAction={{ content: 'Delete', destructive: true, onAction: handleDelete, loading: deleteLoading }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setShowDeleteConfirm(false) }]}
      >
        <Modal.Section>
          <Text>Delete {selectedIds.length} selected task{selectedIds.length > 1 ? 's' : ''} and all their items? This cannot be undone.</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default ManagerRestockTasks;
