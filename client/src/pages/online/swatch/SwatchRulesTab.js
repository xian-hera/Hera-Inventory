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
  const dirty = JSON.stringify(rules) !== JSON.stringify(config.rules);

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
      const d = await api.put('/config', { rules });
      setConfig(d.config);
      setRules(d.config.rules.map(r => ({ ...r })));
      afterSave(d, 'Rules saved. Run a scan in the Colour codes tab to refresh the list.');
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
        {rules.map((r, i) => (
          <InlineStack key={i} gap="300" blockAlign="end" wrap>
            <Text variant="bodySm" tone="subdued">{i + 1}.</Text>
            <div style={{ width: 180 }}>
              <TextField label="Option name" value={r.optionName} onChange={(v) => set(i, { optionName: v })} autoComplete="off" />
            </div>
            <Checkbox label="Case sensitive" checked={!!r.caseSensitive} onChange={(v) => set(i, { caseSensitive: v })} />
            <div style={{ minWidth: 240 }}>
              <MultiSelectDropdown label="Product types" options={meta.productTypes} selected={r.productTypes} onChange={(v) => set(i, { productTypes: v })} placeholder="Choose…" />
            </div>
            <Button size="slim" onClick={() => move(i, -1)} disabled={i === 0}>↑</Button>
            <Button size="slim" onClick={() => move(i, 1)} disabled={i === rules.length - 1}>↓</Button>
            <Button size="slim" tone="critical" variant="plain" onClick={() => setRules(list => list.filter((_, j) => j !== i))}>Delete</Button>
          </InlineStack>
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
