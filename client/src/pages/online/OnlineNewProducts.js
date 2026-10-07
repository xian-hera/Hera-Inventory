// Online → New products (2026-09-24, Hera). Products Buyer created with
// Import Products → Add new (POS only excluded), grouped by the Settings
// groups (+ a hidden built-in "Ungrouped" group). Spec §15.
// Full width; the table wraps text instead of scrolling sideways.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Page, Card, BlockStack, InlineStack, Text, Button, Banner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { HtmlTooltip, FrIcon, adminUrl, TH, TD, postJson } from './newProductsShared';

const DESC_CHARS = 100; // was 60; Description column is now 100 characters wide (2026-10-05)

// ─── Fixed column widths (2026-10-05, Hera) ─────────────────────────────────
// Every card uses the same widths so the columns line up from card to card.
// ~7px per character at 13px. Inventory / Media / Weight = header + 3
// characters of padding on each side. A group's own metafield columns share
// one "special" block at the end (empty block for groups without any).
const PAD3 = 21; // 3 characters
const COL = {
  check: 36,
  title: 350,       // 50 characters
  inventory: 105,   // "Inventory" + 2 × 3 characters
  media: 80,        // "Media" + 2 × 3 characters
  description: 700, // 100 characters
  weight: 87,       // "Weight" + 2 × 3 characters
  tags: 140,        // 20 characters
  special: 350,     // 50 characters, split between the group's own columns
};
const TABLE_W = Object.values(COL).reduce((a, b) => a + b, 0);
const ONE_LINE = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

// One-line text cut off with "…"; hovering shows the full text, but only
// when it was actually cut off.
function Trunc({ text, children }) {
  const ref = useRef(null);
  const [rect, setRect] = useState(null);
  const open = () => {
    const el = ref.current;
    if (el && el.scrollWidth > el.clientWidth + 1) setRect(el.getBoundingClientRect());
  };
  const W = 420;
  const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - W - 8)) : 0;
  return (
    <div ref={ref} style={ONE_LINE} onMouseEnter={open} onMouseLeave={() => setRect(null)}>
      {children || text}
      {rect && text && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', left, top: rect.bottom + 6, maxWidth: W, zIndex: 100000,
          background: '#fff', border: '1px solid #c9cccf', borderRadius: 8, padding: '8px 10px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.18)', fontSize: 13, lineHeight: 1.45, pointerEvents: 'none',
          whiteSpace: 'normal', wordBreak: 'break-word',
        }}>{text}</div>,
        document.body
      )}
    </div>
  );
}

// Inventory column (2026-10-05, Hera): same figure as Finalized — Available
// at the Settings → Inventory locations, filled by "Check Inventory".
// Rows with stock come first, rows never checked next, 0 at the bottom;
// the original order (newest first) is kept inside each of those groups.
const invRank = (i) => (i.available == null ? 1 : i.available > 0 ? 0 : 2);
function sortByInventory(items) {
  return items
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => invRank(a.it) - invRank(b.it) || a.idx - b.idx)
    .map(x => x.it);
}

