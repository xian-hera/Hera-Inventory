import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Checkbox, Banner, Badge, TextField, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';

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
  // `committing` here only covers the brief gap between clicking Commit and
  // the server confirming the lock was acquired (POST response) — the actual
  // in-progress state (shown to EVERY viewer, not just whoever clicked) comes
  // from task.committing, which is persisted server-side so it also survives
  // a page reload or someone else opening this task while a commit is running.
  const [committing, setCommitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [deletingItems, setDeletingItems] = useState(false);
  const [editingItemId, setEditingItemId] = useState(null);
  const [sendingBack, setSendingBack] = useState(false);
  const [editingValue, setEditingValue] = useState('');

  // quiet=true skips the full-page loading spinner — used while polling for
  // commit progress so the table doesn't flicker every couple seconds.
  const fetchTask = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTask(data);
      setNotes(data.notes || []);
    } catch (e) {
      setError(e.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { fetchTask(); }, [fetchTask]);

  // While a commit is in progress (whether this viewer started it, or it was
  // already running when this page loaded — e.g. someone else started it, or
  // this viewer navigated back to it), poll for live progress. This is what
  // makes "It is OK to leave this page" true: the commit itself runs
  // server-side regardless of whether anyone is polling.
  useEffect(() => {
    if (!task?.committing) return;
    const interval = setInterval(() => fetchTask(true), 1500);
    return () => clearInterval(interval);
  }, [task?.committing, fetchTask]);

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
    if (task.status === 'counting') {
      setError('Counting not finished yet.');
      return;
    }
    setCommitting(true);
    setError('');
    try {
      const itemIds = all
        ? task.items
            .filter(i => !i.is_correct && i.poh !== null && !i.is_committed)
            .map(i => i.id)
        : selectedItemIds;

      if (itemIds.length === 0 && !all) {
        setError('No items to commit.');
        setCommitting(false);
        return;
      }

      // The commit itself now runs in the background on the server — this
      // request only starts it and returns immediately (see PATCH
      // /api/tasks/:id/commit). Progress is picked up by the polling effect
      // above, driven off task.committing.
      const res = await fetch(`/api/tasks/${taskId}/commit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setSelectedItemIds([]);
      // Optimistic update so the button switches to "Committing 0 / N"
      // immediately, without waiting for the next poll.
      setTask(prev => prev ? {
        ...prev,
        committing: true,
        commit_total: itemIds.length,
        commit_item_ids: itemIds,
        commit_warnings: null,
      } : prev);
    } catch (e) {
      setError(e.message);
    } finally {
      setCommitting(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this draft? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [task.id] }),
      });
      if (!res.ok) throw new Error('Delete failed');
      navigate('/buyer/counting-tasks');
    } catch (e) {
      setError(e.message);
      setDeleting(false);
    }
  };

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/publish`, { method: 'PATCH' });
      if (!res.ok) throw new Error('Publish failed');
      fetchTask();
    } catch (e) {
      setError(e.message);
    } finally {
      setPublishing(false);
    }
  };

  const handleDeleteItems = async () => {
    if (selectedItemIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedItemIds.length} selected item(s)? This cannot be undone.`)) return;
    setDeletingItems(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/items`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: selectedItemIds }),
      });
      if (!res.ok) throw new Error('Delete items failed');
      setSelectedItemIds([]);
      fetchTask();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingItems(false);
    }
  };

  const handleSavePoh = async (itemId) => {
    const val = parseInt(editingValue);
    if (isNaN(val)) {
      setEditingItemId(null);
      return;
    }
    try {
      const res = await fetch(`/api/tasks/${taskId}/items/${itemId}/poh`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poh: val }),
      });
      const updated = await res.json();
      setTask(prev => ({
        ...prev,
        items: prev.items.map(i => i.id === updated.id ? updated : i),
      }));
    } catch (e) {
      setError('Failed to save');
    }
    setEditingItemId(null);
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

  const typesLabel = Array.isArray(task.types) && task.types.length > 0
    ? task.types.map(typeDisplay).join(', ')
    : '';

  // Progress for the in-flight commit (if any): counted among exactly the
  // items this commit run started with (task.commit_item_ids), so it isn't
  // thrown off by items that were already committed before this run started.
  const isCommittingOnServer = !!task.committing;
  const commitTotal = task.commit_total ?? (task.commit_item_ids ? task.commit_item_ids.length : 0);
  const commitDone = task.commit_item_ids
    ? task.items.filter(i => task.commit_item_ids.includes(i.id) && i.is_committed).length
    : 0;

  const renderEditingCell = (itemId) => (
    <InlineStack gap="100">
      <div style={{ width: '70px' }}>
        <TextField
          label="" labelHidden
          type="number"
          value={editingValue}
          onChange={setEditingValue}
          autoComplete="off"
          autoFocus
          onKeyDown={e => {
            if (e.key === 'Enter') handleSavePoh(itemId);
            if (e.key === 'Escape') setEditingItemId(null);
          }}
        />
      </div>
      <button
        onMouseDown={e => e.preventDefault()}
        onClick={() => handleSavePoh(itemId)}
        style={{
          padding: '6px 12px', borderRadius: '6px', border: 'none',
          background: '#008060', color: 'white',
          cursor: 'pointer', fontSize: '13px', fontWeight: '600',
          whiteSpace: 'nowrap',
        }}
      >
        Save
      </button>
      <button
        onMouseDown={e => e.preventDefault()}
        onClick={() => setEditingItemId(null)}
        style={{
          padding: '6px 10px', borderRadius: '6px',
          border: '1px solid #c9cccf', background: 'white',
          cursor: 'pointer', fontSize: '13px',
        }}
      >
        ✕
      </button>
    </InlineStack>
  );

  // Send Back to Store (2026-09-24, Hera): reviewing → counting, so the store
  // can keep counting and re-submit. Already-committed items stay locked.
  const handleSendBack = async () => {
    if (!window.confirm('Send this task back to the store? It becomes an active counting task again and the manager can keep counting and re-submit.')) return;
    setSendingBack(true);
    setError('');
    try {
      const res = await fetch(`/api/tasks/${taskId}/send-back`, { method: 'PATCH' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to send back');
      await fetchTask();
    } catch (e) {
      setError(e.message);
    } finally {
      setSendingBack(false);
    }
  };

  const rows = task.items.map(item => {
    let detail = '';
    let result = '';

    const canEdit = task.status === 'reviewing' && !item.is_committed;
    const isEditing = editingItemId === item.id;

    if (item.soh !== null && item.poh !== null) {
      const delta = item.is_correct ? 0 : item.poh - item.soh;
      const isZeroDelta = delta === 0;

      if (item.is_correct || isZeroDelta) {
        // Scan Count mode only: an item that matched (system 0, counted 0)
        // because the manager genuinely scanned it and it came up empty
        // looks identical, in scan_count/poh/soh terms, to one they never
        // scanned at all — Shopify already showed 0 either way. ever_scanned
        // is the only thing that tells them apart, so it gets a red check
        // instead of green: still "no discrepancy to commit", but flagged as
        // unverified rather than confirmed.
        const isUnscannedMatch = task.scan_count_mode && !item.ever_scanned;
        const checkColor = isUnscannedMatch ? '#d72c0d' : 'green';
        detail = '';
        if (canEdit) {
          result = isEditing
            ? renderEditingCell(item.id)
            : (
              <span
                onClick={() => { setEditingItemId(item.id); setEditingValue('0'); }}
                style={{ color: checkColor, fontSize: '18px', cursor: 'pointer' }}
                title={isUnscannedMatch ? 'Never scanned — system already showed 0. Click to edit.' : 'Click to edit'}
              >✓</span>
            );
        } else {
          result = (
            <span
              style={{ color: checkColor, fontSize: '18px' }}
              title={isUnscannedMatch ? 'Never scanned — system already showed 0' : undefined}
            >✓</span>
          );
        }
      } else {
        detail = `System ${item.soh}  Actual ${item.poh}`;
        const displayDelta = delta > 0 ? `+${delta}` : `${delta}`;
        if (canEdit) {
          result = isEditing
            ? renderEditingCell(item.id)
            : (
              <span
                onClick={() => { setEditingItemId(item.id); setEditingValue(String(item.poh)); }}
                style={{
                  cursor: 'pointer', fontWeight: 'bold',
                  color: delta > 0 ? '#008060' : '#d72c0d',
                }}
                title="Click to edit"
              >
                {displayDelta}
              </span>
            );
        } else {
          result = (
            <Text tone={delta > 0 ? 'success' : 'critical'} fontWeight="bold">
              {displayDelta}
            </Text>
          );
        }
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
      title={task.task_no}
      subtitle={[typesLabel, task.location].filter(Boolean).join('  ')}
      backAction={{ onAction: () => navigate('/buyer/counting-tasks') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">

            <InlineStack align="space-between">
              <InlineStack gap="200">
                {getStatusBadge(task.status)}
              </InlineStack>
              <Text variant="bodySm" tone="subdued">{formatDate(task.created_at)}</Text>
            </InlineStack>

            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="start" wrap>
                <InlineStack gap="200" wrap>
                  <Button onClick={() => setShowNoteInput(true)}>Add note</Button>
                  <Button
                    tone="critical"
                    disabled={selectedItemIds.length === 0 || deletingItems}
                    loading={deletingItems}
                    onClick={handleDeleteItems}
                  >
                    Delete selected
                  </Button>
                  {task.status === 'draft' && (
                    <>
                      <Button variant="primary" onClick={handlePublish} loading={publishing}>
                        Publish
                      </Button>
                      <Button tone="critical" onClick={handleDelete} loading={deleting}>
                        Delete
                      </Button>
                    </>
                  )}
                  {isCommittingOnServer ? (
                    <BlockStack gap="100">
                      <Button disabled loading>
                        {`Committing ${commitDone} / ${commitTotal}`}
                      </Button>
                      <Text variant="bodySm" tone="subdued">It is OK to leave this page</Text>
                    </BlockStack>
                  ) : (
                    <>
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
                    </>
                  )}
                </InlineStack>
                {task.status === 'reviewing' && !isCommittingOnServer && (
                  <Button onClick={handleSendBack} loading={sendingBack} disabled={committing}>
                    Send Back to Store
                  </Button>
                )}
                </InlineStack>

                {showNoteInput && (
                  <InlineStack gap="200" align="start">
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
                    <Button onClick={() => { setShowNoteInput(false); setNoteInput(''); }}>
                      Cancel
                    </Button>
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
                            <Button variant="plain" tone="critical" onClick={() => handleDeleteNote(i)}>
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

            <Card>
              <DataTable
                columnContentTypes={['text','text','text','text','text']}
                headings={[
                  <Checkbox
                    checked={selectedItemIds.length === task.items.length && task.items.length > 0}
                    indeterminate={selectedItemIds.length > 0 && selectedItemIds.length < task.items.length}
                    onChange={toggleSelectAll}
                  />,
                  'Name', 'SKU', 'Detail', 'Result',
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