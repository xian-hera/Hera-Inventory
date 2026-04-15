import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Checkbox, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

// ─── Built-in reasons ─────────────────────────────────────────────────────────
const BUILT_IN_REASONS = [
  { key: 'damaged_delivery',  label: 'Damaged during delivery' },
  { key: 'damaged_employee',  label: 'Damaged by employee / customer' },
  { key: 'expired',           label: 'Expired' },
  { key: 'stolen',            label: 'Stolen' },
  { key: 'tester',            label: 'Tester' },
];
const OTHER_REASON = { key: 'other', label: 'Other' };

function getPlaceholder(reasonKey) {
  switch (reasonKey) {
    case 'damaged_delivery':
    case 'damaged_employee': return 'Input how many damaged';
    case 'expired':          return 'Input how many expired';
    case 'stolen':           return 'Input how many stolen';
    case 'tester':           return 'Input how many made tester';
    case 'other':            return 'Input how many effected';
    default:                 return 'Input how many effected';
  }
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
    const sym = {
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
      Comma: ',', Period: '.', Slash: '/',
    };
    if (sym[e.code]) return sym[e.code];
  }
  return null;
}

function cleanBarcode(raw) {
  return raw.replace(/^[^0-9]+/, '');
}

// Reset iOS viewport zoom (triggered by input focus on font-size < 16px)
function resetViewportZoom() {
  const viewport = document.querySelector('meta[name=viewport]');
  if (viewport) {
    viewport.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  }
}

// ─── Scan popup (page 1) ──────────────────────────────────────────────────────
function ScanPopup({ productData, soh, allReasons, onClose, onSubmit }) {
  const [selectedReason, setSelectedReason] = useState(null);
  const [otherText, setOtherText]           = useState('');
  const [otherSaved, setOtherSaved]         = useState(false);
  const [qtyInput, setQtyInput]             = useState('');

  const handleReasonClick = (reason) => {
    setSelectedReason(reason);
    setOtherText('');
    setOtherSaved(false);
  };

  const canSubmit = selectedReason && qtyInput && parseInt(qtyInput) > 0 &&
    (selectedReason.key !== 'other' || otherSaved);

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      reason: selectedReason,
      qty: parseInt(qtyInput),
      reasonDetail: selectedReason.key === 'other' ? otherText : null,
    });
  };

  const placeholder = selectedReason ? getPlaceholder(selectedReason.key) : 'Choose reason first';

  const btnStyle = (active) => ({
    padding: '12px 16px', borderRadius: '8px', border: 'none',
    background: active ? '#005bd3' : '#f0f0f0',
    color: active ? 'white' : '#202223',
    cursor: 'pointer', fontSize: '16px',
    fontWeight: active ? '600' : '400',
    textAlign: 'center', width: '100%',
  });

  const damageReasons = allReasons.filter(r => r.key === 'damaged_delivery' || r.key === 'damaged_employee');
  const midReasons    = allReasons.filter(r => !['damaged_delivery', 'damaged_employee', 'other'].includes(r.key));

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'white', borderRadius: '16px', padding: '24px',
        width: 'calc(100% - 32px)', maxWidth: '420px',
        maxHeight: '90vh', overflowY: 'auto', position: 'relative',
      }}>
        <button onClick={onClose} style={{
          position: 'absolute', top: '12px', right: '12px',
          background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
        }}>✕</button>

        <BlockStack gap="300">
          <div style={{ paddingRight: '28px' }}>
            <Text variant="headingMd" fontWeight="bold">{productData.name}</Text>
          </div>
          <Text variant="bodyMd" tone="subdued">System {soh ?? '—'}</Text>

          {damageReasons.map(r => (
            <button key={r.key} style={btnStyle(selectedReason?.key === r.key)}
              onClick={() => handleReasonClick(r)}>
              {r.label}
            </button>
          ))}

          {midReasons.length > 0 && (
            <div style={{ display: 'flex', gap: '8px' }}>
              {midReasons.map(r => (
                <button key={r.key} style={{ ...btnStyle(selectedReason?.key === r.key), flex: 1 }}
                  onClick={() => handleReasonClick(r)}>
                  {r.label}
                </button>
              ))}
            </div>
          )}

          {selectedReason?.key === 'other' ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              {otherSaved ? (
                <>
                  <div style={{
                    flex: 1, padding: '10px 12px', border: '1px solid #c9cccf',
                    borderRadius: '8px', fontSize: '16px', background: '#f6f6f7',
                    color: '#202223', wordBreak: 'break-word',
                  }}>{otherText}</div>
                  <button onClick={() => setOtherSaved(false)} style={{
                    padding: '10px 14px', borderRadius: '8px', border: '1px solid #c9cccf',
                    background: 'white', cursor: 'pointer', fontSize: '16px',
                    fontWeight: '500', whiteSpace: 'nowrap',
                  }}>Edit</button>
                </>
              ) : (
                <>
                  <input
                    autoFocus value={otherText}
                    onChange={e => setOtherText(e.target.value)}
                    placeholder="Describe reason"
                    style={{
                      flex: 1, padding: '10px 12px', border: '1px solid #005bd3',
                      borderRadius: '8px', fontSize: '16px', outline: 'none',
                    }}
                  />
                  <button
                    disabled={!otherText.trim()}
                    onClick={() => setOtherSaved(true)}
                    style={{
                      padding: '10px 14px', borderRadius: '8px', border: 'none',
                      background: otherText.trim() ? '#005bd3' : '#f0f0f0',
                      color: otherText.trim() ? 'white' : '#8c9196',
                      cursor: otherText.trim() ? 'pointer' : 'not-allowed',
                      fontSize: '16px', fontWeight: '500', whiteSpace: 'nowrap',
                    }}>Save</button>
                </>
              )}
            </div>
          ) : (
            <button style={btnStyle(false)} onClick={() => handleReasonClick(OTHER_REASON)}>
              Other
            </button>
          )}

          {/* Qty input — font-size 16px prevents iOS auto-zoom */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              inputMode="numeric" value={qtyInput}
              onChange={e => setQtyInput(e.target.value)}
              placeholder={placeholder} disabled={!selectedReason}
              style={{
                flex: 1, padding: '10px 12px', fontSize: '16px',
                border: `1px solid ${selectedReason ? '#c9cccf' : '#e1e3e5'}`,
                borderRadius: '8px', outline: 'none',
                background: selectedReason ? 'white' : '#f6f6f7',
                color: selectedReason ? '#202223' : '#8c9196',
              }}
            />
            <button
              disabled={!canSubmit} onClick={handleSubmit}
              style={{
                padding: '10px 20px', borderRadius: '8px', border: 'none',
                background: canSubmit ? '#005bd3' : '#f0f0f0',
                color: canSubmit ? 'white' : '#8c9196',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                fontSize: '16px', fontWeight: '600', whiteSpace: 'nowrap',
              }}>
              Submit
            </button>
          </div>
        </BlockStack>
      </div>
    </div>
  );
}

