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

// Mobile-only compact date: drops the "YYYY." prefix when the date falls in
// the current year — "2026.SEP.16 08:49" becomes "SEP.16 08:49" — since on a
// narrow phone screen the year is rarely useful and its 5 extra characters
// were part of what pushed this row's columns into wrapping onto their own
// lines (see the flex row below). Only a genuinely past/future year keeps it.
function formatDateCompact(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const datePart = `${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')}`;
  const timePart = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  const yearPrefix = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}.`;
  return `${yearPrefix}${datePart} ${timePart}`;
}

// Mobile-only supplier truncation — max 15 characters, ellipsis beyond that.
function truncateSupplier(name) {
  if (!name) return '';
  return name.length > 15 ? `${name.slice(0, 15)}…` : name;
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
      {/* Same technique as the top-level Hub Home page: layout switches
          purely on viewport width (768px breakpoint) via a media query, not
          JS/resize-listener logic. Both the desktop and mobile version of
          the supplier name and date are always rendered; the media query
          just toggles which one is visible. Below 768px the columns also
          get tighter fixed widths (see .po-col-*) so all of them still fit
          on one line instead of each wrapping onto its own line. */}
      <style>{`
        .po-row { display: flex; align-items: center; flex-wrap: nowrap; gap: 12px; }
        .po-col-first { flex: 1 1 160px; min-width: 0; }
        .po-col-date { flex: 0 0 150px; text-align: center; }
        .po-col-qty { flex: 0 0 100px; text-align: center; }
        .po-col-ratio { flex: 0 0 70px; text-align: right; }
        .po-col-status { flex: 0 0 110px; text-align: right; }
        .po-supplier-mobile, .po-date-mobile { display: none; }
        @media (max-width: 767px) {
          .po-row { gap: 6px; }
          .po-col-first { flex: 1 1 90px; }
          .po-col-date { flex: 0 0 100px; }
          .po-col-qty { flex: 0 0 80px; }
          .po-col-ratio { flex: 0 0 55px; }
          .po-col-status { flex: 0 0 85px; }
          .po-supplier-desktop, .po-date-desktop { display: none; }
          .po-supplier-mobile { display: inline; font-size: 11px; color: #6d7175; }
          .po-date-mobile { display: inline; }
        }
      `}</style>
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
                      <div className="po-row">
                        <div className="po-col-first">
                          <BlockStack gap="0">
                            <Text fontWeight="semibold" truncate>{inv.po_number || inv.invoice_number}</Text>
                            <span className="po-supplier-desktop">
                              <Text variant="bodySm" tone="subdued" truncate>{inv.supplier_name}</Text>
                            </span>
                            <span className="po-supplier-mobile">{truncateSupplier(inv.supplier_name)}</span>
                          </BlockStack>
                        </div>
                        <div className="po-col-date">
                          <span className="po-date-desktop">
                            <Text variant="bodySm" tone="subdued" alignment="center">{formatDate(inv.sent_to_store_at)}</Text>
                          </span>
                          <span className="po-date-mobile">
                            <Text variant="bodySm" tone="subdued" alignment="center">{formatDateCompact(inv.sent_to_store_at)}</Text>
                          </span>
                        </div>
                        <div className="po-col-qty">
                          <Text variant="bodySm" tone="subdued" alignment="center">Qty: {inv.total_quantity}</Text>
                        </div>
                        <div className="po-col-ratio">
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
                        <div className="po-row">
                          <div className="po-col-first">
                            <BlockStack gap="0">
                              <span style={{ fontWeight: 600, textDecoration: 'underline' }}>{h.ref_no}</span>
                              <span className="po-supplier-desktop">
                                <Text variant="bodySm" tone="subdued" truncate>{h.summary?.supplier_name}</Text>
                              </span>
                              <span className="po-supplier-mobile">{truncateSupplier(h.summary?.supplier_name)}</span>
                            </BlockStack>
                          </div>
                          <div className="po-col-date">
                            <span className="po-date-desktop">
                              <Text variant="bodySm" tone="subdued" alignment="center">{formatDate(h.created_at)}</Text>
                            </span>
                            <span className="po-date-mobile">
                              <Text variant="bodySm" tone="subdued" alignment="center">{formatDateCompact(h.created_at)}</Text>
                            </span>
                          </div>
                          <div className="po-col-status">
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

      {/* Bottom safe-area spacer (2026-09-18, Hera): same fix as
          ManagerWigDemo.js — on Android, opening this page inside Shopify's
          own app leaves the last card sitting right under Shopify's native
          bottom button/nav bar, unreachable to tap. See the
          .mobile-bottom-safe-area comment in client/public/index.html for
          the full explanation; only takes effect on phone-width screens.
          NOTE (2026-09-18, Hera): this div was added here once already, but
          a separate edit to this file's mobile layout (the .po-* column
          system above) replaced the whole return block and dropped it —
          that's why the bottom-padding fix "stopped working". Re-added here,
          now after the .po-* layout changes rather than before them. */}
      <div className="mobile-bottom-safe-area" aria-hidden="true" />
    </Page>
  );
}

export default ManagerPOReceiving;
