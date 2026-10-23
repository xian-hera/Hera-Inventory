import React, { useState, useEffect, useCallback } from 'react';
import { Page, BlockStack, Text, Banner } from '@shopify/polaris';
import { useLocationColors, LOC_PILL_DEFAULT, pillTextColor, TruckIcon, EnterIcon, ExitIcon, refreshWarehouseBadges } from './whShared';

// Warehouse › Delivery tab (2026-10-23, Hera) — for the truck driver, phone
// only. Shows TODAY's saved Schedule as stops: Morning / Afternoon rows of
// location pills, in schedule order (WH places all cards of a store together,
// so each store is one stop per half-day; the first card decides the order).
//
//   • the stop the truck is at = the first stop not done yet → bigger pill,
//     truck icon, bold label;
//   • done stops → light grey pill and label;
//   • a stop with pickup tasks → green "arrow into door" sign after the label
//     (hidden once the stop is done; was an orange dot);
//   • the stop being viewed → bigger pill (was a black outline). It follows the truck, but the
//     driver can tap any stop to look at it / use its buttons out of order.
//
// Below the rows, for the viewed stop: its location pill, then
//   • blue "Delivered" button (only if it has deliveries) → (no confirm since
//     2026-10-23) every
//     delivery of the stop is Delivered (server: transfers In Transit →
//     Receiving; POs keep Sent to store). Done → grey "Delivered" block;
//   • Pickup card (only if it has pickups): transfer numbers (custom: title),
//     not clickable; Online order transfers first in pickup colour (opening
//     their items: to come);
//   • green "Picked Up" button → (no confirm) every pickup Picked up (store → HQ
//     transfers go In Transit; part 1 of a store → store transfer doesn't
//     change). Done → grey "Picked Up" block.
// A stop is done when both (whichever it has) are done; the next stop then
// becomes the truck's stop. API: GET /api/warehouse/delivery,
// POST /api/warehouse/delivery/done { half, location, action }.

const HALVES = [{ id: 'AM', label: 'AM' }, { id: 'PM', label: 'PM' }];
const GREY_BG = '#ebebeb';
const GREY_TEXT = '#a8a8a8';
const ORANGE = '#e2ac0c';
// Colours from Hera's artwork (2026-10-23)
const BLUE = '#3771BC';
const GREEN = '#4D8F53';
const PICKUP_BG = '#fff3d6';

const stopDone = (st) => (!st.hasDeliver || st.delivered) && (!st.hasPickup || st.pickedUp);

// Stop pill (changed 2026-10-23, Hera):
//   • selected (being viewed) → clearly bigger, bold, bigger truck; it pushes
//     the pills beside it a little, but keeps the row height (negative
//     vertical margin), so the rows above / below don't move;
//   • truck icon = the stop the truck is at;
//   • green "arrow into door" sign = the stop has pickups (until it is done).
// size 'display' = the stop's pill under the line.
function StopPill({ stop, active, selected, onClick, size }) {
  const colors = useLocationColors();
  const done = stopDone(stop);
  const bg = done ? GREY_BG : (colors[stop.location] || LOC_PILL_DEFAULT);
  const fg = done ? GREY_TEXT : pillTextColor(bg);
  const big = selected && size !== 'display';
  const disp = size === 'display';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!selected}
      style={{
        font: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: big ? 8 : 6,
        border: 'none', background: bg, color: fg, borderRadius: 999, whiteSpace: 'nowrap',
        // normal 30px high; selected 38px drawn over the row gap (margin -4px)
        padding: big ? '7px 16px' : disp ? '5px 14px' : '5px 12px',
        margin: big ? '-4px 0' : 0,
        fontSize: big ? 19 : disp ? 16 : 14, lineHeight: big ? '24px' : '20px',
        fontWeight: big || disp ? 700 : 500,
      }}
    >
      {active && !done && <TruckIcon height={big ? 22 : 16} arrow="none" color={fg} label="Truck is here" />}
      {stop.location}
      {stop.hasPickup && !done && <EnterIcon size={big ? 24 : 20} disc={GREEN} glyph="#ffffff" label="Has pickup" />}
    </button>
  );
}

// Delivered / Picked Up buttons: white label + small round sign (its arrow /
// door show the button colour) — Delivered: arrow out of the door,
// Picked Up: arrow into the door — no truck icon any more (2026-10-23).
function BigButton({ color, onClick, disabled, text, exit }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', minHeight: 64, border: 'none', borderRadius: 12, background: color, cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, opacity: disabled ? 0.6 : 1,
        color: '#ffffff', font: 'inherit', fontSize: 22, fontWeight: 700,
      }}
    >
      {text}
      {exit ? <ExitIcon size={30} disc="#ffffff" label="" /> : <EnterIcon size={30} disc="#ffffff" label="" />}
    </button>
  );
}

