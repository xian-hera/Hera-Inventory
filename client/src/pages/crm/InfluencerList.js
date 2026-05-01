import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Card, DataTable, Button, Modal, TextField, Select, Badge,
  InlineStack, BlockStack, Text, Spinner, Banner, EmptyState, Box,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const STATUS_OPTIONS = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Draft', value: 'draft' },
  { label: 'Archive', value: 'archive' },
];

const EMPTY_FORM = {
  name: '', email: '', code: '', commission_rate: '', type: '',
  platforms: [{ label: '', url: '' }],
};

function statusBadge(status) {
  const map = { active: 'success', draft: 'attention', archive: 'enabled' };
  return <Badge tone={map[status] || 'enabled'}>{status}</Badge>;
}

export default function InfluencerList() {
  const navigate = useNavigate();
  const [influencers, setInfluencers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/influencers');
      setInfluencers(await r.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = influencers.filter(i =>
    statusFilter === 'all' || i.status === statusFilter
  );

  // ── Form helpers ──
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setPlatform = (idx, key, val) =>
    setForm(f => {
      const p = [...f.platforms];
      p[idx] = { ...p[idx], [key]: val };
      return { ...f, platforms: p };
    });
  const addPlatform = () =>
    setForm(f => ({ ...f, platforms: [...f.platforms, { label: '', url: '' }] }));
  const removePlatform = (idx) =>
    setForm(f => ({ ...f, platforms: f.platforms.filter((_, i) => i !== idx) }));

  const handleSave = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/influencers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          platforms: form.platforms.filter(p => p.label || p.url),
        }),
      });
      if (!r.ok) throw new Error('Failed');
      await load();
      setModalOpen(false);
      setForm(EMPTY_FORM);
    } catch (e) {
      setError('Failed to save influencer.');
    } finally { setSaving(false); }
  };

  // ── Table rows ──
  const rows = filtered.map(inf => {
    const sale = inf.last_stats_total != null
      ? `$${parseFloat(inf.last_stats_total).toLocaleString('en', { minimumFractionDigits: 2 })}`
      : '—';
    const commission = (inf.last_stats_total != null && inf.commission_rate)
      ? `$${(parseFloat(inf.last_stats_total) * parseFloat(inf.commission_rate) / 100).toLocaleString('en', { minimumFractionDigits: 2 })}`
      : '—';

    const platformLinks = (inf.platforms || []).slice(0, 3).map((p, i) => (
      <a key={i} href={p.url} target="_blank" rel="noopener noreferrer"
        style={{ marginRight: 8, color: '#005bd3', textDecoration: 'none', fontSize: 13 }}>
        {p.label}
      </a>
    ));

    return [
      <Text fontWeight="semibold">{inf.name}</Text>,
      <div>{platformLinks}</div>,
      inf.type || '—',
      sale,
      commission,
      statusBadge(inf.status),
      <Button size="slim" onClick={() => navigate(`/crm/influencers/${inf.id}`)}>Detail</Button>,
    ];
  });

  return (
    <Page
      title="Influencers"
      primaryAction={{ content: 'Add Influencer', onAction: () => { setForm(EMPTY_FORM); setModalOpen(true); } }}
    >
      {/* Filter bar */}
      <Box paddingBlockEnd="400">
        <InlineStack gap="300" align="start">
          <div style={{ minWidth: 160 }}>
            <Select label="" labelHidden options={STATUS_OPTIONS}
              value={statusFilter} onChange={setStatusFilter} />
          </div>
          <Text tone="subdued" variant="bodySm" as="p">
            {filtered.length} influencer{filtered.length !== 1 ? 's' : ''}
          </Text>
        </InlineStack>
      </Box>

      <Card padding="0">
        {loading ? (
          <Box padding="800"><InlineStack align="center"><Spinner /></InlineStack></Box>
        ) : filtered.length === 0 ? (
          <EmptyState heading="No influencers yet" image="">
            <p>Click "Add Influencer" to get started.</p>
          </EmptyState>
        ) : (
          <DataTable
            columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text', 'text']}
            headings={['Name', 'Platform', 'Type', 'Total Sale (last 180d)', 'Commission', 'Status', '']}
            rows={rows}
          />
        )}
      </Card>

      {/* ── Add Influencer Modal ── */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add Influencer"
        primaryAction={{ content: saving ? 'Saving…' : 'Save', onAction: handleSave, disabled: saving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          {error && <Box paddingBlockEnd="400"><Banner tone="critical">{error}</Banner></Box>}
          <BlockStack gap="400">
            <TextField label="Name" value={form.name} onChange={v => setField('name', v)} autoComplete="off" />
            <TextField label="Email" value={form.email} onChange={v => setField('email', v)} autoComplete="off" />

            {/* Platform rows */}
            <BlockStack gap="200">
              <Text variant="bodyMd" fontWeight="semibold">Platforms</Text>
              {form.platforms.map((p, idx) => (
                <InlineStack key={idx} gap="200" align="start" blockAlign="center">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Platform" labelHidden placeholder="e.g. TikTok"
                      value={p.label} onChange={v => setPlatform(idx, 'label', v)} autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 2 }}>
                    <TextField
                      label="Link" labelHidden placeholder="https://..."
                      value={p.url} onChange={v => setPlatform(idx, 'url', v)} autoComplete="off"
                    />
                  </div>
                  {form.platforms.length > 1 && (
                    <Button size="slim" tone="critical" onClick={() => removePlatform(idx)}>✕</Button>
                  )}
                </InlineStack>
              ))}
              <Button size="slim" onClick={addPlatform}>+ Add Platform</Button>
            </BlockStack>

            <TextField label="Discount Code" value={form.code}
              onChange={v => setField('code', v)} autoComplete="off" />
            <TextField label="Commission Rate (%)" value={form.commission_rate}
              onChange={v => setField('commission_rate', v)} autoComplete="off" type="number" />
            <TextField label="Type" value={form.type}
              onChange={v => setField('type', v)} autoComplete="off" />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}