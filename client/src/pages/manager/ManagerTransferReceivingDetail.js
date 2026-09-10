import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import { StatusBadge } from '../shared/transferStatus';

// Same keydown-buffer barcode-scanner listening pattern as
// ManagerPOReceivingDetail.js — kept as its own local copy per this
// codebase's convention (no shared scanner-utils module).
function resolveKey(e) {
  if (e.key && e.key !== 'Unidentified' && e.key.length === 1) return e.key;
  if (e.code) {
    if (e.code.startsWith('Digit')) return e.code.slice(5);
    if (e.code.startsWith('Numpad') && e.code.length === 7) return e.code.slice(6);
    if (e.code.startsWith('Key') && e.code.length === 4) {
      const ch = e.code.slice(3);
      return e.shiftKey ? ch : ch.toLowerCase();
    }
    const sym = { Minus:'-', Equal:'=', BracketLeft:'[', BracketRight:']',
      Backslash:'\\', Semicolon:';', Quote:"'", Backquote:'`',
      Comma:',', Period:'.', Slash:'/' };
    if (sym[e.code]) return sym[e.code];
  }
  return null;
}

function cleanBarcode(raw) {
  return raw.replace(/^[^0-9]+/, '');
}

// Manager's Receiving-side detail page — handles both In transit (read-only,
// black "Delivered" button) and Receiving (full counting page modeled on
// ManagerPOReceivingDetail.js: scanner, count popup, All/Uncounted/Off-qty
// filter pills, Wig Number column, notes). Spec doc section 6.
function ManagerTransferReceivingDetail() {
  const navigate = useNavigate();
  const { transferId } = useParams();

  const [transfer, setTransfer] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [delivering, setDelivering] = useState(false);

  const [popupItem, setPopupItem] = useState(null);
  const [countInput, setCountInput] = useState('');
  const [countError, setCountError] = useState('');
  const [savingCount, setSavingCount] = useState(false);
  const [notFoundBarcode, setNotFoundBarcode] = useState('');

  const [showNoteInput, setShowNoteInput] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const [exportingPdf, setExportingPdf] = useState(false);

  const [itemFilter, setItemFilter] = useState('all');

  const barcodeBuffer = useRef('');
  const barcodeTimer = useRef(null);
  const popupRef = useRef(null);
  const itemsRef = useRef([]);
  const notFoundTimer = useRef(null);

  useEffect(() => { popupRef.current = popupItem; }, [popupItem]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const fetchTransfer = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}?role=manager`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfer(data.transfer);
      setItems(data.items);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [transferId]);

  useEffect(() => { fetchTransfer(); }, [fetchTransfer]);

  useEffect(() => {
    const anyOpen = !!(popupItem || showSubmitConfirm);
    document.body.style.overflow = anyOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [popupItem, showSubmitConfirm]);

  const isReceiving = transfer?.status === 'receiving';

  useEffect(() => {
    if (!isReceiving) return;
    const handleKeyDown = (e) => {
      if (popupRef.current) return;
      const activeTag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA'].includes(activeTag)) return;

      if (e.key === 'Enter') {
        clearTimeout(barcodeTimer.current);
        const barcode = cleanBarcode(barcodeBuffer.current.trim());
        barcodeBuffer.current = '';
        if (!barcode) return;
        const matched = itemsRef.current.find(i => i.sku === barcode);
        if (matched) {
          openPopup(matched);
        } else {
          clearTimeout(notFoundTimer.current);
          setNotFoundBarcode(barcode);
          notFoundTimer.current = setTimeout(() => setNotFoundBarcode(''), 2000);
        }
        return;
      }

      const ch = resolveKey(e);
      if (ch) {
        barcodeBuffer.current += ch;
        clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => { barcodeBuffer.current = ''; }, 500);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(barcodeTimer.current);
      clearTimeout(notFoundTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReceiving]);

  const openPopup = (item) => {
    setPopupItem(item);
    setCountInput('');
    setCountError('');
  };
  const closePopup = () => {
    setPopupItem(null);
    setCountInput('');
    setCountError('');
  };

  const saveCount = async (item, count) => {
    setSavingCount(true);
    setCountError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/count`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, count }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, received_quantity: count, counted_confirmed: true } : i)));
      closePopup();
    } catch (e) {
      setCountError(e.message);
    } finally {
      setSavingCount(false);
    }
  };

  const handleCorrect = () => {
    if (!popupItem) return;
    saveCount(popupItem, Number(popupItem.quantity));
  };

  const handleSubmitCount = () => {
    if (!popupItem) return;
    if (countInput === '') { setCountError('input your count'); return; }
    const value = parseInt(countInput, 10);
    if (isNaN(value) || value < 0) { setCountError('input your count'); return; }
    saveCount(popupItem, value);
  };

  const saveNote = async () => {
    if (!noteDraft.trim()) return;
    setSavingNote(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'manager', text: noteDraft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfer(prev => ({ ...prev, note: noteDraft.trim(), note_by: 'manager' }));
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

  const handleDelivered = async () => {
    setDelivering(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/delivered`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await fetchTransfer();
    } catch (e) {
      setError(e.message);
    } finally {
      setDelivering(false);
    }
  };

  // Export PDF (2026-09-10 addendum) — available in every status this page
  // renders (In transit read-only + Receiving), using this location's own
  // (to-location) qty column, per Hera's column spec. Same download pattern
  // as BuyerPOImportInvoice.js's handleExportPdf / TransferPrepDetail.js's
  // exportPdf.
  const exportPdf = async () => {
    setExportingPdf(true);
    setError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/export-pdf?qtySide=to`);
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

  const handleSubmitInvoice = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch(`/api/transfers/${transferId}/submit-count`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate('/manager/transfer');
    } catch (e) {
      setSubmitError(e.message);
      setShowSubmitConfirm(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Page title="Transfer" backAction={{ onAction: () => navigate('/manager/transfer') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }
  if (!transfer) {
    return (
      <Page title="Transfer" backAction={{ onAction: () => navigate('/manager/transfer') }}>
        <Layout><Layout.Section>{error && <Banner tone="critical">{error}</Banner>}</Layout.Section></Layout>
      </Page>
    );
  }

  // ── In transit — read-only, Delivered button ─────────────────────────────
  if (transfer.status === 'in_transit') {
    return (
      <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
        <Page
          title={transfer.transfer_no}
          backAction={{ onAction: () => navigate('/manager/transfer') }}
          titleMetadata={<StatusBadge status={transfer.status} />}
        >
          <Layout>
            <Layout.Section>
              <BlockStack gap="400">
                {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
                <InlineStack align="space-between" blockAlign="center" wrap>
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
                  <InlineStack gap="200">
                    <Button onClick={exportPdf} loading={exportingPdf} disabled={exportingPdf}>Export PDF</Button>
                    <Button
                      onClick={handleDelivered}
                      loading={delivering}
                      fullWidth={false}
                    >
                      Delivered
                    </Button>
                  </InlineStack>
                </InlineStack>

                <Card>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>SKU</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Wig Number</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...items].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(item => (
                          <tr key={item.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                            <td style={{ padding: '10px' }}>{item.sku}</td>
                            <td style={{ padding: '10px' }}>{item.name}</td>
                            <td style={{ padding: '10px', color: '#6d7175' }}>{item.wig_number || ''}</td>
                            <td style={{ padding: '10px' }}>{item.quantity}</td>
                          </tr>
                        ))}
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

  // ── Receiving — full counting page ───────────────────────────────────────
  const totalCount = items.length;
  const countedCount = items.filter(i => i.counted_confirmed).length;
  const allCounted = totalCount > 0 && countedCount === totalCount;
  const notCountedCount = totalCount - countedCount;
  const offQtyCount = items.filter(i => i.counted_confirmed && Number(i.received_quantity) !== Number(i.quantity)).length;

  const ITEM_FILTERS = [
    { key: 'all', label: 'All', count: totalCount },
    { key: 'not_counted', label: 'Uncounted', count: notCountedCount },
    { key: 'off_qty', label: 'Off Qty', count: offQtyCount },
  ];

  // Off-qty rows always pinned to top (spec doc section 6: "始终置顶显示"),
  // regardless of which filter pill is active — alphabetical by name
  // otherwise, and within that pinned group too (2026-09-10 addendum).
  const isOffQty = (item) => item.counted_confirmed && Number(item.received_quantity) !== Number(item.quantity);
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  const sortedItems = [...items].sort((a, b) => {
    const diff = (isOffQty(b) ? 1 : 0) - (isOffQty(a) ? 1 : 0);
    return diff !== 0 ? diff : byName(a, b);
  });

  const filteredItems = sortedItems.filter(item => {
    if (itemFilter === 'all') return true;
    if (itemFilter === 'not_counted') return !item.counted_confirmed;
    if (itemFilter === 'off_qty') return isOffQty(item);
    return true;
  });

  return (
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      <Page
        title={transfer.transfer_no}
        backAction={{ onAction: () => navigate('/manager/transfer') }}
        titleMetadata={<StatusBadge status={transfer.status} />}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
              {submitError && <Banner tone="critical" onDismiss={() => setSubmitError('')}>{submitError}</Banner>}

              <InlineStack gap="300" wrap blockAlign="center">
                <Text fontWeight="semibold">{transfer.from_location} to {transfer.to_location}</Text>
                <Text tone="subdued" variant="bodySm">{countedCount}/{totalCount} counted</Text>
              </InlineStack>

              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" wrap align="end">
                    <Button onClick={exportPdf} loading={exportingPdf} disabled={exportingPdf}>Export PDF</Button>
                    <Button onClick={() => setShowNoteInput(v => !v)}>
                      Add note{transfer.note ? ' •' : ''}
                    </Button>
                    <Button variant="primary" onClick={() => setShowSubmitConfirm(true)} disabled={!allCounted}>
                      Submit
                    </Button>
                  </InlineStack>

                  {showNoteInput && (
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
                  )}
                </BlockStack>
              </Card>

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
                        const counted = item.counted_confirmed;
                        const matches = counted && Number(item.received_quantity) === Number(item.quantity);
                        return (
                          <tr
                            key={item.id}
                            onClick={() => openPopup(item)}
                            style={{ borderBottom: '1px solid #f1f1f1', cursor: 'pointer' }}
                          >
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
                                <span style={{ color: '#008060', fontWeight: 700 }}>✓ {item.received_quantity}</span>
                              ) : (
                                <span style={{ color: '#d72c0d', fontWeight: 700 }}>{item.received_quantity}</span>
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

        {notFoundBarcode && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
          }}>
            <div style={{
              background: 'white', borderRadius: '12px',
              padding: '24px 32px', maxWidth: '320px', textAlign: 'center',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
              <Text variant="bodyLg" fontWeight="bold">SKU "{notFoundBarcode}" not found in this transfer.</Text>
            </div>
          </div>
        )}

        {popupItem && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          }}>
            <div style={{
              position: 'fixed', top: '50%', left: '16px', right: '16px',
              transform: 'translateY(-50%)',
              background: 'white', borderRadius: '12px', padding: '24px',
              maxWidth: '480px', margin: '0 auto', zIndex: 1001,
            }}>
              <button onClick={closePopup} style={{
                position: 'absolute', top: '12px', right: '12px',
                background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', zIndex: 1,
              }}>✕</button>

              <BlockStack gap="400">
                <div style={{ paddingRight: '28px' }}>
                  <div style={{ fontSize: '16px', fontWeight: '700', lineHeight: '1.4', wordBreak: 'break-word' }}>
                    {popupItem.name}
                  </div>
                  <div style={{ fontSize: '13px', color: '#6d7175' }}>{popupItem.sku}</div>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    inputMode="numeric"
                    placeholder="Input your count"
                    value={countInput}
                    onChange={e => { setCountInput(e.target.value); setCountError(''); }}
                    autoComplete="off" autoFocus
                    style={{
                      flex: 1, minWidth: 0, padding: '10px 12px', fontSize: '16px',
                      border: '1px solid #c9cccf', borderRadius: '8px',
                      outline: 'none', boxSizing: 'border-box', display: 'block',
                    }}
                    onFocus={e => { e.target.style.borderColor = '#005bd3'; }}
                    onBlur={e => { e.target.style.borderColor = '#c9cccf'; }}
                  />
                  <Button onClick={handleSubmitCount} loading={savingCount}>Submit</Button>
                </div>

                {countError && (
                  <div style={{ background: '#fff4f4', borderRadius: '8px', padding: '10px 14px',
                    fontSize: '14px', color: '#d72c0d' }}>
                    {countError}
                  </div>
                )}

                <button onClick={handleCorrect} disabled={savingCount} style={{
                  background: '#008060', color: 'white', border: 'none',
                  borderRadius: '12px', padding: '20px', fontSize: '22px',
                  fontWeight: 'bold', cursor: savingCount ? 'default' : 'pointer',
                }}>
                  Quantity {popupItem.quantity}　Correct
                </button>
              </BlockStack>
            </div>
          </div>
        )}

        {showSubmitConfirm && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px',
          }}>
            <div style={{ background: 'white', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '360px' }}>
              <BlockStack gap="300">
                <Text variant="headingMd" fontWeight="bold">Submit this count?</Text>
                <Text variant="bodyMd" tone="subdued">
                  This transfer will move to Counted and be removed from your Receiving list.
                </Text>
                <InlineStack gap="200" align="center">
                  <button
                    onClick={handleSubmitInvoice}
                    disabled={submitting}
                    style={{
                      padding: '10px 24px', borderRadius: '8px', border: 'none',
                      background: '#008060', color: 'white',
                      cursor: submitting ? 'default' : 'pointer', fontSize: '14px', fontWeight: '600',
                    }}
                  >
                    {submitting ? '...' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setShowSubmitConfirm(false)}
                    disabled={submitting}
                    style={{
                      padding: '10px 24px', borderRadius: '8px',
                      border: '1px solid #c9cccf', background: 'white',
                      cursor: 'pointer', fontSize: '14px',
                    }}
                  >
                    Cancel
                  </button>
                </InlineStack>
              </BlockStack>
            </div>
          </div>
        )}
      </Page>
    </div>
  );
}

export default ManagerTransferReceivingDetail;
