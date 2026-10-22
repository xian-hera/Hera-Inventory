import React, { useCallback, useEffect, useState } from 'react';
import { Card, BlockStack, Text, Button } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { StatusBadge, HoldBadge } from '../shared/transferStatus';
import { TaskTypeLabel } from '../shared/priceChangeShared';
import { DDList, DDFull } from '../shared/ddPill';

// Store › Dashboard (2026-10-22, Hera — claude/STORE_DASHBOARD_AND_LINE_NOTES.md).
// Everything the store has to deal with today, in four cards (a card with
// nothing in it is not shown):
//   Incoming Delivery — POs sent to store that have a DD pill (until the
//     store submits its count), transfers TO this store that are In transit /
//     Receiving and have a DD pill, and WH custom tasks to this store (TBD or
//     DD today or later).
//   Inventory Count  — Weekly Inventory Count tasks not submitted yet.
//   Price Change     — price change tasks (parts) not marked Done yet.
//   Prepare to Send  — transfers FROM this store in Draft / Pending / Ready
//     to Ship.
// Rows look like the matching Tasks page rows, without table headers. Every
// detail page opened from here comes back here (state.from).
//
// useStoreDashboard() loads it all; ManagerHome uses `hasContent` to decide
// which tab to open first.

export const DASHBOARD_BACK = '/manager?tab=dashboard';

const TYPE_LABEL_MAP = { 'Hair & Skin Care': 'Care', 'Tools & Accessories': 'Tools + Acc.' };
const typeDisplay = (type) => TYPE_LABEL_MAP[type] || type;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}.${MONTHS[d.getMonth()]}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function formatDateCompact(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const yearPrefix = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}.`;
  return `${yearPrefix}${MONTHS[d.getMonth()]}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const EMPTY = { pos: [], incoming: [], custom: [], counts: [], prices: [], sending: [] };

async function getJson(url, options) {
  const r = await fetch(url, options);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
  return d;
}

export function useStoreDashboard(location) {
  const [state, setState] = useState({ loading: !!location, error: '', data: EMPTY });

  const load = useCallback(async (quiet = false) => {
    if (!location) { setState({ loading: false, error: '', data: EMPTY }); return; }
    if (!quiet) setState(s => ({ ...s, loading: true, error: '' }));
    const loc = encodeURIComponent(location);
    try {
      const [poList, home, custom, counts, prices] = await Promise.all([
        getJson(`/api/po-invoices/manager/receiving?location=${loc}`),
        getJson(`/api/transfers/manager/home?location=${loc}`),
        getJson(`/api/warehouse/store-custom?location=${loc}`).catch(() => []),
        getJson(`/api/tasks?status=counting&location=${loc}`),
        getJson(`/api/price-change-tasks/manager?location=${loc}`).catch(() => []),
      ]);
      const receiving = (home && home.receiving) || [];
      const sending = (home && home.sending) || [];
      const pos = Array.isArray(poList) ? poList : [];
      const transferIds = [...receiving, ...sending].map(t => t.id);
      const dd = (pos.length || transferIds.length)
        ? await getJson('/api/warehouse/dd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poIds: pos.map(p => p.id), transferIds }),
        }).catch(() => ({ pos: {}, transfers: {} }))
        : { pos: {}, transfers: {} };
      const poDD = (id) => ((dd.pos && dd.pos[id]) || {}).entries || [];
      const trDD = (id) => (((dd.transfers && dd.transfers[id]) || {}).entries || []).filter(e => e.location === location);
      const data = {
        pos: pos.filter(p => poDD(p.id).length > 0).map(p => ({ ...p, dd: poDD(p.id) })),
        incoming: receiving
          .filter(t => (t.status === 'in_transit' || t.status === 'receiving') && trDD(t.id).length > 0)
          .map(t => ({ ...t, dd: trDD(t.id) })),
        custom: Array.isArray(custom) ? custom : [],
        counts: Array.isArray(counts) ? counts : [],
        prices: (Array.isArray(prices) ? prices : []).filter(t => t.location_status === 'pending'),
        sending: sending
          .filter(t => ['loading', 'pending', 'good_to_go'].includes(t.status))
          .map(t => ({ ...t, dd: trDD(t.id) })),
      };
      setState({ loading: false, error: '', data });
    } catch (e) {
      setState({ loading: false, error: e.message, data: EMPTY });
    }
  }, [location]);

  useEffect(() => { load(); }, [load]);

  const d = state.data;
  const hasContent = d.pos.length + d.incoming.length + d.custom.length + d.counts.length + d.prices.length + d.sending.length > 0;
  return { ...state, hasContent, reload: load };
}

// ─── Rows ────────────────────────────────────────────────────────────────────

const ROW = { padding: '12px 4px', borderTop: '1px solid #f1f1f1' };
const firstRow = (i) => (i === 0 ? { ...ROW, borderTop: 'none' } : ROW);
const linkText = { fontWeight: 600, textDecoration: 'underline', cursor: 'pointer' };

function Section({ title, children }) {
  return (
    <BlockStack gap="200">
      <div className="sd-title"><Text variant="headingMd" as="h2">{title}</Text></div>
      <Card>{children}</Card>
    </BlockStack>
  );
}

