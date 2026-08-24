import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Banner, Spinner, Badge
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function BuyerPOReceivingHistory() {
  const navigate = useNavigate();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/po-invoices/history')
      .then(r => r.json())
      .then(data => setHistory(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <Page title="Committed invoice history" backAction={{ onAction: () => navigate('/buyer/po-receiving') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              Only the most recent 200 committed invoices are kept. Older ones are automatically cleared.
            </Banner>

            <Card>
              <BlockStack gap="300">
                {loading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : history.length === 0 ? (
                  <Text tone="subdued">No committed invoices yet.</Text>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          {['Date', 'Time', 'Supplier', 'Invoice number', ''].map((h, i) => (
                            <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {history.map(inv => {
                          const [date, time] = formatDate(inv.committed_at).split(' ');
                          return (
                            <tr key={inv.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                              <td style={{ padding: '10px' }}>{date}</td>
                              <td style={{ padding: '10px' }}>{time}</td>
                              <td style={{ padding: '10px' }}>{inv.supplier_name}</td>
                              <td style={{ padding: '10px' }}>
                                <span
                                  style={{ cursor: 'pointer', textDecoration: 'underline' }}
                                  onClick={() => navigate(`/buyer/po-receiving/committed/${inv.id}`)}
                                >
                                  {inv.invoice_number}
                                </span>{' '}
                                committed
                              </td>
                              <td style={{ padding: '10px' }}>
                                {inv.is_promotional && <Badge>Promotional</Badge>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOReceivingHistory;
