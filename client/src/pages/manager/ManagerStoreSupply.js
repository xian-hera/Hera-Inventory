import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Page, BlockStack, InlineStack, Text, Banner, Card } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { getManagerLocation } from '../../accountMemory';
import { api, deadlineText, shortDate, SUBDUED } from '../warehouse/supplyShared';

// Store › Tasks › Store Supply (2026-11-09, Hera — claude/STORE_SUPPLY_SPEC.md).
// Left: WH's items by group (collapsible), + adds one to Selected. Right:
// Request with − / + qty (Max enforced) and ×. The list is a draft saved on
// the server (one per store, shared by every device). Since 2026-11-10
// (Hera) there is no Submit Request button: the draft is submitted
// automatically when the deadline closes (services/storeSupply.rollCycle), so
// the store can keep adding until then. A request submitted earlier (before
// this change) is still shown read-only until the deadline closes.
// Look (2026-11-10, Hera): same as the other Hub pages — Polaris Card /
// Text / Button, 13 px text, thin card borders (not the mockup's sizes).

const GREEN = '#40d37f'; // + button (2026-11-10, Hera; was #008060)
const RED = '#d72c0d';

const subLine = (packSize, max, maxRed) => {
  const parts = [];
  if (packSize) parts.push(<span key="p">1 = {packSize}</span>);
  if (max != null) parts.push(<span key="m" style={maxRed ? { color: RED, fontWeight: 600 } : undefined}>Max {max}</span>);
  return parts.length ? parts.reduce((acc, p, i) => (i ? [...acc, <span key={`d${i}`}> · </span>, p] : [p]), []) : null;
};

const ROUND = {
  width: 26, height: 26, borderRadius: '50%', border: 'none', padding: 0, fontSize: 15, lineHeight: '26px',
  cursor: 'pointer', flex: '0 0 auto', touchAction: 'manipulation',
};

function Chevron({ open }) {
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, flex: '0 0 auto' }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={SUBDUED} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {open ? <path d="M3 9l4-4 4 4" /> : <path d="M3 5l4 4 4-4" />}
      </svg>
    </span>
  );
}

// Item card: like the Schedule's task cards — 1 px border, 13 px text.
const CARD = {
  position: 'relative', background: '#fff', border: '1px solid #c9cccf', borderRadius: 10, padding: '8px 10px',
  boxSizing: 'border-box', minHeight: 52, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
};

