import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';

function MultiSelectDropdown({ label, options, selected, onChange, placeholder = 'ALL' }) {
  const [open, setOpen] = useState(false);
  const [dropStyle, setDropStyle] = useState({});
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      const btn = btnRef.current;
      const drop = document.querySelector('[data-msd-drop="' + label + '"]');
      if (btn && !btn.contains(e.target) && drop && !drop.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, label]);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        minWidth: Math.max(rect.width, 160),
        zIndex: 99999,
        background: 'white',
        border: '1px solid #c9cccf',
        borderRadius: '8px',
        maxHeight: '320px',
        minHeight: '120px',
        overflowY: 'auto',
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      });
    }
    setOpen(!open);
  };

  const toggle = (value) => {
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
  };

  const displayText = selected.length === 0 ? placeholder : selected.join(', ');

  return (
    <div style={{ position: 'relative', minWidth: '140px' }}>
      {label && (
        <div style={{ fontSize: '12px', color: '#6d7175', marginBottom: '4px' }}>{label}</div>
      )}
      <button
        ref={btnRef}
        onClick={handleToggle}
        style={{
          width: '100%', padding: '6px 28px 6px 10px',
          border: '1px solid #c9cccf', borderRadius: '8px',
          background: 'white', cursor: 'pointer', textAlign: 'left',
          fontSize: '14px', position: 'relative',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          minHeight: '36px',
        }}
      >
        {displayText}
        <span style={{
          position: 'absolute', right: '8px', top: '50%',
          transform: 'translateY(-50%)', pointerEvents: 'none',
        }}>▾</span>
      </button>

      {open && ReactDOM.createPortal(
        <div data-msd-drop={label} style={dropStyle}>
          {options.map(opt => {
            const value = typeof opt === 'string' ? opt : opt.value;
            const optLabel = typeof opt === 'string' ? opt : opt.label;
            const checked = selected.includes(value);
            return (
              <div
                key={value}
                onClick={() => toggle(value)}
                style={{
                  padding: '10px 12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '8px',
                  background: checked ? '#f1f8f5' : 'white',
                  borderBottom: '1px solid #f6f6f7',
                }}
              >
                <input type="checkbox" checked={checked} onChange={() => {}} style={{ cursor: 'pointer' }} />
                <span style={{ fontSize: '14px' }}>{optLabel}</span>
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

export default MultiSelectDropdown;