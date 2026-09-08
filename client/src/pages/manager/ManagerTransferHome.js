import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Spinner, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '../shared/transferStatus';

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

  useEffect(() => { fetchHome(); }, [fetchHome]);

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
              </>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerTransferHome;
