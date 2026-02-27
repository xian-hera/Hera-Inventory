import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Checkbox, Banner, TextField
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function PreviewTask() {
  const navigate = useNavigate();
  const [taskData, setTaskData] = useState(null);
  const [selectedBarcodes, setSelectedBarcodes] = useState([]);
  const [notes, setNotes] = useState([]);
  const [noteInput, setNoteInput] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem('pendingTask');
    if (stored) {
      setTaskData(JSON.parse(stored));
    } else {
      navigate('/buyer/counting-tasks/new');
    }
  }, [navigate]);

  if (!taskData) return null;

  const handleAddNote = () => {
    if (!noteInput.trim()) return;
    setNotes(prev => [...prev, {
      text: noteInput.trim(),
      created_at: new Date().toISOString(),
    }]);
    setNoteInput('');
    setShowNoteInput(false);
  };

  const handleDeleteNote = (index) => {
    setNotes(prev => prev.filter((_, i) => i !== index));
  };

  const handleRemoveSelected = () => {
    setTaskData(prev => ({
      ...prev,
      items: prev.items.filter(p => !selectedBarcodes.includes(p.barcode)),
    }));
    setSelectedBarcodes([]);
  };

  const toggleSelectOne = (barcode) => {
    setSelectedBarcodes(prev =>
      prev.includes(barcode) ? prev.filter(x => x !== barcode) : [...prev, barcode]
    );
  };

  const toggleSelectAll = () => {
    if (selectedBarcodes.length === taskData.items.length) {
      setSelectedBarcodes([]);
    } else {
      setSelectedBarcodes(taskData.items.map(p => p.barcode));
    }
  };

  const handleSave = async (publish) => {
    if (taskData.items.length === 0) {
      setError('No items in task.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department: taskData.department,
          locations: taskData.locations,
          filterSummary: taskData.filterSummary,
          items: taskData.items,
          notes,
          publish,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      sessionStorage.removeItem('pendingTask');
      navigate('/buyer/counting-tasks');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}.${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };

  const rows = taskData.items.map(p => [
    <Checkbox
      checked={selectedBarcodes.includes(p.barcode)}
      onChange={() => toggleSelectOne(p.barcode)}
    />,
    p.name || '-',
    p.barcode || '-',
  ]);

  return (
    <Page
      title={`Preview task — ${taskData.department} ${taskData.locations.join(', ')}`}
      secondaryActions={[{
        content: 'Back to creating',
        onAction: () => navigate('/buyer/counting-tasks/new'),
      }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            {/* Filter summary */}
            <Text variant="bodySm" tone="subdued">{taskData.filterSummary}</Text>

            {/* Action buttons */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" wrap>
                  <Button onClick={() => setShowNoteInput(true)}>Add note</Button>
                  <Button
                    disabled={selectedBarcodes.length === 0}
                    onClick={handleRemoveSelected}
                  >
                    Remove selected
                  </Button>
                  <Button onClick={() => handleSave(false)} loading={saving}>
                    Save as draft
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => handleSave(true)}
                    loading={saving}
                  >
                    Save and publish
                  </Button>
                </InlineStack>

                {/* Note input */}
                {showNoteInput && (
                  <InlineStack gap="200" align="start">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label=""
                        labelHidden
                        placeholder="Enter note..."
                        value={noteInput}
                        onChange={setNoteInput}
                        autoComplete="off"
                      />
                    </div>
                    <Button onClick={handleAddNote}>Save note</Button>
                    <Button onClick={() => { setShowNoteInput(false); setNoteInput(''); }}>
                      Cancel
                    </Button>
                  </InlineStack>
                )}

                {/* Notes list */}
                {notes.length > 0 && (
                  <BlockStack gap="200">
                    {notes.map((note, i) => (
                      <InlineStack key={i} align="space-between">
                        <Text variant="bodyMd">{note.text}</Text>
                        <InlineStack gap="200">
                          <Text variant="bodySm" tone="subdued">{formatDate(note.created_at)}</Text>
                          <Button
                            variant="plain"
                            tone="critical"
                            onClick={() => handleDeleteNote(i)}
                          >
                            ✕
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* Items list */}
            <Card>
              <DataTable
                columnContentTypes={['text','text','text']}
                headings={[
                  <Checkbox
                    checked={selectedBarcodes.length === taskData.items.length && taskData.items.length > 0}
                    indeterminate={selectedBarcodes.length > 0 && selectedBarcodes.length < taskData.items.length}
                    onChange={toggleSelectAll}
                  />,
                  'Name',
                  'SKU',
                ]}
                rows={rows}
              />
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default PreviewTask;