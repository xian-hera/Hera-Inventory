import React, { useState, useRef, useEffect } from 'react';

function MultiSelectDropdown({ label, options, selected, onChange, placeholder = 'ALL' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const toggle = (value) => {
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const displayText = selected.length === 0 ? placeholder : selected.join(', ');

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: '140px' }}>
      {label && (
        <div style={{ fontSize: '12px', color: '#6d7175', marginBottom: '4px' }}>{label}</div>
      )}
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          padding: '6px 28px 6px 10px',
          border: '1px solid #c9cccf',
          borderRadius: '8px',
          background: 'white',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: '14px',
          position: 'relative',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {displayText}
        <span style={{
          position: 'absolute', right: '8px', top: '50%',
          transform: 'translateY(-50%)', pointerEvents: 'none',
        }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0,
          background: 'white', border: '1px solid #c9cccf',
          borderRadius: '8px', zIndex: 100, minWidth: '100%',
          maxHeight: '240px', overflowY: 'auto',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          marginTop: '4px',
        }}>
          {options.map(opt => {
            const value = typeof opt === 'string' ? opt : opt.value;
            const label = typeof opt === 'string' ? opt : opt.label;
            const checked = selected.includes(value);
            return (
              <div
                key={value}
                onClick={() => toggle(value)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: checked ? '#f1f8f5' : 'white',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {}}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{ fontSize: '14px' }}>{label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default MultiSelectDropdown;