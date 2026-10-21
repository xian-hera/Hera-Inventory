import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Banner
} from '@shopify/polaris';
// Spinner no longer imported (2026-10-21): UI rule #1 (claude/UI_RULES_READ_FIRST.md)
// — loading states in this file now show the text "Loading..." instead.
import { useNavigate } from 'react-router-dom';
import { StatusBadge, HoldBadge, TagPills } from '../shared/transferStatus';
import { FilterButtons, FILTER_ALL } from './whShared';

// Date column (2026-10-05, Hera): creation date of the transfer, shown right
// after the Transfer column on all three transfer cards. YYYY-MM-DD on
// desktop, MM-DD on phones — both are rendered and a single @media rule
// (breakpoint 767/768px, same approach as Home.js) picks which is visible.
// Computed in America/Toronto so a transfer created in the evening doesn't
// show up as the next (UTC) day.
const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
});
function formatCreatedDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return DATE_FMT.format(d); // en-CA => YYYY-MM-DD
}
function DateCell({ value }) {
  const full = formatCreatedDate(value);
  return (
    <>
      <span className="wh-date-desktop">{full}</span>
      <span className="wh-date-mobile">{full.slice(5)}</span>
    </>
  );
}
const DATE_CSS = `
.wh-date-mobile { display: none; }
@media (max-width: 767px) {
  .wh-date-desktop { display: none; }
  .wh-date-mobile { display: inline; }
}
`;

