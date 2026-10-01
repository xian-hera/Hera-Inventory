// Online › Swatch › Libraries (spec §4, §5.2). A library's name is a Shopify
// vendor name exactly (picked from the list, never typed — Hera 2026-10-01);
// other vendors can be linked to share its images.
import React, { useState } from 'react';
import { Card, BlockStack, InlineStack, Text, Button, Select, TextField, Banner } from '@shopify/polaris';
import MultiSelectDropdown from '../../../components/MultiSelectDropdown';
import { api, TH, TD } from './swatchApi';

function SwatchLibrariesTab({ meta, libraries, loadLibraries, setBanner, afterSave }) {
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [linked, setLinked] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null); // { id, vendors }

  const taken = new Set(libraries.flatMap(l => l.vendors));
  const freeVendors = meta.vendors.filter(v => !taken.has(v));

  const create = async () => {
    setErr('');
    setSaving(true);
    try {
      const d = await api.post('/libraries', { name, prefix: prefix.trim(), vendors: linked });
      setName(''); setPrefix(''); setLinked([]);
      await loadLibraries();
      afterSave(d, `Library ${d.library.name} created.`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveVendors = async (lib) => {
    try {
      const d = await api.put(`/libraries/${lib.id}`, { vendors: editing.vendors });
      setEditing(null);
      await loadLibraries();
      afterSave(d, `Linked vendors of ${lib.name} saved.`);
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    }
  };

  const remove = async (lib) => {
    if (!window.confirm(`Delete the library ${lib.name}?`)) return;
    try {
      const d = await api.del(`/libraries/${lib.id}`);
      await loadLibraries();
      afterSave(d, `Library ${lib.name} deleted.`);
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    }
  };

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">New library</Text>
          <Text tone="subdued" variant="bodySm">
            Name = the vendor exactly as in Shopify. Prefix (lowercase letters and digits) goes into every file name: Hera_swatch_{'{prefix}'}_{'{original file name}'}.
            Name and prefix can't be changed once the library has images.
          </Text>
          <InlineStack gap="300" blockAlign="end" wrap>
            <div style={{ width: 240 }}>
              <Select label="Vendor (library name)" options={[{ label: 'Choose…', value: '' }, ...freeVendors.map(v => ({ label: v, value: v }))]}
                value={name} onChange={(v) => { setName(v); setLinked(l => l.filter(x => x !== v)); }} />
            </div>
            <div style={{ width: 120 }}>
              <TextField label="Prefix" value={prefix} onChange={(v) => setPrefix(v.toLowerCase().replace(/[^a-z0-9]/g, ''))} autoComplete="off" placeholder="e.g. sen" />
            </div>
            <div style={{ minWidth: 220 }}>
              <MultiSelectDropdown label="Also used by (optional)" options={freeVendors.filter(v => v !== name)} selected={linked} onChange={setLinked} placeholder="None" />
            </div>
            <Button variant="primary" onClick={create} loading={saving} disabled={!name || !prefix}>Create</Button>
          </InlineStack>
          {err && <Banner tone="critical" onDismiss={() => setErr('')}>{err}</Banner>}
        </BlockStack>
      </Card>

      <Card padding="0">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH}>Library</th>
              <th style={TH}>Prefix</th>
              <th style={TH}>Vendors using it</th>
              <th style={TH}>Images</th>
              <th style={TH}>Colour codes linked</th>
              <th style={TH} />
            </tr>
          </thead>
          <tbody>
            {libraries.map(l => (
              <tr key={l.id}>
                <td style={TD}><Text fontWeight="semibold">{l.name}</Text></td>
                <td style={TD}>{l.prefix}</td>
                <td style={TD}>
                  {editing && editing.id === l.id ? (
                    <InlineStack gap="200" blockAlign="end">
                      <div style={{ minWidth: 220 }}>
                        <MultiSelectDropdown label="" options={[...l.vendors.filter(v => v !== l.name), ...freeVendors]}
                          selected={editing.vendors.filter(v => v !== l.name)} onChange={(v) => setEditing({ id: l.id, vendors: [l.name, ...v] })} placeholder="Only its own vendor" />
                      </div>
                      <Button size="slim" variant="primary" onClick={() => saveVendors(l)}>Save</Button>
                      <Button size="slim" onClick={() => setEditing(null)}>Cancel</Button>
                    </InlineStack>
                  ) : (
                    <InlineStack gap="200" blockAlign="center">
                      <span>{l.vendors.join(', ')}</span>
                      <Button size="slim" variant="plain" onClick={() => setEditing({ id: l.id, vendors: l.vendors })}>Edit</Button>
                    </InlineStack>
                  )}
                </td>
                <td style={TD}>{l.image_count}</td>
                <td style={TD}>{l.code_count}</td>
                <td style={TD}>
                  <Button size="slim" tone="critical" variant="plain" onClick={() => remove(l)} disabled={l.image_count > 0}>Delete</Button>
                </td>
              </tr>
            ))}
            {libraries.length === 0 && <tr><td style={TD} colSpan={6}><Text tone="subdued">No library yet.</Text></td></tr>}
          </tbody>
        </table>
      </Card>
    </BlockStack>
  );
}

export default SwatchLibrariesTab;
