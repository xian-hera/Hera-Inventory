// Online › Wig Try-on › Usage log: every event (funnel steps, generations, blocks).
import React, { useState, useEffect, useCallback } from 'react';
import { Card, BlockStack, InlineStack, Text, Select, TextField, Button, Badge, Box } from '@shopify/polaris';
import { api, RANGES, rangeDates, EVENT_LABEL, REASON_LABEL, ADMIN_PRODUCT, ADMIN_CUSTOMER, fmtTime, fmtMs, fmtNum, TH, TD } from './wigTryonApi';

const TYPES = [
  { label: 'Generations (success + failed)', value: 'generations' },
  { label: 'All events', value: '' },
  { label: 'Blocked by limits', value: 'blocked' },
  { label: 'Selfie checks (OK + rejected)', value: 'selfie' },
  ...Object.entries(EVENT_LABEL).map(([value, label]) => ({ label, value })),
];
const TONE = { generation_success: 'success', generation_failed: 'critical', selfie_accepted: 'success', selfie_rejected: 'attention', blocked_account_limit: 'warning', blocked_ip_limit: 'warning', blocked_global_limit: 'warning' };

export default function WigTryonLog({ setBanner }) {
  const [range, setRange] = useState('7');
  const [source, setSource] = useState('');
  const [type, setType] = useState('generations');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setData(null);
    try {
      const { from, to } = rangeDates(range);
      const params = new URLSearchParams({ from, to, page: String(page), pageSize: '100' });
      if (source) params.set('source', source);
      if (type) params.set('type', type);
      if (query) params.set('q', query);
      setData(await api.get(`/events?${params}`));
    } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
  }, [range, source, type, query, page, setBanner]);
  useEffect(() => { load(); }, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const reset = (fn) => (v) => { fn(v); setPage(1); };

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="300" wrap blockAlign="end">
          <div style={{ minWidth: 160 }}><Select label="Period" options={RANGES} value={range} onChange={reset(setRange)} /></div>
          <div style={{ minWidth: 180 }}>
            <Select label="Source" value={source} onChange={reset(setSource)}
              options={[{ label: 'All', value: '' }, { label: 'Storefront customers', value: 'storefront' }, { label: 'Hub tests', value: 'admin_test' }]} />
          </div>
          <div style={{ minWidth: 240 }}><Select label="Events" options={TYPES} value={type} onChange={reset(setType)} /></div>
          <div style={{ minWidth: 240 }}>
            <TextField label="Search" value={q} onChange={setQ} autoComplete="off" placeholder="Product, colour, customer ID, error"
              onKeyDown={(e) => { if (e.key === 'Enter') { setQuery(q.trim()); setPage(1); } }}
              connectedRight={<Button onClick={() => { setQuery(q.trim()); setPage(1); }}>Search</Button>} />
          </div>
        </InlineStack>

        {!data ? <Text tone="subdued">Loading...</Text> : (
          <>
            <Text tone="subdued" variant="bodySm">{fmtNum(data.total)} events</Text>
            <Box overflowX="auto">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>Time</th><th style={TH}>Event</th><th style={TH}>Customer</th><th style={TH}>Product</th>
                    <th style={TH}>Colour</th><th style={TH}>Prompt</th><th style={TH}>Model</th><th style={TH}>Time taken</th>
                    <th style={TH}>Tokens in / out</th><th style={TH}>Error / note</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map(e => (
                    <tr key={e.id}>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>{fmtTime(e.created_at)}</td>
                      <td style={TD}>
                        <InlineStack gap="100">
                          <Badge tone={TONE[e.event_type]}>{EVENT_LABEL[e.event_type] || e.event_type}</Badge>
                          {e.source === 'admin_test' && <Badge>Hub test</Badge>}
                        </InlineStack>
                      </td>
                      <td style={TD}>{e.customer_id ? <a href={`${ADMIN_CUSTOMER}${e.customer_id}`} target="_blank" rel="noreferrer">{e.customer_id}</a> : (e.source === 'admin_test' ? '' : <Text tone="subdued">guest</Text>)}</td>
                      <td style={TD}>{e.product_id ? <a href={`${ADMIN_PRODUCT}${e.product_id}`} target="_blank" rel="noreferrer">{e.product_title || e.product_id}</a> : ''}</td>
                      <td style={TD}>{e.color_name || ''}</td>
                      <td style={TD}>{e.prompt_version ? `v${e.prompt_version}` : (e.event_type.startsWith('generation') ? 'editor' : '')}</td>
                      <td style={TD}>{e.model || ''}</td>
                      <td style={TD}>{e.duration_ms != null ? fmtMs(e.duration_ms) : ''}</td>
                      <td style={TD}>{e.input_tokens != null ? `${fmtNum(e.input_tokens)} / ${fmtNum(e.output_tokens)}` : ''}</td>
                      <td style={{ ...TD, color: e.event_type === 'generation_failed' ? '#d72c0d' : undefined }}>
                        {e.event_type.startsWith('selfie_') && e.error_reason ? (REASON_LABEL[e.error_reason] || e.error_reason) : (e.error_reason || '')}
                        {e.detail && <div style={{ color: '#6d7175', fontSize: 12 }}>{e.detail}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
            {pages > 1 && (
              <InlineStack gap="200" align="center" blockAlign="center">
                <Button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
                <Text>Page {page} of {pages}</Text>
                <Button disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </InlineStack>
            )}
          </>
        )}
      </BlockStack>
    </Card>
  );
}
