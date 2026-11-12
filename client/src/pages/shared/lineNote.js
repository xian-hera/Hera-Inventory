import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@shopify/polaris';

// Line-item notes (2026-10-22, Hera — claude/STORE_DASHBOARD_AND_LINE_NOTES.md).
// While counting (Store › PO Receiving, Transfer receiving — also WH ›
// Receiving to HQ — and Weekly Inventory Count) ONE note can be left on a
// line item from its count modal:
//   Note button (same size as the modal's Submit) → becomes a full-width text
//   box with Cancel / Save under it (Save only with text) → after Save the
//   note shows with a red × on its left (deletes at once, no confirm) and the
//   Note button is gone until it is deleted.
// Lists show a blue (i) next to the count of a line item that has a note;
// Purchasing sees the same (i) next to the store's count and the note text
// when hovering anywhere on that row.

// <LineNote note onSave(text) onDelete() leading />
//   leading: optional node on the same row, left of the Note button
//   (Inventory Count: the "Check History" button).
export function LineNote({ note, onSave, onDelete, leading = null }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const boxRef = useRef(null);

  useEffect(() => { if (editing && boxRef.current) boxRef.current.focus(); }, [editing]);

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true); setError('');
    try {
      await onSave(text);
      setEditing(false); setDraft('');
    } catch (e) {
      setError(e.message || 'Could not save the note');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await onDelete(); } catch (e) { setError(e.message || 'Could not delete the note'); } finally { setBusy(false); }
  };

  const showButton = !note && !editing;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {(leading || showButton) && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          {leading}
          {showButton && <Button onClick={() => { setEditing(true); setDraft(''); setError(''); }}>Note</Button>}
        </div>
      )}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            ref={boxRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={3}
            placeholder="Note for this item..."
            style={{
              width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 16, lineHeight: '22px',
              border: '1px solid #005bd3', borderRadius: 8, outline: 'none', resize: 'vertical', fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={() => { setEditing(false); setDraft(''); setError(''); }} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={busy} disabled={!draft.trim()}>Save</Button>
          </div>
        </div>
      )}
      {note && !editing && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            aria-label="Delete note"
            style={{
              border: 'none', background: 'none', padding: '0 2px', margin: 0, cursor: busy ? 'default' : 'pointer',
              color: '#d72c0d', fontSize: 18, lineHeight: '22px', fontWeight: 700,
            }}
          >×</button>
          <div style={{ fontSize: 14, lineHeight: '22px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#303030' }}>{note}</div>
        </div>
      )}
      {error && <div style={{ color: '#d72c0d', fontSize: 13 }}>{error}</div>}
    </div>
  );
}

// ── Note in its own popup (2026-11-12, Hera) ────────────────────────────────
// Used by the Store count modals since the keypad change (Weekly Inventory
// Count, PO count, Transfer receiving count, Online transfer prep): the Note
// button sits left of the count box; tapping it opens a separate small popup
// (placed high, so the phone keyboard doesn't cover it) instead of growing
// the count modal. Save overwrites the note (one note per line item, as
// before); the saved note shows at the bottom of the count modal with a red
// × on its left (LineNoteText). LineNote above is kept for any other use.
//
// <LineNoteButton note onSave(text) /> · <LineNoteText note onDelete() />
export function LineNoteButton({ note, onSave, disabled = false }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={disabled}>Note</Button>
      {open && <LineNotePopup note={note} onSave={onSave} onClose={() => setOpen(false)} />}
    </>
  );
}

