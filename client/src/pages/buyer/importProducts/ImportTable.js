// Import Products — the editable, full-width table (2026-09-24).
// Plain <table> (same approach as BuyerPOImportInvoice.js) styled to match
// Polaris; the container scrolls both ways so the horizontal scrollbar is
// always on screen and the header row stays sticky.
import React, { useState, useRef, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { Tooltip } from '@shopify/polaris';
import {
  PRESETS, PRESET_BY_KEY, POOL_METAFIELDS, cellValue, effectiveCell,
  isSubCollectionCol, isDisplaySectionCol, subCollectionOptions,
  subCollectionItems, subCollectionKey,
} from './importModel';

const PRESET_BG = '#f1f8f3';
// Cell grid lines (2026-09-25, Hera): every cell gets a right + top border.
const GRID = '1px solid #e1e3e5';
const GROUP_LINE = '1px solid #8c9196'; // above the first row of each product
const CHECK_COL = 40;
const INFO_COL = 230;
const METAFIELD_BG = '#f0f5fd';
const MAX_CHARS = 55;
const CHAR_PX = 7.2;

function defaultWidth(col, rows) {
  let max = String(col.header || '').length;
  for (let i = 0; i < rows.length && i < 200; i++) {
    const v = String(rows[i].values[col.id] || '');
    if (v.length > max) max = v.length;
    if (max >= MAX_CHARS) break;
  }
  return Math.max(90, Math.min(MAX_CHARS, max) * CHAR_PX + 28);
}

// Presets / metafield grouping (spec §6.3).
export function orderColumns(columns, presetsOn, metafieldsOn) {
  const lc = (s) => String(s || '').toLowerCase();
  let list = [
    ...columns.filter(c => c.synthetic && !c.preset),
    ...columns.filter(c => c.csvIndex != null).sort((a, b) => a.csvIndex - b.csvIndex),
    ...columns.filter(c => c.synthetic && c.preset),
  ];
  if (!presetsOn) {
    list = list.filter(c => !(c.synthetic && c.preset));
  } else {
    const presetCols = PRESETS.map(p => list.find(c => c.preset === p.key)).filter(Boolean);
    list = list.filter(c => !c.preset);
    let anchor = list.findIndex(c => c.kind === 'field' && c.field === 'title');
    if (anchor === -1) anchor = list.findIndex(c => lc(c.header) === 'name');
    const at = anchor === -1 ? list.length : anchor + 1;
    list.splice(at, 0, ...presetCols);
  }
  if (metafieldsOn) {
    const isMf = (c) => (c.kind === 'metafield' || c.kind === 'shopifyMf' || (c.kind === 'unmatched' && c.namespace)) && !(presetsOn && c.preset);
    const mfCols = list.filter(isMf);
    list = list.filter(c => !isMf(c));
    const anchor = list.findIndex(c => c.kind === 'field' && c.field === 'sku');
    list.splice(anchor === -1 ? list.length : anchor + 1, 0, ...mfCols);
  }
  return list;
}

// Dropdown pool for a column, or null for a textbox column.
// Sub collection (2026-09-25): depends on the row's Sub type — returns
// { needsSubType: true } when the row has none. Display section: the
// metafield definition's own choices (read from Shopify at each import).
export function poolFor(col, pools, rowCtx) {
  if (col.preset) return PRESET_BY_KEY[col.preset].options;
  if (col.kind === 'field' && col.field === 'category') return (pools.categories || []).map(c => c.fullName);
  if (isSubCollectionCol(col)) {
    if (!rowCtx) return [];
    const opts = subCollectionOptions(rowCtx.row, rowCtx.columns, pools, rowCtx.isFirstOfGroup, rowCtx.presets);
    return opts === null ? { needsSubType: true } : opts;
  }
  if (isDisplaySectionCol(col)) return (col.def && col.def.choices) || [];
  if (col.kind === 'metafield') {
    const name = POOL_METAFIELDS[`${col.level}.${col.namespace}.${col.key}`];
    if (name) return pools[name] || [];
  }
  return null;
}

// original === null → no "current value" option (used by "Add collection").
function DropdownEditor({ anchorRect, original, originalLabel, pool, isCategory, emptyMessage, onPick, onCancel }) {
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onCancel(); };
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onCancel]);

  const q = query.trim().toLowerCase();
  // Category filters on the lowest level only (spec §6.4).
  const leaf = (s) => String(s).split('>').pop().trim().toLowerCase();
  const filtered = pool.filter(o => !q || (isCategory ? leaf(o) : String(o).toLowerCase()).includes(q));
  const options = [];
  // The CSV's own value (blank counts as a value) is always the first option.
  if (original !== null) options.push({ value: original, label: original === '' ? '(empty)' : original, isOriginal: true });
  for (const o of filtered) if (o !== original) options.push({ value: o, label: o === '' ? '(none — clear this cell)' : o });

  const top = Math.min(anchorRect.bottom + 2, window.innerHeight - 320);
  return ReactDOM.createPortal(
    <div ref={ref} style={{
      position: 'fixed', top, left: Math.min(anchorRect.left, window.innerWidth - 380), width: Math.max(anchorRect.width, 260), maxWidth: 520,
      zIndex: 100000, background: '#fff', border: '1px solid #c9cccf', borderRadius: 8,
      boxShadow: '0 4px 16px rgba(0,0,0,0.18)', padding: 6,
    }}>
      {emptyMessage ? (
        <div style={{ padding: 8, fontSize: 13, color: '#6d7175' }}>{emptyMessage}</div>
      ) : (
      <>
      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Type to filter"
        style={{ width: '100%', boxSizing: 'border-box', height: 32, border: '1px solid #c9cccf', borderRadius: 6, padding: '0 8px', fontSize: 13, marginBottom: 4 }}
      />
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {options.map((o, i) => (
          <div
            key={`${i}-${o.value}`}
            onMouseDown={(e) => { e.preventDefault(); onPick(o.value); }}
            style={{ padding: '7px 8px', cursor: 'pointer', fontSize: 13, borderRadius: 4, color: o.isOriginal ? '#6d7175' : '#202223' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f1f2f3'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            {o.label}{o.isOriginal ? `  · ${originalLabel || 'CSV value'}` : ''}
          </div>
        ))}
        {filtered.length === 0 && q && <div style={{ padding: 8, fontSize: 13, color: '#6d7175' }}>No match</div>}
      </div>
      </>
      )}
    </div>,
    document.body
  );
}

function TextEditor({ initial, onCommit, onCancel }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const commit = () => { if (!done.current) { done.current = true; onCommit(v); } };
  return (
    <textarea
      autoFocus
      value={v}
      onChange={e => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { done.current = true; onCancel(); }
      }}
      rows={Math.min(6, Math.max(1, Math.ceil(String(v).length / 40)))}
      style={{
        width: '100%', boxSizing: 'border-box', fontSize: 13, fontFamily: 'inherit',
        border: '1px solid #005bd3', borderRadius: 6, padding: '4px 6px', resize: 'vertical',
      }}
    />
  );
}

