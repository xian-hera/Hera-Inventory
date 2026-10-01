// Online › Swatch — small API helpers + shared bits (2026-10-01).
// Server: server/routes/swatch.js (/api/swatch). Spec: claude/SWATCH_FEATURE_SPEC.md.
import React from 'react';

export const ADMIN_PRODUCT = 'https://admin.shopify.com/store/beaute-hera/products/';

async function call(method, url, body) {
  const res = await fetch(`/api/swatch${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
export const api = {
  get: (u) => call('GET', u),
  post: (u, b) => call('POST', u, b || {}),
  put: (u, b) => call('PUT', u, b || {}),
  del: (u, b) => call('DELETE', u, b),
};

// Shopify CDN image at a given width (keeps the ?v= version param).
export const thumb = (url, width = 160) => (url ? `${url}${url.includes('?') ? '&' : '?'}width=${width}` : '');

// File -> base64 (no data: prefix)
export const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export const STATUS_LABEL = {
  matched: 'Matched',
  possible: 'Possible match',
  none: 'No match',
};

export const TH = { textAlign: 'left', padding: '10px 8px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid #e1e3e5', verticalAlign: 'bottom', whiteSpace: 'nowrap' };
export const TD = { padding: '8px', fontSize: 13, borderTop: '1px solid #f1f1f1', verticalAlign: 'top', wordBreak: 'break-word' };

// Swatch card preview: same proportions / crop as the storefront (spec §1.1, §7.2).
export function SwatchThumb({ url, position, width = 48, height = 54, style }) {
  return (
    <div style={{
      width, height, flex: 'none', borderRadius: 4, border: '1px solid #e1e3e5',
      background: url ? `#fff url("${thumb(url, 200)}") no-repeat` : '#f6f6f7',
      backgroundSize: 'cover', backgroundPosition: position || 'center top', ...style,
    }} />
  );
}

export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
