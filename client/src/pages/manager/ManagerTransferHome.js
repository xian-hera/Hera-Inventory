import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Spinner, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '../shared/transferStatus';

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

  const location = localStorage.getItem('managerLocation');

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

  const renderRow = (tr) => (
    <div
      key={tr.id}
      onClick={() => openTransfer(tr)}
      style={{ borderBottom: '1px solid #f1f1f1', padding: '12px 4px', cursor: 'pointer' }}
    >
      <InlineStack align="space-between" blockAlign="center" wrap>
        <InlineStack gap="300" blockAlign="center" wrap>
          <Text fontWeight="semibold">{tr.transfer_no}</Text>
          <Text tone="subdued" variant="bodySm">{tr.from_location} to {tr.to_location}</Text>
        </InlineStack>
        <StatusBadge status={tr.status} />
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
      <InlineStack gap="200" blockAlign="center" wrap>
        <span style={{
          fontWeight: 700,
          color: h.kind === 'transfer_receiving' ? '#008060' : '#1F3D7A',
        }}>
          {h.kind === 'transfer_receiving' ? '[Received]' : '[Sent]'}
        </span>
        {h.kind === 'transfer_receiving' && (
          <Text tone="subdued" variant="bodySm">{h.summary?.from_location}</Text>
        )}
        <span style={{ fontWeight: 600, textDecoration: 'underline' }}>{h.ref_no}</span>
        <Text tone="subdued" variant="bodySm">{formatDate(h.created_at)}</Text>
      </InlineStack>
    </div>
  );

  if (!location) {
    return (
      <Page title="Transfer" backAction={{ onAction: () => navigate('/manager') }}>
        <Layout>
          <Layout.Section>
            <Banner tone="warning">Please select a location on Manager Home first.</Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page title="Transfer" backAction={{ onAction: () => navigate('/manager') }}>
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
    </Page>
  );
}

export default ManagerTransferHome;
