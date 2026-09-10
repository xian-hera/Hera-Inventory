import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, Banner, Spinner, TextField,
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import { StatusBadge } from './transferStatus';

// Shared Loading / Pending / Good to go / In transit detail page — used by
// BOTH Warehouse (HQ-origin card, see WarehouseTransferDetail.js) and Manager
// as a from-location (Sending card, see ManagerTransferSendingDetail.js).
// Hera confirmed these two are the same page ("这个页面与 warehouse 打开
// loading 时完全一样"); the only differences are: Manager's page also shows
// a Wig Number column (showWigNumber prop), and the Good-to-go button reads
// "Dispatch" for Warehouse vs "Truck picked up" for Manager
// (dispatchLabel prop). See claude/TRANSFER_FEATURE_SPEC.md sections 5 & 6.
function TransferPrepDetail({ role, showWigNumber, backPath, dispatchLabel }) {
  const navigate = useNavigate();
  const { transferId } = useParams();

  const [transfer, setTransfer] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [draftQty, setDraftQty] = useState({}); // itemId -> stepper draft value, before check-confirm
  const [savingItemId, setSavingItemId] = useState(null);
  const [notProcessedOnly, setNotProcessedOnly] = useState(false);

  const [refreshing, setRefreshing] = useState(false);

  const [showNoteInput, setShowNoteInput] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

  const fetchTransfer = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}?role=${role}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfer(data.transfer);
      setItems(data.items);
      const drafts = {};
      data.items.forEach(i => { drafts[i.id] = i.qty_loaded != null ? i.qty_loaded : i.quantity; });
      setDraftQty(drafts);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [transferId, role]);

  useEffect(() => { fetchTransfer(); }, [fetchTransfer]);

  // Re-queries Shopify for every item's from/to qty and persists it as this
  // transfer's snapshot (transfer_items.from_qty_snapshot/to_qty_snapshot) —
  // no longer runs automatically on page load, only on an explicit click
  // (2026-09-10 addendum — this used to fire on every mount, which is why
  // this page used to spin every time a Loading transfer was opened).
  const refreshQty = async () => {
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
  };

  const exportPdf = async () => {
    setExportingPdf(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/export-pdf?qtySide=from`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${transfer?.transfer_no || 'transfer'}-export.pdf`;
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

  const confirmQtyLoaded = async (item) => {
    setSavingItemId(item.id);
    setError('');
    try {
      const qty = Number(draftQty[item.id]);
      const res = await fetch(`/api/transfers/${transferId}/qty-loaded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, qty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, qty_loaded: qty, loaded_confirmed: true } : i)));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingItemId(null);
    }
  };

  const saveNote = async () => {
    if (!noteDraft.trim()) return;
    setSavingNote(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, text: noteDraft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfer(prev => ({ ...prev, note: noteDraft.trim(), note_by: role }));
      setNoteDraft('');
      setShowNoteInput(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingNote(false);
    }
  };

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

  const submitLoading = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/submit-loading`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate(backPath);
    } catch (e) {
      setError(e.message);
      setSubmitting(false);
    }
  };

  const dispatch = async () => {
    setDispatching(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/dispatch`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate(backPath);
    } catch (e) {
      setError(e.message);
      setDispatching(false);
    }
  };

  if (loading) {
    return (
      <Page title="Transfer" backAction={{ onAction: () => navigate(backPath) }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }
  if (!transfer) {
    return (
      <Page title="Transfer" backAction={{ onAction: () => navigate(backPath) }}>
        <Layout><Layout.Section>{error && <Banner tone="critical">{error}</Banner>}</Layout.Section></Layout>
      </Page>
    );
  }

  const status = transfer.status;
  const isLoading = status === 'loading';
  const isPending = status === 'pending';
  const isGoodToGo = status === 'good_to_go';
  const isInTransit = status === 'in_transit';
  const showFromQtyColumn = isLoading || isPending;

  const notProcessedCount = items.filter(i => !i.loaded_confirmed).length;
  const allConfirmed = items.length > 0 && notProcessedCount === 0;
  const hasMismatch = items.some(i => i.qty_loaded != null && i.qty_loaded !== i.quantity);

  // Orange-check (mismatched) rows always pinned to top — confirmed for
  // both Loading and Pending. Alphabetical by name otherwise, and within
  // each group too (2026-09-10 addendum).
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  const sortedItems = [...items].sort((a, b) => {
    const aOff = a.loaded_confirmed && a.qty_loaded !== a.quantity ? 1 : 0;
    const bOff = b.loaded_confirmed && b.qty_loaded !== b.quantity ? 1 : 0;
    const diff = bOff - aOff;
    return diff !== 0 ? diff : byName(a, b);
  });
  const visibleItems = notProcessedOnly ? sortedItems.filter(i => !i.loaded_confirmed) : sortedItems;

  const submitButtonLabel = allConfirmed && hasMismatch ? 'Submit to Buyer' : dispatchLabel === 'Truck picked up' ? 'Good to go' : 'Good to go';

  return (
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      <Page
        title={transfer.transfer_no}
        backAction={{ onAction: () => navigate(backPath) }}
        titleMetadata={<StatusBadge status={status} />}
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
                  {(isLoading || isPending) && (
                    <button
                      onClick={() => setNotProcessedOnly(v => !v)}
                      style={{
                        padding: '8px 16px', borderRadius: '999px',
                        border: notProcessedOnly ? '1.5px solid #008060' : '1.5px solid #c9cccf',
                        background: notProcessedOnly ? '#008060' : 'white',
                        color: notProcessedOnly ? 'white' : '#202223',
                        fontSize: '14px', cursor: 'pointer', whiteSpace: 'nowrap',
                      }}
                    >
                      Not Loaded {notProcessedCount}
                    </button>
                  )}
                </InlineStack>
                <InlineStack gap="200" wrap>
                  {/* Export PDF is available in every status, for both
                      Warehouse and Manager-as-from-location (2026-09-10
                      addendum) — printable copy for physically picking. */}
                  <Button onClick={exportPdf} loading={exportingPdf} disabled={exportingPdf}>Export PDF</Button>
                  {(isLoading || isPending) && (
                    <Button onClick={refreshQty} loading={refreshing}>Refresh qty</Button>
                  )}
                  {isLoading && (
                    <Button onClick={() => setShowNoteInput(v => !v)}>
                      Add note{transfer.note ? ' •' : ''}
                    </Button>
                  )}
                  {isLoading && (
                    <Button
                      variant="primary"
                      disabled={!allConfirmed}
                      loading={submitting}
                      onClick={submitLoading}
                    >
                      {submitButtonLabel}
                    </Button>
                  )}
                  {isGoodToGo && (
                    <Button variant="primary" loading={dispatching} onClick={dispatch}>
                      {dispatchLabel}
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>

              {isPending && (
                <Text tone="subdued">Waiting for buyer to confirm.</Text>
              )}

              {showNoteInput && isLoading && (
                <Card>
                  <BlockStack gap="200">
                    {transfer.note ? (
                      <BlockStack gap="150">
                        <Text>{transfer.note}</Text>
                        <div><Button size="slim" tone="critical" onClick={deleteNote} loading={savingNote}>Delete</Button></div>
                      </BlockStack>
                    ) : (
                      <InlineStack gap="200">
                        <div style={{ flex: 1 }}>
                          <TextField label="" labelHidden placeholder="Note..." value={noteDraft} onChange={setNoteDraft} autoComplete="off" />
                        </div>
                        <Button onClick={saveNote} loading={savingNote}>Save</Button>
                      </InlineStack>
                    )}
                  </BlockStack>
                </Card>
              )}

              <Card>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>SKU</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name</th>
                        {showWigNumber && (
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Wig Number</th>
                        )}
                        {showFromQtyColumn && (
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{transfer.from_location} qty</th>
                        )}
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer qty</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Qty loaded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleItems.map(item => {
                        const confirmed = item.loaded_confirmed;
                        const matches = confirmed && item.qty_loaded === item.quantity;
                        return (
                          <tr key={item.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                            <td style={{ padding: '10px' }}>{item.sku}</td>
                            <td style={{ padding: '10px' }}>{item.name}</td>
                            {showWigNumber && <td style={{ padding: '10px', color: '#6d7175' }}>{item.wig_number || ''}</td>}
                            {showFromQtyColumn && (
                              <td style={{ padding: '10px' }}>{item.from_qty_snapshot ?? '—'}</td>
                            )}
                            <td style={{ padding: '10px' }}>{item.quantity}</td>
                            <td style={{ padding: '10px' }}>
                              {(isGoodToGo || isInTransit) ? (
                                <span style={{ color: '#008060', fontWeight: 700 }}>{item.qty_loaded} ✓</span>
                              ) : confirmed ? (
                                <span style={{ color: matches ? '#008060' : '#d72c0d', fontWeight: 700 }}>
                                  {item.qty_loaded} {matches ? '✓' : '●'}
                                </span>
                              ) : (
                                <InlineStack gap="150" blockAlign="center">
                                  <input
                                    type="number"
                                    value={draftQty[item.id] ?? item.quantity}
                                    onChange={e => setDraftQty(prev => ({ ...prev, [item.id]: e.target.value }))}
                                    style={{ width: '70px', padding: '6px 8px', border: '1px solid #c9cccf', borderRadius: '6px' }}
                                  />
                                  <button
                                    onClick={() => confirmQtyLoaded(item)}
                                    disabled={savingItemId === item.id}
                                    style={{
                                      border: '1px solid #c9cccf', borderRadius: '999px', width: '32px', height: '32px',
                                      background: 'white', cursor: 'pointer', color: '#008060', fontWeight: 700,
                                    }}
                                  >
                                    ✓
                                  </button>
                                </InlineStack>
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

export default TransferPrepDetail;
