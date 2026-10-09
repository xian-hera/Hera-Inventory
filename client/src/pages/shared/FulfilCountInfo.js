import React from 'react';

// Count-modal info for the Online Order fulfillment location (2026-10, Hera).
// The server (GET /api/shopify/inventory) only returns `committed` / `picked`
// when the location being counted is the one set in Online → Settings →
// "Fulfillment location", so this never shows anywhere else. Shown only when
// Committed ≠ 0 (Picked is hidden together with it). Picked > Committed gives
// no warning.
//
// Picked units have already left the shelf, so what the manager should find on
// the shelf is: Available + Committed − Picked.
export default function FulfilCountInfo({ soh, committed, picked }) {
  if (!(committed > 0) || soh === null || soh === undefined) return null;
  const p = picked > 0 ? picked : 0;
  const expected = Math.max(0, soh + committed - p);
  const row = { display: 'flex', justifyContent: 'space-between', fontSize: '14px' };
  return (
    <div style={{ background: '#fff8ec', borderRadius: '8px', padding: '10px 14px',
      color: '#202223', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={row}><span>Available</span><strong>{soh}</strong></div>
      <div style={row}><span>Committed</span><strong>{committed}</strong></div>
      <div style={row}><span>Picked</span><strong>{p}</strong></div>
      <div style={{ ...row, borderTop: '1px solid #f0e0c0', paddingTop: '6px', marginTop: '2px',
        color: '#b05c00', fontWeight: 600 }}>
        <span>Expected on shelf</span><strong>{expected}</strong>
      </div>
    </div>
  );
}
