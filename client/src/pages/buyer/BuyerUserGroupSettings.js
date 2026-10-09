import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Banner, Modal
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { resetMyGroup, fetchGroups } from '../../userGroup';

// Settings → User Group (2026-10-09, Hera). Claude spec: claude/USER_GROUPS_FEATURE.md
//
// One card, "Groups". Each group = a name + the product types it works with.
// A type can belong to ONE group only (the Types dropdown hides types that
// another group already has); a type in no group is visible to everybody.
//
// Two kinds of Save, as designed:
//   * the small Save beside a field / the Add form puts that row into the draft
//     below (nothing is stored yet);
//   * the dark Save at the bottom of the card stores the whole list — new,
//     edited and deleted groups — in one go.
// "Reset my group" forgets the group this Shopify account picked; the next
// Purchasing page asks again (see components/BuyerGroupGate.js).

const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();

let keySeq = 0;
const newKey = () => `n${++keySeq}`;

const toDraft = (g) => ({ key: `g${g.id}`, id: g.id, name: g.name, types: [...(g.types || [])] });
const snapshot = (list) => JSON.stringify(list.map((g) => [g.id || null, g.name, g.types]));

const rowStyle = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '12px 28px',
  padding: '18px 8px', borderBottom: '1px solid #c9cccf',
};
const cellStyle = { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 };
const typesTextStyle = {
  maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

function BuyerUserGroupSettings() {
  const navigate = useNavigate();

  const [groups, setGroups] = useState([]);          // draft
  const [savedSnap, setSavedSnap] = useState('[]');  // last stored version, for "unsaved changes"
  const [shopifyTypes, setShopifyTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rowError, setRowError] = useState({ key: null, text: '' });

  // inline edit of an existing row: which fields are open
  const [edit, setEdit] = useState(null); // { key, name?: string, types?: string[] }
  // Add form below the list
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTypes, setNewTypes] = useState([]);
  const [addError, setAddError] = useState('');

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, typesRes] = await Promise.all([
        fetchGroups(),
        fetch('/api/shopify/product-types').then((r) => r.json()).catch(() => []),
      ]);
      if (list === null) throw new Error('Could not load user groups.');
      const draft = list.map(toDraft);
      setGroups(draft);
      setSavedSnap(snapshot(draft));
      const types = (Array.isArray(typesRes) ? typesRes : []).map((t) => String(t || '').trim()).filter(Boolean);
      setShopifyTypes([...new Set(types)].sort((a, b) => a.localeCompare(b)));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirty = snapshot(groups) !== savedSnap;
  const formOpen = adding || !!edit;

  // Warn when closing the tab / reloading with unsaved changes.
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

  // Types other groups own (case-insensitive) — not offered in a row's dropdown.
  const ownedByOthers = useCallback((exceptKey) => {
    const set = new Set();
    groups.filter((g) => g.key !== exceptKey).forEach((g) => g.types.forEach((t) => set.add(lc(t))));
    return set;
  }, [groups]);

  const optionsFor = useCallback((exceptKey, current) => {
    const taken = ownedByOthers(exceptKey);
    const base = shopifyTypes.filter((t) => !taken.has(lc(t)));
    // keep a type this group already has even if Shopify no longer lists it
    (current || []).forEach((t) => { if (!base.some((b) => lc(b) === lc(t))) base.push(t); });
    return base;
  }, [shopifyTypes, ownedByOthers]);

  const unassigned = useMemo(() => {
    const used = new Set();
    groups.forEach((g) => g.types.forEach((t) => used.add(lc(t))));
    return shopifyTypes.filter((t) => !used.has(lc(t)));
  }, [groups, shopifyTypes]);

  const nameTaken = (name, exceptKey) =>
    groups.some((g) => g.key !== exceptKey && lc(g.name) === lc(name));

  // ── row edit ──
  const startEditName = (g) => {
    setRowError({ key: null, text: '' });
    setEdit((prev) => (prev && prev.key === g.key ? { ...prev, name: g.name } : { key: g.key, name: g.name }));
  };
  const startEditTypes = (g) => {
    setRowError({ key: null, text: '' });
    setEdit((prev) => (prev && prev.key === g.key ? { ...prev, types: [...g.types] } : { key: g.key, types: [...g.types] }));
  };
  const cancelEdit = () => { setEdit(null); setRowError({ key: null, text: '' }); };

  const saveRow = (g) => {
    const nextName = edit.name !== undefined ? edit.name.trim() : g.name;
    const nextTypes = edit.types !== undefined ? edit.types : g.types;
    if (!nextName) return setRowError({ key: g.key, text: 'Group name is required.' });
    if (nameTaken(nextName, g.key)) return setRowError({ key: g.key, text: 'Another group already has this name.' });
    if (nextTypes.length === 0) return setRowError({ key: g.key, text: 'Choose at least one type.' });
    setGroups((prev) => prev.map((x) => (x.key === g.key ? { ...x, name: nextName, types: nextTypes } : x)));
    cancelEdit();
  };

  // ── add ──
  const openAdd = () => { setAdding(true); setNewName(''); setNewTypes([]); setAddError(''); };
  const closeAdd = () => { setAdding(false); setAddError(''); };
  const saveNew = () => {
    const name = newName.trim();
    if (!name) return setAddError('Group name is required.');
    if (nameTaken(name, null)) return setAddError('Another group already has this name.');
    if (newTypes.length === 0) return setAddError('Choose at least one type.');
    setGroups((prev) => [...prev, { key: newKey(), id: null, name, types: newTypes }]);
    closeAdd();
  };

  // ── delete (draft only — the card Save stores it) ──
  const confirmDelete = () => {
    const key = deleteTarget.key;
    setGroups((prev) => prev.filter((g) => g.key !== key));
    if (edit && edit.key === key) setEdit(null);
    setDeleteTarget(null);
  };

  // ── card Save ──
  const saveAll = async () => {
    if (formOpen) {
      setError('Save or cancel the group you are editing first.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/user-groups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: groups.map((g) => ({ id: g.id, name: g.name, types: g.types })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const draft = (data.groups || []).map(toDraft);
      setGroups(draft);
      setSavedSnap(snapshot(draft));
      setNotice('Groups saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    setError('');
    try {
      await resetMyGroup();
      setNotice('Your group has been reset.');
    } finally {
      setResetting(false);
    }
  };

  const goBack = () => {
    if (dirty || formOpen) setLeaveOpen(true);
    else navigate('/buyer/settings');
  };

  const renderRow = (g) => {
    const editing = edit && edit.key === g.key ? edit : null;
    return (
      <div key={g.key} style={rowStyle}>
        <div style={{ ...cellStyle, minWidth: '190px' }}>
          {editing && editing.name !== undefined ? (
            <div style={{ width: '200px' }}>
              <TextField
                label="" labelHidden value={editing.name} autoComplete="off" maxLength={64}
                onChange={(v) => setEdit((p) => ({ ...p, name: v }))}
              />
            </div>
          ) : (
            <>
              <Text as="span" variant="headingMd">{g.name}</Text>
              <Button variant="plain" onClick={() => startEditName(g)}>Edit</Button>
            </>
          )}
        </div>

        <div style={{ flex: 1, minWidth: '220px' }}>
          <Text as="p" variant="bodySm" tone="subdued">Type</Text>
          {editing && editing.types !== undefined ? (
            <div style={{ maxWidth: '320px' }}>
              <MultiSelectDropdown
                label="" placeholder="" options={optionsFor(g.key, editing.types)}
                selected={editing.types}
                onChange={(v) => setEdit((p) => ({ ...p, types: v }))}
              />
            </div>
          ) : (
            <div style={cellStyle}>
              <span style={typesTextStyle} title={g.types.join(', ')}>
                <Text as="span" variant="headingMd">{g.types.join(', ')}</Text>
              </span>
              <Button variant="plain" onClick={() => startEditTypes(g)}>Edit</Button>
            </div>
          )}
        </div>

        <div style={{ ...cellStyle, marginLeft: 'auto' }}>
          {editing && <Button onClick={() => saveRow(g)}>Save</Button>}
          {editing && <Button variant="plain" onClick={cancelEdit}>Cancel</Button>}
          <Button variant="plain" tone="critical" onClick={() => setDeleteTarget(g)}>Delete group</Button>
        </div>

        {rowError.key === g.key && rowError.text && (
          <div style={{ width: '100%' }}>
            <Text as="p" tone="critical" variant="bodySm">{rowError.text}</Text>
          </div>
        )}
      </div>
    );
  };

  return (
    <Page title="User Group" backAction={{ onAction: goBack }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {notice && <Banner tone="success" onDismiss={() => setNotice('')}>{notice}</Banner>}

            <InlineStack align="end">
              <Button onClick={handleReset} loading={resetting}>Reset my group</Button>
            </InlineStack>

            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd" as="h2">Groups</Text>

                {loading ? (
                  <Text as="p" tone="subdued">Loading...</Text>
                ) : (
                  <>
                    <div>
                      {groups.length === 0 && (
                        <div style={{ padding: '12px 8px' }}>
                          <Text as="p" tone="subdued">No groups yet. Without groups everyone sees everything.</Text>
                        </div>
                      )}
                      {groups.map(renderRow)}
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 28px', padding: '8px' }}>
                      <Button variant="plain" onClick={openAdd} disabled={adding}>+ Add Group</Button>
                      <Text as="span">
                        Unassigned types, can be seen by all users: {unassigned.length ? unassigned.join(', ') : 'none'}
                      </Text>
                    </div>

                    {adding && (
                      <div style={{ padding: '16px 8px', borderTop: '1px solid #c9cccf' }}>
                        <InlineStack gap="400" blockAlign="end" wrap>
                          <div style={{ width: '220px' }}>
                            <TextField
                              label="Group Name" value={newName} onChange={setNewName}
                              autoComplete="off" maxLength={64}
                            />
                          </div>
                          <div style={{ width: '260px' }}>
                            <MultiSelectDropdown
                              label="Types" placeholder="" options={optionsFor(null, newTypes)}
                              selected={newTypes} onChange={setNewTypes}
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
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete group"
        primaryAction={{ content: 'Delete group', destructive: true, onAction: confirmDelete }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setDeleteTarget(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            Delete "{deleteTarget && deleteTarget.name}"? Its types become unassigned and are seen by everyone.
            Anyone using this group will be asked to choose a group again. The change is stored when you press Save on the card.
          </Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        title="Unsaved changes"
        primaryAction={{ content: 'Leave without saving', destructive: true, onAction: () => navigate('/buyer/settings') }}
        secondaryActions={[{ content: 'Stay', onAction: () => setLeaveOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">You have group changes that are not saved. If you leave now they are lost.</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default BuyerUserGroupSettings;
