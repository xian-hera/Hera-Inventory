import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Page, Card, BlockStack, Text, Banner, Button } from '@shopify/polaris';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { StatusBadge, TagPills } from '../shared/transferStatus';
import { LineNote, LineNoteIcon, transferLineNoteApi } from '../shared/lineNote';

// Store › Online transfer (2026-10-23, Hera — claude/FULFILLER_ONLINE_TRANSFER_SPEC.md).
// The from-store prepares an Online (Fulfiller) transfer here instead of the
// normal TransferPrepDetail (ManagerTransferSendingDetail picks this page when
// transfer.source === 'fulfiller').
//   • columns: product (first image · Type · SKU · Name · Wig Number for wigs ·
//     Variant name) · Requested Qty · Loaded Qty (red when ≠ requested, empty
//     while not picked);
//   • order: not picked → loaded ≠ requested → loaded = requested;
//   • tap a row (or scan its barcode) → item modal: big image, Qty box
//     (pre-filled 0) + Picked, Note, big green "Picked {requested}"; a picked
//     line shows "You have picked …" / its qty with Reset;
//   • Ready to Ship only when every line is picked. Any qty may be loaded —
//     no Reviewing (server). Read-only afterwards.

function resolveKey(e) {
  if (e.key && e.key !== 'Unidentified' && e.key.length === 1) return e.key;
  if (e.code) {
    if (e.code.startsWith('Digit')) return e.code.slice(5);
    if (e.code.startsWith('Numpad') && e.code.length === 7) return e.code.slice(6);
    if (e.code.startsWith('Key') && e.code.length === 4) {
      const ch = e.code.slice(3);
      return e.shiftKey ? ch : ch.toLowerCase();
    }
  }
  return null;
}
const cleanBarcode = (raw) => raw.replace(/^[^0-9]+/, '');

const requestedOf = (i) => Number(i.requested_qty != null ? i.requested_qty : i.quantity);
const isPicked = (i) => !!i.loaded_confirmed && i.qty_loaded != null;
const rank = (i) => (!isPicked(i) ? 0 : Number(i.qty_loaded) !== requestedOf(i) ? 1 : 2);
const isWig = (i) => String(i.product_type || '').toUpperCase() === 'WIG';

function Thumb({ src, size }) {
  return src
    ? <img src={src} alt="" style={{ width: size, height: size, objectFit: 'cover', borderRadius: 6, flex: 'none', background: '#f1f1f1' }} />
    : <div style={{ width: size, height: size, borderRadius: 6, flex: 'none', background: '#e3e3e3' }} />;
}

function ProductText({ item, big }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: '#8a8a8a' }}>
        {item.product_type && <span style={{ marginRight: 8, color: '#b5b5b5' }}>{item.product_type}</span>}
        {item.sku}
      </div>
      <div style={{ fontWeight: 650 }}>{item.product_title || item.name}</div>
      {isWig(item) && item.wig_no && <div style={{ fontSize: 13, fontWeight: 600, marginTop: big ? 0 : 4 }}>{item.wig_no}</div>}
      {item.variant_title && <div style={{ fontSize: big ? 18 : 16, fontWeight: 650 }}>{item.variant_title}</div>}
    </div>
  );
}

