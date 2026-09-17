import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Banner, TextField, Button
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

// ─── Card grouping (2026-09-17, Hera) ───────────────────────────────────────
// Manager's list is now split into one card per product custom.sub_type,
// plus a SOLDE card for cleared-out stock (split further into the same 5
// sub-type sections, divided by a labeled rule). The actual sub_type ->
// card mapping and the wig_number === "SOLDE" check both happen server-side
// (see categorizeRow() in server/routes/wigDemo.js) — every item GET / (and
// POST /refresh-wig-numbers) returns already carries `category` (one of
// CARD_ORDER below, or 'UNKNOWN' for "sub type not found") and `section`
// (only set when category === 'SOLDE', one of SOLDE_SECTION_ORDER). Kept
// server-side rather than duplicated here so there's only one place this
// mapping can ever drift — see claude/DEMO_WIG_FEATURE_SPEC.md §32.
const CARD_ORDER = ['FULL', 'HALF', 'LACE', 'HUMAN HAIR', 'TOPPERS', 'SOLDE'];
const SOLDE_SECTION_ORDER = ['FULL', 'HALF', 'LACE', 'HUMAN HAIR', 'TOPPERS'];

// Name/Color de-duplication (2026-09-17, Hera): every wig's Name already
// ends with its own Color (e.g. Name "BFF TP MIRELLA #BURGUNDY ANGEL",
// Color "#BURGUNDY ANGEL"), and Color is also shown as its own line right
// below Name — so the color text was effectively printed twice, which was
// also most of what made Name so wide it squeezed Demo date/Wig number.
// Hera's rule: "在 Name 的末尾找到和 Color 一致的部分（包括 #），然后不在列表
// 里显示这个部分" — an exact suffix match (Color, including its leading
// "#"), matched against Name's raw text as-is (not case-folded — Hera said
// the two are already "完全一致" in the data, so this doesn't try to guess
// around a mismatch). Only ever changes what's *rendered*; item.name itself
// is untouched. Falls back to the full Name whenever there's no exact
// match, so a row that doesn't follow this convention (or predates it)
// never gets silently mangled.
//
// "@" instead of "#" (2026-09-17 follow-up, Hera): some wigs spell their
// trailing color in Name with "@" where Color itself still starts with "#"
// (e.g. Name "WIG@ LACE ARLENA @613", Color "#613"). Hera: "仅针对末尾的 @"
// — only the trailing occurrence is treated as equivalent to "#", because a
// Name like that one also has an *earlier* "@" (right after "WIG") that
// must NOT be touched. This never scans the string for "@" — it only ever
// checks whether Name's exact tail matches Color as given, or matches Color
// with its leading "#" swapped for "@", so an unrelated "@" earlier in the
// string can never accidentally match.
//
// Leading "WIG" (2026-09-17 follow-up, Hera): a second, independent rule —
// "只要 Name 是以 WIG 开头，就隐藏掉这三个字母，以及其后的一个空格" — applied
// regardless of whether the color-suffix rule above matched anything.
// Consumes at most one following space, only if one is actually there right
// after "WIG": "WIG FW DASHLY..." -> "FW DASHLY..." (space consumed), but
// "WIG@ LACE ARLENA" -> "@ LACE ARLENA" (next character is "@", not a
// space, so nothing extra is consumed and the "@" stays) — matching Hera's
// own worked example end to end: Name "WIG@ LACE ARLENA @613" + Color
// "#613" -> strip the "@613" suffix -> "WIG@ LACE ARLENA" -> strip leading
// "WIG" -> "@ LACE ARLENA".
//
// Performance: still just string prefix/suffix checks and slices on two
// strings already sitting in the row object in memory — no extra fetch or
// database work, no scanning/regex over the whole string. Even a card with
// a few hundred rows costs a fraction of a millisecond total for this, well
// under anything a person could notice next to the React rendering work
// already happening for every row regardless.
function displayName(name, color) {
  const n = (name || '').toString();
  const c = (color || '').toString();
  let result = n;

  if (n && c) {
    const candidates = c.startsWith('#') ? [c, '@' + c.slice(1)] : [c];
    const matched = candidates.find(cand => n.endsWith(cand));
    if (matched) {
      result = n.slice(0, n.length - matched.length).trimEnd();
    }
  }

  if (result.startsWith('WIG')) {
    result = result.slice(3);
    if (result.startsWith(' ')) result = result.slice(1);
  }

  return result;
}

