import React, { useState, useEffect, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, TextField, Tooltip
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { fetchLocationMap } from '../shared/locationMap';

// Create BOX PO (see claude/BOX_PO_FEATURE_SPEC.md section 2): Card1 collects
// Supplier + Total BOXES (required) + optional Date, then Confirm collapses
// it into a header line and reveals the line-item toolbar/table. Total BOXES
// vs. sum-of-line-items mismatch is a non-blocking warning (confirmed with
// Hera) — Create can still proceed.
function BuyerBoxPOCreate() {
  const navigate = useNavigate();
  const csvInputRef = useRef(null);
  const orderCounter = useRef(0);

  // Card 1
  const [suppliers, setSuppliers] = useState([]);
  const [suppliersLoading, setSuppliersLoading] = useState(true);
  const [locations, setLocations] = useState([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [supplierId, setSupplierId] = useState('');
  const [totalBoxes, setTotalBoxes] = useState('');
  const [boxDate, setBoxDate] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState('');

  // Note (Buyer-only, at most 1 — same add/delete UX as Transfer's note)
  const [note, setNote] = useState(null);
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  // Line items
  const [items, setItems] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [editingLocationKey, setEditingLocationKey] = useState(null);
  const [csvError, setCsvError] = useState('');
  const [csvLoading, setCsvLoading] = useState(false);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    fetch('/api/po-suppliers')
      .then(r => r.json())
      .then(data => setSuppliers(Array.isArray(data) ? data : []))
      .catch(() => setSuppliers([]))
      .finally(() => setSuppliersLoading(false));
    fetchLocationMap() // shared location map (2026-09-24)
      .then(data => setLocations(Array.isArray(data) ? data : []))
      .catch(() => setLocations([]))
      .finally(() => setLocationsLoading(false));
  }, []);

  const supplier = suppliers.find(s => String(s.id) === String(supplierId));

  const handleDiscard = () => {
    if (!window.confirm('Discard this BOX PO? Nothing typed here has been saved, and this cannot be undone.')) return;
    navigate('/buyer/po-receiving/box-po');
  };

  const handleConfirm = () => {
    if (!supplierId) {
      setConfirmError('Supplier is required.');
      return;
    }
    const qty = parseInt(totalBoxes, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      setConfirmError('Total BOXES is required and must be a positive number.');
      return;
    }
    setConfirmError('');
    setConfirmed(true);
  };

  const nextOrder = () => { orderCounter.current += 1; return orderCounter.current; };

  const addEmptyLine = () => {
    setItems(prev => [{
      key: `line-${nextOrder()}`,
      location: '',
      boxQty: 0,
    }, ...prev]);
  };

  const updateItemLocation = (key, value) => {
    setItems(prev => prev.map(i => i.key === key ? { ...i, location: value } : i));
  };

  const updateItemBoxQty = (key, value) => {
    const qty = value === '' ? '' : Math.max(0, parseInt(value, 10) || 0);
    setItems(prev => prev.map(i => i.key === key ? { ...i, boxQty: qty } : i));
  };

  const toggleSelectItem = (key) => {
    setSelectedKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const handleDeleteSelected = () => {
    setItems(prev => prev.filter(i => !selectedKeys.includes(i.key)));
    setSelectedKeys([]);
  };

  // ── Note ─────────────────────────────────────────────────────────────────
  const openAddNote = () => { setNoteDraft(''); setNoteEditing(true); };
  const saveNote = () => {
    if (!noteDraft.trim()) { setNoteEditing(false); return; }
    setNote(noteDraft.trim());
    setNoteEditing(false);
  };
  const deleteNote = () => setNote(null);

  // ── CSV upload ───────────────────────────────────────────────────────────
  // Header must have Location and Qty (or Quantity) columns, matched
  // case-insensitively — the tooltip on the Upload CSV button spells this out.
  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    setCsvError('');
    setCsvLoading(true);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const lines = evt.target.result.split('\n').filter(l => l.trim());
        if (lines.length < 2) { setCsvError('CSV must have a header row and at least one data row.'); return; }

        const header = lines[0].split(',').map(c => c.trim().replace(/"/g, '').toLowerCase());
        const locationCol = header.indexOf('location');
        const qtyCol = header.findIndex(h => h === 'qty' || h === 'quantity');
        if (locationCol === -1 || qtyCol === -1) {
          setCsvError('CSV must have a header row with Location and Qty columns.');
          return;
        }

        const rows = lines.slice(1).map(l => l.split(',').map(c => c.trim().replace(/"/g, '')));
        const failed = [];
        const newItems = [];
        for (const row of rows) {
          const location = row[locationCol];
          const qty = parseInt(row[qtyCol], 10);
          // Same floor-at-0 rule as the manual stepper (updateItemBoxQty) —
          // without this a negative CSV value would slip through, since
          // Number.isFinite(-5) is true.
          if (!location || !Number.isFinite(qty) || qty < 0) { failed.push(location || '(blank)'); continue; }
          newItems.push({ key: `csv-${nextOrder()}`, location, boxQty: qty });
        }
        if (newItems.length > 0) setItems(prev => [...newItems, ...prev]);
        if (failed.length > 0) setCsvError(`${failed.length} row(s) skipped (missing Location, or Qty missing/negative): ${failed.join(', ')}`);
      } finally {
        setCsvLoading(false);
      }
    };
    reader.readAsText(file);
  };

  // ── Create ───────────────────────────────────────────────────────────────
  const sumBoxQty = items.reduce((sum, i) => sum + (Number(i.boxQty) || 0), 0);

  const handleCreate = async () => {
    if (items.length === 0) { setCreateError('Add at least one line item.'); return; }
    if (items.some(i => !i.location)) { setCreateError('Every line item needs a Destination Location.'); return; }

    const qty = parseInt(totalBoxes, 10);
    // Mismatch is a non-blocking warning (confirmed with Hera) — but a Banner
    // here would flash and vanish since a successful Create immediately
    // navigates away. A synchronous confirm() dialog is the only way the
    // warning is actually seen before that navigation happens, so use the
    // same pattern already used for Discard/Delete selected in this file.
    if (sumBoxQty !== qty) {
      const proceed = window.confirm(
        `Total BOXES (${qty}) does not match the sum of line-item BOX qty (${sumBoxQty}). Create this BOX PO anyway?`
      );
      if (!proceed) return;
    }

    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch('/api/box-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId,
          supplierName: supplier?.name,
          totalBoxes: qty,
          date: boxDate || null,
          note,
          items: items.map(i => ({ location: i.location, boxQty: i.boxQty })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create BOX PO');
      navigate('/buyer/po-receiving/box-po');
    } catch (e) {
      setCreateError(e.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Page
      title="Create BOX PO"
      backAction={{ onAction: handleDiscard }}
      primaryAction={{ content: 'Discard', destructive: true, onAction: handleDiscard }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {confirmError && <Banner tone="critical" onDismiss={() => setConfirmError('')}>{confirmError}</Banner>}
            {createError && <Banner tone="critical" onDismiss={() => setCreateError('')}>{createError}</Banner>}

            {!confirmed ? (
              <Card>
                <BlockStack gap="300">
                  {(suppliersLoading) ? (
                    <InlineStack align="center"><Spinner size="small" /></InlineStack>
                  ) : (
                    <InlineStack gap="400" wrap align="start">
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">Supplier</Text>
                        <select
                          value={supplierId}
                          onChange={e => setSupplierId(e.target.value)}
                          style={SELECT_STYLE}
                        >
                          <option value="">Supplier</option>
                          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </BlockStack>
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">Total BOXES</Text>
                        <input
                          type="number"
                          min="0"
                          value={totalBoxes}
                          onChange={e => setTotalBoxes(e.target.value)}
                          placeholder="0"
                          style={NUMBER_INPUT_STYLE}
                        />
                      </BlockStack>
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">Date</Text>
                        <input
                          type="date"
                          value={boxDate}
                          onChange={e => setBoxDate(e.target.value)}
                          style={SELECT_STYLE}
                        />
                      </BlockStack>
                      <div style={{ marginLeft: 'auto' }}>
                        <BlockStack gap="100">
                          <Text variant="bodySm" tone="subdued">&nbsp;</Text>
                          <Button variant="primary" onClick={handleConfirm}>Confirm</Button>
                        </BlockStack>
                      </div>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>
            ) : (
              <InlineStack align="space-between" blockAlign="center" wrap>
                <InlineStack gap="400" wrap>
                  <Text variant="bodySm" tone="subdued">Supplier: {supplier?.name}</Text>
                  {boxDate && <Text variant="bodySm" tone="subdued">Date: {boxDate}</Text>}
                </InlineStack>
                <Text variant="bodySm" fontWeight="bold">Total BOXES {totalBoxes}</Text>
              </InlineStack>
            )}

            {confirmed && (
              <>
                <InlineStack gap="200" wrap blockAlign="center">
                  {selectedKeys.length > 0 && (
                    <Button tone="critical" onClick={handleDeleteSelected}>
                      Delete selected ({selectedKeys.length})
                    </Button>
                  )}
                  <Button onClick={addEmptyLine}>Add line</Button>
                  {note === null && !noteEditing && (
                    <Button onClick={openAddNote}>Add note</Button>
                  )}
                  <Tooltip content="Must have header, Location and Qty, which means how many boxes go to which store.">
                    <Button onClick={() => csvInputRef.current.click()} loading={csvLoading}>
                      Upload CSV
                    </Button>
                  </Tooltip>
                  <input
                    type="file" accept=".csv" ref={csvInputRef}
                    style={{ display: 'none' }} onChange={handleCSVUpload}
                  />
                  <Button variant="primary" onClick={handleCreate} loading={creating}>Create</Button>
                </InlineStack>

                {csvError && <Text tone="critical" variant="bodySm">{csvError}</Text>}

                {note !== null && (
                  <InlineStack gap="150" blockAlign="center">
                    <Text tone="subdued" variant="bodySm">{note}</Text>
                    <span style={{ cursor: 'pointer', color: '#d72c0d' }} onClick={deleteNote}>×</span>
                  </InlineStack>
                )}
                {noteEditing && (
                  <InlineStack gap="150" blockAlign="center">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label=""
                        labelHidden
                        value={noteDraft}
                        onChange={setNoteDraft}
                        placeholder="Add a note..."
                        autoComplete="off"
                        onKeyDown={(e) => { if (e.key === 'Enter') saveNote(); }}
                      />
                    </div>
                    <Button onClick={saveNote}>Save</Button>
                    <Button onClick={() => setNoteEditing(false)}>Cancel</Button>
                  </InlineStack>
                )}

                <Card>
                  {items.length === 0 ? (
                    <Text tone="subdued">No line items yet — upload a CSV or add a line.</Text>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                        <thead>
                          <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                            <th style={TH_STYLE}>
                              <input
                                type="checkbox"
                                checked={items.length > 0 && selectedKeys.length === items.length}
                                onChange={() => setSelectedKeys(selectedKeys.length === items.length ? [] : items.map(i => i.key))}
                              />
                            </th>
                            <th style={TH_STYLE}>Destination Location</th>
                            <th style={TH_STYLE}>BOX qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map(it => (
                            <tr key={it.key} style={{ borderBottom: '1px solid #f1f1f1' }}>
                              <td style={TD_STYLE}>
                                <input
                                  type="checkbox"
                                  checked={selectedKeys.includes(it.key)}
                                  onChange={() => toggleSelectItem(it.key)}
                                />
                              </td>
                              <td style={TD_STYLE}>
                                {editingLocationKey === it.key ? (
                                  <select
                                    autoFocus
                                    value={it.location}
                                    onChange={e => { updateItemLocation(it.key, e.target.value); setEditingLocationKey(null); }}
                                    onBlur={() => setEditingLocationKey(null)}
                                    style={SELECT_STYLE}
                                  >
                                    <option value="">Location</option>
                                    {locations.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
                                  </select>
                                ) : (
                                  <span
                                    style={{ cursor: 'pointer', textDecoration: 'underline dotted' }}
                                    onClick={() => setEditingLocationKey(it.key)}
                                  >
                                    {it.location || '(click to set)'}
                                  </span>
                                )}
                              </td>
                              <td style={TD_STYLE}>
                                <input
                                  type="number"
                                  min="0"
                                  value={it.boxQty}
                                  onChange={e => updateItemBoxQty(it.key, e.target.value)}
                                  style={{
                                    width: '72px', padding: '4px 6px', borderRadius: '6px',
                                    border: '1px solid #c9cccf', fontSize: '13px',
                                  }}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

const SELECT_STYLE = {
  padding: '6px 10px', borderRadius: '8px',
  border: '1px solid #c9cccf', fontSize: '14px',
  background: '#fff', cursor: 'pointer', fontFamily: 'inherit',
};

const NUMBER_INPUT_STYLE = {
  padding: '6px 10px', borderRadius: '8px',
  border: '1px solid #c9cccf', fontSize: '14px',
  fontFamily: 'inherit', width: '120px',
};

const TH_STYLE = { padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' };
const TD_STYLE = { padding: '10px' };

export default BuyerBoxPOCreate;
