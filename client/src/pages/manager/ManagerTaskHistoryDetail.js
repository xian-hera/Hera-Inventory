import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Banner, Spinner,
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';

// Read-only "History in past 15 days" detail page for a Weekly Inventory
// Count task the manager already submitted (see ManagerCountingTasksList.js's
// History section, and server/routes/managerHistory.js for how the row was
// frozen at the moment of submit / complete-scan). Deliberately a brand-new,
// separate component rather than a stripped-down ManagerTaskDetail.js — this
// page reads manager_history.detail (a frozen JSON snapshot, never re-fetched
// live), while ManagerTaskDetail.js reads/writes the live task_items table.
// Per Hera's spec: same System/Scans/Actual columns and stat card as the live
// task page, no Add note, no Submit. "Type in SKU" stays too (2026-09-10
// correction — my earlier assumption to drop it was wrong), but scoped down:
// it — and scanning a barcode, same as the live page — locates an item and
// opens a READ-ONLY popup showing its frozen System/Scans/Actual; there's no
// input, Correct or Reset control, since this record can't be edited.

// Same keydown-buffer barcode-scanner listening pattern as
// ManagerTaskDetail.js — kept as its own local copy per this codebase's
// convention (no shared scanner-utils module).
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

const TYPE_LABEL_MAP = {
  'Hair & Skin Care': 'Care',
  'Tools & Accessories': 'Tools + Acc.',
};

