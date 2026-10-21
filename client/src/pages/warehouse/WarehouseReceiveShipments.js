import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Page, Layout, Card, BlockStack, InlineStack, Text, Button, Banner, Modal, TextField, Select } from '@shopify/polaris';
import {
  HQ, RoutePills, LinkText, PoPopup, PoDetailContent, useIsPhone, useToast, refreshWarehouseBadges,
} from './whShared';

// Warehouse › Receive Shipments (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §8).
// Every PO created after go-live waits here until the supplier delivers it
// to HQ. WH then marks it Received (it leaves this page and becomes an
// Unscheduled task on the Schedule) or deletes it (WH never sees it again;
// the PO itself is untouched for Purchasing / Store).
// Mainly used on iPad; on a phone the table folds into 4 columns.

const TH = { padding: '10px 8px', textAlign: 'left', color: '#6d7175', fontWeight: 500, fontSize: 13, borderBottom: '1px solid #c9cccf' };
const TD = { padding: '12px 8px', fontSize: 13, borderBottom: '1px solid #e1e3e5', verticalAlign: 'middle' };

function ReceivedButton({ onClick, disabled, children = 'Received' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        border: 'none', borderRadius: 999, background: disabled ? '#9bcfa6' : '#2e9e44', color: '#fff',
        padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  );
}

// Pallet / Box switch — same look as the PB qty switch on Purchasing's PO page.
function PbSwitch({ mode, onChange }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        role="switch"
        aria-checked={mode === 'B'}
        aria-label="Switch between Pallet and Box"
        onClick={() => onChange(mode === 'P' ? 'B' : 'P')}
        style={{
          width: 36, height: 20, borderRadius: 10, border: 'none', padding: 0, position: 'relative',
          background: mode === 'B' ? '#303030' : '#8a8a8a', cursor: 'pointer', flex: '0 0 auto',
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: mode === 'B' ? 19 : 3, width: 14, height: 14,
          borderRadius: '50%', background: 'white', transition: 'left 0.15s',
        }} />
      </button>
      <span style={{ fontSize: 14, color: '#303030', minWidth: 44 }}>{mode === 'B' ? 'Box' : 'Pallet'}</span>
    </span>
  );
}

function parsePb(text) {
  const m = /^\s*(\d+)\s*([PB])\s*$/i.exec(String(text || ''));
  return m ? { qty: m[1], mode: m[2].toUpperCase() } : { qty: '', mode: 'P' };
}

