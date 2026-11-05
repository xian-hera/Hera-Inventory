// Online › Wig Try-on (2026-11-04, Hera). Spec: claude/WIG_TRYON_FEATURE_SPEC.md.
// Tabs: Overview · Prompt & Test · Usage log · Settings.
import React, { useState, useEffect, useCallback } from 'react';
import { Page, Card, BlockStack, InlineStack, Text, Tabs, Banner, Badge } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { api } from './wigTryonApi';
import WigTryonOverview from './WigTryonOverview';
import WigTryonPrompt from './WigTryonPrompt';
import WigTryonLog from './WigTryonLog';
import WigTryonSettings from './WigTryonSettings';
import WigTryonStorefront from './WigTryonStorefront';

const TABS = [
  { id: 'overview', content: 'Overview' },
  { id: 'prompt', content: 'Prompt & Test' },
  { id: 'log', content: 'Usage log' },
  { id: 'storefront', content: 'Storefront' },
  { id: 'settings', content: 'Settings' },
];

// inTabs: shown as a tab of Online (OnlineHome) — no title or back arrow of its own.
function OnlineWigTryon({ inTabs = false } = {}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [data, setData] = useState(null); // { config, activePromptVersion, today, hasApiKey, queue }
  const [banner, setBanner] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.get('/config')); } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pageProps = { title: inTabs ? undefined : 'Wig Try-on', backAction: inTabs ? undefined : { onAction: () => navigate('/online') } };
  if (!data) {
    return <Page {...pageProps}>{banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : <Text tone="subdued">Loading...</Text>}</Page>;
  }
  const { config, today } = data;
  const shared = { config, defaults: data.defaults, reload: load, setBanner, activePromptVersion: data.activePromptVersion };

  return (
    <Page {...pageProps}>
      <BlockStack gap="400">
        {banner && <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Banner>}
        {!data.hasApiKey && (
          <Banner tone="warning">OPENAI_API_KEY is not set on the server (Render → Environment). Generation will fail until it is added.</Banner>
        )}
        <Card>
          <InlineStack gap="600" blockAlign="center" wrap>
            <InlineStack gap="200" blockAlign="center">
              <Text fontWeight="semibold">Storefront</Text>
              {config.mode === 'live' ? <Badge tone="success">Live</Badge> : config.mode === 'preview' ? <Badge tone="attention">Preview only</Badge> : <Badge>Off</Badge>}
            </InlineStack>
            <Text tone="subdued">Today: {today.count} / {config.limits.globalDaily} try-ons</Text>
            <Text tone="subdued">Prompt in use: v{data.activePromptVersion}{config.activePromptVersion ? '' : ' (latest)'}</Text>
            <Text tone="subdued">Model: {config.openai.model}</Text>
            {config.colorEnabled ? <Badge tone="info">Colour choice on</Badge> : <Badge>Colour choice off</Badge>}
            {config.selfieCheck.enabled ? <Badge tone="info">Selfie check on</Badge> : <Badge tone="attention">Selfie check off</Badge>}
          </InlineStack>
        </Card>
        <Tabs tabs={TABS} selected={tab} onSelect={setTab} />
        <div>
          {TABS[tab].id === 'overview' && <WigTryonOverview {...shared} />}
          {TABS[tab].id === 'prompt' && <WigTryonPrompt {...shared} />}
          {TABS[tab].id === 'log' && <WigTryonLog {...shared} />}
          {TABS[tab].id === 'storefront' && <WigTryonStorefront {...shared} lastSync={data.lastSync} />}
          {TABS[tab].id === 'settings' && <WigTryonSettings {...shared} />}
        </div>
      </BlockStack>
    </Page>
  );
}

export default OnlineWigTryon;
