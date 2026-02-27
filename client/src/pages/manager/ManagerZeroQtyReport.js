import React, { useState, useEffect, useRef } from 'react';
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

function ManagerZeroQtyReport() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Popup
  const [popupData, setPopupData] = useState(null);
  const [popupSoh, setPopupSoh] = useState(null);
  const [popupScanHistory, setPopupScanHistory] = useState([]);
  const [countInput, setCountInput] = useState('');
  const [loadingSoh, setLoadingSoh] = useState(false);

  const barcodeBuffer = useRef('');
  const barcodeTimer = useRef(null);
  const location = localStorage.getItem('managerLocation') || '';

  // Listen for barcode scanner
  useEffect(() => {
    const handleKeyDown = async (e) => {
      if (popupData) return;
      if (e.key === 'Enter') {
        const barcode = barcodeBuffer.current.trim();
        barcodeBuffer.current = '';
        if (barcode) {
          await openPopupByBarcode(barcode);
        }
      } else if (e.key.length === 1) {
        barcodeBuffer.current += e.key;
        clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => {
          barcodeBuffer.current = '';
        }, 500);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [popupData, location]);

  const openPopupByBarcode = async (barcode) => {
    setLoadingSoh(true);
    setError('');
    try {
      const locRes = await fetch('/api/shopify/locations');
      const locData = await locRes.json();
      const loc = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');

      const res = await fetch(`/api/shopify/inventory/${encodeURIComponent(barcode)}/${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Product not found');

      // Check if already in list
      const existing = items.find(i => i.barcode === barcode);
      const existingHistory = existing?.scan_history || [];

      setPopupData({ ...data, barcode, locationId: loc.id });
      setPopupSoh(data.soh ?? 0);
      setPopupScanHistory(existingHistory);
      setCountInput('');
    } catch (e) {
      setError(e.message || 'Product not found');
    } finally {
      setLoadingSoh(false);
    }
  };

  const closePopup = () => {
    setPopupData(null);
    setPopupSoh(null);
    setPopupScanHistory([]);
    setCountInput('');
  };

  const handleCorrect = () => {
    // POH = SOH, don't add to list
    closePopup();
  };

  const handleSubmitCount = () => {
    if (!popupData || !countInput) return;
    const value = parseInt(countInput);
    if (isNaN(value)) return;

    const newEntry = { type: 'counted', value, created_at: new Date().toISOString() };
    const newHistory = [...popupScanHistory, newEntry];
    const poh = computePOH(newHistory, popupSoh);

    setItems(prev => {
      const existing = prev.find(i => i.barcode === popupData.barcode);
      if (existing) {
        return prev.map(i =>
          i.barcode === popupData.barcode
            ? { ...i, poh, soh: popupSoh, scan_history: newHistory }
            : i
        );
      } else {
        return [...prev, {
          id: Date.now(),
          barcode: popupData.barcode,
          name: popupData.name,
          department: popupData.department,
          location,
          locationId: popupData.locationId,
          soh: popupSoh,
          poh,
          scan_history: newHistory,
        }];
      }
    });
    closePopup();
  };

  const handleSubmitItems = async (ids) => {
    setSubmitting(true);
    setError('');
    try {
      const toSubmit = items.filter(i => ids.includes(i.id));
      const res = await fetch('/api/reports/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: toSubmit }),
      });
      if (!res.ok) throw new Error('Failed to submit');
      setItems(prev => prev.filter(i => !ids.includes(i.id)));
      setSelectedIds([]);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleSelectOne = (id) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === items.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(items.map(i => i.id));
    }
  };

  const rows = items.map(item => [
    <Checkbox
      checked={selectedIds.includes(item.id)}
      onChange={() => toggleSelectOne(item.id)}
    />,
    item.name || '-',
    item.barcode || '-',
    item.soh ?? '-',
    item.poh ?? '-',
  ]);

  return (
    <Page
      title="0 quantity report"
      backAction={{ onAction: () => navigate('/manager') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Text variant="bodySm" tone="subdued">Scan to add items</Text>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="end" gap="200">
                  <Button
                    disabled={selectedIds.length === 0 || submitting}
                    onClick={() => handleSubmitItems(selectedIds)}
                    loading={submitting}
                  >
                    Submit selected
                  </Button>
                  <Button
                    disabled={items.length === 0 || submitting}
                    onClick={() => handleSubmitItems(items.map(i => i.id))}
                    loading={submitting}
                  >
                    Submit all
                  </Button>
                </InlineStack>

                {items.length === 0 ? (
                  <Text tone="subdued" alignment="center">No items yet. Scan a barcode to add.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={['text','text','text','numeric','numeric']}
                    headings={[
                      <Checkbox
                        checked={selectedIds.length === items.length && items.length > 0}
                        indeterminate={selectedIds.length > 0 && selectedIds.length < items.length}
                        onChange={toggleSelectAll}
                      />,
                      'Name', 'SKU', 'SOH', 'POH',
                    ]}
                    rows={rows}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Scan Popup */}
      {popupData && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'white', borderRadius: '12px',
            padding: '24px', width: '90%', maxWidth: '500px',
            position: 'relative',
          }}>
            <button
              onClick={closePopup}
              style={{
                position: 'absolute', top: '12px', right: '12px',
                background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
              }}
            >
              ✕
            </button>

            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text variant="headingMd" fontWeight="bold">{popupData.name}</Text>
                <Text variant="bodyMd" tone="subdued">{popupData.barcode}</Text>
              </BlockStack>

              {/* Scan history */}
              {popupScanHistory.length > 0 && (
                <BlockStack gap="100">
                  {popupScanHistory.map((s, i) => (
                    <InlineStack key={i} gap="200">
                      <span style={{
                        width: '8px', height: '8px', borderRadius: '50%',
                        background: 'black', display: 'inline-block', marginTop: '6px'
                      }} />
                      <Text>{s.type === 'correct' ? 'correct' : `counted ${s.value}`}</Text>
                    </InlineStack>
                  ))}
                  <Text variant="bodySm" tone="subdued">
                    total count {computePOH(popupScanHistory, popupSoh)}
                  </Text>
                </BlockStack>
              )}

              {/* Count input */}
              <InlineStack gap="200">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="" labelHidden
                    type="number"
                    placeholder="Input your count"
                    value={countInput}
                    onChange={setCountInput}
                    autoComplete="off"
                    autoFocus
                  />
                </div>
                <Button onClick={handleSubmitCount} disabled={!countInput}>Submit</Button>
              </InlineStack>

              {/* Correct button */}
              {loadingSoh ? <Spinner /> : (
                <button
                  onClick={handleCorrect}
                  style={{
                    background: 'green', color: 'white', border: 'none',
                    borderRadius: '12px', padding: '20px', fontSize: '22px',
                    fontWeight: 'bold', cursor: 'pointer', width: '100%',
                  }}
                >
                  SOH {popupSoh}　Correct
                </button>
              )}
            </BlockStack>
          </div>
        </div>
      )}
    </Page>
  );
}

export default ManagerZeroQtyReport;