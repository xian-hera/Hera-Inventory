import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Banner, Spinner, TextField, Button
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
    // Click anywhere on the dark backdrop closes the modal (Hera, 2026-09-16
    // — the alreadyDemo warning banner used to partially cover the ✕ button,
    // making it fiddly to hit; clicking outside the modal is now the primary
    // way to close it). The ✕ button is kept as a secondary, more discoverable
    // close affordance — it still works the same as before.
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: '16px', padding: '24px',
          width: 'calc(100% - 32px)', maxWidth: '460px',
          maxHeight: '90vh', overflowY: 'auto', position: 'relative',
          cursor: 'default',
        }}
      >
        <button onClick={onClose} style={{
          position: 'absolute', top: '12px', right: '12px',
          background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
        }}>✕</button>

        {loading || !data ? (
          <InlineStack align="center"><Spinner /></InlineStack>
        ) : (
          <BlockStack gap="300">
            {error && <Banner tone="critical">{error}</Banner>}

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

            {/* Making a demo for a SKU that's already this location's
                current demo used to be blocked here (disabled button +
                warning banner above). Hera, 2026-09-16: that's wrong — the
                demo that just sold and the new demo being made can
                legitimately be the exact same variant, and the correct
                behavior is a normal replace (old released, new added), same
                as swapping to a different variant of the same product. See
                the POST /api/wig-demo handler in wigDemo.js for the
                same-SKU shortcut this enables server-side. */}
            <button
              disabled={submitting}
              onClick={onSubmit}
              style={{
                width: '100%', padding: '16px', borderRadius: '10px', border: 'none',
                background: submitting ? '#f0f0f0' : '#005bd3',
                color: submitting ? '#8c9196' : 'white',
                cursor: submitting ? 'not-allowed' : 'pointer',
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
          onClick={(e) => { e.stopPropagation(); setZoomOpen(false); }}
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

// ─── How to Use overlay ─────────────────────────────────────────────────────
// Full-screen dark scrim with plain-language usage instructions. Click
// anywhere (including on the text) closes it — Hera's explicit spec, so
// unlike AddDemoModal's image zoom (which stops propagation on the image so
// only the backdrop closes it) this overlay has no inner stopPropagation.
// Copy and layout are Hera's own final version (2026-09-16, replacing the
// earlier 5-point placeholder draft): a 2-step numbered "how to make a
// demo" list, two explainer paragraphs, a worked example set off in a
// pill-shaped callout, and a closing note on cancelling. The example pill
// deliberately uses a *subtle* translucent-white fill rather than a
// saturated color (a first pass used a pale yellow, which read as an
// emphasis/warning callout — Hera wanted differentiation, not emphasis, so
// it's just barely lighter than the surrounding text, confirmed against an
// HTML preview before this was coded up).
function HowToUseOverlay({ onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '32px 24px', cursor: 'pointer',
      }}
    >
      <div style={{ maxWidth: '440px', color: 'white', textAlign: 'left' }}>
        <div style={{ fontSize: '15px', fontWeight: '700', marginBottom: '20px' }}>
          Use this page to MAKE demo only.
        </div>

        <ol style={{ margin: '0 0 20px', paddingLeft: '22px' }}>
          <li style={{ fontSize: '15px', lineHeight: 1.6, marginBottom: '14px' }}>
            Scan a WIG barcode with the scanner, or use the search box, to find the wig you want to demo.
          </li>
          <li style={{ fontSize: '15px', lineHeight: 1.6 }}>
            Check the details in the popup, you can also tap the thumbnail to enlarge the photo, for verification. Then tap "Make DEMO".
          </li>
        </ol>

        <div style={{ fontSize: '15px', lineHeight: 1.6, marginBottom: '16px' }}>
          The list shows every current demo at your location: SKU / Name / Color, the date it became a demo, and its Wig number.
        </div>

        <div style={{ fontSize: '15px', lineHeight: 1.6, marginBottom: '16px' }}>
          A wig can only have 1 demo at any time, so when you add a new demo, the existing demo of the same wig will be replaced.
        </div>

        <div style={{
          background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.14)',
          color: 'rgba(255,255,255,0.85)', borderRadius: '16px', padding: '14px 18px',
          fontSize: '14px', lineHeight: 1.6, marginBottom: '16px',
        }}>
          For example, you have added color #1 of the wig Ryella as demo in Hub, when that demo is sold, you want to add color #2 as new demo, when you do, color #1 in the list will be replaced.
        </div>

        <div style={{ fontSize: '15px', lineHeight: 1.6 }}>
          To cancel a demo if you made a mistake, contact the buyer.
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
function ManagerWigDemo() {
  const navigate = useNavigate();
  const location = localStorage.getItem('managerLocation') || '';

  const [shopifyLocationId, setShopifyLocationId] = useState('');
  const [items, setItems]             = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');

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

  const [showHelp, setShowHelp] = useState(false);

  const popupOpen = modalOpen || modalLoading;

  useEffect(() => {
    document.body.style.overflow = (popupOpen || showHelp) ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [popupOpen, showHelp]);

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
      if (popupOpen || showHelp) return;
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
  }, [popupOpen, showHelp, shopifyLocationId, location]);

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

  return (
    <Page
      title="Wig DEMO"
      backAction={{ onAction: () => navigate('/manager') }}
      secondaryActions={[{ content: 'How to Use', onAction: () => setShowHelp(true) }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm">Current demos</Text>

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
                      // Used to show "✓ Already a demo" instead of an Add
                      // button for a SKU that's already this location's
                      // current demo, blocking re-adding it from search
                      // results. Hera, 2026-09-16: that block is gone — see
                      // the Make DEMO button in AddDemoModal above — so this
                      // always shows Add now, same as any other search
                      // result. No special-casing needed here any more: a
                      // click still opens the normal Add Demo modal, and the
                      // backend handles the "same SKU" replace on its own.
                      searchResults.map(r => (
                        <div key={r.variantId} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '10px 12px', borderTop: '1px solid #f1f1f1',
                        }}>
                          <Text variant="bodySm">{r.barcode} — {r.name}</Text>
                          <button
                            onClick={() => openAddDemoModal(r.barcode)}
                            style={{
                              padding: '6px 14px', borderRadius: '8px', border: '1px solid #c9cccf',
                              background: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: '500',
                            }}
                          >
                            Add
                          </button>
                        </div>
                      ))
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
                        keep their own narrow column at the right. No
                        checkbox column any more — it only ever existed to
                        select rows for Cancel DEMO, which Hera had removed
                        from this page 2026-09-16 (Manager can no longer
                        cancel a demo themselves; see
                        claude/DEMO_WIG_FEATURE_SPEC.md §18). */}
                    <div style={{
                      display: 'grid', gridTemplateColumns: '1fr 90px 70px',
                      gap: '8px', padding: '8px 0', borderBottom: '1px solid #e1e3e5',
                      fontSize: '12px', fontWeight: '600', color: '#6d7175',
                    }}>
                      <span>SKU / Name / Color</span>
                      <span>Demo date</span>
                      <span>Wig number</span>
                    </div>
                    {items.map(item => (
                      <div key={item.id} style={{
                        display: 'grid', gridTemplateColumns: '1fr 90px 70px',
                        gap: '8px', padding: '10px 0', borderBottom: '1px solid #f1f1f1',
                        alignItems: 'start',
                      }}>
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

      {showHelp && <HowToUseOverlay onClose={() => setShowHelp(false)} />}
    </Page>
  );
}

export default ManagerWigDemo;
