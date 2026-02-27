import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Banner, TextField, Spinner, Checkbox
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}.${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function computePOH(scanHistory, soh) {
  if (!scanHistory || scanHistory.length === 0) return null;
  const last = scanHistory[scanHistory.length - 1];
  if (last.type === 'correct') return soh;
  // Find last correct index
  let lastCorrectIdx = -1;
  for (let i = scanHistory.length - 1; i >= 0; i--) {
    if (scanHistory[i].type === 'correct') { lastCorrectIdx = i; break; }
  }
  // Sum counted values after last correct
  const relevant = lastCorrectIdx >= 0
    ? scanHistory.slice(lastCorrectIdx + 1)
    : scanHistory;
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

  // Scan popup
  const [popupItem, setPopupItem] = useState(null);
  const [popupSoh, setPopupSoh] = useState(null);
  const [countInput, setCountInput] = useState('');
  const [loadingSoh, setLoadingSoh] = useState(false);

  // Barcode buffer for scanner
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

  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  // Listen for barcode scanner input
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (popupItem) return; // Don't scan while popup is open
      if (e.key === 'Enter') {
        const barcode = barcodeBuffer.current.trim();
        barcodeBuffer.current = '';
        if (barcode && task) {
          const matched = task.items.find(i => i.barcode === barcode);
          if (matched) {
            openPopup(matched);
          } else {
            setError(`Barcode "${barcode}" not found in this task.`);
          }
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
  }, [task, popupItem]);

  const openPopup = async (item) => {
    setPopupItem(item);
    setCountInput('');
    setLoadingSoh(true);
    try {
      const locationMap = await fetch('/api/shopify/locations');
      const locData = await locationMap.json();
      const loc = locData.find(l => l.name === location);
      if (!loc) throw new Error('Location not found');

      const res = await fetch(`/api/shopify/inventory/${encodeURIComponent(item.barcode)}/${encodeURIComponent(loc.id)}`);
      const data = await res.json();
      setPopupSoh(data.soh ?? 0);

      // Update SOH in task items
      setTask(prev => ({
        ...prev,
        items: prev.items.map(i =>
          i.id === item.id ? { ...i, soh: data.soh ?? 0 } : i
        ),
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
    const isCorrect = type === 'correct' || (newHistory[newHistory.length - 1]?.type === 'correct');

    await fetch(`/api/tasks/${taskId}/items/${item.id}/scan`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scan_history: newHistory,
        poh: newPoh,
        soh: popupSoh,
        is_correct: isCorrect,
      }),
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
    if (hasUnscanned) {
      setSubmitWarning(true);
    }
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

  const filteredItems = task.items.filter(item => {
    if (filter === 'not_scanned') return item.soh === null;
    if (filter === 'qty_off') return item.soh !== null && !item.is_correct && item.poh !== null;
    return true;
  });

  const rows = filteredItems.map(item => {
    const scanCount = (item.scan_history || []).filter(s => s.type === 'correct' || s.type === 'counted').length;
    const scanBars = Array.from({ length: scanCount }).map((_, i) => (
      <span key={i} style={{ display: 'inline-block', width: '3px', height: '18px', background: 'green', marginRight: '2px' }} />
    ));

    let pohDisplay = '';
    if (item.poh !== null && item.poh !== undefined) {
      const isMatch = item.is_correct || item.poh === item.soh;
      pohDisplay = (
        <span style={{
          background: isMatch ? 'green' : 'transparent',
          color: isMatch ? 'white' : 'inherit',
          padding: isMatch ? '2px 6px' : '0',
          borderRadius: '4px',
        }}>
          {item.poh}
        </span>
      );
    }

    return [
      item.name || '-',
      item.barcode || '-',
      item.soh !== null ? String(item.soh) : '',
      <InlineStack gap="050">{scanBars}</InlineStack>,
      pohDisplay,
    ];
  });

  return (
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

            {/* Actions + Notes */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" wrap align="end">
                  <Button onClick={() => setShowNoteInput(true)}>Add note</Button>
                  <Button
                    variant="primary"
                    onClick={handleSubmit}
                    loading={submitting}
                  >
                    Submit
                  </Button>
                </InlineStack>

                {submitWarning && (
                  <Text tone="critical" fontWeight="bold">Unscanned items!</Text>
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
                    <Button onClick={handleAddNote}>Save note</Button>
                    <Button onClick={() => { setShowNoteInput(false); setNoteInput(''); }}>Cancel</Button>
                  </InlineStack>
                )}

                {notes.length > 0 && (
                  <BlockStack gap="200">
                    <Text variant="headingSm">Note</Text>
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

            {/* Filter */}
            <InlineStack gap="300">
              {['all', 'not_scanned', 'qty_off'].map(f => (
                <Button
                  key={f}
                  variant={filter === f ? 'primary' : 'plain'}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'All' : f === 'not_scanned' ? 'Not scanned' : 'Qty off'}
                </Button>
              ))}
            </InlineStack>

            {/* Items table */}
            <Card>
              <DataTable
                columnContentTypes={['text','text','numeric','text','text']}
                headings={['Name', 'SKU', 'SOH', 'Scan times', 'POH']}
                rows={rows}
              />
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Scan Popup */}
      {popupItem && (
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
            <Button
              variant="plain"
              onClick={closePopup}
              style={{ position: 'absolute', top: '12px', right: '12px' }}
            >
              ✕
            </Button>

            <BlockStack gap="400">
              <InlineStack gap="400">
                <Text variant="headingMd" fontWeight="bold">Name</Text>
                <Text variant="headingMd">{popupItem.name}</Text>
              </InlineStack>
              <InlineStack gap="400">
                <Text variant="headingMd" fontWeight="bold">SKU</Text>
                <Text variant="headingMd">{popupItem.barcode}</Text>
              </InlineStack>

              {/* Scan history */}
              {(popupItem.scan_history || []).length > 0 && (
                <BlockStack gap="100">
                  {popupItem.scan_history.map((s, i) => (
                    <InlineStack key={i} gap="200">
                      <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'black', display: 'inline-block', marginTop: '4px' }} />
                      <Text>{s.type === 'correct' ? 'correct' : `counted ${s.value}`}</Text>
                    </InlineStack>
                  ))}
                  <Text variant="bodySm" tone="subdued">
                    total count {computePOH(popupItem.scan_history, popupItem.soh ?? popupSoh)}
                  </Text>
                </BlockStack>
              )}

              {/* Input */}
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

export default ManagerTaskDetail;