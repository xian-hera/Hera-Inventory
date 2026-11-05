// Online › Wig Try-on › Storefront (2026-11-05): the icon on the product photo,
// where it sits, and every text of the try-on window (EN / FR).
// Saved to the Hub and written to the app metafield hera_tryon.config, which
// the "Hera Wig Try-on" app embed reads.
import React, { useState } from 'react';
import { Card, BlockStack, InlineStack, InlineGrid, Text, TextField, Button, Modal, Banner } from '@shopify/polaris';
import { api, fmtTime } from './wigTryonApi';

// Same picture as the built-in icon in shopify-app/extensions/hera-swatch/assets/hera-tryon.js.
export const DEFAULT_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="18" fill="#FFBCC7"/>'
  + '<path d="M22 14l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#1d1d1d"/>'
  + '<path d="M66 16h8a6 6 0 0 1 6 6v8M30 80h-8a6 6 0 0 1-6-6v-8" fill="none" stroke="#1d1d1d" stroke-width="4" stroke-linecap="round"/>'
  + '<path d="M47 18c-14 0-22 10-21 25 0 9-3 15-6 21 6 3 13 3 18-1-2 6-1 11 3 14 4-6 6-13 5-20" fill="#1d1d1d"/>'
  + '<path d="M47 18c13 0 20 10 19 23 0 7 2 12 5 16-4 2-9 2-12-1" fill="#1d1d1d"/>'
  + '<ellipse cx="46" cy="42" rx="11" ry="14" fill="#FFBCC7"/>'
  + '<rect x="54" y="60" width="30" height="22" rx="4" fill="#1d1d1d"/><rect x="62" y="56" width="10" height="6" rx="2" fill="#1d1d1d"/>'
  + '<circle cx="69" cy="71" r="6" fill="none" stroke="#FFBCC7" stroke-width="3"/></svg>');

const TEXTS = [
  { group: 'Window header', items: [
    { key: 'titleLabel', label: 'Small label above the wig name (“Wig AI try on”)' },
    { key: 'leftLabel', label: 'Small label above the number (“Try-ons left today”)' },
    { key: 'iconLabel', label: 'Icon name for screen readers / tooltip' },
  ] },
  { group: 'First-visit tip', items: [
    { key: 'tipText', label: 'Shown once per customer browser next to the icon, page dimmed (empty = no tip)', multiline: 2 },
  ] },
  { group: 'Choose colour & selfie', items: [
    { key: 'chooseColor', label: 'Choose colour title' },
    { key: 'uploadSelfie', label: 'Upload selfie title' },
    { key: 'consentBefore', label: 'Consent — text before the link' },
    { key: 'consentLink', label: 'Consent — link text' },
    { key: 'consentAfter', label: 'Consent — text after the link' },
    { key: 'requirements', label: 'Selfie requirements (next to the upload box)', multiline: 3 },
    { key: 'description', label: 'Description (below the upload box)', multiline: 3 },
    { key: 'changePhoto', label: 'Link: change photo (shown once a selfie is kept)' },
    { key: 'removePhoto', label: 'Link: remove photo' },
    { key: 'btnChooseColor', label: 'Button before a colour is chosen (disabled)' },
    { key: 'btnUploadSelfie', label: 'Button before the selfie passed the check (disabled)' },
    { key: 'tryButton', label: 'Button when ready' },
  ] },
  { group: 'Messages while choosing', items: [
    { key: 'checking', label: 'While the selfie is checked' },
    { key: 'selfieOk', label: 'Selfie passed the check' },
    { key: 'consentFirst', label: 'Upload / button pressed before accepting the policy' },
    { key: 'chooseColorFirst', label: 'Button pressed without a colour' },
    { key: 'uploadFirst', label: 'Button pressed without a selfie' },
  ] },
  { group: 'Loading & result', items: [
    { key: 'loading', label: 'Loading screen (new line = line break)', multiline: 2 },
    { key: 'savePhoto', label: 'Save button' },
    { key: 'tryAnother', label: 'Try another button' },
  ] },
];

