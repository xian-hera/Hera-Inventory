import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, DataTable, Checkbox, TextField, Badge
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { useLocationMap } from '../shared/locationMap';
// Same CSV decoding / hidden-character cleaning as Import Products
// (2026-10-08, "661157104234�" incident).
import { decodeCsvBuffer, cleanCell, UNREADABLE_CHAR } from './importProducts/importModel';
// Scheduled price changes (2026-10-08, Hera) — spec:
// claude/PRICE_CHANGE_SCHEDULE_REVERSE_SPEC.md
import ScheduledTasksCard, { ScheduledTaskModal } from './priceChange/ScheduledTasksCard';
import { TaskTypeLabel, excludedText, formatToronto, money } from '../shared/priceChangeShared';

// The old "Upload CSV → Publish" flow on this page (labels only, no price
// change in Shopify) is replaced by Create Task (2026-10-08, Hera). Kept,
// hidden; set to true to bring it back.
const SHOW_LEGACY_UPLOAD = false;

// Location list: comes from the shared location map (pages/shared/locationMap.js,
// 2026-09-24). The hardcoded 19-code LOCATIONS constant that used to live here
// (the Location multi-select's options, and its "everything selected by
// default" initial value) was removed — the default-all selection is now
// applied once, as soon as the shared list has loaded (see below).

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

  const [selectedLocations, setSelectedLocations] = useState([]);
  const { names: locationNames } = useLocationMap();
  // Default = every location selected (same as before the shared map). Applied
  // exactly once, when the list first arrives, and only if the user hasn't
  // already picked something in the meantime.
  const locationsDefaultedRef = useRef(false);
  useEffect(() => {
    if (locationsDefaultedRef.current || locationNames.length === 0) return;
    locationsDefaultedRef.current = true;
    setSelectedLocations(prev => (prev.length === 0 ? [...locationNames] : prev));
  }, [locationNames]);
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

  // Archived tasks: every store Done; kept 30 days (2026-10-08).
  const [archived, setArchived]           = useState([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  // Scheduled task opened from a Published row ("Reverse" link).
  const [openScheduledId, setOpenScheduledId] = useState(null);
  const [scheduledVersion, setScheduledVersion] = useState(0);

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

  const fetchArchived = useCallback(async () => {
    setArchivedLoading(true);
    try {
      const res = await fetch('/api/price-change-tasks/archived');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setArchived(data);
    } catch (e) {
      setTasksError('Failed to load archived tasks');
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); fetchArchived(); }, [fetchTasks, fetchArchived]);

  const handleCSVUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    const reader = new FileReader();
    reader.onload = async (evt) => {
      // Bytes decoded as UTF-8, or as Windows-1252 when they aren't valid
      // UTF-8 (Excel "CSV (Comma delimited)") — was readAsText (UTF-8 only).
      const lines = decodeCsvBuffer(evt.target.result).split('\n').filter(l => l.trim());

      if (lines.length === 0) { setError('No data found in CSV.'); return; }

      // Find the header row: the first row with a cell whose value is
      // exactly "SKU" (case-insensitive, quotes/whitespace stripped).
      // Everything at or before that row is ignored, and that column is the
      // only one read from every row after it — no more guessing which
      // column holds the SKU by whether it looks numeric.
      let skuCol = -1;
      let headerRowIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
        const idx = cols.findIndex(c => c.toLowerCase() === 'sku');
        if (idx !== -1) {
          skuCol = idx;
          headerRowIndex = i;
          break;
        }
      }

      if (skuCol === -1) {
        setError('CSV must have a column with header "SKU".');
        return;
      }

      const dataLines = lines.slice(headerRowIndex + 1);

      if (dataLines.length === 0) { setError('No data found in CSV.'); return; }

      const allSkus = [...new Set(
        dataLines
          .map(l => cleanCell(l.split(',')[skuCol] || '').trim().replace(/"/g, ''))
          .filter(Boolean)
      )];
      // A SKU that still holds "�" can't be matched — list it, don't look it up.
      const unreadable = allSkus.filter(sku => sku.includes(UNREADABLE_CHAR));
      const skus = allSkus.filter(sku => !sku.includes(UNREADABLE_CHAR));

      if (skus.length === 0 && unreadable.length === 0) { setError('No SKUs found in CSV.'); return; }

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
      const problems = [];
      if (failed.length > 0) problems.push(`${failed.length} SKU(s) not found in Shopify: ${failed.join(', ')}`);
      if (unreadable.length > 0) problems.push(`${unreadable.length} SKU(s) contain an unreadable character (�) — save the CSV as "CSV UTF-8" or retype them: ${unreadable.join(', ')}`);
      if (problems.length > 0) setError(problems.join(' · '));
      setLoading(false);
    };
    reader.readAsArrayBuffer(file);
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
      // Tasks made by Create Task (task_type set) show old → new values and
      // skipped items (2026-10-08); older tasks keep the simple item list.
      const res = await fetch(task.task_type ? `/api/price-change-tasks/${task.id}/detail` : `/api/price-change-tasks/${task.id}/items`);
      const data = await res.json();
      setDetailItems(task.task_type ? (data.items || []) : data);
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
    const rev = task.reverse_task; // its reverse, waiting in Scheduled Tasks
    return [
      <Checkbox checked={selectedTaskIds.includes(task.id)} onChange={() => toggleTaskSelectOne(task.id)} />,
      <BlockStack gap="050" inlineAlign="start">
        <Button variant="plain" onClick={() => openTaskDetail(task)}>{task.task_no}</Button>
        {rev && rev.status === 'scheduled' && (
          <Button variant="plain" size="slim" onClick={() => setOpenScheduledId(task.reverse_task_id)}>
            {`↻ Reverse ${formatToronto(rev.scheduled_at)}`}
          </Button>
        )}
        {task.reverse_of_no && <Text variant="bodySm" tone="subdued">Reverse of {task.reverse_of_no}</Text>}
      </BlockStack>,
      <TaskTypeLabel type={task.task_type} fallback={task.label_type || ''} />,
      String(task.item_count || 0),
      unfinished.length > 0
        // Long lists wrap inside the cell instead of widening the table
        // (DataTable cells don't wrap by default) — 2026-10-09, Hera.
        ? <div style={{ fontSize: '13px', color: '#d72c0d', whiteSpace: 'normal', minWidth: 160 }}>{unfinished.join(', ')}</div>
        : <Badge tone="success">All done</Badge>,
    ];
  });

  return (
    <Page
      title="Price Change"
      backAction={{ onAction: () => navigate('/buyer') }}
      primaryAction={{ content: 'Create Task', onAction: () => navigate('/buyer/price-change/create') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            {/* Scheduled Tasks (2026-10-08) */}
            <ScheduledTasksCard
              locationNames={locationNames}
              version={scheduledVersion}
              onChanged={() => { fetchTasks(); }}
            />

            {SHOW_LEGACY_UPLOAD && (<>
            <Card>
              <InlineStack gap="400" wrap align="start">
                <MultiSelectDropdown
                  label="Location"
                  options={locationNames}
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
                  <InlineStack gap="200" blockAlign="center">
                    <Button onClick={() => csvInputRef.current.click()} loading={loading}>
                      Upload CSV
                    </Button>
                    <Text variant="bodySm" tone="subdued">
                      Only SKU column is needed. MUST have header &quot;SKU&quot;.
                    </Text>
                  </InlineStack>
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

            </>)}

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
                    columnContentTypes={['text','text','text','text','text']}
                    headings={[
                      <Checkbox
                        checked={selectedTaskIds.length === tasks.length && tasks.length > 0}
                        indeterminate={selectedTaskIds.length > 0 && selectedTaskIds.length < tasks.length}
                        onChange={toggleTaskSelectAll}
                      />,
                      'Task', 'Task type', 'Items', 'Unfinished Locations',
                    ]}
                    rows={taskRows}
                  />
                )}
              </BlockStack>
            </Card>

            {/* Archived Tasks — every store Done; last 30 days (2026-10-08) */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" fontWeight="bold">Archived Tasks</Text>
                <Text variant="bodySm" tone="subdued">Tasks every store has marked Done. Kept for 30 days.</Text>
                {archivedLoading ? <Text tone="subdued">Loading...</Text> : archived.length === 0 ? (
                  <Text tone="subdued">No archived tasks.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={['text','text','text','text','text']}
                    headings={['Task', 'Task type', 'Items', 'Published', 'Archived']}
                    rows={archived.map(t => [
                      <Button variant="plain" onClick={() => openTaskDetail(t)}>{t.task_no}</Button>,
                      <TaskTypeLabel type={t.task_type} fallback={t.label_type || ''} />,
                      String(t.item_count || 0),
                      formatToronto(t.published_at || t.created_at),
                      formatToronto(t.archived_at || t.created_at),
                    ])}
                  />
                )}
              </BlockStack>
            </Card>
            <div style={{ height: 120 }} />
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

      {/* Reverse opened from a Published row (2026-10-08) */}
      {openScheduledId && (
        <ScheduledTaskModal
          taskId={openScheduledId}
          locationNames={locationNames}
          onClose={() => setOpenScheduledId(null)}
          onChanged={() => { setScheduledVersion(v => v + 1); fetchTasks(); }}
        />
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
            width: '100%', maxWidth: detailTask.task_type ? '920px' : '680px', maxHeight: '80vh', overflowY: 'auto', // wider for Create Task tasks (more columns, 2026-10-09)
          }}>
            <InlineStack align="space-between">
              {/* Task name · label type */}
              <Text variant="headingMd" fontWeight="bold">
                Task {detailTask.task_no}
                {detailTask.task_type && (
                  <span style={{ fontWeight: 400, color: '#6d7175' }}>
                    {' · '}<TaskTypeLabel type={detailTask.task_type} />
                  </span>
                )}
                {!detailTask.task_type && detailTask.label_type && (
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
                  {detailTask.task_type ? excludedText(detailTask.locations, locationNames) : detailTask.locations.join(', ')}
                </Text>
              </div>
            )}

            {detailTask.note && (
              <div style={{ marginTop: '6px' }}>
                <Text tone="subdued" variant="bodySm">{detailTask.note}</Text>
              </div>
            )}

            <div style={{ marginTop: '16px' }}>
              {detailLoading ? <Spinner /> : detailTask.task_type ? (
                // Create Task tasks (2026-10-08): what was changed in Shopify.
                // Discontinued (not its reverse) also shows the custom.name
                // change, e.g. "Kamila 1B → Kamila@ 1B" (2026-10-09).
                (() => {
                  const showName = detailTask.task_type === 'discontinued' && !detailTask.reverse_of;
                  const nameCell = (item) => (item.new_name
                    ? (
                      <div style={{ whiteSpace: 'normal', minWidth: 140 }}>
                        <div style={{ color: '#6d7175' }}>{item.old_name || ''}</div>
                        <div>→ {item.new_name}</div>
                      </div>
                    )
                    : (item.apply_status === 'done' ? 'No change' : '—'));
                  return (
                    <DataTable
                      columnContentTypes={showName ? ['text','text','text','text','text','text'] : ['text','text','text','text','text']}
                      headings={showName
                        ? ['SKU', 'Name', 'Price', 'Compare-at', 'custom.name', 'Result']
                        : ['SKU', 'Name', 'Price', 'Compare-at', 'Result']}
                      rows={detailItems.map(item => [
                        item.sku,
                        item.name || '-',
                        item.apply_status === 'done' ? `${money(item.old_price)} → ${money(item.new_price)}` : money(item.csv_price),
                        item.apply_status === 'done' ? `${money(item.old_compare_at)} → ${money(item.new_compare_at)}` : '—',
                        ...(showName ? [nameCell(item)] : []),
                        item.apply_status === 'done' ? (item.apply_note || 'Changed') : (item.apply_note || item.apply_status || ''),
                      ])}
                    />
                  );
                })()
              ) : (
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
