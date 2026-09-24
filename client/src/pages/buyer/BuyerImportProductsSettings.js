// Buyer → Import Products → Settings (2026-09-24, Hera).
// Spec: claude/IMPORT_PRODUCTS_FEATURE_SPEC.md §9.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Banner, Select, Tag, Divider, ChoiceList, Spinner,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { useLocationMap } from '../shared/locationMap';

const ASSIGN_CARDS = [
  { field: 'sub_type', title: 'Sub types', noun: 'sub types' },
  { field: 'sub_collection', title: 'Sub collections', noun: 'sub collections' },
  { field: 'display_section', title: 'Display sections', noun: 'display sections' },
];

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// One Sub types / Sub collections / Display sections card.
function AssignCard({ field, title, noun, types, onDirtyChange, registerSave }) {
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
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [field, assign]);
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
              <AssignCard key={c.field} {...c} types={types} onDirtyChange={onDirtyChange} registerSave={registerSave} />
            ))}

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
