import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Spinner, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
// Store location: remembered per Shopify account, loaded before this page
// renders by ManagerLocationGate (2026-09-29) — replaces reading
// localStorage 'managerLocation' directly. See client/src/accountMemory.js.
import { getManagerLocation } from '../../accountMemory';
import { useDD, poEntries, DDList } from '../shared/ddPill';

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
// Not used since 2026-10-27 (the history Supplier has its own column and is
// cut with CSS ellipsis); kept per the project's no-silent-delete rule.
// eslint-disable-next-line no-unused-vars
function truncateSupplier(name) {
  if (!name) return '';
  return name.length > 15 ? `${name.slice(0, 15)}…` : name;
}

// List of invoices the buyer has sent to this location, still awaiting the
// manager's count. "Publish date" shown here is the buyer's Send to store
// date (sent_to_store_at), not the invoice's own date.
function ManagerPOReceiving() {
  const navigate = useNavigate();
  const location = getManagerLocation() || '';

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Full DD pills (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §7),
  // live from the Warehouse Schedule. Desktop: own column between Date and
  // Qty (split PO → one per line); phone: a line under Date / Qty.
  const dd = useDD({ poIds: invoices.map(inv => inv.id) });

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
    <Page title="Purchase Orders" backAction={{ onAction: () => navigate('/manager') }}>
      {/* Same technique as the top-level Hub Home page: layout switches
          purely on viewport width (768px breakpoint) via a media query, not
          JS/resize-listener logic. Both the desktop and mobile version of
          the supplier name and date are always rendered; the media query
          just toggles which one is visible. Below 768px the columns also
          get tighter fixed widths (see .po-col-*) so all of them still fit
          on one line instead of each wrapping onto its own line. */}
      {/* 2026-10-27 (Hera): both lists are CSS grids sharing the same first
          two columns (PO number | Supplier), so the two cards line up.
          Desktop column widths follow Hera's mock-up (9 : 37 : 35 : 9.5 :
          9.5); the PO number is not bold; Qty is left-aligned. Phone: PO
          number column ~8 characters wide with Qty (list) / Date (history)
          under it, Supplier takes the rest, the DD pills on line 2 start
          under Supplier; everything left-aligned except the progress
          (counted / total), which is right-aligned. Replaces the earlier
          flex columns (.po-row / .po-col-*) and the separate phone DD line. */}
      <style>{`
        .po-grid { display: grid; grid-template-columns: 9fr 37fr 35fr 9.5fr 9.5fr; column-gap: 12px; row-gap: 6px; align-items: center; }
        .po-list-row { grid-template-areas: "po sup dd qty ratio"; }
        .po-hist-row { grid-template-areas: "po sup rest rest rest"; }
        .po-a-po { grid-area: po; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .po-a-sup { grid-area: sup; min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .po-a-dd { grid-area: dd; min-width: 0; display: flex; justify-content: flex-start; }
        .po-a-qty { grid-area: qty; min-width: 0; white-space: nowrap; text-align: left; }
        .po-a-ratio { grid-area: ratio; text-align: right; white-space: nowrap; }
        .po-a-rest { grid-area: rest; display: flex; align-items: center; justify-content: flex-end; gap: 12px; min-width: 0; }
        .po-a-date { flex: 0 0 150px; text-align: center; white-space: nowrap; }
        .po-a-status { flex: 0 0 110px; text-align: right; }
        .po-date-mobile { display: none; }
        @media (max-width: 767px) {
          .po-grid { grid-template-columns: 8ch minmax(0, 1fr) auto; column-gap: 8px; }
          .po-list-row { grid-template-areas: "po sup ratio" "qty dd dd"; }
          .po-hist-row { grid-template-areas: "po sup status" "date date ."; }
          .po-a-po { overflow: visible; }
          .po-a-qty { overflow: visible; align-self: start; padding-top: 3px; }
          .po-a-rest { display: contents; }
          .po-a-date { grid-area: date; text-align: left; }
          .po-a-status { grid-area: status; }
          .po-date-desktop { display: none; }
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
                      {/* 2026-10-22 (Hera): the date column is no longer shown
                          here, and the supplier has its own column (bold)
                          instead of sitting under the PO number. */}
                      <div className="po-grid po-list-row">
                        <div className="po-a-po">{inv.po_number || inv.invoice_number}</div>
                        <div className="po-a-sup">{inv.supplier_name}</div>
                        <div className="po-a-dd">
                          <DDList full entries={poEntries(dd, inv.id)} />
                        </div>
                        <div className="po-a-qty">
                          <Text variant="bodySm" tone="subdued">Qty: {inv.total_quantity}</Text>
                        </div>
                        <div className="po-a-ratio">
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
                      {/* Phone: the DD pills are line 2 of the grid above (under
                          Supplier) since 2026-10-27 — no separate DD line. */}
                    </div>
                  ))}
                </BlockStack>
              )}
            </Card>

            {/* History in past 15 days — frozen record of what this manager
                already submitted; see comment on the `history` state above. */}
            <Card>
              <BlockStack gap="200">
                {/* No card title any more (2026-10-22, Hera; was "History in past 15 days"). */}
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
                        {/* 2026-10-27 (Hera): same first two columns as the
                            list above — PO number (not bold), Supplier (bold,
                            own column); phone: Date under the PO number. */}
                        <div className="po-grid po-hist-row">
                          <div className="po-a-po" style={{ textDecoration: 'underline' }}>{h.ref_no}</div>
                          <div className="po-a-sup">{h.summary?.supplier_name}</div>
                          <div className="po-a-rest">
                          <div className="po-a-date">
                            <span className="po-date-desktop">
                              <Text variant="bodySm" tone="subdued" alignment="center">{formatDate(h.created_at)}</Text>
                            </span>
                            <span className="po-date-mobile">
                              <Text variant="bodySm" tone="subdued">{formatDateCompact(h.created_at)}</Text>
                            </span>
                          </div>
                          <div className="po-a-status">
                            {/* "Committed" (green) once Purchasing committed the PO (2026-10-22, Hera). */}
                            <span style={{
                              display: 'inline-block', padding: '4px 12px', borderRadius: '999px',
                              background: h.label === 'Committed' ? '#CDFEE1' : '#E1E3E5',
                              color: h.label === 'Committed' ? '#0C5132' : '#3F4448', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
                            }}>
                              {h.label}
                            </span>
                          </div>
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
