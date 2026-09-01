import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Spinner, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// List of invoices the buyer has sent to this location, still awaiting the
// manager's count. "Publish date" shown here is the buyer's Send to store
// date (sent_to_store_at), not the invoice's own date.
function ManagerPOReceiving() {
  const navigate = useNavigate();
  const location = localStorage.getItem('managerLocation') || '';

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!location) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/po-invoices/manager/receiving?location=${encodeURIComponent(location)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setInvoices(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [location]);

  useEffect(() => { load(); }, [load]);

  return (
    <Page title="PO Receiving" backAction={{ onAction: () => navigate('/manager') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {!location && (
              <Banner tone="warning">Please set your location on the Task home page first.</Banner>
            )}

            <Card>
              {loading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : invoices.length === 0 ? (
                <Text tone="subdued" alignment="center">No invoices waiting to be counted.</Text>
              ) : (
                <BlockStack gap="0">
                  {invoices.map((inv, idx) => (
                    <div
                      key={inv.id}
                      onClick={() => navigate(`/manager/po-receiving/${inv.id}`)}
                      style={{
                        cursor: 'pointer',
                        padding: '12px 4px',
                        borderTop: idx > 0 ? '1px solid #f1f1f1' : undefined,
                      }}
                    >
                      <InlineStack align="space-between" blockAlign="center" wrap>
                        <BlockStack gap="0">
                          <Text fontWeight="semibold">{inv.po_number || inv.invoice_number}</Text>
                          <Text variant="bodySm" tone="subdued">{inv.supplier_name}</Text>
                        </BlockStack>
                        <Text variant="bodySm" tone="subdued">{formatDate(inv.sent_to_store_at)}</Text>
                        <Text variant="bodySm" tone="subdued">Qty: {inv.total_quantity}</Text>
                        <Text
                          variant="bodySm"
                          fontWeight="medium"
                          tone={Number(inv.counted_lineitems) >= Number(inv.total_lineitems) ? 'success' : 'subdued'}
                        >
                          {inv.counted_lineitems}/{inv.total_lineitems}
                        </Text>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerPOReceiving;
