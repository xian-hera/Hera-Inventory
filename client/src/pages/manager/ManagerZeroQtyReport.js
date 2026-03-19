import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Checkbox, Banner, TextField, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function computePOH(scanHistory, soh) {
  if (!scanHistory || scanHistory.length === 0) return null;
  const last = scanHistory[scanHistory.length - 1];
  if (last.type === 'correct') return soh;
  let lastCorrectIdx = -1;
  for (let i = scanHistory.length - 1; i >= 0; i--) {
    if (scanHistory[i].type === 'correct') { lastCorrectIdx = i; break; }
  }
  const relevant = lastCorrectIdx >= 0 ? scanHistory.slice(lastCorrectIdx + 1) : scanHistory;
  return relevant.reduce((sum, s) => sum + (s.type === 'counted' ? (s.value || 0) : 0), 0);
}

function resolveKey(e) {
  if (e.key && e.key !== 'Unidentified' && e.key.length === 1) {
    return e.key;
  }
  if (e.code) {
    if (e.code.startsWith('Digit')) return e.code.slice(5);
    if (e.code.startsWith('Numpad') && e.code.length === 7) return e.code.slice(6);
    if (e.code.startsWith('Key') && e.code.length === 4) {
      const ch = e.code.slice(3);
      return e.shiftKey ? ch : ch.toLowerCase();
    }
    const symbolMap = {
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
      Comma: ',', Period: '.', Slash: '/',
    };
    if (symbolMap[e.code]) return symbolMap[e.code];
  }
  return null;
}

