import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Checkbox, Badge, Text, Banner, Spinner
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

// Row-level divider styling — this needs a plain <table> (not Polaris
// DataTable) to render as one continuous line: DataTable lays out each cell
// independently, so a per-cell border comes out as a broken/segmented line
// rather than a single line spanning the row. Same-location rows keep their
// normal thin divider and spacing; a location-group boundary gets a
// darker/thicker divider with 130% of the normal vertical spacing on both
// sides of it (extra padding-top on the row that starts the new group,
// extra padding-bottom on the row that ends the previous one).
const ROW_V_PADDING = 10;
const GROUP_V_PADDING = Math.round(ROW_V_PADDING * 1.3);
const ROW_BORDER = '1px solid #f1f1f1';
// Same 1px weight as ROW_BORDER — only the color darkens to stand out from
// the light same-location divider (per user feedback: darker, not thicker).
const GROUP_BORDER = '1px solid #202223';

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

            {/* padding="0" on the Card so the table (and its location-boundary
                dividers) can be genuinely flush with the card's left/right
                edges; padding is re-applied manually below to every
                non-table child so they don't visually touch the edges. */}
            <Card padding="0">
              <BlockStack gap="300">
                <div style={{ padding: '16px 16px 0' }}>
                  <InlineStack align="end" gap="200">
                    <Button tone="critical" disabled={selectedIds.length === 0} onClick={handleDelete}>
                      Delete selected
                    </Button>
                    <Button disabled={selectedIds.length === 0} onClick={handleArchive}>
                      Archive selected
                    </Button>
                  </InlineStack>
                </div>

                {loading ? (
                  <div style={{ padding: '16px' }}>
                    <InlineStack align="center"><Spinner /></InlineStack>
                  </div>
                ) : displayedTasks.length === 0 ? (
                  <div style={{ padding: '16px' }}>
                    <Text tone="subdued" alignment="center">No tasks found.</Text>
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto', paddingBottom: '16px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          <th style={{ padding: '8px', textAlign: 'left', width: '32px' }}>
                            <Checkbox
                              checked={selectedIds.length === tasks.length && tasks.length > 0}
                              indeterminate={selectedIds.length > 0 && selectedIds.length < tasks.length}
                              onChange={toggleSelectAll}
                            />
                          </th>
                          {['No.', 'Types', 'Location', 'Inaccurate', 'Date', 'Status'].map((h, i) => (
                            <th
                              key={i}
                              style={{ padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayedTasks.map((task, idx) => {
                          // 显示 task 的 types，多个用 , 分隔，使用缩写
                          const typesDisplay = Array.isArray(task.types) && task.types.length > 0
                            ? task.types.map(typeDisplay).join(', ')
                            : '-';

                          const isFirstOfGroup = idx > 0 && task.location !== displayedTasks[idx - 1].location;
                          const isLastOfGroup = idx < displayedTasks.length - 1 && task.location !== displayedTasks[idx + 1].location;
                          const rowBorder = idx === 0 ? 'none' : (isFirstOfGroup ? GROUP_BORDER : ROW_BORDER);
                          const padTop = isFirstOfGroup ? GROUP_V_PADDING : ROW_V_PADDING;
                          const padBottom = isLastOfGroup ? GROUP_V_PADDING : ROW_V_PADDING;
                          const tdStyle = { padding: `${padTop}px 10px ${padBottom}px`, verticalAlign: 'top' };

                          return (
                            <tr key={task.id} style={{ borderTop: rowBorder }}>
                              <td style={tdStyle}>
                                <Checkbox checked={selectedIds.includes(task.id)} onChange={() => toggleSelectOne(task.id)} />
                              </td>
                              <td style={tdStyle}>
                                <Button variant="plain" onClick={() => navigate(`/buyer/counting-tasks/${task.id}`)}>{task.task_no}</Button>
                              </td>
                              <td style={{ ...tdStyle, whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: '160px' }}>{typesDisplay}</td>
                              <td style={tdStyle}>{task.location}</td>
                              <td style={tdStyle}>{task.inaccurate_count > 0 ? String(task.inaccurate_count) : ''}</td>
                              <td style={tdStyle}>{formatDate(task.created_at)}</td>
                              <td style={tdStyle}>{getStatusBadge(task.status)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default CountingTasksList;