// Warehouse Home. (The "BOX PO" section that used to be at the very top was
// removed together with the whole BOX PO feature, 2026-10-21, Hera.)
// Card 1: HQ-origin transfers (Loading/Pending/Good to go/
// In transit), clickable, checkbox only on Good to go rows (for batch
// dispatch), header select-all + "Dispatch selected" / "Dispatch all Good
// to go" buttons. Card 2: "Pick up from store" transfers (neither from nor to
// is HQ) — no checkboxes, Good to go reads as "Ready for Pick up". As of
// 2026-10-05 the transfer number is clickable (underlined) into a read-only
// detail page with no actions (WarehouseTransferViewDetail.js).
// Spec doc section 5.
// (2026-10-21, Hera: the checkboxes and both dispatch buttons were removed
// from the HQ transfers card, which now lists only Draft + Pending — see
// the hqList comment below.)
//
// Warehouse tabs (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §10):
// this page is shown inside WarehouseShell as the "HQ Transfers" tab —
//   section="hq" → HQ transfers card + Receiving to HQ card.
// The "Temp" tab and its "Pick up from store" card (and that card's
// read-only detail page) were removed 2026-10-21 (Hera: WH no longer needs
// them); "Receiving to HQ" moved from Temp to here because WH receives
// store → HQ transfers on its detail page.
// (no section = all cards, the old standalone page — kept for reference, no
// route uses it any more). inTabs hides this page's own title / back arrow.
// Detail pages get { state: { from } } so their back button returns here.
function WarehouseHome({ inTabs = false, section } = {}) {
  const showHq = !section || section === 'hq';
  const backTo = section === 'hq' ? '/warehouse/hq-transfers' : '/warehouse';
  const navigate = useNavigate();
  const [hq, setHq] = useState([]);
  const [receivingToHq, setReceivingToHq] = useState([]);
  const [receivingLoading, setReceivingLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // HQ Transfers tag filter (2026-10-21): All or one tag of the listed transfers.
  const [tagFilter, setTagFilter] = useState(FILTER_ALL);

  const fetchHome = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/warehouse/home');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setHq(data.hq || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHome(); }, [fetchHome]);

  // 改动二第1点 (2026-09-15): "Receiving to HQ" — In transit/Receiving
  // transfers whose to_location is HQ. Warehouse acts as the receiving/
  // counting role here (see WarehouseTransferReceivingDetail.js).
  useEffect(() => {
    setReceivingLoading(true);
    fetch('/api/transfers/warehouse/receiving-to-hq')
      .then(r => r.json())
      .then(data => setReceivingToHq(Array.isArray(data) ? data : []))
      .catch(() => setReceivingToHq([]))
      .finally(() => setReceivingLoading(false));
  }, []);

  // HQ Transfers tab (Hera 2026-10-21): only Draft and Pending transfers;
  // the "Mark selected In Transit" / "Mark all Ready to Ship In Transit"
  // buttons (and the checkbox column they needed) were removed — transfers
  // are now marked In Transit by Go! on the Schedule, or on the transfer page.
  const hqList = hq.filter(tr => tr.status === 'loading' || tr.status === 'pending');
  const hqTags = [...new Set(hqList.flatMap(tr => (Array.isArray(tr.tags) ? tr.tags.flat(Infinity) : [])).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  const tagValue = tagFilter !== FILTER_ALL && !hqTags.includes(tagFilter) ? FILTER_ALL : tagFilter;
  const hqVisible = tagValue === FILTER_ALL ? hqList : hqList.filter(tr => (tr.tags || []).flat(Infinity).includes(tagValue));

  return (
    <Page
      title={inTabs ? undefined : 'Warehouse'}
      backAction={inTabs ? undefined : { onAction: () => navigate('/') }}
    >
      <style>{DATE_CSS}</style>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {loading ? (
              <InlineStack align="center"><Text tone="subdued">Loading...</Text></InlineStack>
            ) : (
              <>
                {showHq && (
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingSm">HQ transfers</Text>
                    {hqTags.length > 0 && <FilterButtons values={hqTags} value={tagValue} onChange={setTagFilter} />}

                    {hqVisible.length === 0 ? (
                      <Text tone="subdued">No transfers right now.</Text>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                          <thead>
                            <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Tag</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Date</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>To</th>
                              <th style={{ padding: '8px 10px', textAlign: 'right', color: '#6d7175' }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {hqVisible.map(tr => (
                              <tr key={tr.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                                <td
                                  style={{ padding: '10px', cursor: 'pointer' }}
                                  onClick={() => navigate(`/warehouse/transfer/${tr.id}`, { state: { from: backTo } })}
                                >
                                  <span style={{ textDecoration: 'underline' }}>{tr.shopify_transfer_name || tr.transfer_no}</span>
                                </td>
                                <td style={{ padding: '10px' }}><TagPills tags={tr.tags} /></td>
                                <td style={{ padding: '10px', whiteSpace: 'nowrap' }}><DateCell value={tr.created_at} /></td>
                                <td style={{ padding: '10px' }}>{tr.to_location}</td>
                                <td style={{ padding: '10px' }}>
                                  <InlineStack gap="100" align="end"><StatusBadge status={tr.status} />{tr.on_hold && <HoldBadge />}</InlineStack>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </BlockStack>
                </Card>
                )}

                {showHq && (
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingSm">Receiving to HQ</Text>
                    {receivingLoading ? (
                      <InlineStack align="center"><Text tone="subdued">Loading...</Text></InlineStack>
                    ) : receivingToHq.length === 0 ? (
                      <Text tone="subdued">No transfers right now.</Text>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                          <thead>
                            <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Date</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>From</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>To</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {receivingToHq.map(tr => (
                              <tr key={tr.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                                <td
                                  style={{ padding: '10px', cursor: 'pointer' }}
                                  onClick={() => navigate(`/warehouse/transfer/receiving/${tr.id}`, { state: { from: backTo } })}
                                >
                                  <span style={{ textDecoration: 'underline' }}>{tr.shopify_transfer_name || tr.transfer_no}</span>
                                  {(tr.tags || []).length > 0 && <div style={{ marginTop: '4px' }}><TagPills tags={tr.tags} /></div>}
                                </td>
                                <td style={{ padding: '10px', whiteSpace: 'nowrap' }}><DateCell value={tr.created_at} /></td>
                                <td style={{ padding: '10px' }}>{tr.from_location}</td>
                                <td style={{ padding: '10px' }}>{tr.to_location}</td>
                                <td style={{ padding: '10px' }}>
                                  <InlineStack gap="100"><StatusBadge status={tr.status} />{tr.on_hold && <HoldBadge />}</InlineStack>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </BlockStack>
                </Card>
                )}
              </>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default WarehouseHome;
