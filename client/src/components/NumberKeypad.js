import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── Setting ─────────────────────────────────────────────────────────────────
// 2026-11-12 (Hera): chosen per device in Store › Tasks (bottom left, under
// Employee Cap): "Use Hera Keypad for numeric input" (default) / "Use phone
// keyboard always", remembered on the device (localStorage
// 'hub_number_keypad' = 'keypad' | 'phone'). Was: one setting for all
// devices in Online › Settings (removed 2026-11-12, Hera).
const DEVICE_KEY = 'hub_number_keypad';
const keypadListeners = new Set();
const isTouch = () => typeof window !== 'undefined'
  && (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);
// true = Hera Keypad (the default when this device never chose).
export function getDeviceKeypad() {
  try { return localStorage.getItem(DEVICE_KEY) !== 'phone'; } catch (e) { return true; }
}
export function setDeviceKeypad(on) {
  try { localStorage.setItem(DEVICE_KEY, on ? 'keypad' : 'phone'); } catch (e) { /* storage blocked */ }
  keypadListeners.forEach(f => f(!!on));
}
// true → use the keypad for number boxes on this device.
export function useNumberKeypad() {
  const [on, setOn] = useState(getDeviceKeypad);
  useEffect(() => {
    keypadListeners.add(setOn);
    setOn(getDeviceKeypad());
    return () => { keypadListeners.delete(setOn); };
  }, []);
  return !!on && isTouch();
}

// ── Hub's own number keypad (2026-11-12, Hera — claude/NUMBER_KEYPAD.md) ────
// Version 2 (2026-11-12, Hera): the keypad is no longer built into each popup.
// ONE keypad (<NumberKeypadHost />, mounted once in App.js) works like a
// phone keyboard of our own:
//   • it rises from the bottom of the screen while a number box marked
//     data-hub-keypad has the focus, and goes away when the focus leaves;
//   • it pushes the popup up: the popup box (marked data-keypad-panel) is
//     placed in the space above the keypad and made no taller than that
//     space (its content scrolls if needed) — the keypad never covers it;
//   • OK = pressing Enter in the box, so the popup's own Enter handling
//     (Submit / Search / Save / Picked) runs. The popups keep their own
//     buttons too.
// A popup only marks its box and its box panel:
//   <input data-hub-keypad="neg"|"" data-keypad-ok="Picked"? data-keypad-empty-ok?
//          inputMode={keypad ? 'none' : 'numeric'} onKeyDown={Enter → submit} />
//   <div data-keypad-panel="center"|"top"> (the popup box)
// "center": a popup centred with top + translateY(-50%) (most Store popups).
// "top": a popup placed near the top inside a flex overlay (Online transfer
// prep item modal). "flex": a popup centred by a full-screen flex overlay
// (Stock Loss scan popup).
// The box stays a real <input> (inputMode="none" → no phone keyboard), so a
// barcode scanner, which types like a keyboard, still works. Text boxes
// (Note etc.) are not marked and keep the phone keyboard.
// Keypad mode is on when useNumberKeypad() is true (device choice + touch
// screen). Computers never see it.
//
// Layout: 1–9 in a 3 × 3 grid, last row: [− / ⌫] [0] [OK].
// The bottom-left key: when something is left of the cursor it deletes it (⌫);
// when nothing is (empty box, or cursor at the start) it adds a minus sign (−).
// Boxes without data-hub-keypad="neg" show ⌫ there always.

const KEY = {
  height: 46, borderRadius: 8, border: 'none', background: '#fff', color: '#303030',
  fontSize: 20, fontWeight: 500, cursor: 'pointer', touchAction: 'manipulation', userSelect: 'none',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, font: 'inherit',
  boxShadow: '0 1px 0 rgba(0,0,0,0.12)',
};

const BackspaceIcon = () => (
  <svg width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="#303030" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d="M7.5 1.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13L1.5 9z" /><path d="M11 6l6 6M17 6l-6 6" />
  </svg>
);

// caret = { start, end } inside value
export function applyKey(value, caret, key, allowNegative) {
  const v = String(value ?? '');
  const start = Math.max(0, Math.min(caret.start, v.length));
  const end = Math.max(start, Math.min(caret.end, v.length));
  if (key === 'minus') {
    if (end > start) return { value: v.slice(0, start) + v.slice(end), caret: start };              // delete selection
    if (start > 0) return { value: v.slice(0, start - 1) + v.slice(start), caret: start - 1 };      // backspace
    if (allowNegative && !v.startsWith('-')) return { value: `-${v}`, caret: 1 };                    // add minus
    return { value: v, caret: start };
  }
  // digit
  if (v === '0' || v === '-0') return { value: v.replace('0', '') + key, caret: v.length }; // a lone 0 is replaced
  if (start === 0 && end === 0 && v.startsWith('-')) return { value: v, caret: 0 }; // never before the minus
  return { value: v.slice(0, start) + key + v.slice(end), caret: start + 1 };
}

