import React, { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Card, BlockStack, InlineStack, Text, Button, Select, Banner, Spinner, Checkbox } from '@shopify/polaris';

// Store › Label Print › "Search by Filters" (2026-10-28, Hera).
// A collapsed text button under the Scan / search card; open → a card with
// five filters (Type, Vendor, Supplier, Display Section, Discontinued; each
// "Any" by default, one value each) and Search. Results (all filters
// together, from the server's local variant index — active products only)
// are listed under a divider: SKU, Name, plus one column per filter that is
// set. At most 100 rows (a notice asks to narrow the search when there are
// more). Add All / Add Selected put them on the print list; SKUs already on
// it are skipped.
//   Type     — the enabled product types (Purchasing › Settings › Product Types)
//   Vendor   — vendors of active products; type to narrow the list
//   Supplier — Purchasing › Purchase Orders › Supplier management; matched
//              against custom.supplier_a_name
//   Display Section — the custom.display_section choices
//   Discontinued    — custom.discontinued: True / False / Empty
// API: GET /api/label-print-tasks/filter-options, POST …/filter-search.

const ANY = '';

const Chevron = ({ up }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ display: 'block' }}>
    <path d={up ? 'M6 12l4-4 4 4' : 'M6 8l4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// A dropdown you can type into: the list shows the options containing the
// typed text (any case, anywhere in the value); "Any" is always first.
function TypeAheadPicker({ label, options, value, onChange }) {
  const [text, setText] = useState(value || 'Any');
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  // The list is drawn in a portal on <body> (2026-10-28 fix): inside the
  // Polaris Card it was cut off by the card's edge. Placed under the input
  // (above it when there is no room below) and kept in place on scroll /
  // resize while open.
  const [pos, setPos] = useState(null); // { left, top | bottom, width }
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = inputRef.current && inputRef.current.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      setPos(below < 200 && r.top > below
        ? { left: r.left, bottom: window.innerHeight - r.top + 4, width: r.width }
        : { left: r.left, top: r.bottom + 4, width: r.width });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);
  useEffect(() => { if (!open) setText(value || 'Any'); }, [value, open]);
  const list = useMemo(() => {
    const q = typed ? text.trim().toLowerCase() : '';
    return q ? options.filter(o => o.toLowerCase().includes(q)) : options;
  }, [options, text, typed]);
  const pick = (v) => { onChange(v); setOpen(false); setTyped(false); };
  return (
    <div ref={boxRef} style={{ position: 'relative', width: 150 }}>
      <div style={{ marginBottom: 4 }}><Text as="span" variant="bodyMd">{label}</Text></div>
      <input
        ref={inputRef}
        type="text"
        value={text}
        onFocus={(e) => { setOpen(true); setTyped(false); e.target.select(); }}
        onBlur={() => setTimeout(() => { setOpen(false); setTyped(false); }, 150)}
        onChange={(e) => { setText(e.target.value); setTyped(true); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (typed && list.length) pick(list[0]); else if (!typed) setOpen(false); }
          if (e.key === 'Escape') { setOpen(false); e.target.blur(); }
        }}
        aria-label={label}
        autoComplete="off"
        style={{
          width: '100%', boxSizing: 'border-box', height: 32, padding: '0 10px', fontSize: 13, font: 'inherit',
          border: '1px solid #8a8a8a', borderRadius: 8, outline: 'none', background: '#fff',
        }}
      />
      {open && pos && createPortal(
        <div style={{
          position: 'fixed', zIndex: 99999, left: pos.left, top: pos.top, bottom: pos.bottom, width: Math.max(pos.width, 200),
          maxHeight: 260, overflowY: 'auto', boxSizing: 'border-box',
          background: '#fff', border: '1px solid #c9cccf', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        }}>
          {!typed && (
            <div onMouseDown={(e) => { e.preventDefault(); pick(ANY); }}
              style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 13, background: !value ? '#f1f8f5' : '#fff' }}>Any</div>
          )}
          {list.map(o => (
            <div key={o} onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 13, background: o === value ? '#f1f8f5' : '#fff', wordBreak: 'break-word' }}>
              {o}
            </div>
          ))}
          {typed && list.length === 0 && <div style={{ padding: '8px 10px', fontSize: 13, color: '#6d7175' }}>No results</div>}
        </div>,
        document.body
      )}
    </div>
  );
}

