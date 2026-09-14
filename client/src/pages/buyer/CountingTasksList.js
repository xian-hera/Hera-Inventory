import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  DataTable, Checkbox, Badge, Text, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01','HQ'
];

const STATUS_OPTIONS = ['counting','reviewing','committed','auto_committed','draft','archived'];

// 改动一：9个 Type，含缩写显示
const TYPE_OPTIONS = [
  'Braid',
  'Hair',
  'Hair & Skin Care',
  'Hera Beauty',
  'Jewelry',
  'K-Beauty',
  'Makeup',
  'Tools & Accessories',
  'Wig',
];

const TYPE_LABEL_MAP = {
  'Hair & Skin Care': 'Care',
  'Tools & Accessories': 'Tools + Acc.',
};

function typeDisplay(type) {
  return TYPE_LABEL_MAP[type] || type;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function getStatusBadge(status) {
  const toneMap = {
    counting: 'info', reviewing: 'warning', committed: 'success',
    auto_committed: 'success', draft: 'new', archived: '',
  };
  return <Badge tone={toneMap[status] || ''}>{status}</Badge>;
}

// Always-on location sort (item 1: the old toggleable Sort button was
// removed — the list is now unconditionally grouped by location). Order
// follows LOCATIONS' own M/E/C/O/Q/H group sequence (MTL, EDM, CAL, OTT,
// QC, HQ prefixes), which is already how that array is laid out above.
const LOCATION_ORDER = new Map(LOCATIONS.map((loc, i) => [loc, i]));
const DIVIDER_STYLE = { borderTop: '2px solid #c9cccf', paddingTop: '8px', marginTop: '8px' };

function CountingTasksList() {
  const navigate = useNavigate();
  const [tasks, setTasks]                         = useState([]);
  const [loading, setLoading]                     = useState(false);
  const [error, setError]                         = useState('');
  const [selectedTypes, setSelectedTypes]         = useState([]);
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [selectedStatuses, setSelectedStatuses]   = useState(['counting','reviewing','committed','auto_committed','draft']);
  const [date, setDate]                           = useState('ALL');
  const [selectedIds, setSelectedIds]             = useState([]);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (selectedTypes.length > 0) params.append('types', selectedTypes.join(','));
      if (selectedLocations.length > 0) params.append('location', selectedLocations.join(','));
      if (selectedStatuses.length > 0) params.append('status', selectedStatuses.join(','));
      if (date !== 'ALL') params.append('date', date);
      const res = await fetch(`/api/tasks?${params.toString()}`);
      const data = await res.json();
      setTasks(data);
    } catch (e) {
      setError('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [selectedTypes, selectedLocations, selectedStatuses, date]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  // Always grouped/sorted by location (M/E/C/O/Q/H group order); a stable
  // sort keeps each group's original relative order (as returned by the
  // API) intact.
  const displayedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const ai = LOCATION_ORDER.has(a.location) ? LOCATION_ORDER.get(a.location) : LOCATIONS.length;
      const bi = LOCATION_ORDER.has(b.location) ? LOCATION_ORDER.get(b.location) : LOCATIONS.length;
      return ai - bi;
    });
  }, [tasks]);

  const toggleSelectAll = () => {
    setSelectedIds(selectedIds.length === tasks.length ? [] : tasks.map(t => t.id));
  };
  const toggleSelectOne = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedIds.length} task(s)?`)) return;
    await fetch('/api/tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds }),
    });
    setSelectedIds([]);
    fetchTasks();
  };

  const handleArchive = async () => {
    if (selectedIds.length === 0) return;
    await fetch('/api/tasks/archive', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds }),
    });
    setSelectedIds([]);
    fetchTasks();
  };

  const rows = displayedTasks.map((task, idx) => {
    // 显示 task 的 types，多个用 , 分隔，使用缩写
    const typesDisplay = Array.isArray(task.types) && task.types.length > 0
      ? task.types.map(typeDisplay).join(', ')
      : '-';

    // Visual divider: a top border on every cell of the first row of a new
    // location, so it reads as a horizontal line spanning the whole row.
    const isNewLocationGroup = idx > 0 && task.location !== displayedTasks[idx - 1].location;
    const cellStyle = isNewLocationGroup ? DIVIDER_STYLE : undefined;

    return [
      <div style={cellStyle}><Checkbox checked={selectedIds.includes(task.id)} onChange={() => toggleSelectOne(task.id)} /></div>,
      <div style={cellStyle}><Button variant="plain" onClick={() => navigate(`/buyer/counting-tasks/${task.id}`)}>{task.task_no}</Button></div>,
      <div style={{ ...cellStyle, whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: '160px' }}>{typesDisplay}</div>,
      <div style={cellStyle}>{task.location}</div>,
      <div style={cellStyle}>{task.inaccurate_count > 0 ? String(task.inaccurate_count) : ''}</div>,
      <div style={cellStyle}>{formatDate(task.created_at)}</div>,
      <div style={cellStyle}>{getStatusBadge(task.status)}</div>,
    ];
  });

  return (
    <Page
      title="Weekly Inventory Count"
      backAction={{ onAction: () => navigate('/buyer/inventory-count') }}
      primaryAction={{ content: 'Create New Count', onAction: () => navigate('/buyer/counting-tasks/new') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical">{error}</Banner>}

            <Card>
              <InlineStack gap="400" wrap>
                {/* 改动一：Types 多选，替换 Department 单选 */}
                <MultiSelectDropdown
                  label="Types"
                  options={TYPE_OPTIONS}
                  selected={selectedTypes}
                  onChange={setSelectedTypes}
                  labelMap={TYPE_LABEL_MAP}
                />
                <MultiSelectDropdown
                  label="Location"
                  options={LOCATIONS}
                  selected={selectedLocations}
                  onChange={setSelectedLocations}
                />
                <MultiSelectDropdown
                  label="Status"
                  options={STATUS_OPTIONS}
                  selected={selectedStatuses}
                  onChange={setSelectedStatuses}
                />
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Date</Text>
                  <select
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    style={{ padding: '6px 10px', border: '1px solid #c9cccf', borderRadius: '6px', fontSize: '14px' }}
                  >
                    <option value="ALL">ALL</option>
                    <option value="today">Today</option>
                    <option value="7days">7 days</option>
                    <option value="30days">30 days</option>
                  </select>
                </BlockStack>
              </InlineStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="end" gap="200">
                  <Button tone="critical" disabled={selectedIds.length === 0} onClick={handleDelete}>
                    Delete selected
                  </Button>
                  <Button disabled={selectedIds.length === 0} onClick={handleArchive}>
                    Archive selected
                  </Button>
                </InlineStack>

                <DataTable
                  columnContentTypes={['text','text','text','text','text','text','text']}
                  headings={[
                    <Checkbox
                      checked={selectedIds.length === tasks.length && tasks.length > 0}
                      indeterminate={selectedIds.length > 0 && selectedIds.length < tasks.length}
                      onChange={toggleSelectAll}
                    />,
                    'No.', 'Types', 'Location', 'Inaccurate', 'Date', 'Status',
                  ]}
                  rows={rows}
                  loading={loading}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default CountingTasksList;