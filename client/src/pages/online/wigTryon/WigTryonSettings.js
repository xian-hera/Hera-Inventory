// Online › Wig Try-on › Settings: switches, product types, OpenAI, limits, texts.
import React, { useState } from 'react';
import { Card, BlockStack, InlineStack, InlineGrid, Text, TextField, Checkbox, Select, Button, Banner } from '@shopify/polaris';
import { api, IMAGE_MODELS, CHECK_MODELS } from './wigTryonApi';

const TEXTS = [
  { key: 'limitReached', label: 'Daily limit reached (account and IP — same text on purpose)' },
  { key: 'busy', label: 'Daily total reached / service paused' },
  { key: 'loginRequired', label: 'Login required' },
  { key: 'failed', label: 'Generation failed' },
  { key: 'badPhoto', label: 'Photo not readable (wrong format / too large)' },
  { key: 'selfieExpired', label: 'Checked selfie expired (more than 10 minutes)' },
];

// Selfie check reasons the customer can see (same codes as the server).
const SELFIE_REASONS = [
  { key: 'no_person', label: 'No person' },
  { key: 'multiple_people', label: 'More than one person' },
  { key: 'face_not_visible', label: 'Face not visible / covered / turned away' },
  { key: 'head_cut_off', label: 'Head cut off' },
  { key: 'face_too_small', label: 'Face too small' },
  { key: 'blurry_or_dark', label: 'Blurry or too dark' },
  { key: 'not_a_real_photo', label: 'Not a real photo' },
  { key: 'inappropriate', label: 'Inappropriate' },
];

export const MODES = [
  { label: 'Off — icon never shown', value: 'off' },
  { label: 'Preview only — theme editor + theme preview links', value: 'preview' },
  { label: 'Live — real store', value: 'live' },
];

const MODELS = IMAGE_MODELS;