function ImportTable({
  columns, rows, groups, mode, presets, pools, presetsOn, metafieldsOn,
  validation, conflicts, precheck, selectedIds, onToggleRow, onToggleAll, onEdit,
}) {
  const ordered = useMemo(() => orderColumns(columns, presetsOn, metafieldsOn), [columns, presetsOn, metafieldsOn]);
  const [widths, setWidths] = useState({});
  const [editing, setEditing] = useState(null); // { rowId, colId, rect }
  const dragRef = useRef(null);

  const widthOf = (c) => widths[c.id] || defaultWidth(c, rows);

  // Column resize by dragging the header's right edge.
  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      setWidths(w => ({ ...w, [d.id]: Math.max(60, d.start + e.clientX - d.x) }));
    };
    const up = () => { dragRef.current = null; document.body.style.cursor = ''; };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  }, []);

  const groupOf = useMemo(() => {
    const m = new Map();
    groups.forEach(g => g.rows.forEach((r, i) => m.set(r.id, { g, index: i })));
    return m;
  }, [groups]);

  // Rows in group order.
  const orderedRows = useMemo(() => groups.flatMap(g => g.rows), [groups]);

  const allSelected = orderedRows.length > 0 && orderedRows.every(r => selectedIds.includes(r.id));
  const autoHandles = (precheck && precheck.autoHandles) || {};

  const colBg = (c) => {
    if (presetsOn && c.preset) return PRESET_BG;
    if (metafieldsOn && !c.preset && (c.kind === 'metafield' || c.kind === 'shopifyMf')) return METAFIELD_BG;
    return undefined;
  };
  const colDisabled = (c) => c.kind === 'unmatched' || c.kind === 'shopifyMf' || (c.preset && PRESET_BY_KEY[c.preset].readOnly);

  const th = {
    position: 'sticky', top: 0, zIndex: 2, background: '#f7f7f7', textAlign: 'left',
    fontSize: 13, fontWeight: 600, padding: '10px 8px', borderBottom: '1px solid #c9cccf', borderRight: GRID, whiteSpace: 'nowrap',
  };

  // Column widths only take effect when the table itself has an explicit
  // width: with width:auto the browser squeezed every column into the
  // window (3–4 letters per line) and ignored the dragged widths
  // (fixed 2026-09-25). The table is now exactly as wide as its columns.
  const totalWidth = CHECK_COL + INFO_COL + ordered.reduce((sum, c) => sum + widthOf(c), 0);

  // Second horizontal scrollbar above the header, kept in sync with the
  // table's own one — the table scrolls vertically inside its box, so the
  // bottom scrollbar is often off-screen (2026-09-25, Hera).
  const topBarRef = useRef(null);
  const bodyRef = useRef(null);
  // The bar being scrolled by the user "owns" the sync for one frame, so the
  // echo scroll event from the other bar is ignored.
  const scrollOwner = useRef(null);
  const syncScroll = (from, to) => {
    if (scrollOwner.current && scrollOwner.current !== from) return;
    scrollOwner.current = from;
    if (from.current && to.current) to.current.scrollLeft = from.current.scrollLeft;
    window.requestAnimationFrame(() => { scrollOwner.current = null; });
  };
  const stickyLeft = (left, z = 1) => ({ position: 'sticky', left, zIndex: z });

  return (
    <div style={{ border: '1px solid #e1e3e5', borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
    <div
      ref={topBarRef}
      onScroll={() => syncScroll(topBarRef, bodyRef)}
      style={{ overflowX: 'auto', overflowY: 'hidden', borderBottom: GRID, background: '#fafafa' }}
      aria-label="Scroll the table left or right"
    >
      <div style={{ width: totalWidth, height: 1 }} />
    </div>
    <div
      ref={bodyRef}
      onScroll={() => syncScroll(bodyRef, topBarRef)}
      style={{ height: 'calc(100vh - 186px)', minHeight: 360, overflow: 'auto' }}
    >
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed', fontSize: 13, width: totalWidth }}>
        <colgroup>
          <col style={{ width: CHECK_COL }} />
          <col style={{ width: INFO_COL }} />
          {ordered.map(c => <col key={c.id} style={{ width: widthOf(c) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...th, ...stickyLeft(0, 3) }}>
              <input type="checkbox" checked={allSelected} onChange={() => onToggleAll(allSelected ? [] : orderedRows.map(r => r.id))} />
            </th>
            <th style={{ ...th, ...stickyLeft(CHECK_COL, 3), borderRight: '1px solid #c9cccf' }}>Check</th>
            {ordered.map(c => {
              const disabled = colDisabled(c) && !c.preset;
              const title = c.kind === 'unmatched' ? `Will be ignored — ${c.reason || 'not matched'}`
                : c.kind === 'shopifyMf' ? 'Shopify category metafield — shown only, not imported'
                : c.synthetic && c.preset ? 'Added by Presets' : '';
              const inner = (
                <span style={{ color: disabled ? '#8c9196' : undefined }}>
                  {disabled ? '⚠ ' : ''}{c.header}
                </span>
              );
              return (
                <th key={c.id} style={{ ...th, background: colBg(c) || th.background, position: 'sticky', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {title ? <Tooltip content={title}>{inner}</Tooltip> : inner}
                  <span
                    onMouseDown={(e) => { e.preventDefault(); dragRef.current = { id: c.id, x: e.clientX, start: widthOf(c) }; document.body.style.cursor = 'col-resize'; }}
                    title="Drag to resize"
                    style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 1 }}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {orderedRows.map(r => {
            const info = groupOf.get(r.id);
            const isFirst = !info || info.index === 0;
            const g = info && info.g;
            const rowErr = (validation.rowErrors[r.id] || []);
            const cellErr = validation.cellErrors[r.id] || {};
            const cellWarn = (validation.cellWarnings && validation.cellWarnings[r.id]) || {};
            const skipMsgs = g && isFirst ? (validation.skip[g.key] || []) : [];
            const pcRow = precheck && precheck.rows ? precheck.rows[r.rowNumber] : null;
            const matchedTitle = mode === 'update' && pcRow && !pcRow.errors.length ? pcRow.productTitle : '';
            const blocking = rowErr.length + Object.keys(cellErr).length;
            const skipped = g && (validation.skip[g.key] || []).length > 0;
            const rowBg = blocking ? '#fdeceb' : skipped ? '#fff4f4' : '#fff';
            const topBorder = isFirst ? GROUP_LINE : GRID;
            const td = { padding: '8px', borderTop: topBorder, borderRight: GRID, verticalAlign: 'top', background: rowBg, wordBreak: 'break-word', whiteSpace: 'pre-wrap' };
            const msgs = [...rowErr, ...Object.values(cellErr), ...skipMsgs];
            const warnMsgs = Object.values(cellWarn);
            return (
              <tr key={r.id}>
                <td style={{ ...td, ...stickyLeft(0) }}>
                  <input type="checkbox" checked={selectedIds.includes(r.id)} onChange={() => onToggleRow(r.id)} />
                </td>
                <td style={{ ...td, ...stickyLeft(CHECK_COL), borderRight: '1px solid #c9cccf', fontSize: 12 }}>
                  <div style={{ color: '#6d7175' }}>
                    {isFirst ? `Row ${r.rowNumber}` : `↳ Row ${r.rowNumber} · variant`}
                    {matchedTitle ? ` · ${matchedTitle}` : ''}
                  </div>
                  {msgs.map((m, i) => (
                    <div key={i} style={{ color: blocking ? '#d72c0d' : '#b98900', marginTop: 2 }}>
                      {blocking ? '✕ ' : '⚠ '}{m}
                    </div>
                  ))}
                  {warnMsgs.map((m, i) => (
                    <div key={`w${i}`} style={{ color: '#b98900', marginTop: 2 }}>⚠ {m}</div>
                  ))}
                  {!msgs.length && precheck && <div style={{ color: '#008060' }}>✓ Ready</div>}
                </td>
                {ordered.map(c => {
                  const eff = effectiveCell(r, c, { isFirstOfGroup: isFirst, presets });
                  const productOnlyRow = c.level === 'product' && !isFirst && mode === 'add';
                  const disabled = colDisabled(c) || productOnlyRow;
                  const err = cellErr[c.id];
                  const warn = cellWarn[c.id];
                  const conflict = conflicts[r.id] && conflicts[r.id][c.id];
                  let display = eff.value;
                  let style = {};
                  if (eff.source === 'preset') style = { color: '#008060' };
                  if (eff.source === 'edit') style = { color: '#d72c0d', fontWeight: 700 };
                  if (productOnlyRow || c.kind === 'unmatched' || c.kind === 'shopifyMf') style = { ...style, color: '#8c9196' };
                  if (c.kind === 'field' && c.field === 'handle' && mode === 'add' && isFirst && !String(eff.value).trim()) {
                    display = autoHandles[g && g.key] || (g && g.handle) || '';
                    style = { color: '#8c9196', fontStyle: 'italic' };
                  }
                  const isEditing = editing && editing.rowId === r.id && editing.colId === c.id;
                  const pool = poolFor(c, pools, { row: r, columns, isFirstOfGroup: isFirst, presets });
                  const cellStyle = {
                    ...td,
                    background: err ? '#fbe9e7' : (conflict || warn) ? '#fff8e1' : (colBg(c) || td.background),
                    cursor: disabled ? 'default' : 'pointer',
                    outline: err ? '1px solid #d72c0d' : warn ? '1px solid #e8a33d' : undefined,
                    outlineOffset: -1,
                  };
                  // Sub collection is a list (2026-09-25, Hera): one line per
                  // item, click an item to change it, blue "Add collection"
                  // adds another, red × removes an added item.
                  const isSc = isSubCollectionCol(c) && !disabled;
                  const scItems = isSc ? subCollectionItems(eff.value) : [];
                  const saveItems = (items) => onEdit(r.id, c.id, items.join(', '));
                  const openAt = (e, itemIndex) => {
                    e.stopPropagation();
                    setEditing({ rowId: r.id, colId: c.id, itemIndex, rect: e.currentTarget.getBoundingClientRect() });
                  };
                  const scContent = isSc ? (
                    <div style={style}>
                      {scItems.map((it, i) => (
                        <div key={`${i}-${it}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 2 }}>
                          <span onClick={(e) => openAt(e, i)} style={{ cursor: 'pointer' }}>{it}</span>
                          {i > 0 && (
                            <span
                              role="button"
                              aria-label={`Remove ${it}`}
                              onClick={(e) => { e.stopPropagation(); saveItems(scItems.filter((_, j) => j !== i)); }}
                              style={{ color: '#d72c0d', cursor: 'pointer', fontWeight: 700, lineHeight: 1.2 }}
                            >×</span>
                          )}
                        </div>
                      ))}
                      <span
                        onClick={(e) => openAt(e, 'add')}
                        style={{ color: '#005bd3', cursor: 'pointer', fontWeight: 400, fontSize: 12 }}
                      >Add collection</span>
                    </div>
                  ) : null;
                  const content = isSc ? scContent : (
                    <span style={style}>
                      {display === '' ? ' ' : String(display)}
                      {c.kind === 'field' && c.field === 'handle' && mode === 'add' && isFirst && !String(eff.value).trim() && display
                        ? <span style={{ fontSize: 11, marginLeft: 4 }}>auto</span> : null}
                    </span>
                  );
                  return (
                    <td
                      key={c.id}
                      style={cellStyle}
                      onClick={(e) => {
                        if (disabled || isEditing) return;
                        // Sub collection: an empty cell click = Add collection;
                        // otherwise items / links handle their own clicks.
                        if (isSc) { if (!scItems.length) openAt(e, 'add'); return; }
                        setEditing({ rowId: r.id, colId: c.id, rect: e.currentTarget.getBoundingClientRect() });
                      }}
                    >
                      {isEditing && !pool ? (
                        <TextEditor
                          initial={String(cellValue(r, c))}
                          onCommit={(v) => { setEditing(null); onEdit(r.id, c.id, v); }}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (err || conflict || warn || productOnlyRow) ? (
                        <Tooltip content={err || conflict || warn || 'Product-level field — the first row of this product is used'}>{content}</Tooltip>
                      ) : content}
                      {isEditing && pool && isSc && (() => {
                        const idx = editing.itemIndex;
                        const taken = new Set(scItems.filter((_, j) => j !== idx).map(subCollectionKey));
                        const list = (Array.isArray(pool) ? pool : []).filter(o => !taken.has(subCollectionKey(o)));
                        return (
                          <DropdownEditor
                            anchorRect={editing.rect}
                            original={idx === 'add' ? null : scItems[idx]}
                            originalLabel="current"
                            pool={idx === 0 && scItems.length === 1 ? [...list, ''] : list}
                            emptyMessage={pool && pool.needsSubType ? 'Choose sub type first.' : ''}
                            onPick={(v) => {
                              setEditing(null);
                              const next = [...scItems];
                              if (idx === 'add') { if (v) next.push(v); } else if (v === '') next.splice(idx, 1); else next[idx] = v;
                              saveItems(next);
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        );
                      })()}
                      {isEditing && pool && !isSc && (
                        <DropdownEditor
                          anchorRect={editing.rect}
                          original={String(r.values[c.id] == null ? '' : r.values[c.id])}
                          pool={Array.isArray(pool) ? pool : []}
                          emptyMessage={pool && pool.needsSubType ? 'Choose sub type first.' : ''}
                          isCategory={c.kind === 'field' && c.field === 'category'}
                          onPick={(v) => { setEditing(null); onEdit(r.id, c.id, v); }}
                          onCancel={() => setEditing(null)}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {orderedRows.length === 0 && (
            <tr><td colSpan={ordered.length + 2} style={{ padding: 24, color: '#6d7175', textAlign: 'center' }}>No rows.</td></tr>
          )}
        </tbody>
      </table>
    </div>
    </div>
  );
}

export default ImportTable;
