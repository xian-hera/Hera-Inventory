import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Select, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const METAFIELD_TYPE_OPTIONS = [{ label: 'Product', value: 'product' }, { label: 'Variant', value: 'variant' }];

function MetafieldFieldEditor({ label, value, onSave }) {
  const [editing, setEditing] = useState(!value);
  const [type, setType] = useState(value?.type || 'variant');
  const [namespaceKey, setNamespaceKey] = useState(value?.namespaceKey || '');

  useEffect(() => {
    setType(value?.type || 'variant');
    setNamespaceKey(value?.namespaceKey || '');
    setEditing(!value);
  }, [value]);

  const handleSave = async () => {
    if (!namespaceKey.trim()) return;
    await onSave({ type, namespaceKey: namespaceKey.trim() });
    setEditing(false);
  };

  return (
    <InlineStack gap="300" blockAlign="end" wrap>
      <Text fontWeight="semibold">{label}</Text>
      {editing ? (
        <>
          <div style={{ width: 130 }}>
            <Select label="metafield type" options={METAFIELD_TYPE_OPTIONS} value={type} onChange={setType} />
          </div>
          <div style={{ width: 220 }}>
            <TextField label="name.space" value={namespaceKey} onChange={setNamespaceKey} autoComplete="off" placeholder="custom.sample" />
          </div>
          <Button onClick={handleSave}>Save</Button>
        </>
      ) : (
        <>
          <Text tone="subdued">metafield type: {value.type === 'product' ? 'Product' : 'Variant'}</Text>
          <Text tone="subdued">name.space: {value.namespaceKey}</Text>
          <Button variant="plain" onClick={() => setEditing(true)}>Edit</Button>
        </>
      )}
    </InlineStack>
  );
}

