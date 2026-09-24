// Online → New products (2026-09-24, Hera). Products Buyer created with
// Import Products → Add new (POS only excluded), grouped by the Settings
// groups (+ a hidden built-in "Ungrouped" group). Spec §15.
// Full width; the table wraps text instead of scrolling sideways.
import React, { useState, useEffect, useCallback } from 'react';
import { Page, Card, BlockStack, InlineStack, Text, Button, Banner, Spinner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { HtmlTooltip, FrIcon, adminUrl, TH, TD, postJson } from './newProductsShared';
import FullBleed from '../../components/FullBleed';

const DESC_CHARS = 60;

function GroupCard({ group, onChanged, setBanner }) {
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState('');
  const items = group.items;
  const mfs = group.metafields || [];
  const allSelected = items.length > 0 && items.every(i => selected.includes(i.id));

  const act = async (kind) => {
    const ids = kind === 'refresh' ? items.map(i => i.id) : selected;
    if (!ids.length) return;
    if (kind === 'delete' && !window.confirm(`Remove ${ids.length} item(s) from this list? (The products stay in Shopify.)`)) return;
    setBusy(kind);
    try {
      if (kind === 'refresh') {
        const r = await postJson('/api/new-products/refresh', { ids });
        if (r.errors && r.errors.length) setBanner({ tone: 'warning', text: `Refreshed ${r.refreshed}. Failed: ${r.errors.map(e => `${e.title} (${e.error})`).join('; ')}` });
        else setBanner({ tone: 'success', text: `Refreshed ${r.refreshed} item(s).` });
      } else if (kind === 'delete') {
        await postJson('/api/new-products/delete', { ids });
      } else if (kind === 'finalize') {
        await postJson('/api/new-products/finalize', { ids });
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
        <Text variant="headingMd" as="h2">{group.name}</Text>
        <InlineStack gap="200">
          <Button onClick={() => act('refresh')} loading={busy === 'refresh'} disabled={!items.length || !!busy}>Refresh</Button>
          <Button tone="critical" variant="primary" onClick={() => act('delete')} loading={busy === 'delete'} disabled={!selected.length || !!busy}>Delete selected</Button>
          <Button variant="primary" onClick={() => act('finalize')} loading={busy === 'finalize'} disabled={!selected.length || !!busy}>Mark selected as finalized</Button>
        </InlineStack>
      </InlineStack>
      <FullBleed>
      <Card padding="0">
        <div style={{ padding: '4px 12px 8px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: 32 }}>
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? [] : items.map(i => i.id))} />
                </th>
                <th style={TH}>Title</th>
                <th style={{ ...TH, width: 60 }}>Media</th>
                <th style={TH}>Description</th>
                <th style={TH}>Weight</th>
                {mfs.map(m => <th key={`${m.level}.${m.namespace}.${m.key}`} style={TH}>{m.name}</th>)}
                <th style={TH}>Tags</th>
              </tr>
            </thead>
            <tbody>
              {items.map(i => (
                <tr key={i.id}>
                  <td style={TD}>
                    <input type="checkbox" checked={selected.includes(i.id)} onChange={() => setSelected(s => (s.includes(i.id) ? s.filter(x => x !== i.id) : [...s, i.id]))} />
                  </td>
                  <td style={{ ...TD, minWidth: 180 }}>
                    {i.titleFr && <HtmlTooltip text={i.titleFr}><FrIcon /></HtmlTooltip>}
                    <a href={adminUrl(i.shopifyProductId)} target="_blank" rel="noopener noreferrer">{i.title}</a>
                    {i.refreshError && <div style={{ color: '#d72c0d', fontSize: 12, marginTop: 2 }}>{i.refreshError}</div>}
                  </td>
                  <td style={TD}>{i.mediaCount == null ? '' : i.mediaCount}</td>
                  <td style={{ ...TD, minWidth: 220 }}>
                    {i.descriptionFrText && <HtmlTooltip html={i.descriptionFrHtml} text={i.descriptionFrText}><FrIcon /></HtmlTooltip>}
                    {i.descriptionText
                      ? <HtmlTooltip html={i.descriptionHtml} text={i.descriptionText}>
                          <span>{i.descriptionText.slice(0, DESC_CHARS)}{i.descriptionText.length > DESC_CHARS ? '…' : ''}</span>
                        </HtmlTooltip>
                      : ''}
                  </td>
                  <td style={TD}>{i.weight}</td>
                  {mfs.map(m => <td key={`${m.level}.${m.namespace}.${m.key}`} style={TD}>{(i.metafields || {})[`${m.level}.${m.namespace}.${m.key}`] || ''}</td>)}
                  <td style={TD}>{(i.tags || []).join(', ')}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={6 + mfs.length} style={{ ...TD, textAlign: 'center', color: '#6d7175', padding: 20 }}>No products.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      </FullBleed>
    </BlockStack>
  );
}

function OnlineNewProducts() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/new-products');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Load failed');
      setData(d);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    // Fixed-width page; only each group's table is full width (FullBleed) —
    // Hera 2026-09-24.
    <Page
      title="New products"
      backAction={{ onAction: () => navigate('/online') }}
      secondaryActions={[
        { content: 'Settings', onAction: () => navigate('/online/new-products/settings') },
        { content: 'Finalized', onAction: () => navigate('/online/new-products/finalized') },
      ]}
    >
      <BlockStack gap="500">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {banner && <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>}
        {!data && !error && <InlineStack align="center"><Spinner /></InlineStack>}
        {data && data.groups.map(g => <GroupCard key={g.id} group={g} onChanged={load} setBanner={setBanner} />)}
        {data && data.ungrouped.length > 0 && (
          <GroupCard group={{ id: 'ungrouped', name: 'Ungrouped', metafields: [], items: data.ungrouped }} onChanged={load} setBanner={setBanner} />
        )}
        {data && !data.groups.length && !data.ungrouped.length && (
          <Card><Text tone="subdued" alignment="center">No new products.</Text></Card>
        )}
      </BlockStack>
    </Page>
  );
}

export default OnlineNewProducts;