function typeDisplay(type) {
  return TYPE_LABEL_MAP[type] || type;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ManagerTaskHistoryDetail() {
  const navigate = useNavigate();
  const { historyId } = useParams();

  const [entry, setEntry]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [filter, setFilter]   = useState('all');
  const [sortAZ, setSortAZ]   = useState(false);

  // Type in SKU / barcode scan → read-only item lookup popup. Same UI as the
  // live page's Type in SKU flow, minus any editing.
  const [popupItem, setPopupItem]     = useState(null);
  const [showSkuInput, setShowSkuInput] = useState(false);
  const [skuInput, setSkuInput]       = useState('');
  const [skuError, setSkuError]       = useState('');
  const [errorPopup, setErrorPopup]   = useState('');

  const barcodeBuffer = useRef('');
  const barcodeTimer  = useRef(null);
  const popupRef            = useRef(null);
  const showSkuInputRef     = useRef(false);
  const entryRef            = useRef(null);

  useEffect(() => { popupRef.current = popupItem; }, [popupItem]);
  useEffect(() => { showSkuInputRef.current = showSkuInput; }, [showSkuInput]);
  useEffect(() => { entryRef.current = entry; }, [entry]);

  useEffect(() => {
    const anyOpen = !!(popupItem || showSkuInput);
    document.body.style.overflow = anyOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [popupItem, showSkuInput]);

  const fetchEntry = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/manager-history/${historyId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.kind !== 'task') throw new Error('This history entry is not a task submission.');
      setEntry(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [historyId]);

  useEffect(() => { fetchEntry(); }, [fetchEntry]);

  // Scanner listening — same as ManagerTaskDetail.js, except a match opens
  // the read-only popup below instead of the editable scan popup, and
  // (mirroring the live page, where Type in SKU / scanning-to-open-popup is
  // hidden entirely for Scan Count mode tasks) does nothing for a Scan Count
  // task, since that mode never has a Type in SKU button either.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (popupRef.current) return;
      if (showSkuInputRef.current) return;
      const activeTag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA'].includes(activeTag)) return;
      const cur = entryRef.current;
      if (!cur || cur.detail?.scan_count_mode) return;

      if (e.key === 'Enter') {
        clearTimeout(barcodeTimer.current);
        const barcode = cleanBarcode(barcodeBuffer.current.trim());
        barcodeBuffer.current = '';
        if (barcode) {
          const matched = (cur.detail.items || []).find(i => i.barcode === barcode);
          if (matched) {
            setPopupItem(matched);
          } else {
            setErrorPopup(`Barcode "${barcode}" not found in this task.`);
          }
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
    };
  }, []);

  const handleSkuSearch = () => {
    const sku = skuInput.trim();
    const cur = entryRef.current;
    if (!sku || !cur) return;
    const matched = (cur.detail.items || []).find(i => i.barcode === sku);
    if (matched) {
      setShowSkuInput(false);
      setSkuInput('');
      setSkuError('');
      setPopupItem(matched);
    } else {
      setSkuError(`SKU "${sku}" not found in this task.`);
    }
  };

  if (loading) return (
    <Page title="History" backAction={{ onAction: () => navigate('/manager/counting-tasks') }}>
      <Spinner />
    </Page>
  );

  if (!entry) return (
    <Page title="History" backAction={{ onAction: () => navigate('/manager/counting-tasks') }}>
      <Banner tone="critical">{error || 'History entry not found'}</Banner>
    </Page>
  );

  const detail = entry.detail || {};
  const items  = detail.items || [];
  const notes  = detail.notes || [];
  const isScanCountMode = !!detail.scan_count_mode;

  const totalCount       = items.length;
  const processedCount   = items.filter(i => i.soh !== null).length;
  const unprocessedCount = totalCount - processedCount;
  const qtyOffCount      = items.filter(i => i.soh !== null && !i.is_correct && i.poh !== null).length;
  const itemNotScannedCount = items.filter(i => (i.scan_count || 0) === 0).length;

  const typesLabel = Array.isArray(detail.types) && detail.types.length > 0
    ? detail.types.map(typeDisplay).join(', ')
    : '';

  const filteredItems = items.filter(item => {
    if (isScanCountMode) {
      if (filter === 'item_not_scanned') return (item.scan_count || 0) === 0;
      return true;
    }
    if (filter === 'not_scanned') return item.soh === null;
    if (filter === 'qty_off')     return item.soh !== null && !item.is_correct && item.poh !== null;
    return true;
  });

  const displayedItems = sortAZ
    ? [...filteredItems].sort((a, b) =>
        (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
      )
    : filteredItems;

  const rows = displayedItems.map(item => {
    const nameSku = (
      <div>
        <div style={{ fontSize: '14px', fontWeight: '500' }}>{item.name || '-'}</div>
        <div style={{ fontSize: '12px', color: '#6d7175' }}>{item.barcode || '-'}</div>
      </div>
    );

    if (isScanCountMode) {
      return [
        <div>{nameSku}</div>,
        <div>{item.soh !== null ? String(item.soh) : ''}</div>,
        <div />,
        <div>{String(item.scan_count || 0)}</div>,
      ];
    }

    const scanCount = (item.scan_history || []).length;
    const scanBars  = Array.from({ length: Math.min(scanCount, 10) }).map((_, i) => (
      <span key={i} style={{
        display: 'inline-block', width: '3px', height: '16px',
        background: 'green', marginRight: '2px', borderRadius: '1px',
      }} />
    ));

    let pohDisplay = '';
    if (item.poh !== null && item.poh !== undefined) {
      const isMatch = item.is_correct || item.poh === item.soh;
      pohDisplay = (
        <span style={{
          background: isMatch ? '#008060' : 'transparent',
          color:      isMatch ? 'white'   : 'inherit',
          padding:    isMatch ? '2px 8px' : '0',
          borderRadius: '4px',
          fontWeight: isMatch ? 'bold' : 'normal',
        }}>
          {item.poh}
        </span>
      );
    }

    return [
      <div>{nameSku}</div>,
      <div>{item.soh !== null ? String(item.soh) : ''}</div>,
      <div><InlineStack gap="050">{scanBars}</InlineStack></div>,
      <div>{pohDisplay}</div>,
    ];
  });

  return (
    <div style={{ padding: '0 5px' }}>
      <Page
        title={detail.task_no || entry.ref_no}
        subtitle={typesLabel}
        backAction={{ onAction: () => navigate('/manager/counting-tasks') }}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <span style={{
                  display: 'inline-block', padding: '4px 12px', borderRadius: '999px',
                  background: '#E1E3E5', color: '#3F4448', fontSize: '13px', fontWeight: 600,
                }}>
                  {entry.label}
                </span>
                <Text variant="bodySm" tone="subdued">{formatDate(entry.created_at)}</Text>
              </InlineStack>

              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

              <Card>
                <InlineStack gap="400" wrap>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">Unprocessed</Text>
                    <Text variant="headingMd" fontWeight="bold">{unprocessedCount}</Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">Processed</Text>
                    <Text variant="headingMd" fontWeight="bold">{processedCount}</Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">Qty off</Text>
                    <Text variant="headingMd" fontWeight="bold" tone={qtyOffCount > 0 ? 'critical' : undefined}>
                      {qtyOffCount}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">Total</Text>
                    <Text variant="headingMd" fontWeight="bold">{totalCount}</Text>
                  </BlockStack>
                </InlineStack>
              </Card>

              {!isScanCountMode && (
                <Card>
                  <InlineStack gap="200" wrap align="end">
                    <Button onClick={() => { setSkuInput(''); setSkuError(''); setShowSkuInput(true); }}>
                      Type in SKU
                    </Button>
                  </InlineStack>
                </Card>
              )}

              {notes.length > 0 && (
                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingSm">Notes</Text>
                    {notes.map((note, i) => (
                      <div key={i} style={{ borderBottom: '1px solid #e1e3e5', paddingBottom: '8px' }}>
                        <InlineStack align="space-between">
                          <Text variant="bodyMd">{note.text}</Text>
                          <Text variant="bodySm" tone="subdued">{formatDate(note.created_at)}</Text>
                        </InlineStack>
                      </div>
                    ))}
                  </BlockStack>
                </Card>
              )}

              <InlineStack align="space-between" gap="200">
                <InlineStack gap="200">
                  {isScanCountMode
                    ? ['all', 'item_not_scanned'].map(f => (
                        <button
                          key={f}
                          onClick={() => setFilter(f)}
                          style={{
                            padding: '6px 14px', borderRadius: '20px', border: '1px solid #c9cccf',
                            background: filter === f ? '#008060' : 'white',
                            color: filter === f ? 'white' : '#202223',
                            cursor: 'pointer', fontSize: '13px',
                            fontWeight: filter === f ? '600' : '400',
                          }}
                        >
                          {f === 'all' ? `All (${totalCount})` : `Item not Scanned (${itemNotScannedCount})`}
                        </button>
                      ))
                    : ['all', 'not_scanned', 'qty_off'].map(f => (
                        <button
                          key={f}
                          onClick={() => setFilter(f)}
                          style={{
                            padding: '6px 14px', borderRadius: '20px', border: '1px solid #c9cccf',
                            background: filter === f ? '#008060' : 'white',
                            color: filter === f ? 'white' : '#202223',
                            cursor: 'pointer', fontSize: '13px',
                            fontWeight: filter === f ? '600' : '400',
                          }}
                        >
                          {f === 'all'
                            ? `All (${totalCount})`
                            : f === 'not_scanned'
                              ? `Not scanned (${unprocessedCount})`
                              : `Qty off (${qtyOffCount})`}
                        </button>
                      ))}
                </InlineStack>
                {!isScanCountMode && (
                  <button
                    onClick={() => setSortAZ(v => !v)}
                    style={{
                      padding: '6px 14px', borderRadius: '20px', border: '1px solid #c9cccf',
                      background: sortAZ ? '#1a1a1a' : 'white',
                      color: sortAZ ? 'white' : '#202223',
                      cursor: 'pointer', fontSize: '13px',
                      fontWeight: sortAZ ? '600' : '400', whiteSpace: 'nowrap',
                    }}
                  >
                    {sortAZ ? 'Sort A→Z ✓' : 'Sort'}
                  </button>
                )}
              </InlineStack>

              <Card>
                <DataTable
                  columnContentTypes={isScanCountMode ? ['text', 'numeric', 'text', 'numeric'] : ['text', 'numeric', 'text', 'text']}
                  headings={isScanCountMode ? ['Name / SKU', 'System', '', 'Scans'] : ['Name / SKU', 'System', 'Scans', 'Actual']}
                  rows={rows}
                />
              </Card>
              <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} />
            </BlockStack>
          </Layout.Section>
        </Layout>

        {/* Barcode-not-found — tap anywhere to dismiss, same as ManagerTaskDetail.js */}
        {errorPopup && (
          <div onClick={() => setErrorPopup('')} style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              background: 'white', borderRadius: '12px',
              padding: '24px 32px', maxWidth: '320px', textAlign: 'center',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
              <Text variant="bodyLg" fontWeight="bold">{errorPopup}</Text>
              <div style={{ marginTop: '12px', fontSize: '13px', color: '#6d7175' }}>Tap anywhere to dismiss</div>
            </div>
          </div>
        )}

        {/* Type in SKU — locate an item in this frozen task by SKU */}
        {showSkuInput && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          }}>
            <div style={{
              position: 'fixed', top: '50%', left: '16px', right: '16px',
              transform: 'translateY(-50%)',
              background: 'white', borderRadius: '12px', padding: '24px',
              maxWidth: '400px', margin: '0 auto', zIndex: 1001,
            }}>
              <button
                onClick={() => { setShowSkuInput(false); setSkuInput(''); setSkuError(''); }}
                style={{ position: 'absolute', top: '12px', right: '12px',
                  background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer' }}
              >✕</button>
              <BlockStack gap="300">
                <Text variant="headingMd" fontWeight="bold">Type in SKU</Text>
                {skuError && (
                  <div style={{ background: '#fff4f4', borderRadius: '8px', padding: '10px 14px',
                    fontSize: '14px', color: '#d72c0d' }}>
                    {skuError}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '14px', color: '#202223', fontWeight: '500', marginBottom: '4px' }}>SKU</div>
                    <input
                      inputMode="numeric"
                      value={skuInput}
                      onChange={e => { setSkuInput(e.target.value); setSkuError(''); }}
                      onKeyDown={e => { if (e.key === 'Enter') handleSkuSearch(); }}
                      autoComplete="off" autoFocus
                      placeholder="Enter exact SKU"
                      style={{
                        width: '100%', padding: '10px 12px', fontSize: '16px',
                        border: '1px solid #c9cccf', borderRadius: '8px',
                        outline: 'none', boxSizing: 'border-box', display: 'block',
                      }}
                      onFocus={e => { e.target.style.borderColor = '#005bd3'; }}
                      onBlur={e => { e.target.style.borderColor = '#c9cccf'; }}
                    />
                  </div>
                  <button
                    onClick={handleSkuSearch}
                    disabled={!skuInput.trim()}
                    style={{
                      padding: '10px 18px', borderRadius: '8px', border: 'none',
                      background: skuInput.trim() ? '#008060' : '#f6f6f7',
                      color: skuInput.trim() ? 'white' : '#8c9196',
                      cursor: skuInput.trim() ? 'pointer' : 'not-allowed',
                      fontSize: '14px', fontWeight: '600', whiteSpace: 'nowrap',
                    }}
                  >
                    Search
                  </button>
                </div>
              </BlockStack>
            </div>
          </div>
        )}

        {/* Read-only item lookup popup — opened by Type in SKU or a physical
            scan. Shows this item's frozen System/Scans/Actual; no input, no
            Correct/Reset/Submit — there's nothing here left to change. */}
        {popupItem && (
          <div onClick={() => setPopupItem(null)} style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          }}>
            <div onClick={e => e.stopPropagation()} style={{
              position: 'fixed', top: '50%', left: '16px', right: '16px',
              transform: 'translateY(-50%)',
              background: 'white', borderRadius: '12px', padding: '24px',
              maxWidth: '480px', margin: '0 auto', zIndex: 1001,
            }}>
              <button onClick={() => setPopupItem(null)} style={{
                position: 'absolute', top: '12px', right: '12px',
                background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', zIndex: 1,
              }}>✕</button>

              <BlockStack gap="400">
                <div style={{ paddingRight: '28px' }}>
                  <div style={{ fontSize: '16px', fontWeight: '700', lineHeight: '1.4', wordBreak: 'break-word' }}>
                    {popupItem.name}
                  </div>
                  <div style={{ fontSize: '13px', color: '#6d7175' }}>{popupItem.barcode}</div>
                </div>

                {(popupItem.scan_history || []).length > 0 && (
                  <BlockStack gap="100">
                    {popupItem.scan_history.map((s, i) => (
                      <InlineStack key={i} gap="200">
                        <span style={{
                          width: '8px', height: '8px', borderRadius: '50%',
                          background: 'black', display: 'inline-block', marginTop: '6px',
                        }} />
                        <Text>{s.type === 'correct' ? 'correct' : `counted ${s.value}`}</Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}

                <InlineStack gap="400" wrap>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">System</Text>
                    <Text variant="headingMd" fontWeight="bold">{popupItem.soh !== null && popupItem.soh !== undefined ? popupItem.soh : '-'}</Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">Actual</Text>
                    <Text variant="headingMd" fontWeight="bold">{popupItem.poh !== null && popupItem.poh !== undefined ? popupItem.poh : '-'}</Text>
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </div>
          </div>
        )}
      </Page>
    </div>
  );
}

export default ManagerTaskHistoryDetail;