function GroupCard({ group, onChanged, setBanner }) {
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState('');
  const items = sortByInventory(group.items);
  const mfs = group.metafields || [];
  const allSelected = items.length > 0 && items.every(i => selected.includes(i.id));

  const act = async (kind) => {
    const ids = kind === 'refresh' ? items.map(i => i.id) : selected;
    if (!ids.length) return;
    if (kind === 'delete' && !window.confirm(`Remove ${ids.length} item(s) from this list? (The products stay in Shopify.)`)) return;
    setBusy(kind);
    try {
      if (kind === 'refresh') {
        const r = await postJson('/api/new-products/refresh', { ids });
        if (r.errors && r.errors.length) setBanner({ tone: 'warning', text: `Refreshed ${r.refreshed}. Failed: ${r.errors.map(e => `${e.title} (${e.error})`).join('; ')}` });
        else setBanner({ tone: 'success', text: `Refreshed ${r.refreshed} item(s).` });
      } else if (kind === 'delete') {
        await postJson('/api/new-products/delete', { ids });
      } else if (kind === 'finalize') {
        await postJson('/api/new-products/finalize', { ids });
      }
      setSelected([]);
      await onChanged();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setBusy('');
    }
  };

  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <Text variant="headingMd" as="h2">{group.name}</Text>
        <InlineStack gap="200">
          <Button onClick={() => act('refresh')} loading={busy === 'refresh'} disabled={!items.length || !!busy}>Refresh</Button>
          <Button tone="critical" variant="primary" onClick={() => act('delete')} loading={busy === 'delete'} disabled={!selected.length || !!busy}>Delete selected</Button>
          <Button variant="primary" onClick={() => act('finalize')} loading={busy === 'finalize'} disabled={!selected.length || !!busy}>Mark selected as finalized</Button>
        </InlineStack>
      </InlineStack>
      {/* Fixed-width list (2026-10-05, Hera): wider than the page column and
          centred on it; the same width for every card so columns line up.
          On a screen narrower than the table it scrolls sideways inside the
          card (the page itself hides sideways overflow). */}
      <div style={{ position: 'relative', left: '50%', transform: 'translateX(-50%)', width: `min(${TABLE_W + 2}px, calc(100vw - 32px))` }}>
      <Card padding="0">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: TABLE_W, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: COL.check }} />
              <col style={{ width: COL.title }} />
              <col style={{ width: COL.inventory }} />
              <col style={{ width: COL.media }} />
              <col style={{ width: COL.description }} />
              <col style={{ width: COL.weight }} />
              <col style={{ width: COL.tags }} />
              {mfs.length
                ? mfs.map(m => <col key={`${m.level}.${m.namespace}.${m.key}`} style={{ width: COL.special / mfs.length }} />)
                : <col style={{ width: COL.special }} />}
            </colgroup>
            <thead>
              <tr>
                <th style={{ ...TH, paddingLeft: 12 }}>
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? [] : items.map(i => i.id))} />
                </th>
                <th style={TH}>Title</th>
                <th style={{ ...TH, padding: `10px ${PAD3}px` }}>Inventory</th>
                <th style={{ ...TH, padding: `10px ${PAD3}px` }}>Media</th>
                <th style={TH}>Description</th>
                <th style={{ ...TH, padding: `10px ${PAD3}px` }}>Weight</th>
                <th style={TH}>Tags</th>
                {mfs.length
                  ? mfs.map(m => <th key={`${m.level}.${m.namespace}.${m.key}`} style={TH}><Trunc text={m.name} /></th>)
                  : <th style={TH} />}
              </tr>
            </thead>
            <tbody>
              {items.map(i => {
                const tags = (i.tags || []).join(', ');
                return (
                  <tr key={i.id}>
                    <td style={{ ...TD, paddingLeft: 12 }}>
                      <input type="checkbox" checked={selected.includes(i.id)} onChange={() => setSelected(s => (s.includes(i.id) ? s.filter(x => x !== i.id) : [...s, i.id]))} />
                    </td>
                    <td style={TD}>
                      <Trunc text={i.title}>
                        {i.titleFr && <HtmlTooltip text={i.titleFr}><FrIcon /></HtmlTooltip>}
                        <a href={adminUrl(i.shopifyProductId)} target="_blank" rel="noopener noreferrer">{i.title}</a>
                      </Trunc>
                      {/* New variants of an existing product (2026-10-07): only these
                          SKUs are new; Inventory counts only them. */}
                      {i.variantIds && i.variantIds.length > 0 && (
                        <div style={{ color: '#6d7175', fontSize: 12, marginTop: 2, ...ONE_LINE }} title={(i.skus || []).join(', ')}>
                          New SKU{i.variantIds.length > 1 ? 's' : ''}: {(i.skus || []).join(', ') || i.variantIds.length}
                        </div>
                      )}
                      {i.refreshError && <div style={{ color: '#d72c0d', fontSize: 12, marginTop: 2 }}>{i.refreshError}</div>}
                    </td>
                    <td style={{ ...TD, padding: `10px ${PAD3}px` }}>{i.available == null ? '—' : i.available}</td>
                    <td style={{ ...TD, padding: `10px ${PAD3}px` }}>{i.mediaCount == null ? '' : i.mediaCount}</td>
                    <td style={TD}>
                      <div style={ONE_LINE}>
                        {i.descriptionFrText && <HtmlTooltip html={i.descriptionFrHtml} text={i.descriptionFrText}><FrIcon /></HtmlTooltip>}
                        {i.descriptionText
                          ? <HtmlTooltip html={i.descriptionHtml} text={i.descriptionText}>
                              <span>{i.descriptionText.slice(0, DESC_CHARS)}{i.descriptionText.length > DESC_CHARS ? '…' : ''}</span>
                            </HtmlTooltip>
                          : ''}
                      </div>
                    </td>
                    <td style={{ ...TD, padding: `10px ${PAD3}px`, whiteSpace: 'nowrap' }}>{i.weight}</td>
                    <td style={TD}><Trunc text={tags} /></td>
                    {mfs.length
                      ? mfs.map(m => <td key={`${m.level}.${m.namespace}.${m.key}`} style={TD}><Trunc text={(i.metafields || {})[`${m.level}.${m.namespace}.${m.key}`] || ''} /></td>)
                      : <td style={TD} />}
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr><td colSpan={7 + Math.max(1, mfs.length)} style={{ ...TD, textAlign: 'center', color: '#6d7175', padding: 20 }}>No products.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      </div>
    </BlockStack>
  );
}

// inTabs (2026-10-01): shown as a tab of Online (OnlineHome) — no title or
// back arrow of its own; the tab bar above already says where you are.
function OnlineNewProducts({ inTabs = false } = {}) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState(null);
  const [checkingInv, setCheckingInv] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/new-products');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Load failed');
      setData(d);
      // Updates the red count badge on the New Products tab.
      window.dispatchEvent(new Event('online-badges-refresh'));
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Check Inventory (2026-10-05, Hera): the same as Refresh on the Finalized
  // page (refresh with inventory), for every product on this page.
  const checkInventory = async () => {
    if (!data || checkingInv) return;
    const ids = [...data.groups.flatMap(g => g.items), ...data.ungrouped].map(i => i.id);
    if (!ids.length) return;
    setCheckingInv(true);
    setBanner(null);
    try {
      const r = await postJson('/api/new-products/refresh', { ids, withInventory: true });
      setBanner(r.errors && r.errors.length
        ? { tone: 'warning', text: `Checked ${r.refreshed}. Failed: ${r.errors.map(e => `${e.title} (${e.error})`).join('; ')}` }
        : { tone: 'success', text: `Inventory checked for ${r.refreshed} item(s).` });
      await load();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setCheckingInv(false);
    }
  };

  return (
    // Fixed-width page; each group's table was full width (FullBleed) —
    // Hera 2026-09-24. Since 2026-10-05 the tables share one fixed width
    // (wider than the page, centred) instead — see TABLE_W.
    <Page
      title={inTabs ? undefined : 'New products'}
      backAction={inTabs ? undefined : { onAction: () => navigate('/online') }}
      secondaryActions={[
        { content: 'Settings', onAction: () => navigate('/online/new-products/settings') },
        { content: 'Finalized', onAction: () => navigate('/online/new-products/finalized') },
        { content: 'Check Inventory', onAction: checkInventory, loading: checkingInv, disabled: !data || checkingInv },
      ]}
    >
      <BlockStack gap="500">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {banner && <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>}
        {!data && !error && <InlineStack align="center"><Text tone="subdued">Loading...</Text></InlineStack>}
        {data && data.groups.map(g => <GroupCard key={g.id} group={g} onChanged={load} setBanner={setBanner} />)}
        {data && data.ungrouped.length > 0 && (
          <GroupCard group={{ id: 'ungrouped', name: 'Ungrouped', metafields: [], items: data.ungrouped }} onChanged={load} setBanner={setBanner} />
        )}
        {data && !data.groups.length && !data.ungrouped.length && (
          <Card><Text tone="subdued" alignment="center">No new products.</Text></Card>
        )}
      </BlockStack>
    </Page>
  );
}

export default OnlineNewProducts;
