import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Page, BlockStack, InlineStack, Text, Card, Button, Modal, TextField } from '@shopify/polaris';
import useKeyboardInset from '../../components/useKeyboardInset';

// Online › Keyboard Test (2026-11-12, Hera) — TEMPORARY test page.
// Question: inside the Shopify mobile app, can a popup with a focused text
// box stay above the soft keyboard? (Weekly Inventory Count › task detail ›
// line item popup: its lower part is covered by the keyboard.)
//
// The page shows, live, what the browser reports about the screen (is Hub in
// an iframe, window height, visualViewport height / offset) plus a log of
// resize / focus events, and opens the same kind of popup in five ways:
//   A  Current — centred, uses useKeyboardInset (what the task detail does now)
//   B  Follow visible area — placed and sized from visualViewport directly
//   C  Top of screen — fixed near the top, no keyboard logic
//   D  Top + short while typing — near the top; while a text box has focus on
//      a touch device it assumes the keyboard covers the lower X% and keeps the
//      popup above that (scrolls inside). Works even when the WebView reports
//      nothing.
//   E  Polaris Modal — the standard Polaris dialog with a TextField
// Hera tests each on iPhone / Android in the Shopify app and sends
// screenshots; the winner is then used for the real popups and this page is
// removed.

const LOG_MAX = 14;
const touchDevice = () => (typeof window !== 'undefined')
  && (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);

function readMetrics() {
  const vv = window.visualViewport;
  let inIframe;
  try { inIframe = window.self !== window.top; } catch (e) { inIframe = true; }
  return {
    inIframe,
    innerH: window.innerHeight,
    clientH: document.documentElement.clientHeight,
    outerH: window.outerHeight,
    screenH: window.screen ? window.screen.height : null,
    vvH: vv ? Math.round(vv.height) : null,
    vvTop: vv ? Math.round(vv.offsetTop) : null,
    vvPageTop: vv ? Math.round(vv.pageTop) : null,
    vvScale: vv ? Math.round(vv.scale * 100) / 100 : null,
    scrollY: Math.round(window.scrollY),
    focused: document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName),
  };
}

// ── Recorder (2026-11-12): every test opened is recorded from open to close —
// lowest / highest of each number while it was open, where the popup and the
// text box were while typing, and the events — so Hera can run all five and
// copy one text with every result. Kept in a module object (no re-renders).
const REC = { cur: null, results: [] };
const NUM_KEYS = ['innerH', 'clientH', 'vvH', 'vvTop', 'scrollY'];
function rectOf(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
}
function recStart(test) {
  const x = readMetrics();
  REC.cur = { test, start: x, lo: { ...x }, hi: { ...x }, focusSeen: false, typing: null, events: [] };
}
function recSample(type) {
  const c = REC.cur;
  if (!c) return;
  const x = readMetrics();
  NUM_KEYS.forEach(k => {
    if (x[k] == null) return;
    if (c.lo[k] == null || x[k] < c.lo[k]) c.lo[k] = x[k];
    if (c.hi[k] == null || x[k] > c.hi[k]) c.hi[k] = x[k];
  });
  if (x.focused) {
    c.focusSeen = true;
    // "while typing" snapshot = the moment with the smallest visible / window height
    const size = Math.min(x.vvH == null ? Infinity : x.vvH, x.innerH);
    if (!c.typing || size <= c.typing.size) {
      const input = document.activeElement.getBoundingClientRect();
      c.typing = {
        size, m: x,
        panel: rectOf('[data-kb-panel]') || rectOf('.Polaris-Modal-Dialog__Modal'),
        input: { top: Math.round(input.top), bottom: Math.round(input.bottom) },
      };
    }
  }
  if (type && c.events.length < 25) {
    c.events.push(`${type} in${x.innerH} vv${x.vvH}@${x.vvTop}${x.focused ? ' F' : ''}`);
  }
}
function recEnd() {
  const c = REC.cur;
  if (!c) return;
  recSample('close');
  REC.results = [...REC.results.filter(r => r.test !== c.test), c];
  REC.cur = null;
}
function resultsText() {
  const m = readMetrics();
  const lines = [
    `Keyboard Test ${new Date().toISOString()}`,
    `UA: ${navigator.userAgent}`,
    `iframe ${m.inIframe ? 'yes' : 'no'} · screen ${m.screenH} · dpr ${window.devicePixelRatio} · outer ${m.outerH} · vv ${window.visualViewport ? 'yes' : 'no'}`,
  ];
  const r = (o) => (o ? `top ${o.top} bottom ${o.bottom}${o.h != null ? ` h ${o.h}` : ''}` : '—');
  [...REC.results].sort((a, b) => a.test.localeCompare(b.test)).forEach(c => {
    lines.push('');
    lines.push(`== ${c.test}`);
    lines.push(`open: inner ${c.start.innerH} client ${c.start.clientH} vv ${c.start.vvH}@${c.start.vvTop} scroll ${c.start.scrollY}`);
    lines.push(`range: inner ${c.lo.innerH}-${c.hi.innerH} client ${c.lo.clientH}-${c.hi.clientH} vv ${c.lo.vvH}-${c.hi.vvH} vvTop ${c.lo.vvTop}-${c.hi.vvTop} scroll ${c.lo.scrollY}-${c.hi.scrollY}`);
    if (c.typing) {
      const t = c.typing;
      lines.push(`typing: inner ${t.m.innerH} vv ${t.m.vvH}@${t.m.vvTop} scroll ${t.m.scrollY} | popup ${r(t.panel)} | input ${r(t.input)}`);
    } else {
      lines.push(`typing: text box never focused`);
    }
    lines.push(`events: ${c.events.join(' | ')}`);
  });
  return lines.join('\n');
}