export default function LabelPrintFilterSearch({ isOnList, onAdd }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState(null); // { types, vendors, suppliers, displaySections }
  const [optsError, setOptsError] = useState('');
  const [f, setF] = useState({ type: ANY, vendor: ANY, supplier: ANY, displaySection: ANY, discontinued: ANY });
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState(null); // { total, limit, results, filters }
  const [error, setError] = useState('');
  const [checked, setChecked] = useState([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open || opts) return;
    Promise.all([
      fetch('/api/shopify/product-types').then(r => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/label-print-tasks/filter-options').then(r => r.json().then(d => { if (!r.ok) throw new Error(d.error || 'Failed to load the filters'); return d; })),
    ]).then(([types, o]) => setOpts({ types: Array.isArray(types) ? types : [], ...o }))
      .catch(e => setOptsError(e.message));
  }, [open, opts]);

  const anySet = Object.values(f).some(v => v !== ANY);
  const set = (k) => (v) => setF(prev => ({ ...prev, [k]: v }));

  const search = async () => {
    setSearching(true); setError(''); setChecked([]);
    try {
      const r = await fetch('/api/label-print-tasks/filter-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Search failed');
      setResult({ ...d, filters: { ...f } });
    } catch (e) { setError(e.message); setResult(null); }
    finally { setSearching(false); }
  };

  const rows = result ? result.results : [];
  const addable = rows.filter(r => !isOnList(r.sku));
  const allOn = addable.length > 0 && addable.every(r => checked.includes(r.variantId));
  const add = async (list) => {
    if (!list.length) return;
    setAdding(true); setError('');
    try { await onAdd(list.filter(r => !isOnList(r.sku))); setChecked([]); }
    catch (e) { setError(e.message); }
    finally { setAdding(false); }
  };

  // One column per filter that was set when searching.
  const extraCols = result ? [
    result.filters.type && { key: 'type', label: 'Type' },
    result.filters.vendor && { key: 'vendor', label: 'Vendor' },
    result.filters.supplier && { key: 'supplier', label: 'Supplier' },
    result.filters.displaySection && { key: 'displaySection', label: 'Display Section' },
    result.filters.discontinued && { key: 'discontinued', label: 'Discontinued' },
  ].filter(Boolean) : [];
  const TH = { padding: '8px 10px', textAlign: 'left', fontWeight: 500, color: '#616161', borderBottom: '1px solid #e3e3e3', whiteSpace: 'nowrap' };
  const TD = { padding: '10px', borderBottom: '1px solid #f1f1f1', verticalAlign: 'middle' };

  return (
    <BlockStack gap="300">
      <div>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'none', padding: '4px 0',
            cursor: 'pointer', font: 'inherit', fontWeight: 650, color: '#303030',
          }}
        >
          Search by Filters
          <span style={{ display: 'inline-flex', borderRadius: '50%', background: '#e3e3e3', color: '#303030' }}><Chevron up={open} /></span>
        </button>
      </div>
      {open && (
        <Card>
          <BlockStack gap="300">
            {optsError && <Banner tone="critical">{optsError}</Banner>}
            {!opts && !optsError ? <InlineStack align="center"><Spinner size="small" /></InlineStack> : opts && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
                <div style={{ width: 150 }}>
                  <Select label="Type" options={[{ label: 'Any', value: ANY }, ...opts.types.map(t => ({ label: t, value: t }))]} value={f.type} onChange={set('type')} />
                </div>
                <TypeAheadPicker label="Vendor" options={opts.vendors || []} value={f.vendor} onChange={set('vendor')} />
                <TypeAheadPicker label="Supplier" options={opts.suppliers || []} value={f.supplier} onChange={set('supplier')} />
                <TypeAheadPicker label="Display Section" options={opts.displaySections || []} value={f.displaySection} onChange={set('displaySection')} />
                <div style={{ width: 130 }}>
                  <Select
                    label="Discontinued"
                    options={[{ label: 'Any', value: ANY }, { label: 'True', value: 'true' }, { label: 'False', value: 'false' }, { label: 'Empty', value: 'empty' }]}
                    value={f.discontinued} onChange={set('discontinued')}
                  />
                </div>
                <div style={{ marginLeft: 'auto' }}>
                  <Button variant="primary" onClick={search} loading={searching} disabled={!anySet}>Search</Button>
                </div>
              </div>
            )}
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {result && (
              <div style={{ borderTop: '1px solid #e3e3e3', paddingTop: 12 }}>
                <BlockStack gap="300">
                  {result.total > result.limit && (
                    <Banner tone="warning">
                      Too many results ({result.total}). Only the first {result.limit} are listed — please narrow the search.
                    </Banner>
                  )}
                  {rows.length === 0 ? (
                    <Text tone="subdued" alignment="center">No products found.</Text>
                  ) : (
                    <>
                      <InlineStack align="space-between" blockAlign="center" gap="200">
                        <Text tone="subdued">{result.total > result.limit ? `${rows.length} of ${result.total}` : `${rows.length} found`}</Text>
                        <InlineStack gap="200">
                          <Button onClick={() => add(addable)} disabled={adding || addable.length === 0} loading={adding}>Add All</Button>
                          <Button onClick={() => add(rows.filter(r => checked.includes(r.variantId)))} disabled={adding || checked.length === 0}>
                            {checked.length ? `Add Selected (${checked.length})` : 'Add Selected'}
                          </Button>
                        </InlineStack>
                      </InlineStack>
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr>
                              <th style={{ ...TH, width: 32 }}>
                                <Checkbox label="Select all" labelHidden checked={allOn} disabled={addable.length === 0}
                                  onChange={() => setChecked(allOn ? [] : addable.map(r => r.variantId))} />
                              </th>
                              <th style={TH}>SKU</th>
                              <th style={TH}>Name</th>
                              {extraCols.map(c => <th key={c.key} style={TH}>{c.label}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(r => {
                              const onList = isOnList(r.sku);
                              const on = checked.includes(r.variantId);
                              return (
                                <tr key={r.variantId}>
                                  <td style={TD}>
                                    {onList ? <span style={{ color: '#008060', fontSize: 12, fontWeight: 600 }}>✓</span> : (
                                      <Checkbox label="Select" labelHidden checked={on}
                                        onChange={() => setChecked(prev => (on ? prev.filter(x => x !== r.variantId) : [...prev, r.variantId]))} />
                                    )}
                                  </td>
                                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>{r.sku}</td>
                                  <td style={TD}>
                                    {r.name}
                                    {onList && <span style={{ marginLeft: 8, color: '#008060', fontSize: 12, fontWeight: 600 }}>Added</span>}
                                  </td>
                                  {extraCols.map(c => <td key={c.key} style={TD}>{r[c.key] || ''}</td>)}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </BlockStack>
              </div>
            )}
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
