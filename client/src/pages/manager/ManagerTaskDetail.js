import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Banner, TextField, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';

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

function ManagerTaskDetail() {
  const navigate = useNavigate();
  const { taskId } = useParams();
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [notes, setNotes] = useState([]);
  const [noteInput, setNoteInput] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitWarning, setSubmitWarning] = useState(false);

  // Popup
  const [popupItem, setPopupItem] = useState(null);
  const [popupSoh, setPopupSoh] = useState(null);
  const [countInput, setCountInput] = useState('');
  const [loadingSoh, setLoadingSoh] = useState(false);

  // Error popup (problem 8)
  const [errorPopup, setErrorPopup] = useState('');

  const barcodeBuffer = useRef('');
  const barcodeTimer = useRef(null);
  const location = localStorage.getItem('managerLocation') || '';

  const fetchTask = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
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
      if (popupItem) return;
      if (e.key === 'Enter') {
        const barcode = barcodeBuffer.current.trim();
        barcodeBuffer.current = '';
        if (barcode && task) {
          const matched = task.items.find(i => i.barcode === barcode);
          if (matched) {
            openPopup(matched);
          } else {
            setErrorPopup(`Barcode "${barcode}" not found in this task.`);
          }
        }
      } else if (e.key.length === 1) {
        barcodeBuffer.current += e.key;
        clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => { barcodeBuffer.current = ''; }, 500);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [task, popupItem]);

  const openPopup = async (item) => {
    setPopupItem(item);
    setCountInput('');
    setLoadingSoh(true);
    try {
      const locRes = await fetch('/api/shopify/locations');
      const locData = await locRes.json();
      const loc = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');
      const res = await fetch(`/api/shopify/inventory/${encodeURIComponent(item.barcode)}/${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      setPopupSoh(data.soh ?? 0);
      setTask(prev => ({
        ...prev,
        items: prev.items.map(i => i.id === item.id ? { ...i, soh: data.soh ?? 0 } : i),
      }));
    } catch (e) {
      setPopupSoh(0);
    } finally {
      setLoadingSoh(false);
    }
  };

  const closePopup = () => {
    setPopupItem(null);
    setPopupSoh(null);
    setCountInput('');
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
    const newPoh = computePOH(newHistory, popupSoh);
    const isCorrect = newHistory[newHistory.length - 1]?.type === 'correct';

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

  const handleSubmit = async () => {
    if (!task) return;
    const hasUnscanned = task.items.some(i => i.soh === null);
    if (hasUnscanned) setSubmitWarning(true);
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

  // Stats (problem 10)
  const totalCount = task.items.length;
  const processedCount = task.items.filter(i => i.soh !== null).length;
  const unprocessedCount = totalCount - processedCount;
  const qtyOffCount = task.items.filter(i => i.soh !== null && !i.is_correct && i.poh !== null).length;

  const filteredItems = task.items.filter(item => {
    if (filter === 'not_scanned') return item.soh === null;
    if (filter === 'qty_off') return item.soh !== null && !item.is_correct && item.poh !== null;
    return true;
  });

  const rows = filteredItems.map(item => {
    const scanCount = (item.scan_history || []).length;
    const scanBars = Array.from({ length: Math.min(scanCount, 10) }).map((_, i) => (
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
          color: isMatch ? 'white' : 'inherit',
          padding: isMatch ? '2px 8px' : '0',
          borderRadius: '4px',
          fontWeight: isMatch ? 'bold' : 'normal',
        }}>
          {item.poh}
        </span>
      );
    }

    // Problem 9: Name/SKU combined column
    const nameSku = (
      <div>
        <div style={{ fontSize: '14px', fontWeight: '500' }}>{item.name || '-'}</div>
        <div style={{ fontSize: '12px', color: '#6d7175' }}>{item.barcode || '-'}</div>
      </div>
    );

    return [
      nameSku,
      item.soh !== null ? String(item.soh) : '',
      <InlineStack gap="050">{scanBars}</InlineStack>,
      pohDisplay,
    ];
  });

  return (
    // Problem 7: mobile padding
    <div style={{ padding: '0 5px' }}>
      <Page
        title={task.task_no}
        subtitle={task.department}
        backAction={{ onAction: () => navigate('/manager/counting-tasks') }}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <InlineStack align="end">
                <Text variant="bodySm" tone="subdued">{formatDate(task.created_at)}</Text>
              </InlineStack>

              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

              {/* Problem 10: Stats */}
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

              {/* Actions + Notes */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" wrap align="end">
                    <Button onClick={() => setShowNoteInput(true)}>Add note</Button>
                    <Button variant="primary" onClick={handleSubmit} loading={submitting}>Submit</Button>
                  </InlineStack>

                  {submitWarning && (
                    <Text tone="critical" fontWeight="bold">Warning: there are unscanned items!</Text>
                  )}

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

              {/* Filter tabs */}
              <InlineStack gap="200">
                {['all', 'not_scanned', 'qty_off'].map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '20px',
                      border: '1px solid #c9cccf',
                      background: filter === f ? '#008060' : 'white',
                      color: filter === f ? 'white' : '#202223',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: filter === f ? '600' : '400',
                    }}
                  >
                    {f === 'all' ? `All (${totalCount})` : f === 'not_scanned' ? `Not scanned (${unprocessedCount})` : `Qty off (${qtyOffCount})`}
                  </button>
                ))}
              </InlineStack>

              {/* Items table */}
              <Card>
                <DataTable
                  columnContentTypes={['text','numeric','text','text']}
                  headings={['Name / SKU', 'SOH', 'Scans', 'POH']}
                  rows={rows}
                />
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>

        {/* Error popup (problem 8) */}
        {errorPopup && (
          <div
            onClick={() => setErrorPopup('')}
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.5)', zIndex: 2000,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div style={{
              background: 'white', borderRadius: '12px',
              padding: '24px 32px', maxWidth: '320px', textAlign: 'center',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
              <Text variant="bodyLg" fontWeight="bold">{errorPopup}</Text>
              <div style={{ marginTop: '12px', fontSize: '13px', color: '#6d7175' }}>
                Tap anywhere to dismiss
              </div>
            </div>
          </div>
        )}

        {/* Scan Popup */}
        {popupItem && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 5px',
          }}>
            <div style={{
              background: 'white', borderRadius: '12px',
              padding: '24px', width: '100%', maxWidth: '500px',
              position: 'relative',
            }}>
              <button
                onClick={closePopup}
                style={{
                  position: 'absolute', top: '12px', right: '12px',
                  background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
                }}
              >✕</button>

              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text variant="headingMd" fontWeight="bold">{popupItem.name}</Text>
                  <Text variant="bodyMd" tone="subdued">{popupItem.barcode}</Text>
                </BlockStack>

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

                {loadingSoh ? <Spinner /> : (
                  <button
                    onClick={handleCorrect}
                    style={{
                      background: '#008060', color: 'white', border: 'none',
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
    </div>
  );
}

export default ManagerTaskDetail;