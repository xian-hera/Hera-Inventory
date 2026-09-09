import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function BuyerTransferHistory() {
  const navigate = useNavigate();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchHistory = useCallback(async (q) => {
    setLoading(true);
    try {
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      const res = await fetch(`/api/transfers/history${params}`);
      const data = await res.json();
      setHistory(Array.isArray(data) ? data : []);
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHistory(''); }, [fetchHistory]);

  const handleClearSearch = () => {
    setSearch('');
    fetchHistory('');
  };

  return (
    <Page title="Committed transfer history" backAction={{ onAction: () => navigate('/buyer/transfer') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              Only the most recent 200 transfers are kept. Older ones are automatically cleared.
            </Banner>

            <Card>
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label=""
                      labelHidden
                      placeholder="Search by SKU or Name"
                      value={search}
                      onChange={setSearch}
                      onKeyDown={(e) => { if (e.key === 'Enter') fetchHistory(search); }}
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={handleClearSearch}
                    />
                  </div>
                  <Button onClick={() => fetchHistory(search)}>Search</Button>
                </InlineStack>
                {!loading && <Text tone="subdued" variant="bodySm">Found {history.length} matched</Text>}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                {loading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : history.length === 0 ? (
                  <Text tone="subdued">{search ? 'No matching transfer found.' : 'No committed transfers yet.'}</Text>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          {['Date', 'Time', 'Transfer number', 'Transfer ID', 'From', 'To'].map((h, i) => (
                            <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {history.map(tr => {
                          const [date, time] = formatDate(tr.committed_at).split(' ');
                          return (
                            <tr key={tr.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                              <td style={{ padding: '10px' }}>{date}</td>
                              <td style={{ padding: '10px' }}>{time}</td>
                              <td style={{ padding: '10px' }}>
                                <span
                                  style={{ cursor: 'pointer', textDecoration: 'underline' }}
                                  onClick={() => navigate(`/buyer/transfer/${tr.id}`)}
                                >
                                  {tr.transfer_no}
                                </span>
                              </td>
                              <td style={{ padding: '10px' }}>
                                {tr.shopify_transfer_url ? (
                                  <a
                                    href={tr.shopify_transfer_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ textDecoration: 'underline' }}
                                  >
                                    {tr.shopify_transfer_name || tr.shopify_transfer_id}
                                  </a>
                                ) : (
                                  tr.shopify_transfer_name || tr.shopify_transfer_id
                                )}
                              </td>
                              <td style={{ padding: '10px' }}>{tr.from_location}</td>
                              <td style={{ padding: '10px' }}>{tr.to_location}</td>
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

export default BuyerTransferHistory;