function useMetrics() {
  const [m, setM] = useState(readMetrics);
  const [min, setMin] = useState({ innerH: Infinity, vvH: Infinity });
  const [log, setLog] = useState([]);
  const push = useCallback((type) => {
    recSample(type);
    const x = readMetrics();
    setM(x);
    setMin(p => ({ innerH: Math.min(p.innerH, x.innerH), vvH: Math.min(p.vvH, x.vvH == null ? Infinity : x.vvH) }));
    const t = new Date();
    const time = `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(Math.floor(t.getMilliseconds() / 100))}`;
    setLog(p => [`${time} ${type}  inner ${x.innerH}  vv ${x.vvH}@${x.vvTop}`, ...p].slice(0, LOG_MAX));
  }, []);
  useEffect(() => {
    const vv = window.visualViewport;
    const on = (type) => () => push(type);
    // focus events: text boxes only (a button press must not re-render the page mid-click)
    const onText = (type) => (e) => { const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) push(type); };
    const handlers = [
      [window, 'resize', on('win.resize')],
      [window, 'focusin', onText('focusin')],
      [window, 'focusout', onText('focusout')],
      [window, 'orientationchange', on('orientation')],
    ];
    if (vv) handlers.push([vv, 'resize', on('vv.resize')], [vv, 'scroll', on('vv.scroll')]);
    handlers.forEach(([t, e, f]) => t.addEventListener(e, f));
    const timer = setInterval(() => { recSample(null); setM(readMetrics()); }, 300);
    return () => { handlers.forEach(([t, e, f]) => t.removeEventListener(e, f)); clearInterval(timer); };
  }, [push]);
  const reset = () => { setMin({ innerH: Infinity, vvH: Infinity }); setLog([]); };
  return { m, min, log, reset };
}

const fmt = (v) => (v === Infinity || v == null ? '—' : String(v));

function MetricsBox({ m, min, log, onReset, compact }) {
  const row = (k, v) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ color: '#616161' }}>{k}</span><b style={{ fontWeight: 600 }}>{v}</b></div>
  );
  if (compact) {
    return (
      <div style={{ fontSize: 11, color: '#616161', fontFamily: 'ui-monospace, Menlo, monospace' }}>
        iframe {m.inIframe ? 'yes' : 'no'} · inner {m.innerH} · vv {fmt(m.vvH)}@{fmt(m.vvTop)} · min vv {fmt(min.vvH)}
      </div>
    );
  }
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingSm" as="h3">What the Browser Reports</Text>
          <Button size="slim" onClick={onReset}>Reset</Button>
        </InlineStack>
        <div style={{ fontSize: 13, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', columnGap: 16, rowGap: 2 }}>
          {row('In iframe', m.inIframe ? 'Yes' : 'No')}
          {row('Window height', m.innerH)}
          {row('Lowest window height', fmt(min.innerH))}
          {row('Visible height (vv)', fmt(m.vvH))}
          {row('Lowest visible height', fmt(min.vvH))}
          {row('Visible offset top', fmt(m.vvTop))}
          {row('Client height', m.clientH)}
          {row('Outer height', m.outerH)}
          {row('Screen height', fmt(m.screenH))}
          {row('Zoom', fmt(m.vvScale))}
          {row('Page scroll', m.scrollY)}
          {row('Text box focused', m.focused ? 'Yes' : 'No')}
        </div>
        <div style={{ fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', color: '#303030', background: '#f6f6f7', borderRadius: 8, padding: 8, height: 150, overflowY: 'auto', boxSizing: 'border-box' }}>
          {log.length === 0 ? <span style={{ color: '#8a8a8a' }}>Events show here (open a test, tap the box).</span> : log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </BlockStack>
    </Card>
  );
}

// The popup's content — like the Weekly Count line item popup: a text box
// near the top and several things under it, ending with a marked bottom.
function PopupBody({ label, onClose, metrics, min, inputRef, onFocusChange }) {
  const [v, setV] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 650 }}>Test {label}</div>
        <button type="button" onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1 }}>✕</button>
      </div>
      <MetricsBox compact m={metrics} min={min} />
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          ref={inputRef}
          inputMode="numeric"
          placeholder="Input your count"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onFocus={() => onFocusChange && onFocusChange(true)}
          onBlur={() => onFocusChange && onFocusChange(false)}
          autoComplete="off"
          style={{ flex: 1, minWidth: 0, padding: '10px 12px', fontSize: 16, border: '1px solid #8a8a8a', borderRadius: 8, boxSizing: 'border-box' }}
        />
        <Button>Submit</Button>
      </div>
      <button type="button" style={{ background: '#008060', color: '#fff', border: 'none', borderRadius: 12, padding: 18, fontSize: 18, fontWeight: 700 }}>System 5　Correct</button>
      <div style={{ fontSize: 13, color: '#616161' }}>Committed 1 · Picked 0 (example text)</div>
      <button type="button" style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #c9cccf', background: '#fff', fontSize: 14 }}>Check History ↗</button>
      <div style={{ background: '#fff4e5', border: '1px dashed #e2ac0c', borderRadius: 8, padding: 8, fontSize: 12, textAlign: 'center' }}>
        ▼ Bottom of the popup — can you see this line while typing? ▼
      </div>
    </div>
  );
}