// Sets a React-controlled input's value the way typing does (its onChange runs).
function typeInto(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// Shopify's own bottom buttons on Android sit over the bottom 96 px of Hub
// (same as MobileModalSafeArea), so the keypad sits above them there.
const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');

// Pushes the marked popup box up into the space above the keypad. A <style>
// with !important wins over the popup's own inline position while
// <html data-hub-keypad-open> is set; --hub-kp-avail = the height above the
// keypad (px).
const PUSH_CSS = `
html[data-hub-keypad-open] [data-keypad-panel] {
  max-height: calc(var(--hub-kp-avail) - 16px) !important;
  overflow-y: auto !important;
}
html[data-hub-keypad-open] [data-keypad-panel="center"] {
  top: calc(var(--hub-kp-avail) / 2) !important;
  transform: translateY(-50%) !important;
}
html[data-hub-keypad-open] [data-keypad-panel="top"] {
  max-height: calc(var(--hub-kp-avail) - 4vh - 8px) !important;
}
html[data-hub-keypad-open] [data-keypad-panel="flex"] {
  position: relative !important;
  top: calc((var(--hub-kp-avail) - 100vh) / 2) !important;
}
`;

export default function NumberKeypadHost() {
  const keypad = useNumberKeypad();
  const [target, setTarget] = useState(null); // the focused marked <input>
  const [, force] = useState(0);              // re-render on typing (key labels / OK state)
  const boxRef = useRef(null);
  const hideTimer = useRef(null);

  // Follow the focus: a marked box gets focus → show; it loses focus → hide
  // (after a short delay, so moving between boxes doesn't flicker).
  useEffect(() => {
    if (!keypad) { setTarget(null); return undefined; }
    const isMarked = (el) => el && el.tagName === 'INPUT' && el.hasAttribute('data-hub-keypad') && !el.disabled;
    const onIn = (e) => {
      if (isMarked(e.target)) { clearTimeout(hideTimer.current); setTarget(e.target); }
    };
    const onOut = () => {
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        const a = document.activeElement;
        setTarget(isMarked(a) ? a : null);
      }, 120);
    };
    const onType = (e) => { if (isMarked(e.target)) force(n => n + 1); };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    document.addEventListener('input', onType, true);
    document.addEventListener('selectionchange', onType);
    if (isMarked(document.activeElement)) setTarget(document.activeElement);
    return () => {
      clearTimeout(hideTimer.current);
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
      document.removeEventListener('input', onType, true);
      document.removeEventListener('selectionchange', onType);
    };
  }, [keypad]);

  // The box went away with its popup (closed) → hide.
  useEffect(() => {
    if (!target) return undefined;
    const t = setInterval(() => { if (!target.isConnected) setTarget(null); }, 300);
    return () => clearInterval(t);
  }, [target]);

  // Push the popup up while shown.
  useEffect(() => {
    const root = document.documentElement;
    if (!target) { root.removeAttribute('data-hub-keypad-open'); root.style.removeProperty('--hub-kp-avail'); return undefined; }
    const place = () => {
      const box = boxRef.current;
      if (!box) return;
      const top = box.getBoundingClientRect().top;
      root.style.setProperty('--hub-kp-avail', `${Math.max(160, Math.round(top))}px`);
      root.setAttribute('data-hub-keypad-open', '');
      // keep the box being typed in visible inside the (now shorter) popup
      requestAnimationFrame(() => { try { target.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } });
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      root.removeAttribute('data-hub-keypad-open');
      root.style.removeProperty('--hub-kp-avail');
    };
  }, [target]);

  const press = useCallback((key) => {
    const el = target;
    if (!el) return;
    const len = el.value.length;
    const caret = el.selectionStart == null ? { start: len, end: len } : { start: el.selectionStart, end: el.selectionEnd };
    const r = applyKey(el.value, caret, key, el.getAttribute('data-hub-keypad') === 'neg');
    typeInto(el, r.value);
    requestAnimationFrame(() => { try { el.focus({ preventScroll: true }); el.setSelectionRange(r.caret, r.caret); } catch (e) { /* type=number has no caret */ } });
    force(n => n + 1);
  }, [target]);

  const ok = useCallback(() => {
    const el = target;
    if (!el) return;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }, [target]);

  if (!keypad || !target) return <style>{PUSH_CSS}</style>;

  const value = target.value || '';
  const neg = target.getAttribute('data-hub-keypad') === 'neg';
  const caretAt = target.selectionStart == null ? value.length : target.selectionStart;
  const showMinus = neg && caretAt === 0 && !value.startsWith('-');
  const okLabel = target.getAttribute('data-keypad-ok') || 'OK';
  const okDisabled = !value.trim() && !target.hasAttribute('data-keypad-empty-ok');
  const btn = (label, onClick, extra = {}, aria) => (
    <button type="button" aria-label={aria || String(label)} onClick={onClick} style={{ ...KEY, ...extra }}>{label}</button>
  );
  return (
    <>
      <style>{PUSH_CSS}</style>
      <div
        ref={boxRef}
        // never take the focus away from the number box
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: 'fixed', left: 0, right: 0, bottom: isAndroid() ? 96 : 0, zIndex: 3000,
          background: '#e3e3e3', padding: '8px 8px calc(8px + env(safe-area-inset-bottom, 0px))',
          boxShadow: '0 -2px 10px rgba(0,0,0,0.15)',
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, maxWidth: 480, margin: '0 auto' }}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => <React.Fragment key={d}>{btn(d, () => press(d))}</React.Fragment>)}
          {btn(showMinus ? '−' : <BackspaceIcon />, () => press('minus'), { fontSize: 28, fontWeight: 400 }, showMinus ? 'Minus' : 'Delete')}
          {btn('0', () => press('0'))}
          {btn(okLabel, () => { if (!okDisabled) ok(); }, {
            background: okDisabled ? '#d4d4d4' : '#303030', color: okDisabled ? '#8a8a8a' : '#fff', fontSize: 16, fontWeight: 650,
            cursor: okDisabled ? 'default' : 'pointer', boxShadow: 'none',
          })}
        </div>
      </div>
    </>
  );
}
