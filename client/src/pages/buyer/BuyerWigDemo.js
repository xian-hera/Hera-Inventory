import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Checkbox, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01','HQ'
];

function formatDemoDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function BuyerWigDemo() {
  const navigate = useNavigate();

  const [selectedLocations, setSelectedLocations] = useState([...LOCATIONS]);
  const [items, setItems]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (selectedLocations.length > 0 && selectedLocations.length < LOCATIONS.length) {
        params.append('locations', selectedLocations.join(','));
      } else if (selectedLocations.length === 0) {
        setItems([]);
        setLoading(false);
        return;
      }
      const res = await fetch(`/api/wig-demo/buyer?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [selectedLocations]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const toggleSelectOne = (id) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleCancelDemo = async () => {
    if (selectedIds.length === 0) return;
    setCancelling(true);
    setError('');
    try {
      const res = await fetch('/api/wig-demo', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel');
      setItems(prev => prev.filter(i => !(data.deletedIds || []).includes(i.id)));
      setSelectedIds([]);
      if (data.errors?.length > 0) setError(data.errors.join('\n'));
    } catch (e) {
      setError(e.message);
    } finally {
      setCancelling(false);
    }
  };

  // Group into one card per location — only locations that currently have at
  // least one demo get a card, in LOCATIONS order (not just whatever order
  // rows happen to come back in).
  const byLocation = {};
  items.forEach(item => {
    if (!byLocation[item.location]) byLocation[item.location] = [];
    byLocation[item.location].push(item);
  });
  const locationsWithDemos = LOCATIONS.filter(loc => byLocation[loc]?.length > 0);

  return (
    <Page title="Wig DEMO" backAction={{ onAction: () => navigate('/buyer') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <InlineStack align="space-between" blockAlign="end" wrap gap="300">
              <MultiSelectDropdown
                label="Locations"
                options={LOCATIONS}
                selected={selectedLocations}
                onChange={setSelectedLocations}
                showSelectAll
              />
              <InlineStack gap="200" blockAlign="end">
                <button
                  disabled={selectedIds.length === 0 || cancelling}
                  onClick={handleCancelDemo}
                  style={{
                    padding: '9px 18px', borderRadius: '20px', border: 'none',
                    background: selectedIds.length === 0 || cancelling ? '#f6f6f7' : '#d72c0d',
                    color: selectedIds.length === 0 || cancelling ? '#8c9196' : 'white',
                    cursor: selectedIds.length === 0 || cancelling ? 'not-allowed' : 'pointer',
                    fontSize: '13px', fontWeight: '700', whiteSpace: 'nowrap',
                  }}
                >
                  {cancelling ? 'Cancelling…' : 'Cancel DEMO'}
                </button>
              </InlineStack>
            </InlineStack>

            {loading ? (
              <InlineStack align="center"><Spinner /></InlineStack>
            ) : locationsWithDemos.length === 0 ? (
              <Card>
                <Text tone="subdued" alignment="center">No current demos for the selected location(s).</Text>
              </Card>
            ) : (
              locationsWithDemos.map(loc => {
                const rows = byLocation[loc];
                const allSelected = rows.every(r => selectedIds.includes(r.id));
                const someSelected = rows.some(r => selectedIds.includes(r.id));
                const toggleAllInCard = () => {
                  const ids = rows.map(r => r.id);
                  setSelectedIds(prev => allSelected
                    ? prev.filter(id => !ids.includes(id))
                    : [...new Set([...prev, ...ids])]);
                };
                return (
                  <Card key={loc}>
                    <BlockStack gap="300">
                      <Text variant="headingSm" fontWeight="bold">{loc}</Text>
                      {/* Column order per Hera (2026-09-15): SKU, Name, Color,
                          Wig number, Demo date — Wig number (custom.wig_number
                          product metafield, see attachWigNumbers() in
                          wigDemo.js) sits between Color and Demo date. */}
                      <div style={{
                        display: 'grid', gridTemplateColumns: '32px 100px 1fr 90px 70px 90px',
                        gap: '8px', padding: '8px 0', borderBottom: '2px solid #e1e3e5',
                        fontSize: '12px', fontWeight: '600', color: '#6d7175',
                      }}>
                        <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={toggleAllInCard} />
                        <span>SKU</span>
                        <span>Name</span>
                        <span>Color</span>
                        <span>Wig number</span>
                        <span>Demo date</span>
                      </div>
                      {rows.map(item => (
                        <div key={item.id} style={{
                          display: 'grid', gridTemplateColumns: '32px 100px 1fr 90px 70px 90px',
                          gap: '8px', padding: '10px 0', borderBottom: '1px solid #f1f1f1',
                          alignItems: 'center',
                        }}>
                          <Checkbox checked={selectedIds.includes(item.id)} onChange={() => toggleSelectOne(item.id)} />
                          <div style={{ fontSize: '13px', wordBreak: 'break-word' }}>{item.barcode}</div>
                          <div style={{ fontSize: '14px', fontWeight: '500', wordBreak: 'break-word' }}>{item.name || '-'}</div>
                          <div style={{ fontSize: '13px' }}>{item.variant_name || '-'}</div>
                          <div style={{ fontSize: '13px', wordBreak: 'break-word' }}>{item.wig_number || '-'}</div>
                          <div style={{ fontSize: '13px' }}>{formatDemoDate(item.created_at)}</div>
                        </div>
                      ))}
                    </BlockStack>
                  </Card>
                );
              })
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerWigDemo;