function ManagerZeroQtyReport() {
  const navigate = useNavigate();
  const [items, setItems]               = useState([]);
  const [selectedIds, setSelectedIds]   = useState([]);
  const [error, setError]               = useState('');
  const [submitting, setSubmitting]     = useState(false);
  const [loadingItems, setLoadingItems] = useState(true);

  // Debug
  const [debugLog, setDebugLog] = useState([]);
  const addDebug = useCallback((msg) => {
    setDebugLog(prev => [`${new Date().toISOString().slice(11,23)} ${msg}`, ...prev].slice(0, 30));
  }, []);

  // Popup
  const [popupData, setPopupData]               = useState(null);
  const [popupSoh, setPopupSoh]                 = useState(null);
  const [popupScanHistory, setPopupScanHistory] = useState([]);
  const [countInput, setCountInput]             = useState('');
  const [loadingSoh, setLoadingSoh]             = useState(false);

  const barcodeBuffer = useRef('');
  const barcodeTimer  = useRef(null);
  const popupRef      = useRef(null);
  const location      = localStorage.getItem('managerLocation') || '';

  useEffect(() => { popupRef.current = popupData; }, [popupData]);

  const loadDrafts = useCallback(async () => {
    if (!location) { setLoadingItems(false); return; }
    try {
      const res  = await fetch(`/api/reports/drafts?location=${encodeURIComponent(location)}`);
      const data = await res.json();
      setItems(data);
    } catch (e) {
      setError('Failed to load items');
    } finally {
      setLoadingItems(false);
    }
  }, [location]);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  // ── Global keydown with full debug logging ─────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      const activeTag = document.activeElement?.tagName || 'none';

      // Log every single keydown event
      addDebug(`key="${e.key}" code="${e.code}" active=${activeTag} popupOpen=${!!popupRef.current}`);

      if (popupRef.current) return;
      if (['INPUT', 'TEXTAREA'].includes(activeTag)) return;

      if (e.key === 'Enter') {
        clearTimeout(barcodeTimer.current);
        const barcode = barcodeBuffer.current.trim();
        barcodeBuffer.current = '';
        addDebug(`▶ ENTER → barcode="${barcode}"`);
        if (barcode.length > 0) openPopupByBarcode(barcode);
        return;
      }

      const ch = resolveKey(e);
      addDebug(`  resolveKey → "${ch}"`);
      if (ch) {
        barcodeBuffer.current += ch;
        addDebug(`  buffer now = "${barcodeBuffer.current}"`);
        clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => {
          addDebug(`  buffer timeout, clearing "${barcodeBuffer.current}"`);
          barcodeBuffer.current = '';
        }, 500);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(barcodeTimer.current);
    };
  }, [addDebug]);

  const openPopupByBarcode = async (barcode) => {
    setLoadingSoh(true);
    setError('');
    try {
      const locRes  = await fetch('/api/shopify/locations');
      const locData = await locRes.json();
      const loc     = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');
      const res  = await fetch(`/api/shopify/inventory/${encodeURIComponent(barcode)}/${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Product not found');
      const existing = items.find(i => i.barcode === barcode);
      setPopupData({ ...data, barcode, locationId: loc.id });
      setPopupSoh(data.soh ?? 0);
      setPopupScanHistory(existing?.scan_history || []);
      setCountInput('');
    } catch (e) {
      setError(`${e.message} [barcode: "${barcode}"]`);
    } finally {
      setLoadingSoh(false);
    }
  };

  const closePopup = () => {
    setPopupData(null); setPopupSoh(null);
    setPopupScanHistory([]); setCountInput('');
  };

  const handleCorrect = () => closePopup();

  const handleSubmitCount = async () => {
    if (!popupData || !countInput) return;
    const value = parseInt(countInput);
    if (isNaN(value)) return;
    const newEntry   = { type: 'counted', value, created_at: new Date().toISOString() };
    const newHistory = [...popupScanHistory, newEntry];
    const poh        = computePOH(newHistory, popupSoh);
    try {
      const res  = await fetch('/api/reports/drafts', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          barcode: popupData.barcode, name: popupData.name,
          department: popupData.department, location,
          shopify_location_id: popupData.locationId,
          soh: popupSoh, poh, scan_history: newHistory,
        }),
      });
      const saved = await res.json();
      setItems(prev => {
        const exists = prev.find(i => i.barcode === saved.barcode);
        return exists ? prev.map(i => i.barcode === saved.barcode ? saved : i) : [...prev, saved];
      });
    } catch (e) { setError('Failed to save item'); }
    closePopup();
  };

  const handleSubmitItems = async (ids) => {
    setSubmitting(true);
    try {
      const toSubmit = items.filter(i => ids.includes(i.id));
      const res = await fetch('/api/reports/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: toSubmit }),
      });
      if (!res.ok) throw new Error('Failed to submit');
      setItems(prev => prev.filter(i => !ids.includes(i.id)));
      setSelectedIds([]);
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.length === 0) return;
    try {
      await fetch('/api/reports/drafts', { method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }) });
      setItems(prev => prev.filter(i => !selectedIds.includes(i.id)));
      setSelectedIds([]);
    } catch (e) { setError('Failed to delete'); }
  };

  const handleDeleteAll = async () => {
    if (!window.confirm('Delete all items?')) return;
    try {
      await fetch('/api/reports/drafts', { method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, location }) });
      setItems([]); setSelectedIds([]);
    } catch (e) { setError('Failed to delete'); }
  };

  const toggleSelectOne = (id) => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll = () => setSelectedIds(selectedIds.length === items.length ? [] : items.map(i => i.id));

  const rows = items.map(item => [
    <Checkbox checked={selectedIds.includes(item.id)} onChange={() => toggleSelectOne(item.id)} />,
    <div>
      <div style={{ fontSize: '14px', fontWeight: '500' }}>{item.name || '-'}</div>
      <div style={{ fontSize: '12px', color: '#6d7175' }}>{item.barcode || '-'}</div>
    </div>,
    item.soh ?? '-',
    item.poh ?? '-',
  ]);

  return (
    <Page title="0 quantity report" backAction={{ onAction: () => navigate('/manager') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            {/* ── DEBUG PANEL ── */}
            <Card>
              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text variant="bodySm" fontWeight="bold" tone="subdued">Debug log (remove after fix)</Text>
                  <Button size="slim" onClick={() => setDebugLog([])}>Clear</Button>
                </InlineStack>
                <Text variant="bodySm" tone="subdued">
                  Buffer: <strong>{barcodeBuffer.current || '(empty)'}</strong>
                </Text>
                {debugLog.length === 0
                  ? <Text variant="bodySm" tone="subdued">Scan something...</Text>
                  : debugLog.map((line, i) => (
                      <div key={i} style={{
                        fontFamily: 'monospace', fontSize: '11px',
                        color: line.includes('▶') ? '#008060' : line.includes('resolveKey → "null"') ? '#d72c0d' : '#444',
                        borderBottom: '1px solid #f0f0f0', paddingBottom: '2px'
                      }}>{line}</div>
                    ))
                }
              </BlockStack>
            </Card>
            {/* ── END DEBUG ── */}

            <Text variant="bodySm" tone="subdued">
              Scan to add items · saved for 15 days · shared across this location
            </Text>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="end" gap="200" wrap>
                  <button disabled={selectedIds.length === 0 || submitting} onClick={handleDeleteSelected}
                    style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #d72c0d',
                      background: selectedIds.length === 0 ? '#f6f6f7' : 'white',
                      color: selectedIds.length === 0 ? '#8c9196' : '#d72c0d',
                      cursor: selectedIds.length === 0 ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: '500' }}>
                    Delete selected
                  </button>
                  <button disabled={items.length === 0 || submitting} onClick={handleDeleteAll}
                    style={{ padding: '8px 16px', borderRadius: '8px', border: 'none',
                      background: items.length === 0 ? '#f6f6f7' : '#d72c0d',
                      color: items.length === 0 ? '#8c9196' : 'white',
                      cursor: items.length === 0 ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: '500' }}>
                    Delete all
                  </button>
                  <Button disabled={selectedIds.length === 0 || submitting}
                    onClick={() => handleSubmitItems(selectedIds)} loading={submitting}>
                    Submit selected
                  </Button>
                  <button disabled={items.length === 0 || submitting}
                    onClick={() => handleSubmitItems(items.map(i => i.id))}
                    style={{ padding: '8px 16px', borderRadius: '8px', border: 'none',
                      background: items.length === 0 ? '#f6f6f7' : '#008060',
                      color: items.length === 0 ? '#8c9196' : 'white',
                      cursor: items.length === 0 ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: '500' }}>
                    Submit all
                  </button>
                </InlineStack>

                {loadingItems ? <InlineStack align="center"><Spinner /></InlineStack>
                  : items.length === 0
                    ? <Text tone="subdued" alignment="center">No items yet. Scan a barcode to add.</Text>
                    : <DataTable
                        columnContentTypes={['text', 'text', 'numeric', 'numeric']}
                        headings={[
                          <Checkbox checked={selectedIds.length === items.length && items.length > 0}
                            indeterminate={selectedIds.length > 0 && selectedIds.length < items.length}
                            onChange={toggleSelectAll} />,
                          'Name / SKU', 'SOH', 'POH',
                        ]}
                        rows={rows}
                      />
                }
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Scan Popup */}
      {(popupData || loadingSoh) && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '24px',
            width: '100%', maxWidth: '500px', position: 'relative' }}>
            {loadingSoh ? <InlineStack align="center"><Spinner /></InlineStack> : (
              <>
                <button onClick={closePopup} style={{ position: 'absolute', top: '12px', right: '12px',
                  background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer' }}>✕</button>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text variant="headingMd" fontWeight="bold">{popupData.name}</Text>
                    <Text variant="bodyMd" tone="subdued">{popupData.barcode}</Text>
                  </BlockStack>
                  {popupScanHistory.length > 0 && (
                    <BlockStack gap="100">
                      {popupScanHistory.map((s, i) => (
                        <InlineStack key={i} gap="200">
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%',
                            background: 'black', display: 'inline-block', marginTop: '6px' }} />
                          <Text>{s.type === 'correct' ? 'correct' : `counted ${s.value}`}</Text>
                        </InlineStack>
                      ))}
                      <Text variant="bodySm" tone="subdued">
                        total count {computePOH(popupScanHistory, popupSoh)}
                      </Text>
                    </BlockStack>
                  )}
                  <InlineStack gap="200">
                    <div style={{ flex: 1 }}>
                      <TextField label="" labelHidden type="number" placeholder="Input your count"
                        value={countInput} onChange={setCountInput} autoComplete="off" autoFocus />
                    </div>
                    <Button onClick={handleSubmitCount} disabled={!countInput}>Submit</Button>
                  </InlineStack>
                  <button onClick={handleCorrect} style={{ background: 'green', color: 'white',
                    border: 'none', borderRadius: '12px', padding: '20px', fontSize: '22px',
                    fontWeight: 'bold', cursor: 'pointer', width: '100%' }}>
                    SOH {popupSoh}　Correct
                  </button>
                </BlockStack>
              </>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

export default ManagerZeroQtyReport;