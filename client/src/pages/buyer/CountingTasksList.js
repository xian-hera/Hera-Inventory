import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Select, DataTable, Checkbox, Badge, Text, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01'
];

const STATUS_OPTIONS = ['counting','reviewing','committed','auto_committed','draft','archived'];

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

function CountingTasksList() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [department, setDepartment] = useState('ALL');
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [selectedStatuses, setSelectedStatuses] = useState([]);
  const [date, setDate] = useState('ALL');
  const [selectedIds, setSelectedIds] = useState([]);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (department !== 'ALL') params.append('department', department);
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
  }, [department, selectedLocations, selectedStatuses, date]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

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

  const rows = tasks.map(task => [
    <Checkbox checked={selectedIds.includes(task.id)} onChange={() => toggleSelectOne(task.id)} />,
    <Button variant="plain" onClick={() => navigate(`/buyer/counting-tasks/${task.id}`)}>{task.task_no}</Button>,
    task.department,
    task.location,
    task.inaccurate_count > 0 ? String(task.inaccurate_count) : '',
    formatDate(task.created_at),
    getStatusBadge(task.status),
  ]);

  return (
    <Page
      title="Counting tasks"
      backAction={{ onAction: () => navigate('/buyer') }}
      primaryAction={{ content: 'Creating task', onAction: () => navigate('/buyer/counting-tasks/new') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical">{error}</Banner>}
            <Card>
              <InlineStack gap="400" wrap>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Department</Text>
                  <Select
                    label="" labelHidden
                    options={[
                      { label: 'ALL', value: 'ALL' },
                      { label: 'CARE', value: 'CARE' },
                      { label: 'HAIR', value: 'HAIR' },
                      { label: 'GENM', value: 'GENM' },
                    ]}
                    value={department}
                    onChange={setDepartment}
                  />
                </BlockStack>
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
                  <Select
                    label="" labelHidden
                    options={[
                      { label: 'ALL', value: 'ALL' },
                      { label: 'Today', value: 'today' },
                      { label: '7 days', value: '7days' },
                      { label: '30 days', value: '30days' },
                    ]}
                    value={date}
                    onChange={setDate}
                  />
                </BlockStack>
              </InlineStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="end" gap="200">
                  <Button tone="critical" disabled={selectedIds.length === 0} onClick={handleDelete}>Delete selected</Button>
                  <Button disabled={selectedIds.length === 0} onClick={handleArchive}>Archive selected</Button>
                </InlineStack>
                <DataTable
                  columnContentTypes={['text','text','text','text','text','text','text']}
                  headings={[
                    <Checkbox
                      checked={selectedIds.length === tasks.length && tasks.length > 0}
                      indeterminate={selectedIds.length > 0 && selectedIds.length < tasks.length}
                      onChange={toggleSelectAll}
                    />,
                    'No.', 'Department', 'Location', 'Inaccurate', 'Date', 'Status',
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