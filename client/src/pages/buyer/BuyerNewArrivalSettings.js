// Buyer → Settings → New Arrival (2026-09-29, Hera).
// Rules for Store → New Arrival. Spec: claude/STORE_NEW_ARRIVAL_FEATURE.md
// Each card saves on its own.
import React, { useState, useEffect } from 'react';
import { Page, Layout, Card, BlockStack, InlineStack, Text, Button, Banner, TextField, Spinner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { useLocationMap } from '../shared/locationMap';

function BuyerNewArrivalSettings() {
  const navigate = useNavigate();
  const { names: locationNames } = useLocationMap();
  const [types, setTypes] = useState([]);
  const [loaded, setLoaded] = useState(null); // settings from the server
  const [error, setError] = useState('');
  const [msg, setMsg] = useState({}); // card → message

  const [shelfLocations, setShelfLocations] = useState([]);
  const [days, setDays] = useState('');
  const [tbdDays, setTbdDays] = useState('');
  const [includedTypes, setIncludedTypes] = useState([]);
  const [saving, setSaving] = useState('');

  const apply = (d) => {
    setLoaded(d);
    setShelfLocations(d.shelfLocationsEffective || []);
    setDays(String(d.days));
    setTbdDays(String(d.tbdDeleteDays));
  };

  useEffect(() => {
    fetch('/api/store-new-arrivals/settings').then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Load failed');
      apply(d);
    }).catch(e => setError(e.message));
    fetch('/api/shopify/product-types').then(r => r.json()).then(d => setTypes(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  // Types are stored as the EXCLUDED list, so a type that appears later is
  // included automatically.
  useEffect(() => {
    if (!loaded) return;
    const ex = new Set((loaded.excludedTypes || []).map(t => t.toLowerCase()));
    setIncludedTypes(types.filter(t => !ex.has(t.toLowerCase())));
  }, [loaded, types]);

  const save = async (card, body) => {
    setSaving(card); setError(''); setMsg(m => ({ ...m, [card]: '' }));
    try {
      const res = await fetch('/api/store-new-arrivals/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Save failed');
      apply(d);
      setMsg(m => ({ ...m, [card]: 'Saved.' }));
    } catch (e) {
      setMsg(m => ({ ...m, [card]: '' }));
      setError(e.message);
    } finally {
      setSaving('');
    }
  };

  const minDays = loaded ? loaded.minDays : 10;
  const minTbd = loaded ? loaded.minTbdDeleteDays : 90;
  const daysBad = !(parseInt(days, 10) >= minDays);
  const tbdBad = !(parseInt(tbdDays, 10) >= minTbd);
  const Saved = ({ card }) => (msg[card] ? <Banner tone="success" onDismiss={() => setMsg(m => ({ ...m, [card]: '' }))}>{msg[card]}</Banner> : null);

  return (
    <Page title="New Arrival" backAction={{ onAction: () => navigate('/buyer/settings') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {!loaded && !error && <InlineStack align="center"><Spinner /></InlineStack>}
            {loaded && (
              <>
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h2">Shelf date locations</Text>
                    <Text tone="subdued">A new product's "new" period starts on the first day any of these locations has available stock.</Text>
                    <Saved card="shelf" />
                    <InlineStack gap="300" blockAlign="end" align="space-between">
                      <div style={{ minWidth: 280 }}>
                        <MultiSelectDropdown label="" options={locationNames} selected={shelfLocations} onChange={setShelfLocations} placeholder="None" showSelectAll />
                      </div>
                      <Button variant="primary" onClick={() => save('shelf', { shelfLocations })} loading={saving === 'shelf'} disabled={!shelfLocations.length}>Save</Button>
                    </InlineStack>
                    {loaded.shelfLocations === null && (
                      <Text variant="bodySm" tone="subdued">Not saved yet — using every active location except HQ.</Text>
                    )}
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h2">New period</Text>
                    <Text tone="subdued">How many days a product stays in New Arrival, counted from its shelf date.</Text>
                    <Saved card="days" />
                    <InlineStack gap="300" blockAlign="end" align="space-between">
                      <div style={{ width: 160 }}>
                        <TextField label="Days" type="number" min={minDays} value={days} onChange={setDays} autoComplete="off"
                          error={days !== '' && daysBad ? `${minDays} or more` : undefined} />
                      </div>
                      <Button variant="primary" onClick={() => save('days', { days: parseInt(days, 10) })} loading={saving === 'days'} disabled={daysBad}>Save</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h2">TBD products</Text>
                    <Text tone="subdued">Delete a product that is still "New until TBD" (never in stock at a shelf date location) this many days after it entered New Arrival.</Text>
                    <Saved card="tbd" />
                    <InlineStack gap="300" blockAlign="end" align="space-between">
                      <div style={{ width: 160 }}>
                        <TextField label="Days" type="number" min={minTbd} value={tbdDays} onChange={setTbdDays} autoComplete="off"
                          error={tbdDays !== '' && tbdBad ? `${minTbd} or more` : undefined} />
                      </div>
                      <Button variant="primary" onClick={() => save('tbd', { tbdDeleteDays: parseInt(tbdDays, 10) })} loading={saving === 'tbd'} disabled={tbdBad}>Save</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h2">Types</Text>
                    <Text tone="subdued">Only the selected types are shown in New Arrival. New types are included automatically.</Text>
                    <Saved card="types" />
                    <InlineStack gap="300" blockAlign="end" align="space-between">
                      <div style={{ minWidth: 280 }}>
                        <MultiSelectDropdown label="" options={types} selected={includedTypes} onChange={setIncludedTypes} placeholder="None" showSelectAll />
                      </div>
                      <Button variant="primary" loading={saving === 'types'}
                        onClick={() => save('types', { excludedTypes: types.filter(t => !includedTypes.includes(t)) })}>Save</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              </>
            )}
            {/* Room for dropdowns opened near the bottom. */}
            <div style={{ height: '33vh' }} />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerNewArrivalSettings;
