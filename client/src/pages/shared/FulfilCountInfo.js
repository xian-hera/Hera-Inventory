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
  // 2026-11-12 (Hera): 2 rows instead of 4 — the four labels on top, their
  // numbers under them — with smaller text, so the count modal is shorter
  // (room for the Hub keypad). Never wraps: on a narrow screen the text gets
  // a little smaller (vw-based clamp) and the columns narrower.
  // Was: one "label … number" row each, 14px, Expected on shelf under a line.
  const cols = [
    ['Available', soh],
    ['Committed', committed],
    ['Picked', p],
    ['Expected on shelf', expected, true],
  ];
  return (
    <div style={{ background: '#fff8ec', borderRadius: '8px', padding: '8px 12px',
      color: '#202223', display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
      {cols.map(([label, value, strong]) => (
        <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0,
          whiteSpace: 'nowrap', color: strong ? '#b05c00' : undefined }}>
          <span style={{ fontSize: 'clamp(9px, 2.9vw, 11px)', lineHeight: 1.2, fontWeight: strong ? 600 : 400 }}>{label}</span>
          <span style={{ fontSize: 'clamp(13px, 4vw, 15px)', lineHeight: 1.2, fontWeight: 650 }}>{value}</span>
        </div>
      ))}
    </div>
  );
}
