// Online › Swatch (2026-10-01, Hera). Spec: claude/SWATCH_FEATURE_SPEC.md §2.2, §9.
// Top: master switch (Off / Preview only / Live). Tabs: Colour codes ·
// Images · Libraries · Rules · Style & Text.
import React, { useState, useEffect, useCallback } from 'react';
import { Page, Card, BlockStack, InlineStack, Text, Tabs, Banner, Select, Button, Spinner, Badge } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { api, fmtTime } from './swatchApi';
import SwatchCodesTab from './SwatchCodesTab';
import SwatchImagesTab from './SwatchImagesTab';
import SwatchLibrariesTab from './SwatchLibrariesTab';
import SwatchRulesTab from './SwatchRulesTab';
import SwatchStyleTab from './SwatchStyleTab';

const MODES = [
  { label: 'Off — storefront unchanged', value: 'off' },
  { label: 'Preview only — theme preview links + theme editor', value: 'preview' },
  { label: 'Live — replace on the real store', value: 'live' },
];
const MODE_BADGE = { off: <Badge>Off</Badge>, preview: <Badge tone="attention">Preview only</Badge>, live: <Badge tone="success">Live</Badge> };

const TABS = [
  { id: 'codes', content: 'Colour codes' },
  { id: 'images', content: 'Images' },
  { id: 'libraries', content: 'Libraries' },
  { id: 'rules', content: 'Rules' },
  { id: 'style', content: 'Style & Text' },
];

function OnlineSwatch() {
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [config, setConfig] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [meta, setMeta] = useState({ vendors: [], productTypes: [], locations: [] });
  const [libraries, setLibraries] = useState([]);
  const [banner, setBanner] = useState(null);
  const [savingMode, setSavingMode] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const loadConfig = useCallback(async () => {
    const d = await api.get('/config');
    setConfig(d.config);
    setLastSync(d.lastSync);
  }, []);
  const loadLibraries = useCallback(async () => {
    const d = await api.get('/libraries');
    setLibraries(d.libraries);
  }, []);

  useEffect(() => {
    loadConfig().catch(e => setBanner({ tone: 'critical', text: e.message }));
    loadLibraries().catch(e => setBanner({ tone: 'critical', text: e.message }));
    api.get('/meta').then(setMeta).catch(e => setBanner({ tone: 'critical', text: `Could not load vendors / types: ${e.message}` }));
  }, [loadConfig, loadLibraries]);

  // Every save returns {synced, syncError} — show sync problems in one place.
  const afterSave = useCallback((d, okText) => {
    if (d && d.synced === false) setBanner({ tone: 'warning', text: `Saved, but the storefront data could not be updated: ${d.syncError}` });
    else if (okText) setBanner({ tone: 'success', text: okText });
    if (d && d.syncedAt) setLastSync({ syncedAt: d.syncedAt, sizes: d.sizes });
  }, []);

  const changeMode = async (mode) => {
    if (mode === 'live' && !window.confirm('Turn Hera Swatch on for the real store? The colour pickers of every product that matches a rule will be replaced (only on themes where the Hera Swatch app embed is switched on).')) return;
    setSavingMode(true);
    try {
      const d = await api.put('/config', { mode });
      setConfig(d.config);
      afterSave(d, `Hera Swatch is now: ${MODES.find(m => m.value === mode).label}`);
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setSavingMode(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const d = await api.post('/sync');
      afterSave({ synced: true, ...d }, 'Storefront data updated.');
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setSyncing(false);
    }
  };

  if (!config) {
    return <Page title="Swatch" backAction={{ onAction: () => navigate('/online') }}><Spinner /></Page>;
  }

  const refreshMeta = async () => {
    try {
      setMeta(await api.post('/meta/refresh'));
      setBanner({ tone: 'success', text: 'Vendor and product type lists refreshed from Shopify.' });
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    }
  };

  const shared = { config, setConfig, meta, refreshMeta, libraries, loadLibraries, setBanner, afterSave };

  return (
    // Normal page width like the rest of the Hub; only the Colour codes table
    // is pulled to full width (FullBleed), same as Import Products / New products.
    <Page title="Swatch" titleMetadata={MODE_BADGE[config.mode]} backAction={{ onAction: () => navigate('/online') }}>
      <BlockStack gap="400">
        {banner && <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>}
        <Card>
          <InlineStack gap="600" blockAlign="end" wrap>
            <div style={{ minWidth: 380 }}>
              <Select label="Hera Swatch on the storefront" options={MODES} value={config.mode}
                onChange={changeMode} disabled={savingMode} />
            </div>
            <BlockStack gap="100">
              <Text tone="subdued" variant="bodySm">
                Storefront data last updated: {fmtTime(lastSync && lastSync.syncedAt)}
                {lastSync && lastSync.sizes ? ` · ${Object.entries(lastSync.sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(1)}KB`).join(', ')}` : ''}
              </Text>
              <Text tone="subdued" variant="bodySm">
                The Hera Swatch app embed must also be switched on in the theme (Customize → App embeds).
              </Text>
            </BlockStack>
            <Button onClick={syncNow} loading={syncing}>Update storefront data now</Button>
          </InlineStack>
        </Card>
        <Tabs tabs={TABS} selected={tab} onSelect={setTab} />
        <div>
          {TABS[tab].id === 'codes' && <SwatchCodesTab {...shared} />}
          {TABS[tab].id === 'images' && <SwatchImagesTab {...shared} />}
          {TABS[tab].id === 'libraries' && <SwatchLibrariesTab {...shared} />}
          {TABS[tab].id === 'rules' && <SwatchRulesTab {...shared} />}
          {TABS[tab].id === 'style' && <SwatchStyleTab {...shared} />}
        </div>
      </BlockStack>
    </Page>
  );
}

export default OnlineSwatch;
