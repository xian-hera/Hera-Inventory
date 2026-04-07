import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Checkbox, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import CameraScanner from '../../components/CameraScanner';

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
  if (e.key && e.key !== 'Unidentified' && e.key.length === 1) return e.key;
  if (e.code) {
    if (e.code.startsWith('Digit')) return e.code.slice(5);
    if (e.code.startsWith('Numpad') && e.code.length === 7) return e.code.slice(6);
    if (e.code.startsWith('Key') && e.code.length === 4) {
      const ch = e.code.slice(3);
      return e.shiftKey ? ch : ch.toLowerCase();
    }
    const sym = { Minus:'-', Equal:'=', BracketLeft:'[', BracketRight:']',
      Backslash:'\\', Semicolon:';', Quote:"'", Backquote:'`',
      Comma:',', Period:'.', Slash:'/' };
    if (sym[e.code]) return sym[e.code];
  }
  return null;
}

function cleanBarcode(raw) {
  return raw.replace(/^[^0-9]+/, '');
}

function ManagerZeroQtyReport() {
  const navigate = useNavigate();
  const [items, setItems]               = useState([]);
  const [selectedIds, setSelectedIds]   = useState([]);
  const [error, setError]               = useState('');
  const [submitting, setSubmitting]     = useState(false);
  const [loadingItems, setLoadingItems] = useState(true);

  const [popupData, setPopupData]               = useState(null);
  const [popupSoh, setPopupSoh]                 = useState(null);
  const [popupScanHistory, setPopupScanHistory] = useState([]);
  const [countInput, setCountInput]             = useState('');
  const [loadingSoh, setLoadingSoh]             = useState(false);
  const [popupCommitted, setPopupCommitted]     = useState(0);
  const [historyLoading, setHistoryLoading]     = useState(false);

  const [showTypeIn, setShowTypeIn]     = useState(false);
  const [showCamera, setShowCamera]     = useState(false);
  const cameraPauseRef                  = useRef(false);
  const [skuInput, setSkuInput]         = useState('');
  const [skuSearching, setSkuSearching] = useState(false);
  const [skuError, setSkuError]         = useState('');

  const barcodeBuffer = useRef('');
  const barcodeTimer  = useRef(null);
  const popupRef      = useRef(null);
  const typeInRef     = useRef(false);
  const location      = localStorage.getItem('managerLocation') || '';

  useEffect(() => { popupRef.current = popupData; }, [popupData]);
  useEffect(() => { typeInRef.current = showTypeIn; }, [showTypeIn]);

  useEffect(() => {
    const anyOpen = !!(popupData || loadingSoh || showTypeIn);
    document.body.style.overflow = anyOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [popupData, loadingSoh, showTypeIn]);

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

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (popupRef.current) return;
      if (typeInRef.current) return;
      const activeTag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA'].includes(activeTag)) return;

      if (e.key === 'Enter') {
        clearTimeout(barcodeTimer.current);
        const barcode = cleanBarcode(barcodeBuffer.current.trim());
        barcodeBuffer.current = '';
        if (barcode.length > 0) openPopupByBarcode(barcode);
        return;
      }

      const ch = resolveKey(e);
      if (ch) {
        barcodeBuffer.current += ch;
        clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => { barcodeBuffer.current = ''; }, 500);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(barcodeTimer.current);
    };
  }, []);

  // 摄像头扫描回调
  const handleCameraScan = (barcode) => {
    cameraPauseRef.current = true;
    openPopupByBarcode(barcode);
  };

  const handleCameraPopupClose = () => {
    closePopup();
    cameraPauseRef.current = false;
  };

  // 修复：使用 query string 格式，避免 barcode 含特殊字符导致 404
  const openPopupByBarcode = async (barcode) => {
    setLoadingSoh(true);
    setError('');
    try {
      const locRes  = await fetch('/api/shopify/locations');
      const locData = await locRes.json();
      const loc     = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');
      const res  = await fetch(`/api/shopify/inventory?barcode=${encodeURIComponent(barcode)}&locationId=${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Product not found');
      const existing = items.find(i => i.barcode === barcode);
      setPopupData({ ...data, barcode, locationId: loc.id });
      setPopupSoh(data.soh ?? null);
      setPopupCommitted(data.committed ?? 0);
      setPopupScanHistory(existing?.scan_history || []);
      setCountInput('');
    } catch (e) {
      setError(e.message || 'Product not found');
    } finally {
      setLoadingSoh(false);
    }
  };

  const openHistory = async (barcode) => {
    setHistoryLoading(true);
    try {
      const locRes  = await fetch('/api/shopify/locations');
      const locData = await locRes.json();
      const loc     = locData.find(l => l.name === location);
      const locationId = loc ? encodeURIComponent(loc.id) : '';
      const res  = await fetch(`/api/shopify/inventory-history/${encodeURIComponent(barcode)}?locationId=${locationId}`);
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error('Could not get history URL');
      window.open(data.url, '_blank');
    } catch (e) {
      setError('Could not open history: ' + e.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const closePopup = () => {
    setPopupData(null); setPopupSoh(null);
    setPopupCommitted(0); setPopupScanHistory([]); setCountInput('');
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
          type: popupData.productType || null, location,
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

  // 修复：使用 query string 格式
  const handleSkuSearch = async () => {
    if (!skuInput.trim()) return;
    setSkuSearching(true); setSkuError('');
    try {
      const locRes  = await fetch('/api/shopify/locations');
      const locData = await locRes.json();
      const loc     = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');
      const res  = await fetch(`/api/shopify/inventory?barcode=${encodeURIComponent(skuInput.trim())}&locationId=${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'SKU not found');
      setShowTypeIn(false); setSkuInput('');
      const existing = items.find(i => i.barcode === skuInput.trim());
      setPopupData({ ...data, barcode: skuInput.trim(), locationId: loc.id });
      setPopupSoh(data.soh ?? null);
      setPopupScanHistory(existing?.scan_history || []);
      setCountInput('');
    } catch (e) {
      setSkuError(e.message || 'SKU not found');
    } finally {
      setSkuSearching(false);
    }
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

  const toggleSelectOne = (id) => setSelectedIds(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll = () =>
    setSelectedIds(selectedIds.length === items.length ? [] : items.map(i => i.id));

  const rows = items.map(item => [
    <Checkbox checked={selectedIds.includes(item.id)} onChange={() => toggleSelectOne(item.id)} />,
    <div onClick={() => openPopupByBarcode(item.barcode)}
      style={{ cursor: 'pointer', minWidth: 0 }}>
      <div style={{ fontSize: '14px', fontWeight: '500', wordBreak: 'break-word', whiteSpace: 'normal' }}>{item.name || '-'}</div>
      <div style={{ fontSize: '12px', color: '#6d7175', wordBreak: 'break-all' }}>{item.barcode || '-'}</div>
    </div>,
    <div onClick={() => openPopupByBarcode(item.barcode)} style={{ cursor: 'pointer' }}>
      {item.soh ?? '-'}
    </div>,
    <div onClick={() => openPopupByBarcode(item.barcode)} style={{ cursor: 'pointer' }}>
      {item.poh ?? '-'}
    </div>,
  ]);

  const overlayStyle = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.6)', zIndex: 1000,
  };
  const popupInnerStyle = {
    position: 'fixed',
    top: '50%', left: '16px', right: '16px',
    transform: 'translateY(-50%)',
    background: 'white', borderRadius: '12px', padding: '24px',
    maxWidth: '480px', margin: '0 auto', zIndex: 1001,
  };

  return (
    <Page title="Zero/Low Inventory Count" backAction={{ onAction: () => navigate('/manager') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            <Text variant="bodySm" tone="subdued">
              Scan to add items · saved for 15 days · shared across this location
            </Text>
            <Card>
              <BlockStack gap="300">
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => { setSkuInput(''); setSkuError(''); setShowTypeIn(true); }}
                    style={{ flex: 1, padding: '10px 16px', borderRadius: '8px',
                      border: '1px solid #c9cccf', background: 'white', color: '#202223',
                      cursor: 'pointer', fontSize: '14px', fontWeight: '500', textAlign: 'center' }}>
                    Type in SKU
                  </button>
                  <button onClick={() => setShowCamera(true)}
                    style={{ padding: '10px 16px', borderRadius: '8px',
                      border: '1px solid #c9cccf', background: 'white', color: '#202223',
                      cursor: 'pointer', fontSize: '14px', fontWeight: '500' }}>
                    📷
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button disabled={selectedIds.length === 0 || submitting} onClick={handleDeleteSelected}
                    style={{ flex: '1 1 auto', padding: '8px 12px', borderRadius: '8px',
                      border: '1px solid #d72c0d',
                      background: selectedIds.length === 0 ? '#f6f6f7' : 'white',
                      color: selectedIds.length === 0 ? '#8c9196' : '#d72c0d',
                      cursor: selectedIds.length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '13px', fontWeight: '500' }}>
                    Delete selected
                  </button>
                  <button disabled={items.length === 0 || submitting} onClick={handleDeleteAll}
                    style={{ flex: '1 1 auto', padding: '8px 12px', borderRadius: '8px',
                      border: 'none',
                      background: items.length === 0 ? '#f6f6f7' : '#d72c0d',
                      color: items.length === 0 ? '#8c9196' : 'white',
                      cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '13px', fontWeight: '500' }}>
                    Delete all
                  </button>
                  <button disabled={selectedIds.length === 0 || submitting}
                    onClick={() => handleSubmitItems(selectedIds)}
                    style={{ flex: '1 1 auto', padding: '8px 12px', borderRadius: '8px',
                      border: '1px solid #c9cccf',
                      background: selectedIds.length === 0 ? '#f6f6f7' : 'white',
                      color: selectedIds.length === 0 ? '#8c9196' : '#202223',
                      cursor: selectedIds.length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '13px', fontWeight: '500' }}>
                    Submit selected
                  </button>
                  <button disabled={items.length === 0 || submitting}
                    onClick={() => handleSubmitItems(items.map(i => i.id))}
                    style={{ flex: '1 1 auto', padding: '8px 12px', borderRadius: '8px',
                      border: 'none',
                      background: items.length === 0 ? '#f6f6f7' : '#008060',
                      color: items.length === 0 ? '#8c9196' : 'white',
                      cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '13px', fontWeight: '500' }}>
                    Submit all
                  </button>
                </div>

                {loadingItems
                  ? <InlineStack align="center"><Spinner /></InlineStack>
                  : items.length === 0
                    ? <Text tone="subdued" alignment="center">No items yet. Scan a barcode to add.</Text>
                    : <DataTable
                        columnContentTypes={['text', 'text', 'numeric', 'numeric']}
                        headings={[
                          <Checkbox
                            checked={selectedIds.length === items.length && items.length > 0}
                            indeterminate={selectedIds.length > 0 && selectedIds.length < items.length}
                            onChange={toggleSelectAll} />,
                          'Name / SKU', 'System', 'Actual',
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
        <div style={overlayStyle}>
          <div style={popupInnerStyle}>
            {loadingSoh
              ? <InlineStack align="center"><Spinner /></InlineStack>
              : <>
                  <button onClick={showCamera ? handleCameraPopupClose : closePopup} style={{
                    position: 'absolute', top: '12px', right: '12px',
                    background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', zIndex: 1,
                  }}>✕</button>
                  <BlockStack gap="400">
                    <div style={{ paddingRight: '28px', wordBreak: 'break-word' }}>
                      <div style={{ fontSize: '16px', fontWeight: '700', lineHeight: '1.4' }}>
                        {popupData.name}
                      </div>
                    </div>
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
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        inputMode="numeric"
                        placeholder="Input your count"
                        value={countInput}
                        onChange={e => setCountInput(e.target.value)}
                        autoComplete="off"
                        autoFocus
                        style={{
                          flex: 1, minWidth: 0, padding: '10px 12px', fontSize: '16px',
                          border: '1px solid #c9cccf', borderRadius: '8px',
                          outline: 'none', boxSizing: 'border-box', display: 'block',
                        }}
                        onFocus={e => { e.target.style.borderColor = '#005bd3'; }}
                        onBlur={e => { e.target.style.borderColor = '#c9cccf'; }}
                      />
                      <Button onClick={handleSubmitCount} disabled={!countInput}>Submit</Button>
                    </div>
                    {popupSoh === null ? (
                      <div style={{ background: '#f6f6f7', borderRadius: '12px', padding: '16px',
                        textAlign: 'center', fontSize: '14px', color: '#d72c0d' }}>
                        System unavailable — network error. Please close and retry.
                      </div>
                    ) : (
                      <>
                        <button onClick={handleCorrect} style={{ background: 'green', color: 'white',
                          border: 'none', borderRadius: '12px', padding: '20px', fontSize: '22px',
                          fontWeight: 'bold', cursor: 'pointer', width: '100%' }}>
                          System {popupSoh}　Correct
                        </button>
                        {popupCommitted > 0 && (
                          <div style={{ textAlign: 'center', fontSize: '13px', color: '#e67c00', fontWeight: '500' }}>
                            {popupCommitted} committed
                          </div>
                        )}
                        <button
                          onClick={() => openHistory(popupData.barcode)}
                          disabled={historyLoading}
                          style={{
                            padding: '8px 16px', borderRadius: '8px',
                            border: '1px solid #c9cccf', background: 'white',
                            color: historyLoading ? '#8c9196' : '#202223',
                            cursor: historyLoading ? 'not-allowed' : 'pointer',
                            fontSize: '14px', fontWeight: '500',
                          }}>
                          {historyLoading ? '...' : 'Check History ↗'}
                        </button>
                      </>
                    )}
                  </BlockStack>
                </>
            }
          </div>
        </div>
      )}

      {/* Camera Scanner */}
      {showCamera && (
        <CameraScanner
          onScan={handleCameraScan}
          onClose={() => { setShowCamera(false); cameraPauseRef.current = false; }}
          pauseRef={cameraPauseRef}
        />
      )}

      {/* Type in SKU popup */}
      {showTypeIn && (
        <div style={overlayStyle}>
          <div style={popupInnerStyle}>
            <button onClick={() => setShowTypeIn(false)} style={{ position: 'absolute',
              top: '12px', right: '12px', background: 'none', border: 'none',
              fontSize: '20px', cursor: 'pointer' }}>✕</button>
            <BlockStack gap="300">
              <Text variant="headingMd" fontWeight="bold">Type in SKU</Text>
              {skuError && <Banner tone="critical" onDismiss={() => setSkuError('')}>{skuError}</Banner>}
              <div style={{ marginBottom: '4px', fontSize: '14px', color: '#202223', fontWeight: '500' }}>SKU</div>
              <input
                value={skuInput}
                inputMode="numeric"
                onChange={e => { setSkuInput(e.target.value); setSkuError(''); }}
                onKeyDown={e => { if (e.key === 'Enter') handleSkuSearch(); }}
                autoComplete="off"
                autoFocus
                placeholder="Enter exact SKU"
                style={{
                  width: '100%', padding: '10px 12px', fontSize: '16px',
                  border: '1px solid #c9cccf', borderRadius: '8px',
                  outline: 'none', boxSizing: 'border-box', display: 'block',
                }}
                onFocus={e => { e.target.style.borderColor = '#005bd3'; }}
                onBlur={e => { e.target.style.borderColor = '#c9cccf'; }}
              />
              <Button
                variant="primary"
                onClick={handleSkuSearch}
                loading={skuSearching}
                disabled={!skuInput.trim()}
                fullWidth
              >
                Search
              </Button>
            </BlockStack>
          </div>
        </div>
      )}
    </Page>
  );
}

export default ManagerZeroQtyReport;