function SelectedCard({ line, onQty, onRemove }) {
  const atMax = line.max != null && line.qty >= line.max;
  const [txt, setTxt] = useState(String(line.qty));
  useEffect(() => { setTxt(String(line.qty)); }, [line.qty]);
  const commit = (raw) => {
    let n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1) n = 1;
    if (line.max != null && n > line.max) n = line.max;
    setTxt(String(n));
    if (n !== line.qty) onQty(n);
  };
  return (
    // name on top; pack size / Max bottom-left, qty bottom-right
    <div style={{ ...CARD, flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
      <button type="button" aria-label="Remove" onClick={onRemove}
        style={{ position: 'absolute', top: 2, right: 4, border: 'none', background: 'none', color: RED, fontSize: 16, fontWeight: 600, cursor: 'pointer', padding: 2, lineHeight: 1 }}>×</button>
      <div style={{ fontWeight: 600, wordBreak: 'break-word', paddingRight: 18 }}>{line.name}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <div style={{ fontSize: 12, color: SUBDUED, minWidth: 0 }}>{subLine(line.packSize, line.max, atMax || line.capped)}</div>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
        <button type="button" aria-label="Less" disabled={line.qty <= 1} onClick={() => onQty(line.qty - 1)}
          style={{ ...ROUND, background: line.qty <= 1 ? '#efefef' : '#e3e3e3', color: line.qty <= 1 ? '#c4c4c4' : '#303030' }}>−</button>
        <input value={txt} inputMode="numeric" aria-label={`${line.name} qty`}
          onChange={(e) => setTxt(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          style={{ width: 40, textAlign: 'center', font: 'inherit', fontSize: 13, fontWeight: 600, padding: '3px 2px', border: '1px solid #8a8a8a', borderRadius: 8 }} />
        <button type="button" aria-label="More" disabled={atMax} onClick={() => onQty(line.qty + 1)}
          style={{ ...ROUND, background: atMax ? '#efefef' : '#e3e3e3', color: atMax ? '#c4c4c4' : '#303030' }}>+</button>
      </span>
      </div>
    </div>
  );
}

function ManagerStoreSupply() {
  const navigate = useNavigate();
  const location = getManagerLocation() || '';
  const [view, setView] = useState(null);
  const [lines, setLines] = useState([]);        // draft: [{ itemId, name, packSize, max, qty, capped }]
  const [open, setOpen] = useState({});          // group id → expanded
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState(''); // '' | 'saving' | 'saved'
  const saveTimer = useRef(null);
  const pending = useRef(null);

  const apply = useCallback((d) => {
    setView(d);
    if (d.request && d.request.status === 'draft') setLines(d.request.lines);
    else if (!d.request || d.request.status === 'none') setLines([]);
    setOpen(prev => (Object.keys(prev).length || !d.groups || !d.groups.length ? prev : { [d.groups[0].id]: true }));
  }, []);

  const load = useCallback(async () => {
    if (!location) return;
    try { apply(await api('GET', `/store?location=${encodeURIComponent(location)}`)); } catch (e) { setError(e.message); }
  }, [location, apply]);
  useEffect(() => { load(); }, [load]);

  // Draft autosave (debounced); flushed when leaving the page.
  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const body = pending.current;
    if (!body) return;
    pending.current = null;
    setSaveState('saving');
    try { await api('PUT', '/store/draft', body); setSaveState('saved'); } catch (e) { setError(e.message); setSaveState(''); if (e.status === 409) load(); }
  }, [load]);
  useEffect(() => () => { if (pending.current) { const b = pending.current; pending.current = null; fetch('/api/store-supply/store/draft', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), keepalive: true }); } }, []);
  const change = (next) => {
    setLines(next);
    pending.current = { location, lines: next.map(l => ({ itemId: l.itemId, qty: l.qty })) };
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 600);
  };

  const back = () => { flush(); navigate('/manager?tab=tasks'); };

  if (!location) {
    return <Page title="Store Supply" backAction={{ onAction: back }}><Banner tone="warning">Please select a location on Manager Home first.</Banner></Page>;
  }
  if (!view) {
    return <Page title="Store Supply" backAction={{ onAction: back }}>{error ? <Banner tone="critical">{error}</Banner> : <InlineStack align="center"><Text tone="subdued">Loading...</Text></InlineStack>}</Page>;
  }

  const last = view.lastSubmission;
  const submitted = view.request && (view.request.status === 'submitted' || view.request.status === 'approved');
  const added = new Set(lines.map(l => l.itemId));

  return (
    <Page title="Store Supply" backAction={{ onAction: back }}>
      <style>{`
        .ss-cols { display: grid; grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr); column-gap: 20px; align-items: start; }
        .ss-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        @media (max-width: 767px) {
          .ss-cols { grid-template-columns: minmax(0, 1fr); row-gap: 20px; }
          .ss-divider { display: none; }
          .ss-grid { grid-template-columns: minmax(0, 1fr); }
        }
      `}</style>
      <BlockStack gap="400">
        {/* Deadline bar — a Polaris Card (2026-11-10, was a big grey box) */}
        <Card>
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#2c6ecb" strokeWidth="1.6" aria-hidden="true">
                <rect x="3" y="4.5" width="14" height="12.5" rx="2" /><path d="M3 8.5h14M7 2.5v4M13 2.5v4" />
              </svg>
              <Text as="span">Current Deadline</Text>
              <Text as="span" fontWeight="semibold">{view.setUp ? deadlineText(view.deadline) : '—'}</Text>
            </InlineStack>
            <Text as="p" tone="subdued">
              Last Submission {last ? shortDate(last.at) : '—'}{last && last.auto ? ', automatically submitted due to cycle close.' : ''}
            </Text>
          </BlockStack>
        </Card>

        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

        {!view.setUp ? (
          <Text tone="subdued">Store Supply is not open yet.</Text>
        ) : submitted ? (
          <BlockStack gap="300">
            <Banner tone="success">You have already submitted a request for this cycle. You can make a new one after the deadline.</Banner>
            <div className="ss-grid">
              {view.request.lines.map(l => (
                <div key={`${l.itemId}-${l.name}`} style={CARD}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{l.name}</div>
                    <div style={{ fontSize: 12, color: SUBDUED }}>{l.packSize ? `1 = ${l.packSize}` : ''}</div>
                  </div>
                  <span style={{ fontWeight: 600 }}>{l.qty}</span>
                </div>
              ))}
            </div>
          </BlockStack>
        ) : (
          <div className="ss-cols">
            {/* Items */}
            <BlockStack gap="400">
              {view.groups.length === 0 && <Text tone="subdued">No supplies to choose yet.</Text>}
              {view.groups.map(g => {
                const isOpen = !!open[g.id];
                return (
                  <BlockStack key={g.id} gap="200">
                    <button type="button" onClick={() => setOpen(o => ({ ...o, [g.id]: !o[g.id] }))}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: 'none', borderBottom: '1px solid #e3e3e3', background: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: '#303030' }}>
                      <Text variant="headingMd" as="span">{g.name}</Text>
                      <Chevron open={isOpen} />
                    </button>
                    {isOpen && (
                      g.items.length === 0 ? <Text tone="subdued">No items.</Text> : (
                        <div className="ss-grid">
                          {g.items.map(it => {
                            const isAdded = added.has(it.id);
                            // Out of Stock (2026-11-10, Hera): greyed like an added
                            // item, "Out of Stock" instead of the pack size, can't
                            // be requested; the server lists them last.
                            const out = it.status === 'out_of_stock';
                            const grey = isAdded || out;
                            return (
                              <div key={it.id} style={{ ...CARD, ...(grey ? { background: 'transparent', borderColor: '#e3e3e3' } : {}) }}>
                                <div style={{ flex: 1, minWidth: 0, color: grey ? '#8a8a8a' : '#303030' }}>
                                  <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{it.name}</div>
                                  <div style={{ fontSize: 12, color: grey ? '#b5b5b5' : SUBDUED }}>{out ? 'Out of Stock' : subLine(it.packSize, it.max)}</div>
                                </div>
                                {out ? null : isAdded ? (
                                  <span style={{ color: '#8a8a8a', fontSize: 12 }}>Added</span>
                                ) : (
                                  <button type="button" aria-label={`Add ${it.name}`}
                                    onClick={() => change([...lines, { itemId: it.id, name: it.name, packSize: it.packSize, max: it.max, qty: 1 }])}
                                    // an SVG plus, centred exactly in the circle (the text "+" sat low)
                                    style={{ ...ROUND, width: 28, height: 28, background: GREEN, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" /></svg>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )
                    )}
                  </BlockStack>
                );
              })}
            </BlockStack>

            <div className="ss-divider" style={{ background: '#e3e3e3', alignSelf: 'stretch', minHeight: 200 }} />

            {/* Selected */}
            <BlockStack gap="200">
              {/* "Selected" → "Request", no Submit Request button (2026-11-10, Hera) */}
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingMd" as="span">Request</Text>
                  {saveState && <span style={{ fontSize: 12, color: SUBDUED }}>{saveState === 'saving' ? 'Saving...' : 'Saved'}</span>}
                </InlineStack>
                <Text as="p" tone="subdued">Full request will be submitted automatically at the deadline. If you have urgent need, contact warehouse directly.</Text>
              </BlockStack>
              {lines.length === 0 ? (
                <Text tone="subdued">Nothing selected yet. Tap + on an item to add it.</Text>
              ) : (
                <div className="ss-grid">
                  {lines.map((l, i) => (
                    <SelectedCard key={l.itemId} line={l}
                      onQty={(n) => change(lines.map((x, j) => (j === i ? { ...x, qty: n, capped: false } : x)))}
                      onRemove={() => change(lines.filter((_, j) => j !== i))} />
                  ))}
                </div>
              )}
            </BlockStack>
          </div>
        )}
      </BlockStack>

      <div className="mobile-bottom-safe-area" aria-hidden="true" />
    </Page>
  );
}

export default ManagerStoreSupply;
