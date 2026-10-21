import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, Banner
} from '@shopify/polaris';
// Spinner no longer imported (2026-10-21): UI rule #1 (claude/UI_RULES_READ_FIRST.md)
// — loading states in this file now show the text "Loading..." instead.
import { useNavigate } from 'react-router-dom';
import { StatusBadge, warehouseStatusLabel, HoldBadge, TagPills } from '../shared/transferStatus';

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
//
// Warehouse tabs (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §10):
// this page is now shown inside WarehouseShell as two tabs —
//   section="hq"   → "HQ Transfers" tab: only the HQ transfers card
//   section="temp" → "Temp" tab: Receiving to HQ, Pick up from store
// (no section = all cards, the old standalone page — kept for reference, no
// route uses it any more). inTabs hides this page's own title / back arrow.
// Detail pages get { state: { from } } so their back button returns here.
function WarehouseHome({ inTabs = false, section } = {}) {
  const showHq = !section || section === 'hq';
  const showTemp = !section || section === 'temp';
  const backTo = section === 'hq' ? '/warehouse/hq-transfers' : section === 'temp' ? '/warehouse/temp' : '/warehouse';
  const navigate = useNavigate();
  const [hq, setHq] = useState([]);
  const [pickupFromStore, setPickupFromStore] = useState([]);
  const [receivingToHq, setReceivingToHq] = useState([]);
  const [receivingLoading, setReceivingLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [dispatching, setDispatching] = useState(false);

  const fetchHome = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/warehouse/home');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setHq(data.hq || []);
      setPickupFromStore(data.pickupFromStore || []);
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

  const goodToGoIds = hq.filter(tr => tr.status === 'good_to_go').map(tr => tr.id);
  const allGoodToGoSelected = goodToGoIds.length > 0 && goodToGoIds.every(id => selectedIds.includes(id));

  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleSelectAll = () => {
    setSelectedIds(allGoodToGoSelected ? [] : goodToGoIds);
  };

  const dispatchSelected = async () => {
    if (selectedIds.length === 0) return;
    setDispatching(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/warehouse/dispatch-selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      const failed = (data.results || []).filter(r => !r.success);
      if (failed.length > 0) setError(`${failed.length} transfer(s) failed to dispatch: ${failed.map(f => f.error).join('; ')}`);
      setSelectedIds([]);
      await fetchHome();
    } catch (e) {
      setError(e.message);
    } finally {
      setDispatching(false);
    }
  };

  const dispatchAllGoodToGo = async () => {
    setDispatching(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/warehouse/dispatch-all-good-to-go', { method: 'POST' });
      const data = await res.json();
      const failed = (data.results || []).filter(r => !r.success);
      if (failed.length > 0) setError(`${failed.length} transfer(s) failed to dispatch: ${failed.map(f => f.error).join('; ')}`);
      setSelectedIds([]);
      await fetchHome();
    } catch (e) {
      setError(e.message);
    } finally {
      setDispatching(false);
    }
  };

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
                    <InlineStack align="space-between" blockAlign="center" wrap>
                      <Text variant="headingSm">HQ transfers</Text>
                      <InlineStack gap="200">
                        <Button
                          disabled={selectedIds.length === 0}
                          loading={dispatching}
                          onClick={dispatchSelected}
                        >
                          Mark selected In Transit
                        </Button>
                        <Button
                          variant="primary"
                          disabled={goodToGoIds.length === 0}
                          loading={dispatching}
                          onClick={dispatchAllGoodToGo}
                        >
                          Mark all Ready to Ship In Transit
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    {hq.length === 0 ? (
                      <Text tone="subdued">No transfers right now.</Text>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                          <thead>
                            <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                              {/* 2026-10-05 indentation fix: this checkbox column used
                                  to be ALWAYS rendered at a fixed 32px (+20px padding)
                                  even when no row is Good to go and every cell in it was
                                  empty — an empty ~50px gutter in front of "Transfer",
                                  very visible on a phone. Now only rendered when at least
                                  one row actually has a checkbox, and shrunk to just
                                  hug the checkbox (width 1%, tighter padding). */}
                              {goodToGoIds.length > 0 && (
                                <th style={{ padding: '8px 4px 8px 10px', width: '1%' }}>
                                  <input type="checkbox" checked={allGoodToGoSelected} onChange={toggleSelectAll} />
                                </th>
                              )}
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Date</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>From</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>To</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {hq.map(tr => (
                              <tr key={tr.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                                {goodToGoIds.length > 0 && (
                                  <td style={{ padding: '8px 4px 8px 10px', width: '1%' }}>
                                    {tr.status === 'good_to_go' && (
                                      <input
                                        type="checkbox"
                                        checked={selectedIds.includes(tr.id)}
                                        onChange={(e) => { e.stopPropagation(); toggleSelect(tr.id); }}
                                      />
                                    )}
                                  </td>
                                )}
                                <td
                                  style={{ padding: '10px', cursor: 'pointer' }}
                                  onClick={() => navigate(`/warehouse/transfer/${tr.id}`, { state: { from: backTo } })}
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

                {showTemp && (
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

                {showTemp && (
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingSm">Pick up from store</Text>
                    {pickupFromStore.length === 0 ? (
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
                            {pickupFromStore.map(tr => (
                              <tr key={tr.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                                {/* 2026-10-05: now clickable into a read-only detail page */}
                                <td
                                  style={{ padding: '10px', cursor: 'pointer' }}
                                  onClick={() => navigate(`/warehouse/transfer/view/${tr.id}`, { state: { from: backTo } })}
                                >
                                  <span style={{ textDecoration: 'underline' }}>{tr.shopify_transfer_name || tr.transfer_no}</span>
                                  {(tr.tags || []).length > 0 && <div style={{ marginTop: '4px' }}><TagPills tags={tr.tags} /></div>}
                                </td>
                                <td style={{ padding: '10px', whiteSpace: 'nowrap' }}><DateCell value={tr.created_at} /></td>
                                <td style={{ padding: '10px' }}>{tr.from_location}</td>
                                <td style={{ padding: '10px' }}>{tr.to_location}</td>
                                <td style={{ padding: '10px' }}>
                                  <StatusBadge status={tr.status} label={warehouseStatusLabel(tr.status, true)} />
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
