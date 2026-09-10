import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Banner, Spinner,
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';

// Read-only "History in past 15 days" detail page for a transfer this manager
// already Received or Sent (see ManagerTransferHome.js's History section, and
// server/routes/transfers.js's submit-count / dispatchOne for how the row was
// frozen). Branches on the fetched entry's `kind` — 'transfer_receiving' shows
// the Received-side counting table (Name/SKU, Wig Number, Qty, Count, same as
// ManagerTransferReceivingDetail.js's Receiving state), 'transfer_sending'
// shows the Sent-side table (SKU, Name, Wig Number, Transfer qty, Qty loaded —
// same as TransferPrepDetail.js's Good to go/In transit state, where every
// qty loaded is a confirmed green check). A brand-new, separate component
// rather than reusing either of those live/editable pages — this one reads
// manager_history.detail (a frozen snapshot, including wig_number values
// captured at the moment of the manager's action), never the live
// transfer_items table.

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ManagerTransferHistoryDetail() {
  const navigate = useNavigate();
  const { historyId } = useParams();

  const [entry, setEntry]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const fetchEntry = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/manager-history/${historyId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.kind !== 'transfer_receiving' && data.kind !== 'transfer_sending') {
        throw new Error('This history entry is not a transfer.');
      }
      setEntry(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [historyId]);

  useEffect(() => { fetchEntry(); }, [fetchEntry]);

  if (loading) {
    return (
      <Page title="History" backAction={{ onAction: () => navigate('/manager/transfer') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }
  if (!entry) {
    return (
      <Page title="History" backAction={{ onAction: () => navigate('/manager/transfer') }}>
        <Layout><Layout.Section>{error && <Banner tone="critical">{error}</Banner>}</Layout.Section></Layout>
      </Page>
    );
  }

  const detail = entry.detail || {};
  const items = detail.items || [];
  const isReceiving = entry.kind === 'transfer_receiving';

  const headerTag = (
    <span style={{
      display: 'inline-block', padding: '4px 12px', borderRadius: '999px',
      background: isReceiving ? '#B8E9C9' : '#B7CBEF',
      color: isReceiving ? '#1B5E2E' : '#1F3D7A',
      fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {entry.label}
    </span>
  );

  return (
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      <Page
        title={detail.transfer_no || entry.ref_no}
        backAction={{ onAction: () => navigate('/manager/transfer') }}
        titleMetadata={headerTag}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

              <InlineStack align="space-between" blockAlign="start" wrap>
                <InlineStack gap="600" wrap>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">From</Text>
                    <Text fontWeight="bold">{detail.from_location}</Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">To</Text>
                    <Text fontWeight="bold">{detail.to_location}</Text>
                  </BlockStack>
                </InlineStack>
                <Text variant="bodySm" tone="subdued">{formatDate(entry.created_at)}</Text>
              </InlineStack>

              <Card>
                <div style={{ overflowX: 'auto' }}>
                  {isReceiving ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name / SKU</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}></th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Qty</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...items].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(item => {
                          const counted = item.counted_confirmed;
                          const matches = counted && Number(item.received_quantity) === Number(item.quantity);
                          return (
                            <tr key={item.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                              <td style={{ padding: '10px' }}>
                                <div style={{ fontWeight: 500 }}>{item.name || '-'}</div>
                                <div style={{ fontSize: '12px', color: '#6d7175' }}>{item.sku || '-'}</div>
                              </td>
                              <td style={{ padding: '10px', color: '#6d7175' }}>{item.wig_number || ''}</td>
                              <td style={{ padding: '10px' }}>{item.quantity}</td>
                              <td style={{ padding: '10px' }}>
                                {!counted ? (
                                  <Text tone="subdued">not counted</Text>
                                ) : matches ? (
                                  <span style={{ color: '#008060', fontWeight: 700 }}>✓ {item.received_quantity}</span>
                                ) : (
                                  <span style={{ color: '#d72c0d', fontWeight: 700 }}>{item.received_quantity}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>SKU</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Wig Number</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer qty</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Qty loaded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...items].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(item => (
                          <tr key={item.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                            <td style={{ padding: '10px' }}>{item.sku}</td>
                            <td style={{ padding: '10px' }}>{item.name}</td>
                            <td style={{ padding: '10px', color: '#6d7175' }}>{item.wig_number || ''}</td>
                            <td style={{ padding: '10px' }}>{item.quantity}</td>
                            <td style={{ padding: '10px' }}>
                              <span style={{ color: '#008060', fontWeight: 700 }}>{item.qty_loaded} ✓</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </Card>
              <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} />
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </div>
  );
}

export default ManagerTransferHistoryDetail;
