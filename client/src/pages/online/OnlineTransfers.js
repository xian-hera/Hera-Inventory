import React, { useState, useEffect, useCallback } from 'react';
import { Page, BlockStack, Card, Text, Banner, Button, InlineStack } from '@shopify/polaris';
import { StatusBadge } from '../shared/transferStatus';

// Online › Transfer (2026-10-23, Hera — claude/FULFILLER_ONLINE_TRANSFER_SPEC.md).
// Every Online (Fulfiller) transfer that is Preparing / Ready to Ship / In
// Transit, one card each. Online is the Admin of these transfers (Purchasing
// never sees them):
//   • Transfer number → the Shopify transfer page; Title → the product page;
//     Order Number → the order page (orders come from Fulfiller);
//   • Delete Transfer in Hub → gone from Hub (store, WH Delivery, this tab);
//     the Shopify transfer is not touched;
//   • Delete Selected → removes the rows from the Shopify transfer and Hub.
//     Preparing: any row; Ready to Ship / In Transit: rows with Picked Qty 0.

const LINK = { color: '#005bd3', textDecoration: 'underline' };
const TH = { padding: '8px 10px', textAlign: 'left', color: '#6d7175', fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid #e1e3e5' };
const TD = { padding: '10px', borderBottom: '1px solid #f1f1f1', verticalAlign: 'top' };

function TransferCard({ t, onChanged, setError }) {
  const [sel, setSel] = useState([]);
  const [busy, setBusy] = useState(false);
  const canDeleteRow = (r) => t.status === 'loading' || r.picked === 0;
  const selectable = t.rows.filter(canDeleteRow).map(r => r.rowId);
  const allOn = selectable.length > 0 && selectable.every(id => sel.includes(id));
  const toggle = (id) => setSel(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const deleteTransfer = async () => {
    if (!window.confirm(`Delete ${t.shopify_transfer_name || t.transfer_no} from Hub?\n\nThe store and the WH Delivery won't see it any more. The Shopify transfer is not changed; Fulfiller is told.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/online-transfers/${t.id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Delete failed');
      await onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  // 2026-10-24 (Hera): push a transfer on when the store forgot Ready to Ship
  // or the driver forgot Picked Up.
  const advance = async (step) => {
    const name = t.shopify_transfer_name || t.transfer_no;
    const msg = step === 'ready-to-ship'
      ? `Mark ${name} as Ready to Ship?\n\nLines the store hasn't picked count as the requested qty.`
      : `Mark ${name} as In Transit?\n\nIt counts as picked up by the driver${t.status === 'loading' ? ' (it is marked Ready to Ship first; lines the store hasn\'t picked count as the requested qty)' : ''}.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/online-transfers/${t.id}/${step}`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed');
      await onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const deleteRows = async () => {
    if (sel.length === 0) return;
    if (!window.confirm(`Delete ${sel.length} row${sel.length === 1 ? '' : 's'}? They are removed from the Shopify transfer too.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/online-transfers/${t.id}/delete-rows`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowIds: sel }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Delete failed');
      setSel([]);
      await onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
          <InlineStack gap="300" blockAlign="center" wrap>
            {t.shopify_transfer_url
              ? <a href={t.shopify_transfer_url} target="_blank" rel="noreferrer" style={{ ...LINK, fontSize: 20, fontWeight: 600 }}>{t.shopify_transfer_name || t.transfer_no}</a>
              : <span style={{ fontSize: 20, fontWeight: 600 }}>{t.shopify_transfer_name || t.transfer_no}</span>}
            <span style={{ fontSize: 16 }}>{t.from_location}</span>
            <StatusBadge status={t.status} />
            {t.needs_reassign_at && <span style={{ fontSize: 12, fontWeight: 650, color: '#8e1f1f' }}>Waiting for a new stop from Fulfiller</span>}
          </InlineStack>
          <InlineStack gap="200" wrap>
            <Button onClick={() => advance('ready-to-ship')} disabled={busy || t.status !== 'loading'}>Mark as Ready to Ship</Button>
            <Button onClick={() => advance('in-transit')} disabled={busy || !['loading', 'good_to_go'].includes(t.status)}>Mark as In Transit</Button>
            <Button tone="critical" variant="primary" onClick={deleteTransfer} disabled={busy}>Delete Transfer in Hub</Button>
            <Button onClick={deleteRows} disabled={busy || sel.length === 0}>Delete Selected</Button>
          </InlineStack>
        </InlineStack>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: 32 }}>
                  <input type="checkbox" aria-label="Select all" checked={allOn} disabled={selectable.length === 0}
                    onChange={() => setSel(allOn ? [] : selectable)} />
                </th>
                <th style={TH}>Title</th>
                <th style={TH}>Variant</th>
                <th style={TH}>Order Number</th>
                <th style={TH}>Requested Qty</th>
                <th style={TH}>Picked Qty</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map(r => (
                <tr key={r.rowId}>
                  <td style={TD}>
                    <input type="checkbox" aria-label="Select row" checked={sel.includes(r.rowId)} disabled={!canDeleteRow(r)} onChange={() => toggle(r.rowId)} />
                  </td>
                  <td style={TD}>{r.productUrl ? <a href={r.productUrl} target="_blank" rel="noreferrer" style={LINK}>{r.title}</a> : r.title}</td>
                  <td style={TD}>{r.variant}</td>
                  <td style={TD}>{r.orderName ? (r.orderUrl ? <a href={r.orderUrl} target="_blank" rel="noreferrer" style={LINK}>{r.orderName}</a> : r.orderName) : '—'}</td>
                  <td style={TD}>{r.requested}</td>
                  <td style={{ ...TD, color: r.picked != null && r.picked !== r.requested ? '#d72c0d' : undefined }}>{r.picked == null ? '' : r.picked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </BlockStack>
    </Card>
  );
}

function OnlineTransfers({ inTabs = false } = {}) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/online-transfers');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load');
      setList(d);
    } catch (e) { setError(e.message); setList(prev => prev || []); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    // Normal page width like the other Online tabs (was fullWidth, which put
    // the content at the far left under the centred tab bar — Hera 2026-10-24).
    <Page title={inTabs ? undefined : 'Online Transfers'}>
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {list === null ? <Text tone="subdued">Loading...</Text>
          : list.length === 0 ? <Text tone="subdued">No Online transfers right now.</Text>
          : list.map(t => <TransferCard key={t.id} t={t} onChanged={load} setError={setError} />)}
      </BlockStack>
    </Page>
  );
}

export default OnlineTransfers;
