import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Spinner, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { StatusBadge, HoldBadge, TagPills } from '../shared/transferStatus';
// Store location: remembered per Shopify account, loaded before this page
// renders by ManagerLocationGate (2026-09-29) — replaces reading
// localStorage 'managerLocation' directly. See client/src/accountMemory.js.
import { getManagerLocation } from '../../accountMemory';
import { useDD, transferEntries, DDList, useIsPhoneWidth } from '../shared/ddPill';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// Manager Transfer Home — two cards: Receiving (this location is the
// to_location, statuses In transit / Receiving) and Sending (this location
// is the from_location, statuses Loading / Good to go / Pending). No
// checkboxes, no batch ops (confirmed by Hera — Manager doesn't need them).
// Spec doc section 6.
function ManagerTransferHome() {
  const navigate = useNavigate();
  const [receiving, setReceiving] = useState([]);
  const [sending, setSending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // History in past 15 days — a frozen record of transfers this manager
  // already received or sent, kept below the two live cards above. Two
  // kinds share the section: 'transfer_receiving' (Received) and
  // 'transfer_sending' (Sent) — merged and sorted by created_at desc. See
  // server/routes/managerHistory.js.
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const location = getManagerLocation();

  // Full DD pills (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §7),
  // left of the "from to" line. A store → store transfer is two Schedule
  // cards; each store only sees its own one (from store: the pickup, to
  // store: the delivery) — i.e. the entries whose store is this location.
  const dd = useDD({ transferIds: [...receiving, ...sending].map(tr => tr.id) });
  const myEntries = (id) => transferEntries(dd, id).filter(e => e.location === location);
  const isPhone = useIsPhoneWidth();

  const fetchHome = useCallback(async () => {
    if (!location) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/manager/home?location=${encodeURIComponent(location)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setReceiving(data.receiving || []);
      setSending(data.sending || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [location]);

  const fetchHistory = useCallback(async () => {
    if (!location) { setHistoryLoading(false); return; }
    setHistoryLoading(true);
    try {
      const [recvRes, sendRes] = await Promise.all([
        fetch(`/api/manager-history?kind=transfer_receiving&location=${encodeURIComponent(location)}`),
        fetch(`/api/manager-history?kind=transfer_sending&location=${encodeURIComponent(location)}`),
      ]);
      const [recvData, sendData] = await Promise.all([recvRes.json(), sendRes.json()]);
      if (!recvRes.ok) throw new Error(recvData.error);
      if (!sendRes.ok) throw new Error(sendData.error);
      const merged = [...recvData, ...sendData].sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );
      setHistory(merged);
    } catch (e) {
      // Secondary, non-blocking display — don't surface an error banner
      // over the two live cards for a History load failure.
    } finally {
      setHistoryLoading(false);
    }
  }, [location]);

  useEffect(() => { fetchHome(); }, [fetchHome]);
  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const openTransfer = (tr) => {
    if (tr.status === 'in_transit' || tr.status === 'receiving') {
      navigate(`/manager/transfer/receiving/${tr.id}`);
    } else {
      navigate(`/manager/transfer/sending/${tr.id}`);
    }
  };

  // Phone layout (2026-10-21, Hera): [transfer number over the grey "X to Y"]
  // · DD · status pill. The status pill is always right-aligned — also when
  // it doesn't fit and wraps onto its own line (margin-left: auto). Desktop
  // keeps the layout below unchanged.
  const renderRowPhone = (tr) => (
    <div
      key={tr.id}
      onClick={() => openTransfer(tr)}
      style={{ borderBottom: '1px solid #f1f1f1', padding: '12px 4px', cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 6 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}>
          {/* tags right after the number (2026-10-22) */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text fontWeight="semibold">{tr.shopify_transfer_name || tr.transfer_no}</Text>
            <TagPills tags={tr.tags} />
          </span>
          <Text tone="subdued" variant="bodySm">{tr.from_location} to {tr.to_location}</Text>
        </div>
        <DDList full entries={myEntries(tr.id)} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <StatusBadge status={tr.status} />
          {tr.on_hold && <HoldBadge />}
        </div>
      </div>
    </div>
  );

  const renderRow = (tr) => isPhone ? renderRowPhone(tr) : (
    <div
      key={tr.id}
      onClick={() => openTransfer(tr)}
      style={{ borderBottom: '1px solid #f1f1f1', padding: '12px 4px', cursor: 'pointer' }}
    >
      <InlineStack align="space-between" blockAlign="center" wrap>
        {/* 2026-10-22 (Hera): number · tags · locations · DD (the DD used to
            come before the locations). */}
        <InlineStack gap="300" blockAlign="center" wrap>
          <Text fontWeight="semibold">{tr.shopify_transfer_name || tr.transfer_no}</Text>
          <TagPills tags={tr.tags} />
          <Text tone="subdued" variant="bodySm">{tr.from_location} to {tr.to_location}</Text>
          <DDList full entries={myEntries(tr.id)} />
        </InlineStack>
        <InlineStack gap="150" blockAlign="center">
          <StatusBadge status={tr.status} />
          {tr.on_hold && <HoldBadge />}
        </InlineStack>
      </InlineStack>
    </div>
  );

  const renderHistoryRow = (h, idx) => (
    <div
      key={h.id}
      onClick={() => navigate(`/manager/transfer/history/${h.id}`)}
      style={{
        cursor: 'pointer',
        padding: '12px 4px',
        borderTop: idx > 0 ? '1px solid #f1f1f1' : undefined,
      }}
    >
      {/* 2026-10-22 (Hera): Shopify transfer number (never the Hub-internal
          number), tags, date, and the transfer's CURRENT status pill on the
          right. The "[Received]" / "[Sent]" prefix (and the from-location
          after it) were removed — the list rows don't carry their kind, so
          it always read "[Sent]". */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 6 }}>
        <span style={{ fontWeight: 600, textDecoration: 'underline' }}>{h.shopify_transfer_name || '—'}</span>
        <TagPills tags={h.transfer_tags} />
        <Text tone="subdued" variant="bodySm">{formatDate(h.created_at)}</Text>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {h.transfer_status && <StatusBadge status={h.transfer_status} />}
          {h.transfer_on_hold && <HoldBadge />}
        </span>
      </div>
    </div>
  );

  if (!location) {
    return (
      <Page title="Transfers" backAction={{ onAction: () => navigate('/manager') }}>
        <Layout>
          <Layout.Section>
            <Banner tone="warning">Please select a location on Manager Home first.</Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page title="Transfers" backAction={{ onAction: () => navigate('/manager') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {loading ? (
              <InlineStack align="center"><Spinner /></InlineStack>
            ) : (
              <>
                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingSm">Receiving</Text>
                    {receiving.length === 0 ? (
                      <Text tone="subdued">Nothing to receive right now.</Text>
                    ) : (
                      receiving.map(renderRow)
                    )}
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingSm">Sending</Text>
                    {sending.length === 0 ? (
                      <Text tone="subdued">Nothing to send right now.</Text>
                    ) : (
                      sending.map(renderRow)
                    )}
                  </BlockStack>
                </Card>

                {/* History in past 15 days — frozen record of transfers this
                    manager already received or sent; see comment on the
                    `history` state above. */}
                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingSm">History in past 15 days</Text>
                    {historyLoading ? (
                      <InlineStack align="center"><Spinner /></InlineStack>
                    ) : history.length === 0 ? (
                      <Text tone="subdued">No transfer activity in the past 15 days.</Text>
                    ) : (
                      history.map(renderHistoryRow)
                    )}
                  </BlockStack>
                </Card>
              </>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
      {/* Bottom safe area (2026-09-24, Hera): keeps the last content above
          Shopify's native bottom buttons on Android; same 80px spacer as the
          other manager pages, on every device. */}
      <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} aria-hidden="true" />
    </Page>
  );
}

export default ManagerTransferHome;
