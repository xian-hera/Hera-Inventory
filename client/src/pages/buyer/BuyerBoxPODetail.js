import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import { StatusBadge } from '../shared/boxPoStatus';

function formatDateOnly(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).slice(0, 10);
  const [y, m, d] = s.split('-');
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  if (!y || !m || !d) return '';
  return `${y}.${months[Number(m) - 1]}.${d}`;
}

// Shared Buyer-side BOX PO detail page (see claude/BOX_PO_FEATURE_SPEC.md
// sections 4/5/6): the SAME route/component renders all three statuses.
//  - incoming: Buyer now has the same counting powers Warehouse has on its
//    own incoming page (2026-09-25, Hera) — a Box qty stepper + confirm
//    button per row, and a Submit button top-right that's enabled once every
//    row is counted_confirmed. Submitting flips the task to 'received' via
//    the same /:id/count and /:id/submit endpoints Warehouse uses — those
//    routes don't distinguish who's calling them, so a task counted by
//    either the Buyer or Warehouse behaves identically from here on.
//  - received: Confirm button right-aligned on the header row; both Buyer's
//    and Warehouse's notes are shown; table gains "Box received" + a colored
//    checkmark circle per row (green if it matches BOX qty, orange filled
//    circle + red bold text if it doesn't).
//  - confirmed: fully read-only again; table trimmed to just
//    Destination Location + Box received (no BOX qty column, no styling).
function BuyerBoxPODetail() {
  const navigate = useNavigate();
  const { id } = useParams();

  const [boxPo, setBoxPo] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');

  // Incoming-status counting (mirrors WarehouseBoxPODetail.js)
  const [draftCounts, setDraftCounts] = useState({}); // itemId -> string draft value
  const [countingId, setCountingId] = useState(null);
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/box-po/${id}`)
      .then(r => r.json())
      .then(data => {
        setBoxPo(data.boxPo || null);
        const its = Array.isArray(data.items) ? data.items : [];
        setItems(its);
        setDraftCounts(prev => {
          const next = { ...prev };
          its.forEach(it => { if (next[it.id] === undefined) next[it.id] = String(it.box_qty); });
          return next;
        });
      })
      .catch(() => setLoadError('Failed to load this BOX PO.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleConfirm = async () => {
    setConfirming(true);
    setConfirmError('');
    try {
      const res = await fetch(`/api/box-po/${id}/confirm`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to confirm');
      load();
    } catch (e) {
      setConfirmError(e.message);
    } finally {
      setConfirming(false);
    }
  };

  const updateDraft = (itemId, value) => {
    const qty = value === '' ? '' : Math.max(0, parseInt(value, 10) || 0);
    setDraftCounts(prev => ({ ...prev, [itemId]: qty === '' ? '' : String(qty) }));
  };

  const confirmCount = async (itemId) => {
    const value = draftCounts[itemId];
    const qty = parseInt(value, 10);
    // A cleared/blank input must not silently no-op the click — otherwise
    // the row just stays uncounted with no indication why, quietly blocking
    // Submit until someone notices.
    if (!Number.isFinite(qty)) {
      setActionError('Enter a number for Box received before confirming this row.');
      return;
    }
    setCountingId(itemId);
    setActionError('');
    try {
      const res = await fetch(`/api/box-po/${id}/count`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, boxReceived: qty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to confirm count');
      load();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setCountingId(null);
    }
  };

  const allConfirmed = items.length > 0 && items.every(it => it.counted_confirmed);

  const handleSubmit = async () => {
    setSubmitting(true);
    setActionError('');
    try {
      const res = await fetch(`/api/box-po/${id}/submit`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit');
      navigate('/buyer/po-receiving/box-po');
    } catch (e) {
      setActionError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Page title="BOX PO" backAction={{ onAction: () => navigate('/buyer/po-receiving/box-po') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }

  if (loadError || !boxPo) {
    return (
      <Page title="BOX PO" backAction={{ onAction: () => navigate('/buyer/po-receiving/box-po') }}>
        <Layout><Layout.Section><Banner tone="critical">{loadError || 'Not found.'}</Banner></Layout.Section></Layout>
      </Page>
    );
  }

  const status = boxPo.status; // 'incoming' | 'received' | 'confirmed'

  return (
    <Page
      title={boxPo.box_po_number}
      titleMetadata={<StatusBadge status={status} />}
      backAction={{ onAction: () => navigate('/buyer/po-receiving/box-po') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {confirmError && <Banner tone="critical" onDismiss={() => setConfirmError('')}>{confirmError}</Banner>}
            {actionError && <Banner tone="critical" onDismiss={() => setActionError('')}>{actionError}</Banner>}

            <InlineStack align="space-between" blockAlign="center" wrap>
              <InlineStack gap="400" wrap>
                <Text variant="bodySm" tone="subdued">Supplier: {boxPo.supplier_name}</Text>
                <Text variant="bodySm" tone="subdued">Total Boxes: {boxPo.total_boxes}</Text>
                {boxPo.box_date && <Text variant="bodySm" tone="subdued">Date: {formatDateOnly(boxPo.box_date)}</Text>}
              </InlineStack>
              {status === 'incoming' && (
                <Button variant="primary" disabled={!allConfirmed} loading={submitting} onClick={handleSubmit}>
                  Submit
                </Button>
              )}
              {status === 'received' && (
                <Button variant="primary" onClick={handleConfirm} loading={confirming}>Confirm</Button>
              )}
            </InlineStack>

            {boxPo.buyer_note && (
              <Text tone="subdued" variant="bodySm">Buyer note: {boxPo.buyer_note}</Text>
            )}
            {status !== 'incoming' && boxPo.warehouse_note && (
              <Text tone="subdued" variant="bodySm">Warehouse note: {boxPo.warehouse_note}</Text>
            )}

            <Card>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                      <th style={TH_STYLE}>Destination Location</th>
                      {status === 'incoming' && <th style={TH_STYLE}>Box qty</th>}
                      {status === 'received' && <th style={TH_STYLE}>Box qty</th>}
                      {status === 'received' && <th style={TH_STYLE}>Box received</th>}
                      {status === 'confirmed' && <th style={TH_STYLE}>Box received</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => {
                      const mismatched = status === 'incoming'
                        ? it.counted_confirmed && Number(it.box_received) !== Number(it.box_qty)
                        : it.box_received != null && Number(it.box_received) !== Number(it.box_qty);
                      return (
                        <tr key={it.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                          <td style={TD_STYLE}>{it.location}</td>
                          {status === 'incoming' && (
                            <td style={TD_STYLE}>
                              {it.counted_confirmed ? (
                                <InlineStack gap="150" blockAlign="center">
                                  <Text
                                    as="span"
                                    variant="bodySm"
                                    fontWeight={mismatched ? 'bold' : undefined}
                                    tone={mismatched ? 'critical' : undefined}
                                  >
                                    {it.box_received}
                                  </Text>
                                  <span style={mismatched ? CIRCLE_ORANGE_STYLE : CIRCLE_GREEN_STYLE}>✓</span>
                                </InlineStack>
                              ) : (
                                <InlineStack gap="150" blockAlign="center">
                                  <input
                                    type="number"
                                    min="0"
                                    value={draftCounts[it.id] ?? ''}
                                    onChange={e => updateDraft(it.id, e.target.value)}
                                    style={{
                                      width: '72px', padding: '4px 6px', borderRadius: '6px',
                                      border: '1px solid #c9cccf', fontSize: '13px',
                                    }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => confirmCount(it.id)}
                                    disabled={countingId === it.id}
                                    style={CIRCLE_BUTTON_STYLE}
                                    title="Confirm count"
                                  >
                                    ✓
                                  </button>
                                </InlineStack>
                              )}
                            </td>
                          )}
                          {status === 'received' && <td style={TD_STYLE}>{it.box_qty}</td>}
                          {status === 'received' && (
                            <td style={TD_STYLE}>
                              <InlineStack gap="150" blockAlign="center">
                                <Text
                                  as="span"
                                  variant="bodySm"
                                  fontWeight={mismatched ? 'bold' : undefined}
                                  tone={mismatched ? 'critical' : undefined}
                                >
                                  {it.box_received}
                                </Text>
                                <span style={mismatched ? CIRCLE_ORANGE_STYLE : CIRCLE_GREEN_STYLE}>✓</span>
                              </InlineStack>
                            </td>
                          )}
                          {status === 'confirmed' && <td style={TD_STYLE}>{it.box_received}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

const TH_STYLE = { padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' };
const TD_STYLE = { padding: '10px' };

const CIRCLE_BASE_STYLE = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '18px', height: '18px', borderRadius: '50%',
  color: '#fff', fontSize: '12px', fontWeight: 700, lineHeight: 1,
};
const CIRCLE_GREEN_STYLE = { ...CIRCLE_BASE_STYLE, background: '#108043' };
const CIRCLE_ORANGE_STYLE = { ...CIRCLE_BASE_STYLE, background: '#FFA500' };

const CIRCLE_BUTTON_STYLE = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '22px', height: '22px', borderRadius: '50%',
  border: '1px solid #c9cccf', background: '#f1f2f3',
  color: '#108043', fontSize: '13px', fontWeight: 700, lineHeight: 1,
  cursor: 'pointer', padding: 0,
};

export default BuyerBoxPODetail;
