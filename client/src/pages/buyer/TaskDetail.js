import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Checkbox, Banner, Badge, TextField, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}.${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function getStatusBadge(status) {
  const toneMap = {
    counting: 'info',
    reviewing: 'warning',
    committed: 'success',
    auto_committed: 'success',
    draft: 'new',
    archived: '',
  };
  return <Badge tone={toneMap[status] || ''}>{status}</Badge>;
}

function TaskDetail() {
  const navigate = useNavigate();
  const { taskId } = useParams();
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedItemIds, setSelectedItemIds] = useState([]);
  const [notes, setNotes] = useState([]);
  const [noteInput, setNoteInput] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [committing, setCommitting] = useState(false);

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

  const handleAddNote = async () => {
    if (!noteInput.trim()) return;
    const newNotes = [...notes, {
      text: noteInput.trim(),
      created_at: new Date().toISOString(),
    }];
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

  const handleCommit = async (all) => {
    if (!task) return;
    setCommitting(true);
    setError('');
    try {
      const itemIds = all
        ? task.items
            .filter(i => !i.is_correct && i.poh !== null && !i.is_committed)
            .map(i => i.id)
        : selectedItemIds;

      if (itemIds.length === 0) {
        setError('No items to commit.');
        setCommitting(false);
        return;
      }

      const res = await fetch(`/api/tasks/${taskId}/commit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSelectedItemIds([]);
      fetchTask();
    } catch (e) {
      setError(e.message);
    } finally {
      setCommitting(false);
    }
  };

  const toggleSelectOne = (id) => {
    setSelectedItemIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (!task) return;
    if (selectedItemIds.length === task.items.length) {
      setSelectedItemIds([]);
    } else {
      setSelectedItemIds(task.items.map(i => i.id));
    }
  };

  if (loading) return (
    <Page title="Task detail" backAction={{ onAction: () => navigate('/buyer/counting-tasks') }}>
      <Spinner />
    </Page>
  );

  if (!task) return (
    <Page title="Task detail" backAction={{ onAction: () => navigate('/buyer/counting-tasks') }}>
      <Banner tone="critical">{error || 'Task not found'}</Banner>
    </Page>
  );

  const rows = task.items.map(item => {
    let detail = '';
    let result = '';

    if (item.soh !== null && item.poh !== null) {
      if (item.is_correct) {
        result = <span style={{ color: 'green', fontSize: '18px' }}>✓</span>;
      } else {
        const delta = item.poh - item.soh;
        detail = `SOH ${item.soh}  POH ${item.poh}`;
        result = (
          <Text tone={delta > 0 ? 'success' : 'critical'} fontWeight="bold">
            {delta > 0 ? `+${delta}` : `${delta}`}
          </Text>
        );
      }
    }

    return [
      <Checkbox
        checked={selectedItemIds.includes(item.id)}
        onChange={() => toggleSelectOne(item.id)}
      />,
      item.name || '-',
      item.barcode || '-',
      detail,
      item.is_committed ? <Badge tone="success">committed</Badge> : result,
    ];
  });

  return (
    <Page
      title={`${task.task_no}`}
      subtitle={`${task.department}  ${task.location}`}
      backAction={{ onAction: () => navigate('/buyer/counting-tasks') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">

            {/* Header info */}
            <InlineStack align="space-between">
              <InlineStack gap="200">
                {getStatusBadge(task.status)}
              </InlineStack>
              <Text variant="bodySm" tone="subdued">{formatDate(task.created_at)}</Text>
            </InlineStack>

            {/* Filter summary */}
            {task.filter_summary && (
              <Text variant="bodySm" tone="subdued">{task.filter_summary}</Text>
            )}

            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            {/* Actions + Notes */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" wrap>
                  <Button onClick={() => setShowNoteInput(true)}>Add note</Button>
                  <Button
                    disabled={selectedItemIds.length === 0 || committing}
                    onClick={() => handleCommit(false)}
                    loading={committing}
                  >
                    Commit selected
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => handleCommit(true)}
                    loading={committing}
                  >
                    Commit all
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
                    <Text variant="headingSm">Note</Text>
                    {notes.map((note, i) => (
                      <div key={i} style={{ borderBottom: '1px solid #e1e3e5', paddingBottom: '8px' }}>
                        <InlineStack align="space-between">
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
                      </div>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* Items table */}
            <Card>
              <DataTable
                columnContentTypes={['text','text','text','text','text']}
                headings={[
                  <Checkbox
                    checked={selectedItemIds.length === task.items.length && task.items.length > 0}
                    indeterminate={selectedItemIds.length > 0 && selectedItemIds.length < task.items.length}
                    onChange={toggleSelectAll}
                  />,
                  'Name',
                  'SKU',
                  'Detail',
                  'Result',
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

export default TaskDetail;