function LineNotePopup({ note, onSave, onClose }) {
  const [draft, setDraft] = useState(note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const boxRef = useRef(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch (e) { /* ignore */ } }
  }, []);
  const save = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setError('');
    try { await onSave(text); onClose(); } catch (e) { setError(e.message || 'Could not save the note'); setBusy(false); }
  };
  return createPortal(
    <div
      onClick={() => { if (!busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 2500, background: 'rgba(0,0,0,0.45)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '8vh 16px 0' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Note"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(420px, 100%)', background: '#fff', borderRadius: 12, padding: 16, boxSizing: 'border-box', boxShadow: '0 10px 30px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <div style={{ fontSize: 16, fontWeight: 650 }}>Note</div>
        <textarea
          ref={boxRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={3}
          placeholder="Note for this item..."
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 16, lineHeight: '22px',
            border: '1px solid #005bd3', borderRadius: 8, outline: 'none', resize: 'vertical', fontFamily: 'inherit',
          }}
        />
        {error && <div style={{ color: '#d72c0d', fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!draft.trim()}>Save</Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function LineNoteText({ note, onDelete }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!note) return null;
  const remove = async () => {
    setBusy(true); setError('');
    try { await onDelete(); } catch (e) { setError(e.message || 'Could not delete the note'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label="Delete note"
          style={{
            border: 'none', background: 'none', padding: '0 2px', margin: 0, cursor: busy ? 'default' : 'pointer',
            color: '#d72c0d', fontSize: 18, lineHeight: '22px', fontWeight: 700,
          }}
        >×</button>
        <div style={{ fontSize: 14, lineHeight: '22px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#303030' }}>{note}</div>
      </div>
      {error && <div style={{ color: '#d72c0d', fontSize: 13 }}>{error}</div>}
    </div>
  );
}

// Blue circle (i): this line item has a note.
export function LineNoteIcon({ note, title }) {
  if (!note) return null;
  return (
    <span
      title={title}
      aria-label="Has a note"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16,
        borderRadius: '50%', background: '#005bd3', color: '#fff', fontSize: 11, fontWeight: 700,
        fontStyle: 'italic', fontFamily: 'Georgia, serif', lineHeight: 1, marginLeft: 6,
        verticalAlign: 'middle', flex: '0 0 auto',
      }}
    >i</span>
  );
}

// Purchasing: wraps a table; hovering anywhere on a row whose <tr> carries
// data-line-note="…" (or, for Polaris DataTable rows, whose position matches
// notesByRow[i]) shows the note next to the pointer.
export function LineNoteHover({ children, notesByRow }) {
  const [tip, setTip] = useState(null); // { text, x, y }
  const onMove = (e) => {
    const tr = e.target && e.target.closest ? e.target.closest('tr') : null;
    let text = '';
    if (tr) {
      if (tr.dataset && tr.dataset.lineNote) text = tr.dataset.lineNote;
      else if (notesByRow && tr.parentNode && tr.parentNode.tagName === 'TBODY') {
        const idx = Array.prototype.indexOf.call(tr.parentNode.children, tr);
        text = notesByRow[idx] || '';
      }
    }
    if (text) setTip({ text, x: e.clientX, y: e.clientY });
    else if (tip) setTip(null);
  };
  return (
    <div onMouseMove={onMove} onMouseLeave={() => setTip(null)}>
      {children}
      {tip && createPortal(
        <div style={{
          position: 'fixed', zIndex: 900, left: Math.min(tip.x + 14, window.innerWidth - 336), top: tip.y + 16,
          maxWidth: 320, background: '#fff', color: '#303030', border: '1px solid #c9cccf', borderRadius: 8,
          boxShadow: '0 6px 18px rgba(0,0,0,0.15)', padding: '8px 10px', fontSize: 13, lineHeight: '18px',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', pointerEvents: 'none',
        }}>
          <div style={{ fontSize: 11, color: '#6d7175', marginBottom: 2 }}>Store note</div>
          {tip.text}
        </div>,
        document.body
      )}
    </div>
  );
}

// Save / delete helpers (one per kind of task).
async function call(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
export const poLineNoteApi = (invoiceId, itemId) => ({
  save: (text) => call(`/api/po-invoices/manager/receiving/${invoiceId}/items/${itemId}/note`, 'PUT', { text }),
  remove: () => call(`/api/po-invoices/manager/receiving/${invoiceId}/items/${itemId}/note`, 'DELETE'),
});
export const transferLineNoteApi = (transferId, itemId) => ({
  save: (text) => call(`/api/transfers/${transferId}/items/${itemId}/note`, 'PUT', { text }),
  remove: () => call(`/api/transfers/${transferId}/items/${itemId}/note`, 'DELETE'),
});
export const taskLineNoteApi = (taskId, itemId) => ({
  save: (text) => call(`/api/tasks/${taskId}/items/${itemId}/note`, 'PUT', { text }),
  remove: () => call(`/api/tasks/${taskId}/items/${itemId}/note`, 'DELETE'),
});
