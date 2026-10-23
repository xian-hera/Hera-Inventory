import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, BlockStack, InlineStack, Text, Banner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '../shared/transferStatus';
import { useLocationMap } from '../shared/locationMap';

// Shared bits for the Warehouse Scheduler + Receive Shipments pages
// (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md):
// location / PB pills, the read-only PO and Transfer popups, truncation,
// location sort order, the badge-refresh event and a small toast.

export const HQ = 'HQ';

// Tab badges (WarehouseShell) reload when a page fires this event.
export function refreshWarehouseBadges() {
  window.dispatchEvent(new Event('warehouse-badges-refresh'));
}

// Cut a text to n characters with "…" (custom task Type / Title on cards —
// 12 for now, Hera 2026-10-21, to be tuned once the UI is in use).
export const CARD_TEXT_MAX = 12;
export function truncate(text, n = CARD_TEXT_MAX) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Location colours (2026-10-22, Hera — Warehouse › Settings › Location
// Color): each location's pill gets the colour set there; a location with no
// colour is light grey (before: every pill was light purple #f1edff). Loaded
// once per app load and shared by every pill; Settings updates the cache on
// Save.
export const LOC_PILL_DEFAULT = '#e4e5e7';
let locColors = null;          // { name: '#RRGGBB' } once loaded
let locColorsPromise = null;
const locColorListeners = new Set();
export function loadLocationColors() {
  if (!locColorsPromise) {
    locColorsPromise = fetch('/api/warehouse/location-colors')
      .then(r => r.json())
      .then(d => { setLocationColorsCache((d && d.colors) || {}); return locColors; })
      .catch(() => { locColorsPromise = null; return {}; });
  }
  return locColorsPromise;
}
export function setLocationColorsCache(colors) {
  locColors = { ...(colors || {}) };
  locColorListeners.forEach(fn => fn(locColors));
}
export function useLocationColors() {
  const [colors, setColors] = useState(locColors || {});
  useEffect(() => {
    locColorListeners.add(setColors);
    if (locColors) setColors(locColors); else loadLocationColors();
    return () => { locColorListeners.delete(setColors); };
  }, []);
  return colors;
}
// Dark text on light colours, white text on dark ones.
export function pillTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#303030';
  const n = parseInt(m[1], 16);
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.35 ? '#303030' : '#ffffff';
}

// Location pill (task-card style), in the location's colour.
export function LocPill({ name }) {
  const colors = useLocationColors();
  const bg = colors[name] || LOC_PILL_DEFAULT;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: bg,
      color: pillTextColor(bg), fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap', lineHeight: '18px',
    }}>{name}</span>
  );
}

const ARROW = <span aria-hidden="true" style={{ fontWeight: 700, fontSize: 13, lineHeight: '18px' }}>➔</span>;

// Location part of a card, by direction (HQ is never shown):
//   HQ → X   : ➔ [X]
//   X → HQ   : [X] ➔
//   X → Y    : [X] ➔ [Y]
//   HQ → HQ  : ➔ [HQ]   (a PO whose to location is HQ — before 2026-10-21 this
//                        showed only the arrow, i.e. an "empty" location)
export function RoutePills({ from, to }) {
  const fromHQ = !from || from === HQ;
  const toHQ = to === HQ;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', minWidth: 0 }}>
      {!fromHQ && <LocPill name={from} />}
      {ARROW}
      {(!toHQ || fromHQ) && to && <LocPill name={to} />}
    </span>
  );
}

// Icons from Hera's artwork (2026-10-23) — traced from her image, not
// redrawn (traced paths match the original pixels ≥ 99%).
//   PICKUP_TRUCK : curved arrow + truck (pickup cards on the Schedule)
//   TRUCK_ONLY   : the truck alone (Delivery › the stop the truck is at)
//   ENTER_DISC / ENTER_GLYPH : round "arrow into door" sign; the disc path has
//     the arrow / door cut out, the glyph path is the arrow / door itself.
const PICKUP_TRUCK = { w: 938, h: 394, d: 'M0.3 329.2C0.6 267.7 0.8 264.1 2.7 256.0C16.8 198.6 58.4 157.8 115.0 145.8C123.1 144.1 129.5 143.7 158.9 143.3L193.3 142.8 L167.6 117.1C153.5 103.0 142.0 91.0 142.0 90.5C142.0 89.9 151.9 79.6 164.0 67.5L186.0 45.5 L250.5 110.0L315.0 174.5 L250.5 239.0L186.0 303.5 L163.8 281.2L141.5 259.0 L167.3 233.2C181.4 219.1 193.0 207.1 193.0 206.6C193.0 206.1 179.3 206.0 162.2 206.3C135.0 206.7 130.6 207.0 123.5 208.9C95.4 216.4 74.4 236.9 65.9 265.0C63.6 272.4 63.6 273.4 63.2 333.2L62.9 394.0 L31.4 394.0L-0.1 394.0 L0.3 329.2ZM455.6 392.5C440.7 388.4 426.2 376.4 419.6 362.8C416.3 356.0 415.2 352.1 413.5 340.8L412.9 337.0 L382.6 337.0C353.4 337.0 352.2 336.9 349.6 334.9C343.6 330.2 344.0 341.5 344.0 169.0C344.0 -5.0 343.6 6.1 350.2 2.0C353.5 0.0 354.4 -0.0 532.7 0.2L712.0 0.5 L715.2 3.8L718.5 7.0 L719.0 37.8L719.5 68.5 L771.0 69.0L822.5 69.5 L827.0 71.9C829.5 73.2 832.8 75.4 834.5 76.8C839.4 80.9 932.8 196.0 935.2 200.9L937.5 205.5 L937.8 266.8C938.0 320.3 937.9 328.4 936.5 331.0C933.6 336.5 931.3 337.0 907.7 337.0L886.3 337.0 L885.2 345.2C882.0 367.4 864.7 386.9 843.4 392.4C835.7 394.4 821.3 394.4 814.0 392.5C798.9 388.5 784.4 376.7 777.7 363.0C774.3 356.2 773.3 352.5 771.5 340.8L770.9 337.0 L649.7 337.0L528.4 337.0 L527.2 345.2C524.0 367.3 506.6 387.0 485.5 392.5C478.3 394.3 462.4 394.3 455.6 392.5ZM874.1 182.1C878.4 176.8 877.9 175.9 849.4 141.0C834.8 123.1 821.4 107.0 819.7 105.2C813.3 98.5 813.5 98.5 781.8 98.5C754.1 98.5 753.0 98.6 751.0 100.6C749.0 102.6 749.0 103.6 749.0 141.4C749.0 182.2 748.9 182.2 753.5 184.1C754.6 184.5 781.8 184.8 813.8 184.7L872.2 184.5 L874.1 182.1Z' };
const TRUCK_ONLY = { w: 594, h: 394, d: 'M111.6 392.5C96.7 388.4 82.2 376.4 75.6 362.8C72.3 356.0 71.2 352.1 69.5 340.8L68.9 337.0 L38.6 337.0C9.4 337.0 8.2 336.9 5.6 334.9C-0.4 330.2 -0.0 341.5 -0.0 169.0C-0.0 -5.0 -0.4 6.1 6.2 2.0C9.5 0.0 10.4 -0.0 188.7 0.2L368.0 0.5 L371.2 3.8L374.5 7.0 L375.0 37.8L375.5 68.5 L427.0 69.0L478.5 69.5 L483.0 71.9C485.5 73.2 488.8 75.4 490.5 76.8C495.4 80.9 588.8 196.0 591.2 200.9L593.5 205.5 L593.8 266.8C594.0 320.3 593.9 328.4 592.5 331.0C589.6 336.5 587.3 337.0 563.7 337.0L542.3 337.0 L541.2 345.2C538.0 367.4 520.7 386.9 499.4 392.4C491.7 394.4 477.3 394.4 470.0 392.5C454.9 388.5 440.4 376.7 433.7 363.0C430.3 356.2 429.3 352.5 427.5 340.8L426.9 337.0 L305.7 337.0L184.4 337.0 L183.2 345.2C180.0 367.3 162.6 387.0 141.5 392.5C134.3 394.3 118.4 394.3 111.6 392.5ZM530.1 182.1C534.4 176.8 533.9 175.9 505.4 141.0C490.8 123.1 477.4 107.0 475.7 105.2C469.3 98.5 469.5 98.5 437.8 98.5C410.1 98.5 409.0 98.6 407.0 100.6C405.0 102.6 405.0 103.6 405.0 141.4C405.0 182.2 404.9 182.2 409.5 184.1C410.6 184.5 437.8 184.8 469.8 184.7L528.2 184.5 L530.1 182.1Z' };
const ENTER_SIZE = 290;
const ENTER_DISC = 'M129.5 289.4C92.4 283.8 67.5 271.6 42.9 247.0C14.8 219.0 0.7 184.9 0.7 145.0C0.7 123.9 3.9 107.5 11.8 89.0C30.7 44.4 68.8 13.2 117.0 2.9C131.0 -0.1 157.9 -0.4 171.5 2.4C201.2 8.3 227.1 21.9 247.5 42.5C268.1 63.2 281.4 87.6 287.6 116.0C290.3 128.2 290.3 161.8 287.6 174.0C281.4 202.6 268.0 227.1 247.5 247.5C227.2 267.9 203.1 281.1 175.5 287.0C165.8 289.1 137.2 290.5 129.5 289.4ZM205.2 250.2C216.1 245.8 224.8 237.1 229.2 226.2L231.5 220.5 L231.5 145.0L231.5 69.5 L229.3 64.0C224.5 52.4 214.8 43.2 203.3 39.4C198.1 37.7 194.3 37.5 166.5 37.5L135.5 37.5 L135.2 52.7L134.9 67.9 L165.1 68.2L195.2 68.5 L198.1 71.8L201.0 75.0 L201.0 145.1L201.0 215.2 L197.6 218.6L194.2 222.0 L164.6 222.0L135.0 222.0 L135.0 237.6L135.0 253.1 L167.2 252.8C198.0 252.5 199.8 252.4 205.2 250.2ZM137.8 112.3C118.4 92.9 102.1 77.0 101.5 77.0C100.9 77.0 95.8 81.7 90.0 87.5L79.5 98.0 L96.5 115.0L113.5 132.0 L69.7 132.0L26.0 132.0 L26.0 147.5L26.0 163.0 L69.5 163.0C93.4 163.0 113.0 163.3 113.0 163.8C113.0 164.2 105.6 171.9 96.5 181.0L80.0 197.5 L90.7 208.2L101.5 219.0 L137.2 183.3L173.0 147.5 L137.8 112.3Z';
const ENTER_GLYPH = 'M135.0 237.6L135.0 222.0 L164.6 222.0L194.2 222.0 L197.6 218.6L201.0 215.2 L201.0 145.1L201.0 75.0 L198.1 71.8L195.2 68.5 L165.1 68.2L134.9 67.9 L135.2 52.7L135.5 37.5 L166.5 37.5C194.3 37.5 198.1 37.7 203.3 39.4C214.8 43.2 224.5 52.4 229.3 64.0L231.5 69.5 L231.5 145.0L231.5 220.5 L229.2 226.2C224.8 237.1 216.1 245.8 205.2 250.2C199.8 252.4 198.0 252.5 167.2 252.8L135.0 253.1 L135.0 237.6ZM90.7 208.2L80.0 197.5 L96.5 181.0C105.6 171.9 113.0 164.2 113.0 163.8C113.0 163.3 93.4 163.0 69.5 163.0L26.0 163.0 L26.0 147.5L26.0 132.0 L69.7 132.0L113.5 132.0 L96.5 115.0L79.5 98.0 L90.0 87.5C95.8 81.7 100.9 77.0 101.5 77.0C102.1 77.0 118.4 92.9 137.8 112.3L173.0 147.5 L137.2 183.3L101.5 219.0 L90.7 208.2Z';

function TracedIcon({ icon, height, color, label }) {
  return (
    <svg width={Math.round(height * icon.w / icon.h)} height={height} viewBox={`0 0 ${icon.w} ${icon.h}`} role="img" aria-label={label} style={{ flex: 'none', display: 'block' }}>
      <path fill={color} fillRule="evenodd" d={icon.d} />
    </svg>
  );
}

// Truck icon. arrow 'in' = curved arrow + truck (pickup); 'none' = truck only.
// (Replaces Claude's hand-drawn truck of earlier today; its 'out' variant is
// no longer used — the Delivery buttons now show text + EnterIcon.)
export function TruckIcon({ height = 18, color = '#231f20', arrow = 'in', label }) {
  return <TracedIcon icon={arrow === 'none' ? TRUCK_ONLY : PICKUP_TRUCK} height={height} color={color} label={label || (arrow === 'none' ? 'Truck' : 'Pickup')} />;
}

// Pickup mark on Schedule cards: curved arrow + truck right of the location.
export function PickupTruck({ height = 18 }) {
  return <TruckIcon height={height} arrow="in" label="Pickup" />;
}

// Round "arrow into door" sign. disc = circle colour, glyph = arrow / door
// colour; glyph omitted → arrow / door are see-through (show what is behind).
export function EnterIcon({ size = 20, disc = '#ffffff', glyph, label }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${ENTER_SIZE} ${ENTER_SIZE}`} role="img" aria-label={label || 'Pickup'} style={{ flex: 'none', display: 'block' }}>
      <path fill={disc} fillRule="evenodd" d={ENTER_DISC} />
      {glyph && <path fill={glyph} fillRule="evenodd" d={ENTER_GLYPH} />}
    </svg>
  );
}

// Round "arrow out of door" sign (Delivery › Delivered button), traced from
// Hera's artwork 2026-10-23 like EnterIcon above.
const EXIT_W = 659;
const EXIT_H = 658;
const EXIT_DISC = 'M298.0 656.9C223.2 650.0 151.0 615.8 97.1 561.9C42.7 507.6 9.9 438.3 1.9 361.0C0.4 346.2 0.4 311.8 1.9 297.0C8.5 233.5 31.6 175.7 70.1 126.5C124.4 57.1 202.7 12.9 291.0 1.8C307.1 -0.2 356.2 0.1 372.0 2.3C409.0 7.5 439.7 16.6 471.7 32.0C490.6 41.1 514.3 55.2 525.4 64.1C544.8 79.5 551.6 85.5 562.1 95.9C616.0 149.8 648.1 216.4 657.2 293.5C658.9 307.8 658.9 350.2 657.2 364.5C648.1 441.6 616.0 508.2 562.1 562.1C515.3 608.8 455.0 640.7 391.3 652.5C363.6 657.6 325.7 659.4 298.0 656.9ZM347.0 539.0L347.0 504.0 L283.7 504.0C215.2 504.0 213.7 503.9 206.7 498.6C204.7 497.1 202.0 493.5 200.5 490.7L198.0 485.6 L198.0 328.9L198.0 172.2 L200.8 167.0C204.2 160.5 209.8 156.4 216.9 155.0C220.2 154.4 246.7 154.0 284.6 154.0L347.0 154.0 L347.0 119.0L347.0 83.9 L276.2 84.2C206.6 84.6 205.4 84.6 197.5 86.8C180.5 91.5 165.7 100.4 153.4 113.1C141.7 125.2 133.9 139.2 129.7 155.7L127.5 164.5 L127.5 329.0L127.5 493.5 L129.7 502.3C133.9 518.8 141.7 532.8 153.4 544.9C167.6 559.6 183.8 568.5 203.6 572.4C209.0 573.5 225.4 573.8 278.8 573.9L347.0 574.0 L347.0 539.0ZM514.8 403.7L596.0 322.5 L514.7 241.2L433.5 160.0 L408.5 185.0L383.5 210.0 L422.0 248.5L460.5 287.0 L360.7 287.0L261.0 287.0 L261.0 322.5L261.0 358.0 L360.7 358.0L460.5 358.0 L422.2 396.3C401.2 417.3 384.0 435.0 384.0 435.5C384.0 436.5 432.0 485.0 433.0 485.0C433.3 485.0 470.1 448.4 514.8 403.7Z';
const EXIT_GLYPH = 'M203.6 572.4C183.8 568.5 167.6 559.6 153.4 544.9C141.7 532.8 133.9 518.8 129.7 502.3L127.5 493.5 L127.5 329.0L127.5 164.5 L129.7 155.7C133.9 139.2 141.7 125.2 153.4 113.1C165.7 100.4 180.5 91.5 197.5 86.8C205.4 84.6 206.6 84.6 276.2 84.2L347.0 83.9 L347.0 119.0L347.0 154.0 L284.6 154.0C246.7 154.0 220.2 154.4 216.9 155.0C209.8 156.4 204.2 160.5 200.8 167.0L198.0 172.2 L198.0 328.9L198.0 485.6 L200.5 490.7C202.0 493.5 204.7 497.1 206.7 498.6C213.7 503.9 215.2 504.0 283.7 504.0L347.0 504.0 L347.0 539.0L347.0 574.0 L278.8 573.9C225.4 573.8 209.0 573.5 203.6 572.4ZM408.2 460.7C394.9 447.4 384.0 436.0 384.0 435.5C384.0 435.0 401.2 417.3 422.2 396.3L460.5 358.0 L360.7 358.0L261.0 358.0 L261.0 322.5L261.0 287.0 L360.7 287.0L460.5 287.0 L422.0 248.5L383.5 210.0 L408.5 185.0L433.5 160.0 L514.7 241.2L596.0 322.5 L514.8 403.7C470.1 448.4 433.3 485.0 433.0 485.0C432.7 485.0 421.6 474.1 408.2 460.7Z';
export function ExitIcon({ size = 20, disc = '#ffffff', glyph, label }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${EXIT_W} ${EXIT_H}`} role="img" aria-label={label || 'Delivered'} style={{ flex: 'none', display: 'block' }}>
      <path fill={disc} fillRule="evenodd" d={EXIT_DISC} />
      {glyph && <path fill={glyph} fillRule="evenodd" d={EXIT_GLYPH} />}
    </svg>
  );
}

// Pink PB pill on PO cards: "P 4" / "B 12". Nothing when there is no PB qty.
export function PbPill({ count, unit }) {
  if (!count || !unit) return null;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: '#fde0df',
      color: '#5c1414', fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap', lineHeight: '18px',
    }}>{unit} {count}</span>
  );
}

// Location sort order = the order of the shared location map (canonical:
// HQ → MTL → OTT → QC → CAL → EDM → other, numeric within a prefix; defined
// in server/routes/shopify.js compareLocationNames; editable in Purchasing →
// Settings → Locations since 2026-10-22).
// Unknown names go last, alphabetically.
export function useLocationOrder() {
  const { names } = useLocationMap();
  return useMemo(() => {
    const idx = new Map(names.map((n, i) => [n, i]));
    return (a, b) => {
      const ia = idx.has(a) ? idx.get(a) : Number.MAX_SAFE_INTEGER;
      const ib = idx.has(b) ? idx.get(b) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return String(a || '').localeCompare(String(b || ''));
    };
  }, [names]);
}

// True on phone-width screens (≤ 767px, same breakpoint as Home.js).
const PHONE_QUERY = '(max-width: 767px)';
export function useIsPhone() {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_QUERY).matches : false);
  const [phone, setPhone] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on); };
  }, []);
  return phone;
}

// Small bottom toast (the Hub has no Polaris Frame, so no Polaris Toast).
// Each call gets its own id, so the same text twice in a row still shows for
// the full time.
let toastSeq = 0;
export function useToast() {
  const [toast, setToast] = useState(null); // { text, id }
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  const msg = toast ? toast.text : '';
  const show = useCallback((text) => setToast(text ? { text, id: ++toastSeq } : null), []);
  const node = msg ? (
    <div role="status" style={{
      position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 600,
      background: '#303030', color: '#fff', padding: '10px 16px', borderRadius: 10,
      boxShadow: '0 8px 24px rgba(0,0,0,0.2)', fontWeight: 550, fontSize: 13, maxWidth: 'calc(100vw - 32px)',
    }}>{msg}</div>
  ) : null;
  return [node, show];
}

// Unsaved Schedule draft guard (2026-10-21): the Schedule page reports
// whether it has unsaved changes; the tab bar, Settings button, back arrow
// and "Jump to Transfer" ask before leaving it.
let scheduleDirty = false;
export function setScheduleDirty(v) { scheduleDirty = !!v; }
export function confirmLeaveSchedule() {
  if (!scheduleDirty) return true;
  const ok = window.confirm('The Schedule has unsaved changes. Leave without saving?');
  if (ok) scheduleDirty = false;
  return ok;
}

// Blue underlined text button (PO / transfer numbers).
export function LinkText({ children, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick && onClick(); }}
      style={{
        border: 'none', background: 'none', padding: 0, margin: 0, cursor: 'pointer', font: 'inherit',
        color: '#005bd3', textDecoration: 'underline', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  );
}

const TH = { padding: '6px 8px', textAlign: 'left', color: '#6d7175', fontWeight: 550, fontSize: 12, borderBottom: '1px solid #e1e3e5' };
const TD = { padding: '6px 8px', fontSize: 13, borderBottom: '1px solid #f1f1f1', verticalAlign: 'top' };

function ItemsTable({ rows }) {
  if (rows.length === 0) return <Text tone="subdued">No line items.</Text>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={TH}>SKU</th><th style={TH}>Name</th><th style={{ ...TH, textAlign: 'right' }}>Qty</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td style={{ ...TD, whiteSpace: 'nowrap' }}>{r.sku || '—'}</td>
              <td style={TD}>{r.name || ''}</td>
              <td style={{ ...TD, textAlign: 'right' }}>{r.quantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Read-only PO content (header + line items), like the PO Export PDF.
export function PoDetailContent({ invoiceId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setData(null); setError('');
    fetch(`/api/warehouse/po/${invoiceId}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to load PO'); return d; })
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [invoiceId]);
  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return <Text tone="subdued">Loading...</Text>;
  const inv = data.invoice;
  return (
    <BlockStack gap="300">
      <InlineStack gap="200" blockAlign="center" wrap>
        <Text variant="headingMd" as="h3">{inv.supplier_name}</Text>
        <RoutePills from={HQ} to={inv.location} />
      </InlineStack>
      <ItemsTable rows={data.items} />
    </BlockStack>
  );
}

// PO popup (click a PO number) — read-only.
export function PoPopup({ invoiceId, number, onClose }) {
  return (
    <Modal open={!!invoiceId} onClose={onClose} title={number || 'PO'}>
      <Modal.Section>
        {invoiceId ? <PoDetailContent invoiceId={invoiceId} /> : null}
      </Modal.Section>
    </Modal>
  );
}

// Transfer popup (click a transfer number) — read-only, shows the status.
// From HQ → extra "Jump to Transfer" button to the Warehouse detail page.
export function TransferPopup({ transferId, onClose, returnTo = '/warehouse' }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!transferId) return undefined;
    let cancelled = false;
    setData(null); setError('');
    fetch(`/api/transfers/${transferId}?role=warehouse`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to load transfer'); return d; })
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [transferId]);
  const tr = data && data.transfer;
  const items = data && Array.isArray(data.items) ? data.items.filter(i => i.edit_state !== 'removed') : [];
  const fromHQ = tr && tr.from_location === HQ;
  return (
    <Modal
      open={!!transferId}
      onClose={onClose}
      title={tr ? (tr.shopify_transfer_name || tr.transfer_no) : 'Transfer'}
      secondaryActions={fromHQ ? [{
        content: 'Jump to Transfer',
        onAction: () => { if (confirmLeaveSchedule()) navigate(`/warehouse/transfer/${transferId}`, { state: { from: returnTo } }); },
      }] : undefined}
    >
      <Modal.Section>
        {error ? <Banner tone="critical">{error}</Banner> : !tr ? <Text tone="subdued">Loading...</Text> : (
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center" wrap>
              <StatusBadge status={tr.status} />
              <Text as="span">From <b>{tr.from_location}</b> to <b>{tr.to_location}</b></Text>
            </InlineStack>
            <ItemsTable rows={items} />
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );
}

// Big one-of-many filter buttons (iPad): "All" + one per value. Exactly one
// is always selected.
export function FilterButtons({ values, value, onChange, allLabel = 'All' }) {
  const opts = [{ v: '__all__', label: allLabel }, ...values.map(v => ({ v, label: v }))];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {opts.map(o => {
        const on = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.v)}
            style={{
              font: 'inherit', fontSize: 15, fontWeight: on ? 650 : 500, padding: '10px 18px', minHeight: 44,
              borderRadius: 10, cursor: 'pointer', border: `1px solid ${on ? '#303030' : '#c9cccf'}`,
              background: on ? '#303030' : '#fff', color: on ? '#fff' : '#303030',
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}
export const FILTER_ALL = '__all__';