// ─── Photo upload popup (page 2) ──────────────────────────────────────────────
function PhotoPopup({ sku, onSubmit, onClose }) {
  const [photos, setPhotos]       = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError]         = useState('');
  const fileRef    = useRef(null);
  const addFileRef = useRef(null);

  const handleInitialFileChange = (e) => {
    const files = Array.from(e.target.files).slice(0, 4);
    setPhotos(files.map(f => ({ file: f, preview: URL.createObjectURL(f) })));
    e.target.value = '';
  };

  const handleAddMoreChange = (e) => {
    const files = Array.from(e.target.files);
    const remaining = 4 - photos.length;
    const newFiles = files.slice(0, remaining).map(f => ({ file: f, preview: URL.createObjectURL(f) }));
    setPhotos(prev => [...prev, ...newFiles]);
    e.target.value = '';
  };

  const handleUndo = () => {
    setPhotos([]);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleSubmit = async () => {
    if (photos.length === 0) return;
    setUploading(true);
    setError('');
    try {
      const uploaded = [];
      for (let i = 0; i < photos.length; i++) {
        const { file } = photos[i];
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const res = await fetch('/api/stock-losses/upload-photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64, mimeType: file.type, sku, index: i + 1 }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        uploaded.push({ gid: data.gid, url: data.url });
      }
      onSubmit(uploaded);
    } catch (e) {
      setError(e.message || 'Upload failed');
      setUploading(false);
    }
  };

  const canAddMore = photos.length > 0 && photos.length < 4 && !uploading;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Close button outside popup */}
      <button onClick={onClose} style={{
        position: 'fixed', top: '16px', right: '16px', zIndex: 1001,
        width: '36px', height: '36px', borderRadius: '50%',
        background: 'rgba(255,255,255,0.9)', border: 'none',
        fontSize: '20px', lineHeight: 1, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}>✕</button>

      <div style={{
        background: 'white', borderRadius: '16px', padding: '24px',
        width: 'calc(100% - 32px)', maxWidth: '420px', position: 'relative',
      }}>
        <BlockStack gap="300">
          <Text variant="headingMd" fontWeight="bold">
            {photos.length > 0
              ? `${photos.length} photo${photos.length > 1 ? 's' : ''} uploaded`
              : 'Photo required'}
          </Text>

          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

          {photos.length > 0 ? (
            <>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                {photos.map((p, i) => (
                  <img key={i} src={p.preview} alt=""
                    style={{ width: '72px', height: '72px', objectFit: 'cover', borderRadius: '8px' }} />
                ))}
                {canAddMore && (
                  <>
                    <input type="file" accept="image/*" multiple ref={addFileRef}
                      style={{ display: 'none' }} onChange={handleAddMoreChange} />
                    <button onClick={() => addFileRef.current?.click()} style={{
                      width: '72px', height: '72px', borderRadius: '8px',
                      border: '2px dashed #c9cccf', background: '#f6f6f7',
                      cursor: 'pointer', display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center',
                      color: '#6d7175',
                    }}>
                      <span style={{ fontSize: '24px', lineHeight: 1 }}>+</span>
                    </button>
                  </>
                )}
              </div>
              <button onClick={handleUndo} style={{
                padding: '10px', borderRadius: '8px', border: '1px solid #c9cccf',
                background: 'white', cursor: 'pointer', fontSize: '16px',
              }}>Undo</button>
            </>
          ) : (
            <>
              <input type="file" accept="image/*" multiple ref={fileRef}
                style={{ display: 'none' }} onChange={handleInitialFileChange} />
              <button onClick={() => fileRef.current?.click()} style={{
                padding: '12px', borderRadius: '8px', border: '1px dashed #c9cccf',
                background: '#f6f6f7', cursor: 'pointer', fontSize: '16px', width: '100%',
              }}>
                Upload photos (1–4)
              </button>
            </>
          )}

          <button
            disabled={photos.length === 0 || uploading}
            onClick={handleSubmit}
            style={{
              padding: '12px', borderRadius: '8px', border: 'none',
              background: photos.length > 0 && !uploading ? '#005bd3' : '#f0f0f0',
              color: photos.length > 0 && !uploading ? 'white' : '#8c9196',
              cursor: photos.length > 0 && !uploading ? 'pointer' : 'not-allowed',
              fontSize: '16px', fontWeight: '600',
            }}>
            {uploading ? 'Uploading...' : 'Submit'}
          </button>
        </BlockStack>
      </div>
    </div>
  );
}

