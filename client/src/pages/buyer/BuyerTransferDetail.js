import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import { StatusBadge } from '../shared/transferStatus';

// Buyer's Transfer detail page — five render modes keyed off transfer.status
// (spec doc section 4):
//   Loading      — read-only, Cancel + Refresh location qty. Over-stock rows
//                  (transfer qty > current from-location qty) are highlighted
//                  and pinned to top, but not editable here.
//   Pending      — only the over-stock rows get a checkbox + editable
//                  stepper (defaulting to the current from-location qty);
//                  everything else stays a plain read-only number. Delete
//                  selected line items, Confirm.
//   Good to go / In transit / Receiving — shared read-only render with an
//                  extra {to_location} qty column
//   Counted      — editable Received qty (reuses the count endpoint),
//                  mismatched rows highlighted + pinned to top, Refresh + Commit
//   Committed    — read-only, last column renamed "Transferred qty"
//
// Note: unlike Warehouse's Loading page and Manager's Receiving page, the
// spec's Buyer-side status walkthrough never lists an "Add note" button for
// Buyer's own detail page (Loading only lists Cancel + Refresh) — so this
// page only *displays* an existing note (with a Delete, since Buyer authored
// it at Create Transfer time) rather than offering to add one here.
function BuyerTransferDetail() {
  const navigate = useNavigate();
  const { transferId } = useParams();

  const [transfer, setTransfer] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [refreshing, setRefreshing] = useState(false);
  const [fromQtyBySku, setFromQtyBySku] = useState({});
  const [toQtyBySku, setToQtyBySku] = useState({});

  const [draftQty, setDraftQty] = useState({}); // Pending: itemId -> stepper draft (only for over-stock rows)
  const [selectedItemIds, setSelectedItemIds] = useState([]);
  const [deletingItems, setDeletingItems] = useState(false);

  const [receivedDraft, setReceivedDraft] = useState({}); // Counted: itemId -> draft
  const [savingItemId, setSavingItemId] = useState(null);

  const [savingNote, setSavingNote] = useState(false);

  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [committing, setCommitting] = useState(false);

  const fetchTransfer = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}?role=buyer`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfer(data.transfer);
      setItems(data.items);
      const receivedDrafts = {};
      data.items.forEach(i => {
        receivedDrafts[i.id] = i.received_quantity != null ? i.received_quantity : i.quantity;
      });
      setReceivedDraft(receivedDrafts);
      setDraftQty({});
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [transferId]);

  useEffect(() => { fetchTransfer(); }, [fetchTransfer]);

  const refreshQty = useCallback(async () => {
    if (!transfer) return;
    setRefreshing(true);
    try {
      const nextFrom = {};
      const nextTo = {};
      for (const item of items) {
        if (!item.sku) continue;
        const res = await fetch(
          `/api/shopify/inventory-by-sku?sku=${encodeURIComponent(item.sku)}&fromLocationId=${encodeURIComponent(transfer.from_location_id)}&toLocationId=${encodeURIComponent(transfer.to_location_id)}`
        );
        if (res.ok) {
          const data = await res.json();
          nextFrom[item.sku] = data.fromQty;
          nextTo[item.sku] = data.toQty;
        }
      }
      setFromQtyBySku(prev => ({ ...prev, ...nextFrom }));
      setToQtyBySku(prev => ({ ...prev, ...nextTo }));
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }, [transfer, items]);

  useEffect(() => {
    if (!loading && transfer && items.length > 0) { refreshQty(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, transfer?.id]);

  const deleteNote = async () => {
    setSavingNote(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/note`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfer(prev => ({ ...prev, note: null, note_by: null }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingNote(false);
    }
  };

  const handleCancel = async () => {
    if (!window.confirm('Cancel this transfer? This will cancel it in Shopify and delete it here. This cannot be undone.')) return;
    setCancelling(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate('/buyer/transfer/ongoing');
    } catch (e) {
      setError(e.message);
      setCancelling(false);
    }
  };

  const toggleSelectItem = (id) => {
    setSelectedItemIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleDeleteSelectedItems = async () => {
    if (selectedItemIds.length === 0) return;
    setDeletingItems(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/items`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: selectedItemIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSelectedItemIds([]);
      await fetchTransfer();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingItems(false);
    }
  };

  // An "over-stock" row is one whose transfer qty exceeds the current
  // (refreshed) from-location qty — spec doc section 4: these are the only
  // rows that get a checkbox + editable stepper on the Pending page, and the
  // only rows highlighted/pinned to top on both Loading and Pending.
  const isOverStock = (item) => {
    const fromQty = fromQtyBySku[item.sku];
    return fromQty != null && Number(item.quantity) > Number(fromQty);
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setError('');
    try {
      const payload = {
        items: items.map(i => {
          const overStock = isOverStock(i);
          const defaultQty = overStock ? fromQtyBySku[i.sku] : i.quantity;
          const qty = overStock && draftQty[i.id] != null ? draftQty[i.id] : defaultQty;
          return {
            itemId: i.id,
            inventoryItemId: i.inventory_item_id,
            quantity: Number(qty),
            availableQty: fromQtyBySku[i.sku],
          };
        }),
      };
      const res = await fetch(`/api/transfers/${transferId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await fetchTransfer();
    } catch (e) {
      setError(e.message);
    } finally {
      setConfirming(false);
    }
  };

  const saveReceivedQty = async (item) => {
    setSavingItemId(item.id);
    setError('');
    try {
      const count = Number(receivedDraft[item.id]);
      const res = await fetch(`/api/transfers/${transferId}/count`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, count }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, received_quantity: count, counted_confirmed: true } : i)));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingItemId(null);
    }
  };

  const handleCommit = async () => {
    setCommitting(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/commit`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate('/buyer/transfer');
    } catch (e) {
      setError(e.message);
      setCommitting(false);
    }
  };

  if (loading) {
    return (
      <Page title="Transfer" backAction={{ onAction: () => navigate('/buyer/transfer') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }
  if (!transfer) {
    return (
      <Page title="Transfer" backAction={{ onAction: () => navigate('/buyer/transfer') }}>
        <Layout><Layout.Section>{error && <Banner tone="critical">{error}</Banner>}</Layout.Section></Layout>
      </Page>
    );
  }

  const status = transfer.status;
  const isLoading = status === 'loading';
  const isPending = status === 'pending';
  const isMidTransit = status === 'good_to_go' || status === 'in_transit' || status === 'receiving';
  const isCounted = status === 'counted';
  const isCommitted = status === 'committed';

  // Sorting/highlighting is keyed off the *persisted* received_quantity, not
  // the live-typed draft — otherwise a row would jump to the top mid-keystroke
  // while the buyer is still typing a correction (same pattern TransferPrepDetail
  // and ManagerPOReceivingDetail use: only saved state affects layout).
  const isReceivedMismatchSaved = (item) => item.received_quantity != null && Number(item.received_quantity) !== Number(item.quantity);
  // Live version (includes the unsaved draft) — used only for the input's own
  // in-progress styling and the "will adjust Shopify" banner text below.
  const isReceivedMismatchDraft = (item) => Number(receivedDraft[item.id] ?? item.quantity) !== Number(item.quantity);
  const hasMismatch = isCounted && items.some(isReceivedMismatchDraft);

  // Loading/Pending: over-stock rows pinned to top. Counted: received-qty
  // mismatch rows pinned to top. Everyone else keeps insertion order.
  let sortedItems = items;
  if (isLoading || isPending) {
    sortedItems = [...items].sort((a, b) => (isOverStock(b) ? 1 : 0) - (isOverStock(a) ? 1 : 0));
  } else if (isCounted) {
    sortedItems = [...items].sort((a, b) => (isReceivedMismatchSaved(b) ? 1 : 0) - (isReceivedMismatchSaved(a) ? 1 : 0));
  }

  return (
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      <Page
        title={transfer.transfer_no}
        backAction={{ onAction: () => (isCommitted ? navigate(-1) : navigate('/buyer/transfer/ongoing')) }}
        titleMetadata={
          <InlineStack gap="200" blockAlign="center">
            <StatusBadge status={status} />
            {transfer.shopify_transfer_url && (
              <a href={transfer.shopify_transfer_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px', fontWeight: 600, textDecoration: 'underline' }}>
                {transfer.shopify_transfer_name || transfer.shopify_transfer_id}
              </a>
            )}
          </InlineStack>
        }
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

              <InlineStack align="space-between" blockAlign="start" wrap>
                <InlineStack gap="600" wrap>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">From</Text>
                    <Text fontWeight="bold">{transfer.from_location}</Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">To</Text>
                    <Text fontWeight="bold">{transfer.to_location}</Text>
                  </BlockStack>
                </InlineStack>

                <InlineStack gap="200" wrap>
                  {isPending && selectedItemIds.length > 0 && (
                    <Button tone="critical" loading={deletingItems} onClick={handleDeleteSelectedItems}>
                      Delete selected ({selectedItemIds.length})
                    </Button>
                  )}
                  {(isLoading || isPending || isCounted || isCommitted) && (
                    <Button onClick={refreshQty} loading={refreshing}>Refresh qty</Button>
                  )}
                  {isLoading && (
                    <Button tone="critical" loading={cancelling} onClick={handleCancel}>Cancel</Button>
                  )}
                  {isPending && (
                    <Button variant="primary" loading={confirming} onClick={handleConfirm}>Confirm</Button>
                  )}
                  {isCounted && (
                    <Button variant="primary" loading={committing} onClick={handleCommit}>Commit</Button>
                  )}
                </InlineStack>
              </InlineStack>

              {transfer.note && (
                <Card>
                  <BlockStack gap="150">
                    <Text variant="bodySm" tone="subdued">Note</Text>
                    <Text>{transfer.note}</Text>
                    {isLoading && transfer.note_by === 'buyer' && (
                      <div><Button size="slim" tone="critical" onClick={deleteNote} loading={savingNote}>Delete</Button></div>
                    )}
                  </BlockStack>
                </Card>
              )}

              <Card>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        {isPending && <th style={{ padding: '8px 10px', width: '32px' }} />}
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>SKU</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name</th>
                        {/* {from location} qty appears in every status per spec doc section 4
                            (Loading/Pending: from qty only; Good to go/In transit/Receiving/
                            Counted/Committed: from qty + to qty). */}
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{transfer.from_location} qty</th>
                        {(isMidTransit || isCounted || isCommitted) && (
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{transfer.to_location} qty</th>
                        )}
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>
                          {isCommitted ? 'Transferred qty' : 'Transfer qty'}
                        </th>
                        {isCounted && (
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Received qty</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedItems.map(item => {
                        const overStock = (isLoading || isPending) && isOverStock(item);
                        const receivedMismatch = isCounted && isReceivedMismatchSaved(item);
                        const receivedMismatchLive = isCounted && isReceivedMismatchDraft(item);
                        return (
                          <tr
                            key={item.id}
                            style={{
                              borderBottom: '1px solid #f1f1f1',
                              background: receivedMismatch ? '#fdeceb' : undefined,
                            }}
                          >
                            {isPending && (
                              <td style={{ padding: '8px 10px' }}>
                                {overStock && (
                                  <input
                                    type="checkbox"
                                    checked={selectedItemIds.includes(item.id)}
                                    onChange={() => toggleSelectItem(item.id)}
                                  />
                                )}
                              </td>
                            )}
                            <td style={{ padding: '10px' }}>{item.sku}</td>
                            <td style={{ padding: '10px' }}>{item.name}</td>
                            <td style={{ padding: '10px', color: overStock ? '#d72c0d' : undefined, fontWeight: overStock ? 700 : undefined }}>
                              {fromQtyBySku[item.sku] ?? '—'}
                            </td>
                            {(isMidTransit || isCounted || isCommitted) && (
                              <td style={{ padding: '10px' }}>{toQtyBySku[item.sku] ?? '—'}</td>
                            )}
                            <td style={{ padding: '10px' }}>
                              {isPending && overStock ? (
                                <input
                                  type="number"
                                  min="0"
                                  max={fromQtyBySku[item.sku]}
                                  value={draftQty[item.id] ?? fromQtyBySku[item.sku] ?? item.quantity}
                                  onChange={e => setDraftQty(prev => ({ ...prev, [item.id]: e.target.value }))}
                                  style={{ width: '72px', padding: '4px 6px', borderRadius: '6px', border: '1px solid #d72c0d', fontSize: '13px', color: '#d72c0d', fontWeight: 700 }}
                                />
                              ) : (
                                <span style={{ color: overStock ? '#d72c0d' : undefined, fontWeight: overStock ? 700 : undefined }}>
                                  {item.quantity}
                                </span>
                              )}
                            </td>
                            {isCounted && (
                              <td style={{ padding: '10px' }}>
                                <InlineStack gap="150" blockAlign="center">
                                  <input
                                    type="number"
                                    min="0"
                                    value={receivedDraft[item.id] ?? item.quantity}
                                    onChange={e => setReceivedDraft(prev => ({ ...prev, [item.id]: e.target.value }))}
                                    style={{
                                      width: '72px', padding: '4px 6px', borderRadius: '6px', fontSize: '13px',
                                      border: receivedMismatchLive ? '1px solid #d72c0d' : '1px solid #c9cccf',
                                      color: receivedMismatchLive ? '#d72c0d' : undefined,
                                      fontWeight: receivedMismatchLive ? 700 : undefined,
                                    }}
                                  />
                                  <button
                                    onClick={() => saveReceivedQty(item)}
                                    disabled={savingItemId === item.id}
                                    style={{
                                      border: '1px solid #c9cccf', borderRadius: '999px', width: '28px', height: '28px',
                                      background: 'white', cursor: 'pointer', color: '#008060', fontWeight: 700,
                                    }}
                                  >
                                    ✓
                                  </button>
                                </InlineStack>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
              {isCounted && hasMismatch && (
                <Text tone="subdued" variant="bodySm">
                  Some received quantities differ from the transfer quantity — committing will adjust Shopify to match.
                </Text>
              )}
              <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} />
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </div>
  );
}

export default BuyerTransferDetail;
