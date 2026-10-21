import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Page, Layout, Card, BlockStack, InlineStack, Text, Button, Banner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

// Warehouse Settings (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §10a).
// One card for now: "Custom Task" → Task Types, the options of the Type
// dropdown in Schedule › Create task.
//   • every type is a pill with × (delete)
//   • "Add type" adds a pill whose text is editable right away; click
//     elsewhere (or Enter) saves it
//   • click a pill's text to rename it
//   • empty text on save → the pill is removed; a duplicate name
//     (case-insensitive) is refused
//   • zero types is allowed
// Every change is saved at once (PUT /api/warehouse/task-types). Existing
// custom tasks keep the type text they were created with.

let keySeq = 0;
const withKeys = (list) => list.map(name => ({ key: `t${++keySeq}`, name }));

function EditablePill({ item, editing, onStartEdit, onCommit, onCancel, onDelete, busy }) {
  const [draft, setDraft] = useState(item.name);
  const inputRef = useRef(null);
  const doneRef = useRef(false);
  useEffect(() => {
    if (editing) {
      setDraft(item.name);
      doneRef.current = false;
      setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
    }
  }, [editing, item.name]);

  const finish = (save) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (save) onCommit(draft); else onCancel();
  };

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: 14,
      background: editing ? '#ffffff' : '#f1f2f3', border: editing ? '1px solid #8a8a8a' : '1px solid transparent',
      fontSize: 13,
    }}>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          maxLength={40}
          size={Math.max(6, draft.length + 1)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          }}
          style={{ border: 'none', outline: 'none', font: 'inherit', background: 'transparent', padding: 0 }}
          aria-label="Type name"
        />
      ) : (
        <span
          role="button"
          tabIndex={0}
          title="Click to rename"
          onClick={() => !busy && onStartEdit()}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) onStartEdit(); }}
          style={{ cursor: busy ? 'default' : 'text' }}
        >{item.name}</span>
      )}
      {!editing && (
        <span
          role="button"
          tabIndex={0}
          aria-label={`Delete ${item.name}`}
          onClick={() => !busy && onDelete()}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) onDelete(); }}
          style={{ cursor: busy ? 'default' : 'pointer', marginLeft: 8, color: '#d72c0d', opacity: busy ? 0.5 : 1 }}
        >×</span>
      )}
    </span>
  );
}

function WarehouseSettings() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]); // [{ key, name }] — '' name = new, not saved yet
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingKey, setEditingKey] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    return fetch('/api/warehouse/task-types')
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to load'); return d; })
      .then(d => setItems(withKeys(d.types || [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (nextItems) => {
    const names = nextItems.map(i => i.name).filter(Boolean);
    setItems(nextItems.filter(i => i.name));
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/warehouse/task-types', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ types: names }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to save');
      setItems(withKeys(d.types || []));
    } catch (e) {
      setError(e.message);
      await load(); // back to what is really saved
    } finally {
      setSaving(false);
    }
  };

  const commit = (key, raw) => {
    setEditingKey(null);
    const name = String(raw || '').trim();
    const current = items.find(i => i.key === key);
    if (!current) return;
    if (!name) { // empty → remove the pill
      if (!current.name) { setItems(items.filter(i => i.key !== key)); return; }
      save(items.filter(i => i.key !== key));
      return;
    }
    if (name === current.name) return; // nothing changed
    const dup = items.some(i => i.key !== key && i.name.toLowerCase() === name.toLowerCase());
    if (dup) {
      setError(`Type "${name}" already exists.`);
      if (!current.name) setItems(items.filter(i => i.key !== key));
      return;
    }
    save(items.map(i => (i.key === key ? { ...i, name } : i)));
  };

  const cancel = (key) => {
    setEditingKey(null);
    setItems(prev => prev.filter(i => i.key !== key || i.name)); // drop an unsaved new pill
  };

  const addType = () => {
    const item = { key: `t${++keySeq}`, name: '' };
    setItems(prev => [...prev, item]);
    setEditingKey(item.key);
  };

  return (
    <Page title="Warehouse Settings" backAction={{ onAction: () => navigate('/warehouse') }}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Custom Task</Text>
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
              <BlockStack gap="200">
                <Text as="h3" fontWeight="semibold">Task Types</Text>
                <Text tone="subdued" variant="bodySm">
                  Options of the Type dropdown when creating a custom task on the Schedule. Click a type to rename it.
                  Renaming or deleting a type does not change tasks already created.
                </Text>
                {loading ? (
                  <Text tone="subdued">Loading...</Text>
                ) : (
                  <InlineStack gap="150" wrap blockAlign="center">
                    {items.length === 0 && <Text tone="subdued">No types yet.</Text>}
                    {items.map(item => (
                      <EditablePill
                        key={item.key}
                        item={item}
                        editing={editingKey === item.key}
                        busy={saving}
                        onStartEdit={() => setEditingKey(item.key)}
                        onCommit={(v) => commit(item.key, v)}
                        onCancel={() => cancel(item.key)}
                        onDelete={() => save(items.filter(i => i.key !== item.key))}
                      />
                    ))}
                    <Button onClick={addType} disabled={saving || editingKey !== null}>Add type</Button>
                  </InlineStack>
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default WarehouseSettings;