// Item modal — placed high on the screen (Shopify's own bottom bar on phones
// can't cover its buttons); scrolls inside when tall.
function ItemModal({ item, transferId, onClose, onChanged, setError }) {
  const picked = isPicked(item);
  const req = requestedOf(item);
  const fullGreen = picked && Number(item.qty_loaded) === req;
  const [qty, setQty] = useState(picked && !fullGreen ? String(item.qty_loaded) : '0');
  const [busy, setBusy] = useState(false);
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Failed');
  };
  const pick = async (n) => {
    if (!Number.isInteger(n) || n < 0) return;
    setBusy(true);
    try { await post(`/api/transfers/${transferId}/qty-loaded`, { itemId: item.id, qty: n }); await onChanged(); onClose(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true);
    try { await post(`/api/transfers/${transferId}/qty-loaded/undo`, { itemId: item.id }); await onChanged(); onClose(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const noteApi = transferLineNoteApi(transferId, item.id);
  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 520, background: 'rgba(0,0,0,0.45)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '4vh 12px 0' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(560px, 100%)', maxHeight: '84vh', overflowY: 'auto', background: '#fff', borderRadius: 14, padding: 16, boxSizing: 'border-box', boxShadow: '0 10px 30px rgba(0,0,0,0.25)' }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#8a8a8a' }}>
              {item.product_type && <span style={{ marginRight: 8, color: '#b5b5b5' }}>{item.product_type}</span>}
              <span style={{ marginRight: 8 }}>{item.sku}</span>
              <span style={{ color: '#303030', fontWeight: 650 }}>{item.product_title || item.name}</span>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
              {isWig(item) && item.wig_no && <span style={{ marginRight: 10 }}>{item.wig_no}</span>}
              {item.variant_title}
            </div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 22, lineHeight: 1, cursor: 'pointer', color: '#6d7175' }}>×</button>
        </div>
        <div style={{ margin: '12px 0', width: '100%', aspectRatio: '1 / 1', background: '#f1f1f1', borderRadius: 8, overflow: 'hidden' }}>
          {item.image_url && <img src={item.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="number"
                inputMode="numeric"
                min="0"
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ''))}
                onFocus={(e) => e.target.select()}
                aria-label="Qty"
                style={{ width: 64, minWidth: 0, font: 'inherit', fontSize: 16, padding: '6px 8px', border: '1px solid #c9cccf', borderRadius: 8 }}
              />
              <Button onClick={() => pick(parseInt(qty || '0', 10))} disabled={busy}>Picked</Button>
            </div>
            <LineNote note={item.line_note} onSave={async (t) => { await noteApi.save(t); await onChanged(); }} onDelete={async () => { await noteApi.remove(); await onChanged(); }} />
          </div>
          <div style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {fullGreen ? (
              <>
                <div style={{ minHeight: 64, borderRadius: 10, background: '#e3f1df', color: '#0c5132', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 650, fontSize: 16, padding: '0 12px', textAlign: 'center' }}>
                  You have picked {req}
                </div>
                <Button onClick={reset} disabled={busy}>Reset</Button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => pick(req)}
                  style={{ minHeight: 64, border: 'none', borderRadius: 10, background: '#16a34a', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, font: 'inherit' }}
                >
                  <span style={{ fontSize: 22, fontWeight: 700 }}>Picked</span>
                  <span style={{ fontSize: 16, fontWeight: 600 }}>{req}</span>
                </button>
                {picked && <Button onClick={reset} disabled={busy}>Reset</Button>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function OnlineTransferPrepDetail() {
  const navigate = useNavigate();
  const { transferId } = useParams();
  const location = useLocation();
  const backTo = (location.state && location.state.from) || '/manager/transfer';
  const [transfer, setTransfer] = useState(null);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [notFound, setNotFound] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const itemsRef = useRef([]);
  const openRef = useRef(null);
  const buf = useRef('');
  const bufTimer = useRef(null);
  const nfTimer = useRef(null);
  itemsRef.current = items;
  openRef.current = openId;

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/transfers/${transferId}?role=manager`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load');
      setTransfer(d.transfer);
      setItems((d.items || []).filter(i => i.edit_state !== 'removed'));
    } catch (e) {
      setError(e.message);
    }
  }, [transferId]);
  useEffect(() => { load(); }, [load]);

  const editable = transfer && transfer.status === 'loading' && !transfer.on_hold;

  // barcode scanner: keydown buffer, Enter ends a scan
  useEffect(() => {
    if (!editable) return undefined;
    const onKey = (e) => {
      if (openRef.current) return;
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (e.key === 'Enter') {
        clearTimeout(bufTimer.current);
        const code = cleanBarcode(buf.current.trim());
        buf.current = '';
        if (!code) return;
        const hit = itemsRef.current.find(i => i.sku === code);
        if (hit) setOpenId(hit.id);
        else {
          clearTimeout(nfTimer.current);
          setNotFound(code);
          nfTimer.current = setTimeout(() => setNotFound(''), 2500);
        }
        return;
      }
      const ch = resolveKey(e);
      if (ch) {
        buf.current += ch;
        clearTimeout(bufTimer.current);
        bufTimer.current = setTimeout(() => { buf.current = ''; }, 500);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(bufTimer.current); clearTimeout(nfTimer.current); };
  }, [editable]);

  if (!transfer) {
    return (
      <Page title="Transfer" backAction={{ onAction: () => navigate(backTo) }}>
        {error ? <Banner tone="critical">{error}</Banner> : <Text tone="subdued">Loading...</Text>}
      </Page>
    );
  }

  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || (a.product_title || a.name || '').localeCompare(b.product_title || b.name || ''));
  const allPicked = items.length > 0 && items.every(isPicked);
  const open = items.find(i => i.id === openId) || null;

  const readyToShip = async () => {
    setSubmitting(true); setError('');
    try {
      const r = await fetch(`/api/transfers/${transferId}/submit-loading`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: transfer.updated_at }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409) throw new Error('Someone else changed this transfer. It has been reloaded.');
      if (!r.ok) throw new Error(d.error || 'Ready to Ship failed');
      await load();
    } catch (e) {
      setError(e.message);
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  // narrow qty columns (phone): header words wrap, numbers stay large
  const TH = { padding: '8px 8px 8px 12px', textAlign: 'right', color: '#6d7175', fontWeight: 500, width: 80, lineHeight: '16px', fontSize: 13 };
  return (
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      <Page
        title={transfer.shopify_transfer_name || transfer.transfer_no}
        backAction={{ onAction: () => navigate(backTo) }}
        titleMetadata={<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><TagPills tags={transfer.tags} /><StatusBadge status={transfer.status} /></span>}
        primaryAction={editable ? { content: 'Ready to Ship', onAction: readyToShip, disabled: !allPicked || submitting, loading: submitting } : undefined}
      >
        <BlockStack gap="300">
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
          {transfer.on_hold && <Text tone="critical" fontWeight="bold">This transfer is on hold.</Text>}
          {notFound && <Banner tone="warning">No item found ({notFound}).</Banner>}
          <Card padding="0">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, tableLayout: 'fixed' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e1e3e5' }}>
                  <th style={{ width: 'auto' }} />
                  <th style={TH}>Requested Qty</th>
                  <th style={TH}>Loaded Qty</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(i => {
                  const req = requestedOf(i);
                  const off = isPicked(i) && Number(i.qty_loaded) !== req;
                  return (
                    <tr
                      key={i.id}
                      onClick={() => { if (editable) setOpenId(i.id); }}
                      style={{ borderBottom: '1px solid #f1f1f1', cursor: editable ? 'pointer' : 'default' }}
                    >
                      <td style={{ padding: '10px 6px 10px 10px', overflow: 'hidden' }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
                          <Thumb src={i.image_url} size={56} />
                          <ProductText item={i} />
                        </div>
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'right', fontSize: 18, fontWeight: 500 }}>{req}</td>
                      <td style={{ padding: '10px 8px', textAlign: 'right', fontSize: 18, fontWeight: 500, color: off ? '#d72c0d' : '#303030', whiteSpace: 'nowrap' }}>
                        {isPicked(i) ? i.qty_loaded : ''}
                        {i.line_note && <span style={{ marginLeft: 6 }}><LineNoteIcon note={i.line_note} /></span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} />
        </BlockStack>
      </Page>
      {open && editable && (
        <ItemModal item={open} transferId={transferId} onClose={() => setOpenId(null)} onChanged={load} setError={setError} />
      )}
    </div>
  );
}

export default OnlineTransferPrepDetail;
