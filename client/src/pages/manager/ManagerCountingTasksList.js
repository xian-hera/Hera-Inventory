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

  // History in past 15 days — a frozen record of tasks this manager already
  // submitted, kept below the live table so they can look back at what was
  // submitted after it leaves the list above. See server/routes/
  // managerHistory.js. Independent of the Types/Date filters above (those
  // only affect the live 'counting' list).
  const [history, setHistory]               = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

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

  const fetchHistory = useCallback(async () => {
    if (!location) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/manager-history?kind=task&location=${encodeURIComponent(location)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setHistory(data);
    } catch (e) {
      // History is a secondary, non-blocking display — a failure here
      // shouldn't put an error banner over the main task list.
    } finally {
      setHistoryLoading(false);
    }
  }, [location]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

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

  const historyRows = history.map(h => {
    const typesArr = (h.summary && Array.isArray(h.summary.types)) ? h.summary.types : [];
    const typesDisplay = typesArr.length > 0 ? typesArr.map(typeDisplay).join(', ') : '-';
    return [
      <Button variant="plain" onClick={() => navigate(`/manager/counting-tasks/history/${h.id}`)}>
        {h.ref_no}
      </Button>,
      <div style={{ whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: '160px' }}>{typesDisplay}</div>,
      formatDate(h.created_at),
      <span style={{
        display: 'inline-block', padding: '4px 12px', borderRadius: '999px',
        background: '#E1E3E5', color: '#3F4448', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
      }}>
        {h.label}
      </span>,
    ];
  });

  return (
    <Page
      title="Weekly Inventory Count"
      backAction={{ onAction: () => navigate('/manager/inventory-count') }}
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

            {/* History in past 15 days — frozen record of what this manager
                already submitted; see comment on the `history` state above. */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm">History in past 15 days</Text>
                {historyLoading ? <Spinner /> : history.length === 0 ? (
                  <Text tone="subdued">No submitted tasks in the past 15 days.</Text>
                ) : (
                  <div style={{ overflowX: 'hidden' }}>
                    <DataTable
                      columnContentTypes={['text','text','text','text']}
                      headings={['No.', 'Types', 'Date', 'Status']}
                      rows={historyRows}
                    />
                  </div>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Bottom safe-area spacer (2026-09-18, Hera): same fix as
          ManagerWigDemo.js — on Android, opening this page inside Shopify's
          own app leaves the last card sitting right under Shopify's native
          bottom button/nav bar, unreachable to tap. See the
          .mobile-bottom-safe-area comment in client/public/index.html for
          the full explanation; only takes effect on phone-width screens. */}
      <div className="mobile-bottom-safe-area" aria-hidden="true" />
    </Page>
  );
}

export default ManagerCountingTasksList;