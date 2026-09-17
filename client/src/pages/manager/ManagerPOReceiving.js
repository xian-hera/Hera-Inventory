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

  // History in past 15 days — a frozen record of invoices this manager
  // already submitted, kept below the live list so they can look back at
  // what was submitted after it leaves the list above. See
  // server/routes/managerHistory.js.
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

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

  const loadHistory = useCallback(async () => {
    if (!location) { setHistoryLoading(false); return; }
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/manager-history?kind=po_invoice&location=${encodeURIComponent(location)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setHistory(data);
    } catch (e) {
      // Secondary, non-blocking display — don't surface an error banner
      // over the main invoice list for a History load failure.
    } finally {
      setHistoryLoading(false);
    }
  }, [location]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

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
                      {/* A fixed flex-basis on every column except the first
                          (PO number/supplier, which varies a lot in length)
                          keeps Date/Qty/counted lined up vertically between
                          rows — the previous `align="space-between"` instead
                          distributed space based on each row's own content
                          width, so a shorter PO/supplier block on one row
                          shifted every column after it left, row by row. */}
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                          <BlockStack gap="0">
                            <Text fontWeight="semibold" truncate>{inv.po_number || inv.invoice_number}</Text>
                            <Text variant="bodySm" tone="subdued" truncate>{inv.supplier_name}</Text>
                          </BlockStack>
                        </div>
                        <div style={{ flex: '0 0 150px', textAlign: 'center' }}>
                          <Text variant="bodySm" tone="subdued" alignment="center">{formatDate(inv.sent_to_store_at)}</Text>
                        </div>
                        <div style={{ flex: '0 0 100px', textAlign: 'center' }}>
                          <Text variant="bodySm" tone="subdued" alignment="center">Qty: {inv.total_quantity}</Text>
                        </div>
                        <div style={{ flex: '0 0 70px', textAlign: 'right' }}>
                          <Text
                            variant="bodySm"
                            fontWeight="medium"
                            alignment="end"
                            tone={Number(inv.counted_lineitems) >= Number(inv.total_lineitems) ? 'success' : 'subdued'}
                          >
                            {inv.counted_lineitems}/{inv.total_lineitems}
                          </Text>
                        </div>
                      </div>
                    </div>
                  ))}
                </BlockStack>
              )}
            </Card>

            {/* History in past 15 days — frozen record of what this manager
                already submitted; see comment on the `history` state above. */}
            <Card>
              <BlockStack gap="200">
                <Text variant="headingSm">History in past 15 days</Text>
                {historyLoading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : history.length === 0 ? (
                  <Text tone="subdued">No submitted invoices in the past 15 days.</Text>
                ) : (
                  <BlockStack gap="0">
                    {history.map((h, idx) => (
                      <div
                        key={h.id}
                        onClick={() => navigate(`/manager/po-receiving/history/${h.id}`)}
                        style={{
                          cursor: 'pointer',
                          padding: '12px 4px',
                          borderTop: idx > 0 ? '1px solid #f1f1f1' : undefined,
                        }}
                      >
                        {/* Same fixed-column fix as the pending list above —
                            Date/status need their own fixed width so they
                            stay lined up regardless of how long ref_no/
                            supplier_name happen to be on a given row. */}
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                          <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                            <BlockStack gap="0">
                              <span style={{ fontWeight: 600, textDecoration: 'underline' }}>{h.ref_no}</span>
                              <Text variant="bodySm" tone="subdued" truncate>{h.summary?.supplier_name}</Text>
                            </BlockStack>
                          </div>
                          <div style={{ flex: '0 0 150px', textAlign: 'center' }}>
                            <Text variant="bodySm" tone="subdued" alignment="center">{formatDate(h.created_at)}</Text>
                          </div>
                          <div style={{ flex: '0 0 110px', textAlign: 'right' }}>
                            <span style={{
                              display: 'inline-block', padding: '4px 12px', borderRadius: '999px',
                              background: '#E1E3E5', color: '#3F4448', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
                            }}>
                              {h.label}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerPOReceiving;