function ReceiveModal({ po, onClose, onDone }) {
  const initial = parsePb(po.pb_effective);
  const [mode, setMode] = useState(initial.mode);
  const [qty, setQty] = useState(initial.qty);
  const [showItems, setShowItems] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if ((!qty || /^0+$/.test(qty)) && !window.confirm(`${po.po_number} has no P / B qty. Mark it as Received without a P / B qty?`)) return;
    setSaving(true);
    setError('');
    try {
      const r = await fetch(`/api/warehouse/receive-shipments/${po.id}/receive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, qty }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to mark as Received');
      onDone(`${po.po_number} received`);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Receive shipment" size="small">
      <Modal.Section>
        <BlockStack gap="400">
          {error && <Banner tone="critical">{error}</Banner>}
          <InlineStack gap="200" blockAlign="center" wrap>
            <LinkText onClick={() => setShowItems(v => !v)} title="Show the PO content">{po.po_number}</LinkText>
            <RoutePills from={HQ} to={po.location} />
          </InlineStack>
          <Text variant="headingLg" as="p">{po.supplier_name}</Text>
          {showItems && (
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #e1e3e5', borderRadius: 8, padding: 8 }}>
              <PoDetailContent invoiceId={po.id} />
            </div>
          )}
          <InlineStack gap="300" blockAlign="center" wrap>
            <PbSwitch mode={mode} onChange={setMode} />
            <div style={{ width: 120 }}>
              <TextField
                label="P / B qty"
                labelHidden
                value={qty}
                onChange={(v) => setQty(String(v).replace(/\D/g, ''))}
                inputMode="numeric"
                autoComplete="off"
                placeholder="qty"
              />
            </div>
          </InlineStack>
          <InlineStack align="end" gap="200">
            <Button onClick={onClose} disabled={saving}>Cancel</Button>
            <ReceivedButton onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Received'}</ReceivedButton>
          </InlineStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function WarehouseReceiveShipments() {
  const phone = useIsPhone();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState([]);
  const [sortBy, setSortBy] = useState('date');
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(null); // PO row in the Received modal
  const [popup, setPopup] = useState(null); // { id, number }
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/warehouse/receive-shipments');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load');
      setRows(Array.isArray(d) ? d : []);
      setSelected(prev => prev.filter(id => d.some(x => x.id === id)));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => {
    const list = [...rows];
    if (sortBy === 'supplier') {
      list.sort((a, b) => String(a.supplier_name || '').localeCompare(String(b.supplier_name || ''), undefined, { sensitivity: 'base' })
        || new Date(a.created_at) - new Date(b.created_at));
    } else {
      list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);
    }
    return list;
  }, [rows, sortBy]);

  const allSelected = rows.length > 0 && selected.length === rows.length;
  const toggle = (id) => setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const toggleAll = () => setSelected(allSelected ? [] : rows.map(r => r.id));

  const afterChange = async (msg) => {
    await load();
    refreshWarehouseBadges();
    if (msg) showToast(msg);
  };

  const deleteSelected = async () => {
    const n = selected.length;
    if (!n) return;
    if (!window.confirm(`Delete ${n} PO${n > 1 ? 's' : ''} from Receive Shipments?\n\nWarehouse will not see ${n > 1 ? 'them' : 'it'} again (not here and not on the Schedule). The PO itself is not changed for Purchasing or Store.`)) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/warehouse/receive-shipments/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selected }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to delete');
      setSelected([]);
      await afterChange(`${d.deleted} PO${d.deleted === 1 ? '' : 's'} deleted`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const receiveSelected = async () => {
    const n = selected.length;
    if (!n) return;
    if (!window.confirm(`Mark ${n} PO${n > 1 ? 's' : ''} as Received?\n\nPOs received this way skip the P / B qty entry: each keeps the P / B qty it has now (it may be empty). Please confirm.`)) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/warehouse/receive-shipments/receive-many', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selected }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to mark as Received');
      setSelected([]);
      await afterChange(`${d.received} PO${d.received === 1 ? '' : 's'} received`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pbText = (r) => r.pb_effective || '-';

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* On a phone Polaris drops the page side padding (cards go edge to
                edge) — give the heading row its own 16px gutter. */}
            <div style={{ padding: phone ? '0 16px' : 0 }}>
            <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
              <Text variant="headingLg" as="h2">Receive Shipments</Text>
              <InlineStack gap="200" blockAlign="center" wrap>
                <Button tone="critical" onClick={deleteSelected} disabled={busy || selected.length === 0}>Delete Selected</Button>
                <div style={{ minWidth: 170 }}>
                  <Select
                    label="Sort"
                    labelHidden
                    value={sortBy}
                    onChange={setSortBy}
                    options={[
                      { label: 'Sorting by Date', value: 'date' },
                      { label: 'Sorting by Supplier', value: 'supplier' },
                    ]}
                  />
                </div>
                <Button onClick={receiveSelected} disabled={busy || selected.length === 0}>Mark selected as Received</Button>
              </InlineStack>
            </InlineStack>
            </div>

            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              {loading && rows.length === 0 ? (
                <Text tone="subdued">Loading...</Text>
              ) : rows.length === 0 ? (
                <Text tone="subdued">No shipments waiting.</Text>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: phone ? 'fixed' : 'auto' }}>
                  <thead>
                    <tr>
                      <th style={{ ...TH, width: 28 }}>
                        <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                      </th>
                      {phone ? (
                        <>
                          <th style={TH}>PO / Supplier</th>
                          <th style={TH}>To / P/B</th>
                          <th style={{ ...TH, width: 96 }} />
                        </>
                      ) : (
                        <>
                          <th style={TH}>PO number</th>
                          <th style={TH}>Supplier</th>
                          <th style={TH}>To Location</th>
                          <th style={TH}>P / B Qty</th>
                          <th style={TH} />
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(r => (
                      <tr key={r.id}>
                        <td style={TD}>
                          <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.po_number}`} />
                        </td>
                        {phone ? (
                          <>
                            <td style={{ ...TD, overflow: 'hidden' }}>
                              <div><LinkText onClick={() => setPopup({ id: r.id, number: r.po_number })}>{r.po_number}</LinkText></div>
                              <div style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.supplier_name}</div>
                            </td>
                            <td style={TD}>
                              <div><RoutePills from={HQ} to={r.location} /></div>
                              <div style={{ marginTop: 4 }}>{pbText(r)}</div>
                            </td>
                            <td style={{ ...TD, textAlign: 'right' }}>
                              <ReceivedButton onClick={() => setReceiving(r)} disabled={busy} />
                            </td>
                          </>
                        ) : (
                          <>
                            <td style={TD}><LinkText onClick={() => setPopup({ id: r.id, number: r.po_number })}>{r.po_number}</LinkText></td>
                            <td style={TD}>{r.supplier_name}</td>
                            <td style={TD}><RoutePills from={HQ} to={r.location} /></td>
                            <td style={TD}>{pbText(r)}</td>
                            <td style={{ ...TD, textAlign: 'right' }}>
                              <ReceivedButton onClick={() => setReceiving(r)} disabled={busy} />
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {receiving && (
        <ReceiveModal
          po={receiving}
          onClose={() => setReceiving(null)}
          onDone={async (msg) => { setReceiving(null); await afterChange(msg); }}
        />
      )}
      <PoPopup invoiceId={popup && popup.id} number={popup && popup.number} onClose={() => setPopup(null)} />
      {toast}
    </Page>
  );
}

export default WarehouseReceiveShipments;
