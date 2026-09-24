import { useEffect } from 'react';

// Keeps centered popups inside the part of the screen the user can actually
// see when the soft keyboard is open (2026-09-24, Hera — trial on
// ManagerTaskDetail first).
//
// While `active` is true it listens to window.visualViewport and writes two
// CSS variables on <html>:
//   --kb-center-y  vertical centre of the visible area (px)
//   --kb-avail-h   height a popup may use (px): visible height minus the
//                  margin — 176px when the keyboard is closed (same room as
//                  before for Shopify's bottom bar), 32px when it is open
//                  (the bottom bar is behind the keyboard then).
// Popups use them with the old values as fallbacks, e.g.
//   top:       'var(--kb-center-y, 50%)'
//   maxHeight: 'var(--kb-avail-h, calc(100vh - 176px))'
// so on a browser without visualViewport nothing changes.
//
// The keyboard is detected by comparing the visible height with the largest
// height seen while the popup is open (works whether the WebView shrinks the
// layout viewport — Android — or only pans the visual viewport — iOS).
// The DOM is written directly, not through React state, so typing does not
// re-render the page.

const CLOSED_MARGIN = 176;
const OPEN_MARGIN = 32;
const KEYBOARD_RATIO = 0.75; // visible height below 75% of baseline = keyboard open

function useKeyboardInset(active) {
  useEffect(() => {
    if (!active) return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const root = document.documentElement;
    let baseline = Math.max(vv.height, window.innerHeight);
    let frame = 0;

    const apply = () => {
      frame = 0;
      const h = vv.height;
      if (h > baseline) baseline = h;
      const keyboardOpen = h < baseline * KEYBOARD_RATIO;
      const margin = keyboardOpen ? OPEN_MARGIN : CLOSED_MARGIN;
      root.style.setProperty('--kb-center-y', `${Math.round(vv.offsetTop + h / 2)}px`);
      root.style.setProperty('--kb-avail-h', `${Math.max(120, Math.round(h - margin))}px`);
      if (keyboardOpen) {
        // Keep the focused input visible inside the (now shorter) popup.
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.scrollIntoView) {
          el.scrollIntoView({ block: 'nearest' });
        }
      }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(apply); };
    const onOrientation = () => { baseline = 0; schedule(); };

    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('orientationchange', onOrientation);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('orientationchange', onOrientation);
      root.style.removeProperty('--kb-center-y');
      root.style.removeProperty('--kb-avail-h');
    };
  }, [active]);
}

export default useKeyboardInset;
