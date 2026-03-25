import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Banner, TextField, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

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

function ManagerRestockPlan() {
  const navigate = useNavigate();
  const location = localStorage.getItem('managerLocation') || '';

  const [items, setItems]               = useState([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [error, setError]               = useState('');

  const [popupData, setPopupData]         = useState(null);
  const [popupSoh, setPopupSoh]           = useState(null);
  const [restockInput, setRestockInput]   = useState('');
  const [loadingSoh, setLoadingSoh]       = useState(false);
  const [editingBarcode, setEditingBarcode] = useState(null);

  const [showAddByTyping, setShowAddByTyping] = useState(false);
  const [skuInput, setSkuInput]               = useState('');
  const [skuSearching, setSkuSearching]       = useState(false);
  const [skuError, setSkuError]               = useState('');

  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId]           = useState(null);


  const longPressTimer = useRef(null);
  const barcodeBuffer  = useRef('');
  const barcodeTimer   = useRef(null);
  const popupRef       = useRef(null);
  const addByTypingRef = useRef(false);

  useEffect(() => { popupRef.current = popupData; }, [popupData]);
  useEffect(() => { addByTypingRef.current = showAddByTyping; }, [showAddByTyping]);

  const loadItems = useCallback(async () => {
    if (!location) { setLoadingItems(false); return; }
    try {
      const res  = await fetch(`/api/reports/restock?location=${encodeURIComponent(location)}`);
      const data = await res.json();
      setItems(data);
    } catch (e) {
      setError('Failed to load restock plan');
    } finally {
      setLoadingItems(false);
    }
  }, [location]);

  useEffect(() => { loadItems(); }, [loadItems]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (popupRef.current) return;
      if (addByTypingRef.current) return;
      const activeTag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA'].includes(activeTag)) return;

      if (e.key === 'Enter') {
        clearTimeout(barcodeTimer.current);
        const barcode = cleanBarcode(barcodeBuffer.current.trim());
        barcodeBuffer.current = '';
        if (barcode.length > 0) openPopupByBarcode(barcode, false);
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

  const openPopupByBarcode = async (barcode, isEdit) => {
    setLoadingSoh(true);
    setError('');
    setEditingBarcode(isEdit ? barcode : null);
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
      setPopupSoh(data.soh ?? null);
      setRestockInput(isEdit && existing ? String(existing.restock_qty) : '');
    } catch (e) {
      setError(e.message || 'Product not found');
    } finally {
      setLoadingSoh(false);
    }
  };

  const closePopup = () => {
    setPopupData(null); setPopupSoh(null);
    setRestockInput(''); setEditingBarcode(null);
  };



  const handleSave = async () => {
    if (!popupData || restockInput === '') return;
    const qty = parseInt(restockInput);
    if (isNaN(qty)) return;
    try {
      const res  = await fetch('/api/reports/restock', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          barcode: popupData.barcode, name: popupData.name,
          location, shopify_location_id: popupData.locationId,
          soh: popupSoh, restock_qty: qty,
        }),
      });
      const saved = await res.json();
      setItems(prev => {
        const exists = prev.find(i => i.barcode === saved.barcode);
        return exists ? prev.map(i => i.barcode === saved.barcode ? saved : i) : [...prev, saved];
      });
    } catch (e) { setError('Failed to save'); }
    closePopup();
  };

  const handleCheckPress = async (item) => {
    if (item.is_done) setDeleteConfirmId(item.id);
    else await toggleDone(item.id, true);
  };

  const toggleDone = async (id, isDone) => {
    try {
      const res     = await fetch(`/api/reports/restock/${id}/done`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_done: isDone }),
      });
      const updated = await res.json();
      setItems(prev => prev.map(i => i.id === updated.id ? updated : i));
    } catch (e) { setError('Failed to update'); }
  };

  const handleLongPressStart = (item) => {
    if (!item.is_done) return;
    longPressTimer.current = setTimeout(async () => { await toggleDone(item.id, false); }, 600);
  };
  const handleLongPressEnd = () => clearTimeout(longPressTimer.current);

  const handleDeleteConfirmed = async () => {
    if (!deleteConfirmId) return;
    try {
      await fetch('/api/reports/restock', { method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [deleteConfirmId] }) });
      setItems(prev => prev.filter(i => i.id !== deleteConfirmId));
    } catch (e) { setError('Failed to delete'); }
    setDeleteConfirmId(null);
  };

  const handleDeleteAll = async () => {
    try {
      await fetch('/api/reports/restock', { method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, location }) });
      setItems([]);
    } catch (e) { setError('Failed to delete'); }
    setShowDeleteAllConfirm(false);
  };

  const handleSkuSearch = async () => {
    if (!skuInput.trim()) return;
    setSkuSearching(true); setSkuError('');
    try {
      const locRes  = await fetch('/api/shopify/locations');
      const locData = await locRes.json();
      const loc     = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');
      const res  = await fetch(`/api/shopify/inventory/${encodeURIComponent(skuInput.trim())}/${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'SKU not found');
      setShowAddByTyping(false); setSkuInput('');
      setPopupData({ ...data, barcode: skuInput.trim(), locationId: loc.id });
      setPopupSoh(data.soh ?? null); setRestockInput(''); setEditingBarcode(null);
    } catch (e) { setSkuError(e.message || 'SKU not found'); }
    finally { setSkuSearching(false); }
  };

  const renderRows = () => items.map(item => {
    const done = item.is_done;
    return (
      <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 80px 44px',
        gap: '8px', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #e1e3e5' }}>
        <div style={{ textDecoration: done ? 'line-through' : 'none', color: done ? '#8c9196' : 'inherit' }}>
          <div style={{ fontSize: '14px', fontWeight: '500' }}>{item.name || '-'}</div>
          <div style={{ fontSize: '12px', color: done ? '#b5b9bd' : '#6d7175' }}>{item.barcode || '-'}</div>
        </div>
        <span style={{ textDecoration: done ? 'line-through' : 'none', color: done ? '#8c9196' : 'inherit' }}>
          {item.soh ?? '-'}
        </span>
        {done
          ? <span style={{ textDecoration: 'line-through', color: '#8c9196' }}>{item.restock_qty}</span>
          : <span onClick={() => openPopupByBarcode(item.barcode, true)}
              style={{ cursor: 'pointer', color: '#2c6ecb', fontWeight: '500', textDecoration: 'underline' }}>
              {item.restock_qty}
            </span>
        }
        <button onClick={() => handleCheckPress(item)}
          onMouseDown={() => handleLongPressStart(item)} onMouseUp={handleLongPressEnd}
          onTouchStart={() => handleLongPressStart(item)} onTouchEnd={handleLongPressEnd}
          title={done ? 'Tap to delete · Long-press to undo' : 'Mark as done'}
          style={{ background: done ? '#008060' : 'white', color: done ? 'white' : '#008060',
            border: '2px solid #008060', borderRadius: '50%', width: '32px', height: '32px',
            fontSize: '16px', cursor: 'pointer', display: 'flex', alignItems: 'center',
            justifyContent: 'center', flexShrink: 0 }}>
          ✓
        </button>
      </div>
    );
  });

  return (
    <Page title="Restock" backAction={{ onAction: () => navigate('/manager') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            <Text variant="bodySm" tone="subdued">
              Scan to add items · saved for 15 days · shared across this location
            </Text>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="end" gap="200">
                  <button disabled={items.length === 0} onClick={() => setShowDeleteAllConfirm(true)}
                    style={{ padding: '8px 16px', borderRadius: '8px', border: 'none',
                      background: items.length === 0 ? '#f6f6f7' : '#d72c0d',
                      color: items.length === 0 ? '#8c9196' : 'white',
                      cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '14px', fontWeight: '500' }}>
                    Delete all
                  </button>
                  <button onClick={() => { setSkuInput(''); setSkuError(''); setShowAddByTyping(true); }}
                    style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #c9cccf',
                      background: 'white', color: '#202223', cursor: 'pointer',
                      fontSize: '14px', fontWeight: '500' }}>
                    Add by typing
                  </button>
                </InlineStack>

                {items.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 80px 44px',
                    gap: '8px', padding: '4px 0', borderBottom: '2px solid #e1e3e5' }}>
                    <Text variant="bodySm" fontWeight="semibold" tone="subdued">Name / SKU</Text>
                    <Text variant="bodySm" fontWeight="semibold" tone="subdued">System</Text>
                    <Text variant="bodySm" fontWeight="semibold" tone="subdued">Restock</Text>
                    <Text variant="bodySm" fontWeight="semibold" tone="subdued"> </Text>
                  </div>
                )}

                {loadingItems
                  ? <InlineStack align="center"><Spinner /></InlineStack>
                  : items.length === 0
                    ? <Text tone="subdued" alignment="center">No items yet. Scan a barcode to add.</Text>
                    : <div>{renderRows()}</div>
                }
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Scan / Edit Popup */}
      {(popupData || loadingSoh) && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px', boxSizing: 'border-box',
        }}>
          <div style={{
            background: 'white', borderRadius: '12px', padding: '24px',
            width: '100%', maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box',
            position: 'relative', overflow: 'hidden',
          }}>
            {loadingSoh ? <InlineStack align="center"><Spinner /></InlineStack> : (
              <>
                <button onClick={closePopup} style={{ position: 'absolute', top: '12px', right: '12px',
                  background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', zIndex: 1 }}>✕</button>
                <BlockStack gap="300">
                  {/* Popup header */}
                  <div style={{ paddingRight: '28px', wordBreak: 'break-word' }}>
                    <div style={{ fontSize: '16px', fontWeight: '700', lineHeight: '1.4' }}>
                      {popupData.name}
                    </div>
                  </div>
                  <InlineStack gap="200" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <TextField label="Restock quantity" type="number"
                        placeholder="Input restock quantity" value={restockInput}
                        onChange={setRestockInput} autoComplete="off" autoFocus />
                    </div>
                    <div style={{ paddingBottom: '2px' }}>
                      <Button variant="primary" onClick={handleSave} disabled={restockInput === ''}>Save</Button>
                    </div>
                  </InlineStack>
                  <div style={{ background: popupSoh === null ? '#fff4f4' : '#f6f6f7',
                    borderRadius: '8px', padding: '12px 16px', textAlign: 'center' }}>
                    {popupSoh === null
                      ? <Text variant="bodyMd" tone="critical">System — (network error, please retry)</Text>
                      : <Text variant="bodyLg" fontWeight="semibold">System {popupSoh}</Text>
                    }
                  </div>
                </BlockStack>
              </>
            )}
          </div>
        </div>
      )}

      {/* Add by typing */}
      {showAddByTyping && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '24px',
            width: '100%', maxWidth: '400px', position: 'relative' }}>
            <button onClick={() => setShowAddByTyping(false)} style={{ position: 'absolute',
              top: '12px', right: '12px', background: 'none', border: 'none',
              fontSize: '20px', cursor: 'pointer' }}>✕</button>
            <BlockStack gap="300">
              <Text variant="headingMd" fontWeight="bold">Add by SKU</Text>
              {skuError && <Banner tone="critical" onDismiss={() => setSkuError('')}>{skuError}</Banner>}
              <InlineStack gap="200" blockAlign="end">
                <div style={{ flex: 1 }}>
                  <TextField label="SKU" value={skuInput}
                    onChange={val => { setSkuInput(val); setSkuError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') handleSkuSearch(); }}
                    autoComplete="off" autoFocus placeholder="Enter exact SKU" />
                </div>
                <div style={{ paddingBottom: '2px' }}>
                  <Button onClick={handleSkuSearch} loading={skuSearching} disabled={!skuInput.trim()}>Search</Button>
                </div>
              </InlineStack>
            </BlockStack>
          </div>
        </div>
      )}

      {/* Delete-all confirm */}
      {showDeleteAllConfirm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '24px',
            width: '100%', maxWidth: '340px', textAlign: 'center' }}>
            <BlockStack gap="300">
              <Text variant="headingMd" fontWeight="bold">Delete all items?</Text>
              <Text variant="bodyMd" tone="subdued">This cannot be undone.</Text>
              <InlineStack gap="200" align="center">
                <button onClick={handleDeleteAll} style={{ padding: '10px 24px', borderRadius: '8px',
                  border: 'none', background: '#d72c0d', color: 'white',
                  cursor: 'pointer', fontSize: '14px', fontWeight: '600' }}>Delete all</button>
                <button onClick={() => setShowDeleteAllConfirm(false)} style={{ padding: '10px 24px',
                  borderRadius: '8px', border: '1px solid #c9cccf', background: 'white',
                  cursor: 'pointer', fontSize: '14px' }}>Cancel</button>
              </InlineStack>
            </BlockStack>
          </div>
        </div>
      )}

      {/* Delete-done confirm */}
      {deleteConfirmId && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '24px',
            width: '100%', maxWidth: '340px', textAlign: 'center' }}>
            <BlockStack gap="300">
              <Text variant="headingMd" fontWeight="bold">Delete this item?</Text>
              <Text variant="bodyMd" tone="subdued">Long-press the check button to undo done instead.</Text>
              <InlineStack gap="200" align="center">
                <button onClick={handleDeleteConfirmed} style={{ padding: '10px 24px', borderRadius: '8px',
                  border: 'none', background: '#d72c0d', color: 'white',
                  cursor: 'pointer', fontSize: '14px', fontWeight: '600' }}>Delete</button>
                <button onClick={() => setDeleteConfirmId(null)} style={{ padding: '10px 24px',
                  borderRadius: '8px', border: '1px solid #c9cccf', background: 'white',
                  cursor: 'pointer', fontSize: '14px' }}>Cancel</button>
              </InlineStack>
            </BlockStack>
          </div>
        </div>
      )}

    </Page>
  );
}

export default ManagerRestockPlan;