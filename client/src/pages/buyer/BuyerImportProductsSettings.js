// Buyer → Import Products → Settings (2026-09-24, Hera).
// Spec: claude/IMPORT_PRODUCTS_FEATURE_SPEC.md §9.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Banner, Select, Tag, Divider, ChoiceList, Spinner, Tooltip,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { useLocationMap } from '../shared/locationMap';

// 2026-09-25 (Hera): only Sub types is still assigned with this card.
// The Sub collections and Display sections entries were removed from this
// list: Display section now uses the metafield's own choices in the import
// table (only for HAIR & SKIN CARE), and Sub collections has its own card
// below (SubCollectionsCard), since custom.sub_collection is free text.
const ASSIGN_CARDS = [
  { field: 'sub_type', title: 'Sub types', noun: 'sub types' },
];

const subCollectionKey = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// One Sub types / Sub collections / Display sections card.
function AssignCard({ field, title, noun, types, onDirtyChange, registerSave, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [choices, setChoices] = useState([]);
  const [assign, setAssign] = useState({}); // choice → type
  const [original, setOriginal] = useState({});
  const [type, setType] = useState('');
  const [saving, setSaving] = useState(false);
  const [definitionFound, setDefinitionFound] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/import-products/settings/assignments/${field}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Load failed');
      setChoices(data.choices || []);
      setAssign(data.assignments || {});
      setOriginal(data.assignments || {});
      setDefinitionFound(!!data.definitionFound);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [field]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!type && types.length) setType(types[0]);
  }, [types, type]);

  const dirty = JSON.stringify(assign) !== JSON.stringify(original);
  useEffect(() => { onDirtyChange(field, dirty); }, [dirty, field, onDirtyChange]);

  const save = useCallback(async () => {
    setSaving(true); setError(''); setSaved('');
    try {
      const res = await fetch(`/api/import-products/settings/assignments/${field}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignments: assign }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setOriginal(assign);
      setSaved('Saved.');
      if (onSaved) onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [field, assign, onSaved]);
  useEffect(() => { registerSave(field, save, () => setAssign(original)); }, [field, save, original, registerSave]);

  const unassigned = choices.filter(c => !assign[c]);
  const assignedHere = Object.keys(assign).filter(c => assign[c] === type);
  const stale = new Set(Object.keys(assign).filter(c => !choices.includes(c)));

  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingMd" as="h2">{title}</Text>
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {saved && <Banner tone="success" onDismiss={() => setSaved('')}>{saved}</Banner>}
        {!definitionFound && !loading && <Banner tone="warning">The metafield definition for {title.toLowerCase()} was not found in Shopify.</Banner>}
        {loading ? <Spinner size="small" /> : (
          <>
            <Text tone="subdued">
              {unassigned.length ? `${title} not assigned yet` : `All ${noun} have been assigned.`}
            </Text>
            <InlineStack gap="200" wrap>
              {unassigned.map(c => (
                <Tag key={c} onClick={type ? () => setAssign(a => ({ ...a, [c]: type })) : undefined}>{c}</Tag>
              ))}
            </InlineStack>
            <div style={{ maxWidth: 260 }}>
              <Select
                label={`Select type to see assigned ${noun}`}
                options={types.map(t => ({ label: t, value: t }))}
                value={type}
                onChange={setType}
              />
            </div>
            <InlineStack gap="200" wrap>
              {assignedHere.length === 0 && <Text tone="subdued">None assigned to {type || 'this type'}.</Text>}
              {assignedHere.map(c => (
                <Tag key={c} onRemove={() => setAssign(a => { const n = { ...a }; delete n[c]; return n; })}>
                  {stale.has(c) ? `${c} (No longer in Shopify)` : c}
                </Tag>
              ))}
            </InlineStack>
            <InlineStack align="end">
              <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save</Button>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

// ─── Sub collections card (2026-09-25, Hera) ────────────────────────────────
// Per Type: Sync pulls the sub_collection values ACTIVE products use; each
// value is then assigned to one sub type. Duplicate makes an unassigned copy
// of a value so it can also go under another sub type; Delete duplicated
// removes an unassigned copy (one copy of every value always stays).
// Shown only once every sub type has been assigned (saved) in Sub types.
let uidCounter = 0;
const withUid = (rows) => rows.map(r => ({ ...r, uid: `s${r.id}` }));
const rowsEqual = (a, b) => JSON.stringify((a || []).map(r => [r.id, r.value, r.subType || null]))
  === JSON.stringify((b || []).map(r => [r.id, r.value, r.subType || null]));

function PillButton({ children, onClick, active }) {
  // Grey pill = not assigned yet (clickable), like Polaris Tag.
  return (
    <Tag onClick={onClick}>
      <span style={{ fontWeight: active ? 600 : undefined }}>{children}</span>
    </Tag>
  );
}

function SubCollectionsCard({ types, subTypeVersion, onDirtyChange, registerSave }) {
  const FIELD = 'sub_collection_values';
  const [subTypeInfo, setSubTypeInfo] = useState(null); // { allAssigned, byType: {type: [subType]} }
  const [type, setType] = useState('');
  const [saved, setSavedRows] = useState({});   // type → rows from server
  const [drafts, setDrafts] = useState({});     // type → rows being edited
  const [status, setStatus] = useState({});     // type → sync status
  const [loadingType, setLoadingType] = useState(false);
  const [mode, setMode] = useState(null);       // null | 'duplicate' | 'delete'
  const [subType, setSubType] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  // Sub types: is everything assigned (saved), and which belong to each type.
  useEffect(() => {
    let stop = false;
    fetch('/api/import-products/settings/assignments/sub_type').then(r => r.json()).then(d => {
      if (stop) return;
      const assignments = d.assignments || {};
      const choices = d.choices || [];
      const byType = {};
      for (const [st, t] of Object.entries(assignments)) (byType[t] = byType[t] || []).push(st);
      Object.values(byType).forEach(l => l.sort());
      setSubTypeInfo({ allAssigned: choices.every(c => assignments[c]), byType });
    }).catch(e => !stop && setError(e.message));
    return () => { stop = true; };
  }, [subTypeVersion]);

  useEffect(() => { if (!type && types.length) setType(types[0]); }, [types, type]);

  const loadType = useCallback(async (t, { keepDraft } = {}) => {
    if (!t) return;
    setLoadingType(true);
    try {
      const res = await fetch(`/api/import-products/settings/sub-collections?type=${encodeURIComponent(t)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Load failed');
      const rows = withUid(d.rows || []);
      setSavedRows(s => ({ ...s, [t]: rows }));
      if (!keepDraft) setDrafts(s => ({ ...s, [t]: rows }));
      setStatus(s => ({ ...s, [t]: d.status || {} }));
      return d;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setLoadingType(false);
    }
  }, []);

  // Load a type the first time it is picked (drafts of other types are kept).
  useEffect(() => {
    if (type && !saved[type]) loadType(type);
    setMode(null);
    setSubType('');
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirtyTypes = Object.keys(drafts).filter(t => !rowsEqual(drafts[t], saved[t]));
  const dirty = dirtyTypes.length > 0;
  useEffect(() => { onDirtyChange(FIELD, dirty); }, [dirty, onDirtyChange]);

  const running = !!(status[type] && status[type].running);
  // Poll while this type's sync runs; reload the list when it finishes.
  useEffect(() => {
    if (!running || !type) return undefined;
    const t = setInterval(async () => {
      const d = await loadType(type);
      if (d && !(d.status && d.status.running)) {
        const sum = d.status && d.status.lastSummary;
        if (d.status && d.status.lastError) setNotice('');
        else if (sum) setNotice(`Synced ${type}: ${sum.total} value(s) in use · ${sum.added} added · ${sum.removed} removed.`);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [running, type, loadType]);

  const save = useCallback(async () => {
    setSaving(true); setError(''); setNotice('');
    try {
      let dropped = 0;
      for (const t of dirtyTypes) {
        const res = await fetch('/api/import-products/settings/sub-collections', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: t, rows: drafts[t].map(r => ({ id: r.id, value: r.value, subType: r.subType || null })) }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(`${t}: ${d.error || 'Save failed'}`);
        dropped += d.dropped || 0;
        const rows = withUid(d.rows || []);
        setSavedRows(s => ({ ...s, [t]: rows }));
        setDrafts(s => ({ ...s, [t]: rows }));
      }
      setNotice(dropped ? `Saved. ${dropped} value(s) were no longer in use and had already been removed by a sync.` : 'Saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [dirtyTypes, drafts]);
  const discard = useCallback(() => { setDrafts(saved); setMode(null); }, [saved]);
  useEffect(() => { registerSave(FIELD, save, discard); }, [save, discard, registerSave]);

  const sync = async () => {
    setError(''); setNotice('');
    if (drafts[type] && !rowsEqual(drafts[type], saved[type])) {
      setError(`Save or discard your changes for ${type} before syncing.`);
      return;
    }
    try {
      const res = await fetch('/api/import-products/settings/sub-collections/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not start');
      setStatus(s => ({ ...s, [type]: { ...(s[type] || {}), running: true } }));
      setNotice('Sync started — you can leave this page.');
    } catch (e) {
      setError(e.message);
    }
  };

  if (!subTypeInfo) {
    return <Card><BlockStack gap="300"><Text variant="headingMd" as="h2">Sub collections</Text><Spinner size="small" /></BlockStack></Card>;
  }
  if (!subTypeInfo.allAssigned) {
    return (
      <Card>
        <BlockStack gap="300">
          <Text variant="headingMd" as="h2">Sub collections</Text>
          <Text tone="subdued">Finish assigning Sub Types first.</Text>
        </BlockStack>
      </Card>
    );
  }

  const rows = drafts[type] || [];
  const subTypesHere = subTypeInfo.byType[type] || [];
  const countByKey = rows.reduce((m, r) => { const k = subCollectionKey(r.value); m[k] = (m[k] || 0) + 1; return m; }, {});
  const unassigned = rows.filter(r => !r.subType);
  const assigned = rows.filter(r => r.subType);
  const assignedHere = subType ? rows.filter(r => r.subType === subType) : [];
  const setRows = (fn) => setDrafts(s => ({ ...s, [type]: fn(s[type] || []) }));

  const clickValue = (r) => {
    setError(''); setNotice('');
    if (mode === 'duplicate') {
      uidCounter += 1;
      setRows(list => {
        const i = list.findIndex(x => x.uid === r.uid);
        const copy = { id: null, value: r.value, subType: null, uid: `n${uidCounter}` };
        return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
      });
      setMode(null);
      return;
    }
    if (mode === 'delete') {
      if (r.subType || (countByKey[subCollectionKey(r.value)] || 0) < 2) {
        setError(`"${r.value}" can't be deleted — only an unassigned copy of a duplicated value can be deleted.`);
      } else {
        setRows(list => list.filter(x => x.uid !== r.uid));
      }
      setMode(null);
      return;
    }
    if (r.subType) return;
    if (!subType) { setError('Select a sub type below first.'); return; }
    const k = subCollectionKey(r.value);
    if (rows.some(x => x.subType === subType && subCollectionKey(x.value) === k)) {
      setError(`"${r.value}" is already assigned to ${subType}. Use a different sub type.`);
      return;
    }
    setRows(list => list.map(x => (x.uid === r.uid ? { ...x, subType } : x)));
  };

  const st = status[type] || {};
  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingMd" as="h2">Sub collections</Text>
        <Text tone="subdued">Select type to see all sub collections currently in use. Clickable means not assigned to a sub type yet.</Text>
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {notice && <Banner tone="success" onDismiss={() => setNotice('')}>{notice}</Banner>}
        <InlineStack align="space-between" blockAlign="end">
          <InlineStack gap="300" blockAlign="end">
            <div style={{ minWidth: 220 }}>
              <Select label="Type" labelHidden options={types.map(t => ({ label: t, value: t }))} value={type} onChange={setType} />
            </div>
            <Tooltip content="If you wish to add a new sub collection that never used, do it in Shopify product page">
              <Button variant="primary" onClick={sync} loading={running} disabled={!type}>Sync</Button>
            </Tooltip>
          </InlineStack>
          <InlineStack gap="200">
            <Tooltip content="Click this button then click the duplicated value you wish to delete.">
              <Button pressed={mode === 'delete'} onClick={() => setMode(m => (m === 'delete' ? null : 'delete'))} disabled={!rows.length}>Delete duplicated</Button>
            </Tooltip>
            <Tooltip content="Click this button then click a value to duplicate one, if that value is shared in more than one sub types.">
              <Button pressed={mode === 'duplicate'} onClick={() => setMode(m => (m === 'duplicate' ? null : 'duplicate'))} disabled={!rows.length}>Duplicate</Button>
            </Tooltip>
          </InlineStack>
        </InlineStack>
        {running && <InlineStack gap="200"><Spinner size="small" /><Text tone="subdued">Syncing {type}…</Text></InlineStack>}
        {st.lastSuccessAt && <Text variant="bodySm" tone="subdued">Last synced {fmt(st.lastSuccessAt)}</Text>}
        {st.lastError && <Banner tone="critical">Last sync failed ({fmt(st.lastErrorAt)}): {st.lastError}</Banner>}
        {mode && (
          <Text tone="subdued">
            {mode === 'duplicate' ? 'Click a value to duplicate it.' : 'Click an unassigned duplicated value to delete it.'}
          </Text>
        )}

        {loadingType && !rows.length ? <Spinner size="small" /> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {!rows.length && <Text tone="subdued">No sub collections for {type || 'this type'} yet — click Sync.</Text>}
            {unassigned.map(r => (
              <PillButton key={r.uid} onClick={() => clickValue(r)} active={mode === 'delete' && (countByKey[subCollectionKey(r.value)] || 0) > 1}>
                {r.value}
              </PillButton>
            ))}
            {assigned.length > 0 && (
              <span style={{ color: '#6d7175' }}>
                {assigned.map((r, i) => (
                  <span key={r.uid} title={`Assigned to ${r.subType}`}>
                    {mode === 'duplicate'
                      ? <span onClick={() => clickValue(r)} style={{ cursor: 'pointer', textDecoration: 'underline' }}>{r.value}</span>
                      : r.value}
                    {i < assigned.length - 1 ? ', ' : ''}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}

        <div style={{ maxWidth: 260 }}>
          <Select
            label="Select sub type to assign sub collections"
            options={[{ label: subTypesHere.length ? 'Select sub type' : 'No sub types for this type', value: '' }, ...subTypesHere.map(x => ({ label: x, value: x }))]}
            value={subType}
            onChange={setSubType}
          />
        </div>
        {subType && (
          <InlineStack gap="200" wrap>
            {assignedHere.length === 0 && <Text tone="subdued">None assigned to {subType}.</Text>}
            {assignedHere.map(r => (
              <Tag key={r.uid} onRemove={() => setRows(list => list.map(x => (x.uid === r.uid ? { ...x, subType: null } : x)))}>{r.value}</Tag>
            ))}
          </InlineStack>
        )}
        <InlineStack align="end">
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function BuyerImportProductsSettings() {
  const navigate = useNavigate();
  const { names: locationNames } = useLocationMap();
  const [types, setTypes] = useState([]);
  const [error, setError] = useState('');

  const [defaultLocations, setDefaultLocations] = useState([]);
  const [savedLocations, setSavedLocations] = useState([]);
  const [savingLoc, setSavingLoc] = useState(false);
  const [locMsg, setLocMsg] = useState('');

  const [catTypes, setCatTypes] = useState([]);
  const [catStatus, setCatStatus] = useState({});
  const [catCounts, setCatCounts] = useState({});
  const [catMsg, setCatMsg] = useState('');

  const [blankMode, setBlankMode] = useState('keep');
  const [savedBlankMode, setSavedBlankMode] = useState('keep');
  const [blankMsg, setBlankMsg] = useState('');
  // Bumped when Sub types is saved, so Sub collections re-checks it.
  const [subTypeVersion, setSubTypeVersion] = useState(0);
  const onSubTypesSaved = useCallback(() => setSubTypeVersion(v => v + 1), []);

  const dirtyRef = useRef({});
  const saversRef = useRef({});
  const [anyDirty, setAnyDirty] = useState(false);
  const onDirtyChange = useCallback((field, d) => {
    dirtyRef.current[field] = d;
    setAnyDirty(Object.values(dirtyRef.current).some(Boolean));
  }, []);
  const registerSave = useCallback((field, save, discard) => { saversRef.current[field] = { save, discard }; }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/import-products/settings');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Load failed');
      setDefaultLocations(data.defaultLocations || []);
      setSavedLocations(data.defaultLocations || []);
      setBlankMode(data.blankMode || 'keep');
      setSavedBlankMode(data.blankMode || 'keep');
      setCatStatus(data.categoryStatus || {});
      setCatCounts(data.categoryCounts || {});
      return data;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, []);

  useEffect(() => {
    loadSettings();
    fetch('/api/shopify/product-types').then(r => r.json()).then(d => {
      const list = Array.isArray(d) ? d : [];
      setTypes(list);
      setCatTypes(list); // default: all selected
    }).catch(() => {});
  }, [loadSettings]);

  // Poll while a category update runs in the background.
  useEffect(() => {
    if (!catStatus.running) return undefined;
    const t = setInterval(() => { loadSettings(); }, 3000);
    return () => clearInterval(t);
  }, [catStatus.running, loadSettings]);

  // Warn before a browser reload/close with unsaved assignment changes.
  useEffect(() => {
    if (!anyDirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [anyDirty]);

  const saveLocations = async () => {
    setSavingLoc(true); setLocMsg('');
    try {
      const res = await fetch('/api/import-products/settings/locations', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locations: defaultLocations }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSavedLocations(defaultLocations);
      setLocMsg('Saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingLoc(false);
    }
  };

  const updateCategories = async () => {
    setCatMsg('');
    try {
      const res = await fetch('/api/import-products/settings/categories/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ types: catTypes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start');
      setCatMsg('Update started — you can leave this page.');
      setCatStatus(s => ({ ...s, running: true }));
    } catch (e) {
      setCatMsg('');
      setError(e.message);
    }
  };

  const saveBlankMode = async () => {
    setBlankMsg('');
    try {
      const res = await fetch('/api/import-products/settings/blank-mode', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: blankMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSavedBlankMode(blankMode);
      setBlankMsg('Saved.');
    } catch (e) {
      setError(e.message);
    }
  };

  const goBack = () => {
    if (anyDirty && !window.confirm('You have unsaved changes. Leave without saving?')) return;
    navigate('/buyer/import-products');
  };

  const inactiveSaved = savedLocations.filter(n => locationNames.length && !locationNames.includes(n));

  return (
    <Page title="Import Products Settings" backAction={{ onAction: goBack }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {anyDirty && (
              <Banner tone="warning" title="Unsaved changes">
                <InlineStack gap="200">
                  <Button onClick={() => Object.entries(saversRef.current).forEach(([f, s]) => dirtyRef.current[f] && s.save())}>Save</Button>
                  <Button onClick={() => Object.entries(saversRef.current).forEach(([f, s]) => dirtyRef.current[f] && s.discard())}>Discard</Button>
                </InlineStack>
              </Banner>
            )}

            {/* Locations */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Locations</Text>
                <Text tone="subdued">Select default active locations.</Text>
                {locMsg && <Banner tone="success" onDismiss={() => setLocMsg('')}>{locMsg}</Banner>}
                <InlineStack gap="300" blockAlign="end" align="space-between">
                  <div style={{ minWidth: 280 }}>
                    <MultiSelectDropdown label="" options={locationNames} selected={defaultLocations} onChange={setDefaultLocations} placeholder="None" showSelectAll />
                  </div>
                  <Button variant="primary" onClick={saveLocations} loading={savingLoc}>Update</Button>
                </InlineStack>
                {inactiveSaved.length > 0 && (
                  <Text tone="subdued">No longer active (ignored as defaults): {inactiveSaved.join(', ')}</Text>
                )}
              </BlockStack>
            </Card>

            {/* Categories */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Categories</Text>
                <Text tone="subdued">Select types to update the categories that are currently in use.</Text>
                <Text variant="bodySm" tone="subdued">
                  Only categories already used by active products are listed. To give a product a category that hasn't been used yet, set it manually in Shopify after import.
                </Text>
                <InlineStack gap="300" blockAlign="end" align="space-between">
                  <div style={{ minWidth: 280 }}>
                    <MultiSelectDropdown label="" options={types} selected={catTypes} onChange={setCatTypes} placeholder="None" showSelectAll />
                  </div>
                  <Button variant="primary" onClick={updateCategories} loading={!!catStatus.running} disabled={!catTypes.length}>Update</Button>
                </InlineStack>
                {catMsg && <Text tone="subdued">{catMsg}</Text>}
                {catStatus.running && <InlineStack gap="200"><Spinner size="small" /><Text tone="subdued">Updating categories…</Text></InlineStack>}
                {catStatus.lastSuccessAt && <Text tone="subdued">Last updated {fmt(catStatus.lastSuccessAt)}</Text>}
                {catStatus.lastError && (
                  <Banner tone="critical">Last update failed ({fmt(catStatus.lastErrorAt)}): {catStatus.lastError}</Banner>
                )}
                {Object.keys(catCounts).length > 0 && (
                  <Text variant="bodySm" tone="subdued">
                    {Object.entries(catCounts).map(([t, n]) => `${t}: ${n}`).join(' · ')}
                  </Text>
                )}
              </BlockStack>
            </Card>

            {ASSIGN_CARDS.map(c => (
              <AssignCard key={c.field} {...c} types={types} onDirtyChange={onDirtyChange} registerSave={registerSave}
                onSaved={c.field === 'sub_type' ? onSubTypesSaved : undefined} />
            ))}
            <SubCollectionsCard types={types} subTypeVersion={subTypeVersion} onDirtyChange={onDirtyChange} registerSave={registerSave} />

            {/* Update existing — empty cells */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Update existing — empty cells</Text>
                {blankMsg && <Banner tone="success" onDismiss={() => setBlankMsg('')}>{blankMsg}</Banner>}
                <ChoiceList
                  title="When a CSV cell is empty in Update existing mode"
                  titleHidden
                  choices={[
                    { label: "Don't change", value: 'keep', helpText: 'The existing Shopify value is kept.' },
                    { label: 'Clear', value: 'clear', helpText: 'The Shopify value is cleared. Title, Price and Handle are never cleared.' },
                  ]}
                  selected={[blankMode]}
                  onChange={(v) => setBlankMode(v[0])}
                />
                <Divider />
                <InlineStack align="end">
                  <Button variant="primary" onClick={saveBlankMode} disabled={blankMode === savedBlankMode}>Save</Button>
                </InlineStack>
              </BlockStack>
            </Card>
            {/* Room for dropdowns opened near the bottom (2026-09-24, Hera). */}
            <div style={{ height: '33vh' }} />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerImportProductsSettings;
