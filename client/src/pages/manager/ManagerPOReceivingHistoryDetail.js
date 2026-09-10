import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Banner, Spinner,
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';

// Read-only "History in past 15 days" detail page for a PO Receiving invoice
// the manager already submitted (see ManagerPOReceiving.js's History section,
// and server/routes/poInvoices.js's manager/receiving/:id/submit for how the
// row was frozen). A brand-new, separate component rather than a stripped
// ManagerPOReceivingDetail.js — this page reads manager_history.detail (a
// frozen snapshot, including wig_number values captured at submit time), not
// the live po_invoice_items table. No Note button, no Submit button (there's
// nothing left to submit or reply to on a frozen record) — Export PDF stays,
// per Hera (2026-09-10 correction): it calls the same live
// GET /:id/export-pdf route the live page uses (via the invoice_id captured
// in the frozen snapshot), so it always reflects the invoice's current
// quantities the same way it always has, not a frozen copy.

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ManagerPOReceivingHistoryDetail() {
  const navigate = useNavigate();
  const { historyId } = useParams();

  const [entry, setEntry]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [itemFilter, setItemFilter] = useState('all');
  const [exportingPdf, setExportingPdf] = useState(false);

  const fetchEntry = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/manager-history/${historyId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.kind !== 'po_invoice') throw new Error('This history entry is not a PO Receiving submission.');
      setEntry(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [historyId]);

  useEffect(() => { fetchEntry(); }, [fetchEntry]);

  // Same Export PDF as ManagerPOReceivingDetail.js's handleExportPdf — the
  // export endpoint always reads live po_invoice_items by invoice id (never
  // this frozen detail.items), so this always exports the invoice's current
  // state, exactly like it does from the live page.
  const handleExportPdf = async () => {
    if (!entry?.detail?.invoice_id) return;
    setExportingPdf(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/${entry.detail.invoice_id}/export-pdf`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${entry.detail.po_number || entry.detail.invoice_number || 'invoice'}-export.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setExportingPdf(false);
    }
  };

  if (loading) {
    return (
      <Page title="History" backAction={{ onAction: () => navigate('/manager/po-receiving') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }
  if (!entry) {
    return (
      <Page title="History" backAction={{ onAction: () => navigate('/manager/po-receiving') }}>
        <Layout><Layout.Section>{error && <Banner tone="critical">{error}</Banner>}</Layout.Section></Layout>
      </Page>
    );
  }

  const detail = entry.detail || {};
  const items = detail.items || [];

  const totalCount = items.length;
  const countedCount = items.filter(i => i.store_count !== null && i.store_count !== undefined).length;
  const notCountedCount = totalCount - countedCount;
  const offQtyCount = items.filter(i => {
    const counted = i.store_count !== null && i.store_count !== undefined;
    return counted && Number(i.store_count) !== Number(i.quantity);
  }).length;

  const ITEM_FILTERS = [
    { key: 'all', label: 'All', count: totalCount },
    { key: 'not_counted', label: 'Not counted', count: notCountedCount },
    { key: 'off_qty', label: 'Off qty', count: offQtyCount },
  ];

  const filteredItems = items.filter(item => {
    if (itemFilter === 'all') return true;
    const counted = item.store_count !== null && item.store_count !== undefined;
    if (itemFilter === 'not_counted') return !counted;
    if (itemFilter === 'off_qty') return counted && Number(item.store_count) !== Number(item.quantity);
    return true;
  });

  return (
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      <Page
        title={detail.po_number || detail.invoice_number || entry.ref_no}
        backAction={{ onAction: () => navigate('/manager/po-receiving') }}
        secondaryActions={[
          { content: 'Export PDF', onAction: handleExportPdf, loading: exportingPdf, disabled: exportingPdf || !detail.invoice_id },
        ]}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

              <InlineStack align="space-between" blockAlign="center" wrap>
                <InlineStack gap="300" wrap blockAlign="center">
                  <Text fontWeight="semibold">{detail.supplier_name}</Text>
                  <Text tone="subdued" variant="bodySm">{detail.location}</Text>
                  <Text tone="subdued" variant="bodySm">{countedCount}/{totalCount} counted</Text>
                </InlineStack>
                <InlineStack gap="200" blockAlign="center">
                  <span style={{
                    display: 'inline-block', padding: '4px 12px', borderRadius: '999px',
                    background: '#E1E3E5', color: '#3F4448', fontSize: '13px', fontWeight: 600,
                  }}>
                    {entry.label}
                  </span>
                  <Text variant="bodySm" tone="subdued">{formatDate(entry.created_at)}</Text>
                </InlineStack>
              </InlineStack>

              <InlineStack gap="200" wrap>
                {ITEM_FILTERS.map(f => {
                  const active = itemFilter === f.key;
                  return (
                    <button
                      key={f.key}
                      onClick={() => setItemFilter(f.key)}
                      style={{
                        padding: '10px 20px',
                        borderRadius: '999px',
                        border: active ? '1.5px solid #008060' : '1.5px solid #c9cccf',
                        background: active ? '#008060' : 'white',
                        color: active ? 'white' : '#202223',
                        fontSize: '15px',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {f.label} <span style={{ fontWeight: 700 }}>{f.count}</span>
                    </button>
                  );
                })}
              </InlineStack>

              <Card>
                <div style={{ overflowX: 'auto' }}>
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
                      {filteredItems.map(item => {
                        const counted = item.store_count !== null && item.store_count !== undefined;
                        const matches = counted && Number(item.store_count) === Number(item.quantity);
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
                                <span style={{ color: '#008060', fontWeight: 700 }}>✓ {item.store_count}</span>
                              ) : (
                                <span style={{ color: '#d72c0d', fontWeight: 700 }}>{item.store_count}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
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

export default ManagerPOReceivingHistoryDetail;