function BuyerPOSettings() {
  const navigate = useNavigate();

  const [packageSize, setPackageSize] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [typeOptions, setTypeOptions] = useState([]);
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [typeHistory, setTypeHistory] = useState({});
  // The "unregistered supplier found" banner only reflects a run observed to
  // finish during THIS page visit — it must not reappear from a stale result
  // left over from a run that finished before the user came back to this page.
  const [showUnregistered, setShowUnregistered] = useState(false);
  const pollTimer = useRef(null);

  const fetchMetafields = useCallback(async () => {
    const res = await fetch('/api/po-settings/metafields');
    const data = await res.json();
    setPackageSize(data.packageSize);
    setGroups(data.groups || []);
  }, []);

  const fetchTypeHistory = useCallback(async () => {
    const res = await fetch('/api/po-settings/type-update-history');
    const data = await res.json();
    setTypeHistory(data || {});
  }, []);

  const fetchUpdateStatus = useCallback(async () => {
    const res = await fetch('/api/po-settings/update-sku-global/status');
    const data = await res.json();
    setUpdateStatus(data);
    return data.isRunning;
  }, []);

  useEffect(() => {
    Promise.all([fetchMetafields(), fetchTypeHistory()]).finally(() => setLoading(false));
    fetch('/api/shopify/product-types').then(r => r.json()).then(data => setTypeOptions(Array.isArray(data) ? data : [])).catch(() => {});
    fetchUpdateStatus().then(isRunning => { if (isRunning) startPolling(); });
    return () => { if (pollTimer.current) clearInterval(pollTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPolling = () => {
    if (pollTimer.current) return;
    pollTimer.current = setInterval(async () => {
      const isRunning = await fetchUpdateStatus();
      if (!isRunning) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
        setShowUnregistered(true);
        fetchTypeHistory();
      }
    }, 4000);
  };

  const savePackageSize = async (val) => {
    setError('');
    try {
      const res = await fetch('/api/po-settings/metafields/package-size', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(val),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setPackageSize(val);
    } catch (e) { setError(e.message); }
  };

  const saveGroupField = async (index, field, val) => {
    setError('');
    try {
      const res = await fetch(`/api/po-settings/metafields/groups/${index}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, ...val }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGroups(data.groups);
    } catch (e) { setError(e.message); }
  };

  const addGroup = async () => {
    setError('');
    try {
      const res = await fetch('/api/po-settings/metafields/groups', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGroups(data.groups);
    } catch (e) { setError(e.message); }
  };

  const deleteGroup = async (index) => {
    if (!window.confirm('Delete this metafield group?')) return;
    setError('');
    try {
      const res = await fetch(`/api/po-settings/metafields/groups/${index}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGroups(data.groups);
    } catch (e) { setError(e.message); }
  };

  const handleUpdate = async () => {
    if (selectedTypes.length === 0) { setError('Select at least one type.'); return; }
    setError('');
    try {
      const res = await fetch('/api/po-settings/update-sku-global', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ types: selectedTypes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      startPolling();
      fetchUpdateStatus();
    } catch (e) { setError(e.message); }
  };

  const handleClearHistory = async () => {
    if (!window.confirm('Clear all committed invoice history? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/po-invoices/committed', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to clear history');
    } catch (e) { setError(e.message); }
  };

  if (loading) return null;

  return (
    <Page title="Settings" backAction={{ onAction: () => navigate('/buyer/po-receiving') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <BlockStack gap="200">
              <Text variant="headingMd">Metafields</Text>
              <Text tone="subdued">
                Setup the metafield group here, when update SKU-supplier code mapping, it can retrieve info from designated metafield.
              </Text>
            </BlockStack>

            <Card>
              <MetafieldFieldEditor label="Package size" value={packageSize} onSave={savePackageSize} />
            </Card>

            {groups.map((g, i) => (
              <Card key={i}>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text variant="headingSm">Metafield group {i + 1}</Text>
                    {groups.length > 1 && (
                      <Button variant="plain" tone="critical" onClick={() => deleteGroup(i)}>delete</Button>
                    )}
                  </InlineStack>
                  <MetafieldFieldEditor label="Supplier name" value={g.name} onSave={(val) => saveGroupField(i, 'name', val)} />
                  <MetafieldFieldEditor label="Supplier code" value={g.code} onSave={(val) => saveGroupField(i, 'code', val)} />
                </BlockStack>
              </Card>
            ))}

            <InlineStack align="end">
              <Button onClick={addGroup} disabled={groups.length >= 4}>Add group</Button>
            </InlineStack>

            <BlockStack gap="200">
              <Text variant="headingMd">SKU & supplier code</Text>
              <Text tone="subdued">Click the button to update all suppliers' code list.</Text>
            </BlockStack>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="end">
                  <div style={{ minWidth: 240 }}>
                    <MultiSelectDropdown label="Types" options={typeOptions} selected={selectedTypes} onChange={setSelectedTypes} />
                  </div>
                  <Button onClick={handleUpdate} loading={updateStatus?.isRunning} disabled={updateStatus?.isRunning}>Update</Button>
                  <Text tone="subdued" variant="bodySm">This can take a long time — it walks every product of the selected types.</Text>
                </InlineStack>

                {updateStatus?.isRunning && <Banner tone="info">Updating…</Banner>}

                {showUnregistered && updateStatus?.unregisteredSuppliers?.length > 0 && (
                  <BlockStack gap="200">
                    {updateStatus.unregisteredSuppliers.map(u => (
                      <InlineStack key={u.name} align="space-between">
                        <Text tone="critical">Unregistered supplier found: {u.name}</Text>
                        <Button
                          size="slim"
                          onClick={() => navigate('/buyer/po-receiving/suppliers/new', { state: { prefillName: u.name } })}
                        >
                          Add
                        </Button>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}

                {Object.keys(typeHistory).length > 0 && (
                  <BlockStack gap="150">
                    {Object.entries(typeHistory).map(([type, h]) => (
                      <Text key={type} tone="subdued" variant="bodySm">
                        {type}, last update {new Date(h.lastUpdatedAt).toLocaleString()}
                      </Text>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <BlockStack gap="200">
              <Text variant="headingMd">History</Text>
              <Text tone="subdued">Clear the specific history record.</Text>
            </BlockStack>

            <Card>
              <InlineStack gap="300" blockAlign="center">
                <Button tone="critical" onClick={handleClearHistory}>Clear</Button>
                <Text>Clear committed invoice history in homepage.</Text>
              </InlineStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOSettings;