function DoneBlock({ text }) {
  return (
    <div style={{
      width: '100%', minHeight: 64, borderRadius: 12, background: '#d4d4d4', color: '#303030',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15,
    }}>{text}</div>
  );
}

function PickupCard({ tasks }) {
  const list = [...tasks].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  return (
    <div style={{
      background: '#fff', borderRadius: 12, boxShadow: '0 1px 0 rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.08)',
      padding: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <span style={{ fontWeight: 650, marginRight: 4 }}>Pickup</span>
      {list.map(t => (
        <span key={t.id} style={{
          padding: '5px 12px', borderRadius: 8, fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap',
          border: `1px solid ${t.online ? ORANGE : '#c9cccf'}`, background: t.online ? PICKUP_BG : '#fff',
        }}>{t.online ? 'Online' : t.number}</span>
      ))}
    </div>
  );
}

function WarehouseDelivery() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState(null); // null = follow the truck
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/warehouse/delivery');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load');
      setData(d);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error && !data) return <Page><Banner tone="critical">{error}</Banner></Page>;
  if (!data) return <Page><Text tone="subdued">Loading...</Text></Page>;

  const stops = data.stops || [];
  // The truck's stop (2026-10-23, Hera): the first unfinished stop AFTER the
  // stop finished last (stops can be done out of order); none after it →
  // the first unfinished stop of the day.
  const lastDone = stops.reduce((best, st, i) => (st.doneAt && (!best || st.doneAt > best.doneAt) ? { doneAt: st.doneAt, i } : best), null);
  const active = (lastDone && stops.slice(lastDone.i + 1).find(st => !stopDone(st)))
    || stops.find(st => !stopDone(st)) || null;
  const selected = stops.find(st => st.key === selectedKey) || active || stops[stops.length - 1] || null;

  // No confirmation any more (2026-10-23, Hera): a tap takes effect at once.
  const run = async (stop, action) => {
    setBusy(true);
    try {
      const r = await fetch('/api/warehouse/delivery/done', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ half: stop.half, location: stop.location, action }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      setData(prev => ({ ...prev, stops: d.stops }));
      if (d.failed && d.failed.length) {
        setNotice({ tone: 'critical', text: `Not done: ${d.failed.map(f => `${f.number} (${f.error})`).join(', ')}. Try again.` });
      } else {
        setNotice(null);
        // The stop is finished → the view moves on with the truck to the
        // next stop (2026-10-23, Hera).
        const after = (d.stops || []).find(x => x.key === stop.key);
        if (after && stopDone(after)) setSelectedKey(null);
      }
      refreshWarehouseBadges();
    } catch (e) {
      setNotice({ tone: 'critical', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <div style={{ padding: '0 16px', maxWidth: 640, margin: '0 auto' }}>
        <BlockStack gap="400">
          {/* no "Delivery" title under the tab bar (2026-10-23, Hera) */}
          {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}
          {stops.length === 0 ? (
            <Text tone="subdued">Nothing on today's schedule.</Text>
          ) : (
            <>
              {/* 18px between AM and PM (1.5× the old 12px, 2026-10-23) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {HALVES.map(h => {
                  const row = stops.filter(st => st.half === h.id);
                  return (
                    // AM / PM stay level with the FIRST row of pills when the
                    // pills wrap (2026-10-23): top-aligned, label as tall as
                    // that row (pills are all 30px high).
                    <div key={h.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <span style={{
                        fontWeight: 700, width: 30, flex: 'none', display: 'flex', alignItems: 'center',
                        height: 30,
                      }}>{h.label}</span>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 }}>
                        {row.length === 0 && <span style={{ color: GREY_TEXT, fontSize: 14 }}>—</span>}
                        {row.map(st => (
                          <StopPill
                            key={st.key}
                            stop={st}
                            active={active && active.key === st.key}
                            selected={selected && selected.key === st.key}
                            onClick={() => setSelectedKey(st.key)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ borderTop: '1px solid #303030' }} />
              {selected && (
                <BlockStack gap="300">
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <StopPill stop={selected} size="display" active={false} selected={false} onClick={() => {}} />
                  </div>
                  {selected.hasDeliver && (selected.delivered
                    ? <DoneBlock text="Delivered" />
                    : (
                      <BigButton color={BLUE} text="Delivered" exit disabled={busy} onClick={() => run(selected, 'deliver')} />
                    ))}
                  {selected.hasPickup && <PickupCard tasks={selected.pickup} />}
                  {selected.hasPickup && (selected.pickedUp
                    ? <DoneBlock text="Picked Up" />
                    : (
                      <BigButton color={GREEN} text="Picked Up" disabled={busy} onClick={() => run(selected, 'pickup')} />
                    ))}
                </BlockStack>
              )}
            </>
          )}
        </BlockStack>
      </div>
    </Page>
  );
}

export default WarehouseDelivery;
