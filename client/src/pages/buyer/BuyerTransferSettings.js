import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Banner, Modal
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

// Transfer Settings — the Tag pool: candidate tags shown on Create Transfer.
// Not case-sensitive for uniqueness, max 20 characters, and deleting a tag
// here never touches already-published transfers (spec doc section 3).
//
// 2026-10-09 (Hera): second card "Tag of Types" — which product types a tag
// stands for, so Transfers follow the Purchasing user groups (a Transfer is
// visible to a group through its tags' types). Same two-level Save as
// Settings → User Group: the small Save puts a row into the draft, the dark
// card Save stores the whole list. Tag pool ↔ Tag of Types link:
//   * a tag saved in Tag of Types is added to the pool when missing, and
//   * a pool tag that is used in Tag of Types is "locked": no red × (the
//     server refuses to delete it too);
//   * removing it from Tag of Types unlocks it (it stays in the pool).
const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
let keySeq = 0;
const newKey = () => `n${++keySeq}`;
const toDraft = (r) => ({ key: `t${r.id}`, id: r.id, tag: r.tag, types: [...(r.types || [])] });
const snapshot = (list) => JSON.stringify(list.map((r) => [r.id || null, r.tag, r.types]));

const rowStyle = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '12px 28px',
  padding: '18px 8px', borderBottom: '1px solid #c9cccf',
};
const cellStyle = { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 };
const typesTextStyle = { maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

function BuyerTransferSettings() {
  const navigate = useNavigate();
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newTag, setNewTag] = useState('');
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const fetchTags = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/tags');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTags(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTags(); }, [fetchTags]);

  const handleAdd = async () => {
    const trimmed = newTag.trim();
    if (!trimmed) return;
    setAdding(true);
    setError('');
    try {
      const res = await fetch('/api/transfers/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTags(prev => [...prev, data].sort((a, b) => a.tag.localeCompare(b.tag)));
      setNewTag('');
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (tag) => {
    setDeletingId(tag.id);
    setError('');
    try {
      const res = await fetch(`/api/transfers/tags/${tag.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTags(prev => prev.filter(t => t.id !== tag.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingId(null);
    }
  };

  // ═══ Tag of Types (2026-10-09) ═══════════════════════════════════════════
  const [items, setItems] = useState([]);           // draft
  const [savedSnap, setSavedSnap] = useState('[]');
  const [shopifyTypes, setShopifyTypes] = useState([]);
  const [ttLoading, setTtLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ttError, setTtError] = useState('');
  const [ttNotice, setTtNotice] = useState('');
  const [rowError, setRowError] = useState({ key: null, text: '' });
  const [edit, setEdit] = useState(null); // { key, tag?: string, types?: string[] }
  const [ttAdding, setTtAdding] = useState(false);
  const [addTag, setAddTag] = useState('');
  const [addTypes, setAddTypes] = useState([]);
  const [addError, setAddError] = useState('');
  const [leaveOpen, setLeaveOpen] = useState(false);

  const loadTagTypes = useCallback(async () => {
    setTtLoading(true);
    try {
      const [rows, typesRes] = await Promise.all([
        fetch('/api/transfers/tag-types').then((r) => r.json()),
        fetch('/api/shopify/product-types').then((r) => r.json()).catch(() => []),
      ]);
      const draft = (Array.isArray(rows) ? rows : []).map(toDraft);
      setItems(draft);
      setSavedSnap(snapshot(draft));
      const types = (Array.isArray(typesRes) ? typesRes : []).map((t) => String(t || '').trim()).filter(Boolean);
      setShopifyTypes([...new Set(types)].sort((a, b) => a.localeCompare(b)));
    } catch (e) {
      setTtError(e.message || 'Could not load Tag of Types.');
    } finally {
      setTtLoading(false);
    }
  }, []);

  useEffect(() => { loadTagTypes(); }, [loadTagTypes]);

  const dirty = snapshot(items) !== savedSnap;
  const formOpen = ttAdding || !!edit;

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty || formOpen;
  useEffect(() => {
    const handler = (e) => {
      if (!dirtyRef.current) return undefined;
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const typeOptions = (current) => {
    const base = [...shopifyTypes];
    (current || []).forEach((t) => { if (!base.some((b) => lc(b) === lc(t))) base.push(t); });
    return base;
  };

  const tagTaken = (name, exceptKey) => items.some((r) => r.key !== exceptKey && lc(r.tag) === lc(name));

  const startEditTag = (r) => {
    setRowError({ key: null, text: '' });
    setEdit((p) => (p && p.key === r.key ? { ...p, tag: r.tag } : { key: r.key, tag: r.tag }));
  };
  const startEditTypes = (r) => {
    setRowError({ key: null, text: '' });
    setEdit((p) => (p && p.key === r.key ? { ...p, types: [...r.types] } : { key: r.key, types: [...r.types] }));
  };
  const cancelEdit = () => { setEdit(null); setRowError({ key: null, text: '' }); };

  const saveRow = (r) => {
    const nextTag = edit.tag !== undefined ? edit.tag.trim() : r.tag;
    const nextTypes = edit.types !== undefined ? edit.types : r.types;
    if (!nextTag) return setRowError({ key: r.key, text: 'Tag is required.' });
    if (tagTaken(nextTag, r.key)) return setRowError({ key: r.key, text: 'This tag is already in the list.' });
    if (nextTypes.length === 0) return setRowError({ key: r.key, text: 'Choose at least one type.' });
    setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, tag: nextTag, types: nextTypes } : x)));
    cancelEdit();
  };

  const openAdd = () => { setTtAdding(true); setAddTag(''); setAddTypes([]); setAddError(''); };
  const closeAdd = () => { setTtAdding(false); setAddError(''); };
  const saveNew = () => {
    const name = addTag.trim();
    if (!name) return setAddError('Tag is required.');
    if (tagTaken(name, null)) return setAddError('This tag is already in the list.');
    if (addTypes.length === 0) return setAddError('Choose at least one type.');
    setItems((prev) => [...prev, { key: newKey(), id: null, tag: name, types: addTypes }]);
    closeAdd();
  };

  const removeRow = (r) => {
    setItems((prev) => prev.filter((x) => x.key !== r.key));
    if (edit && edit.key === r.key) setEdit(null);
  };

  const saveAll = async () => {
    if (formOpen) {
      setTtError('Save or cancel the tag you are editing first.');
      return;
    }
    setSaving(true);
    setTtError('');
    setTtNotice('');
    try {
      const res = await fetch('/api/transfers/tag-types', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map((r) => ({ id: r.id, tag: r.tag, types: r.types })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const draft = (Array.isArray(data) ? data : []).map(toDraft);
      setItems(draft);
      setSavedSnap(snapshot(draft));
      setTtNotice('Saved.');
      fetchTags(); // pool: new tags added, locks updated
    } catch (e) {
      setTtError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const goBack = () => {
    if (dirty || formOpen) setLeaveOpen(true);
    else navigate('/buyer/transfer');
  };

  const renderRow = (r) => {
    const editing = edit && edit.key === r.key ? edit : null;
    return (
      <div key={r.key} style={rowStyle}>
        <div style={{ ...cellStyle, minWidth: '170px' }}>
          {editing && editing.tag !== undefined ? (
            <div style={{ width: '170px' }}>
              <TextField
                label="" labelHidden value={editing.tag} autoComplete="off" maxLength={20}
                onChange={(v) => setEdit((p) => ({ ...p, tag: v }))}
              />
            </div>
          ) : (
            <>
              <Text as="span" variant="headingMd">{r.tag}</Text>
              <Button variant="plain" onClick={() => startEditTag(r)}>Edit</Button>
            </>
          )}
        </div>

        <div style={{ flex: 1, minWidth: '220px' }}>
          <Text as="p" variant="bodySm" tone="subdued">Type</Text>
          {editing && editing.types !== undefined ? (
            <div style={{ maxWidth: '320px' }}>
              <MultiSelectDropdown
                label="" placeholder="" options={typeOptions(editing.types)}
                selected={editing.types}
                onChange={(v) => setEdit((p) => ({ ...p, types: v }))}
              />
            </div>
          ) : (
            <div style={cellStyle}>
              <span style={typesTextStyle} title={r.types.join(', ')}>
                <Text as="span" variant="headingMd">{r.types.join(', ')}</Text>
              </span>
              <Button variant="plain" onClick={() => startEditTypes(r)}>Edit</Button>
            </div>
          )}
        </div>

        <div style={{ ...cellStyle, marginLeft: 'auto' }}>
          {editing && <Button onClick={() => saveRow(r)}>Save</Button>}
          {editing && <Button variant="plain" onClick={cancelEdit}>Cancel</Button>}
          <Button variant="plain" tone="critical" onClick={() => removeRow(r)}>Delete</Button>
        </div>

        {rowError.key === r.key && rowError.text && (
          <div style={{ width: '100%' }}>
            <Text as="p" tone="critical" variant="bodySm">{rowError.text}</Text>
          </div>
        )}
      </div>
    );
  };

  return (
    <Page title="Transfer Settings" backAction={{ onAction: goBack }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm">Tag pool</Text>
                <Text tone="subdued" variant="bodySm">
                  Candidate tags shown when creating a transfer. Not case-sensitive, up to 20 characters. Removing a tag here does not affect transfers already created with it.
                </Text>

                <InlineStack gap="200">
                  <div style={{ flex: 1, maxWidth: '260px' }}>
                    <TextField
                      label="" labelHidden
                      placeholder="New tag"
                      value={newTag}
                      onChange={setNewTag}
                      maxLength={20}
                      autoComplete="off"
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
                    />
                  </div>
                  <Button onClick={handleAdd} loading={adding}>Add</Button>
                </InlineStack>

                {loading ? (
                  <InlineStack align="center"><Text tone="subdued">Loading...</Text></InlineStack>
                ) : tags.length === 0 ? (
                  <Text tone="subdued">No tags yet.</Text>
                ) : (
                  <InlineStack gap="150" wrap>
                    {tags.map(tag => (
                      <span
                        key={tag.id}
                        style={{
                          display: 'inline-flex', alignItems: 'center',
                          padding: '4px 10px', borderRadius: '14px',
                          background: '#f1f2f3', fontSize: '13px',
                        }}
                      >
                        {tag.tag}
                        {/* locked = used in Tag of Types → no × (2026-10-09) */}
                        {!tag.locked && (
                          <span
                            onClick={() => (deletingId === tag.id ? null : handleDelete(tag))}
                            style={{ cursor: 'pointer', marginLeft: '8px', color: '#d72c0d', opacity: deletingId === tag.id ? 0.5 : 1 }}
                          >
                            ×
                          </span>
                        )}
                      </span>
                    ))}
                  </InlineStack>
                )}
              </BlockStack>
            </Card>

            {/* Tag of Types (2026-10-09, Hera) */}
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd" as="h2">Tag of Types</Text>
                <Text tone="subdued" variant="bodySm">
                  Which product types a tag stands for. Transfers follow the Purchasing user groups through these types; a tag that is not listed here is seen by every group. A tag saved here is also kept in the Tag pool and cannot be deleted from it.
                </Text>
                {ttError && <Banner tone="critical" onDismiss={() => setTtError('')}>{ttError}</Banner>}
                {ttNotice && <Banner tone="success" onDismiss={() => setTtNotice('')}>{ttNotice}</Banner>}

                {ttLoading ? (
                  <Text as="p" tone="subdued">Loading...</Text>
                ) : (
                  <>
                    <div>{items.map(renderRow)}</div>

                    <div style={{ padding: '8px' }}>
                      <Button onClick={openAdd} disabled={ttAdding}>Add tag for types</Button>
                    </div>

                    {ttAdding && (
                      <div style={{ padding: '16px 8px', borderTop: '1px solid #c9cccf' }}>
                        <InlineStack gap="400" blockAlign="end" wrap>
                          <div style={{ width: '200px' }}>
                            <TextField
                              label="Tag" value={addTag} onChange={setAddTag}
                              autoComplete="off" maxLength={20}
                            />
                          </div>
                          <div style={{ width: '260px' }}>
                            <MultiSelectDropdown
                              label="Types" placeholder="" options={typeOptions(addTypes)}
                              selected={addTypes} onChange={setAddTypes}
                            />
                          </div>
                          <Button onClick={saveNew}>Save</Button>
                          <Button variant="plain" onClick={closeAdd}>Cancel</Button>
                        </InlineStack>
                        {addError && (
                          <div style={{ marginTop: '8px' }}>
                            <Text as="p" tone="critical" variant="bodySm">{addError}</Text>
                          </div>
                        )}
                      </div>
                    )}

                    <InlineStack align="end">
                      <Button variant="primary" onClick={saveAll} loading={saving} disabled={!dirty || saving}>
                        Save
                      </Button>
                    </InlineStack>
                  </>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        title="Unsaved changes"
        primaryAction={{ content: 'Leave without saving', destructive: true, onAction: () => navigate('/buyer/transfer') }}
        secondaryActions={[{ content: 'Stay', onAction: () => setLeaveOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">You have Tag of Types changes that are not saved. If you leave now they are lost.</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default BuyerTransferSettings;