const OVERLAY = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000 };
const PANEL = {
  position: 'fixed', left: 16, right: 16, maxWidth: 480, margin: '0 auto', background: '#fff',
  borderRadius: 12, padding: 20, boxSizing: 'border-box', overflowY: 'auto', zIndex: 1001,
};

// A — exactly how the task detail popup is built today.
function PopupA({ close, metrics, min }) {
  useKeyboardInset(true);
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  return createPortal(
    <div style={OVERLAY}>
      <div data-kb-panel="1" style={{ ...PANEL, top: 'var(--kb-center-y, 50%)', transform: 'translateY(-50%)', maxHeight: 'var(--kb-avail-h, calc(100vh - 176px))' }}>
        <PopupBody label="A · Current" onClose={close} metrics={metrics} min={min} inputRef={ref} />
      </div>
    </div>, document.body);
}

// B — top / height straight from visualViewport.
function PopupB({ close, metrics, min }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const upd = () => setBox({ top: vv.offsetTop + 8, h: vv.height - 16 });
    upd();
    vv.addEventListener('resize', upd); vv.addEventListener('scroll', upd);
    return () => { vv.removeEventListener('resize', upd); vv.removeEventListener('scroll', upd); };
  }, []);
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  return createPortal(
    <div style={OVERLAY}>
      <div data-kb-panel="1" style={{ ...PANEL, top: box ? box.top : 8, maxHeight: box ? box.h : 'calc(100% - 16px)' }}>
        <PopupBody label="B · Follow Visible Area" onClose={close} metrics={metrics} min={min} inputRef={ref} />
      </div>
    </div>, document.body);
}

// C — near the top, nothing else.
function PopupC({ close, metrics, min }) {
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  return createPortal(
    <div style={OVERLAY}>
      <div data-kb-panel="1" style={{ ...PANEL, top: 8, maxHeight: 'calc(100% - 16px)' }}>
        <PopupBody label="C · Top of Screen" onClose={close} metrics={metrics} min={min} inputRef={ref} />
      </div>
    </div>, document.body);
}

// D — near the top; while typing on a touch device, as tall as the part the
// keyboard leaves free (assumed `pct` % of the window covered), scrolling inside.
function PopupD({ close, metrics, min, pct }) {
  const ref = useRef(null);
  const [typing, setTyping] = useState(false);
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  const short = typing && touchDevice();
  return createPortal(
    <div style={OVERLAY}>
      <div data-kb-panel="1" style={{ ...PANEL, top: 8, maxHeight: short ? `calc(${100 - pct}% - 16px)` : 'calc(100% - 16px)' }}>
        <PopupBody label={`D · Top, ${pct}% Kept Free`} onClose={close} metrics={metrics} min={min} inputRef={ref} onFocusChange={setTyping} />
      </div>
    </div>, document.body);
}

