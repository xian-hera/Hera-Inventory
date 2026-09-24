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

// Multi-count (2026-09-24, Hera): one green tally bar per Submit / Correct
// saved for a line item (server keeps them in count_history and recomputes
// store_count — see computeStoreCount() in server/routes/poInvoices.js).
function countHistory(item) {
  const h = Array.isArray(item && item.count_history) ? item.count_history : [];
  if (h.length === 0 && item && item.store_count !== null && item.store_count !== undefined) {
    return [{ type: 'counted', value: item.store_count, legacy: true }];
  }
  return h;
}

function TallyBars({ count }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: '6px', verticalAlign: 'middle' }}>
      {Array.from({ length: Math.min(count, 10) }).map((_, i) => (
        <span key={i} style={{
          display: 'inline-block', width: '3px', height: '16px',
          background: 'green', marginRight: '2px', borderRadius: '1px',
        }} />
      ))}
    </span>
  );
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

  // Line-item list filter (All / Not counted / Off qty) — single-select,
  // defaults to All. Purely a client-side view filter over `items`; doesn't
  // touch the server or the counted/total summary line above the table.
  const [itemFilter, setItemFilter] = useState('all');

  // Bulk "Mark Correct" (2026-09-24, Hera) — desktop only, mobile is
  // completely unaffected (see the .po-select-col / .po-bulk-actions CSS
  // classes below, same show/hide-by-media-query technique as Home.js /
  // ManagerPOReceiving.js). Selection is scoped to whatever's currently
  // visible under itemFilter — "select all" / "Mark all Correct" act on
  // filteredItems, not every item in the invoice, so switching the pill
  // filter always shows a consistent set of checkboxes to work from.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [markingCorrect, setMarkingCorrect] = useState(false);

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

  // Reset the bulk-select checkboxes whenever the visible set changes, so a
  // stale selection never silently includes rows the manager can't see.
  useEffect(() => { setSelectedIds(new Set()); }, [itemFilter]);

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
  // `entry` is { type: 'counted', value } or { type: 'correct' }; the server
  // appends it to the item's count history and returns the new total.
  const saveCount = async (item, entry) => {
    setSavingCount(true);
    setCountError('');
    try {
      const res = await fetch(`/api/po-invoices/manager/receiving/${invoiceId}/items/${item.id}/count`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
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
    saveCount(popupItem, { type: 'correct' });
  };

  const handleSubmitCount = () => {
    if (!popupItem) return;
    if (countInput === '') { setCountError('input your count'); return; }
    const value = parseInt(countInput, 10);
    if (isNaN(value) || value < 0) { setCountError('input your count'); return; }
    saveCount(popupItem, { type: 'counted', value });
  };

  // Desktop-only bulk "Mark Correct" — hits the new bulk endpoint once for
  // however many item ids are passed in, rather than looping the single-item
  // PATCH client-side, so it's one request/one transaction either way.
  const markCorrectBulk = async (itemIds) => {
    if (!itemIds.length) return;
    setMarkingCorrect(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/manager/receiving/${invoiceId}/items/mark-correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const byId = new Map((data.items || []).map(i => [i.id, i]));
      setItems(prev => prev.map(i => (byId.has(i.id) ? { ...i, ...byId.get(i.id) } : i)));
      setSelectedIds(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setMarkingCorrect(false);
    }
  };

  const toggleSelectItem = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
  const notCountedCount = totalCount - countedCount;
  const offQtyCount = items.filter(i => {
    const counted = i.store_count !== null && i.store_count !== undefined;
    return counted && Number(i.store_count) !== Number(i.quantity);
  }).length;

  const ITEM_FILTERS = [
    { key: 'all', label: 'All', count: totalCount },
    { key: 'not_counted', label: 'Not counted', count: notCountedCount },
    { key: 'off_qty', label: 'Off qty', count: offQtyCount },
  ];

  const filteredItems = items.filter(item => {
    if (itemFilter === 'all') return true;
    const counted = item.store_count !== null && item.store_count !== undefined;
    if (itemFilter === 'not_counted') return !counted;
    if (itemFilter === 'off_qty') return counted && Number(item.store_count) !== Number(item.quantity);
    return true;
  });

  const allFilteredSelected = filteredItems.length > 0 && filteredItems.every(item => selectedIds.has(item.id));
  const toggleSelectAll = () => {
    setSelectedIds(allFilteredSelected ? new Set() : new Set(filteredItems.map(item => item.id)));
  };
  const handleMarkAllCorrect = () => markCorrectBulk(filteredItems.map(item => item.id));
  const handleMarkSelectedCorrect = () => markCorrectBulk(Array.from(selectedIds));

  return (
    // Wrapper caps width at 100% of the viewport at all times — the whole
    // point being that a modal opening/closing never leaves the page in a
    // state that needs horizontal scrolling.
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      {/* Desktop-only bulk "Mark Correct" UI (checkbox column + Mark
          all/selected Correct buttons) — pure CSS media-query toggle, same
          technique as Home.js / ManagerPOReceiving.js. Both markups are
          effectively "always there"; below 768px these two classes just
          collapse to nothing, so mobile's table and layout are byte-for-byte
          what they were before this feature existed. */}
      <style>{`
        .po-select-col { display: none; }
        .po-bulk-actions { display: none; }
        @media (min-width: 768px) {
          .po-select-col { display: table-cell; }
          .po-bulk-actions { display: flex; }
        }
      `}</style>
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

              {/* Line-item filter — All / Not counted / Off qty, single-select
                  pill buttons, defaults to All. Lets the manager tap "Not
                  counted" while counting to only see what's left. */}
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

              {/* Bulk "Mark Correct" — desktop only (see .po-bulk-actions
                  above). "Mark all Correct" and "Mark selected Correct" both
                  act on filteredItems (whatever the current All/Not
                  counted/Off qty pill shows), matching the select-all
                  checkbox in the table header below. */}
              <div className="po-bulk-actions" style={{ justifyContent: 'flex-end', gap: '8px' }}>
                <Button onClick={handleMarkAllCorrect} loading={markingCorrect} disabled={markingCorrect || filteredItems.length === 0}>
                  Mark all Correct
                </Button>
                <Button onClick={handleMarkSelectedCorrect} loading={markingCorrect} disabled={markingCorrect || selectedIds.size === 0}>
                  Mark selected Correct
                </Button>
              </div>

              <Card>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th className="po-select-col" style={{ padding: '8px 10px', textAlign: 'left' }}>
                          <input
                            type="checkbox"
                            checked={allFilteredSelected}
                            onChange={toggleSelectAll}
                            aria-label="Select all"
                          />
                        </th>
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
                      {filteredItems.map(item => {
                        const counted = item.store_count !== null && item.store_count !== undefined;
                        const matches = counted && Number(item.store_count) === Number(item.quantity);
                        return (
                          <tr
                            key={item.id}
                            onClick={() => openPopup(item)}
                            style={{ borderBottom: '1px solid #f1f1f1', cursor: 'pointer' }}
                          >
                            <td className="po-select-col" style={{ padding: '10px' }} onClick={e => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={selectedIds.has(item.id)}
                                onChange={() => toggleSelectItem(item.id)}
                                aria-label={`Select ${item.name || item.sku || 'item'}`}
                              />
                            </td>
                            <td style={{ padding: '10px' }}>
                              <div style={{ fontWeight: 500 }}>{item.name || '-'}</div>
                              <div style={{ fontSize: '12px', color: '#6d7175' }}>{item.sku || '-'}</div>
                            </td>
                            <td style={{ padding: '10px', color: '#6d7175' }}>{item.wig_number || ''}</td>
                            <td style={{ padding: '10px' }}>{item.quantity}</td>
                            <td style={{ padding: '10px' }}>
                              {counted && <TallyBars count={countHistory(item).length} />}
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
              transform: 'translateY(-50%)', maxHeight: 'calc(100vh - 176px)', overflowY: 'auto',
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

                <div style={{ fontSize: '13px', color: '#6d7175', marginBottom: '-8px' }}>
                  Enter only what you counted this time — not the total.
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

                {countHistory(popupItem).length > 0 && (
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">Count history</Text>
                    {countHistory(popupItem).map((h, i) => (
                      <InlineStack key={i} gap="200" blockAlign="center">
                        <TallyBars count={1} />
                        <Text>{h.type === 'correct' ? 'Correct' : String(h.value)}</Text>
                      </InlineStack>
                    ))}
                    <Text variant="bodySm" tone="subdued">
                      Total {popupItem.store_count === null || popupItem.store_count === undefined ? 0 : popupItem.store_count}
                    </Text>
                  </BlockStack>
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