// A single demo row — same column layout as the old flat list, reused for
// every card/section's list below.
function DemoRow({ item }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 90px 80px',
      gap: '10px', padding: '10px 0', borderBottom: '1px solid #f1f1f1',
      alignItems: 'start',
    }}>
      <div>
        <div style={{ fontSize: '12px', wordBreak: 'break-word' }}>{item.barcode}</div>
        <div style={{ fontSize: '12px', fontWeight: '500', wordBreak: 'break-word', marginTop: '2px' }}>
          {displayName(item.name, item.variant_name) || '-'}
        </div>
        <div style={{ fontSize: '12px', color: '#6d7175', marginTop: '2px', wordBreak: 'break-word' }}>
          {item.variant_name || '-'}
        </div>
      </div>
      <div style={{ fontSize: '12px' }}>{formatDemoDate(item.created_at)}</div>
      <div style={{ fontSize: '12px', wordBreak: 'break-word' }}>{item.wig_number || '-'}</div>
    </div>
  );
}

// Column widths (2026-09-17, Hera: "保证每个 column 的安全宽度，留取一点点
// padding") — Wig number 70→80px and the gap between columns widened
// 8→10px. Color itself isn't a separate grid column here (it's stacked
// under Name inside the first, flexible column, unlike Buyer's layout which
// has Color as its own narrow column), so it was never at risk of the exact
// overlap Hera saw on Buyer's page — this still adds the same wordBreak
// safety to it above, plus the wider Wig number column here for consistency.
const DEMO_ROW_HEADER = (
  <div style={{
    display: 'grid', gridTemplateColumns: '1fr 90px 80px',
    gap: '10px', padding: '8px 0', borderBottom: '1px solid #e1e3e5',
    fontSize: '12px', fontWeight: '600', color: '#6d7175',
  }}>
    <span>SKU / Name / Color</span>
    <span>Demo date</span>
    <span>Wig number</span>
  </div>
);

// A list of demos under one card/section — shows the "No demos" subdued line
// instead of an empty column header when there aren't any (Hera: a card or
// section with 0 demos still shows, just with nothing under it).
function DemoList({ items }) {
  if (items.length === 0) {
    return <Text tone="subdued" variant="bodySm">No demos.</Text>;
  }
  return (
    <div>
      {DEMO_ROW_HEADER}
      {items.map(item => <DemoRow key={item.id} item={item} />)}
    </div>
  );
}

// Divider + centered title used to separate the 5 sub-type sections inside
// the SOLDE card (Hera: "用分割线来水平分隔多个列表，分割线居中写 title，title
// 后面跟着 demo 的数量").
function SectionDivider({ title, count }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '4px 0' }}>
      <div style={{ flex: 1, height: '1px', background: '#e1e3e5' }} />
      <Text variant="bodySm" fontWeight="semibold" tone="subdued">{title} ({count})</Text>
      <div style={{ flex: 1, height: '1px', background: '#e1e3e5' }} />
    </div>
  );
}

