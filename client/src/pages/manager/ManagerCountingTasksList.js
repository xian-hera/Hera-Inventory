import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack,
  Text, DataTable, Banner, Spinner, Button
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
// Store location: remembered per Shopify account, loaded before this page
// renders by ManagerLocationGate (2026-09-29) — replaces reading
// localStorage 'managerLocation' directly. See client/src/accountMemory.js.
import { getManagerLocation } from '../../accountMemory';

// (2026-10-22, Hera) The Types / Date filter card was removed — the list
// always shows every counting task of this location. Its 9-type option list
// and the filter state went with it.

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

  // History in past 15 days — a frozen record of tasks this manager already
  // submitted, kept below the live table so they can look back at what was
  // submitted after it leaves the list above. See server/routes/
  // managerHistory.js. Independent of the Types/Date filters above (those
  // only affect the live 'counting' list).
  const [history, setHistory]               = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const location = getManagerLocation() || '';

  const fetchTasks = useCallback(async () => {
    if (!location) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.append('status', 'counting');
      params.append('location', location);

      const res = await fetch(`/api/tasks?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTasks(data);
    } catch (e) {
      setError('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [location]);

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
      // "Committed" in light green (2026-10-22, Hera; was "Committed by buyer").
      <span style={{
        display: 'inline-block', padding: '4px 12px', borderRadius: '999px',
        background: h.label === 'Committed' ? '#CDFEE1' : '#E1E3E5',
        color: h.label === 'Committed' ? '#0C5132' : '#3F4448', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
      }}>
        {h.label}
      </span>,
    ];
  });

  return (
    <Page
      title="Weekly Inventory Count"
      backAction={{ onAction: () => navigate('/manager') /* was the Inventory Count sub-menu (2026-10-22) */ }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical">{error}</Banner>}


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
                {/* No card title any more (2026-10-27, Hera; was "History in past 15 days"). */}
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