// [number over grey line] · DD · right-aligned status. On a phone the
// status wraps to its own line and stays right-aligned (margin-left: auto).
function TransferRow({ tr, index, onOpen }) {
  return (
    <div style={{ ...firstRow(index), cursor: 'pointer' }} onClick={onOpen}>
      <div className="sd-row">
        <div className="sd-first">
          <span style={linkText}>{tr.shopify_transfer_name || tr.transfer_no}</span>
          <Text tone="subdued" variant="bodySm">{tr.from_location} to {tr.to_location}</Text>
        </div>
        <div className="sd-mid"><DDList full entries={tr.dd} /></div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <StatusBadge status={tr.status} />
          {tr.on_hold && <HoldBadge />}
        </div>
      </div>
    </div>
  );
}

function ManagerDashboard({ location, dashboard }) {
  const navigate = useNavigate();
  const { loading, error, data } = dashboard;
  const [doneLoading, setDoneLoading] = useState([]);
  const [doneKeys, setDoneKeys] = useState([]);
  const [doneError, setDoneError] = useState('');
  const open = (path) => navigate(path, { state: { from: DASHBOARD_BACK } });

  const markDone = async (taskId, part) => {
    const key = `${taskId}:${part}`;
    setDoneLoading(prev => [...prev, key]);
    setDoneError('');
    try {
      const res = await fetch(`/api/price-change-tasks/${taskId}/done`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, part }),
      });
      if (!res.ok) throw new Error('Failed to mark as done');
      // Stays in the list as "Done" until the next reload, so the click shows.
      setDoneKeys(prev => [...prev, key]);
    } catch (e) {
      setDoneError('Failed to mark task as done.');
    } finally {
      setDoneLoading(prev => prev.filter(k => k !== key));
    }
  };

  if (!location) return <Text tone="subdued">Choose a location first.</Text>;
  if (loading) return <Text tone="subdued">Loading...</Text>;
  if (error) return <Text tone="critical">{error}</Text>;

  const incomingCount = data.pos.length + data.incoming.length + data.custom.length;
  if (incomingCount + data.counts.length + data.prices.length + data.sending.length === 0) {
    return <Text tone="subdued">Nothing to handle right now.</Text>;
  }

  // Price change rows: grouped like the Label Print page (main row + "└ WIG"),
  // only the parts not Done yet; Published / Note columns left out.
  const priceGroups = [];
  {
    const byId = new Map();
    for (const t of data.prices) {
      if (!byId.has(t.id)) { byId.set(t.id, { id: t.id, main: null, wig: null }); priceGroups.push(byId.get(t.id)); }
      byId.get(t.id)[(t.part || 'main') === 'wig' ? 'wig' : 'main'] = t;
    }
  }
  const doneCell = (t) => {
    const part = t.part || 'main';
    const key = `${t.id}:${part}`;
    if (doneKeys.includes(key)) return <Text tone="success" fontWeight="medium">Done</Text>;
    return (
      <Button size="slim" tone="success" loading={doneLoading.includes(key)} onClick={() => markDone(t.id, part)}>
        Done
      </Button>
    );
  };
  const typesText = (t) => ((t.item_types || []).filter(Boolean).join(', ') || '-');

  let incomingIdx = 0;
  return (
    <BlockStack gap="500">
      <style>{`
        .sd-row { display: flex; flex-wrap: wrap; align-items: center; column-gap: 12px; row-gap: 6px; }
        .sd-first { flex: 0 0 34%; min-width: 0; display: flex; flex-direction: column; }
        .sd-mid { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
        .sd-po-date { flex: 0 0 auto; min-width: 150px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
        .sd-po-qty { flex: 1 1 60px; text-align: center; }
        .sd-po-ratio { flex: 0 0 60px; text-align: right; }
        .sd-po-dd-mobile { display: none; }
        .sd-date-mobile { display: none; }
        .sd-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .sd-table td { padding: 10px 6px; vertical-align: middle; border-top: 1px solid #f1f1f1; }
        .sd-table tr:first-child td { border-top: none; }
        .sd-title { padding-left: 4px; }
        @media (max-width: 767px) {
          .sd-title { padding-left: 16px; }
          .sd-first { flex: 0 1 auto; }
          .sd-row.sd-po { flex-wrap: nowrap; column-gap: 6px; }
          .sd-po .sd-first { flex: 1 1 90px; }
          .sd-po-date { min-width: 0; flex: 0 0 auto; }
          .sd-po-date .sd-dd-desktop { display: none; }
          .sd-date-desktop { display: none; }
          .sd-date-mobile { display: inline; }
          .sd-po-qty { flex: 0 0 auto; }
          .sd-po-ratio { flex: 0 0 40px; }
          .sd-po-dd-mobile { display: flex; justify-content: flex-start; margin-top: 6px; }
          .sd-table td { padding: 10px 4px; }
        }
      `}</style>
      {doneError && <Text tone="critical">{doneError}</Text>}

      {incomingCount > 0 && (
        <Section title="Incoming Delivery">
          {data.pos.map(inv => (
            <div key={`po-${inv.id}`} style={{ ...firstRow(incomingIdx++), cursor: 'pointer' }}
              onClick={() => open(`/manager/po-receiving/${inv.id}`)}>
              <div className="sd-row sd-po">
                <div className="sd-first">
                  <span style={{ ...linkText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.po_number || inv.invoice_number}</span>
                  <Text tone="subdued" variant="bodySm" truncate>{inv.supplier_name}</Text>
                </div>
                <div className="sd-po-date">
                  <Text variant="bodySm" tone="subdued">
                    <span className="sd-date-desktop">{formatDate(inv.sent_to_store_at)}</span>
                    <span className="sd-date-mobile">{formatDateCompact(inv.sent_to_store_at)}</span>
                  </Text>
                  <div className="sd-dd-desktop"><DDList full entries={inv.dd} /></div>
                </div>
                <div className="sd-po-qty"><Text variant="bodySm" tone="subdued">Qty: {inv.total_quantity}</Text></div>
                <div className="sd-po-ratio">
                  <Text variant="bodySm" fontWeight="medium" alignment="end"
                    tone={Number(inv.counted_lineitems) >= Number(inv.total_lineitems) ? 'success' : 'subdued'}>
                    {inv.counted_lineitems}/{inv.total_lineitems}
                  </Text>
                </div>
              </div>
              {/* Phone: the DD on its own line under the row. */}
              <div className="sd-po-dd-mobile"><DDList full entries={inv.dd} /></div>
            </div>
          ))}
          {data.incoming.map(tr => (
            <TransferRow key={`tr-${tr.id}`} tr={tr} index={incomingIdx++}
              onOpen={() => open(`/manager/transfer/receiving/${tr.id}`)} />
          ))}
          {data.custom.map(c => (
            <div key={`c-${c.id}`} style={firstRow(incomingIdx++)}>
              <div className="sd-row">
                <div className="sd-first">
                  <Text fontWeight="semibold">{c.type || 'Custom'}</Text>
                  <Text tone="subdued" variant="bodySm">{c.title}</Text>
                </div>
                <div className="sd-mid"><DDFull entry={c.entry} /></div>
              </div>
            </div>
          ))}
        </Section>
      )}

      {data.counts.length > 0 && (
        <Section title="Inventory Count">
          <div style={{ overflowX: 'auto' }}>
            <table className="sd-table">
              <tbody>
                {data.counts.map(task => (
                  <tr key={task.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span style={linkText} onClick={() => open(`/manager/counting-tasks/${task.id}`)}>{task.task_no}</span>
                    </td>
                    <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: 160 }}>
                      {Array.isArray(task.types) && task.types.length > 0 ? task.types.map(typeDisplay).join(', ') : '-'}
                    </td>
                    <td>{task.inaccurate_count > 0 ? `${task.inaccurate_count} off qty` : ''}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className="sd-date-desktop">{formatDate(task.created_at)}</span>
                      <span className="sd-date-mobile">{formatDateCompact(task.created_at)}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>{`${task.processed_count || 0}/${task.total_count || 0}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {priceGroups.length > 0 && (
        <Section title="Price Change">
          <div style={{ overflowX: 'auto' }}>
            <table className="sd-table">
              <tbody>
                {priceGroups.flatMap(g => {
                  const head = g.main || g.wig;
                  const onlyWig = !g.main && !!g.wig;
                  const mainUrl = `/manager/price-change/${g.id}${onlyWig ? '?part=wig' : g.wig ? '?part=main' : ''}`;
                  const rows = [(
                    <tr key={`${g.id}-h`}>
                      <td><span style={linkText} onClick={() => open(mainUrl)}>{head.task_no}</span></td>
                      <td><TaskTypeLabel type={head.task_type} fallback={head.label_type || 'Regular price'} /></td>
                      <td>{onlyWig ? <span style={{ color: '#d72c0d', fontWeight: 700 }}>WIG</span> : typesText(head)}</td>
                      <td>{String(head.item_count || 0)}</td>
                      <td style={{ textAlign: 'right' }}>{doneCell(head)}</td>
                    </tr>
                  )];
                  if (g.main && g.wig) {
                    rows.push(
                      <tr key={`${g.id}-w`}>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: 8 }}>
                            <span style={{ color: '#6d7175' }}>└</span>
                            <span style={linkText} onClick={() => open(`/manager/price-change/${g.id}?part=wig`)}>WIG</span>
                          </span>
                        </td>
                        <td /><td />
                        <td>{String(g.wig.item_count || 0)}</td>
                        <td style={{ textAlign: 'right' }}>{doneCell(g.wig)}</td>
                      </tr>
                    );
                  }
                  return rows;
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {data.sending.length > 0 && (
        <Section title="Prepare to Send">
          {data.sending.map((tr, i) => (
            <TransferRow key={tr.id} tr={tr} index={i}
              onOpen={() => open(`/manager/transfer/sending/${tr.id}`)} />
          ))}
        </Section>
      )}
    </BlockStack>
  );
}

export default ManagerDashboard;
