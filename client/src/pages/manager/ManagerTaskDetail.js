import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Banner, TextField, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import CameraScanner from '../../components/CameraScanner';

const TYPE_LABEL_MAP = {
  'Hair & Skin Care': 'Care',
  'Tools & Accessories': 'Tools + Acc.',
};

function typeDisplay(type) {
  return TYPE_LABEL_MAP[type] || type;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

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

function ManagerTaskDetail() {
  const navigate = useNavigate();
  const { taskId } = useParams();
  const [task, setTask]               = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [filter, setFilter]           = useState('all');
  const [sortAZ, setSortAZ]           = useState(false);
  const [notes, setNotes]             = useState([]);
  const [noteInput, setNoteInput]     = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [submitting, setSubmitting]   = useState(false);

  // 改动三：阻止提交时的提示 banner
  const [submitBlockedMsg, setSubmitBlockedMsg] = useState('');

  const [popupItem, setPopupItem]           = useState(null);
  const [popupSoh, setPopupSoh]             = useState(null);
  const [popupCommitted, setPopupCommitted] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [countInput, setCountInput]         = useState('');
  const [loadingSoh, setLoadingSoh]         = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showSkuInput, setShowSkuInput]   = useState(false);
  const [showCamera, setShowCamera]       = useState(false);
  const cameraPauseRef                    = useRef(false);
  const [skuInput, setSkuInput]           = useState('');
  const [skuError, setSkuError]           = useState('');
  const showSkuInputRef                   = useRef(false);
  const [errorPopup, setErrorPopup]       = useState('');

  const barcodeBuffer = useRef('');
  const barcodeTimer  = useRef(null);
  const popupRef      = useRef(null);
  const taskRef       = useRef(null);
  const location      = localStorage.getItem('managerLocation') || '';

  useEffect(() => { popupRef.current = popupItem; }, [popupItem]);
  useEffect(() => { taskRef.current = task; }, [task]);
  useEffect(() => { showSkuInputRef.current = showSkuInput; }, [showSkuInput]);

  useEffect(() => {
    const anyOpen = !!(popupItem || loadingSoh || showSkuInput);
    document.body.style.overflow = anyOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [popupItem, loadingSoh, showSkuInput]);

  const fetchTask = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch(`/api/tasks/${taskId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTask(data);
      setNotes(data.notes || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { fetchTask(); }, [fetchTask]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (popupRef.current) return;
      if (showSkuInputRef.current) return;
      const activeTag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA'].includes(activeTag)) return;

      if (e.key === 'Enter') {
        clearTimeout(barcodeTimer.current);
        const barcode = cleanBarcode(barcodeBuffer.current.trim());
        barcodeBuffer.current = '';
        if (barcode && taskRef.current) {
          const matched = taskRef.current.items.find(i => i.barcode === barcode);
          if (matched) {
            openPopup(matched);
          } else {
            setErrorPopup(`Barcode "${barcode}" not found in this task.`);
          }
        }
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

  const openPopup = async (item) => {
    setPopupItem(item);
    setCountInput('');
    setShowResetConfirm(false);
    setLoadingSoh(true);
    try {
      const locRes  = await fetch('/api/shopify/locations');
      const locData = await locRes.json();
      const loc     = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');
      const res  = await fetch(`/api/shopify/inventory?barcode=${encodeURIComponent(item.barcode)}&locationId=${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      setPopupSoh(data.soh ?? null);
      setPopupCommitted(data.committed ?? 0);
      setTask(prev => ({
        ...prev,
        items: prev.items.map(i => i.id === item.id ? { ...i, soh: data.soh ?? null } : i),
      }));
    } catch (e) {
      setPopupSoh(null);
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
    setPopupItem(null);
    setPopupSoh(null);
    setPopupCommitted(0);
    setCountInput('');
    setShowResetConfirm(false);
  };

  const handleCorrect = async () => {
    if (!popupItem) return;
    await saveScan(popupItem, 'correct', null);
    closePopup();
  };

  const handleSubmitCount = async () => {
    if (!popupItem || !countInput) return;
    const value = parseInt(countInput);
    if (isNaN(value)) return;
    await saveScan(popupItem, 'counted', value);
    closePopup();
  };

  const saveScan = async (item, type, value) => {
    const newEntry = {
      type,
      value: type === 'correct' ? popupSoh : value,
      created_at: new Date().toISOString(),
    };
    const newHistory = [...(item.scan_history || []), newEntry];
    const newPoh     = computePOH(newHistory, popupSoh);
    const isCorrect  = newHistory[newHistory.length - 1]?.type === 'correct';

    await fetch(`/api/tasks/${taskId}/items/${item.id}/scan`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan_history: newHistory, poh: newPoh, soh: popupSoh, is_correct: isCorrect }),
    });

    setTask(prev => ({
      ...prev,
      items: prev.items.map(i =>
        i.id === item.id
          ? { ...i, scan_history: newHistory, poh: newPoh, soh: popupSoh, is_correct: isCorrect }
          : i
      ),
    }));
  };

  const handleResetConfirmed = async () => {
    if (!popupItem) return;
    const currentSoh = popupSoh;
    await fetch(`/api/tasks/${taskId}/items/${popupItem.id}/scan`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan_history: [], poh: null, soh: currentSoh, is_correct: false }),
    });
    const resetItem = { ...popupItem, scan_history: [], poh: null, is_correct: false, soh: currentSoh };
    setTask(prev => ({
      ...prev,
      items: prev.items.map(i => i.id === popupItem.id ? resetItem : i),
    }));
    setPopupItem(resetItem);
    setCountInput('');
    setShowResetConfirm(false);
  };

  const handleSkuSearch = () => {
    const sku = skuInput.trim();
    if (!sku || !taskRef.current) return;
    const matched = taskRef.current.items.find(i => i.barcode === sku);
    if (matched) {
      setShowSkuInput(false);
      setSkuInput('');
      setSkuError('');
      openPopup(matched);
    } else {
      setSkuError(`SKU "${sku}" not found in this task.`);
    }
  };

  const handleAddNote = async () => {
    if (!noteInput.trim()) return;
    const newNotes = [...notes, { text: noteInput.trim(), created_at: new Date().toISOString() }];
    setNotes(newNotes);
    setNoteInput('');
    setShowNoteInput(false);
    await fetch(`/api/tasks/${taskId}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: newNotes }),
    });
  };

  const handleDeleteNote = async (index) => {
    const newNotes = notes.filter((_, i) => i !== index);
    setNotes(newNotes);
    await fetch(`/api/tasks/${taskId}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: newNotes }),
    });
  };

  // 摄像头扫描回调：与扫码枪逻辑相同
  const handleCameraScan = (barcode) => {
    if (!taskRef.current) return;
    const matched = taskRef.current.items.find(i => i.barcode === barcode);
    if (matched) {
      cameraPauseRef.current = true;
      openPopup(matched);
    } else {
      setErrorPopup(`Barcode "${barcode}" not found in this task.`);
    }
  };

  const handleCameraPopupClose = () => {
    closePopup();
    cameraPauseRef.current = false;
  };

  // 改动三：检查 Not Scanned 数量，若不为 0 则阻止提交并切换筛选
  const handleSubmit = async () => {
    if (!task) return;
    const notScannedCount = task.items.filter(i => i.soh === null).length;
    if (notScannedCount > 0) {
      setSubmitBlockedMsg(`You have not finished, these are not scanned yet.`);
      setFilter('not_scanned');
      return;
    }
    setSubmitBlockedMsg('');
    setSubmitting(true);
    try {
      await fetch(`/api/tasks/${taskId}/submit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      });
      navigate('/manager/counting-tasks');
    } catch (e) {
      setError('Failed to submit task');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <Page title="Task" backAction={{ onAction: () => navigate('/manager/counting-tasks') }}>
      <Spinner />
    </Page>
  );

  if (!task) return (
    <Page title="Task" backAction={{ onAction: () => navigate('/manager/counting-tasks') }}>
      <Banner tone="critical">{error || 'Task not found'}</Banner>
    </Page>
  );

  const totalCount       = task.items.length;
  const processedCount   = task.items.filter(i => i.soh !== null).length;
  const unprocessedCount = totalCount - processedCount;
  const qtyOffCount      = task.items.filter(i => i.soh !== null && !i.is_correct && i.poh !== null).length;

  // 改动一：types 显示
  const typesLabel = Array.isArray(task.types) && task.types.length > 0
    ? task.types.map(typeDisplay).join(', ')
    : '';

  const filteredItems = task.items.filter(item => {
    if (filter === 'not_scanned') return item.soh === null;
    if (filter === 'qty_off')     return item.soh !== null && !item.is_correct && item.poh !== null;
    return true;
  });

  const displayedItems = sortAZ
    ? [...filteredItems].sort((a, b) =>
        (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
      )
    : filteredItems;

  const hasHistory = (popupItem?.scan_history || []).length > 0;

  const rows = displayedItems.map(item => {
    const scanCount = (item.scan_history || []).length;
    const scanBars  = Array.from({ length: Math.min(scanCount, 10) }).map((_, i) => (
      <span key={i} style={{
        display: 'inline-block', width: '3px', height: '16px',
        background: 'green', marginRight: '2px', borderRadius: '1px',
      }} />
    ));

    let pohDisplay = '';
    if (item.poh !== null && item.poh !== undefined) {
      const isMatch = item.is_correct || item.poh === item.soh;
      pohDisplay = (
        <span style={{
          background: isMatch ? '#008060' : 'transparent',
          color:      isMatch ? 'white'   : 'inherit',
          padding:    isMatch ? '2px 8px' : '0',
          borderRadius: '4px',
          fontWeight: isMatch ? 'bold' : 'normal',
        }}>
          {item.poh}
        </span>
      );
    }

    const nameSku = (
      <div>
        <div style={{ fontSize: '14px', fontWeight: '500' }}>{item.name || '-'}</div>
        <div style={{ fontSize: '12px', color: '#6d7175' }}>{item.barcode || '-'}</div>
      </div>
    );

    return [
      <div onClick={() => openPopup(item)} style={{ cursor: 'pointer' }}>{nameSku}</div>,
      <div onClick={() => openPopup(item)} style={{ cursor: 'pointer' }}>{item.soh !== null ? String(item.soh) : ''}</div>,
      <div onClick={() => openPopup(item)} style={{ cursor: 'pointer' }}><InlineStack gap="050">{scanBars}</InlineStack></div>,
      <div onClick={() => openPopup(item)} style={{ cursor: 'pointer' }}>{pohDisplay}</div>,
    ];
  });

  return (
    <div style={{ padding: '0 5px' }}>
      <Page
        title={task.task_no}
        // 改动一：subtitle 显示 types
        subtitle={typesLabel}
        backAction={{ onAction: () => navigate('/manager/counting-tasks') }}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <InlineStack align="end">
                <Text variant="bodySm" tone="subdued">{formatDate(task.created_at)}</Text>
              </InlineStack>

              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

              {/* 改动三：阻止提交时的提示 */}
              {submitBlockedMsg && (
                <Banner tone="critical" onDismiss={() => setSubmitBlockedMsg('')}>
                  {submitBlockedMsg}
                </Banner>
              )}

              <Card>
                <InlineStack gap="400" wrap>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">Unprocessed</Text>
                    <Text variant="headingMd" fontWeight="bold">{unprocessedCount}</Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">Processed</Text>
                    <Text variant="headingMd" fontWeight="bold">{processedCount}</Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">Qty off</Text>
                    <Text variant="headingMd" fontWeight="bold" tone={qtyOffCount > 0 ? 'critical' : undefined}>
                      {qtyOffCount}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued">Total</Text>
                    <Text variant="headingMd" fontWeight="bold">{totalCount}</Text>
                  </BlockStack>
                </InlineStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" wrap align="end">
                    <Button onClick={() => { setSkuInput(''); setSkuError(''); setShowSkuInput(true); }}>
                      Type in SKU
                    </Button>
                    <Button onClick={() => setShowCamera(true)}>
                      <img src="/camera.svg" alt="camera" style={{ width: '20px', height: '20px', display: 'block' }} />
                    </Button>
                    <Button onClick={() => setShowNoteInput(true)}>Add note</Button>
                    <Button variant="primary" onClick={handleSubmit} loading={submitting}>Submit</Button>
                  </InlineStack>

                  {showNoteInput && (
                    <InlineStack gap="200">
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="" labelHidden
                          placeholder="Enter note..."
                          value={noteInput}
                          onChange={setNoteInput}
                          autoComplete="off"
                        />
                      </div>
                      <Button onClick={handleAddNote}>Save</Button>
                      <Button onClick={() => { setShowNoteInput(false); setNoteInput(''); }}>Cancel</Button>
                    </InlineStack>
                  )}

                  {notes.length > 0 && (
                    <BlockStack gap="200">
                      <Text variant="headingSm">Notes</Text>
                      {notes.map((note, i) => (
                        <div key={i} style={{ borderBottom: '1px solid #e1e3e5', paddingBottom: '8px' }}>
                          <InlineStack align="space-between">
                            <Text variant="bodyMd">{note.text}</Text>
                            <InlineStack gap="200">
                              <Text variant="bodySm" tone="subdued">{formatDate(note.created_at)}</Text>
                              <Button variant="plain" tone="critical" onClick={() => handleDeleteNote(i)}>✕</Button>
                            </InlineStack>
                          </InlineStack>
                        </div>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              <InlineStack align="space-between" gap="200">
                <InlineStack gap="200">
                  {['all', 'not_scanned', 'qty_off'].map(f => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      style={{
                        padding: '6px 14px', borderRadius: '20px', border: '1px solid #c9cccf',
                        background: filter === f ? '#008060' : 'white',
                        color: filter === f ? 'white' : '#202223',
                        cursor: 'pointer', fontSize: '13px',
                        fontWeight: filter === f ? '600' : '400',
                      }}
                    >
                      {f === 'all'
                        ? `All (${totalCount})`
                        : f === 'not_scanned'
                          ? `Not scanned (${unprocessedCount})`
                          : `Qty off (${qtyOffCount})`}
                    </button>
                  ))}
                </InlineStack>
                <button
                  onClick={() => setSortAZ(v => !v)}
                  style={{
                    padding: '6px 14px', borderRadius: '20px', border: '1px solid #c9cccf',
                    background: sortAZ ? '#1a1a1a' : 'white',
                    color: sortAZ ? 'white' : '#202223',
                    cursor: 'pointer', fontSize: '13px',
                    fontWeight: sortAZ ? '600' : '400', whiteSpace: 'nowrap',
                  }}
                >
                  {sortAZ ? 'Sort A→Z ✓' : 'Sort'}
                </button>
              </InlineStack>

              <Card>
                <DataTable
                  columnContentTypes={['text', 'numeric', 'text', 'text']}
                  headings={['Name / SKU', 'System', 'Scans', 'Actual']}
                  rows={rows}
                />
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>

        {/* Camera Scanner */}
        {showCamera && (
          <CameraScanner
            onScan={handleCameraScan}
            onClose={() => { setShowCamera(false); cameraPauseRef.current = false; }}
            pauseRef={cameraPauseRef}
          />
        )}

        {/* Error popup */}
        {errorPopup && (
          <div onClick={() => setErrorPopup('')} style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              background: 'white', borderRadius: '12px',
              padding: '24px 32px', maxWidth: '320px', textAlign: 'center',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
              <Text variant="bodyLg" fontWeight="bold">{errorPopup}</Text>
              <div style={{ marginTop: '12px', fontSize: '13px', color: '#6d7175' }}>Tap anywhere to dismiss</div>
            </div>
          </div>
        )}

        {/* Type in SKU popup */}
        {showSkuInput && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          }}>
            <div style={{
              position: 'fixed', top: '50%', left: '16px', right: '16px',
              transform: 'translateY(-50%)',
              background: 'white', borderRadius: '12px', padding: '24px',
              maxWidth: '400px', margin: '0 auto', zIndex: 1001,
            }}>
              <button
                onClick={() => { setShowSkuInput(false); setSkuInput(''); setSkuError(''); }}
                style={{ position: 'absolute', top: '12px', right: '12px',
                  background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer' }}
              >✕</button>
              <BlockStack gap="300">
                <Text variant="headingMd" fontWeight="bold">Type in SKU</Text>
                {skuError && (
                  <div style={{ background: '#fff4f4', borderRadius: '8px', padding: '10px 14px',
                    fontSize: '14px', color: '#d72c0d' }}>
                    {skuError}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '14px', color: '#202223', fontWeight: '500', marginBottom: '4px' }}>SKU</div>
                    <input
                      inputMode="numeric"
                      value={skuInput}
                      onChange={e => { setSkuInput(e.target.value); setSkuError(''); }}
                      onKeyDown={e => { if (e.key === 'Enter') handleSkuSearch(); }}
                      autoComplete="off" autoFocus
                      placeholder="Enter exact SKU"
                      style={{
                        width: '100%', padding: '10px 12px', fontSize: '16px',
                        border: '1px solid #c9cccf', borderRadius: '8px',
                        outline: 'none', boxSizing: 'border-box', display: 'block',
                      }}
                      onFocus={e => { e.target.style.borderColor = '#005bd3'; }}
                      onBlur={e => { e.target.style.borderColor = '#c9cccf'; }}
                    />
                  </div>
                  <button
                    onClick={handleSkuSearch}
                    disabled={!skuInput.trim()}
                    style={{
                      padding: '10px 18px', borderRadius: '8px', border: 'none',
                      background: skuInput.trim() ? '#008060' : '#f6f6f7',
                      color: skuInput.trim() ? 'white' : '#8c9196',
                      cursor: skuInput.trim() ? 'pointer' : 'not-allowed',
                      fontSize: '14px', fontWeight: '600', whiteSpace: 'nowrap',
                    }}
                  >
                    Search
                  </button>
                </div>
              </BlockStack>
            </div>
          </div>
        )}

        {/* Scan Popup */}
        {popupItem && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          }}>
            <div style={{
              position: 'fixed', top: '50%', left: '16px', right: '16px',
              transform: 'translateY(-50%)',
              background: 'white', borderRadius: '12px', padding: '24px',
              maxWidth: '480px', margin: '0 auto', zIndex: 1001,
            }}>
              <button onClick={showCamera ? handleCameraPopupClose : closePopup} style={{
                position: 'absolute', top: '12px', right: '12px',
                background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', zIndex: 1,
              }}>✕</button>

              <BlockStack gap="400">
                <div style={{ paddingRight: '28px' }}>
                  <div style={{ fontSize: '16px', fontWeight: '700', lineHeight: '1.4', wordBreak: 'break-word' }}>
                    {popupItem.name}
                  </div>
                </div>

                {(popupItem.scan_history || []).length > 0 && (
                  <BlockStack gap="100">
                    {popupItem.scan_history.map((s, i) => (
                      <InlineStack key={i} gap="200">
                        <span style={{
                          width: '8px', height: '8px', borderRadius: '50%',
                          background: 'black', display: 'inline-block', marginTop: '6px',
                        }} />
                        <Text>{s.type === 'correct' ? 'correct' : `counted ${s.value}`}</Text>
                      </InlineStack>
                    ))}
                    <Text variant="bodySm" tone="subdued">
                      total count {computePOH(popupItem.scan_history, popupItem.soh ?? popupSoh)}
                    </Text>
                  </BlockStack>
                )}

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    inputMode="numeric"
                    placeholder="Input your count"
                    value={countInput}
                    onChange={e => setCountInput(e.target.value)}
                    autoComplete="off" autoFocus
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

                {loadingSoh ? <Spinner /> : popupSoh === null ? (
                  <div style={{ background: '#fff4f4', borderRadius: '12px', padding: '16px',
                    textAlign: 'center', fontSize: '14px', color: '#d72c0d' }}>
                    System — (network error, please close and retry)
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'stretch' }}>
                      {hasHistory && (
                        <button
                          onClick={() => setShowResetConfirm(true)}
                          style={{
                            padding: '0 16px', borderRadius: '12px',
                            border: '2px solid #c9cccf', background: 'white',
                            color: '#202223', cursor: 'pointer',
                            fontSize: '14px', fontWeight: '600', whiteSpace: 'nowrap',
                          }}
                        >
                          Reset
                        </button>
                      )}
                      <button onClick={handleCorrect} style={{
                        flex: 1, background: '#008060', color: 'white', border: 'none',
                        borderRadius: '12px', padding: '20px', fontSize: '22px',
                        fontWeight: 'bold', cursor: 'pointer',
                      }}>
                        System {popupSoh}　Correct
                      </button>
                    </div>

                    {popupCommitted > 0 && (
                      <div style={{ textAlign: 'center', fontSize: '13px', color: '#e67c00', fontWeight: '500' }}>
                        {popupCommitted} committed
                      </div>
                    )}
                    <button
                      onClick={() => openHistory(popupItem.barcode)}
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
            </div>
          </div>
        )}

        {/* Reset confirm */}
        {showResetConfirm && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px',
          }}>
            <div style={{ background: 'white', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '360px' }}>
              <BlockStack gap="300">
                <Text variant="headingMd" fontWeight="bold">Confirm to reset the count?</Text>
                <Text variant="bodyMd" tone="subdued">
                  It will erase all the count history and start from the beginning.
                </Text>
                <InlineStack gap="200" align="center">
                  <button
                    onClick={handleResetConfirmed}
                    style={{
                      padding: '10px 24px', borderRadius: '8px', border: 'none',
                      background: '#d72c0d', color: 'white',
                      cursor: 'pointer', fontSize: '14px', fontWeight: '600',
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setShowResetConfirm(false)}
                    style={{
                      padding: '10px 24px', borderRadius: '8px',
                      border: '1px solid #c9cccf', background: 'white',
                      cursor: 'pointer', fontSize: '14px',
                    }}
                  >
                    Cancel
                  </button>
                </InlineStack>
              </BlockStack>
            </div>
          </div>
        )}

      </Page>
    </div>
  );
}

export default ManagerTaskDetail;