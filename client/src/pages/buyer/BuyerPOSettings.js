import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Select, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { useLocationMap } from '../shared/locationMap';

// ─── Ship to HQ rules card (2026-10-22, Hera) ───────────────────────────────
// Rules for POs that are NOT added to WH › Receive Shipments. Each rule:
// Supplier + Locations + "Receiving in HQ" switch (the default of the
// "Shipping to HQ" switch shown in Create New Purchase Order when a new PO's
// supplier + location match the rule). A supplier + location pair may be in
// one rule only. Add / Edit / Delete only change this card's draft; nothing
// is stored until the card's Save. Server: /api/po-settings/hq-ship-rules.
function HqSwitch({ on, onChange }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        style={{
          width: 40, height: 22, borderRadius: 11, border: '2px solid #c9cccf', padding: 0, position: 'relative',
          background: on ? '#303030' : '#f1f1f1', cursor: 'pointer', flex: '0 0 auto',
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: on ? 20 : 2, width: 14, height: 14,
          borderRadius: '50%', background: on ? 'white' : '#303030', transition: 'left 0.15s',
        }} />
      </button>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{on ? 'YES' : 'NO'}</span>
    </span>
  );
}

const SMALL_LABEL = { fontSize: 13, color: '#6d7175', marginBottom: 4, lineHeight: '1.4' };
const LINK_BTN = { border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: 14 };

