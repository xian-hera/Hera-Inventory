// Online › Swatch › Style & Text (spec §7). Defaults = the reference app.
import React, { useState } from 'react';
import { Card, BlockStack, InlineStack, Text, Button, TextField, Select, Banner } from '@shopify/polaris';
import { api } from './swatchApi';

const clone = (c) => JSON.parse(JSON.stringify({
  style: c.style, text: c.text, icons: c.icons, suggestIgnore: c.suggestIgnore, selector: c.selector, hideSelectors: c.hideSelectors,
}));

function Color({ label, value, onChange }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000';
  return (
    <InlineStack gap="200" blockAlign="end">
      <div style={{ width: 170 }}><TextField label={label} value={value} onChange={onChange} autoComplete="off" /></div>
      <input type="color" value={hex} onChange={(e) => onChange(e.target.value.toUpperCase())} style={{ width: 36, height: 32, border: 'none', background: 'none' }} />
    </InlineStack>
  );
}

// Rough storefront preview of one card (normal / selected / sold out).
function CardPreview({ s, kind, magnifier, soldOut }) {
  const selected = kind === 'selected';
  return (
    <div style={{ width: Number(s.cardWidth) || 72, border: `${selected ? 1 : 0.5}px solid ${selected ? s.accentColor : '#EFEFEF'}`, borderRadius: 5, background: '#fff', paddingBottom: 5, position: 'relative' }}>
      <div style={{ height: Number(s.imageHeight) || 81, background: 'linear-gradient(135deg,#6b4b3a,#c9a27e)', borderRadius: '5px 5px 0 0', position: 'relative', overflow: 'hidden' }}>
        {kind === 'soldout' && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 16, background: s.soldOutBg, color: s.soldOutColor, fontSize: 10, fontWeight: 600, textAlign: 'center', lineHeight: '16px' }}>{soldOut || 'SOLD OUT'}</div>}
        {selected && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {magnifier
              // eslint-disable-next-line react/no-danger
              ? <span style={{ width: 22, height: 22, display: 'block' }} dangerouslySetInnerHTML={{ __html: magnifier }} />
              : <span style={{ color: '#fff' }}>🔍</span>}
          </div>
        )}
      </div>
      <div style={{ fontSize: 10, fontWeight: 600, color: selected ? '#292929' : '#6A6A6A', padding: '3px 4px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>#1B</div>
      {kind === 'soldout' && <div style={{ position: 'absolute', inset: 0, background: s.overlayColor, opacity: s.overlayOpacity, borderRadius: 5, pointerEvents: 'none' }} />}
    </div>
  );
}

