// Online › Publication (2026-10-15, Hera). Spec: claude/PUBLICATION_FEATURE_SPEC.md
// Channel Groups card, then two sub-tabs: Publishing (filters → background
// scan → results table → publish / unpublish selected variants to channel
// groups) and Settings (metafields, fulfillment location, Qty).
// Server: server/routes/publication.js (/api/publication).
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Card, BlockStack, InlineStack, Text, Tabs, Banner, Select, Button, TextField, Checkbox,
} from '@shopify/polaris';
import MultiSelectDropdown from '../../../components/MultiSelectDropdown';

const ADMIN = 'https://admin.shopify.com/store/beaute-hera/products/';
const numId = (gid) => String(gid || '').split('/').pop();

async function call(method, url, body) {
  const res = await fetch(`/api/publication${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const api = {
  get: (u) => call('GET', u),
  post: (u, b) => call('POST', u, b || {}),
  put: (u, b) => call('PUT', u, b || {}),
};

const TH = { textAlign: 'left', padding: '10px 8px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid #e1e3e5', verticalAlign: 'bottom', whiteSpace: 'nowrap' };
const TD = { padding: '8px', fontSize: 13, borderTop: '1px solid #f1f1f1', verticalAlign: 'top', wordBreak: 'break-word' };
const LINK = { color: '#2c6ecb' };

const COMPARE_OPTIONS = [
  { label: 'less than', value: 'lt' },
  { label: 'more than', value: 'gt' },
  { label: 'equals to', value: 'eq' },
];
const COMPARE_TEXT = { lt: '<', gt: '>', eq: '=' };
const DISC_OPTIONS = [
  { label: 'Empty', value: 'empty' },
  { label: 'True', value: 'true' },
  { label: 'False', value: 'false' },
];
const OWNER_OPTIONS = [
  { label: 'Products', value: 'product' },
  { label: 'Variants', value: 'variant' },
];
const QTY_OPTIONS = [
  { label: 'Available', value: 'available' },
  { label: 'On hand', value: 'on_hand' },
];
const SUB_TABS = [
  { id: 'publishing', content: 'Publishing' },
  { id: 'settings', content: 'Settings' },
];

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// ─── Channel Groups ──────────────────────────────────────────────────────────
function GroupRow({ group, channelOptions, onChange, onDelete }) {
  const [editingName, setEditingName] = useState(!group.name);
  return (
    <InlineStack gap="400" blockAlign="end" wrap>
      <div style={{ minWidth: 160 }}>
        <InlineStack gap="200" blockAlign="center">
          {editingName ? (
            <div style={{ width: 180 }}>
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
      </div>
      <div style={{ width: 320 }}>
        <MultiSelectDropdown label="Channels" options={channelOptions} selected={group.channelIds}
          onChange={(v) => onChange({ ...group, channelIds: v })} placeholder="None" />
      </div>
      <Button variant="plain" tone="critical" onClick={onDelete}>Delete group</Button>
    </InlineStack>
  );
}

function ChannelGroupsCard({ meta, groups, setGroups, setBanner }) {
  const [draft, setDraft] = useState(groups);
  const [saving, setSaving] = useState(false);
  // Read-only summary by default (Hera 2026-10-15): only the group names +
  // Edit. The editing card opens on Edit, or by itself while no group exists.
  const [editing, setEditing] = useState(groups.length === 0);
  const keySeq = useRef(0);
  const resetDraft = useCallback(() => setDraft(groups.map(g => ({ ...g, key: `g${g.id}` }))), [groups]);
  useEffect(() => { resetDraft(); }, [resetDraft]);

  // Channels saved in a group but no longer in Shopify stay listed as "(removed channel)".
  const known = new Set(meta.channels.map(c => c.id));
  const extra = [...new Set(draft.flatMap(g => g.channelIds))].filter(id => !known.has(id));
  const channelOptions = [
    ...meta.channels.map(c => ({ value: c.id, label: c.name })),
    ...extra.map(id => ({ value: id, label: '(removed channel)' })),
  ];

  const save = async () => {
    setSaving(true);
    try {
      const d = await api.put('/groups', { groups: draft.map(({ id, name, channelIds }) => ({ id, name, channelIds })) });
      setGroups(d.groups);
      setEditing(d.groups.length === 0);
      setBanner({ tone: 'success', text: 'Channel groups saved.' });
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <BlockStack gap="200">
      <BlockStack gap="100">
        <Text variant="headingMd" as="h2">Channel Groups</Text>
        <Text tone="subdued" variant="bodySm">Group the channels for better management.</Text>
      </BlockStack>
      {!editing && (
        <InlineStack gap="300" blockAlign="center" wrap>
          <Text fontWeight="bold">{groups.map(g => g.name).join(', ')}</Text>
          <Button variant="plain" onClick={() => { resetDraft(); setEditing(true); }}>Edit</Button>
        </InlineStack>
      )}
      {editing && (
      <Card>
        <BlockStack gap="400">
          {draft.length === 0 && <Text tone="subdued">No group yet.</Text>}
          {draft.map((g, i) => (
            <GroupRow key={g.key} group={g} channelOptions={channelOptions}
              onChange={(ng) => setDraft(d => d.map((x, j) => (j === i ? ng : x)))}
              onDelete={() => setDraft(d => d.filter((_, j) => j !== i))} />
          ))}
          <InlineStack align="space-between" blockAlign="center">
            <Button variant="plain" onClick={() => {
              keySeq.current += 1;
              setDraft(d => [...d, { id: null, key: `new${keySeq.current}`, name: '', channelIds: [] }]);
            }}>+Add group</Button>
            <InlineStack gap="200">
              {groups.length > 0 && (
                <Button onClick={() => { resetDraft(); setEditing(false); }} disabled={saving}>Cancel</Button>
              )}
              <Button variant="primary" onClick={save} loading={saving}>Save</Button>
            </InlineStack>
          </InlineStack>
        </BlockStack>
      </Card>
      )}
    </BlockStack>
  );
}

// ─── Publishing ──────────────────────────────────────────────────────────────
function QtyFilter({ label, value, onChange }) {
  return (
    <InlineStack gap="100" blockAlign="end" wrap={false}>
      <div style={{ width: 120 }}>
        <Select label={label} options={COMPARE_OPTIONS} value={value.compare} onChange={(v) => onChange({ ...value, compare: v })} />
      </div>
      <div style={{ width: 70 }}>
        <TextField label={`${label} number`} labelHidden type="number" min={0} value={String(value.value)}
          onChange={(v) => onChange({ ...value, value: v })} autoComplete="off" />
      </div>
    </InlineStack>
  );
}

function defaultFilters(meta) {
  return {
    types: meta.productTypes.includes('WIG') ? ['WIG'] : [],
    channels: meta.channels.map(c => c.id),
    published: 'yes',
    discontinued: 'empty',
    fulfillmentQty: { compare: 'lt', value: '1' },
    totalQty: { compare: 'lt', value: '1' },
  };
}

function filtersFromParams(p, meta) {
  const d = defaultFilters(meta);
  if (!p) return d;
  const q = (x, f) => (x ? { compare: x.compare, value: String(x.value) } : f);
  return {
    types: Array.isArray(p.types) ? p.types : d.types,
    channels: Array.isArray(p.channels) ? p.channels.filter(id => meta.channels.some(c => c.id === id)) : d.channels,
    published: p.published || d.published,
    discontinued: p.discontinued || d.discontinued,
    fulfillmentQty: q(p.fulfillmentQty, d.fulfillmentQty),
    totalQty: q(p.totalQty, d.totalQty),
  };
}

function PublishingTab({ meta, groups, settings, setBanner }) {
  const [filters, setFilters] = useState(null);
  const [scan, setScan] = useState(null);       // newest scan (status)
  const [results, setResults] = useState(null); // newest finished scan (rows shown)
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pageSize: 100 });
  const [loadingRows, setLoadingRows] = useState(false);
  const [selected, setSelected] = useState([]);
  const [publishGroups, setPublishGroups] = useState([]);
  const [unpublishGroups, setUnpublishGroups] = useState([]);
  const [action, setAction] = useState(null);
  const [starting, setStarting] = useState(false);

  const channelName = useCallback((id) => {
    const c = meta.channels.find(x => x.id === id);
    if (c) return c.name;
    const names = results && results.params && results.params.channelNames;
    return (names && names[id]) || '(removed channel)';
  }, [meta.channels, results]);

  // First load: latest scan + its filters.
  useEffect(() => {
    api.get('/scan/latest').then(d => {
      setScan(d.scan);
      setResults(d.results);
      setFilters(filtersFromParams((d.scan || d.results || {}).params, meta));
    }).catch(e => {
      setFilters(defaultFilters(meta));
      setBanner({ tone: 'critical', text: e.message });
    });
  }, [meta, setBanner]);

  // Poll a running scan.
  useEffect(() => {
    if (!scan || scan.status !== 'running') return undefined;
    const t = setTimeout(async () => {
      try {
        const d = await api.get(`/scan/${scan.id}`);
        setScan(d.scan);
        if (d.scan.status === 'done') { setResults(d.scan); setPage(1); }
      } catch (e) {
        setBanner({ tone: 'critical', text: e.message });
      }
    }, 3000);
    return () => clearTimeout(t);
  }, [scan, setBanner]);

  const loadRows = useCallback(async () => {
    if (!results) { setData({ items: [], total: 0, pageSize: 100 }); return; }
    setLoadingRows(true);
    try {
      setData(await api.get(`/scan/${results.id}/items?page=${page}`));
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setLoadingRows(false);
    }
  }, [results, page, setBanner]);
  useEffect(() => { loadRows(); }, [loadRows]);
  // Selection is per page (Hera 2026-10-15): cleared when the page changes.
  useEffect(() => { setSelected([]); }, [results, page]);

  // Poll a running publish / unpublish.
  useEffect(() => {
    if (!action || action.status !== 'running') return undefined;
    const t = setTimeout(async () => {
      try {
        const d = await api.get(`/actions/${action.id}`);
        setAction(d.action);
        if (d.action.status !== 'running') loadRows();
      } catch (e) {
        setAction(a => ({ ...a, status: 'failed', error: e.message }));
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [action, loadRows]);

  if (!filters) return <Text tone="subdued">Loading...</Text>;

  const set = (patch) => setFilters(f => ({ ...f, ...patch }));
  const missing = [];
  if (!settings.fulfillmentLocation) missing.push('Fulfillment location');
  if (!settings.discontinued.namespace || !settings.discontinued.key) missing.push('Discontinued metafield');
  if (!settings.posOnly.namespace || !settings.posOnly.key) missing.push('POS_Only metafield');
  const qtyOk = (q) => /^\d+$/.test(String(q.value).trim());
  const filtersOk = filters.types.length > 0 && filters.channels.length > 0 && qtyOk(filters.fulfillmentQty) && qtyOk(filters.totalQty);
  const scanning = scan && scan.status === 'running';
  const acting = action && action.status === 'running';

  const startScan = async () => {
    setStarting(true);
    try {
      const d = await api.post('/scan', {
        ...filters,
        fulfillmentQty: { compare: filters.fulfillmentQty.compare, value: Number(filters.fulfillmentQty.value) },
        totalQty: { compare: filters.totalQty.compare, value: Number(filters.totalQty.value) },
      });
      setScan(d.scan);
      setAction(null);
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setStarting(false);
    }
  };

  const groupOptions = groups.map(g => ({ value: String(g.id), label: g.name }));
  const runAction = async (kind, groupIds) => {
    const chosen = groups.filter(g => groupIds.includes(String(g.id)));
    const chNames = [...new Set(chosen.flatMap(g => g.channelIds))].map(channelName);
    const verb = kind === 'publish' ? 'Publish' : 'Unpublish';
    const prep = kind === 'publish' ? 'to' : 'from';
    if (!window.confirm(`${verb} ${selected.length} selected item(s) ${prep}:\n${chNames.join(', ')}?`)) return;
    try {
      const d = await api.post(`/${kind}`, { itemIds: selected, groupIds: groupIds.map(Number) });
      setAction(d.action);
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    }
  };

  const rows = data.items;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const allSelected = rows.length > 0 && rows.every(r => selected.includes(r.id));
  const rp = (results && results.params) || {};
  const fulfilHeader = `${rp.fulfillmentLocation || 'Fulfillment'} Qty`;
  const qtyLabel = rp.qty === 'on_hand' ? 'On hand' : 'Available';

  return (
    <BlockStack gap="400">
      <Text tone="subdued" variant="bodySm">Check if there is unwanted items published in Online.</Text>
      {missing.length > 0 && (
        <Banner tone="warning">Set {missing.join(', ')} in Settings first.</Banner>
      )}
      <Card>
        <BlockStack gap="300">
          <InlineStack gap="300" blockAlign="end" wrap>
            <div style={{ width: 160 }}>
              <MultiSelectDropdown label="Type" options={meta.productTypes} selected={filters.types}
                onChange={(v) => set({ types: v })} placeholder="Choose" />
            </div>
            <div style={{ width: 180 }}>
              <MultiSelectDropdown label="Channels" showSelectAll
                options={meta.channels.map(c => ({ value: c.id, label: c.name }))} selected={filters.channels}
                onChange={(v) => set({ channels: v })} placeholder="Choose"
                formatDisplay={(sel, all) => (sel.length && sel.length === all.length ? 'All channels' : (sel.length ? sel.map(channelName).join(', ') : 'Choose'))} />
            </div>
            <div style={{ width: 90 }}>
              <Select label="Published" options={[{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]}
                value={filters.published} onChange={(v) => set({ published: v })} />
            </div>
            <div style={{ width: 110 }}>
              <Select label="Discontinued" options={DISC_OPTIONS} value={filters.discontinued} onChange={(v) => set({ discontinued: v })} />
            </div>
            <QtyFilter label="Fulfillment Qty" value={filters.fulfillmentQty} onChange={(v) => set({ fulfillmentQty: v })} />
            <QtyFilter label="Total Qty" value={filters.totalQty} onChange={(v) => set({ totalQty: v })} />
            <Button variant="primary" onClick={startScan} loading={starting}
              disabled={!filtersOk || missing.length > 0 || scanning || acting}>Scan</Button>
          </InlineStack>
          <Text tone="subdued" variant="bodySm">
            Only Active products are scanned. Channels and Published: every chosen channel must match.
            Qty = {settings.qty === 'on_hand' ? 'On hand' : 'Available'} (Settings).
          </Text>
          {scanning && (
            <Text tone="subdued">Scanning… {scan.objects ? `${scan.objects} items read from Shopify` : 'waiting for Shopify'}. You can leave this page; the scan keeps running.</Text>
          )}
          {scan && scan.status === 'failed' && (
            <Banner tone="critical">Scan failed: {scan.error}</Banner>
          )}
        </BlockStack>
      </Card>

      {action && (
        <Banner tone={action.status === 'running' ? 'info' : (action.failed.length || action.error ? 'warning' : 'success')}
          onDismiss={action.status === 'running' ? undefined : () => setAction(null)}>
          <BlockStack gap="100">
            <Text>
              {action.kind === 'publish' ? 'Publish' : 'Unpublish'}:{' '}
              {action.status === 'running'
                ? `${action.done} of ${action.total} done…`
                : `${action.succeeded} succeeded${action.failed.length ? `, ${action.failed.length} failed` : ''}.`}
            </Text>
            {action.error && <Text>Stopped: {action.error}</Text>}
            {action.failed.map((f, i) => (
              <Text key={i} variant="bodySm">{f.title}{f.variantName ? ` · ${f.variantName}` : ''} — {f.reason}</Text>
            ))}
          </BlockStack>
        </Banner>
      )}

      {/* MultiSelectDropdown needs a label (it finds its open list by label). */}
      <InlineStack gap="300" align="end" blockAlign="end" wrap>
        <Button onClick={() => runAction('publish', publishGroups)}
          disabled={!selected.length || !publishGroups.length || acting || scanning}>Publish selected to</Button>
        <div style={{ width: 160 }}>
          <MultiSelectDropdown label="Group" options={groupOptions} selected={publishGroups} onChange={setPublishGroups} placeholder="Group" />
        </div>
        <Button onClick={() => runAction('unpublish', unpublishGroups)}
          disabled={!selected.length || !unpublishGroups.length || acting || scanning}>Unpublish selected from</Button>
        <div style={{ width: 160 }}>
          <MultiSelectDropdown label="Group " options={groupOptions} selected={unpublishGroups} onChange={setUnpublishGroups} placeholder="Group" />
        </div>
      </InlineStack>

      <Card padding="200">
        <BlockStack gap="200">
          {results && (
            <Text tone="subdued" variant="bodySm">
              Last scan {fmtTime(results.finishedAt)} · {(rp.types || []).join(', ')} · Published {rp.published === 'no' ? 'No' : 'Yes'}
              {' '}· Discontinued {DISC_OPTIONS.find(o => o.value === rp.discontinued)?.label || '—'}
              {rp.fulfillmentQty ? ` · ${rp.fulfillmentLocation} ${COMPARE_TEXT[rp.fulfillmentQty.compare]} ${rp.fulfillmentQty.value}` : ''}
              {rp.totalQty ? ` · Total ${COMPARE_TEXT[rp.totalQty.compare]} ${rp.totalQty.value}` : ''}
              {' '}({qtyLabel}) · {data.total} result{data.total === 1 ? '' : 's'}
            </Text>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...TH, width: 32 }}>
                    <Checkbox label="Select all" labelHidden checked={allSelected} disabled={!rows.length}
                      onChange={() => setSelected(allSelected ? [] : rows.map(r => r.id))} />
                  </th>
                  <th style={TH}>Title</th>
                  <th style={TH}>Variant name</th>
                  <th style={TH}>Vendor</th>
                  <th style={TH}>POS Only</th>
                  <th style={TH}>{fulfilHeader}</th>
                  <th style={TH}>Total Qty</th>
                  <th style={TH}>Channels</th>
                </tr>
              </thead>
              <tbody>
                {!results && (
                  <tr><td style={TD} colSpan={8}><Text tone="subdued">No scan yet. Choose the filters and click Scan.</Text></td></tr>
                )}
                {results && loadingRows && !rows.length && (
                  <tr><td style={TD} colSpan={8}><Text tone="subdued">Loading...</Text></td></tr>
                )}
                {results && !loadingRows && !rows.length && (
                  <tr><td style={TD} colSpan={8}><Text tone="subdued">Nothing found.</Text></td></tr>
                )}
                {rows.map(r => {
                  const pid = numId(r.productId);
                  return (
                    <tr key={r.id}>
                      <td style={TD}>
                        <Checkbox label="Select" labelHidden checked={selected.includes(r.id)}
                          onChange={(c) => setSelected(s => (c ? [...s, r.id] : s.filter(x => x !== r.id)))} />
                      </td>
                      <td style={TD}><a href={`${ADMIN}${pid}`} target="_blank" rel="noreferrer" style={LINK}>{r.title}</a></td>
                      <td style={TD}>
                        {r.isDefaultVariant
                          ? '—'
                          : <a href={`${ADMIN}${pid}/variants/${numId(r.variantId)}`} target="_blank" rel="noreferrer" style={LINK}>{r.variantName}</a>}
                      </td>
                      <td style={TD}>{r.vendor}</td>
                      <td style={TD}>{r.posOnly || '—'}</td>
                      <td style={TD}>{r.fulfillmentQty}</td>
                      <td style={TD}>{r.totalQty}</td>
                      <td style={TD}>{r.channelIds.length ? r.channelIds.map(channelName).sort().join(', ') : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <InlineStack gap="200" align="center" blockAlign="center">
              <Button size="slim" onClick={() => setPage(p => p - 1)} disabled={page <= 1 || loadingRows}>Previous</Button>
              <Text variant="bodySm">Page {page} of {pages} · {data.total} rows</Text>
              <Button size="slim" onClick={() => setPage(p => p + 1)} disabled={page >= pages || loadingRows}>Next</Button>
            </InlineStack>
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────
function MetafieldRow({ label, value, onChange }) {
  const [editing, setEditing] = useState(false);
  return (
    <InlineStack gap="300" blockAlign="end" wrap>
      <div style={{ width: 170 }}><Text variant="headingSm" as="h3">{label}</Text></div>
      <div style={{ width: 130 }}>
        <Select label="Metafield" options={OWNER_OPTIONS} value={value.owner} disabled={!editing}
          onChange={(v) => onChange({ ...value, owner: v })} />
      </div>
      <div style={{ width: 150 }}>
        <TextField label="Name space" value={value.namespace} disabled={!editing} autoComplete="off"
          onChange={(v) => onChange({ ...value, namespace: v })} />
      </div>
      <div style={{ width: 150 }}>
        <TextField label="Key" value={value.key} disabled={!editing} autoComplete="off"
          onChange={(v) => onChange({ ...value, key: v })} />
      </div>
      {!editing && <Button variant="plain" onClick={() => setEditing(true)}>Edit</Button>}
    </InlineStack>
  );
}

function SettingsTab({ meta, settings, setSettings, setBanner }) {
  const [draft, setDraft] = useState(settings);
  const [formKey, setFormKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState([]);
  useEffect(() => { setDraft(settings); }, [settings]);

  const save = async () => {
    setSaving(true);
    setWarnings([]);
    try {
      const d = await api.put('/settings', draft);
      setSettings(d.settings);
      setWarnings(d.warnings || []);
      setFormKey(k => k + 1); // close the Edit fields
      setBanner({ tone: 'success', text: 'Settings saved.' });
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const locOptions = [
    ...(draft.fulfillmentLocation ? [] : [{ label: 'Choose a location', value: '' }]),
    ...meta.locations.map(l => ({ label: l, value: l })),
    ...(draft.fulfillmentLocation && !meta.locations.includes(draft.fulfillmentLocation)
      ? [{ label: `${draft.fulfillmentLocation} (not in location map)`, value: draft.fulfillmentLocation }] : []),
  ];

  return (
    <Card>
      <BlockStack gap="400" key={formKey}>
        {warnings.map((w, i) => <Banner key={i} tone="warning">{w}</Banner>)}
        <MetafieldRow label="Discontinued" value={draft.discontinued} onChange={(v) => setDraft(d => ({ ...d, discontinued: v }))} />
        <MetafieldRow label="POS_Only" value={draft.posOnly} onChange={(v) => setDraft(d => ({ ...d, posOnly: v }))} />
        <InlineStack gap="300" blockAlign="end" wrap align="space-between">
          <InlineStack gap="300" blockAlign="end" wrap>
            <div style={{ width: 170 }}><Text variant="headingSm" as="h3">Fulfillment location</Text></div>
            <div style={{ width: 150 }}>
              <Select label="Location" options={locOptions} value={draft.fulfillmentLocation || ''}
                onChange={(v) => setDraft(d => ({ ...d, fulfillmentLocation: v || null }))} />
            </div>
            <div style={{ width: 150 }}>
              <Select label="Qty" options={QTY_OPTIONS} value={draft.qty} onChange={(v) => setDraft(d => ({ ...d, qty: v }))} />
            </div>
          </InlineStack>
          <Button variant="primary" onClick={save} loading={saving}>Save</Button>
        </InlineStack>
        <Text tone="subdued" variant="bodySm">
          Metafield: Products = every variant reads its product's metafield; Variants = the variant's own metafield.
          Qty applies to both Qty filters and both Qty columns.
        </Text>
      </BlockStack>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
// inTabs: shown as a tab of Online (OnlineHome) — no title or back arrow of its own.
function OnlinePublication({ inTabs = false } = {}) {
  const [meta, setMeta] = useState(null);
  const [groups, setGroups] = useState([]);
  const [settings, setSettings] = useState(null);
  const [tab, setTab] = useState(0);
  const [banner, setBanner] = useState(null);

  useEffect(() => {
    Promise.all([api.get('/meta'), api.get('/groups'), api.get('/settings')])
      .then(([m, g, s]) => { setMeta(m); setGroups(g.groups); setSettings(s.settings); })
      .catch(e => setBanner({ tone: 'critical', text: e.message }));
  }, []);

  const title = inTabs ? undefined : 'Publication';
  if (!meta || !settings) {
    return (
      <Page title={title}>
        <BlockStack gap="300">
          {banner && <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>}
          {!banner && <Text tone="subdued">Loading...</Text>}
        </BlockStack>
      </Page>
    );
  }

  return (
    <Page title={title}>
      <BlockStack gap="400">
        {banner && <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>}
        <ChannelGroupsCard meta={meta} groups={groups} setGroups={setGroups} setBanner={setBanner} />
        <Tabs tabs={SUB_TABS} selected={tab} onSelect={setTab} />
        {SUB_TABS[tab].id === 'publishing' && (
          <PublishingTab meta={meta} groups={groups} settings={settings} setBanner={setBanner} />
        )}
        {SUB_TABS[tab].id === 'settings' && (
          <SettingsTab meta={meta} settings={settings} setSettings={setSettings} setBanner={setBanner} />
        )}
      </BlockStack>
    </Page>
  );
}

export default OnlinePublication;