function ShipToHqCard() {
  const { names: locationNames } = useLocationMap();
  const [suppliers, setSuppliers] = useState([]);
  const [saved, setSaved] = useState([]);   // rules as stored
  const [rows, setRows] = useState([]);     // draft: { key, supplierId, locations, shipToHq, editing }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const keySeq = useRef(0);
  const toRows = (rules) => rules.map(r => ({ ...r, key: ++keySeq.current, editing: false }));

  useEffect(() => {
    Promise.all([
      fetch('/api/po-settings/hq-ship-rules').then(r => r.json()),
      fetch('/api/po-suppliers').then(r => r.json()),
    ]).then(([d, sup]) => {
      const rules = Array.isArray(d && d.rules) ? d.rules : [];
      setSaved(rules);
      setRows(toRows(rules));
      setSuppliers((Array.isArray(sup) ? sup : []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))));
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);

  const supplierName = (id) => (suppliers.find(s => Number(s.id) === Number(id)) || {}).name || `#${id}`;
  const clean = (list) => list.map(({ supplierId, locations, shipToHq }) => ({ supplierId: Number(supplierId), locations, shipToHq: !!shipToHq }));
  const dirty = JSON.stringify(clean(rows)) !== JSON.stringify(clean(saved)) || rows.some(r => r.editing);

  const update = (key, patch) => setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));
  // Confirm a row: supplier + at least one location, and no pair already in another rule.
  const confirmRow = (row) => {
    setNotice('');
    if (!row.supplierId) { setError('Choose a supplier.'); return; }
    if (!row.locations.length) { setError('Choose at least one location.'); return; }
    const clash = rows.find(o => o.key !== row.key && Number(o.supplierId) === Number(row.supplierId)
      && o.locations.some(l => row.locations.includes(l)));
    if (clash) {
      const l = clash.locations.find(x => row.locations.includes(x));
      setError(`${supplierName(row.supplierId)} + ${l} is already in Rule #${rows.indexOf(clash) + 1}.`);
      return;
    }
    setError('');
    update(row.key, { editing: false });
  };
  const save = async () => {
    if (rows.some(r => r.editing)) { setError('Confirm or delete the rule you are editing first.'); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const res = await fetch('/api/po-settings/hq-ship-rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: clean(rows) }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Save failed');
      setSaved(d.rules);
      setRows(toRows(d.rules));
      setNotice('Saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const supplierOptions = [{ label: 'Choose supplier', value: '' }, ...suppliers.map(s => ({ label: s.name, value: String(s.id) }))];

  return (
    <Card>
      <BlockStack gap="300">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {loading ? <Text tone="subdued">Loading...</Text> : (
          <>
            {rows.length === 0 && <Text tone="subdued">No rules yet.</Text>}
            {rows.map((r, i) => (
              <div key={r.key} style={{ display: 'flex', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap', padding: '10px 0', borderBottom: '1px solid #e1e3e5' }}>
                <div style={{ width: 70, fontWeight: 700, paddingBottom: 8 }}>Rule #{i + 1}</div>
                <div style={{ width: 200 }}>
                  <div style={SMALL_LABEL}>Supplier</div>
                  {r.editing ? (
                    <Select label="" labelHidden options={supplierOptions} value={r.supplierId ? String(r.supplierId) : ''}
                      onChange={(v) => update(r.key, { supplierId: v ? Number(v) : null })} />
                  ) : <div style={{ fontSize: 15, paddingBottom: 6 }}>{supplierName(r.supplierId)}</div>}
                </div>
                <div style={{ flex: '0 1 280px', minWidth: 180 }}>
                  {r.editing ? (
                    <MultiSelectDropdown label="Locations" options={locationNames} selected={r.locations}
                      onChange={(v) => update(r.key, { locations: v })} placeholder="Choose locations" />
                  ) : (
                    <>
                      <div style={SMALL_LABEL}>Locations</div>
                      <div style={{ fontSize: 15, paddingBottom: 6 }}>{r.locations.join(', ')}</div>
                    </>
                  )}
                </div>
                <div style={{ width: 140 }}>
                  <div style={SMALL_LABEL}>Receiving in HQ</div>
                  {r.editing ? (
                    <div style={{ paddingBottom: 6 }}><HqSwitch on={!!r.shipToHq} onChange={(v) => update(r.key, { shipToHq: v })} /></div>
                  ) : <div style={{ fontSize: 15, paddingBottom: 6 }}>{r.shipToHq ? 'Ship to HQ' : 'NOT ship to HQ'}</div>}
                </div>
                <div style={{ paddingBottom: 8 }}>
                  {r.editing
                    ? <button type="button" style={{ ...LINK_BTN, color: '#005bd3' }} onClick={() => confirmRow(r)}>Confirm</button>
                    : <button type="button" style={{ ...LINK_BTN, color: '#005bd3' }} onClick={() => { setNotice(''); update(r.key, { editing: true }); }}>Edit</button>}
                </div>
                <div style={{ marginLeft: 'auto', paddingBottom: 8 }}>
                  <button type="button" style={{ ...LINK_BTN, color: '#d72c0d' }}
                    onClick={() => { setNotice(''); setRows(prev => prev.filter(x => x.key !== r.key)); }}>Delete rule</button>
                </div>
              </div>
            ))}
            <InlineStack align="space-between" blockAlign="center">
              <button type="button" style={{ ...LINK_BTN, fontSize: 15 }}
                onClick={() => { setNotice(''); setRows(prev => [...prev, { key: ++keySeq.current, supplierId: null, locations: [], shipToHq: false, editing: true }]); }}>
                +Add rule
              </button>
              <InlineStack gap="300" blockAlign="center">
                {notice && <Text tone="success">{notice}</Text>}
                {dirty && !notice && <Text tone="subdued" variant="bodySm">Unsaved changes</Text>}
                <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save</Button>
              </InlineStack>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

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
  const [costComparison, setCostComparison] = useState({ cad: 'invoice_cost', usd: 'invoice_cost' });
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

  const fetchCostComparison = useCallback(async () => {
    const res = await fetch('/api/po-settings/cost-comparison');
    const data = await res.json();
    setCostComparison({ cad: data.cad || 'invoice_cost', usd: data.usd || 'invoice_cost' });
  }, []);

  // PO lock switch (2026-10, Hera): default OFF. See the "PO lock" card below.
  const [poLock, setPoLock] = useState(false);
  const [poLockSaving, setPoLockSaving] = useState(false);

  const fetchPoLock = useCallback(async () => {
    const res = await fetch('/api/po-settings/po-lock');
    const data = await res.json();
    setPoLock(!!data.enabled);
  }, []);

  const togglePoLock = async () => {
    if (poLockSaving) return;
    setError('');
    const next = !poLock;
    setPoLockSaving(true);
    setPoLock(next);
    try {
      const res = await fetch('/api/po-settings/po-lock', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPoLock(!!data.enabled);
    } catch (e) {
      setPoLock(!next);
      setError(e.message);
    } finally {
      setPoLockSaving(false);
    }
  };

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
    Promise.all([fetchMetafields(), fetchTypeHistory(), fetchCostComparison(), fetchPoLock().catch(() => {})]).finally(() => setLoading(false));
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

  const saveCostComparison = async (currency, value) => {
    setError('');
    const prev = costComparison;
    setCostComparison(c => ({ ...c, [currency]: value }));
    try {
      const res = await fetch('/api/po-settings/cost-comparison', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [currency]: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCostComparison({ cad: data.cad, usd: data.usd });
    } catch (e) {
      setCostComparison(prev);
      setError(e.message);
    }
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
                  <MetafieldFieldEditor label="Supplier cost" value={g.cost} onSave={(val) => saveGroupField(i, 'cost', val)} />
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
              <Text variant="headingMd">Cost comparison</Text>
              <Text tone="subdued">Set which cost will be compared during importing an invoice.</Text>
            </BlockStack>

            <Card>
              <InlineStack gap="600" wrap align="start">
                <div style={{ minWidth: 260, flex: 1 }}>
                  <BlockStack gap="200">
                    <Text variant="headingSm">CAD supplier</Text>
                    <Select
                      label="Compare Supplier Cost with"
                      options={[
                        { label: 'Invoice cost', value: 'invoice_cost' },
                        { label: 'effective cost', value: 'effective_cost' },
                      ]}
                      value={costComparison.cad}
                      onChange={(val) => saveCostComparison('cad', val)}
                    />
                  </BlockStack>
                </div>
                <div style={{ minWidth: 260, flex: 1 }}>
                  <BlockStack gap="200">
                    <Text variant="headingSm">USD supplier</Text>
                    <Select
                      label="Compare Supplier Cost with"
                      options={[
                        { label: 'Invoice cost', value: 'invoice_cost' },
                        { label: 'Invoice cost after adjustment or unit discount', value: 'effective_cost' },
                      ]}
                      value={costComparison.usd}
                      onChange={(val) => saveCostComparison('usd', val)}
                    />
                  </BlockStack>
                </div>
              </InlineStack>
            </Card>

            <BlockStack gap="200">
              <Text variant="headingMd">Ship to HQ</Text>
              <Text tone="subdued">Rules for PO that not added to Warehouse Receive Shipments.</Text>
            </BlockStack>

            <ShipToHqCard />

            <BlockStack gap="200">
              <Text variant="headingMd">PO lock</Text>
              <Text tone="subdued">
                Lock the items that are included in uncommitted invoice from Store's weekly inventory counting tasks.
              </Text>
            </BlockStack>

            <Card>
              <InlineStack gap="300" blockAlign="center">
                <button
                  type="button"
                  role="switch"
                  aria-checked={poLock}
                  onClick={togglePoLock}
                  disabled={poLockSaving}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: 'none', padding: 0,
                    background: poLock ? '#008060' : '#c9cccf', position: 'relative',
                    cursor: poLockSaving ? 'not-allowed' : 'pointer', transition: 'background 0.15s',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: poLock ? 22 : 2, width: 20, height: 20,
                    borderRadius: '50%', background: 'white', transition: 'left 0.15s',
                  }} />
                </button>
                <Text>{poLock ? 'On' : 'Off'}</Text>
              </InlineStack>
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
