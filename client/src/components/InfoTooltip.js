import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';

const POPOVER_WIDTH = 320;
const VIEWPORT_MARGIN = 16;

// A small click-to-toggle "ⓘ" info tooltip. Matches the PO Receiving mockups:
// clicking the label or the ⓘ opens a white popover with the given text;
// clicking anywhere else dismisses it. No hover behavior, on purpose.
//
// The popover is rendered via a portal into document.body with fixed
// positioning (computed from the trigger's getBoundingClientRect), the same
// pattern used by MultiSelectDropdown and the supplier autocomplete — this
// keeps it from being clipped by an ancestor Card, and clamps it horizontally
// so it never runs off the right edge of the viewport.
let idCounter = 0;

function InfoTooltip({ text, children }) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState({});
  const triggerRef = useRef(null);
  const popoverIdRef = useRef(null);
  if (!popoverIdRef.current) {
    idCounter += 1;
    popoverIdRef.current = `info-tooltip-popover-${idCounter}`;
  }

  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN);
      setPopoverStyle({
        position: 'fixed',
        top: rect.bottom + 6,
        left: Math.max(VIEWPORT_MARGIN, left),
        zIndex: 99999,
        background: 'white',
        border: '1px solid #e1e3e5',
        borderRadius: '8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        padding: '12px 14px',
        width: `${POPOVER_WIDTH}px`,
        fontSize: '13px',
        color: '#202223',
        whiteSpace: 'pre-line',
      });
    }
    setOpen(prev => !prev);
  };

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      const trigger = triggerRef.current;
      const popover = document.getElementById(popoverIdRef.current);
      if (trigger && !trigger.contains(e.target) && popover && !popover.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <span ref={triggerRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ cursor: 'pointer' }} onClick={toggle}>
        {children}
      </span>
      <span
        onClick={toggle}
        style={{
          cursor: 'pointer', fontSize: '13px', color: '#6d7175', borderRadius: '50%',
          border: '1px solid #6d7175', width: '15px', height: '15px', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', lineHeight: 1,
        }}
        title=""
      >
        i
      </span>
      {open && ReactDOM.createPortal(
        <div id={popoverIdRef.current} style={popoverStyle}>
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

export default InfoTooltip;
