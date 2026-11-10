import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Page, BlockStack, InlineStack, Text, Banner, Spinner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { getManagerLocation } from '../../accountMemory';
import { api, deadlineText, shortDate, ConfirmBox } from '../warehouse/supplyShared';

// Store › Tasks › Store Supply (2026-11-09, Hera — claude/STORE_SUPPLY_SPEC.md).
// Left: WH's items by group (collapsible), + adds one to Selected. Right:
// Selected with − / + qty (Max enforced) and ×. The list is a draft saved on
// the server (one per store, shared by every device) until Submit Request.
// After submitting, the page shows what was sent until the deadline closes;
// a draft still open when the deadline closes is submitted automatically.

const GREEN = '#008060';
const RED = '#d72c0d';

const subLine = (packSize, max, maxRed) => {
  const parts = [];
  if (packSize) parts.push(<span key="p">1 = {packSize}</span>);
  if (max != null) parts.push(<span key="m" style={maxRed ? { color: RED, fontWeight: 700 } : undefined}>Max {max}</span>);
  return parts.length ? parts.reduce((acc, p, i) => (i ? [...acc, <span key={`d${i}`}> · </span>, p] : [p]), []) : null;
};

const ROUND = {
  width: 28, height: 28, borderRadius: '50%', border: 'none', padding: 0, fontSize: 17, lineHeight: '28px',
  cursor: 'pointer', flex: '0 0 auto', touchAction: 'manipulation',
};