// E — standard Polaris Modal.
function PopupE({ close, metrics, min }) {
  const [v, setV] = useState('');
  return (
    <Modal open onClose={close} title="Test E · Polaris Modal">
      <Modal.Section>
        <BlockStack gap="300">
          <MetricsBox compact m={metrics} min={min} />
          <TextField label="Count" value={v} onChange={setV} autoComplete="off" inputMode="numeric" autoFocus />
          <button type="button" style={{ background: '#008060', color: '#fff', border: 'none', borderRadius: 12, padding: 18, fontSize: 18, fontWeight: 700 }}>System 5　Correct</button>
          <button type="button" style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #c9cccf', background: '#fff', fontSize: 14 }}>Check History ↗</button>
          <div style={{ background: '#fff4e5', border: '1px dashed #e2ac0c', borderRadius: 8, padding: 8, fontSize: 12, textAlign: 'center' }}>
            ▼ Bottom of the popup — can you see this line while typing? ▼
          </div>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

const TESTS = [
  ['A', 'A · Current (Centre + Keyboard Check)'],
  ['B', 'B · Follow Visible Area'],
  ['C', 'C · Top of Screen'],
  ['D', 'D · Top, Short While Typing'],
  ['E', 'E · Polaris Modal'],
];

function OnlineKeyboardTest() {
  const { m, min, log, reset } = useMetrics();
  const [open, setOpen] = useState(null);
  const [pct, setPct] = useState(45);
  const [results, setResults] = useState('');
  const [copyMsg, setCopyMsg] = useState('');
  const textRef = useRef(null);
  const start = (id) => { reset(); recStart(id === 'D' ? `D (${pct}%)` : id); setOpen(id); };
  const close = () => { recEnd(); setOpen(null); setResults(resultsText()); };
  const copy = async () => {
    const text = resultsText();
    setResults(text);
    try {
      await navigator.clipboard.writeText(text);
      setCopyMsg('Copied.');
      return;
    } catch (e) { /* the app's WebView may block it — try the old way */ }
    try {
      const ta = textRef.current;
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.blur();
      setCopyMsg(ok ? 'Copied.' : 'Copy was blocked — press and hold the text below, Select All, Copy.');
    } catch (e) {
      setCopyMsg('Copy was blocked — press and hold the text below, Select All, Copy.');
    }
  };
  const clearAll = () => { REC.results = []; setResults(''); setCopyMsg(''); };
  const props = { close, metrics: m, min };
  return (
    <Page>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text variant="headingSm" as="h3">Keyboard Test (Temporary)</Text>
            <Text as="p">
              Open this page in the Shopify app on a phone. Run the tests A to E one by one: open a test, tap its
              text box so the keyboard opens, check whether the dashed “Bottom of the popup” line is visible, then close
              it with ✕ and open the next one. Each test is recorded. At the end press Copy All Results and paste the
              text in the chat — no screenshots needed.
            </Text>
          </BlockStack>
        </Card>
        <MetricsBox m={m} min={min} log={log} onReset={reset} />
        <Card>
          <BlockStack gap="300">
            <Text variant="headingSm" as="h3">Tests</Text>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
              {TESTS.map(([id, label]) => <Button key={id} onClick={() => start(id)}>{label}</Button>)}
            </div>
            <InlineStack gap="200" blockAlign="center">
              <span style={{ fontSize: 13, color: '#616161' }}>Test D assumes the keyboard covers</span>
              <select value={pct} onChange={(e) => setPct(Number(e.target.value))} style={{ font: 'inherit', fontSize: 13, padding: '2px 6px', borderRadius: 6 }}>
                {[35, 40, 45, 50, 55].map(n => <option key={n} value={n}>{n}%</option>)}
              </select>
              <span style={{ fontSize: 13, color: '#616161' }}>of the screen</span>
            </InlineStack>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="200">
              <Text variant="headingSm" as="h3">Results ({REC.results.length} of 5 Tests Done)</Text>
              <InlineStack gap="200">
                <Button onClick={clearAll}>Clear</Button>
                <Button variant="primary" onClick={copy}>Copy All Results</Button>
              </InlineStack>
            </InlineStack>
            {copyMsg && <Text as="p" tone={copyMsg === 'Copied.' ? 'success' : 'critical'}>{copyMsg}</Text>}
            <textarea ref={textRef} readOnly value={results} placeholder="Results show here after each test."
              style={{ width: '100%', height: 160, boxSizing: 'border-box', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', border: '1px solid #c9cccf', borderRadius: 8, padding: 8 }} />
          </BlockStack>
        </Card>
      </BlockStack>
      {open === 'A' && <PopupA {...props} />}
      {open === 'B' && <PopupB {...props} />}
      {open === 'C' && <PopupC {...props} />}
      {open === 'D' && <PopupD {...props} pct={pct} />}
      {open === 'E' && <PopupE {...props} />}
      <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} aria-hidden="true" />
    </Page>
  );
}

export default OnlineKeyboardTest;
