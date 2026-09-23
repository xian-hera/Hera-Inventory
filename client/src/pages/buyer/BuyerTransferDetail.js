import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, ButtonGroup, BlockStack, InlineStack, Text, Banner, Spinner,
  Popover, ActionList, Modal, TextField,
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import { StatusBadge, HoldBadge, AutoCommittedBadge } from '../shared/transferStatus';

const HQ_LOCATION_NAME = 'HQ';

// Same small-pill look as BuyerTransferOngoing.js's TAG_PILL_STYLE / Create
// Transfer's TAG_CHIP_STYLE — own copy here rather than a shared import,
// matching how these transfer pages already each keep their own small
// style constants.
const TAG_PILL_STYLE = {
  display: 'inline-flex', alignItems: 'center',
  padding: '2px 8px', borderRadius: '12px',
  background: '#e4e5e7', fontSize: '12px', whiteSpace: 'nowrap',
};

// Buyer's Transfer detail page.
//
// 2026-09-15 rewrite (spec doc section 11, 改动一/四/五/六/七): Buyer can now
// perform every other role's status-changing action from this one page —
// each status shows a "main button" (the same action Warehouse/Manager would
// use) as the default action of a split button, with Commit tucked into the
// dropdown, so Buyer can step a transfer forward normally OR skip straight to
// Commit at any point. Loading gets the same interactive Qty Loaded
// checkbox/stepper table Warehouse uses (but Buyer's Good to Go button works
// even if rows are still unconfirmed — see submitMainAction's `force`).
// Receiving/Counted/Not counted share one editable Received Qty table so
// Buyer can either finish counting or just Commit as-is. Buyer can also Edit
// (line items, only up to Good to go) and Hold/Release a transfer, and every
// main-button click now carries the transfer's last-loaded updated_at so a
// stale click (someone else moved it first) surfaces a "someone else updated
// this" modal instead of silently acting on outdated state.
function BuyerTransferDetail() {
  const navigate = useNavigate();
  const { transferId } = useParams();

  const [transfer, setTransfer] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);

  const [refreshing, setRefreshing] = useState(false);

  const [draftQty, setDraftQty] = useState({}); // Pending: itemId -> stepper draft (only for over-stock rows)
  const [selectedItemIds, setSelectedItemIds] = useState([]);
  const [deletingItems, setDeletingItems] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false); // split-button dropdown (Pending/Loading/Good to go/In transit)

  const [draftLoadedQty, setDraftLoadedQty] = useState({}); // Loading: itemId -> qty_loaded draft
  const [savingLoadedId, setSavingLoadedId] = useState(null);

  const [receivedDraft, setReceivedDraft] = useState({}); // Receiving/Counted/Not counted: itemId -> draft
  const [savingItemId, setSavingItemId] = useState(null);

  const [savingNote, setSavingNote] = useState(false);

  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [mainActing, setMainActing] = useState(false);

  const [holding, setHolding] = useState(false);

  // ── Edit mode (改动四) ──────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [editSelectedIds, setEditSelectedIds] = useState([]);
  const [editRemovedIds, setEditRemovedIds] = useState([]);
  const [editQtyChanges, setEditQtyChanges] = useState({}); // itemId -> new qty
  const [editAdded, setEditAdded] = useState([]); // [{tempKey, sku, name, inventoryItemId, quantity}]
  const [savingEdit, setSavingEdit] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAddItemModal, setShowAddItemModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');

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
      const loadedDrafts = {};
      data.items.forEach(i => {
        receivedDrafts[i.id] = i.received_quantity != null ? i.received_quantity : i.quantity;
        loadedDrafts[i.id] = i.qty_loaded != null ? i.qty_loaded : i.quantity;
      });
      setReceivedDraft(receivedDrafts);
      setDraftLoadedQty(loadedDrafts);
      setDraftQty({});
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [transferId]);

  useEffect(() => { fetchTransfer(); }, [fetchTransfer]);

  // Every main-button / Edit / Hold / Release call goes through this so a
  // 409 (stale — someone else moved the transfer) surfaces the conflict
  // modal instead of a bare error banner.
  const postWithConflictCheck = useCallback(async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, expectedUpdatedAt: transfer?.updated_at }),
    });
    const data = await res.json();
    if (res.status === 409) {
      setConflict(true);
      throw new Error('__conflict__');
    }
    if (!res.ok) throw new Error(data.error);
    return data;
  }, [transfer]);

  const refreshQty = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/refresh-qty`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(data.items);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }, [transferId]);

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
      await postWithConflictCheck(`/api/transfers/${transferId}/cancel`, {});
      navigate('/buyer/transfer/ongoing');
    } catch (e) {
      if (e.message !== '__conflict__') setError(e.message);
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

  const isOverStock = (item) => {
    const fromQty = item.from_qty_snapshot;
    return fromQty != null && Number(item.quantity) > Number(fromQty);
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setError('');
    try {
      const payload = {
        items: items.map(i => {
          const overStock = isOverStock(i);
          const defaultQty = overStock ? i.from_qty_snapshot : i.quantity;
          const qty = overStock && draftQty[i.id] != null ? draftQty[i.id] : defaultQty;
          return {
            itemId: i.id,
            inventoryItemId: i.inventory_item_id,
            quantity: Number(qty),
            availableQty: i.from_qty_snapshot,
          };
        }),
        expectedUpdatedAt: transfer?.updated_at,
      };
      const res = await fetch(`/api/transfers/${transferId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.status === 409) { setConflict(true); return; }
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
        body: JSON.stringify({ itemId: item.id, count, asBuyer: true }),
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

  const saveLoadedQty = async (item) => {
    setSavingLoadedId(item.id);
    setError('');
    try {
      const qty = Number(draftLoadedQty[item.id]);
      const res = await fetch(`/api/transfers/${transferId}/qty-loaded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, qty, asBuyer: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, qty_loaded: qty, loaded_confirmed: true } : i)));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingLoadedId(null);
    }
  };

  const handleCommit = async () => {
    setCommitting(true);
    setError('');
    try {
      await postWithConflictCheck(`/api/transfers/${transferId}/commit`, {});
      navigate('/buyer/transfer');
    } catch (e) {
      if (e.message !== '__conflict__') setError(e.message);
      setCommitting(false);
    }
  };

  // 改动一: the "main button" for Loading/Good to go/In transit — the same
  // action Warehouse/Manager would use, forced through even if this
  // transfer's per-item work isn't fully done (force:true, only meaningful
  // for Loading's submit-loading call — the other two don't gate on
  // anything). 改动六 clarified that Buyer's own status-advancing actions are
  // ALSO blocked while this transfer is on_hold — Buyer must Release first,
  // same as every other role — so the buttons that call this are disabled
  // via the `held` flag below (server-side assertNotHeld enforces it too,
  // regardless of what this call sends).
  const runMainAction = async (path, extra) => {
    setMainActing(true);
    setError('');
    try {
      await postWithConflictCheck(`/api/transfers/${transferId}/${path}`, { asBuyer: true, ...extra });
      await fetchTransfer();
    } catch (e) {
      if (e.message !== '__conflict__') setError(e.message);
    } finally {
      setMainActing(false);
    }
  };

  const handleHold = async () => {
    setHolding(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/hold`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfer(prev => ({ ...prev, on_hold: true }));
    } catch (e) {
      setError(e.message);
    } finally {
      setHolding(false);
    }
  };

  const handleRelease = async () => {
    setHolding(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/release`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfer(prev => ({ ...prev, on_hold: false }));
    } catch (e) {
      setError(e.message);
    } finally {
      setHolding(false);
    }
  };

  // ── Edit mode ──────────────────────────────────────────────────────────
  const startEditing = () => {
    setEditing(true);
    setEditSelectedIds([]);
    setEditRemovedIds([]);
    setEditQtyChanges({});
    setEditAdded([]);
  };
  const cancelEditing = () => {
    setEditing(false);
    setEditSelectedIds([]);
    setEditRemovedIds([]);
    setEditQtyChanges({});
    setEditAdded([]);
  };
  const toggleEditSelect = (id) => {
    setEditSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const confirmEditDelete = () => {
    setEditRemovedIds(prev => [...new Set([...prev, ...editSelectedIds])]);
    setEditSelectedIds([]);
    setShowDeleteConfirm(false);
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError('');
    try {
      const res = await fetch(`/api/shopify/search?q=${encodeURIComponent(searchQuery.trim())}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch {
      setSearchError('Search failed.');
    } finally {
      setSearchLoading(false);
    }
  };

  const addSearchResult = async (result) => {
    try {
      const res = await fetch(
        `/api/shopify/inventory-by-sku?sku=${encodeURIComponent(result.barcode)}&fromLocationId=${encodeURIComponent(transfer.from_location_id)}&toLocationId=${encodeURIComponent(transfer.to_location_id)}`
      );
      if (!res.ok) { setSearchError(`Could not load ${result.barcode}.`); return; }
      const data = await res.json();
      if (items.some(i => i.sku === data.sku) || editAdded.some(a => a.sku === data.sku)) {
        setSearchError(`${data.sku} is already on this transfer.`);
        return;
      }
      setEditAdded(prev => [...prev, {
        tempKey: `added-${data.sku}-${Date.now()}`,
        sku: data.sku, name: data.name, inventoryItemId: data.inventoryItemId, quantity: 1,
      }]);
      setShowAddItemModal(false);
      setSearchQuery('');
      setSearchResults([]);
    } catch {
      setSearchError(`Could not load ${result.barcode}.`);
    }
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    setError('');
    try {
      const payload = {
        expectedUpdatedAt: transfer?.updated_at,
        added: editAdded.map(a => ({ sku: a.sku, name: a.name, inventoryItemId: a.inventoryItemId, quantity: Number(a.quantity) })),
        removedItemIds: editRemovedIds,
        quantityChanges: Object.entries(editQtyChanges).map(([itemId, quantity]) => ({ itemId: Number(itemId), quantity: Number(quantity) })),
      };
      const res = await fetch(`/api/transfers/${transferId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.status === 409) { setConflict(true); return; }
      if (!res.ok) throw new Error(data.error);
      setEditing(false);
      setEditSelectedIds([]);
      setEditRemovedIds([]);
      setEditQtyChanges({});
      setEditAdded([]);
      await fetchTransfer();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingEdit(false);
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
  const isGoodToGo = status === 'good_to_go';
  const isInTransit = status === 'in_transit';
  const isReceiving = status === 'receiving';
  const isCounted = status === 'counted';
  const isNotCounted = status === 'not_counted';
  const isCountedLike = isReceiving || isCounted || isNotCounted;
  const isCommitted = status === 'committed' || status === 'archived';
  const held = !!transfer.on_hold;
  const editableStatus = isLoading || isPending || isGoodToGo; // 改动四/六: Edit + Hold only up to Good to go

  const isReceivedMismatchSaved = (item) => item.received_quantity != null && Number(item.received_quantity) !== Number(item.quantity);
  const isReceivedMismatchDraft = (item) => Number(receivedDraft[item.id] ?? item.quantity) !== Number(item.quantity);
  const hasMismatch = isCountedLike && items.some(isReceivedMismatchDraft);

  const activeItems = items.filter(i => i.edit_state !== 'removed');
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  let sortedItems = [...items].sort(byName);
  if (isLoading || isPending) {
    sortedItems = [...items].sort((a, b) => {
      const aEdit = a.edit_state ? 1 : 0;
      const bEdit = b.edit_state ? 1 : 0;
      if (aEdit !== bEdit) return bEdit - aEdit;
      const diff = (isOverStock(b) ? 1 : 0) - (isOverStock(a) ? 1 : 0);
      return diff !== 0 ? diff : byName(a, b);
    });
  } else if (isCountedLike) {
    sortedItems = [...items].sort((a, b) => {
      const aEdit = a.edit_state ? 1 : 0;
      const bEdit = b.edit_state ? 1 : 0;
      if (aEdit !== bEdit) return bEdit - aEdit;
      const diff = (isReceivedMismatchSaved(b) ? 1 : 0) - (isReceivedMismatchSaved(a) ? 1 : 0);
      return diff !== 0 ? diff : byName(a, b);
    });
  } else {
    sortedItems = [...items].sort((a, b) => {
      const aEdit = a.edit_state ? 1 : 0;
      const bEdit = b.edit_state ? 1 : 0;
      if (aEdit !== bEdit) return bEdit - aEdit;
      return byName(a, b);
    });
  }

  // 改动五: row/qty tint for a Buyer-edited line item — shown to every role,
  // Buyer's own page included.
  const rowStyle = (item) => {
    if (item.edit_state === 'added') return { background: '#e3f8e9' };
    if (item.edit_state === 'removed') return { background: '#fdf1e3', textDecoration: 'line-through', color: '#8c6d4f' };
    if (item.edit_state === 'qty_changed') return { background: '#e4eefc' };
    return {};
  };
  const qtyStyle = (item) => (item.edit_state === 'qty_changed' ? { color: '#1f5199', fontWeight: 700 } : {});

  const fromIsHQ = transfer.from_location === HQ_LOCATION_NAME;

  let mainButtonLabel = null;
  let mainButtonAction = null;
  if (isLoading) { mainButtonLabel = 'Good to Go'; mainButtonAction = () => runMainAction('submit-loading', { force: true }); }
  else if (isGoodToGo) { mainButtonLabel = fromIsHQ ? 'Dispatch' : 'Truck picked up'; mainButtonAction = () => runMainAction('dispatch'); }
  else if (isInTransit) { mainButtonLabel = 'Delivered'; mainButtonAction = () => runMainAction('delivered'); }

  const editAddedTotal = editAdded.length;

  return (
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      <Modal
        open={conflict}
        onClose={() => setConflict(false)}
        title="This transfer has been updated by someone else"
        primaryAction={{ content: 'Refresh', onAction: () => { setConflict(false); fetchTransfer(); } }}
      >
        <Modal.Section>
          <Text>Someone else changed this transfer's status while you had it open. Refresh to see the latest before trying again.</Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Delete selected line items?"
        primaryAction={{ content: 'Confirm', destructive: true, onAction: confirmEditDelete }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setShowDeleteConfirm(false) }]}
      >
        <Modal.Section>
          <Text>Are you sure to delete selected lineitems, this cannot be undone once you click Save.</Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={showAddItemModal}
        onClose={() => setShowAddItemModal(false)}
        title="Add item"
      >
        <Modal.Section>
          <BlockStack gap="300">
            <InlineStack gap="200">
              <div style={{ flex: 1 }}>
                <TextField
                  label="" labelHidden placeholder="Search by SKU or name..."
                  value={searchQuery} onChange={setSearchQuery} autoComplete="off"
                  onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
                />
              </div>
              <Button onClick={runSearch} loading={searchLoading}>Search</Button>
            </InlineStack>
            {searchError && <Banner tone="critical" onDismiss={() => setSearchError('')}>{searchError}</Banner>}
            <BlockStack gap="150">
              {searchResults.map(r => (
                <div
                  key={r.barcode}
                  onClick={() => addSearchResult(r)}
                  style={{ padding: '10px', border: '1px solid #e1e3e5', borderRadius: '8px', cursor: 'pointer' }}
                >
                  <Text fontWeight="semibold">{r.name}</Text>
                  <Text tone="subdued" variant="bodySm">{r.barcode}</Text>
                </div>
              ))}
            </BlockStack>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Page
        title={transfer.shopify_transfer_name || transfer.transfer_no}
        backAction={{ onAction: () => (isCommitted ? navigate(-1) : navigate('/buyer/transfer/ongoing')) }}
        titleMetadata={
          <InlineStack gap="200" blockAlign="center">
            <StatusBadge status={status} />
            {held && <HoldBadge />}
            {transfer.auto_committed && <AutoCommittedBadge />}
            {/* 改动七: the id/name next to the status pill is now a plain
                jump-out icon button, not clickable text — the page title
                itself is the Shopify transfer id/name now.
                2026-09-16: was a hand-styled circular <a> — the icon sat
                off-center inside the circle and read as a UI glitch.
                Swapped for a plain Polaris Button (its normal
                rounded-rectangle shape) instead of custom CSS. */}
            {transfer.shopify_transfer_url && (
              <Button
                size="micro"
                url={transfer.shopify_transfer_url}
                external
                accessibilityLabel="Open in Shopify"
              >
                ↗
              </Button>
            )}
          </InlineStack>
        }
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
              {held && !editing && <Text tone="critical" fontWeight="bold">This transfer is on hold. No one — including you — can advance its status until you release it.</Text>}

              <InlineStack align="space-between" blockAlign="start" wrap>
                <InlineStack gap="600" wrap blockAlign="center">
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">From</Text>
                    <Text fontWeight="bold">{transfer.from_location}</Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">To</Text>
                    <Text fontWeight="bold">{transfer.to_location}</Text>
                  </BlockStack>
                  {/* Tags (2026-09-23, Hera) — shown as pills to the right of
                      From/To, same small-pill style as the Ongoing Transfer
                      list's Tags column and Create Transfer's tag picker.
                      Nothing rendered at all when the transfer has no tags. */}
                  {(transfer.tags || []).length > 0 && (
                    <InlineStack gap="100" wrap blockAlign="center">
                      {transfer.tags.map(tag => (
                        <span key={tag} style={TAG_PILL_STYLE}>{tag}</span>
                      ))}
                    </InlineStack>
                  )}
                </InlineStack>

                {editing ? (
                  // 改动四 A: Edit mode's own toolbar — Delete selected (only
                  // once ≥1 row is checked), Add Item, Cancel, Save.
                  <InlineStack gap="200" wrap>
                    {editSelectedIds.length > 0 && (
                      <Button tone="critical" onClick={() => setShowDeleteConfirm(true)}>
                        Delete Selected ({editSelectedIds.length})
                      </Button>
                    )}
                    <Button onClick={() => setShowAddItemModal(true)}>Add Item</Button>
                    <Button onClick={cancelEditing} disabled={savingEdit}>Cancel</Button>
                    <Button variant="primary" onClick={saveEdit} loading={savingEdit}>Save</Button>
                  </InlineStack>
                ) : (
                  <InlineStack gap="200" wrap>
                    {isPending && selectedItemIds.length > 0 && (
                      <Button tone="critical" disabled={held} loading={deletingItems} onClick={handleDeleteSelectedItems}>
                        Delete selected ({selectedItemIds.length})
                      </Button>
                    )}
                    <Button onClick={refreshQty} loading={refreshing}>Refresh qty</Button>
                    {isLoading && (
                      <Button tone="critical" disabled={held} loading={cancelling} onClick={handleCancel}>Cancel</Button>
                    )}

                    {/* 改动六: Hold/Release, then Edit — only up to Good to go. */}
                    {editableStatus && (
                      <Button onClick={held ? handleRelease : handleHold} loading={holding}>
                        {held ? 'Release' : 'Hold'}
                      </Button>
                    )}
                    {editableStatus && (
                      <Button onClick={startEditing}>Edit</Button>
                    )}

                    {/* 改动一: main button (the responsible role's own action)
                        as the split button's default, Commit in the dropdown. */}
                    {mainButtonLabel && (
                      <Popover
                        active={actionsMenuOpen}
                        onClose={() => setActionsMenuOpen(false)}
                        activator={
                          <ButtonGroup variant="segmented">
                            <Button variant="primary" disabled={held} loading={mainActing} onClick={mainButtonAction}>{mainButtonLabel}</Button>
                            <Button variant="primary" disabled={held} onClick={() => setActionsMenuOpen(v => !v)} disclosure />
                          </ButtonGroup>
                        }
                      >
                        <ActionList
                          items={[{ content: 'Commit', onAction: () => { setActionsMenuOpen(false); handleCommit(); } }]}
                        />
                      </Popover>
                    )}
                    {isPending && (
                      <Popover
                        active={actionsMenuOpen}
                        onClose={() => setActionsMenuOpen(false)}
                        activator={
                          <ButtonGroup variant="segmented">
                            <Button variant="primary" loading={confirming} onClick={handleConfirm}>Confirm</Button>
                            <Button variant="primary" onClick={() => setActionsMenuOpen(v => !v)} disclosure />
                          </ButtonGroup>
                        }
                      >
                        <ActionList
                          items={[{ content: 'Commit', onAction: () => { setActionsMenuOpen(false); handleCommit(); } }]}
                        />
                      </Popover>
                    )}
                    {isCountedLike && (
                      <Button variant="primary" loading={committing} onClick={handleCommit}>Commit</Button>
                    )}
                  </InlineStack>
                )}
              </InlineStack>

              {transfer.note && !editing && (
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
                        {(editing || isPending) && <th style={{ padding: '8px 10px', width: '32px' }} />}
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>SKU</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name</th>
                        {!editing && (
                          <>
                            <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{transfer.from_location} Qty</th>
                            <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{transfer.to_location} Qty</th>
                          </>
                        )}
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>
                          {isCommitted ? 'Transferred Qty' : 'Transfer Qty'}
                        </th>
                        {isLoading && !editing && (
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Qty loaded</th>
                        )}
                        {isCountedLike && !editing && (
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Received Qty</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {editing ? (
                        <>
                          {[...activeItems].sort(byName).map(item => (
                            <tr key={item.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                              <td style={{ padding: '8px 10px' }}>
                                <input type="checkbox" checked={editSelectedIds.includes(item.id)} onChange={() => toggleEditSelect(item.id)} />
                              </td>
                              <td style={{ padding: '10px' }}>{item.sku}</td>
                              <td style={{ padding: '10px' }}>{item.name}</td>
                              <td style={{ padding: '10px' }}>
                                <input
                                  type="number" min="0"
                                  value={editQtyChanges[item.id] ?? item.quantity}
                                  onChange={e => setEditQtyChanges(prev => ({ ...prev, [item.id]: e.target.value }))}
                                  style={{ width: '80px', padding: '4px 6px', borderRadius: '6px', border: '1px solid #c9cccf', fontSize: '13px' }}
                                />
                              </td>
                            </tr>
                          ))}
                          {editAdded.map(a => (
                            <tr key={a.tempKey} style={{ borderBottom: '1px solid #f1f1f1', background: '#e3f8e9' }}>
                              <td style={{ padding: '8px 10px' }} />
                              <td style={{ padding: '10px' }}>{a.sku}</td>
                              <td style={{ padding: '10px' }}>{a.name}</td>
                              <td style={{ padding: '10px' }}>
                                <input
                                  type="number" min="1"
                                  value={a.quantity}
                                  onChange={e => setEditAdded(prev => prev.map(x => x.tempKey === a.tempKey ? { ...x, quantity: e.target.value } : x))}
                                  style={{ width: '80px', padding: '4px 6px', borderRadius: '6px', border: '1px solid #c9cccf', fontSize: '13px' }}
                                />
                              </td>
                            </tr>
                          ))}
                        </>
                      ) : sortedItems.map(item => {
                        const overStock = (isLoading || isPending) && isOverStock(item);
                        const receivedMismatch = isCountedLike && isReceivedMismatchSaved(item);
                        const receivedMismatchLive = isCountedLike && isReceivedMismatchDraft(item);
                        const removed = item.edit_state === 'removed';
                        const loadedConfirmed = item.loaded_confirmed;
                        const loadedMatches = loadedConfirmed && item.qty_loaded === item.quantity;
                        return (
                          <tr
                            key={item.id}
                            style={{
                              borderBottom: '1px solid #f1f1f1',
                              background: receivedMismatch ? '#fdeceb' : undefined,
                              ...rowStyle(item),
                            }}
                          >
                            {isPending && (
                              <td style={{ padding: '8px 10px' }}>
                                {overStock && (
                                  <input type="checkbox" checked={selectedItemIds.includes(item.id)} onChange={() => toggleSelectItem(item.id)} />
                                )}
                              </td>
                            )}
                            <td style={{ padding: '10px' }}>{item.sku}</td>
                            <td style={{ padding: '10px' }}>{item.name}</td>
                            <td style={{ padding: '10px', color: overStock ? '#d72c0d' : undefined, fontWeight: overStock ? 700 : undefined }}>
                              {item.from_qty_snapshot ?? '—'}
                            </td>
                            <td style={{ padding: '10px' }}>{item.to_qty_snapshot ?? '—'}</td>
                            <td style={{ padding: '10px', ...qtyStyle(item) }}>
                              {isPending && overStock ? (
                                <input
                                  type="number"
                                  min="0"
                                  max={item.from_qty_snapshot}
                                  value={draftQty[item.id] ?? item.from_qty_snapshot ?? item.quantity}
                                  onChange={e => setDraftQty(prev => ({ ...prev, [item.id]: e.target.value }))}
                                  style={{ width: '72px', padding: '4px 6px', borderRadius: '6px', border: '1px solid #d72c0d', fontSize: '13px', color: '#d72c0d', fontWeight: 700 }}
                                />
                              ) : (
                                <span style={{ color: overStock ? '#d72c0d' : undefined, fontWeight: overStock ? 700 : undefined }}>
                                  {item.quantity}
                                </span>
                              )}
                            </td>
                            {isLoading && (
                              <td style={{ padding: '10px' }}>
                                {removed ? (
                                  <span style={{ color: '#8c6d4f' }}>—</span>
                                ) : loadedConfirmed ? (
                                  <span style={{ color: loadedMatches ? '#008060' : '#d72c0d', fontWeight: 700 }}>
                                    {item.qty_loaded} {loadedMatches ? '✓' : '●'}
                                  </span>
                                ) : (
                                  <InlineStack gap="150" blockAlign="center">
                                    <input
                                      type="number"
                                      value={draftLoadedQty[item.id] ?? item.quantity}
                                      onChange={e => setDraftLoadedQty(prev => ({ ...prev, [item.id]: e.target.value }))}
                                      disabled={held}
                                      style={{ width: '70px', padding: '6px 8px', border: '1px solid #c9cccf', borderRadius: '6px' }}
                                    />
                                    <button
                                      onClick={() => saveLoadedQty(item)}
                                      disabled={held || savingLoadedId === item.id}
                                      style={{ border: '1px solid #c9cccf', borderRadius: '999px', width: '32px', height: '32px', background: 'white', cursor: held ? 'not-allowed' : 'pointer', color: '#008060', fontWeight: 700, opacity: held ? 0.5 : 1 }}
                                    >
                                      ✓
                                    </button>
                                  </InlineStack>
                                )}
                              </td>
                            )}
                            {isCountedLike && (
                              <td style={{ padding: '10px' }}>
                                {removed ? (
                                  <span style={{ color: '#8c6d4f' }}>—</span>
                                ) : (
                                  <InlineStack gap="150" blockAlign="center">
                                    <input
                                      type="number"
                                      min="0"
                                      value={receivedDraft[item.id] ?? item.quantity}
                                      onChange={e => setReceivedDraft(prev => ({ ...prev, [item.id]: e.target.value }))}
                                      disabled={held}
                                      style={{
                                        width: '72px', padding: '4px 6px', borderRadius: '6px', fontSize: '13px',
                                        border: receivedMismatchLive ? '1px solid #d72c0d' : '1px solid #c9cccf',
                                        color: receivedMismatchLive ? '#d72c0d' : undefined,
                                        fontWeight: receivedMismatchLive ? 700 : undefined,
                                      }}
                                    />
                                    <button
                                      onClick={() => saveReceivedQty(item)}
                                      disabled={held || savingItemId === item.id}
                                      style={{ border: '1px solid #c9cccf', borderRadius: '999px', width: '28px', height: '28px', background: 'white', cursor: held ? 'not-allowed' : 'pointer', color: '#008060', fontWeight: 700, opacity: held ? 0.5 : 1 }}
                                    >
                                      ✓
                                    </button>
                                  </InlineStack>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
              {isCountedLike && hasMismatch && !editing && (
                <Text tone="subdued" variant="bodySm">
                  Some received quantities differ from the transfer quantity — committing will adjust Shopify to match.
                </Text>
              )}
              {editing && editAddedTotal === 0 && editRemovedIds.length === 0 && Object.keys(editQtyChanges).length === 0 && (
                <Text tone="subdued" variant="bodySm">No changes yet — add an item, check rows to delete, or edit a Transfer Qty above.</Text>
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
