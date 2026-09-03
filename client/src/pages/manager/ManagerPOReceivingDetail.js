import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';

// Same keydown-buffer barcode-scanner listening pattern used by
// ManagerTaskDetail.js / ManagerRestockPlan.js — kept as its own local copy
// since this codebase doesn't share a scanner-utils module between pages.
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

function ManagerPOReceivingDetail() {
  const navigate = useNavigate();
  const { invoiceId } = useParams();

  const [invoice, setInvoice] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [popupItem, setPopupItem] = useState(null);
  const [countInput, setCountInput] = useState('');
  const [countError, setCountError] = useState('');
  const [savingCount, setSavingCount] = useState(false);

  const [notFoundBarcode, setNotFoundBarcode] = useState('');

  const [showNoteInput, setShowNoteInput] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [exportingPdf, setExportingPdf] = useState(false);

  const barcodeBuffer = useRef('');
  const barcodeTimer = useRef(null);
  const popupRef = useRef(null);
  const itemsRef = useRef([]);
  const notFoundTimer = useRef(null);

  useEffect(() => { popupRef.current = popupItem; }, [popupItem]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const fetchInvoice = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/po-invoices/manager/receiving/${invoiceId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setInvoice(data.invoice);
      setItems(data.items);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => { fetchInvoice(); }, [fetchInvoice]);

  // Body-scroll lock while any modal is open — never let a modal's presence
  // widen the page such that closing it leaves the page needing horizontal
  // scroll (an explicit past bug Hera flagged). The page content itself
  // never exceeds 100% width (see the wrapping div's overflowX below), so
  // this is just belt-and-suspenders.
  useEffect(() => {
    const anyOpen = !!(popupItem || showSubmitConfirm);
    document.body.style.overflow = anyOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [popupItem, showSubmitConfirm]);

  // Scanner listening — SKU not found shows a popup that auto-dismisses
  // after 2 seconds (no tap needed), per spec, rather than the tap-to-
  // dismiss error popup used elsewhere in the manager app.
  useEffect(() => {
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
  }, []);

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

  // Persisted immediately on every submit (Correct button or manual count) —
  // never batched — so leaving/closing mid-count never loses progress.
  const saveCount = async (item, count) => {
    setSavingCount(true);
    setCountError('');
    try {
      const res = await fetch(`/api/po-invoices/manager/receiving/${invoiceId}/items/${item.id}/count`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // Merge rather than replace: this PATCH's response is a plain DB row
      // (RETURNING *), which has no wig_number field at all — that's a
      // client-side-only value fetched live by the initial GET and never
      // stored in the DB. A straight replace would wipe it out the moment
      // an item is counted; spreading the fresh DB fields over the existing
      // item keeps wig_number (and anything else not in the DB row) intact.
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, ...data } : i)));
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

  // ── Notes — manager can reply even without a buyer note; same "one note
  //    already exists" gate as the buyer side. ──────────────────────────────
  const saveManagerNote = async () => {
    if (!noteInput.trim()) return;
    setSavingNote(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/notes/manager`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: noteInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setInvoice(prev => ({ ...prev, manager_note: data.manager_note, manager_note_at: data.manager_note_at }));
      setNoteInput('');
      setShowNoteInput(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingNote(false);
    }
  };

  const deleteManagerNote = async () => {
    setSavingNote(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/pending/${invoiceId}/notes/manager`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setInvoice(prev => ({ ...prev, manager_note: null, manager_note_at: null }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingNote(false);
    }
  };

  // Export PDF — same endpoint and output as the buyer side's Export PDF
  // (GET /api/po-invoices/:id/export-pdf). That route always builds its
  // rows from item.quantity and leaves a blank hand-fill "Count" column —
  // it never reads store_count at all — so a manager's export here is
  // already byte-for-byte identical to the buyer's, ignoring whatever
  // counting progress exists on this invoice so far, with no separate
  // backend logic needed.
  const handleExportPdf = async () => {
    setExportingPdf(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/${invoiceId}/export-pdf`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.po_number || invoice.invoice_number || 'invoice'}-export.pdf`;
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
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/manager/receiving/${invoiceId}/submit`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate('/manager/po-receiving');
    } catch (e) {
      setError(e.message);
      setShowSubmitConfirm(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Page title="PO Receiving" backAction={{ onAction: () => navigate('/manager/po-receiving') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }
  if (!invoice) {
    return (
      <Page title="PO Receiving" backAction={{ onAction: () => navigate('/manager/po-receiving') }}>
        <Layout><Layout.Section>{error && <Banner tone="critical">{error}</Banner>}</Layout.Section></Layout>
      </Page>
    );
  }

  const totalCount = items.length;
  const countedCount = items.filter(i => i.store_count !== null && i.store_count !== undefined).length;
  const allCounted = totalCount > 0 && countedCount === totalCount;

  return (
    // Wrapper caps width at 100% of the viewport at all times — the whole
    // point being that a modal opening/closing never leaves the page in a
    // state that needs horizontal scrolling.
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      <Page
        title={invoice.po_number || invoice.invoice_number}
        backAction={{ onAction: () => navigate('/manager/po-receiving') }}
        secondaryActions={[
          { content: 'Export PDF', onAction: handleExportPdf, loading: exportingPdf, disabled: exportingPdf },
        ]}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

              <InlineStack gap="300" wrap blockAlign="center">
                <Text fontWeight="semibold">{invoice.supplier_name}</Text>
                <Text tone="subdued" variant="bodySm">{invoice.location}</Text>
                <Text tone="subdued" variant="bodySm">{countedCount}/{totalCount} counted</Text>
              </InlineStack>

              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" wrap align="end">
                    <Button onClick={() => setShowNoteInput(true)}>
                      Note{(invoice.buyer_note || invoice.manager_note) ? ' •' : ''}
                    </Button>
                    <Button variant="primary" onClick={() => setShowSubmitConfirm(true)} disabled={!allCounted}>
                      Submit
                    </Button>
                  </InlineStack>

                  {showNoteInput && (
                    <BlockStack gap="200">
                      {invoice.buyer_note && (
                        <BlockStack gap="050">
                          <Text variant="bodySm" tone="subdued">Buyer's note</Text>
                          <Text>{invoice.buyer_note}</Text>
                        </BlockStack>
                      )}
                      {invoice.manager_note ? (
                        <BlockStack gap="050">
                          <Text variant="bodySm" tone="subdued">Your reply</Text>
                          <Text>{invoice.manager_note}</Text>
                          <div>
                            <Button size="slim" tone="critical" onClick={deleteManagerNote} loading={savingNote}>Delete</Button>
                          </div>
                        </BlockStack>
                      ) : (
                        <InlineStack gap="200">
                          <div style={{ flex: 1 }}>
                            <TextField label="" labelHidden placeholder="Reply..." value={noteInput} onChange={setNoteInput} autoComplete="off" />
                          </div>
                          <Button onClick={saveManagerNote} loading={savingNote}>Save</Button>
                          <Button onClick={() => { setShowNoteInput(false); setNoteInput(''); }} disabled={savingNote}>Cancel</Button>
                        </InlineStack>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name / SKU</th>
                        {/* Wig number — no header per Hera's spec; blank for a
                            non-WIG line item, so this column carries no label
                            of its own and just sits quietly empty for those
                            rows. */}
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}></th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Qty</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(item => {
                        const counted = item.store_count !== null && item.store_count !== undefined;
                        const matches = counted && Number(item.store_count) === Number(item.quantity);
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
                                <span style={{ color: '#008060', fontWeight: 700 }}>✓ {item.store_count}</span>
                              ) : (
                                <span style={{ color: '#d72c0d', fontWeight: 700 }}>{item.store_count}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
              {/* Bottom nav-bar safe area, same convention as ManagerTaskDetail.js */}
              <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} />
            </BlockStack>
          </Layout.Section>
        </Layout>

        {/* SKU not found — auto-dismisses after 2s, no tap needed */}
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
              <Text variant="bodyLg" fontWeight="bold">SKU "{notFoundBarcode}" not found in this invoice.</Text>
            </div>
          </div>
        )}

        {/* Count popup — click-to-open alternative to scanning */}
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

        {/* Submit confirm */}
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
                  This invoice will be removed from your PO Receiving list and marked as counted for the buyer.
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

export default ManagerPOReceivingDetail;
