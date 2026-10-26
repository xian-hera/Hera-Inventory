import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack,
  Text, Banner, Spinner, DataTable,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MobileModalSafeArea from '../../components/MobileModalSafeArea';
// Store location: remembered per Shopify account, loaded before this page
// renders by ManagerLocationGate (2026-09-29) — replaces reading
// localStorage 'managerLocation' directly. See client/src/accountMemory.js.
import { getManagerLocation } from '../../accountMemory';
// Task type dot + WIG part (2026-10-08, Hera) — spec:
// claude/PRICE_CHANGE_SCHEDULE_REVERSE_SPEC.md
import { TaskTypeLabel } from '../shared/priceChangeShared';
import ManagerLabelPrintTaskDetail from './ManagerLabelPrintTaskDetail';

// Store › Price Change (2026-10-22, Hera — was "Label print tasks"):
// Price Change Tasks from Purchasing on top, then straight away the scan
// list to print labels. The store no longer creates / names / deletes its
// own print tasks: each location has ONE list — its most recent existing
// print task, or a new one created on first visit — shown with
// ManagerLabelPrintTaskDetail in `embedded` mode. (Removed with this: the
// store's own task table, "New task" / "Delete selected" / "Delete all"
// and their two modals. Older print tasks of the location stay in the
// database, just not listed.)

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ManagerLabelPrintTasks() {
  const navigate = useNavigate();
  const location = getManagerLocation() || '';

  const [listTaskId, setListTaskId] = useState(null); // this location's one print list
  const [error, setError]           = useState('');

  const [priceTasks, setPriceTasks]       = useState([]);
  const [priceLoading, setPriceLoading]   = useState(true);
  // Track which price task IDs are currently being marked done (for loading state)
  const [doneLoadingIds, setDoneLoadingIds] = useState([]);

  // This location's print list: its most recent print task, else a new one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = location ? `?location=${encodeURIComponent(location)}` : '';
        const res = await fetch(`/api/label-print-tasks${params}`);
        if (!res.ok) throw new Error('Failed to load the print list');
        const list = await res.json();
        let id = Array.isArray(list) && list.length ? list[0].id : null;
        if (!id) {
          const created = await fetch('/api/label-print-tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Price Change', location }),
          });
          if (!created.ok) throw new Error('Failed to create the print list');
          id = (await created.json()).id;
        }
        if (!cancelled) setListTaskId(id);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [location]);

  const fetchPriceTasks = useCallback(async () => {
    if (!location) { setPriceLoading(false); return; }
    setPriceLoading(true);
    try {
      const res = await fetch(`/api/price-change-tasks/manager?location=${encodeURIComponent(location)}`);
      if (!res.ok) throw new Error('Failed to load price change tasks');
      setPriceTasks(await res.json());
    } catch (e) {
      // silent fail
    } finally {
      setPriceLoading(false);
    }
  }, [location]);

  useEffect(() => { fetchPriceTasks(); }, [fetchPriceTasks]);

  // part (2026-10-08): 'main' or 'wig' — the WIG part of a task is Done on its own.
  const handleMarkDone = async (taskId, part = 'main') => {
    const key = `${taskId}:${part}`;
    setDoneLoadingIds(prev => [...prev, key]);
    try {
      const res = await fetch(`/api/price-change-tasks/${taskId}/done`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, part }),
      });
      if (!res.ok) throw new Error('Failed to mark as done');
      // Update local state so button immediately becomes "Done" text
      setPriceTasks(prev =>
        prev.map(t => t.id === taskId && (t.part || 'main') === part ? { ...t, location_status: 'done' } : t)
      );
    } catch (e) {
      setError('Failed to mark task as done.');
    } finally {
      setDoneLoadingIds(prev => prev.filter(id => id !== key));
    }
  };

  // Rows come per task part; group them: main row + optional "└ WIG" branch.
  // A task with only WIG items is one row with WIG in red bold (Hera 2026-10-08).
  const priceGroups = [];
  {
    const byId = new Map();
    for (const t of priceTasks) {
      if (!byId.has(t.id)) { byId.set(t.id, { id: t.id, main: null, wig: null }); priceGroups.push(byId.get(t.id)); }
      byId.get(t.id)[(t.part || 'main') === 'wig' ? 'wig' : 'main'] = t;
    }
  }
  const doneCell = (t) => {
    const part = t.part || 'main';
    if (t.location_status === 'done') return <Text tone="success" fontWeight="medium">Done</Text>;
    return (
      <Button size="slim" tone="success" loading={doneLoadingIds.includes(`${t.id}:${part}`)} onClick={() => handleMarkDone(t.id, part)}>
        Done
      </Button>
    );
  };
  const typesText = (t) => ((t.item_types || []).filter(Boolean).join(', ') || '-');
  const priceRows = [];
  for (const g of priceGroups) {
    const head = g.main || g.wig;
    const onlyWig = !g.main && !!g.wig;
    const mainUrl = `/manager/price-change/${g.id}${onlyWig ? '?part=wig' : g.wig ? '?part=main' : ''}`;
    priceRows.push([
      <Button variant="plain" onClick={() => navigate(mainUrl)}>{head.task_no}</Button>,
      <TaskTypeLabel type={head.task_type} fallback={head.label_type || 'Regular price'} />,
      onlyWig ? <span style={{ color: '#d72c0d', fontWeight: 700 }}>WIG</span> : typesText(head),
      String(head.item_count || 0),
      formatDate(head.published_at || head.created_at),
      head.note || '-',
      doneCell(head),
    ]);
    if (g.main && g.wig) {
      priceRows.push([
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: 8 }}>
          <span style={{ color: '#6d7175' }}>└</span>
          <Button variant="plain" onClick={() => navigate(`/manager/price-change/${g.id}?part=wig`)}>WIG</Button>
        </span>,
        '', '', String(g.wig.item_count || 0), '', '',
        doneCell(g.wig),
      ]);
    }
  }

  return (
    // Page title "Label Print" (was "Price Change") — 2026-10-26, Hera
    <Page
      // Plain title, no location suffix (2026-09-24, Hera). "Price Change"
      // since 2026-10-22 (was "Label print tasks"); no header buttons.
      title="Label Print"
      backAction={{ onAction: () => navigate('/manager') }}
    >
      <Layout>
        <Layout.Section>
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

          {/* ── Price change tasks (from buyer) ── */}
          <div>
            <BlockStack gap="300">
              <Text variant="headingSm">Label Print Tasks</Text>{/* was "Price Change Tasks" (2026-10-26, Hera) */}
              {priceLoading ? (
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '24px' }}>
                    <Spinner size="small" />
                  </div>
                </Card>
              ) : priceTasks.length === 0 ? (
                <Card>
                  <Text tone="subdued" alignment="center">No price change tasks assigned to this location.</Text>
                </Card>
              ) : (
                <Card padding="0">
                  <DataTable
                    columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text', 'text']}
                    headings={['Task', 'Task type', 'Types', 'Items', 'Published', 'Note', '']}
                    rows={priceRows}
                  />
                </Card>
              )}
            </BlockStack>
          </div>
        </Layout.Section>
      </Layout>

      {/* This location's print list (scan / search, print) */}
      <div style={{ marginTop: 16 }}>
        {listTaskId ? <ManagerLabelPrintTaskDetail taskId={listTaskId} embedded /> : (!error && <Text tone="subdued">Loading...</Text>)}
      </div>

      {/* Lift the Polaris modals above Shopify's Android bottom buttons (2026-09-24) */}
      <MobileModalSafeArea />

      {/* Bottom safe area (2026-09-24, Hera): keeps the last content above
          Shopify's native bottom buttons on Android; same 80px spacer as the
          other manager pages, on every device. */}
      <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} aria-hidden="true" />
    </Page>
  );
}

export default ManagerLabelPrintTasks;