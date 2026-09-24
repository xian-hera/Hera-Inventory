// Online → New products → Settings (2026-09-24, Hera). Spec §17.
// Cards: Publish channels · Inventory locations · New Arrival Tag · Groups.
import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Banner, Select, TextField, Tag, Divider, Spinner,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { useLocationMap } from '../shared/locationMap';
import { postJson, putJson } from './newProductsShared';

let keySeq = 0;
const newKey = () => `g${Date.now()}_${keySeq++}`;

function GroupEditor({ group, allTypes, typesTakenElsewhere, onChange, onDelete }) {
  const [editingName, setEditingName] = useState(!group.name);
  const [level, setLevel] = useState('product');
  const [namespace, setNamespace] = useState('');
  const [key, setKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');

  const addMetafield = async () => {
    setErr('');
    const ns = namespace.trim();
    const k = key.trim();
    if (!ns || !k) { setErr('Namespace and key are required.'); return; }
    if (group.metafields.some(m => m.level === level && m.namespace === ns && m.key === k)) { setErr('Already added.'); return; }
    setAdding(true);
    try {
      const d = await postJson('/api/new-products/settings/metafield-lookup', { level, namespace: ns, key: k });
      onChange({ ...group, metafields: [...group.metafields, { level, namespace: ns, key: k, name: d.name }] });
      setNamespace(''); setKey('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setAdding(false);
    }
  };

  // A type can only be in one group — types used by another group are not offered.
  const typeOptions = allTypes.filter(t => !typesTakenElsewhere.has(t.toLowerCase()) || group.product_types.includes(t));

  return (
    <BlockStack gap="300">
      <InlineStack gap="400" blockAlign="end" wrap align="space-between">
        <InlineStack gap="200" blockAlign="center">
          {editingName ? (
            <div style={{ width: 200 }}>
              <TextField label="Group name" labelHidden value={group.name} onChange={(v) => onChange({ ...group, name: v })}
                onBlur={() => group.name.trim() && setEditingName(false)} autoComplete="off" placeholder="Group name" autoFocus />
            </div>
          ) : (
            <>
              <Text variant="headingSm" as="h3">{group.name}</Text>
              <Button variant="plain" onClick={() => setEditingName(true)}>Edit</Button>
            </>
          )}
        </InlineStack>
        <div style={{ minWidth: 180 }}>
          <MultiSelectDropdown label="Types" options={typeOptions} selected={group.product_types}
            onChange={(v) => onChange({ ...group, product_types: v })} placeholder="None" />
        </div>
        <div style={{ width: 130 }}>
          <Select label="Metafield" options={[{ label: 'Products', value: 'product' }, { label: 'Variants', value: 'variant' }]} value={level} onChange={setLevel} />
        </div>
        <div style={{ width: 150 }}><TextField label="Name space" value={namespace} onChange={setNamespace} autoComplete="off" /></div>
        <div style={{ width: 150 }}><TextField label="Key" value={key} onChange={setKey} autoComplete="off" /></div>
        <Button onClick={addMetafield} loading={adding}>Add</Button>
        <Button variant="plain" tone="critical" onClick={onDelete}>Delete group</Button>
      </InlineStack>
      {err && <Banner tone="critical" onDismiss={() => setErr('')}>{err}</Banner>}
      <Text tone="subdued" variant="bodySm">metafield added</Text>
      <InlineStack gap="200" wrap>
        {group.metafields.length === 0 && <Text tone="subdued" variant="bodySm">None yet.</Text>}
        {group.metafields.map((m, i) => (
          <Tag key={`${m.level}.${m.namespace}.${m.key}`} onRemove={() => onChange({ ...group, metafields: group.metafields.filter((_, j) => j !== i) })}>
            <span><strong>{m.name}</strong> | {m.level}.{m.namespace}.{m.key}</span>
          </Tag>
        ))}
      </InlineStack>
    </BlockStack>
  );
}

function OnlineNewProductsSettings() {
  const navigate = useNavigate();
  const { names: locationNames } = useLocationMap();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const [publications, setPublications] = useState([]);
  const [channels, setChannels] = useState([]);
  const [invLocations, setInvLocations] = useState([]);
  const [tag, setTag] = useState('New_arrival');
  const [days, setDays] = useState('60');
  const [editTag, setEditTag] = useState(false);
  const [editDays, setEditDays] = useState(false);
  const [types, setTypes] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupsDirty, setGroupsDirty] = useState(false);
  const [saving, setSaving] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/new-products/settings');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Load failed');
      setPublications(d.publications || []);
      if (d.publicationsError) setError(`Could not load channels: ${d.publicationsError}`);
      setChannels(d.publishChannels || []);
      setInvLocations(d.inventoryLocations || []);
      setTag(d.tag.tag);
      setDays(String(d.tag.days));
      setGroups((d.groups || []).map(g => ({ key: newKey(), name: g.name, product_types: g.product_types || [], metafields: g.metafields || [] })));
      setGroupsDirty(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    fetch('/api/shopify/product-types').then(r => r.json()).then(d => setTypes(Array.isArray(d) ? d : [])).catch(() => {});
  }, [load]);

  useEffect(() => {
    if (!groupsDirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [groupsDirty]);

  const run = async (name, fn, okText) => {
    setSaving(name); setError(''); setMsg('');
    try { await fn(); setMsg(okText); } catch (e) { setError(e.message); } finally { setSaving(''); }
  };

  const saveGroups = () => run('groups', async () => {
    if (groups.some(g => !g.name.trim())) throw new Error('Every group needs a name.');
    await putJson('/api/new-products/settings/groups', { groups: groups.map(g => ({ name: g.name.trim(), product_types: g.product_types, metafields: g.metafields })) });
    setGroupsDirty(false);
  }, 'Groups saved.');

  const updateGroup = (k, next) => { setGroups(gs => gs.map(g => (g.key === k ? next : g))); setGroupsDirty(true); };
  const deleteGroup = (k) => {
    const g = groups.find(x => x.key === k);
    if (!window.confirm(`Delete group "${g.name || 'Untitled'}"? Its products will show under Ungrouped.`)) return;
    setGroups(gs => gs.filter(x => x.key !== k));
    setGroupsDirty(true);
  };
  const addGroup = () => { setGroups(gs => [...gs, { key: newKey(), name: '', product_types: [], metafields: [] }]); setGroupsDirty(true); };

  const goBack = () => {
    if (groupsDirty && !window.confirm('Groups have unsaved changes. Leave without saving?')) return;
    navigate('/online/new-products');
  };

  const pubOptions = publications.map(p => ({ label: p.name, value: p.id }));

  return (
    <Page title="Settings" backAction={{ onAction: goBack }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {msg && <Banner tone="success" onDismiss={() => setMsg('')}>{msg}</Banner>}
            {loading ? <InlineStack align="center"><Spinner /></InlineStack> : (
              <>
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h2">Publish</Text>
                    <Text tone="subdued">Select channels to publish when Finalized</Text>
                    <InlineStack align="space-between" blockAlign="end">
                      <div style={{ minWidth: 300 }}>
                        <MultiSelectDropdown label="" options={pubOptions} selected={channels} onChange={setChannels} placeholder="None" />
                      </div>
                      <Button variant="primary" loading={saving === 'publish'} onClick={() => run('publish', () => putJson('/api/new-products/settings/publish', { channels }), 'Channels saved.')}>Save</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h2">Inventory</Text>
                    <Text tone="subdued">Show inventory at location</Text>
                    <InlineStack align="space-between" blockAlign="end">
                      <div style={{ minWidth: 300 }}>
                        <MultiSelectDropdown label="" options={locationNames} selected={invLocations} onChange={setInvLocations} placeholder="None" showSelectAll />
                      </div>
                      <Button variant="primary" loading={saving === 'inventory'} onClick={() => run('inventory', () => putJson('/api/new-products/settings/inventory', { locations: invLocations }), 'Inventory locations saved.')}>Save</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h2">New Arrival Tag</Text>
                    <InlineStack gap="800" blockAlign="end" align="space-between">
                      <InlineStack gap="800">
                        <BlockStack gap="100">
                          <Text tone="subdued">Add this tag to newly published products</Text>
                          {editTag
                            ? <div style={{ width: 200 }}><TextField label="Tag" labelHidden value={tag} onChange={setTag} autoComplete="off" /></div>
                            : <InlineStack gap="200"><Text fontWeight="bold">{tag}</Text><Button variant="plain" onClick={() => setEditTag(true)}>Edit</Button></InlineStack>}
                        </BlockStack>
                        <BlockStack gap="100">
                          <Text tone="subdued">Delete tag in days</Text>
                          {editDays
                            ? <div style={{ width: 100 }}><TextField label="Days" labelHidden type="number" value={days} onChange={setDays} autoComplete="off" /></div>
                            : <InlineStack gap="200"><Text fontWeight="bold">{days}</Text><Button variant="plain" onClick={() => setEditDays(true)}>Edit</Button></InlineStack>}
                        </BlockStack>
                      </InlineStack>
                      <Button variant="primary" loading={saving === 'tag'} onClick={() => run('tag', async () => {
                        await putJson('/api/new-products/settings/tag', { tag, days });
                        setEditTag(false); setEditDays(false);
                      }, 'New Arrival Tag saved.')}>Save</Button>
                    </InlineStack>
                    <Text variant="bodySm" tone="subdued">The number of days is also the split between "Last N days" and "Before last N days" on the Finalized page. Changes apply to products published from now on.</Text>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="400">
                    <Text variant="headingMd" as="h2">Groups</Text>
                    <Text tone="subdued">Group by types and choose columns to show.</Text>
                    {groups.map((g, i) => {
                      const taken = new Set();
                      groups.forEach(o => { if (o.key !== g.key) o.product_types.forEach(t => taken.add(String(t).toLowerCase())); });
                      return (
                        <BlockStack key={g.key} gap="400">
                          {i > 0 && <Divider />}
                          <GroupEditor group={g} allTypes={types} typesTakenElsewhere={taken}
                            onChange={(next) => updateGroup(g.key, next)} onDelete={() => deleteGroup(g.key)} />
                        </BlockStack>
                      );
                    })}
                    <Divider />
                    <InlineStack align="space-between">
                      <Button variant="plain" onClick={addGroup}>+Add group</Button>
                      <Button variant="primary" loading={saving === 'groups'} onClick={saveGroups} disabled={!groupsDirty}>Save</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              </>
            )}
            {/* Room for dropdowns opened near the bottom (2026-09-24, Hera). */}
            <div style={{ height: '33vh' }} />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default OnlineNewProductsSettings;