function IconPicker({ open, onClose, onPick }) {
  const [q, setQ] = useState('');
  const [files, setFiles] = useState(null);
  const [error, setError] = useState('');
  const search = async () => {
    setError('');
    try { setFiles((await api.get(`/files?q=${encodeURIComponent(q)}`)).files); } catch (e) { setError(e.message); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Choose the icon from Shopify Files" secondaryActions={[{ content: 'Cancel', onAction: onClose }]}>
      <Modal.Section>
        <BlockStack gap="300">
          <Text tone="subdued" variant="bodySm">Upload the icon in Shopify admin › Content › Files first (square PNG or SVG works best), then search for it here.</Text>
          <TextField label="File name" labelHidden placeholder="Search by file name" value={q} onChange={setQ} autoComplete="off"
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }} connectedRight={<Button onClick={search}>Search</Button>} />
          {error && <Banner tone="critical">{error}</Banner>}
          {files && (files.length ? (
            <InlineStack gap="300" wrap>
              {files.map(f => (
                <button key={f.id} type="button" onClick={() => onPick(f)} title={f.filename}
                  style={{ width: 96, padding: 6, border: '1px solid #e1e3e5', borderRadius: 8, background: '#fff', cursor: 'pointer', textAlign: 'center' }}>
                  <img src={f.url} alt="" style={{ width: 64, height: 64, objectFit: 'contain', display: 'block', margin: '0 auto 4px' }} />
                  <span style={{ fontSize: 11, wordBreak: 'break-all' }}>{f.filename}</span>
                </button>
              ))}
            </InlineStack>
          ) : <Text tone="subdued">No images found.</Text>)}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default function WigTryonStorefront({ config, reload, setBanner, lastSync }) {
  const [sf, setSf] = useState(() => ({ ...config.storefront }));
  const [ui, setUi] = useState(() => JSON.parse(JSON.stringify(config.ui)));
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const setText = (key, lang, v) => setUi(prev => ({ ...prev, [key]: { ...prev[key], [lang]: v } }));
  const iconSrc = sf.iconFile ? sf.iconFile.url : DEFAULT_ICON;

  const save = async () => {
    setSaving(true);
    try {
      const d = await api.put('/config', {
        storefront: { ...sf, iconSize: Number(sf.iconSize), iconOffset: Number(sf.iconOffset) },
        ui,
        activePromptVersion: config.activePromptVersion,
      });
      setBanner(d.synced === false
        ? { tone: 'warning', text: `Saved, but the storefront data could not be updated: ${d.syncError}` }
        : { tone: 'success', text: 'Saved. The storefront shows the change on the next page load.' });
      reload();
    } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
    setSaving(false);
  };
  const syncNow = async () => {
    setSyncing(true);
    try { await api.post('/sync'); setBanner({ tone: 'success', text: 'Storefront data updated.' }); reload(); } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
    setSyncing(false);
  };

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text variant="headingMd">Icon on the product photo</Text>
            <InlineStack gap="200" blockAlign="center">
              <Text tone="subdued" variant="bodySm">Storefront data last updated: {fmtTime(lastSync && lastSync.syncedAt)}</Text>
              <Button size="slim" onClick={syncNow} loading={syncing}>Update now</Button>
            </InlineStack>
          </InlineStack>
          <InlineStack gap="600" blockAlign="start" wrap>
            {/* Preview: icon on a grey "photo" at the real size / offset */}
            <div style={{ position: 'relative', width: 220, height: 220, borderRadius: 12, background: '#ececec', flex: 'none' }}>
              <img src={iconSrc} alt="" style={{ position: 'absolute', top: Number(sf.iconOffset) || 0, left: Number(sf.iconOffset) || 0, width: Number(sf.iconSize) || 48, height: Number(sf.iconSize) || 48 }} />
              <span style={{ position: 'absolute', bottom: 8, right: 10, fontSize: 11, color: '#8a8a8a' }}>product photo</span>
            </div>
            <BlockStack gap="300">
              <Text>{sf.iconFile ? `Shopify file: ${sf.iconFile.filename}` : 'Built-in icon'}</Text>
              <InlineStack gap="200">
                <Button onClick={() => setPicking(true)}>{sf.iconFile ? 'Replace icon' : 'Choose from Shopify Files'}</Button>
                {sf.iconFile && <Button variant="plain" onClick={() => setSf({ ...sf, iconFile: null })}>Use built-in icon</Button>}
              </InlineStack>
              <InlineGrid columns={2} gap="300">
                <TextField type="number" label="Size (px)" value={String(sf.iconSize)} onChange={v => setSf({ ...sf, iconSize: v })} autoComplete="off" />
                <TextField type="number" label="Distance from corner (px)" value={String(sf.iconOffset)} onChange={v => setSf({ ...sf, iconOffset: v })} autoComplete="off" />
              </InlineGrid>
              <Text tone="subdued" variant="bodySm">The same icon is shown in the window while the photo is being made.</Text>
            </BlockStack>
          </InlineStack>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text variant="headingMd">Links & placement</Text>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
            <TextField label="Privacy Policy link" value={sf.privacyUrl} onChange={v => setSf({ ...sf, privacyUrl: v })} autoComplete="off"
              helpText="A store path (/policies/privacy-policy) or a full https:// address." />
            <TextField label="App proxy path" value={sf.proxyPath} onChange={v => setSf({ ...sf, proxyPath: v })} autoComplete="off"
              helpText="Must match Shopify admin › Apps › Hera Hub › App proxy (default /apps/hera-tryon)." />
          </InlineGrid>
          <TextField label="Product photo container (CSS selector, advanced)" value={sf.gallerySelector} onChange={v => setSf({ ...sf, gallerySelector: v })} autoComplete="off" monospaced
            helpText="Where the icon is placed. Change only if the theme changes." />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <Text variant="headingMd">Window texts</Text>
          {TEXTS.map(g => (
            <BlockStack key={g.group} gap="200">
              <Text fontWeight="semibold">{g.group}</Text>
              {g.items.map(t => (
                <InlineGrid key={t.key} columns={{ xs: 1, md: 2 }} gap="300">
                  <TextField label={`${t.label} — EN`} value={ui[t.key].en} onChange={v => setText(t.key, 'en', v)} autoComplete="off" multiline={t.multiline} />
                  <TextField label="FR" value={ui[t.key].fr} onChange={v => setText(t.key, 'fr', v)} autoComplete="off" multiline={t.multiline} placeholder="Empty = English" />
                </InlineGrid>
              ))}
            </BlockStack>
          ))}
          <Text tone="subdued" variant="bodySm">Messages for limits, rejected selfies and failures are in Settings.</Text>
        </BlockStack>
      </Card>

      <InlineStack align="end"><Button variant="primary" onClick={save} loading={saving}>Save storefront</Button></InlineStack>

      <IconPicker open={picking} onClose={() => setPicking(false)}
        onPick={(f) => { setSf({ ...sf, iconFile: { filename: f.filename, url: f.url } }); setPicking(false); }} />
    </BlockStack>
  );
}
