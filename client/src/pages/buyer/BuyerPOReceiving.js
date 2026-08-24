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
                  recent.map(inv => (
                    <InlineStack key={inv.id} align="space-between" blockAlign="center">
                      <InlineStack gap="300" blockAlign="center">
                        <Text variant="bodySm" tone="subdued">{formatDate(inv.committed_at)}</Text>
                        <Text variant="bodySm" tone="subdued">{inv.supplier_name}</Text>
                        <Text
                          variant="bodySm"
                          as="span"
                          fontWeight="medium"
                          tone="interactive"
                        >
                          <span
                            style={{ cursor: 'pointer', textDecoration: 'underline' }}
                            onClick={() => navigate(`/buyer/po-receiving/committed/${inv.id}`)}
                          >
                            {inv.invoice_number}
                          </span>
                        </Text>
                        <Text variant="bodySm" tone="subdued">committed</Text>
                        {inv.is_promotional && <Badge>Promotional</Badge>}
                      </InlineStack>
                    </InlineStack>
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
