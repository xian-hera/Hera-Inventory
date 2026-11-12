import React, { useState, useEffect, useCallback } from 'react';

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

// Popup size in keypad mode: centred in the area above Shopify's Android
// bottom buttons (96 px, same as MobileModalSafeArea) and as tall as that
// area allows — no phone keyboard needs room.
export const KEYPAD_POPUP = {
  top: 'calc((100vh - 96px) / 2)',
  transform: 'translateY(-50%)',
  maxHeight: 'calc(100vh - 112px)',
};

// Hub's own number keypad (2026-11-12, Hera).
// Used instead of the phone's keyboard for number-only boxes in Store popups
// when this device chose "Use Hera Keypad for numeric input" (Store › Tasks)
// and the device has a touch screen (computers keep typing as before) — see
// useNumberKeypad() below.
// Boxes using it (Hera's list 2026-11-12): count + Type in SKU in Weekly
// Inventory Count (task detail) and Manual Inventory Count; Stock Loss qty +
// Type in SKU; PO count; Transfer receiving count; Online transfer prep Qty;
// Restock Plan qty + Type in SKU. In keypad mode a popup's own Submit /
// Search button is replaced by OK, and the popup may use the full height
// (no phone keyboard to leave room for) — KEYPAD_POPUP below.
// The box stays a real <input> (inputMode="none" → no phone keyboard), so a
// barcode scanner, which types like a keyboard, still works.
//
// Layout: 1–9 in a 3 × 3 grid, last row: [− / ⌫] [0] [OK].
// The bottom-left key: when something is left of the cursor it deletes it (⌫);
// when nothing is (empty box, or cursor at the start) it adds a minus sign (−).
// Boxes that can't be negative (allowNegative = false) show ⌫ there always.

const KEY = {
  height: 46, borderRadius: 8, border: 'none', background: '#f1f1f1', color: '#303030',
  fontSize: 20, fontWeight: 500, cursor: 'pointer', touchAction: 'manipulation', userSelect: 'none',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, font: 'inherit',
};

const BackspaceIcon = () => (
  <svg width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="#303030" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d="M7.5 1.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13L1.5 9z" /><path d="M11 6l6 6M17 6l-6 6" />
  </svg>
);

// Docked at the bottom of the popup (2026-11-12, Hera): the keypad is always
// the last thing in a popup and sticks to the popup's bottom edge, so it stays
// in view when the popup content is taller than the screen and scrolls.
// `pad` = the popup's own padding (the dock covers it, edge to edge). The
// keypad (or the wrapper given this style) must be the popup content's last
// element and must not sit inside a smaller wrapper of its own.
export function keypadDock(pad = 20) {
  return {
    position: 'sticky', bottom: -pad, zIndex: 2, background: '#fff',
    margin: `0 -${pad}px -${pad}px`, padding: `10px ${pad}px ${pad}px`,
  };
}

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

// dock = popup padding (number) → docked at the popup's bottom (keypadDock);
// false → not docked (the caller docks a wrapper instead).
export default function NumberKeypad({ inputRef, value, onChange, onOk, okDisabled = false, allowNegative = true, okLabel = 'OK', dock = 20 }) {
  const [caretAt, setCaretAt] = useState(String(value ?? '').length);
  // Shown only while its number box is active (2026-11-12, Hera). Tapping a
  // key never takes the focus away from the box (onMouseDown preventDefault),
  // so the keypad stays while typing; tapping anything else hides it. The
  // short delay on hide avoids a flicker when the focus just moves around.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = inputRef && inputRef.current;
    if (!el) return undefined;
    let t = null;
    const onFocus = () => { clearTimeout(t); setShown(true); };
    const onBlur = () => { clearTimeout(t); t = setTimeout(() => setShown(document.activeElement === el), 120); };
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    setShown(document.activeElement === el);
    return () => { clearTimeout(t); el.removeEventListener('focus', onFocus); el.removeEventListener('blur', onBlur); };
  }, [inputRef]);
  const readCaret = useCallback(() => {
    const el = inputRef && inputRef.current;
    const len = String(value ?? '').length;
    if (!el || el.selectionStart == null) return { start: len, end: len };
    return { start: el.selectionStart, end: el.selectionEnd };
  }, [inputRef, value]);

  // follow the cursor in the box (tap inside the number to move it)
  useEffect(() => {
    const el = inputRef && inputRef.current;
    if (!el) return undefined;
    const upd = () => setCaretAt(el.selectionStart == null ? String(el.value).length : el.selectionStart);
    ['click', 'keyup', 'select', 'focus', 'input'].forEach(e => el.addEventListener(e, upd));
    document.addEventListener('selectionchange', upd);
    return () => { ['click', 'keyup', 'select', 'focus', 'input'].forEach(e => el.removeEventListener(e, upd)); document.removeEventListener('selectionchange', upd); };
  }, [inputRef]);

  const press = (key) => {
    const r = applyKey(value, readCaret(), key, allowNegative);
    onChange(r.value);
    setCaretAt(r.caret);
    const el = inputRef && inputRef.current;
    if (el) requestAnimationFrame(() => { try { el.focus({ preventScroll: true }); el.setSelectionRange(r.caret, r.caret); } catch (e) { /* ignore */ } });
  };

  const showMinus = allowNegative && caretAt === 0 && !String(value ?? '').startsWith('-');
  const btn = (label, onClick, extra = {}, aria) => (
    <button type="button" aria-label={aria || String(label)} onMouseDown={(e) => e.preventDefault()} onClick={onClick} style={{ ...KEY, ...extra }}>{label}</button>
  );
  const grid = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => btn(d, () => press(d)))}
      {btn(showMinus ? '−' : <BackspaceIcon />, () => press('minus'), { fontSize: 28, fontWeight: 400 }, showMinus ? 'Minus' : 'Delete')}
      {btn('0', () => press('0'))}
      {btn(okLabel, () => { if (!okDisabled) onOk(); }, {
        background: okDisabled ? '#e3e3e3' : '#303030', color: okDisabled ? '#8a8a8a' : '#fff', fontSize: 16, fontWeight: 650,
        cursor: okDisabled ? 'default' : 'pointer',
      })}
    </div>
  );
  if (!shown) return null;
  return dock === false ? grid : <div style={keypadDock(dock)}>{grid}</div>;
}
