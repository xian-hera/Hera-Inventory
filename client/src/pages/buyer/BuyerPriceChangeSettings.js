// Purchasing › Price Change › Settings (2026-10-08, Hera).
// Spec: claude/PRICE_CHANGE_SCHEDULE_REVERSE_SPEC.md
//   1. Types — which product types are offered in Create Task › Start.
//   2. Price Rule for Discontinued — per type: Price − X % with the cents
//      raised to a set value; used when a Discontinued task's CSV has no
//      price for the SKU.
//   3. Compare-at price — Promotion / Discontinued: overwrite an existing
//      Compare-at price (default) or keep it.
import React, { useState, useEffect } from 'react';
import {
  Page, Card, BlockStack, InlineStack, Text, Button, Banner, TextField, Select,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const NARROW = { maxWidth: '62.375rem', margin: '0 auto', width: '100%' };

function BuyerPriceChangeSettings() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);
  const [allTypes, setAllTypes] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState({});
  const [saving, setSaving] = useState('');

  const [visible, setVisible] = useState([]);
  const [adding, setAdding] = useState(false);
  const [ruleTypes, setRuleTypes] = useState([]);
  const [percent, setPercent] = useState('');
  const [cents, setCents] = useState('99');
  const [keep, setKeep] = useState('overwrite');

  const apply = (s, types) => {
    setSettings(s);
    const hidden = new Set((s.hiddenTypes || []).map(x => x.toLowerCase()));
    setVisible((types || allTypes).filter(t => !hidden.has(t.toLowerCase())));
    setKeep(s.keepExistingCompareAt ? 'keep' : 'overwrite');
  };

  useEffect(() => {
    Promise.all([
      fetch('/api/shopify/product-types').then(r => r.json()),
      fetch('/api/price-change-tasks/settings').then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Load failed'); return d; }),
    ]).then(([t, s]) => {
      const types = Array.isArray(t) ? t : [];
      setAllTypes(types);
      apply(s, types);
    }).catch(e => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const call = async (card, url, method, body) => {
    setSaving(card); setError(''); setMsg(m => ({ ...m, [card]: '' }));
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Save failed');
      apply(d);
      setMsg(m => ({ ...m, [card]: 'Saved.' }));
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setSaving('');
    }
  };

  const usedTypes = new Set(((settings && settings.rules) || []).flatMap(r => r.types.map(t => t.toLowerCase())));
  const freeTypes = allTypes.filter(t => !usedTypes.has(t.toLowerCase()));
  const percentOk = Number(percent) > 0 && Number(percent) < 100;
  const centsOk = /^\d{1,2}$/.test(String(cents).trim());
  const Saved = ({ card }) => (msg[card] ? <Banner tone="success" onDismiss={() => setMsg(m => ({ ...m, [card]: '' }))}>{msg[card]}</Banner> : null);

  return (
    <Page title="Price Change Settings" backAction={{ onAction: () => navigate('/buyer/price-change/create') }}>
      <div style={NARROW}>
        <BlockStack gap="400">
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
          {!settings && !error && <Text tone="subdued">Loading...</Text>}
          {settings && (
            <>
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingMd" as="h2">Types</Text>
                  <Text tone="subdued">Only the selected types are offered in Create Task › Start › Type.</Text>
                  <Saved card="types" />
                  <InlineStack gap="300" blockAlign="end" align="space-between">
                    <div style={{ minWidth: 280 }}>
                      <MultiSelectDropdown label="Types" options={allTypes} selected={visible} onChange={setVisible} placeholder="None" showSelectAll />
                    </div>
                    <Button variant="primary" loading={saving === 'types'}
                      onClick={() => call('types', '/api/price-change-tasks/settings/types', 'PUT', { hiddenTypes: allTypes.filter(t => !visible.includes(t)) })}>
                      Save
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text variant="headingMd" as="h2">Price Rule for Discontinued</Text>
                  <Text tone="subdued">Used only by Discontinued tasks, for SKUs whose CSV row has no price: Price − % off, then the cents are raised to the set value (e.g. 8.99, 40 %, 99 → 5.99).</Text>
                  <Saved card="rules" />
                  {settings.rules.length === 0 && <Text tone="subdued">No rules yet.</Text>}
                  {settings.rules.map(r => (
                    <InlineStack key={r.id} gap="300" blockAlign="center" wrap={false}>
                      <button
                        type="button"
                        aria-label="Delete rule"
                        onClick={() => call('rules', `/api/price-change-tasks/settings/rules/${encodeURIComponent(r.id)}`, 'DELETE')}
                        style={{ border: 'none', background: 'none', color: '#d72c0d', fontWeight: 700, fontSize: 18, cursor: 'pointer', padding: 0 }}
                      >×</button>
                      <Text fontWeight="medium">{r.types.join(', ')}</Text>
                      <Text tone="subdued">— {r.percent}% off, round up cents to .{String(r.cents).padStart(2, '0')}</Text>
                    </InlineStack>
                  ))}
                  {!adding ? (
                    <InlineStack><Button onClick={() => { setAdding(true); setRuleTypes([]); setPercent(''); setCents('99'); }}>Add rule</Button></InlineStack>
                  ) : (
                    <InlineStack gap="400" blockAlign="end" wrap>
                      <div style={{ minWidth: 220 }}>
                        <MultiSelectDropdown label="Type" options={freeTypes} selected={ruleTypes} onChange={setRuleTypes} placeholder="Choose" />
                      </div>
                      <div style={{ width: 150 }}>
                        <TextField label="Reduce the Price" type="number" value={percent} onChange={setPercent} suffix="% off" autoComplete="off"
                          error={percent !== '' && !percentOk ? 'Between 0 and 100' : undefined} />
                      </div>
                      <div style={{ width: 150 }}>
                        <TextField label="Round up cents to" value={cents} onChange={setCents} autoComplete="off"
                          error={cents !== '' && !centsOk ? '0 to 99' : undefined} />
                      </div>
                      <div style={{ marginLeft: 'auto' }}>
                        <InlineStack gap="200">
                          <Button onClick={() => setAdding(false)}>Cancel</Button>
                          <Button variant="primary" loading={saving === 'rules'} disabled={!ruleTypes.length || !percentOk || !centsOk}
                            onClick={async () => {
                              const ok = await call('rules', '/api/price-change-tasks/settings/rules', 'POST', { types: ruleTypes, percent: Number(percent), cents: parseInt(cents, 10) });
                              if (ok) setAdding(false);
                            }}>Add</Button>
                        </InlineStack>
                      </div>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text variant="headingMd" as="h2">Compare-at price</Text>
                  <Text tone="subdued">Promotion and Discontinued tasks move the current Price into Compare-at price. When a SKU already has a Compare-at price:</Text>
                  <Saved card="compare" />
                  <InlineStack gap="300" blockAlign="end" align="space-between">
                    <div style={{ minWidth: 280 }}>
                      <Select label="" labelHidden options={[
                        { label: 'Overwrite it with the current Price', value: 'overwrite' },
                        { label: 'Keep it as it is', value: 'keep' },
                      ]} value={keep} onChange={setKeep} />
                    </div>
                    <Button variant="primary" loading={saving === 'compare'}
                      onClick={() => call('compare', '/api/price-change-tasks/settings/compare-at', 'PUT', { keepExisting: keep === 'keep' })}>Save</Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </>
          )}
          <div style={{ height: '33vh' }} />
        </BlockStack>
      </div>
    </Page>
  );
}

export default BuyerPriceChangeSettings;
