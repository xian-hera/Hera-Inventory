import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Checkbox, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { fetchLocationMap } from '../shared/locationMap';
import FulfilCountInfo from '../shared/FulfilCountInfo';
import CountPills from '../shared/CountPills'; // count history as pills (2026-11-12)
// Store location: remembered per Shopify account, loaded before this page
// renders by ManagerLocationGate (2026-09-29) — replaces reading
// localStorage 'managerLocation' directly. See client/src/accountMemory.js.
import { getManagerLocation } from '../../accountMemory';
import { StatusTime } from '../shared/statusTime';
// High-placed confirm dialog (Polaris Modal rises from the bottom on phones,
// where Shopify's bar can cover its buttons) — shared with Store Supply.
import { ConfirmBox } from '../warehouse/supplyShared';
// Hub number keypad (2026-11-12, Hera): count + Type in SKU boxes are marked
// data-hub-keypad; the one keypad (components/NumberKeypad.js, mounted in
// App.js) shows for them and pushes the popup (data-keypad-panel) up.
import { useNumberKeypad } from '../../components/NumberKeypad';

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

// "OCT.23" — submitted date in the recent list (2026-10-27).
const SHORT_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
// Not used since 2026-11-09 (Hera: the History shows only one date+time, the
// Date column); kept per the project's no-silent-delete rule.
// eslint-disable-next-line no-unused-vars
function shortDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return `${SHORT_MONTHS[d.getMonth()]}.${String(d.getDate()).padStart(2, '0')}`;
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
  // Submit Selected / Submit All ask first (2026-11-10, Hera): ids waiting for the confirm.
  const [confirmIds, setConfirmIds]     = useState(null);
  const keypad   = useNumberKeypad();
  const countRef = useRef(null);
  const skuRef   = useRef(null);
  const [loadingItems, setLoadingItems] = useState(true);

  const [popupData, setPopupData]               = useState(null);
  const [popupSoh, setPopupSoh]                 = useState(null);
  const [popupScanHistory, setPopupScanHistory] = useState([]);
  const [countInput, setCountInput]             = useState('');
  const [loadingSoh, setLoadingSoh]             = useState(false);
  const [popupCommitted, setPopupCommitted]     = useState(0);
  const [historyLoading, setHistoryLoading]     = useState(false);

  const [showTypeIn, setShowTypeIn]     = useState(false);
  const [skuInput, setSkuInput]         = useState('');
  const [skuSearching, setSkuSearching] = useState(false);
  const [skuError, setSkuError]         = useState('');

  const barcodeBuffer = useRef('');
  const barcodeTimer  = useRef(null);
  const popupRef      = useRef(null);
  const typeInRef     = useRef(false);
  const location      = getManagerLocation() || '';

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
      if (!res.ok) throw new Error(data.error || 'Failed to load items');
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError('Failed to load items');
    } finally {
      setLoadingItems(false);
    }
  }, [location]);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  // Submitted in the past 15 days (2026-10-27, Hera): own card under the
  // list, with the status — Submitted until Purchasing commits, then
  // Committed. GET /api/reports/manager-recent.
  const [recent, setRecent] = useState([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const loadRecent = useCallback(async () => {
    if (!location) { setRecentLoading(false); return; }
    try {
      const res = await fetch(`/api/reports/manager-recent?location=${encodeURIComponent(location)}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setRecent(data);
    } catch (e) { /* secondary list — no error banner */ }
    finally { setRecentLoading(false); }
  }, [location]);
  useEffect(() => { loadRecent(); }, [loadRecent]);

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

  // 修复：使用 query string 格式，避免 barcode 含特殊字符导致 404
  const openPopupByBarcode = async (barcode) => {
    setLoadingSoh(true);
    setError('');
    try {
      const locData = await fetchLocationMap(); // shared location map (2026-09-24)
      const loc     = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');
      const res  = await fetch(`/api/shopify/inventory?barcode=${encodeURIComponent(barcode)}&locationId=${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Product not found');
      const existing = items.find(i => i.barcode === data.barcode);
      setPopupData({ ...data, locationId: loc.id });
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
      const locData = await fetchLocationMap(); // shared location map (2026-09-24)
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

  const handleCorrect = async () => {
    if (!popupData) { closePopup(); return; }
    const newEntry   = { type: 'correct', created_at: new Date().toISOString() };
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
      const locData = await fetchLocationMap(); // shared location map (2026-09-24)
      const loc     = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');
      const res  = await fetch(`/api/shopify/inventory?barcode=${encodeURIComponent(skuInput.trim())}&locationId=${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'SKU not found');
      setShowTypeIn(false); setSkuInput('');
      const existing = items.find(i => i.barcode === data.barcode);
      setPopupData({ ...data, locationId: loc.id });
      setPopupSoh(data.soh ?? null);
      setPopupCommitted(data.committed ?? 0);
      setPopupScanHistory(existing?.scan_history || []);
      setCountInput('');
    } catch (e) {
      setSkuError(e.message || 'SKU not found');
    } finally {
      setSkuSearching(false);
    }
  };

  const isMarkedCorrect = (item) => {
    const h = item.scan_history;
    return Array.isArray(h) && h.length > 0 && h[h.length - 1].type === 'correct';
  };

  const handleSubmitItems = async (ids) => {
    setSubmitting(true);
    try {
      const toSubmit = items.filter(i => ids.includes(i.id) && !isMarkedCorrect(i));
      if (toSubmit.length === 0) {
        setError('Selected item(s) are marked "Correct" — nothing to submit.');
        return;
      }
      const res = await fetch('/api/reports/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: toSubmit }),
      });
      if (!res.ok) throw new Error('Failed to submit');
      const submittedIds = toSubmit.map(i => i.id);
      setItems(prev => prev.filter(i => !submittedIds.includes(i.id)));
      setSelectedIds(prev => prev.filter(id => !submittedIds.includes(id)));
      loadRecent(); // the submitted items show up in the card below
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

  const handleExportCSV = () => {
    if (items.length === 0) return;
    const escapeCsv = (val) => {
      const str = String(val ?? '');
      return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const header = ['Name', 'SKU', 'System', 'Actual'];
    const dataRows = items.map(item => [
      escapeCsv(item.name),
      escapeCsv(item.barcode),
      escapeCsv(item.soh),
      escapeCsv(item.poh),
    ].join(','));
    const csvContent = [header.join(','), ...dataRows].join('\r\n');
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const datePart = new Date().toISOString().slice(0, 10);
    link.download = `inventory-count-${location || 'export'}-${datePart}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

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
    transform: 'translateY(-50%)', maxHeight: 'calc(100vh - 176px)', overflowY: 'auto',
    background: 'white', borderRadius: '12px', padding: '24px',
    maxWidth: '480px', margin: '0 auto', zIndex: 1001,
  };

  return (
    <Page title="Manual Inventory Count" backAction={{ onAction: () => navigate('/manager') /* was the Inventory Count sub-menu (2026-10-22) */ }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {/* The small "Scan to add items · saved for 15 days" line was
                removed (2026-10-27, Hera). */}
            <Card>
              <BlockStack gap="300">
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => { setSkuInput(''); setSkuError(''); setShowTypeIn(true); }}
                    style={{ flex: 1, padding: '10px 16px', borderRadius: '8px',
                      border: '1px solid #c9cccf', background: 'white', color: '#202223',
                      cursor: 'pointer', fontSize: '14px', fontWeight: '500', textAlign: 'center' }}>
                    Type in SKU
                  </button>
                  <button disabled={items.length === 0} onClick={handleExportCSV}
                    style={{ flex: 1, padding: '10px 16px', borderRadius: '8px',
                      border: '1px solid #c9cccf',
                      background: items.length === 0 ? '#f6f6f7' : 'white',
                      color: items.length === 0 ? '#8c9196' : '#202223',
                      cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '14px', fontWeight: '500', textAlign: 'center' }}>
                    Export to CSV
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
                    Delete Selected
                  </button>
                  <button disabled={items.length === 0 || submitting} onClick={handleDeleteAll}
                    style={{ flex: '1 1 auto', padding: '8px 12px', borderRadius: '8px',
                      border: 'none',
                      background: items.length === 0 ? '#f6f6f7' : '#d72c0d',
                      color: items.length === 0 ? '#8c9196' : 'white',
                      cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '13px', fontWeight: '500' }}>
                    Delete All
                  </button>
                  <button disabled={selectedIds.length === 0 || submitting}
                    onClick={() => setConfirmIds(selectedIds)}
                    style={{ flex: '1 1 auto', padding: '8px 12px', borderRadius: '8px',
                      border: '1px solid #c9cccf',
                      background: selectedIds.length === 0 ? '#f6f6f7' : 'white',
                      color: selectedIds.length === 0 ? '#8c9196' : '#202223',
                      cursor: selectedIds.length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '13px', fontWeight: '500' }}>
                    Submit Selected
                  </button>
                  <button disabled={items.length === 0 || submitting}
                    onClick={() => setConfirmIds(items.map(i => i.id))}
                    style={{ flex: '1 1 auto', padding: '8px 12px', borderRadius: '8px',
                      border: 'none',
                      background: items.length === 0 ? '#f6f6f7' : '#008060',
                      color: items.length === 0 ? '#8c9196' : 'white',
                      cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                      fontSize: '13px', fontWeight: '500' }}>
                    Submit All
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

            {/* Submitted in the past 30 days (15 until 2026-10-28) — status Submitted / Committed (2026-10-27). */}
            {/* 2026-11-09 (Hera): card title "History"; new Adjust column
                (Actual − System, e.g. System 2 / Actual 0 → -2) and, right of
                Status, when the entry got that status ("HH:MM, Oct. 12"). */}
            <Card>
              <BlockStack gap="300">
              <Text variant="headingSm">History</Text>
              {recentLoading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : recent.length === 0 ? (
                <Text tone="subdued" alignment="center">Nothing submitted in the past 30 days.</Text>
              ) : (
                // A CSS grid instead of the DataTable (2026-11-09): with the
                // Adjust and Date columns the DataTable no longer fit a phone
                // and scrolled sideways. Phone: the date sits under the
                // Status pill (still the right-most column).
                <div className="mzq-hist">
                  <style>{`
                    .mzq-hist .mzq-row { display: grid; grid-template-columns: minmax(0, 1fr) 64px 64px 64px 104px 112px; column-gap: 16px; align-items: start; }
                    .mzq-hist .mzq-num { text-align: right; font-size: 14px; }
                    .mzq-hist .mzq-under { display: none; margin-top: 4px; }
                    .mzq-hist .mzq-pill { display: inline-block; padding: 4px 12px; border-radius: 999px; white-space: nowrap; font-size: 13px; font-weight: 600; }
                    @media (max-width: 767px) {
                      .mzq-hist .mzq-row { grid-template-columns: minmax(0, 1fr) 46px 42px 44px 90px; column-gap: 6px; }
                      .mzq-hist .mzq-datecol { display: none; }
                      .mzq-hist .mzq-under { display: block; }
                      .mzq-hist .mzq-pill { padding: 4px 8px; }
                    }
                  `}</style>
                  <div className="mzq-row" style={{ padding: '8px 0', borderBottom: '1px solid #e1e3e5', fontSize: '12px', fontWeight: 600, color: '#6d7175' }}>
                    <span>Name / SKU</span>
                    <span className="mzq-num" style={{ fontSize: '12px' }}>System</span>
                    <span className="mzq-num" style={{ fontSize: '12px' }}>Actual</span>
                    <span className="mzq-num" style={{ fontSize: '12px' }}>Adjust</span>
                    <span>Status</span>
                    <span className="mzq-datecol">Date</span>
                  </div>
                  {recent.map(r => {
                    const committed = r.status === 'committed' || r.status === 'archived';
                    // Adjust = Actual − System (System 2, Actual 0 → -2)
                    const adjust = (r.soh == null || r.poh == null) ? null : Number(r.poh) - Number(r.soh);
                    const when = r.status_changed_at || (committed ? r.committed_at : r.submitted_at);
                    return (
                      <div key={r.id} className="mzq-row" style={{ padding: '10px 0', borderBottom: '1px solid #f1f1f1' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '14px', fontWeight: '500', wordBreak: 'break-word', whiteSpace: 'normal' }}>{r.name || '-'}</div>
                          <div style={{ fontSize: '12px', color: '#6d7175', wordBreak: 'break-all' }}>{r.barcode || '-'}</div>{/* submit date after the SKU removed 2026-11-09 (Hera) */}
                        </div>
                        <div className="mzq-num">{r.soh ?? '-'}</div>
                        <div className="mzq-num">{r.poh ?? '-'}</div>
                        <div className="mzq-num">{adjust == null ? '-' : (adjust > 0 ? `+${adjust}` : String(adjust))}</div>
                        <div>
                          <span className="mzq-pill" style={{
                            background: committed ? '#CDFEE1' : '#E1E3E5', color: committed ? '#0C5132' : '#3F4448',
                          }}>{committed ? 'Committed' : 'Submitted'}</span>
                          <div className="mzq-under"><StatusTime value={when} style={{ fontSize: 12 }} /></div>
                        </div>
                        <div className="mzq-datecol" style={{ paddingTop: 3 }}><StatusTime value={when} /></div>
                      </div>
                    );
                  })}
                </div>
              )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Scan Popup */}
      {(popupData || loadingSoh) && (
        <div style={overlayStyle}>
          <div style={popupInnerStyle} data-keypad-panel="center">
            {loadingSoh
              ? <InlineStack align="center"><Spinner /></InlineStack>
              : <>
                  <button onClick={closePopup} style={{
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
                        {/* one pill per count, green ✓ for Correct (2026-11-12, Hera) */}
                        <CountPills history={popupScanHistory} />
                        <Text variant="bodySm" tone="subdued">
                          total count {computePOH(popupScanHistory, popupSoh)}
                        </Text>
                      </BlockStack>
                    )}
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        ref={countRef}
                        data-hub-keypad="neg"
                        inputMode={keypad ? 'none' : 'numeric'}
                        placeholder="Input your count"
                        value={countInput}
                        onChange={e => setCountInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && countInput) handleSubmitCount(); }}
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
                        {/* Fulfillment-location info (2026-10): committed/picked only
                            come back for the location set in Online Settings; it
                            replaces the old one-line "N committed" text. */}
                        <FulfilCountInfo soh={popupSoh} committed={popupCommitted} picked={popupData?.picked ?? 0} />
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
                        {/* green System Correct at the bottom (2026-11-12, Hera) */}
                        <button onClick={handleCorrect} style={{ background: 'green', color: 'white',
                          border: 'none', borderRadius: '12px', padding: '20px', fontSize: '22px',
                          fontWeight: 'bold', cursor: 'pointer', width: '100%' }}>
                          System {popupSoh}　Correct
                        </button>
                      </>
                    )}
                  </BlockStack>
                </>
            }
          </div>
        </div>
      )}

      {/* Type in SKU popup */}
      {showTypeIn && (
        <div style={overlayStyle}>
          <div style={popupInnerStyle} data-keypad-panel="center">
            <button onClick={() => setShowTypeIn(false)} style={{ position: 'absolute',
              top: '12px', right: '12px', background: 'none', border: 'none',
              fontSize: '20px', cursor: 'pointer' }}>✕</button>
            <BlockStack gap="300">
              <Text variant="headingMd" fontWeight="bold">Type in SKU</Text>
              {skuError && <Banner tone="critical" onDismiss={() => setSkuError('')}>{skuError}</Banner>}
              <div style={{ marginBottom: '4px', fontSize: '14px', color: '#202223', fontWeight: '500' }}>SKU</div>
              <input
                ref={skuRef}
                data-hub-keypad=""
                value={skuInput}
                inputMode={keypad ? 'none' : 'numeric'}
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
      {/* Confirm for Submit Selected / Submit All (2026-11-10, Hera). Items
          marked "Correct" are not submitted (same as before). */}
      {(() => {
        if (!confirmIds) return null;
        const chosen = items.filter(i => confirmIds.includes(i.id));
        const n = chosen.filter(i => !isMarkedCorrect(i)).length;
        const skipped = chosen.length - n;
        const all = confirmIds.length === items.length;
        return (
          <ConfirmBox
            open
            title={all ? 'Submit All Items?' : 'Submit Selected Items?'}
            confirmLabel="Submit"
            busy={submitting}
            onCancel={() => setConfirmIds(null)}
            onConfirm={async () => { await handleSubmitItems(confirmIds); setConfirmIds(null); }}
          >
            {n === 0
              ? 'The chosen items are all marked “Correct” — there is nothing to submit.'
              : <>
                  {`${n} ${n === 1 ? 'item' : 'items'} will be submitted. Please check the counts first — submitted items can’t be changed.`}
                  {skipped > 0 && <div style={{ marginTop: 6, color: '#616161' }}>{`${skipped} marked “Correct” ${skipped === 1 ? 'is' : 'are'} not submitted.`}</div>}
                </>}
          </ConfirmBox>
        );
      })()}
      {/* Bottom safe area (2026-09-24, Hera): keeps the last content above
          Shopify's native bottom buttons on Android; same 80px spacer as the
          other manager pages, on every device. */}
      <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} aria-hidden="true" />
    </Page>
  );
}

export default ManagerZeroQtyReport;