import React from 'react';

// Count history as one row of pills (2026-11-12, Hera): "Counted" then one
// grey pill per count (its number) and a light-green pill with a check for
// each time the green Correct button was used. Wraps onto a new line only
// when there are too many pills for one. Used by the count modals of Weekly
// Inventory Count, Manual Inventory Count and Purchase Orders (was: one
// "● counted N" / tally line per count).
//   <CountPills history={[{ type: 'counted' | 'correct' | 'set', value }]} />

const PILL = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  minWidth: 28, height: 24, padding: '0 8px', borderRadius: 6, boxSizing: 'border-box',
  fontSize: 14, fontWeight: 600, lineHeight: 1, color: '#303030',
};

const Check = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#303030" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.2 3.2L13 4.8" />
  </svg>
);

export default function CountPills({ history }) {
  const list = Array.isArray(history) ? history : [];
  if (list.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 14, color: '#303030', marginRight: 4 }}>Counted</span>
      {list.map((h, i) => (h.type === 'correct'
        ? <span key={i} style={{ ...PILL, background: '#cdfee1' }} title="Correct" aria-label="Correct"><Check /></span>
        : <span key={i} style={{ ...PILL, background: '#e3e3e3' }}>{String(h.value)}</span>
      ))}
    </div>
  );
}
