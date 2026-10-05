import React, { useState } from 'react';
import { Button } from '@shopify/polaris';

// Shared by WarehouseBoxPODetail.js and BuyerBoxPODetail.js (2026-10-05, Hera)
// — per-line-item Note column + the responsive table styles both pages use.
// See claude/BOX_PO_FEATURE_SPEC.md for the narrated spec.
//
// Responsive approach: same as Home.js / ManagerWigDemo.js — render both the
// desktop and mobile markup and let a single @media rule (breakpoint 767/768px)
// pick which one is visible; no JS reads window.innerWidth.
//  - Desktop (>=768px): clicking a row's Note button/text turns that row's
//    Note cell into an inline textbox + Save.
//  - Mobile (<=767px): the Note cell stays as is, and an EXTRA full-width row
//    is inserted under the line item holding the textbox + Save; saving makes
//    the extra row disappear and the text lands in the Note column.
// Only one line item is ever being edited at a time (editingId in the hook).

const CSS = `
.bpo-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.bpo-th { padding: 8px 10px; text-align: left; font-weight: 600; color: #6d7175; white-space: nowrap; }
.bpo-td { padding: 10px; }
.bpo-col-loc { width: 1%; white-space: nowrap; }
.bpo-col-qty { width: 1%; white-space: nowrap; }
.bpo-col-num { width: 1%; white-space: nowrap; }
.bpo-col-note { width: 100%; max-width: 0; }
.bpo-h-mobile { display: none; }
.bpo-qty-input { width: 72px; padding: 4px 6px; border-radius: 6px; border: 1px solid #c9cccf; font-size: 13px; }
.bpo-note-input { flex: 1; min-width: 0; padding: 5px 8px; border-radius: 6px; border: 1px solid #c9cccf; font-size: 13px; }
.bpo-note-view { display: block; min-width: 0; }
.bpo-note-text { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.bpo-note-inline { display: none; align-items: center; gap: 6px; }
.bpo-note-row { display: none; }
.bpo-note-row-inner { display: flex; align-items: center; gap: 6px; }
.bpo-uncount { cursor: pointer; }
@media (min-width: 768px) {
  .bpo-editing .bpo-note-view { display: none; }
  .bpo-editing .bpo-note-inline { display: flex; }
}
@media (max-width: 767px) {
  .bpo-table { table-layout: fixed; }
  .bpo-th, .bpo-td { padding: 8px 6px; }
  .bpo-col-loc { width: calc(7ch + 12px); }
  .bpo-col-qty { width: calc(3ch + 54px); }
  .bpo-col-num { width: 44px; }
  .bpo-col-note { width: auto; max-width: none; }
  .bpo-h-desktop { display: none; }
  .bpo-h-mobile { display: inline; }
  .bpo-qty-input { width: calc(3ch + 8px); padding: 4px 4px; }
  .bpo-note-row { display: table-row; }
}
`;

export function BoxPoTableStyle() {
  return <style>{CSS}</style>;
}

// Header cell text: "Destination" on desktop, "Dest." on phones.
export function LocationHeader() {
  return (
    <>
      <span className="bpo-h-desktop">Destination</span>
      <span className="bpo-h-mobile">Dest.</span>
    </>
  );
}

// State + handlers for the per-line note editor. `onChanged` is called after a
// successful save/delete so the page can reload its items.
export function useLineNoteEditor(boxPoId, onChanged, setError) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = (item) => { setEditingId(item.id); setDraft(item.note || ''); };
  const cancel = () => { setEditingId(null); setDraft(''); };

  const post = async (itemId, text) => {
    const res = await fetch(`/api/box-po/${boxPoId}/item-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save note');
  };

  const save = async (item) => {
    setSaving(true);
    setError('');
    try {
      await post(item.id, draft);
      setEditingId(null);
      setDraft('');
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item) => {
    setError('');
    try {
      await post(item.id, '');
      if (editingId === item.id) cancel();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  return { editingId, draft, setDraft, saving, startEdit, cancel, save, remove };
}

function NoteEditor({ editor, item, className }) {
  const onKeyDown = (e) => {
    if (e.key === 'Enter') editor.save(item);
    if (e.key === 'Escape') editor.cancel();
  };
  return (
    <div className={className}>
      <input
        className="bpo-note-input"
        type="text"
        value={editor.draft}
        onChange={e => editor.setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Add a note..."
        autoFocus
      />
      <Button onClick={() => editor.save(item)} loading={editor.saving}>Save</Button>
      <Button variant="plain" onClick={editor.cancel}>Cancel</Button>
    </div>
  );
}

// The Note <td>. `editable` = false -> read-only (truncated text + hover
// tooltip via the native title attribute, no Note button, no ×).
export function LineNoteTd({ item, editable, editor }) {
  const editing = editable && editor.editingId === item.id;
  return (
    <td className={`bpo-td bpo-col-note${editing ? ' bpo-editing' : ''}`}>
      <div className="bpo-note-view">
        {item.note ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            {editable && (
              <span
                style={{ cursor: 'pointer', color: '#d72c0d', fontWeight: 700, flexShrink: 0 }}
                title="Delete note"
                onClick={() => editor.remove(item)}
              >
                ×
              </span>
            )}
            <span
              className="bpo-note-text"
              title={item.note}
              style={{ cursor: editable ? 'pointer' : 'default' }}
              onClick={editable ? () => editor.startEdit(item) : undefined}
            >
              {item.note}
            </span>
          </div>
        ) : (
          editable && <Button onClick={() => editor.startEdit(item)}>Note</Button>
        )}
      </div>
      {editing && <NoteEditor editor={editor} item={item} className="bpo-note-inline" />}
    </td>
  );
}

// The extra full-width row shown under a line item while it is being edited
// on phones (display:none on desktop via CSS). Render right after the item's
// own <tr>.
export function LineNoteExtraRow({ item, editable, editor, colSpan }) {
  if (!editable || editor.editingId !== item.id) return null;
  return (
    <tr className="bpo-note-row" style={{ borderBottom: '1px solid #f1f1f1' }}>
      <td colSpan={colSpan} className="bpo-td">
        <NoteEditor editor={editor} item={item} className="bpo-note-row-inner" />
      </td>
    </tr>
  );
}