function Chevron({ open }) {
  return (
    <span aria-hidden="true" style={{ ...ROUND, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#b5b5b5', cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#303030" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {open ? <path d="M3 9l4-4 4 4" /> : <path d="M3 5l4 4 4-4" />}
      </svg>
    </span>
  );
}

const CARD = {
  position: 'relative', background: '#fff', border: '2px solid #c9cccf', borderRadius: 14, padding: '10px 12px',
  boxSizing: 'border-box', minHeight: 66, display: 'flex', alignItems: 'center', gap: 10,
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
    <div style={{ ...CARD, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      <button type="button" aria-label="Remove" onClick={onRemove}
        style={{ position: 'absolute', top: 2, right: 6, border: 'none', background: 'none', color: RED, fontSize: 17, fontWeight: 700, cursor: 'pointer', padding: 2, lineHeight: 1 }}>×</button>
      <div style={{ fontWeight: 700, fontSize: 15, wordBreak: 'break-word', paddingRight: 18 }}>{line.name}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <div style={{ fontSize: 12, color: '#8a8a8a', minWidth: 0 }}>{subLine(line.packSize, line.max, atMax || line.capped)}</div>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
        <button type="button" aria-label="Less" disabled={line.qty <= 1} onClick={() => onQty(line.qty - 1)}
          style={{ ...ROUND, background: line.qty <= 1 ? '#efefef' : '#e3e3e3', color: line.qty <= 1 ? '#c4c4c4' : '#303030' }}>−</button>
        <input value={txt} inputMode="numeric" aria-label={`${line.name} qty`}
          onChange={(e) => setTxt(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          style={{ width: 44, textAlign: 'center', font: 'inherit', fontSize: 17, fontWeight: 700, padding: '4px 2px', border: '2px solid #c9cccf', borderRadius: 8 }} />
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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

  const submit = async () => {
    setSubmitting(true);
    setError('');
    clearTimeout(saveTimer.current);
    pending.current = null;
    try {
      apply(await api('POST', '/store/submit', { location, lines: lines.map(l => ({ itemId: l.itemId, qty: l.qty })) }));
      setConfirmOpen(false);
    } catch (e) { setError(e.message); setConfirmOpen(false); if (e.status === 409) load(); }
    finally { setSubmitting(false); }
  };

  const back = () => { flush(); navigate('/manager?tab=tasks'); };

  if (!location) {
    return <Page title="Store Supply" backAction={{ onAction: back }}><Banner tone="warning">Please select a location on Manager Home first.</Banner></Page>;
  }
  if (!view) {
    return <Page title="Store Supply" backAction={{ onAction: back }}>{error ? <Banner tone="critical">{error}</Banner> : <InlineStack align="center"><Spinner /></InlineStack>}</Page>;
  }

  const last = view.lastSubmission;
  const submitted = view.request && (view.request.status === 'submitted' || view.request.status === 'approved');
  const added = new Set(lines.map(l => l.itemId));

  return (
    <Page title="Store Supply" backAction={{ onAction: back }}>
      <style>{`
        .ss-cols { display: grid; grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr); column-gap: 28px; align-items: start; }
        .ss-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        @media (max-width: 767px) {
          .ss-cols { grid-template-columns: minmax(0, 1fr); row-gap: 24px; }
          .ss-divider { display: none; }
          .ss-grid { grid-template-columns: minmax(0, 1fr); }
        }
      `}</style>
      <BlockStack gap="500">
        {/* Deadline bar */}
        <div style={{ background: '#e3e3e3', borderRadius: 10, padding: '12px 16px' }}>
          <InlineStack gap="200" blockAlign="center">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#2c6ecb" strokeWidth="1.6" aria-hidden="true">
              <rect x="3" y="4.5" width="14" height="12.5" rx="2" /><path d="M3 8.5h14M7 2.5v4M13 2.5v4" />
            </svg>
            <span style={{ fontSize: 13 }}>Current Deadline</span>
            <span style={{ fontWeight: 700 }}>{view.setUp ? deadlineText(view.deadline) : '—'}</span>
          </InlineStack>
          <div style={{ fontSize: 13, marginTop: 6 }}>
            Last Submission {last ? shortDate(last.at) : '—'}{last && last.auto ? ', automatically submitted due to cycle close.' : ''}
          </div>
        </div>

        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

        {!view.setUp ? (
          <Text tone="subdued">Store Supply is not open yet.</Text>
        ) : submitted ? (
          <BlockStack gap="300">
            <Banner tone="success">You have already submitted a request for this cycle. You can make a new one after the deadline.</Banner>
            <div className="ss-grid">
              {view.request.lines.map(l => (
                <div key={`${l.itemId}-${l.name}`} style={{ ...CARD, minHeight: 56 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{l.name}</div>
                    <div style={{ fontSize: 12, color: '#8a8a8a' }}>{l.packSize ? `1 = ${l.packSize}` : ''}</div>
                  </div>
                  <span style={{ fontSize: 17, fontWeight: 700 }}>{l.qty}</span>
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
                  <BlockStack key={g.id} gap="300">
                    <button type="button" onClick={() => setOpen(o => ({ ...o, [g.id]: !o[g.id] }))}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: 'none', background: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
                      <span style={{ fontSize: 18, fontWeight: 600 }}>{g.name}</span>
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
                              <div key={it.id} style={{ ...CARD, ...(grey ? { background: 'transparent', borderColor: '#e1e3e5' } : {}) }}>
                                <div style={{ flex: 1, minWidth: 0, color: grey ? '#8a8a8a' : '#303030' }}>
                                  <div style={{ fontWeight: 700, fontSize: 15, wordBreak: 'break-word' }}>{it.name}</div>
                                  <div style={{ fontSize: 12, color: grey ? '#b5b5b5' : '#8a8a8a' }}>{out ? 'Out of Stock' : subLine(it.packSize, it.max)}</div>
                                </div>
                                {out ? null : isAdded ? (
                                  <span style={{ color: '#8a8a8a', fontSize: 14 }}>Added</span>
                                ) : (
                                  <button type="button" aria-label={`Add ${it.name}`}
                                    onClick={() => change([...lines, { itemId: it.id, name: it.name, packSize: it.packSize, max: it.max, qty: 1 }])}
                                    style={{ ...ROUND, width: 34, height: 34, background: GREEN, color: '#fff', fontSize: 24, lineHeight: '34px', fontWeight: 700 }}>+</button>
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

            <div className="ss-divider" style={{ background: '#8a8a8a', alignSelf: 'stretch', minHeight: 200 }} />

            {/* Selected */}
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <span style={{ fontSize: 18, fontWeight: 600 }}>Selected</span>
                  {saveState && <span style={{ fontSize: 12, color: '#8a8a8a' }}>{saveState === 'saving' ? 'Saving...' : 'Saved'}</span>}
                </InlineStack>
                <button type="button" disabled={lines.length === 0} onClick={() => setConfirmOpen(true)}
                  style={{
                    border: 'none', borderRadius: 10, padding: '9px 14px', fontSize: 14, fontWeight: 650, cursor: lines.length ? 'pointer' : 'default',
                    background: lines.length ? '#303030' : '#d4d4d4', color: lines.length ? '#fff' : '#8a8a8a',
                  }}>Submit Request</button>
              </InlineStack>
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

      <ConfirmBox open={confirmOpen} title="Submit Request?" busy={submitting}
        onConfirm={submit} onCancel={() => setConfirmOpen(false)}>
        Please check that every item and quantity is correct. Once submitted, the request can’t be changed.
      </ConfirmBox>
      <div className="mobile-bottom-safe-area" aria-hidden="true" />
    </Page>
  );
}

export default ManagerStoreSupply;