// ─── Instruction popup ────────────────────────────────────────────────────────
function InstructionPopup({ instruction, onClose }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'white', borderRadius: '16px', padding: '24px',
        width: 'calc(100% - 32px)', maxWidth: '420px',
      }}>
        <BlockStack gap="400">
          <Text variant="bodyLg">{instruction}</Text>
          <button onClick={onClose} style={{
            padding: '12px', borderRadius: '8px', border: 'none',
            background: '#005bd3', color: 'white',
            cursor: 'pointer', fontSize: '16px', fontWeight: '600',
          }}>Got it</button>
        </BlockStack>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
function ManagerStockLosses() {
  const navigate = useNavigate();
  const location = localStorage.getItem('managerLocation') || '';

  const [items, setItems]             = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [submitting, setSubmitting]   = useState(false);

  const barcodeBuffer = useRef('');
  const barcodeTimer  = useRef(null);

  const [showTypeIn, setShowTypeIn]     = useState(false);
  const [skuInput, setSkuInput]         = useState('');
  const [skuSearching, setSkuSearching] = useState(false);
  const [skuError, setSkuError]         = useState('');

  const [popupStage, setPopupStage]         = useState(null);
  const [productData, setProductData]       = useState(null);
  const [productSoh, setProductSoh]         = useState(null);
  const [loadingSoh, setLoadingSoh]         = useState(false);
  const [pendingSubmit, setPendingSubmit]   = useState(null);
  const [pendingInstruction, setPendingInstruction] = useState(null);
  const [settings, setSettings]             = useState([]);
  const [customReasons, setCustomReasons]   = useState([]);
  const [localBrands, setLocalBrands]       = useState([]);

  const popupOpen = !!(popupStage || loadingSoh || showTypeIn);

  useEffect(() => {
    document.body.style.overflow = popupOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [popupOpen]);

  const loadItems = useCallback(async () => {
    if (!location) { setLoading(false); return; }
    try {
      const [itemsRes, settingsRes, reasonsRes, brandsRes] = await Promise.all([
        fetch(`/api/stock-losses?location=${encodeURIComponent(location)}`).then(r => r.json()),
        fetch('/api/stock-losses-settings/matrix').then(r => r.json()),
        fetch('/api/stock-losses-settings/custom-reasons').then(r => r.json()),
        fetch('/api/stock-losses-settings/brands').then(r => r.json()),
      ]);
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      setItems((Array.isArray(itemsRes) ? itemsRes : []).filter(i =>
        new Date(i.submitted_at).getTime() > fifteenDaysAgo
      ));
      setSettings(Array.isArray(settingsRes) ? settingsRes : []);
      setCustomReasons(Array.isArray(reasonsRes) ? reasonsRes : []);
      setLocalBrands((Array.isArray(brandsRes) ? brandsRes : []).map(b => b.vendor));
    } catch (e) {
      setError('Failed to load');
    } finally {
      setLoading(false);
    }
  }, [location]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const allReasons = [
    ...BUILT_IN_REASONS,
    ...customReasons.map(r => ({ key: r.reason_key, label: r.reason_label })),
  ];

  // Case-insensitive match between Shopify productType and settings type_value
  const getSetting = (productType, reasonKey, vendor) => {
    const normalizedType = (productType || '').toLowerCase().trim();
    const typeRow = settings.find(s =>
      s.type_value.toLowerCase().trim() === normalizedType &&
      s.reason === reasonKey
    );
    const photoRequired = typeRow?.photo_required ?? false;
    let instruction = null;
    if (typeRow?.instruction_text) {
      const isLocalBrand = vendor && localBrands.includes(vendor);
      const isHSC = normalizedType === 'hair & skin care';
      instruction = (isLocalBrand && isHSC && typeRow.local_supplier_instruction_text)
        ? typeRow.local_supplier_instruction_text
        : typeRow.instruction_text;
    }
    return { photoRequired, instruction };
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (popupStage || loadingSoh || showTypeIn) return;
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
  }, [popupStage, loadingSoh, showTypeIn]);

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
      setProductData({ ...data, barcode, locationId: loc.id });
      setProductSoh(data.soh ?? null);
      setPopupStage('scan');
    } catch (e) {
      setError(e.message || 'Product not found');
    } finally {
      setLoadingSoh(false);
    }
  };

  const handleSkuSearch = async () => {
    if (!skuInput.trim()) return;
    setSkuSearching(true);
    setSkuError('');
    try {
      const locRes  = await fetch('/api/shopify/locations');
      const locData = await locRes.json();
      const loc     = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');
      const res  = await fetch(`/api/shopify/inventory?barcode=${encodeURIComponent(skuInput.trim())}&locationId=${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'SKU not found');
      setShowTypeIn(false);
      setSkuInput('');
      setProductData({ ...data, barcode: skuInput.trim(), locationId: loc.id });
      setProductSoh(data.soh ?? null);
      setPopupStage('scan');
    } catch (e) {
      setSkuError(e.message || 'SKU not found');
    } finally {
      setSkuSearching(false);
    }
  };

  const handleScanSubmit = ({ reason, qty, reasonDetail }) => {
    const { photoRequired, instruction } = getSetting(
      productData.productType, reason.key, productData.vendor
    );
    setPendingSubmit({ reason, qty, reasonDetail });

    if (photoRequired && instruction) {
      setPendingInstruction(instruction);
      setPopupStage('photo');
    } else if (photoRequired && !instruction) {
      setPendingInstruction(null);
      setPopupStage('photo');
    } else if (!photoRequired && instruction) {
      submitEntry({ reason, qty, reasonDetail }, []);
      setPendingInstruction(instruction);
      setPopupStage('instruction');
    } else {
      submitEntry({ reason, qty, reasonDetail }, []);
      closePopup();
    }
  };

  const handlePhotoSubmit = (uploadedPhotos) => {
    submitEntry(pendingSubmit, uploadedPhotos);
    if (pendingInstruction) {
      setPopupStage('instruction');
    } else {
      closePopup();
    }
  };

  const submitEntry = async ({ reason, qty, reasonDetail }, photos) => {
    try {
      const res = await fetch('/api/stock-losses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          barcode: productData.barcode,
          name: productData.name,
          product_type: productData.productType || null,
          vendor: productData.vendor || null,
          location,
          shopify_location_id: productData.locationId,
          reason: reason.key,
          reason_label: reason.label,
          reason_detail: reasonDetail || null,
          qty,
          soh: productSoh,
          photo_urls: photos.map(p => p.url),
          shopify_file_gids: photos.map(p => p.gid),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(prev => [data.row, ...prev]);
    } catch (e) {
      setError('Failed to save entry: ' + e.message);
    }
  };

  const closePopup = () => {
    setPopupStage(null);
    setProductData(null);
    setProductSoh(null);
    setPendingSubmit(null);
    setPendingInstruction(null);
    // Reset iOS viewport zoom caused by input focus
    resetViewportZoom();
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.length === 0) return;
    setSubmitting(true);
    try {
      await fetch('/api/stock-losses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      setItems(prev => prev.filter(i => !selectedIds.includes(i.id)));
      setSelectedIds([]);
    } catch (e) {
      setError('Failed to delete');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteAll = async () => {
    if (!window.confirm('Delete all items?')) return;
    setSubmitting(true);
    try {
      await fetch('/api/stock-losses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: items.map(i => i.id) }),
      });
      setItems([]);
      setSelectedIds([]);
    } catch (e) {
      setError('Failed to delete');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitItems = (ids) => {
    setItems(prev => prev.filter(i => !ids.includes(i.id)));
    setSelectedIds([]);
  };

  const toggleSelectOne = (id) => setSelectedIds(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll = () =>
    setSelectedIds(selectedIds.length === items.length ? [] : items.map(i => i.id));

  const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000 };
  const innerStyle   = {
    position: 'fixed', top: '50%', left: '16px', right: '16px',
    transform: 'translateY(-50%)', background: 'white', borderRadius: '12px',
    padding: '24px', maxWidth: '480px', margin: '0 auto', zIndex: 1001,
  };

  const btnBase = (disabled, danger, primary) => ({
    flex: '1 1 auto', padding: '8px 12px', borderRadius: '8px',
    border: danger ? '1px solid #d72c0d' : primary ? 'none' : '1px solid #c9cccf',
    background: disabled ? '#f6f6f7' : danger ? 'white' : primary ? '#008060' : 'white',
    color: disabled ? '#8c9196' : danger ? '#d72c0d' : primary ? 'white' : '#202223',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '13px', fontWeight: '500',
  });

  return (
    <Page
      title="Stock Losses"
      backAction={{ onAction: () => navigate('/manager') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Text variant="bodySm" tone="subdued">
              Scan to add items · saved for 15 days · shared across this location
            </Text>

            <Card>
              <BlockStack gap="300">
                <button
                  onClick={() => { setSkuInput(''); setSkuError(''); setShowTypeIn(true); }}
                  style={{
                    width: '100%', padding: '10px 16px', borderRadius: '8px',
                    border: '1px solid #c9cccf', background: 'white',
                    cursor: 'pointer', fontSize: '14px', fontWeight: '500', textAlign: 'center',
                  }}>
                  Type in SKU
                </button>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    disabled={selectedIds.length === 0 || submitting}
                    onClick={handleDeleteSelected}
                    style={btnBase(selectedIds.length === 0 || submitting, true, false)}>
                    Delete selected
                  </button>
                  <button
                    disabled={items.length === 0 || submitting}
                    onClick={handleDeleteAll}
                    style={{ ...btnBase(items.length === 0 || submitting, false, false), background: items.length > 0 && !submitting ? '#d72c0d' : '#f6f6f7', color: items.length > 0 && !submitting ? 'white' : '#8c9196', border: 'none' }}>
                    Delete all
                  </button>
                  <button
                    disabled={selectedIds.length === 0 || submitting}
                    onClick={() => handleSubmitItems(selectedIds)}
                    style={btnBase(selectedIds.length === 0 || submitting, false, false)}>
                    Submit selected
                  </button>
                  <button
                    disabled={items.length === 0 || submitting}
                    onClick={() => handleSubmitItems(items.map(i => i.id))}
                    style={btnBase(items.length === 0 || submitting, false, true)}>
                    Submit all
                  </button>
                </div>

                {loading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : items.length === 0 ? (
                  <Text tone="subdued" alignment="center">No items yet. Scan a barcode to add.</Text>
                ) : (
                  <div>
                    <div style={{
                      display: 'grid', gridTemplateColumns: '32px 1fr 80px 80px',
                      gap: '8px', padding: '8px 0', borderBottom: '1px solid #e1e3e5',
                      fontSize: '12px', fontWeight: '600', color: '#6d7175',
                    }}>
                      <Checkbox
                        checked={selectedIds.length === items.length && items.length > 0}
                        indeterminate={selectedIds.length > 0 && selectedIds.length < items.length}
                        onChange={toggleSelectAll}
                      />
                      <span>Name / SKU</span>
                      <span>System</span>
                      <span>Qty</span>
                    </div>
                    {items.map(item => (
                      <div key={item.id} style={{
                        display: 'grid', gridTemplateColumns: '32px 1fr 80px 80px',
                        gap: '8px', padding: '10px 0', borderBottom: '1px solid #f1f1f1',
                        alignItems: 'start',
                      }}>
                        <Checkbox
                          checked={selectedIds.includes(item.id)}
                          onChange={() => toggleSelectOne(item.id)}
                        />
                        <div>
                          <div style={{ fontSize: '14px', fontWeight: '500', wordBreak: 'break-word' }}>
                            {item.name || '-'}
                          </div>
                          <div style={{ fontSize: '12px', color: '#6d7175' }}>{item.barcode}</div>
                          <div style={{ fontSize: '12px', color: '#6d7175', marginTop: '2px' }}>
                            {item.reason_label}
                            {item.reason_detail && ` · ${item.reason_detail}`}
                          </div>
                        </div>
                        <div style={{ fontSize: '14px' }}>{item.soh ?? '—'}</div>
                        <div style={{ fontSize: '14px', color: '#d72c0d', fontWeight: '600' }}>
                          {item.adjustment}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {loadingSoh && (
        <div style={overlayStyle}>
          <div style={innerStyle}>
            <InlineStack align="center"><Spinner /></InlineStack>
          </div>
        </div>
      )}

      {popupStage === 'scan' && productData && (
        <ScanPopup
          productData={productData}
          soh={productSoh}
          allReasons={allReasons}
          onClose={closePopup}
          onSubmit={handleScanSubmit}
        />
      )}

      {popupStage === 'photo' && productData && (
        <PhotoPopup
          sku={productData.barcode}
          onSubmit={handlePhotoSubmit}
          onClose={closePopup}
        />
      )}

      {popupStage === 'instruction' && pendingInstruction && (
        <InstructionPopup
          instruction={pendingInstruction}
          onClose={closePopup}
        />
      )}

      {showTypeIn && (
        <div style={overlayStyle}>
          <div style={innerStyle}>
            <button onClick={() => { setShowTypeIn(false); resetViewportZoom(); }} style={{
              position: 'absolute', top: '12px', right: '12px',
              background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
            }}>✕</button>
            <BlockStack gap="300">
              <Text variant="headingMd" fontWeight="bold">Type in SKU</Text>
              {skuError && <Banner tone="critical" onDismiss={() => setSkuError('')}>{skuError}</Banner>}
              <input
                value={skuInput} inputMode="numeric"
                onChange={e => { setSkuInput(e.target.value); setSkuError(''); }}
                onKeyDown={e => { if (e.key === 'Enter') handleSkuSearch(); }}
                autoComplete="off" autoFocus placeholder="Enter exact SKU"
                style={{
                  width: '100%', padding: '10px 12px', fontSize: '16px',
                  border: '1px solid #c9cccf', borderRadius: '8px',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
              <button
                disabled={!skuInput.trim() || skuSearching}
                onClick={handleSkuSearch}
                style={{
                  padding: '12px', borderRadius: '8px', border: 'none',
                  background: skuInput.trim() && !skuSearching ? '#005bd3' : '#f0f0f0',
                  color: skuInput.trim() && !skuSearching ? 'white' : '#8c9196',
                  cursor: skuInput.trim() && !skuSearching ? 'pointer' : 'not-allowed',
                  fontSize: '16px', fontWeight: '600',
                }}>
                {skuSearching ? 'Searching...' : 'Search'}
              </button>
            </BlockStack>
          </div>
        </div>
      )}
    </Page>
  );
}

export default ManagerStockLosses;