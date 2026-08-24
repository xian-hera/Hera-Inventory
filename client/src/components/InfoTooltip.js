import React, { useState, useRef, useEffect } from 'react';

// A small click-to-toggle "ⓘ" info tooltip. Matches the PO Receiving mockups:
// clicking the label or the ⓘ opens a white popover with the given text;
// clicking anywhere else dismisses it. No hover behavior, on purpose.
function InfoTooltip({ text, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ cursor: 'pointer' }} onClick={() => setOpen(prev => !prev)}>
        {children}
      </span>
      <span
        onClick={() => setOpen(prev => !prev)}
        style={{
          cursor: 'pointer', fontSize: '13px', color: '#6d7175', borderRadius: '50%',
          border: '1px solid #6d7175', width: '15px', height: '15px', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', lineHeight: 1,
        }}
        title=""
      >
        i
      </span>
      {open && (
        <div
          style={{
            position: 'absolute', top: '22px', left: 0, zIndex: 20,
            background: 'white', border: '1px solid #e1e3e5', borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)', padding: '12px 14px',
            width: '320px', fontSize: '13px', color: '#202223', whiteSpace: 'pre-line',
          }}
        >
          {text}
        </div>
      )}
    </span>
  );
}

export default InfoTooltip;
