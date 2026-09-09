import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, Spinner, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { StatusBadge, warehouseStatusLabel } from '../shared/transferStatus';
import { StatusBadge as BoxPoStatusBadge } from '../shared/boxPoStatus';

// Warehouse Home — a new "BOX PO" section at the very top (see
// claude/BOX_PO_FEATURE_SPEC.md section 9), showing only status='incoming'
// tasks — once a task becomes Received it disappears from here entirely.
// Uses the SAME Card-internal-heading style as the sections below
// (<Text variant="headingSm">), confirmed with Hera — not a divider style.
// Then Card 1: HQ-origin transfers (Loading/Pending/Good to go/
// In transit), clickable, checkbox only on Good to go rows (for batch
// dispatch), header select-all + "Dispatch selected" / "Dispatch all Good
// to go" buttons. Card 2: "Pick up from store" transfers (non-HQ origin) —
// no checkboxes, not clickable, Good to go reads as "Ready for Pick up".
// Spec doc section 5.
function WarehouseHome() {
  const navigate = useNavigate();
  const [hq, setHq] = useState([]);
  const [pickupFromStore, setPickupFromStore] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [dispatching, setDispatching] = useState(false);

  const [boxPos, setBoxPos] = useState([]);
  const [boxPosLoading, setBoxPosLoading] = useState(true);

  useEffect(() => {
    fetch('/api/box-po/warehouse/home')
      .then(r => r.json())
      .then(data => setBoxPos(Array.isArray(data) ? data : []))
      .catch(() => setBoxPos([]))
      .finally(() => setBoxPosLoading(false));
  }, []);

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
    <Page title="Warehouse" backAction={{ onAction: () => navigate('/') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {loading ? (
              <InlineStack align="center"><Spinner /></InlineStack>
            ) : (
              <>
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingSm">BOX PO</Text>
                    {boxPosLoading ? (
                      <InlineStack align="center"><Spinner size="small" /></InlineStack>
                    ) : boxPos.length === 0 ? (
                      <Text tone="subdued">No BOX PO tasks right now.</Text>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                          <thead>
                            <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>BOX PO number</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Supplier</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Total Boxes</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {boxPos.map(bp => (
                              <tr
                                key={bp.id}
                                style={{ borderBottom: '1px solid #f1f1f1', cursor: 'pointer' }}
                                onClick={() => navigate(`/warehouse/box-po/${bp.id}`)}
                              >
                                <td style={{ padding: '10px', textDecoration: 'underline' }}>{bp.box_po_number}</td>
                                <td style={{ padding: '10px' }}>{bp.supplier_name}</td>
                                <td style={{ padding: '10px' }}>{bp.total_boxes}</td>
                                <td style={{ padding: '10px' }}><BoxPoStatusBadge status={bp.status} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </BlockStack>
                </Card>

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
                          Dispatch selected
                        </Button>
                        <Button
                          variant="primary"
                          disabled={goodToGoIds.length === 0}
                          loading={dispatching}
                          onClick={dispatchAllGoodToGo}
                        >
                          Dispatch all Good to go
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
                              <th style={{ padding: '8px 10px', width: '32px' }}>
                                {goodToGoIds.length > 0 && (
                                  <input type="checkbox" checked={allGoodToGoSelected} onChange={toggleSelectAll} />
                                )}
                              </th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>From</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>To</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {hq.map(tr => (
                              <tr key={tr.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                                <td style={{ padding: '8px 10px' }}>
                                  {tr.status === 'good_to_go' && (
                                    <input
                                      type="checkbox"
                                      checked={selectedIds.includes(tr.id)}
                                      onChange={(e) => { e.stopPropagation(); toggleSelect(tr.id); }}
                                    />
                                  )}
                                </td>
                                <td
                                  style={{ padding: '10px', cursor: 'pointer', textDecoration: 'underline' }}
                                  onClick={() => navigate(`/warehouse/transfer/${tr.id}`)}
                                >
                                  {tr.transfer_no}
                                </td>
                                <td style={{ padding: '10px' }}>{tr.from_location}</td>
                                <td style={{ padding: '10px' }}>{tr.to_location}</td>
                                <td style={{ padding: '10px' }}><StatusBadge status={tr.status} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </BlockStack>
                </Card>

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
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>From</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>To</th>
                              <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pickupFromStore.map(tr => (
                              <tr key={tr.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                                <td style={{ padding: '10px' }}>{tr.transfer_no}</td>
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
              </>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default WarehouseHome;
