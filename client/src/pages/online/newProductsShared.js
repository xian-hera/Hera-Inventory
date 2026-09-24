// Shared bits for Online → New products / Finalized (2026-09-24).
import React, { useState, useRef } from 'react';
import ReactDOM from 'react-dom';

export const STORE_ADMIN = 'https://admin.shopify.com/store/beaute-hera/products/';
export const numericId = (gid) => { const m = String(gid || '').match(/(\d+)$/); return m ? m[1] : ''; };
export const adminUrl = (gid) => `${STORE_ADMIN}${numericId(gid)}`;

// Hover tooltip that renders the (server-sanitized) description HTML in a
// fixed-size box; long content is cut off with a fade (spec §15.2).
export function HtmlTooltip({ html, text, children }) {
  const [rect, setRect] = useState(null);
  const ref = useRef(null);
  const W = 480;
  const H = 320;
  const open = () => { if (ref.current) setRect(ref.current.getBoundingClientRect()); };
  const close = () => setRect(null);
  let pos = null;
  if (rect) {
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - W - 8));
    const below = rect.bottom + 6;
    const top = below + H > window.innerHeight - 8 ? Math.max(8, rect.top - H - 6) : below;
    pos = { left, top };
  }
  return (
    <span ref={ref} onMouseEnter={open} onMouseLeave={close} style={{ cursor: 'default' }}>
      {children}
      {rect && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', ...pos, width: W, maxHeight: H, overflow: 'hidden', zIndex: 100000,
          background: '#fff', border: '1px solid #c9cccf', borderRadius: 8, padding: '10px 12px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.18)', fontSize: 13, lineHeight: 1.45, pointerEvents: 'none',
        }}>
          {html
            // eslint-disable-next-line react/no-danger
            ? <div dangerouslySetInnerHTML={{ __html: html }} />
            : <div>{text || '(empty)'}</div>}
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 36, background: 'linear-gradient(rgba(255,255,255,0), #fff)' }} />
        </div>,
        document.body
      )}
    </span>
  );
}

export function FrIcon() {
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, fontWeight: 700, color: '#fff', background: '#2c9ad6',
      borderRadius: 3, padding: '0 3px', lineHeight: '15px', marginRight: 6, verticalAlign: 'middle',
    }}>FR</span>
  );
}

// Small shared table styles.
export const TH = { textAlign: 'left', padding: '10px 8px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid #e1e3e5', verticalAlign: 'bottom' };
export const TD = { padding: '10px 8px', fontSize: 13, borderTop: '1px solid #f1f1f1', verticalAlign: 'top', wordBreak: 'break-word' };

export async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function putJson(url, body) {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
