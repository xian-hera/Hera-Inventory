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

const SORT_CYCLE = [null, 'desc', 'asc'];
function sortLabel(order) {
  if (order === 'desc') return 'Sort ↓';
  if (order === 'asc')  return 'Sort ↑';
  return 'Sort';
}

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
  const [sortOrder, setSortOrder]                 = useState(null);

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

  const handleSort = () => {
    setSortOrder(prev => {
      const idx = SORT_CYCLE.indexOf(prev);
      return SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
    });
  };

  const displayedTasks = useMemo(() => {
    if (!sortOrder) return tasks;
    return [...tasks].sort((a, b) => {
      const cmp = a.task_no.localeCompare(b.task_no);
      return sortOrder === 'desc' ? -cmp : cmp;
    });
  }, [tasks, sortOrder]);

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

  const rows = displayedTasks.map(task => {
    // 显示 task 的 types，多个用 , 分隔，使用缩写
    const typesDisplay = Array.isArray(task.types) && task.types.length > 0
      ? task.types.map(typeDisplay).join(', ')
      : '-';

    return [
      <Checkbox checked={selectedIds.includes(task.id)} onChange={() => toggleSelectOne(task.id)} />,
      <Button variant="plain" onClick={() => navigate(`/buyer/counting-tasks/${task.id}`)}>{task.task_no}</Button>,
      <div style={{ whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: '160px' }}>{typesDisplay}</div>,
      task.location,
      task.inaccurate_count > 0 ? String(task.inaccurate_count) : '',
      formatDate(task.created_at),
      getStatusBadge(task.status),
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
                <InlineStack align="space-between" gap="200">
                  <Button
                    onClick={handleSort}
                    pressed={sortOrder !== null}
                    tone={sortOrder !== null ? 'success' : undefined}
                  >
                    {sortLabel(sortOrder)}
                  </Button>
                  <InlineStack gap="200">
                    <Button tone="critical" disabled={selectedIds.length === 0} onClick={handleDelete}>
                      Delete selected
                    </Button>
                    <Button disabled={selectedIds.length === 0} onClick={handleArchive}>
                      Archive selected
                    </Button>
                  </InlineStack>
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