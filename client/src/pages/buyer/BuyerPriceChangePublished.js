import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, DataTable, Checkbox, Badge
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function BuyerPriceChangePublished() {
  const navigate = useNavigate();
  const [tasks, setTasks]           = useState([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [selectedIds, setSelectedIds] = useState([]);

  // Item detail popup
  const [detailTask, setDetailTask]   = useState(null);
  const [detailItems, setDetailItems] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/price-change-tasks');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTasks(data);
    } catch (e) {
      setError('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const handleDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedIds.length} task(s)?`)) return;
    await fetch('/api/price-change-tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds }),
    });
    setSelectedIds([]);
    fetchTasks();
  };

  const handleDeleteAll = async () => {
    if (!window.confirm('Delete all tasks?')) return;
    const ids = tasks.map(t => t.id);
    await fetch('/api/price-change-tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    setSelectedIds([]);
    fetchTasks();
  };

  const handleArchive = async () => {
    if (selectedIds.length === 0) return;
    await fetch('/api/price-change-tasks/archive', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds }),
    });
    setSelectedIds([]);
    fetchTasks();
  };

  const openDetail = async (task) => {
    setDetailTask(task);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/price-change-tasks/${task.id}/items`);
      const data = await res.json();
      setDetailItems(data);
    } catch (e) {
      setDetailItems([]);
    } finally {
      setDetailLoading(false);
    }
  };

  const toggleSelectOne = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleSelectAll = () => {
    setSelectedIds(selectedIds.length === tasks.length ? [] : tasks.map(t => t.id));
  };

  const rows = tasks.map(task => {
    const unfinished = task.unfinished_locations?.filter(Boolean) || [];
    return [
      <Checkbox checked={selectedIds.includes(task.id)} onChange={() => toggleSelectOne(task.id)} />,
      <Button variant="plain" onClick={() => openDetail(task)}>{task.task_no}</Button>,
      String(task.item_count || 0),
      unfinished.length > 0
        ? <div style={{ fontSize: '13px', color: '#d72c0d' }}>{unfinished.join(', ')}</div>
        : <Badge tone="success">All done</Badge>,
    ];
  });

  return (
    <Page
      title="Published Tasks"
      backAction={{ onAction: () => navigate('/buyer/price-change') }}
      secondaryActions={[
        { content: 'Delete selected', destructive: true, disabled: selectedIds.length === 0, onAction: handleDelete },
        { content: 'Delete all', destructive: true, disabled: tasks.length === 0, onAction: handleDeleteAll },
        { content: 'Archive selected', disabled: selectedIds.length === 0, onAction: handleArchive },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              {loading ? <Spinner /> : (
                <DataTable
                  columnContentTypes={['text','text','text','text']}
                  headings={[
                    <Checkbox
                      checked={selectedIds.length === tasks.length && tasks.length > 0}
                      indeterminate={selectedIds.length > 0 && selectedIds.length < tasks.length}
                      onChange={toggleSelectAll}
                    />,
                    'Task', 'Items', 'Unfinished stores',
                  ]}
                  rows={rows}
                />
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Item detail popup */}
      {detailTask && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
        }}>
          <div style={{
            background: 'white', borderRadius: '12px', padding: '24px',
            width: '100%', maxWidth: '680px', maxHeight: '80vh', overflowY: 'auto',
          }}>
            <InlineStack align="space-between">
              <Text variant="headingMd" fontWeight="bold">Task {detailTask.task_no}</Text>
              <button onClick={() => setDetailTask(null)} style={{
                background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
              }}>✕</button>
            </InlineStack>

            {detailTask.note && (
              <Text tone="subdued" variant="bodySm">{detailTask.note}</Text>
            )}

            <div style={{ marginTop: '16px' }}>
              {detailLoading ? <Spinner /> : (
                <DataTable
                  columnContentTypes={['text','text','text']}
                  headings={['SKU', 'Name', 'Price']}
                  rows={detailItems.map(item => [
                    item.sku,
                    item.name || '-',
                    item.price ? `$${item.price}` : '-',
                  ])}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

export default BuyerPriceChangePublished;