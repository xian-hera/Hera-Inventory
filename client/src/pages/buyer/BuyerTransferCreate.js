import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, Spinner, TextField, Tooltip
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function BuyerTransferCreate() {
  const navigate = useNavigate();
  const csvInputRef = useRef(null);
  const orderCounter = useRef(0);

  // Card 1
  const [locations, setLocations] = useState([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [tagOptions, setTagOptions] = useState([]); // from the Settings tag pool
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [referenceName, setReferenceName] = useState('');
  const [selectedTags, setSelectedTags] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState('');

  // Note
  const [note, setNote] = useState(null);
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  // Line items
  const [items, setItems] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [csvError, setCsvError] = useState('');
  const [csvLoading, setCsvLoading] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    fetch('/api/shopify/locations')
      .then(r => r.json())
      .then(data => setLocations(Array.isArray(data) ? data : []))
      .catch(() => setLocations([]))
      .finally(() => setLocationsLoading(false));
    fetch('/api/transfers/tags')
      .then(r => r.json())
      .then(data => setTagOptions(Array.isArray(data) ? data.map(t => t.tag) : []))
      .catch(() => setTagOptions([]));
  }, []);

  const fromLocation = locations.find(l => l.id === fromLocationId);
  const toLocation = locations.find(l => l.id === toLocationId);

  const handleDiscard = () => {
    if (!window.confirm('Discard this transfer? Nothing typed here has been saved, and this cannot be undone.')) return;
    navigate('/buyer/transfer');
  };

  const handleConfirm = () => {
    if (!fromLocationId || !toLocationId) {
      setConfirmError('From and To locations are required.');
      return;
    }
    if (fromLocationId === toLocationId) {
      setConfirmError('From and To must be different locations.');
      return;
    }
    setConfirmError('');
    setConfirmed(true);
  };

  const toggleTag = (tag) => {
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const nextOrder = () => { orderCounter.current += 1; return orderCounter.current; };

  const addItem = (data, source, transferQty) => {
    setItems(prev => {
      if (prev.some(i => i.sku === data.sku)) return prev; // already in the list
      return [...prev, {
        key: `${source}-${data.sku}-${nextOrder()}`,
        sku: data.sku,
        name: data.name,
        fromQty: data.fromQty,
        toQty: data.toQty,
        inventoryItemId: data.inventoryItemId,
        transferQty,
        source,
        order: orderCounter.current,
      }];
    });
  };

  const updateTransferQty = (key, value) => {
    const qty = value === '' ? '' : Math.max(0, parseInt(value, 10) || 0);
    setItems(prev => prev.map(i => i.key === key ? { ...i, transferQty: qty } : i));
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
  const handleCSVUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    setCsvError('');

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const lines = evt.target.result.split('\n').filter(l => l.trim());
      if (lines.length < 2) { setCsvError('CSV must have a header row and at least one data row.'); return; }

      const header = lines[0].split(',').map(c => c.trim().replace(/"/g, '').toLowerCase());
      const skuCol = header.indexOf('sku');
      const qtyCol = header.findIndex(h => h === 'quantity' || h === 'qty');
      if (skuCol === -1 || qtyCol === -1) {
        setCsvError('CSV must have a header row with SKU and Quantity columns.');
        return;
      }

      const rows = lines.slice(1).map(l => l.split(',').map(c => c.trim().replace(/"/g, '')));
      setCsvLoading(true);
      const failed = [];

      for (const row of rows) {
        const sku = row[skuCol];
        const qty = parseInt(row[qtyCol], 10);
        if (!sku || !Number.isFinite(qty)) { failed.push(row[skuCol] || '(blank)'); continue; }
        try {
          const res = await fetch(
            `/api/shopify/inventory-by-sku?sku=${encodeURIComponent(sku)}&fromLocationId=${encodeURIComponent(fromLocationId)}&toLocationId=${encodeURIComponent(toLocationId)}`
          );
          if (!res.ok) { failed.push(sku); continue; }
          const data = await res.json();
          addItem(data, 'csv', qty);
        } catch {
          failed.push(sku);
        }
      }

      if (failed.length > 0) setCsvError(`${failed.length} SKU(s) not found or failed: ${failed.join(', ')}`);
      setCsvLoading(false);
    };
    reader.readAsText(file);
  };

  // ── Search ───────────────────────────────────────────────────────────────
  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError('');
    try {
      const res = await fetch(`/api/shopify/search?q=${encodeURIComponent(searchQuery.trim())}`);
      const data = await res.json();
      setSearchResults(data.results || []);
      setSearchOpen(true);
    } catch {
      setSearchError('Search failed.');
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  const handleAddFromSearch = async (result) => {
    try {
      const res = await fetch(
        `/api/shopify/inventory-by-sku?sku=${encodeURIComponent(result.barcode)}&fromLocationId=${encodeURIComponent(fromLocationId)}&toLocationId=${encodeURIComponent(toLocationId)}`
      );
      if (!res.ok) { setSearchError(`Could not load ${result.barcode}.`); return; }
      const data = await res.json();
      addItem(data, 'search', 1);
    } catch {
      setSearchError(`Could not load ${result.barcode}.`);
    }
  };

  // ── Create ───────────────────────────────────────────────────────────────
  const sortedItems = [...items].sort((a, b) => {
    const aViol = Number(a.transferQty) > Number(a.fromQty) ? 1 : 0;
    const bViol = Number(b.transferQty) > Number(b.fromQty) ? 1 : 0;
    if (aViol !== bViol) return bViol - aViol;
    const aSrc = a.source === 'search' ? 1 : 0;
    const bSrc = b.source === 'search' ? 1 : 0;
    if (aSrc !== bSrc) return bSrc - aSrc;
    return b.order - a.order;
  });

  const hasOverStock = items.some(i => Number(i.transferQty) > Number(i.fromQty));

  const handleCreate = async () => {
    if (items.length === 0) { setCreateError('Add at least one line item.'); return; }
    if (hasOverStock) { setCreateError('Fix the highlighted line item(s) — transfer qty exceeds available quantity.'); return; }

    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromLocationId,
          fromLocationName: fromLocation?.name,
          toLocationId,
          toLocationName: toLocation?.name,
          referenceName: referenceName || null,
          tags: selectedTags,
          note,
          items: items.map(i => ({
            sku: i.sku, name: i.name, inventoryItemId: i.inventoryItemId,
            quantity: i.transferQty, fromQty: i.fromQty,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create transfer');
      navigate('/buyer/transfer');
    } catch (e) {
      setCreateError(e.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Page
      title="Create transfer"
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
                  {locationsLoading ? (
                    <InlineStack align="center"><Spinner size="small" /></InlineStack>
                  ) : (
                    <InlineStack gap="400" wrap align="start">
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">From</Text>
                        <select
                          value={fromLocationId}
                          onChange={e => setFromLocationId(e.target.value)}
                          style={SELECT_STYLE}
                        >
                          <option value="">Location</option>
                          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                      </BlockStack>
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">To</Text>
                        <select
                          value={toLocationId}
                          onChange={e => setToLocationId(e.target.value)}
                          style={SELECT_STYLE}
                        >
                          <option value="">Location</option>
                          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                      </BlockStack>
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">Reference name</Text>
                        <TextField
                          label=""
                          labelHidden
                          value={referenceName}
                          onChange={setReferenceName}
                          placeholder="name"
                          autoComplete="off"
                        />
                      </BlockStack>
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">Tags</Text>
                        <InlineStack gap="150" wrap>
                          {selectedTags.map(tag => (
                            <span key={tag} style={TAG_CHIP_STYLE}>
                              {tag}
                              <span style={{ cursor: 'pointer', marginLeft: '6px' }} onClick={() => toggleTag(tag)}>×</span>
                            </span>
                          ))}
                        </InlineStack>
                        <InlineStack gap="150" wrap>
                          {tagOptions.filter(t => !selectedTags.includes(t)).map(tag => (
                            <span key={tag} style={TAG_OPTION_STYLE} onClick={() => toggleTag(tag)}>
                              {tag}
                            </span>
                          ))}
                        </InlineStack>
                      </BlockStack>
                      <Button variant="primary" onClick={handleConfirm}>Confirm</Button>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>
            ) : (
              <InlineStack gap="400" wrap>
                <Text variant="bodySm" tone="subdued">From: {fromLocation?.name}</Text>
                <Text variant="bodySm" tone="subdued">To: {toLocation?.name}</Text>
                {referenceName && <Text variant="bodySm" tone="subdued">Reference: {referenceName}</Text>}
                {selectedTags.length > 0 && <Text variant="bodySm" tone="subdued">Tags: {selectedTags.join(', ')}</Text>}
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
                  {note === null && !noteEditing && (
                    <Button onClick={openAddNote}>Add note</Button>
                  )}
                  <Tooltip content="MUST has header, MUST has 2 columns, SKU and Quantity.">
                    <Button onClick={() => csvInputRef.current.click()} loading={csvLoading}>
                      Upload CSV
                    </Button>
                  </Tooltip>
                  <input
                    type="file" accept=".csv" ref={csvInputRef}
                    style={{ display: 'none' }} onChange={handleCSVUpload}
                  />
                  <div style={{ minWidth: '220px' }}>
                    <TextField
                      label=""
                      labelHidden
                      placeholder="SKU, Name"
                      value={searchQuery}
                      onChange={setSearchQuery}
                      onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                      autoComplete="off"
                    />
                  </div>
                  <Button onClick={runSearch} loading={searchLoading}>Search</Button>
                  <Button variant="primary" onClick={handleCreate} loading={creating}>Create</Button>
                </InlineStack>

                {csvError && <Text tone="critical" variant="bodySm">{csvError}</Text>}
                {searchError && <Text tone="critical" variant="bodySm">{searchError}</Text>}

                {searchOpen && (
                  <Card>
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text variant="bodySm" fontWeight="medium">Search results</Text>
                        <span style={{ cursor: 'pointer' }} onClick={() => setSearchOpen(false)}>✕</span>
                      </InlineStack>
                      {searchResults.length === 0 ? (
                        <Text tone="subdued" variant="bodySm">No matches.</Text>
                      ) : (
                        searchResults.map(r => (
                          <InlineStack key={r.variantId} align="space-between" blockAlign="center">
                            <Text variant="bodySm">{r.barcode} — {r.name}</Text>
                            <Button size="slim" onClick={() => handleAddFromSearch(r)}>Add</Button>
                          </InlineStack>
                        ))
                      )}
                    </BlockStack>
                  </Card>
                )}

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
                    <Text tone="subdued">No line items yet — upload a CSV or search to add some.</Text>
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
                            <th style={TH_STYLE}>SKU</th>
                            <th style={TH_STYLE}>Name</th>
                            <th style={TH_STYLE}>{fromLocation?.name || 'From'} qty</th>
                            <th style={TH_STYLE}>{toLocation?.name || 'To'} qty</th>
                            <th style={TH_STYLE}>Transfer qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedItems.map(it => {
                            const violates = Number(it.transferQty) > Number(it.fromQty);
                            return (
                              <tr
                                key={it.key}
                                style={{ borderBottom: '1px solid #f1f1f1', background: violates ? '#fdeceb' : undefined }}
                              >
                                <td style={TD_STYLE}>
                                  <input
                                    type="checkbox"
                                    checked={selectedKeys.includes(it.key)}
                                    onChange={() => toggleSelectItem(it.key)}
                                  />
                                </td>
                                <td style={TD_STYLE}>{it.sku}</td>
                                <td style={TD_STYLE}>{it.name || '-'}</td>
                                <td style={{ ...TD_STYLE, color: violates ? '#d72c0d' : undefined, fontWeight: violates ? 700 : undefined }}>
                                  {it.fromQty}
                                </td>
                                <td style={TD_STYLE}>{it.toQty}</td>
                                <td style={TD_STYLE}>
                                  <input
                                    type="number"
                                    min="0"
                                    value={it.transferQty}
                                    onChange={e => updateTransferQty(it.key, e.target.value)}
                                    style={{
                                      width: '72px', padding: '4px 6px', borderRadius: '6px',
                                      border: '1px solid #c9cccf', fontSize: '13px',
                                      color: violates ? '#d72c0d' : undefined,
                                      fontWeight: violates ? 700 : undefined,
                                    }}
                                  />
                                </td>
                              </tr>
                            );
                          })}
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

const TAG_CHIP_STYLE = {
  display: 'inline-flex', alignItems: 'center',
  padding: '2px 8px', borderRadius: '12px',
  background: '#e4e5e7', fontSize: '12px', cursor: 'default',
};

const TAG_OPTION_STYLE = {
  display: 'inline-flex', alignItems: 'center',
  padding: '2px 8px', borderRadius: '12px',
  background: '#f1f2f3', fontSize: '12px', cursor: 'pointer',
};

const TH_STYLE = { padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' };
const TD_STYLE = { padding: '10px' };

export default BuyerTransferCreate;
