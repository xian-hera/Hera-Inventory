import React, { useState, useEffect, useCallback } from 'react';
import { BlockStack, InlineStack, Text, Button, Banner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { api, deadlineText, packText, Switch, QtyEditor, ConfirmBox, HUB_BOX, SUBDUED, smallBtnStyle } from './supplyShared';
import { LocPill, useLocationOrder } from './whShared';

// Warehouse › Store Supply › Supply Requests and Shopping List
// (step 2, 2026-11-10, Hera — claude/STORE_SUPPLY_SPEC.md).
//
// Current Batch = every closed deadline whose shopping isn't finished yet
// (an unfinished older batch is merged into the newer one); when all are
// finished it is the last one, read-only. Next Batch = requests already
// submitted for the open deadline (WH may review them early).

// Hub look (2026-11-10, Hera): Polaris-like white boxes, 13 px text, Polaris
// buttons — not the mockup's thick borders and big type.
const GREEN = '#008060';
const BLUE = '#2c6ecb';
const CARD = { ...HUB_BOX, padding: 16, boxSizing: 'border-box' };
const TH_STYLE = { fontWeight: 550, color: SUBDUED, fontSize: 12, padding: '6px 0', borderBottom: '1px solid #e3e3e3' };
const PILL = { display: 'inline-block', padding: '1px 9px', borderRadius: 999, fontSize: 12, fontWeight: 600, lineHeight: '18px' };

const effQty = (l) => (l.approvedQty != null ? l.approvedQty : l.qty);

function BatchRange({ from, to }) {
  if (!to) return null;
  return (
    <span style={{ fontSize: 13, color: '#303030' }}>
      {from ? <>From <b style={{ fontWeight: 600 }}>{deadlineText(from)}</b> to <b style={{ fontWeight: 600 }}>{deadlineText(to)}</b></> : <>Up to <b style={{ fontWeight: 600 }}>{deadlineText(to)}</b></>}
    </span>
  );
}

function BatchPills({ batch, onSelect }) {
  return (
    <InlineStack gap="100">
      {[['current', 'Current Batch'], ['next', 'Next Batch']].map(([id, label]) => (
        <button key={id} type="button" aria-pressed={batch === id} onClick={() => onSelect(id)} style={smallBtnStyle(batch === id)}>{label}</button>
      ))}
    </InlineStack>
  );
}

// ── Supply Requests ─────────────────────────────────────────────────────────

function RequestCard({ req, locked, onLine, onApprove, onReview }) {
  const [open, setOpen] = useState(false);
  const approved = req.status === 'approved';
  const lines = req.lines;
  const total = lines.reduce((n, l) => n + effQty(l), 0);
  const shown = lines.filter(l => effQty(l) > 0);
  const TD = { padding: '4px 0', borderBottom: '1px solid #f1f1f1', fontSize: 13, verticalAlign: 'middle', height: 36, boxSizing: 'border-box' };
  const table = (editable) => (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ ...TH_STYLE, textAlign: 'left' }}>Item</th>
          <th style={{ ...TH_STYLE, textAlign: 'center', width: 120 }}>Qty</th>
        </tr>
      </thead>
      <tbody>
        {(editable ? lines : shown).map(l => {
          const changed = l.approvedQty != null;
          return (
            <tr key={l.id}>
              <td style={TD}>
                <div style={{ color: effQty(l) === 0 ? '#8a8a8a' : '#303030' }}>{l.name}</div>
                {l.packSize && <div style={{ fontSize: 12, color: SUBDUED }}>{packText(l.packSize)}</div>}
              </td>
              <td style={{ ...TD, textAlign: 'center' }}>
                {editable ? (
                  <QtyEditor value={effQty(l)} min={0} onCommit={(n) => onLine(l, n)}
                    renderValue={(v) => <span style={changed ? { color: BLUE, fontWeight: 600 } : undefined}>{v}</span>} />
                ) : (
                  <span style={changed ? { color: BLUE, fontWeight: 600 } : undefined}>{effQty(l)}</span>
                )}
                {changed && <div style={{ fontSize: 11, color: SUBDUED }}>Asked {l.qty}</div>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  return (
    <div style={{ ...CARD, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <InlineStack align="space-between" blockAlign="center" gap="200">
        <InlineStack gap="200" blockAlign="center">
          <LocPill name={req.location} />
          {req.autoSubmitted && <span style={{ fontSize: 12, color: SUBDUED }}>Sent at the deadline</span>}
        </InlineStack>
        {approved && <span style={{ ...PILL, background: '#cdfee1', color: '#0c5132' }}>Approved</span>}
      </InlineStack>
      {approved ? (
        <>
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} style={{
            border: 'none', background: '#f6f6f7', borderRadius: 8, padding: '6px 10px', cursor: 'pointer',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, font: 'inherit', fontSize: 13, color: '#303030', textAlign: 'left',
          }}>
            <span>
              <span style={{ display: 'inline-block', width: 14, color: SUBDUED, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>›</span>
              {shown.length === 0 ? 'Nothing' : shown[0].name}{shown.length > 1 ? ` + ${shown.length - 1} more` : ''}
            </span>
            <span style={{ fontWeight: 600 }}>{total}</span>
          </button>
          {open && table(false)}
          {!locked && <InlineStack align="end"><Button onClick={onReview}>Review Again</Button></InlineStack>}
        </>
      ) : (
        <>
          {table(!locked)}
          {!locked && (
            <InlineStack align="end">
              <Button variant="primary" tone="success" onClick={onApprove}>Approve</Button>
            </InlineStack>
          )}
        </>
      )}
    </div>
  );
}

export function SupplyRequests({ setError }) {
  const navigate = useNavigate();
  const order = useLocationOrder();
  const [batch, setBatch] = useState('current');
  const [data, setData] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'last' | 'review', req }
  const [busy, setBusy] = useState(false);
  const [readyNote, setReadyNote] = useState(false);
  const load = useCallback(() => api('GET', `/requests?batch=${batch}`).then(setData).catch(e => setError(e.message)), [batch, setError]);
  useEffect(() => { setData(null); setReadyNote(false); load(); }, [load]);
  if (!data) return <Text tone="subdued">Loading...</Text>;
  const reqs = [...data.requests].sort((a, b) => order(a.location, b.location) || a.id - b.id);
  const locked = data.finished;
  const run = async (fn) => { setError(''); try { await fn(); } catch (e) { setError(e.message); } await load(); };
  const approve = (req) => {
    const others = reqs.filter(r => r.id !== req.id && r.status !== 'approved');
    if (batch === 'current' && others.length === 0) { setConfirm({ kind: 'last', req }); return; }
    run(() => api('POST', `/requests/${req.id}/approve`));
  };
  const doConfirm = async () => {
    const c = confirm;
    setBusy(true);
    await run(() => api('POST', `/requests/${c.req.id}/${c.kind === 'last' ? 'approve' : 'unapprove'}`));
    setBusy(false);
    setConfirm(null);
    if (c.kind === 'last') setReadyNote(true);
  };
  return (
    <BlockStack gap="300">
      <InlineStack gap="300" blockAlign="center" wrap>
        <BatchPills batch={batch} onSelect={setBatch} />
        <BatchRange from={data.from} to={data.to} />
      </InlineStack>
      {locked && <Text tone="subdued">Shopping for this batch is finished — it can’t be changed any more.</Text>}
      {batch === 'next' && data.to && <Text tone="subdued">Stores can still send requests until {deadlineText(data.to)}. You can review the ones already sent.</Text>}
      {readyNote && (
        <Banner tone="success" onDismiss={() => setReadyNote(false)}
          action={{ content: 'Open Shopping List', onAction: () => navigate('/warehouse/store-supply/shopping-list') }}>
          All requests are approved. The Shopping List is ready.
        </Banner>
      )}
      {reqs.length === 0 ? (
        <div style={{ ...CARD, padding: 20 }}>
          <Text tone="subdued">{batch === 'next' ? 'No store has sent a request for the next deadline yet.' : 'No requests in the Current Batch.'}</Text>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, alignItems: 'start' }}>
          {reqs.map(r => (
            <RequestCard key={r.id} req={r} locked={locked}
              onLine={(l, n) => run(() => api('PATCH', `/requests/${r.id}/lines/${l.id}`, { qty: n }))}
              onApprove={() => approve(r)}
              onReview={() => setConfirm({ kind: 'review', req: r })} />
          ))}
        </div>
      )}
      <ConfirmBox
        open={!!confirm}
        busy={busy}
        title={confirm && confirm.kind === 'last' ? 'Approve the Last Request?' : 'Review Again?'}
        confirmLabel={confirm && confirm.kind === 'last' ? 'Approve' : 'Review Again'}
        onCancel={() => setConfirm(null)}
        onConfirm={doConfirm}
      >
        {confirm && confirm.kind === 'last'
          ? 'This is the last request of the Current Batch. After it is approved, the Shopping List is made from all the approved requests.'
          : (batch === 'current'
            ? `${confirm ? confirm.req.location : ''}’s request goes back to review. The Shopping List waits until it is approved again; items already bought stay bought.`
            : `${confirm ? confirm.req.location : ''}’s request goes back to review.`)}
      </ConfirmBox>
    </BlockStack>
  );
}

// ── Shopping List ───────────────────────────────────────────────────────────

const CheckBtn = ({ bought, onClick }) => (
  <button type="button" onClick={onClick} aria-label={bought ? 'Bought — tap to undo' : 'Mark as bought'} title={bought ? 'Bought' : 'Mark as bought'}
    style={{
      width: 28, height: 28, borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', touchAction: 'manipulation',
      background: bought ? '#e3e3e3' : GREEN, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    }}>
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke={bought ? '#8a8a8a' : '#fff'} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  </button>
);

export function ShoppingList({ setError }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'undo', row } | { kind: 'finish' }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const load = useCallback(() => api('GET', '/shopping').then(setData).catch(e => setError(e.message)), [setError]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Text tone="subdued">Loading...</Text>;
  const call = async (method, url, body) => {
    setError('');
    try { const d = await api(method, url, body); setData(d); return d; } catch (e) { setError(e.message); load(); return null; }
  };
  const check = async (row) => {
    if (row.bought) { setConfirm({ kind: 'undo', row }); return; }
    const d = await call('POST', `/shopping/${row.itemId}/bought`, { bought: true });
    if (d && d.allBought) setConfirm({ kind: 'finish' });
  };
  const doConfirm = async () => {
    setBusy(true);
    if (confirm.kind === 'undo') {
      await call('POST', `/shopping/${confirm.row.itemId}/bought`, { bought: false });
    } else {
      setError('');
      try { await api('POST', '/shopping/finish'); setDone(true); } catch (e) { setError(e.message); }
      await load();
    }
    setBusy(false);
    setConfirm(null);
  };

  const box = (children) => <div style={{ ...CARD, padding: 20 }}>{children}</div>;
  if (done && !data.ready) {
    return box(<BlockStack gap="100"><Text fontWeight="semibold">Shopping is finished.</Text><Text tone="subdued">The bought quantities were added to Inventory.</Text></BlockStack>);
  }
  if (!data.ready) {
    const msg = {
      none: 'No batch has closed yet. The Shopping List is made after a deadline passes and every request is approved.',
      empty: 'No store sent a request in the Current Batch.',
      finished: 'Shopping for the last batch is finished. The next list comes after the next deadline.',
    }[data.reason];
    return (
      <BlockStack gap="300">
        {data.to && <BatchRange from={data.from} to={data.to} />}
        {data.reason === 'pending' ? box(
          <InlineStack align="space-between" blockAlign="center" gap="200">
            <Text>Approve all the requests in Current Batch first.</Text>
            <Button onClick={() => navigate('/warehouse/store-supply/requests')}>Supply Requests</Button>
          </InlineStack>
        ) : box(<Text tone="subdued">{msg}</Text>)}
      </BlockStack>
    );
  }

  const TH = { ...TH_STYLE, textAlign: 'left', padding: '6px' };
  const TD = { padding: '4px 6px', height: 44, boxSizing: 'border-box', borderBottom: '1px solid #f1f1f1', fontSize: 13, verticalAlign: 'middle' };
  return (
    <BlockStack gap="300">
      <BatchRange from={data.from} to={data.to} />
      <div style={{ ...CARD, padding: '12px 16px' }}>
        <BlockStack gap="300">
          <InlineStack gap="300" blockAlign="center" wrap>
            <Switch on={data.useStock} label={data.useStock ? 'Use Stock' : 'Ignore Stock'}
              onChange={(v) => call('PUT', '/shopping/use-stock', { useStock: v })} />
            <span style={{ fontSize: 13, color: SUBDUED }}>{data.useStock ? 'Buy only what is missing.' : 'Buy everything the stores asked for.'}</span>
          </InlineStack>
          {data.rows.length === 0 ? (
            <Text tone="subdued">Nothing to buy — every approved qty is 0.</Text>
          ) : (
            <>
              <span style={{ fontSize: 12, color: SUBDUED }}>Click to change the Qty to Buy.</span>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>Item</th>
                    <th style={{ ...TH, textAlign: 'center', width: 90 }}>Current Inventory</th>
                    <th style={{ ...TH, textAlign: 'center', width: 130 }}>Qty to Buy</th>
                    <th style={{ ...TH, width: 44 }} aria-label="Bought" />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => {
                    const none = !r.bought && r.qtyToBuy === 0; // nothing to buy — no check needed
                    return (
                    <tr key={r.itemId} style={{ background: r.bought || none ? '#fafafa' : undefined }}>
                      <td style={TD}>
                        <div style={{ color: r.bought ? '#8a8a8a' : '#303030', textDecoration: r.bought ? 'line-through' : 'none' }}>{r.name}</div>
                        {r.packSize && <div style={{ fontSize: 12, color: SUBDUED }}>{packText(r.packSize)}</div>}
                      </td>
                      <td style={{ ...TD, textAlign: 'center', color: r.bought ? '#8a8a8a' : '#303030' }}>{r.inventory}</td>
                      <td style={{ ...TD, textAlign: 'center' }}>
                        {r.bought ? <span style={{ color: '#8a8a8a' }}>{r.qtyToBuy}</span> : (
                          <QtyEditor value={r.qtyToBuy} min={0} onCommit={(n) => call('PATCH', `/shopping/${r.itemId}`, { qty: n })}
                            renderValue={(v) => <span style={{ fontWeight: 600, color: r.changed ? BLUE : '#303030' }}>{v}</span>} />
                        )}
                      </td>
                      <td style={{ ...TD, textAlign: 'right' }}>
                        {none ? <span style={{ fontSize: 12, color: '#8a8a8a', whiteSpace: 'nowrap' }}>No Need</span> : <CheckBtn bought={r.bought} onClick={() => check(r)} />}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
          {data.allBought && (
            <InlineStack align="end">
              <Button variant="primary" onClick={() => setConfirm({ kind: 'finish' })}>Finish Shopping</Button>
            </InlineStack>
          )}
        </BlockStack>
      </div>
      <ConfirmBox
        open={!!confirm}
        busy={busy}
        title={confirm && confirm.kind === 'undo' ? 'Not Bought?' : 'Finish Shopping?'}
        confirmLabel={confirm && confirm.kind === 'undo' ? 'Undo' : 'Finish'}
        onCancel={() => setConfirm(null)}
        onConfirm={doConfirm}
      >
        {confirm && confirm.kind === 'undo'
          ? `${confirm.row.name} goes back on the list as not bought.`
          : 'The bought quantities are added to Inventory and the batch is closed. Its approved requests become Store Supply tasks in the Schedule.'}
      </ConfirmBox>
    </BlockStack>
  );
}