export default function WigTryonSettings({ config, defaults, reload, setBanner }) {
  const [f, setF] = useState(() => JSON.parse(JSON.stringify(config)));
  const [types, setTypes] = useState((config.eligibleTypes || []).join(', '));
  const [saving, setSaving] = useState(false);

  const set = (path, v) => setF(prev => {
    const next = JSON.parse(JSON.stringify(prev));
    let o = next;
    const parts = path.split('.');
    parts.slice(0, -1).forEach(k => { o = o[k]; });
    o[parts[parts.length - 1]] = v;
    return next;
  });

  const save = async () => {
    if (f.mode === 'live' && config.mode !== 'live' && !window.confirm('Turn AI Try-On on for the real store? (The "Hera Wig Try-on" app embed must also be switched on in the theme.)')) return;
    setSaving(true);
    try {
      const d = await api.put('/config', {
        ...f,
        eligibleTypes: types.split(',').map(s => s.trim()).filter(Boolean),
        activePromptVersion: config.activePromptVersion, // changed only from Prompt & Test
      });
      setBanner(d.synced === false
        ? { tone: 'warning', text: `Saved, but the storefront data could not be updated: ${d.syncError}` }
        : { tone: 'success', text: 'Settings saved.' });
      reload();
    } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
    setSaving(false);
  };

  const ipWarning = Number(f.limits.perIp) <= Number(f.limits.perCustomer);
  const modelOptions = [...new Set([...MODELS, f.openai.model])].map(m => ({ label: m, value: m }));

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text variant="headingMd">Switches</Text>
          <div style={{ maxWidth: 460 }}>
            <Select label="AI Try-On on the storefront" value={f.mode} onChange={v => set('mode', v)} options={MODES}
              helpText="Same as Swatch. Tests from this page work in every mode." />
          </div>
          <Checkbox label="Customers must be logged in" checked={f.requireLogin} onChange={v => set('requireLogin', v)}
            helpText="Turn off only for testing — without login only the IP and daily total limits apply." />
          <Checkbox label="Let customers choose a colour" checked={f.colorEnabled} onChange={v => set('colorEnabled', v)}
            helpText="Part of the customer flow. Uses the Swatch colour card of the product's vendor as the colour reference image." />
          <TextField label="Product types" value={types} onChange={setTypes} autoComplete="off"
            helpText="Comma-separated, not case-sensitive. The icon shows only on these product types. Add the French type names too if the French store translates them (e.g. WIG, PERRUQUE)." />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text variant="headingMd">Daily limits</Text>
          <InlineGrid columns={{ xs: 1, md: 4 }} gap="300">
            <TextField type="number" label="Per customer account" value={String(f.limits.perCustomer)} onChange={v => set('limits.perCustomer', v)} autoComplete="off" />
            <TextField type="number" label="Per IP address" value={String(f.limits.perIp)} onChange={v => set('limits.perIp', v)} autoComplete="off" />
            <TextField type="number" label="Whole store per day" value={String(f.limits.globalDaily)} onChange={v => set('limits.globalDaily', v)} autoComplete="off" />
            <TextField type="number" label="Alert at (% of daily total)" value={String(f.limits.alertPct)} onChange={v => set('limits.alertPct', v)} autoComplete="off" suffix="%"
              helpText="Adds an Urgent task to Online › Dashboard, once a day." />
          </InlineGrid>
          {ipWarning && <Banner tone="warning">Keep the IP limit higher than the account limit — homes, offices and schools share one IP.</Banner>}
          <Text tone="subdued" variant="bodySm">Days follow Montreal time. A generation that fails on our or OpenAI's side gives the use back.</Text>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text variant="headingMd">OpenAI</Text>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
            <Select label="Model (image generation)" options={modelOptions} value={f.openai.model} onChange={v => set('openai.model', v)}
              helpText="Compare models first with “Model (this test only)” on Prompt & Test." />
            <Select label="Image size" value={f.openai.size} onChange={v => set('openai.size', v)}
              options={[{ label: '1024 × 1536 (portrait)', value: '1024x1536' }, { label: '1024 × 1024', value: '1024x1024' }, { label: '1536 × 1024 (landscape)', value: '1536x1024' }, { label: 'auto', value: 'auto' }]} />
            <Select label="Quality" value={f.openai.quality} onChange={v => set('openai.quality', v)}
              options={['low', 'medium', 'high', 'xhigh', 'max', 'auto'].map(v => ({ label: v === 'xhigh' || v === 'max' ? `${v} (gpt-image-2.5 only)` : v, value: v }))} />
            <Select label="Output format" value={f.openai.outputFormat} onChange={v => set('openai.outputFormat', v)}
              options={[{ label: 'JPEG (smaller)', value: 'jpeg' }, { label: 'PNG', value: 'png' }, { label: 'WebP', value: 'webp' }]} />
            <Select label="Input fidelity" value={f.openai.inputFidelity} onChange={v => set('openai.inputFidelity', v)}
              options={[{ label: 'Not sent (required for gpt-image-2)', value: '' }, { label: 'high (gpt-image-1.5)', value: 'high' }, { label: 'low', value: 'low' }]} />
            <TextField type="number" label="Timeout (seconds)" value={String(f.openai.timeoutSec)} onChange={v => set('openai.timeoutSec', v)} autoComplete="off" />
            <TextField type="number" label="Retries" value={String(f.openai.retries)} onChange={v => set('openai.retries', v)} autoComplete="off" helpText="On timeout / rate limit / OpenAI server error." />
            <TextField type="number" label="Max generations at the same time" value={String(f.openai.maxConcurrent)} onChange={v => set('openai.maxConcurrent', v)} autoComplete="off" />
          </InlineGrid>
          <Text fontWeight="semibold">Prices for the cost estimate (US$ per 1M tokens)</Text>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
            <TextField type="number" label="Image input" value={f.pricing.inputImagePerM == null ? '' : String(f.pricing.inputImagePerM)} onChange={v => set('pricing.inputImagePerM', v)} autoComplete="off" />
            <TextField type="number" label="Image output" value={f.pricing.outputImagePerM == null ? '' : String(f.pricing.outputImagePerM)} onChange={v => set('pricing.outputImagePerM', v)} autoComplete="off" />
            <TextField type="number" label="Text input (not used yet)" value={f.pricing.inputTextPerM == null ? '' : String(f.pricing.inputTextPerM)} onChange={v => set('pricing.inputTextPerM', v)} autoComplete="off" />
          </InlineGrid>
          <Text tone="subdued" variant="bodySm">Copy these from OpenAI's pricing page for the selected model. Leave empty to show tokens only.</Text>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text variant="headingMd">Selfie check</Text>
          <Text tone="subdued" variant="bodySm">After the customer uploads a selfie, an OpenAI vision model checks it before any try-on is used. A rejected selfie does not use a try-on; the customer sees the message for the reason below and can upload another one. The product photo is not checked (always the product's first image).</Text>
          <Checkbox label="Check selfies before generating" checked={f.selfieCheck.enabled} onChange={v => set('selfieCheck.enabled', v)} />
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
            {(() => {
              const listed = CHECK_MODELS.some(m => m.value === f.selfieCheck.model);
              return (
                <BlockStack gap="200">
                  <Select label="Model (selfie check)" value={listed ? f.selfieCheck.model : '__other'}
                    onChange={v => set('selfieCheck.model', v === '__other' ? '' : v)}
                    options={[...CHECK_MODELS, { value: '__other', label: 'Other (type the name)…' }]}
                    helpText="A small vision model. Compare on Prompt & Test with “Check model (this test only)”." />
                  {!listed && <TextField label="Model name" labelHidden placeholder="e.g. gpt-6-luna" value={f.selfieCheck.model} onChange={v => set('selfieCheck.model', v)} autoComplete="off" />}
                </BlockStack>
              );
            })()}
            <Select label="Reasoning effort" value={f.selfieCheck.reasoningEffort} onChange={v => set('selfieCheck.reasoningEffort', v)}
              options={[{ label: 'Not sent', value: '' }, ...['none', 'minimal', 'low', 'medium', 'high'].map(v => ({ label: v, value: v }))]}
              helpText="Some models reject some values — use Check selfie only on Prompt & Test after changing." />
            <Select label="Image detail" value={f.selfieCheck.detail} onChange={v => set('selfieCheck.detail', v)}
              options={['auto', 'low', 'high'].map(v => ({ label: v, value: v }))} />
            <TextField type="number" label="Timeout (seconds)" value={String(f.selfieCheck.timeoutSec)} onChange={v => set('selfieCheck.timeoutSec', v)} autoComplete="off" />
            <TextField type="number" label="Max checks per customer per day" value={String(f.selfieCheck.maxPerDay)} onChange={v => set('selfieCheck.maxPerDay', v)} autoComplete="off"
              helpText="Per IP when not logged in. Cost guard only." />
          </InlineGrid>
          <Checkbox label="If the check itself fails (OpenAI error / timeout), let the customer continue" checked={f.selfieCheck.failOpen} onChange={v => set('selfieCheck.failOpen', v)} />
          <TextField label="Check instructions" multiline={10} monospaced value={f.selfieCheck.prompt} onChange={v => set('selfieCheck.prompt', v)} autoComplete="off"
            helpText="The model answers suitable yes / no plus one reason code from the list below (fixed — the answer format is enforced by the server)." />
          {defaults && f.selfieCheck.prompt !== defaults.checkPrompt && (
            <InlineStack><Button variant="plain" onClick={() => set('selfieCheck.prompt', defaults.checkPrompt)}>Reset instructions to default</Button></InlineStack>
          )}
          <Text fontWeight="semibold">Message shown for each reason</Text>
          {SELFIE_REASONS.map(t => (
            <InlineGrid key={t.key} columns={{ xs: 1, md: 2 }} gap="300">
              <TextField label={`${t.label} — EN`} value={f.selfieText[t.key].en} onChange={v => set(`selfieText.${t.key}.en`, v)} autoComplete="off" />
              <TextField label="FR" value={f.selfieText[t.key].fr} onChange={v => set(`selfieText.${t.key}.fr`, v)} autoComplete="off" />
            </InlineGrid>
          ))}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text variant="headingMd">Customer messages</Text>
          {TEXTS.map(t => (
            <InlineGrid key={t.key} columns={{ xs: 1, md: 2 }} gap="300">
              <TextField label={`${t.label} — EN`} value={f.text[t.key].en} onChange={v => set(`text.${t.key}.en`, v)} autoComplete="off" />
              <TextField label="FR" value={f.text[t.key].fr} onChange={v => set(`text.${t.key}.fr`, v)} autoComplete="off" />
            </InlineGrid>
          ))}
          <Text tone="subdued" variant="bodySm">Button and window texts (and the privacy consent wording) come with the storefront UI later.</Text>
        </BlockStack>
      </Card>

      <InlineStack align="end"><Button variant="primary" onClick={save} loading={saving}>Save settings</Button></InlineStack>
    </BlockStack>
  );
}
