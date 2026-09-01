import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import ReactDOM from 'react-dom';

const MAX_WIDTH_RATIO = 0.8; // never wider than 80% of the viewport, per Hera's spec
const VIEWPORT_MARGIN = 16;

// A small click-to-toggle "ⓘ" info tooltip. Matches the PO Receiving mockups:
// clicking the label or the ⓘ opens a white popover with the given text;
// clicking anywhere else dismisses it. No hover behavior, on purpose.
//
// The popover is rendered via a portal into document.body with fixed
// positioning (computed from the trigger's getBoundingClientRect), the same
// pattern used by MultiSelectDropdown and the supplier autocomplete — this
// keeps it from being clipped by an ancestor Card.
//
// Width is "shrink to fit the text" (width: max-content) rather than always
// stretching to some fraction of the screen — short tooltips stay short.
// A max-width cap (80% of viewport) is the only thing that forces a line to
// wrap, for the rare very-long single line. Because the box's real width
// isn't known until it has actually rendered, positioning happens in two
// passes: first render off-screen (visibility: hidden) to measure it, then
// re-render at its final, viewport-clamped position.
let idCounter = 0;

function InfoTooltip({ text, children }) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState({});
  const [measured, setMeasured] = useState(false);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const anchorRef = useRef(null); // trigger's rect at the moment it was opened
  const popoverIdRef = useRef(null);
  if (!popoverIdRef.current) {
    idCounter += 1;
    popoverIdRef.current = `info-tooltip-popover-${idCounter}`;
  }

  const toggle = () => {
    if (!open && triggerRef.current) {
      anchorRef.current = triggerRef.current.getBoundingClientRect();
      setMeasured(false);
      // Pass 1: render off-screen (but still laid out, so it takes its
      // natural shrink-to-fit width) purely to measure it.
      setPopoverStyle({
        position: 'fixed',
        top: anchorRef.current.bottom + 6,
        left: 0,
        visibility: 'hidden',
        zIndex: 99999,
        background: 'white',
        border: '1px solid #e1e3e5',
        borderRadius: '8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        padding: '12px 14px',
        width: 'max-content',
        maxWidth: `${window.innerWidth * MAX_WIDTH_RATIO}px`,
        fontSize: '13px',
        color: '#202223',
        whiteSpace: 'pre-line',
      });
    }
    setOpen(prev => !prev);
  };

  useLayoutEffect(() => {
    if (!open || measured || !popoverRef.current || !anchorRef.current) return;
    // Pass 2: now that it's rendered, we know its real width — clamp its
    // left edge so it never runs off the right (or left) edge of the screen.
    const width = popoverRef.current.getBoundingClientRect().width;
    const rect = anchorRef.current;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN));
    setPopoverStyle(prev => ({ ...prev, visibility: 'visible', left }));
    setMeasured(true);
  }, [open, measured]);

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
    // alignItems: 'baseline' (not 'center') plus a small relative nudge on
    // the icon itself is what actually tucks the "i" circle up against the
    // last character of the label instead of floating at the row's vertical
    // center — visually reads as part of the text, like a trailing glyph,
    // rather than a separate element off to the side.
    <span ref={triggerRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'baseline', gap: '3px' }}>
      <span style={{ cursor: 'pointer' }} onClick={toggle}>
        {children}
      </span>
      <span
        onClick={toggle}
        style={{
          cursor: 'pointer', fontSize: '10px', color: '#6d7175', borderRadius: '50%',
          border: '1px solid #6d7175', width: '13px', height: '13px', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', lineHeight: 1,
          position: 'relative', top: '1px', flexShrink: 0,
        }}
        title=""
      >
        i
      </span>
      {open && ReactDOM.createPortal(
        <div id={popoverIdRef.current} ref={popoverRef} style={popoverStyle}>
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

export default InfoTooltip;
