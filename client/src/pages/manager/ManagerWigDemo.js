import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Checkbox, Banner, Spinner, TextField, Button
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

// ─── Barcode-scanner keyboard-emulation helpers ────────────────────────────
// Same approach as ManagerStockLosses.js / ManagerInventoryCount-style pages:
// the scanner types characters fast then sends Enter. We buffer keystrokes
// and flush on Enter (or after a short idle gap, in case Enter never comes).
function resolveKey(e) {
  if (e.key && e.key !== 'Unidentified' && e.key.length === 1) return e.key;
  if (e.code) {
    if (e.code.startsWith('Digit')) return e.code.slice(5);
    if (e.code.startsWith('Numpad') && e.code.length === 7) return e.code.slice(6);
    if (e.code.startsWith('Key') && e.code.length === 4) {
      const ch = e.code.slice(3);
      return e.shiftKey ? ch : ch.toLowerCase();
    }
    const sym = {
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
      Comma: ',', Period: '.', Slash: '/',
    };
    if (sym[e.code]) return sym[e.code];
  }
  return null;
}

function cleanBarcode(raw) {
  return raw.replace(/^[^0-9]+/, '');
}

function formatDemoDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── Add Demo modal ─────────────────────────────────────────────────────────
function AddDemoModal({ data, loading, submitting, error, onClose, onSubmit }) {
  const [zoomOpen, setZoomOpen] = useState(false);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'white', borderRadius: '16px', padding: '24px',
        width: 'calc(100% - 32px)', maxWidth: '460px',
        maxHeight: '90vh', overflowY: 'auto', position: 'relative',
      }}>
        <button onClick={onClose} style={{
          position: 'absolute', top: '12px', right: '12px',
          background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
        }}>✕</button>

        {loading || !data ? (
          <InlineStack align="center"><Spinner /></InlineStack>
        ) : (
          <BlockStack gap="300">
            {error && <Banner tone="critical">{error}</Banner>}
            {data.alreadyDemo && (
              <Banner tone="warning">This SKU is already the current demo for this location.</Banner>
            )}

            <InlineStack gap="300" blockAlign="start" wrap={false}>
              <div
                onClick={() => data.image && setZoomOpen(true)}
                style={{
                  width: '100px', height: '130px', borderRadius: '8px',
                  background: '#d3d3d3', flexShrink: 0, overflow: 'hidden',
                  cursor: data.image ? 'pointer' : 'default',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {data.image ? (
                  <img src={data.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontSize: '12px', color: '#6d7175', padding: '8px', textAlign: 'center' }}>No image</span>
                )}
              </div>
              <BlockStack gap="100">
                <Text variant="headingMd" fontWeight="bold">{data.name}</Text>
                <Text variant="bodyMd" tone="subdued">{data.barcode}</Text>
                <Text variant="bodyMd" tone="subdued">{data.variantName}</Text>
                <Text variant="bodyMd" tone="subdued">{data.wigNumber || '-'}</Text>
              </BlockStack>
            </InlineStack>

            <button
              disabled={submitting || data.alreadyDemo}
              onClick={onSubmit}
              style={{
                width: '100%', padding: '16px', borderRadius: '10px', border: 'none',
                background: submitting || data.alreadyDemo ? '#f0f0f0' : '#005bd3',
                color: submitting || data.alreadyDemo ? '#8c9196' : 'white',
                cursor: submitting || data.alreadyDemo ? 'not-allowed' : 'pointer',
                fontSize: '20px', fontWeight: '700',
              }}
            >
              {submitting ? 'Making demo…' : 'Make DEMO'}
            </button>
          </BlockStack>
        )}
      </div>

      {zoomOpen && data?.image && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 1002,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setZoomOpen(false)}
        >
          <button onClick={() => setZoomOpen(false)} style={{
            position: 'fixed', top: '16px', right: '16px', zIndex: 1003,
            width: '36px', height: '36px', borderRadius: '50%',
            background: 'rgba(255,255,255,0.9)', border: 'none',
            fontSize: '20px', lineHeight: 1, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
          <img
            src={data.image} alt=""
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
function ManagerWigDemo() {
  const navigate = useNavigate();
  const location = localStorage.getItem('managerLocation') || '';

  const [shopifyLocationId, setShopifyLocationId] = useState('');
  const [items, setItems]             = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [cancelling, setCancelling]   = useState(false);

  const barcodeBuffer = useRef('');
  const barcodeTimer  = useRef(null);

  const [searchQuery, setSearchQuery]     = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen]       = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const [modalOpen, setModalOpen]           = useState(false);
  const [modalLoading, setModalLoading]     = useState(false);
  const [modalData, setModalData]           = useState(null);
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const [modalError, setModalError]         = useState('');

  const popupOpen = modalOpen || modalLoading;

  useEffect(() => {
    document.body.style.overflow = popupOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [popupOpen]);

  useEffect(() => {
    if (!location) return;
    fetch('/api/shopify/locations')
      .then(r => r.json())
      .then(data => {
        const loc = (Array.isArray(data) ? data : []).find(l => l.name === location);
        if (loc) setShopifyLocationId(loc.id);
      })
      .catch(() => {});
  }, [location]);

  const loadItems = useCallback(async () => {
    if (!location) { setLoading(false); return; }
    try {
      const res = await fetch(`/api/wig-demo?location=${encodeURIComponent(location)}`);
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError('Failed to load');
    } finally {
      setLoading(false);
    }
  }, [location]);

  useEffect(() => { loadItems(); }, [loadItems]);

  // ── Barcode scanner listener — same pattern as ManagerStockLosses.js ──────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (popupOpen) return;
      const activeTag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA'].includes(activeTag)) return;
      if (e.key === 'Enter') {
        clearTimeout(barcodeTimer.current);
        const barcode = cleanBarcode(barcodeBuffer.current.trim());
        barcodeBuffer.current = '';
        if (barcode.length > 0) openAddDemoModal(barcode);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popupOpen, shopifyLocationId, location]);

  const openAddDemoModal = async (barcode) => {
    if (!shopifyLocationId) { setError('Location not ready yet — please try again in a moment.'); return; }
    setModalOpen(true);
    setModalLoading(true);
    setModalError('');
    setModalData(null);
    try {
      const res = await fetch(
        `/api/wig-demo/lookup?barcode=${encodeURIComponent(barcode)}&locationId=${encodeURIComponent(shopifyLocationId)}&location=${encodeURIComponent(location)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Product not found');
      setModalData(data);
    } catch (e) {
      setModalOpen(false);
      setError(e.message || 'Product not found');
    } finally {
      setModalLoading(false);
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalData(null);
    setModalError('');
  };

  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/shopify/search?q=${encodeURIComponent(searchQuery.trim())}&types=WIG`);
      const data = await res.json();
      setSearchResults(data.results || []);
      setSearchOpen(true);
    } catch {
      setError('Search failed.');
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  const handleMakeDemo = async () => {
    if (!modalData) return;
    setModalSubmitting(true);
    setModalError('');
    try {
      const res = await fetch('/api/wig-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location, shopifyLocationId,
          barcode: modalData.barcode, name: modalData.name, variantName: modalData.variantName,
          productId: modalData.productId, variantId: modalData.variantId,
          inventoryItemId: modalData.inventoryItemId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to make demo');
      setItems(prev => {
        const withoutReplaced = data.replaced ? prev.filter(i => i.id !== data.replaced.id) : prev;
        return [data.row, ...withoutReplaced];
      });
      if (data.replaceWarning) setError(data.replaceWarning);
      closeModal();
      setSearchOpen(false);
      setSearchQuery('');
    } catch (e) {
      setModalError(e.message);
    } finally {
      setModalSubmitting(false);
    }
  };

  const handleCancelDemo = async () => {
    if (selectedIds.length === 0) return;
    setCancelling(true);
    setError('');
    try {
      const res = await fetch('/api/wig-demo', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel');
      setItems(prev => prev.filter(i => !(data.deletedIds || []).includes(i.id)));
      setSelectedIds([]);
      if (data.errors?.length > 0) setError(data.errors.join('\n'));
    } catch (e) {
      setError(e.message);
    } finally {
      setCancelling(false);
    }
  };

  const toggleSelectOne = (id) => setSelectedIds(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll = () =>
    setSelectedIds(selectedIds.length === items.length ? [] : items.map(i => i.id));

  return (
    <Page title="Wig DEMO" backAction={{ onAction: () => navigate('/manager') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap gap="200">
                  <Text variant="headingSm">Current demos</Text>
                  <Button
                    tone="critical"
                    disabled={selectedIds.length === 0}
                    loading={cancelling}
                    onClick={handleCancelDemo}
                  >
                    Cancel DEMO
                  </Button>
                </InlineStack>

                <InlineStack align="space-between" blockAlign="center" wrap gap="200">
                  <Text variant="bodySm" tone="subdued">Scan barcode to add a new demo or search</Text>
                  <InlineStack gap="100" blockAlign="center">
                    {/* Polaris TextField has no font-size variant of its own
                        (it always renders at Polaris's standard input size),
                        so matching it to the small bodySm text used elsewhere
                        on this page needs a scoped CSS override on the
                        underlying <input> — no existing convention for this
                        in the codebase to reuse, this is the first one. */}
                    <div className="wig-demo-search-field" style={{ minWidth: '180px' }}>
                      <style>{`.wig-demo-search-field input { font-size: 12px; }`}</style>
                      <TextField
                        label="" labelHidden
                        placeholder="SKU / name"
                        value={searchQuery}
                        onChange={setSearchQuery}
                        onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                        autoComplete="off"
                      />
                    </div>
                    <Button onClick={runSearch} loading={searchLoading}>Search</Button>
                  </InlineStack>
                </InlineStack>

                {searchOpen && (
                  <div style={{ border: '1px solid #e1e3e5', borderRadius: '8px', overflow: 'hidden' }}>
                    <InlineStack align="space-between" blockAlign="center" gap="200">
                      <div style={{ padding: '8px 12px' }}>
                        <Text variant="bodySm" fontWeight="medium">Search results</Text>
                      </div>
                      <div style={{ padding: '8px 12px', cursor: 'pointer' }} onClick={() => setSearchOpen(false)}>✕</div>
                    </InlineStack>
                    {searchResults.length === 0 ? (
                      <div style={{ padding: '12px' }}>
                        <Text tone="subdued" variant="bodySm">No WIG matches.</Text>
                      </div>
                    ) : (
                      searchResults.map(r => {
                        const already = items.some(i => i.barcode === r.barcode);
                        return (
                          <div key={r.variantId} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '10px 12px', borderTop: '1px solid #f1f1f1',
                          }}>
                            <Text variant="bodySm">{r.barcode} — {r.name}</Text>
                            {already ? (
                              <Text variant="bodySm" tone="success">✓ Already a demo</Text>
                            ) : (
                              <button
                                onClick={() => openAddDemoModal(r.barcode)}
                                style={{
                                  padding: '6px 14px', borderRadius: '8px', border: '1px solid #c9cccf',
                                  background: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: '500',
                                }}
                              >
                                Add
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {loading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : items.length === 0 ? (
                  <Text tone="subdued" alignment="center">No demos yet. Scan a barcode or search to add one.</Text>
                ) : (
                  <div>
                    {/* Manager is mostly used on mobile — SKU/Name/Color are
                        stacked into one merged column (same pattern as
                        ManagerStockLosses.js) instead of separate fixed-width
                        columns, which was cramping "Name" down to almost
                        nothing on a phone screen and wrapping it one letter
                        per line. Demo date and Wig number (custom.wig_number
                        metafield, see attachWigNumbers() in wigDemo.js) each
                        keep their own narrow column at the right. */}
                    <div style={{
                      display: 'grid', gridTemplateColumns: '32px 1fr 90px 70px',
                      gap: '8px', padding: '8px 0', borderBottom: '1px solid #e1e3e5',
                      fontSize: '12px', fontWeight: '600', color: '#6d7175',
                    }}>
                      <Checkbox
                        checked={selectedIds.length === items.length && items.length > 0}
                        indeterminate={selectedIds.length > 0 && selectedIds.length < items.length}
                        onChange={toggleSelectAll}
                      />
                      <span>SKU / Name / Color</span>
                      <span>Demo date</span>
                      <span>Wig number</span>
                    </div>
                    {items.map(item => (
                      <div key={item.id} style={{
                        display: 'grid', gridTemplateColumns: '32px 1fr 90px 70px',
                        gap: '8px', padding: '10px 0', borderBottom: '1px solid #f1f1f1',
                        alignItems: 'start',
                      }}>
                        <Checkbox
                          checked={selectedIds.includes(item.id)}
                          onChange={() => toggleSelectOne(item.id)}
                        />
                        <div>
                          <div style={{ fontSize: '12px', wordBreak: 'break-word' }}>{item.barcode}</div>
                          <div style={{ fontSize: '12px', fontWeight: '500', wordBreak: 'break-word', marginTop: '2px' }}>
                            {item.name || '-'}
                          </div>
                          <div style={{ fontSize: '12px', color: '#6d7175', marginTop: '2px' }}>
                            {item.variant_name || '-'}
                          </div>
                        </div>
                        <div style={{ fontSize: '12px' }}>{formatDemoDate(item.created_at)}</div>
                        <div style={{ fontSize: '12px', wordBreak: 'break-word' }}>{item.wig_number || '-'}</div>
                      </div>
                    ))}
                  </div>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {popupOpen && (
        <AddDemoModal
          data={modalData}
          loading={modalLoading}
          submitting={modalSubmitting}
          error={modalError}
          onClose={closeModal}
          onSubmit={handleMakeDemo}
        />
      )}
    </Page>
  );
}

export default ManagerWigDemo;