function SwatchStyleTab({ config, setConfig, meta, afterSave }) {
  const [v, setV] = useState(clone(config));
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(clone(config));
  const st = (k, val) => setV(x => ({ ...x, style: { ...x.style, [k]: val } }));
  const tx = (k, lang, val) => setV(x => ({ ...x, text: { ...x.text, [k]: { ...x.text[k], [lang]: val } } }));

  const save = async () => {
    setErr('');
    setSaving(true);
    try {
      const body = {
        ...v,
        style: { ...v.style, cardWidth: Number(v.style.cardWidth), imageHeight: Number(v.style.imageHeight), overlayOpacity: Number(v.style.overlayOpacity) },
        suggestIgnore: { ...v.suggestIgnore, minTotal: Number(v.suggestIgnore.minTotal) },
        hideSelectors: (Array.isArray(v.hideSelectors) ? v.hideSelectors : String(v.hideSelectors).split(',')).map(s => s.trim()).filter(Boolean),
      };
      const d = await api.put('/config', body);
      setConfig(d.config);
      setV(clone(d.config));
      afterSave(d, 'Style & text saved.');
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const svgOk = !v.icons.magnifier || /^<svg[\s>]/i.test(v.icons.magnifier.trim());

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">Swatch card</Text>
          <InlineStack gap="400" wrap blockAlign="end">
            <div style={{ width: 120 }}><TextField label="Card width (px)" type="number" value={String(v.style.cardWidth)} onChange={(x) => st('cardWidth', x)} autoComplete="off" /></div>
            <div style={{ width: 140 }}><TextField label="Image height (px)" type="number" value={String(v.style.imageHeight)} onChange={(x) => st('imageHeight', x)} autoComplete="off" /></div>
            <div style={{ width: 170 }}>
              <Select label="Default crop" options={[{ label: 'Top', value: 'center top' }, { label: 'Center', value: 'center center' }, { label: 'Bottom', value: 'center bottom' }]}
                value={v.style.imagePosition} onChange={(x) => st('imagePosition', x)} />
            </div>
            <Color label="Selected / hover border" value={v.style.accentColor} onChange={(x) => st('accentColor', x)} />
            <Color label="Selected button background" value={v.style.buttonSelectedBg} onChange={(x) => st('buttonSelectedBg', x)} />
          </InlineStack>
          <Text variant="headingSm" as="h3">Sold out</Text>
          <InlineStack gap="400" wrap blockAlign="end">
            <div style={{ width: 160 }}><TextField label="Label (English)" value={v.text.soldOut.en} onChange={(x) => tx('soldOut', 'en', x)} autoComplete="off" /></div>
            <div style={{ width: 160 }}><TextField label="Label (French)" value={v.text.soldOut.fr} onChange={(x) => tx('soldOut', 'fr', x)} autoComplete="off" placeholder="e.g. ÉPUISÉ" /></div>
            <div style={{ width: 200 }}><TextField label="Label background" value={v.style.soldOutBg} onChange={(x) => st('soldOutBg', x)} autoComplete="off" /></div>
            <Color label="Label text" value={v.style.soldOutColor} onChange={(x) => st('soldOutColor', x)} />
            <Color label="Card overlay colour" value={v.style.overlayColor} onChange={(x) => st('overlayColor', x)} />
            <div style={{ width: 120 }}><TextField label="Overlay opacity" type="number" step={0.05} min={0} max={1} value={String(v.style.overlayOpacity)} onChange={(x) => st('overlayOpacity', x)} autoComplete="off" /></div>
          </InlineStack>
          <Text variant="headingSm" as="h3">Preview</Text>
          <InlineStack gap="300">
            <CardPreview s={v.style} kind="normal" />
            <CardPreview s={v.style} kind="selected" magnifier={svgOk ? v.icons.magnifier : ''} />
            <CardPreview s={v.style} kind="soldout" soldOut={v.text.soldOut.en} />
          </InlineStack>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">Large image window (modal)</Text>
          <InlineStack gap="400" wrap>
            <div style={{ minWidth: 320, flex: 1 }}><TextField label="Small text under the image (English)" value={v.text.modalNote.en} onChange={(x) => tx('modalNote', 'en', x)} multiline={2} autoComplete="off" /></div>
            <div style={{ minWidth: 320, flex: 1 }}><TextField label="Small text under the image (French)" value={v.text.modalNote.fr} onChange={(x) => tx('modalNote', 'fr', x)} multiline={2} autoComplete="off" /></div>
          </InlineStack>
          <TextField label="Magnifier icon (SVG code)" value={v.icons.magnifier} onChange={(x) => setV(o => ({ ...o, icons: { ...o.icons, magnifier: x } }))}
            multiline={3} autoComplete="off" error={svgOk ? undefined : 'Must start with <svg'} />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">Advanced</Text>
          <InlineStack gap="400" wrap blockAlign="end">
            <div style={{ width: 160 }}>
              <Select label="Suggested Ignore: location" options={meta.locations.map(l => ({ label: l, value: l }))} value={v.suggestIgnore.locationName}
                onChange={(x) => setV(o => ({ ...o, suggestIgnore: { ...o.suggestIgnore, locationName: x } }))} />
            </div>
            <div style={{ width: 200 }}>
              <TextField label="Suggested Ignore: total below" type="number" value={String(v.suggestIgnore.minTotal)} autoComplete="off"
                onChange={(x) => setV(o => ({ ...o, suggestIgnore: { ...o.suggestIgnore, minTotal: x } }))} />
            </div>
            <div style={{ width: 280 }}>
              <TextField label="Theme picker to replace (CSS selector)" value={v.selector} onChange={(x) => setV(o => ({ ...o, selector: x }))} autoComplete="off" />
            </div>
            <div style={{ width: 280 }}>
              <TextField label="Other pickers to hide (comma separated)" value={Array.isArray(v.hideSelectors) ? v.hideSelectors.join(', ') : v.hideSelectors}
                onChange={(x) => setV(o => ({ ...o, hideSelectors: x }))} autoComplete="off" />
            </div>
          </InlineStack>
          <Text tone="subdued" variant="bodySm">Suggested Ignore = every SKU of the colour is discontinued, has no stock at this location, and the total stock is below this number.</Text>
        </BlockStack>
      </Card>

      {err && <Banner tone="critical" onDismiss={() => setErr('')}>{err}</Banner>}
      <InlineStack gap="200">
        <Button variant="primary" onClick={save} loading={saving} disabled={!dirty || !svgOk}>Save</Button>
        {dirty && <Button onClick={() => setV(clone(config))}>Discard changes</Button>}
      </InlineStack>
    </BlockStack>
  );
}

export default SwatchStyleTab;
