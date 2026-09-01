import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Button, BlockStack, Card, Text, InlineStack, Spinner, Badge
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// invoice_date is a plain DATE column (no time-of-day) — parse it as a
// calendar date rather than through the JS Date/UTC pipeline so it can't
// shift to the previous/next day depending on the viewer's timezone.
function formatDateOnly(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).slice(0, 10);
  const [y, m, d] = s.split('-');
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  if (!y || !m || !d) return '';
  return `${y}.${months[Number(m) - 1]}.${d}`;
}

function BuyerPOReceiving() {
  const navigate = useNavigate();
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/po-invoices/recent')
      .then(r => r.json())
      .then(data => setRecent(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <Page
      title="Receiving PO"
      backAction={{ onAction: () => navigate('/buyer') }}
      primaryAction={{ content: 'Settings', onAction: () => navigate('/buyer/po-receiving/settings') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving/import')}>
              Import an invoice
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving/commit-later')}>
              Commit later
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving/suppliers')}>
              Suppliers management
            </Button>

            <Card>
              <BlockStack gap="300">
                {loading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : recent.length === 0 ? (
                  <Text tone="subdued">No committed invoices yet.</Text>
                ) : (
                  recent.map((inv, idx) => (
                    <div
                      key={inv.id}
                      style={idx > 0 ? { borderTop: '1px solid #f1f1f1', paddingTop: '12px' } : undefined}
                    >
                      <InlineStack align="space-between" blockAlign="center">
                        <InlineStack gap="300" blockAlign="center">
                          <Text variant="bodySm" tone="subdued">{formatDate(inv.committed_at)}</Text>
                          <BlockStack gap="0">
                            <Text variant="bodySm" tone="subdued">{inv.supplier_name}</Text>
                            {inv.invoice_date && (
                              <Text variant="bodySm" tone="subdued">{formatDateOnly(inv.invoice_date)}</Text>
                            )}
                          </BlockStack>
                          <InlineStack gap="150" blockAlign="baseline" wrap={false}>
                            <Text
                              variant="bodySm"
                              as="span"
                              fontWeight="medium"
                              tone="interactive"
                            >
                              <span
                                style={{ cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' }}
                                onClick={() => navigate(`/buyer/po-receiving/committed/${inv.id}`)}
                              >
                                {inv.po_number || inv.invoice_number}
                              </span>
                            </Text>
                            {inv.po_number && inv.invoice_number && (
                              <Text variant="bodySm" tone="subdued">Ref: {inv.invoice_number}</Text>
                            )}
                          </InlineStack>
                          <Text variant="bodySm" tone="subdued">committed</Text>
                          {inv.is_promotional && <Badge>Promotional</Badge>}
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued">
                          Subtotal: {Number(inv.subtotal_cad || 0).toFixed(2)}
                        </Text>
                      </InlineStack>
                    </div>
                  ))
                )}
                {!loading && recent.length > 0 && (
                  <InlineStack align="end">
                    <span
                      style={{ cursor: 'pointer', textDecoration: 'underline', fontSize: '14px' }}
                      onClick={() => navigate('/buyer/po-receiving/history')}
                    >
                      View all
                    </span>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOReceiving;
