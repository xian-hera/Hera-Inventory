// Online › Swatch › Rules (spec §3): a product is replaced when its type is
// in a rule AND it has an option with the rule's name. First rule wins.
import React, { useState } from 'react';
import { Card, BlockStack, InlineStack, Text, Button, TextField, Checkbox, Banner } from '@shopify/polaris';
import MultiSelectDropdown from '../../../components/MultiSelectDropdown';
import { api } from './swatchApi';

function SwatchRulesTab({ config, setConfig, meta, afterSave }) {
  const [rules, setRules] = useState(config.rules.map(r => ({ ...r })));
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  // translatedTypesText is only the text box's raw value — not saved, not compared.
  const clean = list => list.map(({ translatedTypesText, ...r }) => ({ ...r, translatedTypes: r.translatedTypes || [] }));
  const dirty = JSON.stringify(clean(rules)) !== JSON.stringify(clean(config.rules));

  const set = (i, patch) => setRules(list => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i, d) => setRules(list => {
    const n = [...list];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    return n;
  });

  const save = async () => {
    setErr('');
    setSaving(true);
    try {
      const d = await api.put('/config', { rules: clean(rules) });
      setConfig(d.config);
      setRules(d.config.rules.map(r => ({ ...r })));
      afterSave(d, 'Rules saved. Run a scan in the Color codes tab to refresh the list.');
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <BlockStack gap="400">
        <Text tone="subdued" variant="bodySm">
          The whole picker of a matching product is replaced: the option named here is shown as image swatches, the other options as buttons.
          If a product matches several rules, the first one decides which option gets images.
        </Text>
        {/* One row per rule, all on one line (Hera 2026-10-02): labels and boxes line up at the top;
            "Case sensitive" sits under the option name, the translation hint under Product types.
            No horizontal scrolling: boxes are narrow and the translated-types box shrinks to fit. */}
        {rules.map((r, i) => (
          <div key={i} style={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ paddingTop: 30, flex: 'none' }}><Text variant="bodySm" tone="subdued">{i + 1}.</Text></div>
            <div style={{ flex: 'none' }}>
              <BlockStack gap="100">
                {/* 72px = 40% of the old 180px; the label may run past the box */}
                <div style={{ width: 72, whiteSpace: 'nowrap' }}>
                  <TextField label="Option name" value={r.optionName} onChange={(v) => set(i, { optionName: v })} autoComplete="off" />
                </div>
                <Checkbox label="Case sensitive" checked={!!r.caseSensitive} onChange={(v) => set(i, { caseSensitive: v })} />
              </BlockStack>
            </div>
            {/* 144px = 60% of the old 240px; the selected types are cut off with "…" */}
            <div style={{ width: 144, flex: 'none' }}>
              <BlockStack gap="100">
                <MultiSelectDropdown label="Product types" options={meta.productTypes} selected={r.productTypes} onChange={(v) => set(i, { productTypes: v })} placeholder="Choose…" />
                <Text variant="bodySm" tone="subdued">Exactly as the other language shows the type (case sensitive)</Text>
              </BlockStack>
            </div>
            <div style={{ flex: '1 1 160px', minWidth: 0, maxWidth: 260 }}>
              {/* Free text: translated types are not in Shopify's type list (Hera 2026-10-02) */}
              <TextField label="Translated type names (comma separated)" placeholder="e.g. CHEVEUX, PERRUQUE" autoComplete="off"
                value={r.translatedTypesText !== undefined ? r.translatedTypesText : (r.translatedTypes || []).join(', ')}
                onChange={(v) => set(i, { translatedTypesText: v, translatedTypes: v.split(',').map(s => s.trim()).filter(Boolean) })} />
            </div>
            <div style={{ paddingTop: 24, flex: 'none' }}>
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <Button size="slim" onClick={() => move(i, -1)} disabled={i === 0}>↑</Button>
                <Button size="slim" onClick={() => move(i, 1)} disabled={i === rules.length - 1}>↓</Button>
                <Button size="slim" tone="critical" variant="plain" onClick={() => setRules(list => list.filter((_, j) => j !== i))}>Delete</Button>
              </InlineStack>
            </div>
          </div>
        ))}
        {rules.length === 0 && <Text tone="subdued">No rule — no product is replaced.</Text>}
        {err && <Banner tone="critical" onDismiss={() => setErr('')}>{err}</Banner>}
        <InlineStack gap="200">
          <Button onClick={() => setRules(list => [...list, { optionName: 'Color', caseSensitive: true, productTypes: [] }])}>Add rule</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save rules</Button>
          {dirty && <Button onClick={() => setRules(config.rules.map(r => ({ ...r })))}>Discard changes</Button>}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default SwatchRulesTab;
