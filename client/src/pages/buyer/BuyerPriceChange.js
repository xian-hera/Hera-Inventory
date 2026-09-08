import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, DataTable, Checkbox, TextField, Badge
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01','HQ'
];

const LABEL_TYPE_OPTIONS = [
  { value: 'Regular price', label: 'Regular price' },
  { value: 'Sale price',    label: 'Sale price' },
  { value: 'Wig',           label: 'Wig' },
];

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function BuyerPriceChange() {
  const navigate = useNavigate();
  const csvInputRef = useRef(null);

  const [selectedLocations, setSelectedLocations] = useState([...LOCATIONS]);
  const [items, setItems]           = useState([]);
  const [selectedSkus, setSelectedSkus] = useState([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [publishing, setPublishing] = useState(false);

  const [showNoteInput, setShowNoteInput] = useState(false);
  const [noteInput, setNoteInput]         = useState('');
  const [labelType, setLabelType]         = useState('Regular price');
  const [pendingPublishAll, setPendingPublishAll] = useState(false);

  // Published tasks (merged in from the former standalone "Published Tasks" page)
  const [tasks, setTasks]                 = useState([]);
  const [tasksLoading, setTasksLoading]    = useState(false);
  const [tasksError, setTasksError]        = useState('');
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);

  const [detailTask, setDetailTask]       = useState(null);
  const [detailItems, setDetailItems]     = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError('');
    try {
      const res = await fetch('/api/price-change-tasks');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTasks(data);
    } catch (e) {
      setTasksError('Failed to load tasks');
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const handleCSVUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const lines = evt.target.result.split('\n').filter(l => l.trim());

      const dataLines = lines.filter(l => {
        const cols = l.split(',').map(c => c.trim().replace(/"/g, '').toLowerCase());
        return !(cols[0] === 'sku' || cols[0] === 'name' || cols[0] === 'barcode' ||
                 cols[1] === 'sku' || cols[1] === 'name' || cols[1] === 'barcode');
      });

      if (dataLines.length === 0) { setError('No data found in CSV.'); return; }

      const sample = dataLines.slice(0, 20);
      const col0AllNumeric = sample.every(l => /^\d+$/.test(l.split(',')[0]?.trim().replace(/"/g, '') || ''));
      const col1AllNumeric = sample.every(l => /^\d+$/.test(l.split(',')[1]?.trim().replace(/"/g, '') || ''));
      const skuCol = col0AllNumeric ? 0 : col1AllNumeric ? 1 : 0;

      const skus = [...new Set(
        dataLines
          .map(l => l.split(',')[skuCol]?.trim().replace(/"/g, '') || '')
          .filter(Boolean)
      )];

      if (skus.length === 0) { setError('No SKUs found in CSV.'); return; }

      setLoading(true);
      setError('');
      setItems([]);
      setSelectedSkus([]);

      const results = [];
      const failed = [];

      for (const sku of skus) {
        try {
          const res = await fetch(`/api/shopify/variant-by-sku?sku=${encodeURIComponent(sku)}`);
          if (!res.ok) { failed.push(sku); continue; }
          const { variant, product } = await res.json();
          const customName = variant.metafields?.find(
            m => m.namespace === 'custom' && m.key === 'name'
          )?.value || product.title || '';
          results.push({
            sku: variant.sku || sku,
            name: customName,
            price: variant.price || '',
            barcode: variant.barcode || '',
            compare_at_price: variant.compare_at_price || '',
          });
        } catch {
          failed.push(sku);
        }
      }

      setItems(results);
      if (failed.length > 0) {
        setError(`${failed.length} SKU(s) not found in Shopify: ${failed.join(', ')}`);
      }
      setLoading(false);
    };
    reader.readAsText(file);
  };

  const toggleSelectOne = (sku) => {
    setSelectedSkus(prev =>
      prev.includes(sku) ? prev.filter(x => x !== sku) : [...prev, sku]
    );
  };
  const toggleSelectAll = () => {
    setSelectedSkus(selectedSkus.length === items.length ? [] : items.map(i => i.sku));
  };

  const doPublish = async (skusToPublish, note, type) => {
    if (selectedLocations.length === 0) {
      setError('Please select at least one location.');
      return;
    }
    const itemsToPublish = items.filter(i => skusToPublish.includes(i.sku));
    if (itemsToPublish.length === 0) return;

    setPublishing(true);
    setError('');
    try {
      const res = await fetch('/api/price-change-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locations: selectedLocations,
          items: itemsToPublish,
          note: note || null,
          label_type: type || 'Regular price',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(prev => prev.filter(i => !skusToPublish.includes(i.sku)));
      setSelectedSkus([]);
      fetchTasks();
    } catch (e) {
      setError(e.message);
    } finally {
      setPublishing(false);
    }
  };

  const handlePublishSelected = () => {
    if (selectedSkus.length === 0) return;
    setPendingPublishAll(false);
    setNoteInput('');
    setLabelType('Regular price');
    setShowNoteInput(true);
  };

  const handlePublishAll = () => {
    if (items.length === 0) return;
    setPendingPublishAll(true);
    setNoteInput('');
    setLabelType('Regular price');
    setShowNoteInput(true);
  };

  const handleConfirmPublish = async () => {
    const skus = pendingPublishAll ? items.map(i => i.sku) : selectedSkus;
    setShowNoteInput(false);
    await doPublish(skus, noteInput, labelType);
  };

  const rows = items.map(item => [
    <Checkbox
      checked={selectedSkus.includes(item.sku)}
      onChange={() => toggleSelectOne(item.sku)}
    />,
    item.sku,
    item.name || '-',
    item.price ? `$${item.price}` : '-',
  ]);

  // ── Published tasks (merged in from the former standalone "Published Tasks" page) ──

  const handleDeleteSelectedTasks = async () => {
    if (selectedTaskIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedTaskIds.length} task(s)?`)) return;
    await fetch('/api/price-change-tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedTaskIds }),
    });
    setSelectedTaskIds([]);
    fetchTasks();
  };

  const handleDeleteAllTasks = async () => {
    if (!window.confirm('Delete all tasks?')) return;
    const ids = tasks.map(t => t.id);
    await fetch('/api/price-change-tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    setSelectedTaskIds([]);
    fetchTasks();
  };

  const openTaskDetail = async (task) => {
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

  const toggleTaskSelectOne = (id) => {
    setSelectedTaskIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleTaskSelectAll = () => {
    setSelectedTaskIds(selectedTaskIds.length === tasks.length ? [] : tasks.map(t => t.id));
  };

  const taskRows = tasks.map(task => {
    const unfinished = task.unfinished_locations?.filter(Boolean) || [];
    return [
      <Checkbox checked={selectedTaskIds.includes(task.id)} onChange={() => toggleTaskSelectOne(task.id)} />,
      <Button variant="plain" onClick={() => openTaskDetail(task)}>{task.task_no}</Button>,
      String(task.item_count || 0),
      unfinished.length > 0
        ? <div style={{ fontSize: '13px', color: '#d72c0d' }}>{unfinished.join(', ')}</div>
        : <Badge tone="success">All done</Badge>,
    ];
  });

  return (
    <Page
      title="Price Change Task"
      backAction={{ onAction: () => navigate('/buyer') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <InlineStack gap="400" wrap align="start">
                <MultiSelectDropdown
                  label="Location"
                  options={LOCATIONS}
                  selected={selectedLocations}
                  onChange={setSelectedLocations}
                  showSelectAll={true}
                />
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued"> </Text>
                  <input
                    type="file" accept=".csv" ref={csvInputRef}
                    style={{ display: 'none' }} onChange={handleCSVUpload}
                  />
                  <Button onClick={() => csvInputRef.current.click()} loading={loading}>
                    Upload CSV
                  </Button>
                </BlockStack>
              </InlineStack>
            </Card>

            {loading && (
              <Card>
                <BlockStack gap="200">
                  <InlineStack gap="200" align="center">
                    <Spinner size="small" />
                    <Text tone="subdued">Fetching product info from Shopify...</Text>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {!loading && items.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200">
                    <Button onClick={() => { setNoteInput(''); setShowNoteInput(true); setPendingPublishAll(false); }}>
                      Add task note
                    </Button>
                    <Button
                      disabled={selectedSkus.length === 0 || publishing}
                      onClick={handlePublishSelected}
                      loading={publishing}
                    >
                      Publish selected ({selectedSkus.length})
                    </Button>
                    <Button
                      variant="primary"
                      disabled={items.length === 0 || publishing}
                      onClick={handlePublishAll}
                      loading={publishing}
                    >
                      Publish all
                    </Button>
                  </InlineStack>

                  <DataTable
                    columnContentTypes={['text','text','text','text']}
                    headings={[
                      <Checkbox
                        checked={selectedSkus.length === items.length && items.length > 0}
                        indeterminate={selectedSkus.length > 0 && selectedSkus.length < items.length}
                        onChange={toggleSelectAll}
                      />,
                      'SKU', 'Name', 'Price',
                    ]}
                    rows={rows}
                  />
                </BlockStack>
              </Card>
            )}

            {/* Published Tasks — merged in from the former standalone page */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text variant="headingMd" fontWeight="bold">Published Tasks</Text>
                  <InlineStack gap="200">
                    <Button
                      destructive
                      disabled={selectedTaskIds.length === 0}
                      onClick={handleDeleteSelectedTasks}
                    >
                      Delete selected
                    </Button>
                    <Button
                      destructive
                      disabled={tasks.length === 0}
                      onClick={handleDeleteAllTasks}
                    >
                      Delete all
                    </Button>
                  </InlineStack>
                </InlineStack>

                {tasksError && <Banner tone="critical" onDismiss={() => setTasksError('')}>{tasksError}</Banner>}

                {tasksLoading ? <Spinner /> : (
                  <DataTable
                    columnContentTypes={['text','text','text','text']}
                    headings={[
                      <Checkbox
                        checked={selectedTaskIds.length === tasks.length && tasks.length > 0}
                        indeterminate={selectedTaskIds.length > 0 && selectedTaskIds.length < tasks.length}
                        onChange={toggleTaskSelectAll}
                      />,
                      'Task', 'Items', 'Unfinished stores',
                    ]}
                    rows={taskRows}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Note + publish confirm */}
      {showNoteInput && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px',
        }}>
          <div style={{
            background: 'white', borderRadius: '12px', padding: '24px',
            width: '100%', maxWidth: '480px', position: 'relative',
          }}>
            {/* Label type selector — top right */}
            <div style={{ position: 'absolute', top: 20, right: 24 }}>
              <select
                value={labelType}
                onChange={e => setLabelType(e.target.value)}
                style={{
                  padding: '5px 10px', borderRadius: '8px',
                  border: '1px solid #c9cccf', fontSize: '13px',
                  background: '#fff', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {LABEL_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <BlockStack gap="300">
              <Text variant="headingMd" fontWeight="bold">
                {pendingPublishAll ? `Publish all ${items.length} items` : `Publish ${selectedSkus.length} selected items`}
              </Text>
              <Text variant="bodySm" tone="subdued">
                To: {selectedLocations.join(', ')}
              </Text>
              <TextField
                label="Task note (optional)"
                value={noteInput}
                onChange={setNoteInput}
                multiline={2}
                autoComplete="off"
                placeholder="Add a note for managers..."
              />
              <InlineStack gap="200" align="end">
                <Button onClick={() => setShowNoteInput(false)}>Cancel</Button>
                <Button variant="primary" onClick={handleConfirmPublish} loading={publishing}>
                  Publish
                </Button>
              </InlineStack>
            </BlockStack>
          </div>
        </div>
      )}

      {/* Published task item detail popup */}
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
              {/* Task name · label type */}
              <Text variant="headingMd" fontWeight="bold">
                Task {detailTask.task_no}
                {detailTask.label_type && (
                  <span style={{ fontWeight: 400, color: '#6d7175' }}>
                    {' · '}{detailTask.label_type}
                  </span>
                )}
              </Text>
              <button onClick={() => setDetailTask(null)} style={{
                background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
              }}>✕</button>
            </InlineStack>

            {/* Assigned locations */}
            {detailTask.locations && detailTask.locations.length > 0 && (
              <div style={{ marginTop: '6px' }}>
                <Text variant="bodySm" tone="subdued">
                  {detailTask.locations.join(', ')}
                </Text>
              </div>
            )}

            {detailTask.note && (
              <div style={{ marginTop: '6px' }}>
                <Text tone="subdued" variant="bodySm">{detailTask.note}</Text>
              </div>
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

export default BuyerPriceChange;