// One card per category — same "click header to expand/collapse, default
// collapsed, count in the header" shape as Buyer's per-location cards (see
// BuyerWigDemo.js). `critical` styles the header red — used for the "Sub
// type not found" card, since that one is flagging a data problem rather
// than a normal category.
function CategoryCard({ title, count, expanded, onToggle, critical, children }) {
  return (
    <Card>
      <BlockStack gap="300">
        <div
          onClick={onToggle}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <Text tone={critical ? 'critical' : 'subdued'}>{expanded ? '▾' : '▸'}</Text>
          <Text variant="headingSm" fontWeight="bold" tone={critical ? 'critical' : undefined}>{title}</Text>
          <Text tone={critical ? 'critical' : 'subdued'}>{count} demo{count === 1 ? '' : 's'}</Text>
        </div>
        {expanded && children}
      </BlockStack>
    </Card>
  );
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
          <Text alignment="center" tone="subdued">Loading...</Text>
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
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.94)', zIndex: 1100,
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
  const [exportingPdf, setExportingPdf] = useState(false);
  const [refreshingWigNumbers, setRefreshingWigNumbers] = useState(false);

  // Which cards are expanded (2026-09-17, Hera: cards default collapsed to a
  // one-line "name + demo count" header, same as Buyer's per-location cards
  // — see BuyerWigDemo.js's expandedLocations). Only resets on page re-entry
  // (the initial empty Set below) or after clicking Refresh Wig Number
  // (Hera: "展开状态只会在重新进入页面，或者按下了 refresh 之后刷新") — a normal
  // list update (e.g. making a new demo) leaves whatever's expanded alone.
  const [expandedCards, setExpandedCards] = useState(new Set());
  const toggleCardExpanded = (card) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(card)) next.delete(card); else next.add(card);
      return next;
    });
  };

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
      const list = Array.isArray(data) ? data : [];
      setItems(list);

      // Wig Number auto-heal (2026-09-16): wig_number comes from a live,
      // batched Shopify lookup (attachWigNumbers() in wigDemo.js) that already
      // retries once server-side, but Hera still saw a row load with "-" and
      // then show the real number after a manual page refresh — a transient
      // Shopify/network hiccup on that one batched request, not a genuinely
      // empty metafield. Rather than asking her to refresh (the Add Demo
      // modal's own single-item lookup doesn't have this problem, so the list
      // shouldn't need to either), silently re-fetch once in the background
      // and patch in wig_number for any row that's still missing it. Matched
      // by id so this only fills gaps — it never overwrites or reorders what's
      // already on screen. Best-effort: if this second fetch also comes back
      // empty for a row, it's left showing "-" rather than retried forever.
      if (list.some(i => !i.wig_number)) {
        setTimeout(async () => {
          try {
            const res2 = await fetch(`/api/wig-demo?location=${encodeURIComponent(location)}`);
            const data2 = await res2.json();
            const list2 = Array.isArray(data2) ? data2 : [];
            const wigNumberById = new Map(list2.map(i => [i.id, i.wig_number]));
            setItems(prev => prev.map(i => (
              !i.wig_number && wigNumberById.get(i.id)
                ? { ...i, wig_number: wigNumberById.get(i.id) }
                : i
            )));
          } catch (e) {
            // best-effort only — leave "-" showing if this also fails
          }
        }, 1500);
      }
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

  // Refresh Wig Number (Hera, 2026-09-17): re-queries Shopify live for
  // wig_number and updates the DB (see POST /refresh-wig-numbers in
  // server/routes/wigDemo.js), scoped to just this manager's own location —
  // same scope as the rest of this page (Hera's answer: NOT every location,
  // that's Buyer's button). The endpoint returns the refreshed list in the
  // same shape as GET /, so this just replaces items with the response.
  const handleRefreshWigNumbers = async () => {
    if (!location) return;
    setRefreshingWigNumbers(true);
    setError('');
    try {
      const res = await fetch('/api/wig-demo/refresh-wig-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to refresh wig numbers');
      setItems(Array.isArray(data) ? data : []);
      // Collapse every card back down (Hera, 2026-09-17: expanded state
      // should reset after Refresh, same as re-entering the page) — a demo
      // can move cards entirely when its wig_number becomes/stops being
      // "SOLDE", so keeping old cards expanded after this could leave a now-
      // empty card open and a newly-populated one collapsed.
      setExpandedCards(new Set());
    } catch (e) {
      setError(e.message || 'Failed to refresh wig numbers');
    } finally {
      setRefreshingWigNumbers(false);
    }
  };

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
          // wig_number is now a persisted column (2026-09-17, Hera — see the
          // wig_demos.wig_number migration in server/database/init.js) and
          // the backend's INSERT wants it at creation time, so it's sent
          // along here too now (previously not sent at all — see the
          // wig_number note in setItems() below for what that used to mean).
          wigNumber: modalData.wigNumber || '',
          // subType (2026-09-17, Hera): fix for a bug found this same day —
          // GET /lookup already resolves and returns subType (it's what
          // modalData.subType holds right now), but this POST body never
          // forwarded it, so the server's own defensive re-check at POST /
          // (`if (!subType) ...`, added as a belt-and-suspenders guard since
          // /lookup already blocks a missing sub_type before this modal can
          // even open) always saw undefined and rejected every single Make
          // DEMO submission with "Sub type not found" — regardless of what
          // Shopify actually had. Sending it through now, same as wigNumber
          // above.
          subType: modalData.subType || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to make demo');
      setItems(prev => {
        const withoutReplaced = data.replaced ? prev.filter(i => i.id !== data.replaced.id) : prev;
        // wig_number isn't a column on wig_demos (see spec §5 — it's always read
        // live from Shopify, never persisted), so the freshly-inserted row the
        // POST just returned has no wig_number field at all. The Add Demo modal
        // already fetched it a moment ago via GET /lookup (it's what's on screen
        // in the modal right now as modalData.wigNumber) — reuse that instead of
        // leaving this row blank until the next full list reload fills it in.
        //
        // 2026-09-17 update: wig_number IS now a persisted column (see the
        // migration in server/database/init.js), and modalData.wigNumber is
        // now sent up in the POST body above, so data.row already comes back
        // with the correct wig_number via the INSERT's RETURNING *. The
        // override below is redundant now (both sides hold the same value)
        // but left in place rather than removed, since it's harmless and
        // still a reasonable belt-and-suspenders fallback if that ever
        // changes.
        const newRow = { ...data.row, wig_number: modalData.wigNumber || '' };
        return [newRow, ...withoutReplaced];
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

  // Export to PDF (2026-09-16, Hera): "会将当前列表输出为 PDF 文档，方便 manager
  // 进行打印并实物检查" — lets Manager print the current-demos list and walk
  // the floor checking it against what's physically on display. Same pdfkit
  // approach as PO Receiving's already-proven Export PDF (see
  // server/routes/wigDemo.js's new GET /export-pdf route, modeled on
  // poInvoices.js's GET /:id/export-pdf), and the same fetch-blob-download
  // pattern already used on ManagerPOReceivingDetail.js's Export PDF button —
  // reused rather than building a new download mechanism from scratch.
  const handleExportPdf = async () => {
    setExportingPdf(true);
    setError('');
    try {
      const res = await fetch(`/api/wig-demo/export-pdf?location=${encodeURIComponent(location)}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wig-demo-${location}.pdf`;
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

  // Group into cards (2026-09-17, Hera) — `category`/`section` are computed
  // server-side (see categorizeRow() in server/routes/wigDemo.js) and come
  // back on every item from GET / and POST /refresh-wig-numbers, so this is
  // just a straight bucket-by-field pass, same shape as BuyerWigDemo.js's
  // byLocation grouping. `items` is already sorted by wig_number server-side
  // (sortByWigNumber()), and since these are plain filters/forEach passes
  // (not re-sorts), every bucket below keeps that same order.
  const byCategory = {};
  items.forEach(item => {
    const cat = item.category || 'UNKNOWN';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  });
  const soldeBySection = {};
  (byCategory.SOLDE || []).forEach(item => {
    const sec = item.section || 'UNKNOWN';
    if (!soldeBySection[sec]) soldeBySection[sec] = [];
    soldeBySection[sec].push(item);
  });
  const unknownItems = byCategory.UNKNOWN || [];

  return (
    <Page
      title="Wig DEMO"
      backAction={{ onAction: () => navigate('/manager') }}
      secondaryActions={[
        { content: 'Export PDF', onAction: handleExportPdf, loading: exportingPdf, disabled: exportingPdf },
        { content: 'How to Use', onAction: () => setShowHelp(true) },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <BlockStack gap="300">
                {/* Demo count in the heading (2026-09-17, Hera: "在 Current
                    demos 后面，加一个括号，然后显示当前 demo 的数量") — reads
                    straight off `items.length`, the same array the list
                    below renders from, so it's always in sync with what's
                    actually showing (no separate count to keep updated by
                    hand). Stays accurate through the loading state too:
                    while `loading` is true `items` is still whatever it was
                    from the last successful load (`[]` on first mount), so
                    the count doesn't show a stale non-zero number if it's
                    somehow read before the first fetch resolves. */}
                <Text variant="headingSm">Current demos ({items.length})</Text>

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
                    {/* Refresh Wig Number (Hera, 2026-09-17): right of
                        Search, becoming the rightmost button in this row —
                        Search shifts left within this same group. */}
                    <Button
                      onClick={handleRefreshWigNumbers}
                      loading={refreshingWigNumbers}
                      disabled={refreshingWigNumbers}
                    >
                      Refresh Wig Number
                    </Button>
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

              </BlockStack>
            </Card>

            {/* Cards (2026-09-17, Hera): one per product custom.sub_type,
                plus SOLDE for cleared-out stock — replaces the old flat list
                above. Same collapsed-by-default, click-to-expand shape as
                Buyer's per-location cards (BuyerWigDemo.js), rendered as
                siblings of the toolbar Card above rather than nested inside
                it, same as Buyer's layout. category/section come straight
                off each item from the server (see the byCategory/
                soldeBySection grouping above) — every card and SOLDE section
                is always shown, even with 0 demos in it, per Hera's spec. */}
            {loading ? (
              <Text alignment="center" tone="subdued">Loading...</Text>
            ) : items.length === 0 ? (
              <Card>
                <Text tone="subdued" alignment="center">No demos yet. Scan a barcode or search to add one.</Text>
              </Card>
            ) : (
              <>
                {CARD_ORDER.map(cat => {
                  if (cat !== 'SOLDE') {
                    const catItems = byCategory[cat] || [];
                    return (
                      <CategoryCard
                        key={cat}
                        title={cat}
                        count={catItems.length}
                        expanded={expandedCards.has(cat)}
                        onToggle={() => toggleCardExpanded(cat)}
                      >
                        <DemoList items={catItems} />
                      </CategoryCard>
                    );
                  }
                  // SOLDE — further divided into the same 5 sub-type
                  // sections, separated by a labeled divider (Hera: "分割线
                  // 居中写 title，title 后面跟着 demo 的数量"), each section
                  // shown even with 0 demos.
                  const soldeItems = byCategory.SOLDE || [];
                  return (
                    <CategoryCard
                      key="SOLDE"
                      title="SOLDE"
                      count={soldeItems.length}
                      expanded={expandedCards.has('SOLDE')}
                      onToggle={() => toggleCardExpanded('SOLDE')}
                    >
                      <BlockStack gap="200">
                        {SOLDE_SECTION_ORDER.map(section => (
                          <div key={section}>
                            <SectionDivider title={section} count={(soldeBySection[section] || []).length} />
                            <DemoList items={soldeBySection[section] || []} />
                          </div>
                        ))}
                      </BlockStack>
                    </CategoryCard>
                  );
                })}
                {/* "Sub type not found" (Hera, 2026-09-17): demos whose
                    product has no custom.sub_type value in Shopify at all —
                    not one of the 6 official cards above, so unlike those,
                    this only shows up when there's actually something in it. */}
                {unknownItems.length > 0 && (
                  <CategoryCard
                    title="Sub type not found — contact Buyer"
                    count={unknownItems.length}
                    expanded={expandedCards.has('UNKNOWN')}
                    onToggle={() => toggleCardExpanded('UNKNOWN')}
                    critical
                  >
                    <DemoList items={unknownItems} />
                  </CategoryCard>
                )}
              </>
            )}
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
