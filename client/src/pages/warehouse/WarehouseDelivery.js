import React, { useState, useEffect, useCallback } from 'react';
import { Page, BlockStack, Text, Banner, Modal } from '@shopify/polaris';
import { useLocationColors, LOC_PILL_DEFAULT, pillTextColor, TruckIcon, refreshWarehouseBadges } from './whShared';

// Warehouse › Delivery tab (2026-10-23, Hera) — for the truck driver, phone
// only. Shows TODAY's saved Schedule as stops: Morning / Afternoon rows of
// location pills, in schedule order (WH places all cards of a store together,
// so each store is one stop per half-day; the first card decides the order).
//
//   • the stop the truck is at = the first stop not done yet → bigger pill,
//     truck icon, bold label;
//   • done stops → light grey pill and label;
//   • a stop with pickup tasks → orange dot with white ring after the label
//     (hidden once the stop is done);
//   • the stop being viewed → black outline. It follows the truck, but the
//     driver can tap any stop to look at it / use its buttons out of order.
//
// Below the rows, for the viewed stop: its location pill, then
//   • blue "unload" button (only if it has deliveries) → confirm → every
//     delivery of the stop is Delivered (server: transfers In Transit →
//     Receiving; POs keep Sent to store). Done → grey "Delivered" block;
//   • Pickup card (only if it has pickups): transfer numbers (custom: title),
//     not clickable; Online order transfers first in pickup colour (opening
//     their items: to come);
//   • green "load" button → confirm → every pickup Picked up (store → HQ
//     transfers go In Transit; part 1 of a store → store transfer doesn't
//     change). Done → grey "Picked Up" block.
// A stop is done when both (whichever it has) are done; the next stop then
// becomes the truck's stop. API: GET /api/warehouse/delivery,
// POST /api/warehouse/delivery/done { half, location, action }.

const HALVES = [{ id: 'AM', label: 'AM' }, { id: 'PM', label: 'PM' }];
const GREY_BG = '#ebebeb';
const GREY_TEXT = '#a8a8a8';
const ORANGE = '#e2ac0c';
const BLUE = '#1f6fbf';
const GREEN = '#b3dfb8';
const PICKUP_BG = '#fff3d6';

const stopDone = (st) => (!st.hasDeliver || st.delivered) && (!st.hasPickup || st.pickedUp);

function StopPill({ stop, active, selected, onClick, big }) {
  const colors = useLocationColors();
  const done = stopDone(stop);
  const bg = done ? GREY_BG : (colors[stop.location] || LOC_PILL_DEFAULT);
  const fg = done ? GREY_TEXT : pillTextColor(bg);
  const large = big || active;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        font: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
        border: 'none', boxShadow: selected ? 'inset 0 0 0 2px #303030' : 'none',
        background: bg, color: fg, borderRadius: 999, whiteSpace: 'nowrap',
        // Same height (30px) big or small, so the AM / PM label can line up
        // with the first row whichever pill is in it.
        padding: large ? '4px 14px' : '5px 12px', fontSize: large ? 16 : 14,
        fontWeight: large ? 700 : 500, lineHeight: large ? '22px' : '20px',
      }}
    >
      {active && !done && <TruckIcon height={18} arrow="none" color={fg} bg={bg} label="Truck is here" />}
      {stop.location}
      {stop.hasPickup && !done && (
        <span aria-label="Has pickup" style={{
          width: 14, height: 14, borderRadius: '50%', background: ORANGE, boxShadow: '0 0 0 2px #fff', flex: 'none',
        }} />
      )}
    </button>
  );
}

function BigButton({ color, onClick, disabled, children, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      style={{
        width: '100%', minHeight: 64, border: 'none', borderRadius: 12, background: color, cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.6 : 1,
      }}
    >{children}</button>
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
  const [confirm, setConfirm] = useState(null);         // { stop, action }
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

  const run = async () => {
    const { stop, action } = confirm;
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
      setConfirm(null);
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
                    <StopPill stop={selected} big active={false} selected={false} onClick={() => {}} />
                  </div>
                  {selected.hasDeliver && (selected.delivered
                    ? <DoneBlock text="Delivered" />
                    : (
                      <BigButton color={BLUE} label="Delivered" disabled={busy} onClick={() => setConfirm({ stop: selected, action: 'deliver' })}>
                        <TruckIcon height={30} color="#ffffff" bg={BLUE} arrow="out" label="Unload" />
                      </BigButton>
                    ))}
                  {selected.hasPickup && <PickupCard tasks={selected.pickup} />}
                  {selected.hasPickup && (selected.pickedUp
                    ? <DoneBlock text="Picked Up" />
                    : (
                      <BigButton color={GREEN} label="Picked up" disabled={busy} onClick={() => setConfirm({ stop: selected, action: 'pickup' })}>
                        <TruckIcon height={30} color="#231f20" bg={GREEN} arrow="in" label="Load" />
                      </BigButton>
                    ))}
                </BlockStack>
              )}
            </>
          )}
        </BlockStack>
      </div>
      <Modal
        open={!!confirm}
        onClose={() => { if (!busy) setConfirm(null); }}
        title={confirm && confirm.action === 'pickup' ? 'Confirm everything is picked up?' : 'Confirm everything is unloaded?'}
        primaryAction={{ content: 'Confirm', onAction: run, loading: busy, disabled: busy }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setConfirm(null), disabled: busy }]}
      >
        <Modal.Section>
          <Text>{confirm ? confirm.stop.location : ''}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default WarehouseDelivery;
