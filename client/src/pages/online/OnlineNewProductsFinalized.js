// Online → New products → Finalized (2026-09-24, Hera). Spec §16.
// Two cards split by finalized date (N = "Delete tag in days" in Settings).
// Publish: Draft → Active, publish to the Settings channels, add the New
// Arrival tag, download "publish MM-DD.csv" (one row per variant: Title,
// SKU, Date = publish date), and remove the published rows from the list.
import React, { useState, useEffect, useCallback } from 'react';
import Papa from 'papaparse';
import { Page, Card, BlockStack, InlineStack, Text, Button, Banner, Spinner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { adminUrl, TH, TD, postJson } from './newProductsShared';

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function downloadPublishCsv(published) {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const data = [];
  for (const p of published) {
    const skus = p.skus && p.skus.length ? p.skus : [''];
    for (const sku of skus) data.push([p.title, sku, date]);
  }
  const text = Papa.unparse({ fields: ['Title', 'SKU', 'Date'], data });
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `publish ${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function FinalizedCard({ title, items, onChanged, setBanner }) {
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState('');
  const allSelected = items.length > 0 && items.every(i => selected.includes(i.id));

  const act = async (kind) => {
    const ids = kind === 'refresh' ? items.map(i => i.id) : selected;
    if (!ids.length) return;
    if (kind === 'delete' && !window.confirm(`Remove ${ids.length} item(s) from this list? (The products stay in Shopify.)`)) return;
    setBusy(kind);
    try {
      if (kind === 'refresh') {
        const r = await postJson('/api/new-products/refresh', { ids, withInventory: true });
        setBanner(r.errors && r.errors.length
          ? { tone: 'warning', text: `Refreshed ${r.refreshed}. Failed: ${r.errors.map(e => `${e.title} (${e.error})`).join('; ')}` }
          : { tone: 'success', text: `Refreshed ${r.refreshed} item(s).` });
      } else if (kind === 'delete') {
        await postJson('/api/new-products/delete', { ids });
      } else if (kind === 'publish') {
        const r = await postJson('/api/new-products/publish', { ids });
        if (r.published.length) downloadPublishCsv(r.published);
        if (r.failed.length) {
          setBanner({ tone: 'critical', text: `Published ${r.published.length}. Not published: ${r.failed.map(f => `${f.title} — ${f.error}`).join('; ')}` });
        } else {
          setBanner({ tone: 'success', text: `Published ${r.published.length} product(s).` });
        }
      }
      setSelected([]);
      await onChanged();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setBusy('');
    }
  };

  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <Text variant="headingMd" as="h2">{title}</Text>
        <InlineStack gap="200">
          <Button onClick={() => act('refresh')} loading={busy === 'refresh'} disabled={!items.length || !!busy}>Refresh</Button>
          <Button tone="critical" variant="primary" onClick={() => act('delete')} loading={busy === 'delete'} disabled={!selected.length || !!busy}>Delete selected</Button>
          <Button variant="primary" onClick={() => act('publish')} loading={busy === 'publish'} disabled={!selected.length || !!busy}>Publish selected</Button>
        </InlineStack>
      </InlineStack>
      <Card padding="0">
        <div style={{ padding: '4px 12px 8px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: 32 }}>
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? [] : items.map(i => i.id))} />
                </th>
                <th style={TH}>Title</th>
                <th style={TH}>Type</th>
                <th style={TH}>Inventory</th>
                <th style={{ ...TH, width: 120 }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {items.map(i => (
                <tr key={i.id}>
                  <td style={TD}>
                    <input type="checkbox" checked={selected.includes(i.id)} onChange={() => setSelected(s => (s.includes(i.id) ? s.filter(x => x !== i.id) : [...s, i.id]))} />
                  </td>
                  <td style={TD}>
                    <a href={adminUrl(i.shopifyProductId)} target="_blank" rel="noopener noreferrer">{i.title}</a>
                    {i.refreshError && <div style={{ color: '#d72c0d', fontSize: 12, marginTop: 2 }}>{i.refreshError}</div>}
                  </td>
                  <td style={TD}>{i.productType}</td>
                  <td style={TD}>{i.available == null ? '—' : i.available}</td>
                  <td style={TD}>{fmtDate(i.finalizedAt)}</td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={5} style={{ ...TD, textAlign: 'center', color: '#6d7175', padding: 20 }}>No products.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </BlockStack>
  );
}

function OnlineNewProductsFinalized() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/new-products/finalized');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Load failed');
      setData(d);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <Page title="Finalized" backAction={{ onAction: () => navigate('/online/new-products') }}>
      <BlockStack gap="500">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {banner && <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>}
        {!data && !error && <InlineStack align="center"><Spinner /></InlineStack>}
        {data && (
          <>
            <FinalizedCard title={`Last ${data.days} days`} items={data.recent} onChanged={load} setBanner={setBanner} />
            <FinalizedCard title={`Before last ${data.days} days`} items={data.older} onChanged={load} setBanner={setBanner} />
            <Text variant="bodySm" tone="subdued">Items in "Before last {data.days} days" are removed from this list automatically 100 days after they were finalized.</Text>
          </>
        )}
      </BlockStack>
    </Page>
  );
}

export default OnlineNewProductsFinalized;
