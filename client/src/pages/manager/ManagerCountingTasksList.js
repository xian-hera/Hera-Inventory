import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, DataTable, Banner, Spinner, Button
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

// 改动一：9个 Type
const TYPE_OPTIONS = [
  'Braid', 'Hair', 'Hair & Skin Care', 'Hera Beauty',
  'Jewelry', 'K-Beauty', 'Makeup', 'Tools & Accessories', 'Wig',
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
  return `${d.getFullYear()}.${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ManagerCountingTasksList() {
  const navigate = useNavigate();
  const [tasks, setTasks]                 = useState([]);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState('');
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [date, setDate]                   = useState('ALL');

  const location = localStorage.getItem('managerLocation') || '';

  const fetchTasks = useCallback(async () => {
    if (!location) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.append('status', 'counting');
      params.append('location', location);
      if (selectedTypes.length > 0) params.append('types', selectedTypes.join(','));
      if (date !== 'ALL') params.append('date', date);

      const res = await fetch(`/api/tasks?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTasks(data);
    } catch (e) {
      setError('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [location, selectedTypes, date]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const rows = tasks.map(task => {
    const typesDisplay = Array.isArray(task.types) && task.types.length > 0
      ? task.types.map(typeDisplay).join(', ')
      : '-';

    return [
      <Button variant="plain" onClick={() => navigate(`/manager/counting-tasks/${task.id}`)}>
        {task.task_no}
      </Button>,
      // 改动一：显示 types，允许换行
      <div style={{ whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: '160px' }}>{typesDisplay}</div>,
      task.inaccurate_count > 0 ? `${task.inaccurate_count} off qty` : '',
      formatDate(task.created_at),
      `${task.processed_count || 0}/${task.total_count || 0}`,
    ];
  });

  return (
    <Page
      title="Weekly Inventory Count"
      backAction={{ onAction: () => navigate('/manager') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical">{error}</Banner>}

            <Card>
              <InlineStack gap="400" wrap>
                {/* 改动一：Types 多选，替换 Department */}
                <MultiSelectDropdown
                  label="Types"
                  options={TYPE_OPTIONS}
                  selected={selectedTypes}
                  onChange={setSelectedTypes}
                  labelMap={TYPE_LABEL_MAP}
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
              {loading ? <Spinner /> : (
                <div style={{ overflowX: 'hidden' }}>
                  <DataTable
                    columnContentTypes={['text','text','text','text','text']}
                    headings={['No.', 'Types', '', 'Date', 'Progress']}
                    rows={rows}
                  />
                </div>
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerCountingTasksList;