import React, { useEffect, useState } from 'react';

// DD (delivery date) pills on Purchasing (BY) and Store (MA) pages
// (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §7). Data comes live
// from the Warehouse Schedule (POST /api/warehouse/dd, saved schedule only).
//
// Two forms:
//   full (MA) — PB pill "2 P" + DD pill "TUE. AM. 4th. OCT 02"
//               (unscheduled: "TBD"; no PB qty → no PB pill; transfers have
//               no PB). 4th = this store's place among the different stores
//               on that half-day's schedule.
//   mini (BY) — "OCT 02" (unscheduled: "TBD").
// Date in the past → both pills grey (today is not past).
// A split PO / a store → store transfer has one entry per Schedule card.
//
// Also here: Purchasing's grey PB pill (BY value, WH correction shown as
// strike-through + new value) — a different thing from the DD.

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const DD_BG = '#d6f6f5';
const DD_BG_PAST = '#cccccc';

function parseDay(day) {
  const [y, m, d] = String(day || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 12));
}

// 'OCT 02'
export function ddDateText(day) {
  const dt = parseDay(day);
  return dt ? `${MONTHS[dt.getUTCMonth()]} ${String(dt.getUTCDate()).padStart(2, '0')}` : '';
}

// 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st …
export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
}

const pillStyle = (past) => ({
  display: 'inline-block', padding: '1px 10px', borderRadius: 999, background: past ? DD_BG_PAST : DD_BG,
  color: '#000', fontSize: 13, lineHeight: '20px', whiteSpace: 'nowrap', verticalAlign: 'middle',
});

// Mini: "OCT 02" / "TBD".
export function DDMini({ entry }) {
  if (!entry) return null;
  // TBD not bold (2026-10-22, Hera) — same weight as the date.
  if (entry.state === 'tbd') return <span style={pillStyle(false)}>TBD</span>;
  return <span style={pillStyle(entry.past)}>{ddDateText(entry.date)}</span>;
}

// Full: [2 P] [TUE. AM. 4th. OCT 02] / [2 P] [TBD].
export function DDFull({ entry }) {
  if (!entry) return null;
  const pb = entry.pbCount && entry.pbUnit ? `${entry.pbCount} ${entry.pbUnit}` : null;
  let main;
  if (entry.state === 'tbd') {
    main = <span style={pillStyle(false)}>TBD</span>; // not bold (2026-10-22)
  } else if (entry.state === 'scheduled') {
    const dt = parseDay(entry.date);
    const head = [
      dt ? `${WEEKDAYS[dt.getUTCDay()]}.` : '',
      entry.half ? `${entry.half}.` : '',
      entry.position ? `${ordinal(entry.position)}.` : '',
    ].filter(Boolean).join(' ');
    main = <span style={pillStyle(entry.past)}><b>{head}</b> {ddDateText(entry.date)}</span>;
  } else {
    main = <span style={pillStyle(entry.past)}>{ddDateText(entry.date)}</span>;
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      {pb && <span style={pillStyle(entry.state === 'scheduled' && entry.past)}><b>{pb}</b></span>}
      {main}
    </span>
  );
}

// Several entries: full → one per line (column, tight); mini → side by side.
export function DDList({ entries, full = false, direction }) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return null;
  const column = (direction || (full ? 'column' : 'row')) === 'column';
  const Item = full ? DDFull : DDMini;
  return (
    <span style={{
      display: 'inline-flex', flexDirection: column ? 'column' : 'row', alignItems: column ? 'flex-start' : 'center',
      gap: column ? 2 : 6, flexWrap: column ? 'nowrap' : 'wrap', verticalAlign: 'middle',
    }}>
      {list.map((e, i) => <Item key={i} entry={e} />)}
    </span>
  );
}

// Purchasing's PB pill (2026-10-22, Hera — was a single grey pill with the
// BY value struck through inside it):
//   not received by WH yet        → grey pill, BY value
//   WH received, same value        → green pill
//   WH received, different value   → grey pill with BY value struck through,
//                                     then a red pill with WH's value
//   BY left it empty, WH entered   → green pill with WH's value
// Nothing to show → nothing.
const PB_PILL = {
  display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600,
  lineHeight: '18px', whiteSpace: 'nowrap', verticalAlign: 'middle',
};
const PB_GREY = { ...PB_PILL, background: '#e4e5e7', color: '#303030' };
const PB_GREEN = { ...PB_PILL, background: '#cdfee1', color: '#0c5132' };
const PB_RED = { ...PB_PILL, background: '#fed3d1', color: '#8e1f0b' };
export function PBGreyPill({ pb }) {
  if (!pb) return null;
  const by = pb.by || null;
  const changed = pb.whSet && (pb.wh || null) !== by;
  if (pb.received) {
    if (!changed) return by ? <span style={PB_GREEN}>{by}</span> : null;
    if (!by) return pb.wh ? <span style={PB_GREEN}>{pb.wh}</span> : null;
    return (
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', verticalAlign: 'middle' }}>
        <span style={PB_GREY}><s style={{ color: '#8a8a8a', fontWeight: 500 }}>{by}</s></span>
        {pb.wh && <span style={PB_RED}>{pb.wh}</span>}
      </span>
    );
  }
  if (!by && !(changed && pb.wh)) return null;
  // Before WH received it (older data may already carry a WH value here).
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: '#e4e5e7',
      color: '#303030', fontSize: 12, fontWeight: 600, lineHeight: '18px', whiteSpace: 'nowrap', verticalAlign: 'middle',
    }}>
      {changed ? (
        <>
          {by && <s style={{ color: '#8a8a8a', fontWeight: 500 }}>{by}</s>}
          {by && pb.wh && ' '}
          {pb.wh}
        </>
      ) : by}
    </span>
  );
}

// Loads DD data for the given PO / transfer ids. Reloads only when the set
// of ids changes (pages that poll their own list don't re-fetch this).
// → { pos: { [id]: { entries, pb } }, transfers: { [id]: { entries } } }
const EMPTY = { pos: {}, transfers: {} };
export function useDD({ poIds = [], transferIds = [] } = {}) {
  const poKey = [...new Set(poIds.map(Number).filter(Boolean))].sort((a, b) => a - b).join(',');
  const trKey = [...new Set(transferIds.map(Number).filter(Boolean))].sort((a, b) => a - b).join(',');
  const [data, setData] = useState(EMPTY);
  useEffect(() => {
    if (!poKey && !trKey) { setData(EMPTY); return undefined; }
    let cancelled = false;
    fetch('/api/warehouse/dd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        poIds: poKey ? poKey.split(',').map(Number) : [],
        transferIds: trKey ? trKey.split(',').map(Number) : [],
      }),
    })
      .then(r => (r.ok ? r.json() : EMPTY))
      .then(d => { if (!cancelled) setData({ pos: d.pos || {}, transfers: d.transfers || {} }); })
      .catch(() => { if (!cancelled) setData(EMPTY); });
    return () => { cancelled = true; };
  }, [poKey, trKey]);
  return data;
}

export const poEntries = (dd, id) => ((dd.pos[id] || {}).entries || []);
export const poPb = (dd, id) => (dd.pos[id] || {}).pb || null;
export const transferEntries = (dd, id) => ((dd.transfers[id] || {}).entries || []);

// Phone-width screens (≤ 767px, same breakpoint as the rest of the Hub).
const PHONE_QUERY = '(max-width: 767px)';
export function useIsPhoneWidth() {
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

// Entries of a transfer that belong next to its From / To location
// (Purchasing list): HQ → store → To; store → HQ → From; store → store →
// pickup card at From, deliver card at To.
export function splitTransferSides(entries, fromLocation) {
  const from = []; const to = [];
  (entries || []).forEach(e => {
    if (e.leg === 'pickup') from.push(e);
    else if (e.leg === 'deliver') to.push(e);
    else if (e.location && e.location === fromLocation) from.push(e);
    else to.push(e);
  });
  return { from, to };
}
