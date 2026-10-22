import React, { useState, useEffect, useCallback } from 'react';
import { Page, Layout, Card, BlockStack, InlineStack, Text, Button, Banner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { clearLocationMapCache } from '../shared/locationMap';

// Purchasing → Settings → Locations (2026-10-22, Hera).
//
// Card 1 — Sync: refreshes the shared location map (server location_map
// table) from Shopify. Moved here from the old "Sync Locations" button on
// Settings (2026-09-24); same endpoint, same result banner.
//
// Card 2 — Order: one button per location prefix (the location names with
// the digits removed: MTL01…MTL11 → MTL). Click a prefix to select it, move
// it with ← / →, then Save. The saved order is the ONE order every location
// list in the Hub uses (server/routes/shopify.js compareLocationNames);
// within a prefix, locations stay in number order (MTL02 before MTL10).
function BuyerLocationsSettings() {
  const navigate = useNavigate();

  // ── Card 1: Sync ────────────────────────────────────────────────────────
  const [syncingLocations, setSyncingLocations] = useState(false);
  const [locationSyncResult, setLocationSyncResult] = useState(null); // { tone, lines[] }

  // ── Card 2: Order ───────────────────────────────────────────────────────
  const [prefixes, setPrefixes] = useState(null);      // current (edited) order
  const [savedPrefixes, setSavedPrefixes] = useState([]); // as loaded / last saved
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [orderNotice, setOrderNotice] = useState(null); // { tone, text }

  // Unsaved changes on the Order card?
  const dirty = !!prefixes && prefixes.join('|') !== savedPrefixes.join('|');

  const loadOrder = useCallback(async () => {
    try {
      const res = await fetch('/api/shopify/location-order');
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      const list = Array.isArray(data && data.prefixes) ? data.prefixes : [];
      setPrefixes(list);
      setSavedPrefixes(list);
      setSelected(null);
    } catch (e) {
      setPrefixes([]);
      setOrderNotice({ tone: 'critical', text: `Could not load locations: ${e.message}` });
    }
  }, []);

  useEffect(() => { loadOrder(); }, [loadOrder]);

  const handleSyncLocations = async () => {
    setSyncingLocations(true);
    setLocationSyncResult(null);
    try {
      const res = await fetch('/api/shopify/sync-locations', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      clearLocationMapCache();
      const lines = [`${(data.active || []).length} active locations synced from Shopify: ${(data.active || []).join(', ')}`];
      if ((data.added || []).length) lines.push(`New: ${data.added.join(', ')}`);
      if ((data.deactivated || []).length) lines.push(`No longer active (hidden from lists): ${data.deactivated.join(', ')}`);
      setLocationSyncResult({ tone: 'success', lines });
      // A sync can add or remove a prefix — refresh the Order card, unless
      // there are unsaved changes there (don't throw them away).
      if (!dirty) await loadOrder();
    } catch (e) {
      setLocationSyncResult({ tone: 'critical', lines: [`Sync failed: ${e.message}`] });
    } finally {
      setSyncingLocations(false);
    }
  };

  const move = (delta) => {
    if (!prefixes || selected == null) return;
    const i = prefixes.indexOf(selected);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= prefixes.length) return;
    const next = [...prefixes];
    [next[i], next[j]] = [next[j], next[i]];
    setPrefixes(next);
    setOrderNotice(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setOrderNotice(null);
    try {
      const res = await fetch('/api/shopify/location-order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      clearLocationMapCache();
      setSavedPrefixes(prefixes);
      setSelected(null);
      setOrderNotice({ tone: 'success', text: `Saved: ${prefixes.join(', ')}. Other devices see the new order after they reload the app.` });
    } catch (e) {
      setOrderNotice({ tone: 'critical', text: `Save failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  };

  const arrow = (label, delta, disabled) => (
    <Button size="slim" onClick={() => move(delta)} disabled={disabled} accessibilityLabel={delta < 0 ? 'Move left' : 'Move right'}>
      {label}
    </Button>
  );

  return (
    <Page title="Locations" backAction={{ onAction: () => navigate('/buyer/settings') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Sync</Text>
                <Text as="p" tone="subdued">
                  Get the latest locations from Shopify. Press this after adding, renaming or deactivating a location in Shopify.
                </Text>
                {locationSyncResult && (
                  <Banner tone={locationSyncResult.tone} onDismiss={() => setLocationSyncResult(null)}>
                    <BlockStack gap="100">
                      {locationSyncResult.lines.map((line, i) => <Text as="p" key={i}>{line}</Text>)}
                    </BlockStack>
                  </Banner>
                )}
                <InlineStack>
                  <Button onClick={handleSyncLocations} loading={syncingLocations}>Sync Locations</Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Order</Text>
                <Text as="p" tone="subdued">
                  The order of locations in every list of the Hub. Click a location, move it with the arrows, then Save.
                </Text>
                {orderNotice && (
                  <Banner tone={orderNotice.tone} onDismiss={() => setOrderNotice(null)}>{orderNotice.text}</Banner>
                )}
                {prefixes === null ? (
                  <Text as="p" tone="subdued">Loading...</Text>
                ) : prefixes.length === 0 ? (
                  <Text as="p" tone="subdued">No locations yet. Click Sync Locations.</Text>
                ) : (
                  <InlineStack gap="200" blockAlign="center" wrap>
                    {prefixes.map((p, i) => (
                      <InlineStack key={p} gap="100" blockAlign="center" wrap={false}>
                        {selected === p && arrow('←', -1, i === 0)}
                        <Button
                          variant={selected === p ? 'primary' : 'secondary'}
                          onClick={() => setSelected(selected === p ? null : p)}
                        >
                          {p}
                        </Button>
                        {selected === p && arrow('→', 1, i === prefixes.length - 1)}
                      </InlineStack>
                    ))}
                  </InlineStack>
                )}
                <InlineStack>
                  <Button variant="primary" onClick={handleSave} loading={saving} disabled={!dirty}>Save</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerLocationsSettings;
