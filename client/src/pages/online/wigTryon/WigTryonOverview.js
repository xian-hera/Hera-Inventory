// Online › Wig Try-on › Overview: totals, funnel, product / colour stats.
import React, { useState, useEffect, useCallback } from 'react';
import { Card, BlockStack, InlineStack, InlineGrid, Text, Select, Box } from '@shopify/polaris';
import { api, RANGES, rangeDates, EVENT_LABEL, REASON_LABEL, ADMIN_PRODUCT, fmtMs, fmtNum, pct, TH, TD } from './wigTryonApi';

function Stat({ label, value, sub }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text tone="subdued" variant="bodySm">{label}</Text>
        <Text variant="headingLg" as="p">{value}</Text>
        {sub && <Text tone="subdued" variant="bodySm">{sub}</Text>}
      </BlockStack>
    </Card>
  );
}

export default function WigTryonOverview({ config, setBanner }) {
  const [range, setRange] = useState('today');
  const [source, setSource] = useState('storefront');
  const [stats, setStats] = useState(null);

  const load = useCallback(async () => {
    setStats(null);
    try {
      const { from, to } = rangeDates(range);
      setStats(await api.get(`/stats?from=${from}&to=${to}&source=${source}`));
    } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
  }, [range, source, setBanner]);
  useEffect(() => { load(); }, [load]);

  const g = stats && stats.generations;
  const total = g ? g.success + g.failed : 0;
  const sc = stats && stats.selfieCheck;
  const blockedTotal = stats ? Object.values(stats.blocked).reduce((a, b) => a + b, 0) : 0;
  const funnel = stats ? stats.funnel.filter(f => f.step !== 'color_selected' || config.colorEnabled || f.sessions > 0) : [];
  const first = funnel.length ? funnel[0].sessions : 0;

  return (
    <BlockStack gap="400">
      <InlineStack gap="300">
        <div style={{ minWidth: 180 }}><Select label="Period" labelInline options={RANGES} value={range} onChange={setRange} /></div>
        <div style={{ minWidth: 220 }}>
          <Select label="Source" labelInline value={source} onChange={setSource}
            options={[{ label: 'Storefront customers', value: 'storefront' }, { label: 'Hub tests', value: 'admin_test' }]} />
        </div>
      </InlineStack>

      {!stats ? <Text tone="subdued">Loading...</Text> : (
        <>
          <InlineGrid columns={{ xs: 2, md: 3, lg: 6 }} gap="300">
            <Stat label="Generated" value={fmtNum(g.success)} sub={`${g.failed} failed`} />
            <Stat label="Success rate" value={pct(g.success, total)} />
            <Stat label="Avg. time" value={fmtMs(g.avgMs)} />
            <Stat label="Est. OpenAI cost" value={g.estCostUsd == null ? '—' : `US$${g.estCostUsd.toFixed(2)}`}
              sub={`${fmtNum(g.inputTokens)} in / ${fmtNum(g.outputTokens)} out tokens${g.estCostUsd == null ? ' · set prices in Settings' : ''}`} />
            <Stat label="Selfies rejected" value={`${fmtNum(sc.rejected)} / ${fmtNum(sc.accepted + sc.rejected)}`}
              sub={Object.entries(sc.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${REASON_LABEL[k] || k} ${n}`).join(' · ') || 'checked by the selfie check'} />
            <Stat label="Blocked by limits" value={fmtNum(blockedTotal)}
              sub={`account ${stats.blocked.blocked_account_limit || 0} · IP ${stats.blocked.blocked_ip_limit || 0} · daily total ${stats.blocked.blocked_global_limit || 0}`} />
          </InlineGrid>

          {source === 'storefront' && (
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Funnel</Text>
                <Text tone="subdued" variant="bodySm">Counted by browser session. “Step” = from the previous step; “Overall” = from button clicks.</Text>
                <Box overflowX="auto">
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={TH}>Step</th><th style={TH}>Sessions</th><th style={TH}>Step</th><th style={TH}>Overall</th><th style={{ ...TH, width: '40%' }} /></tr></thead>
                    <tbody>
                      {funnel.map((f, i) => (
                        <tr key={f.step}>
                          <td style={TD}>{EVENT_LABEL[f.step]}</td>
                          <td style={TD}>{fmtNum(f.sessions)}</td>
                          <td style={TD}>{i === 0 ? '' : pct(f.sessions, funnel[i - 1].sessions)}</td>
                          <td style={TD}>{i === 0 ? '' : pct(f.sessions, first)}</td>
                          <td style={TD}>
                            <div style={{ height: 10, borderRadius: 5, background: '#2c6ecb', width: first ? `${Math.max(1, (f.sessions / first) * 100)}%` : 0 }} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Box>
              </BlockStack>
            </Card>
          )}

          <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Products</Text>
                {!stats.products.length ? <Text tone="subdued">No try-ons in this period.</Text> : (
                  <Box overflowX="auto">
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr><th style={TH}>Product</th><th style={TH}>Generated</th><th style={TH}>Failed</th><th style={TH}>Downloads</th></tr></thead>
                      <tbody>
                        {stats.products.map(p => (
                          <tr key={p.product_id}>
                            <td style={TD}>
                              <a href={`${ADMIN_PRODUCT}${p.product_id}`} target="_blank" rel="noreferrer">{p.product_title || p.product_id}</a>
                              {p.vendor && <div style={{ color: '#6d7175', fontSize: 12 }}>{p.vendor}</div>}
                            </td>
                            <td style={TD}>{p.success}</td><td style={TD}>{p.failed}</td><td style={TD}>{p.downloads}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Box>
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Colours</Text>
                {!stats.colors.length ? <Text tone="subdued">No colour try-ons in this period.</Text> : (
                  <Box overflowX="auto">
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr><th style={TH}>Colour</th><th style={TH}>Vendor</th><th style={TH}>Generated</th><th style={TH}>Failed</th></tr></thead>
                      <tbody>
                        {stats.colors.map(c => (
                          <tr key={c.color_name}><td style={TD}>{c.color_name}</td><td style={TD}>{c.vendor}</td><td style={TD}>{c.success}</td><td style={TD}>{c.failed}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </InlineGrid>
        </>
      )}
    </BlockStack>
  );
}
