import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Card, BlockStack, InlineStack, Text, Badge, Button, Select,
  TextField, Modal, Banner, Spinner, Box, Divider, DataTable,
} from '@shopify/polaris';
import { useParams, useNavigate } from 'react-router-dom';

const STATUS_OPTIONS = [
  { label: 'Draft', value: 'draft' },
  { label: 'Active', value: 'active' },
  { label: 'Archive', value: 'archive' },
];

const DAYS_OPTIONS = [
  { label: 'Last 7 days', value: '7' },
  { label: 'Last 30 days', value: '30' },
  { label: 'Last 180 days', value: '180' },
  { label: 'Last 365 days', value: '365' },
];

const EMPTY_PLATFORM = { label: '', url: '' };

const EMPTY_BILLING = {
  line1: '', line2: '', city: '', province: '', postal_code: '', country: '',
};

function fmt(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en', { dateStyle: 'medium' });
}
function statusBadge(status) {
  const map = { active: 'success', draft: 'attention', archive: 'enabled' };
  return <Badge tone={map[status] || 'enabled'}>{status}</Badge>;
}

export default function InfluencerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [inf, setInf] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(false);
  const [selectedDays, setSelectedDays] = useState('180');
  const [orders, setOrders] = useState([]);

  // Edit info modal
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  // Note
  const [noteText, setNoteText] = useState('');
  const [noteLoading, setNoteLoading] = useState(false);

  // Payment info modal
  const [payInfoOpen, setPayInfoOpen] = useState(false);
  const [payInfoForm, setPayInfoForm] = useState({ payment_method: '', phone_number: '', billing_address: EMPTY_BILLING });
  const [payInfoSaving, setPayInfoSaving] = useState(false);
  const [payInfoError, setPayInfoError] = useState('');

  // Payment record modal
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [payForm, setPayForm] = useState({ payment_date: '', amount: '', method: '' });
  const [paySaving, setPaySaving] = useState(false);
  const [payError, setPayError] = useState('');
  const [payConfirmed, setPayConfirmed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/influencers/${id}`);
      if (!r.ok) { navigate('/crm/influencers'); return; }
      setInf(await r.json());
    } finally { setLoading(false); }
  }, [id, navigate]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Page><Box padding="800"><InlineStack align="center"><Spinner /></InlineStack></Box></Page>;
  if (!inf) return null;

  // ── Status change ──
  const handleStatusChange = async (val) => {
    const r = await fetch(`/api/influencers/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: val }),
    });
    if (r.ok) setInf(await r.json());
  };

  // ── Edit info ──
  const openEdit = () => {
    setEditForm({
      name: inf.name || '',
      email: inf.email || '',
      code: inf.code || '',
      commission_rate: inf.commission_rate || '',
      type: inf.type || '',
      platforms: inf.platforms?.length ? [...inf.platforms] : [EMPTY_PLATFORM],
    });
    setEditError('');
    setEditOpen(true);
  };
  const setEditField = (k, v) => setEditForm(f => ({ ...f, [k]: v }));
  const setEditPlatform = (idx, key, val) =>
    setEditForm(f => {
      const p = [...f.platforms];
      p[idx] = { ...p[idx], [key]: val };
      return { ...f, platforms: p };
    });
  const handleEditSave = async () => {
    if (!editForm.name.trim()) { setEditError('Name is required'); return; }
    setEditSaving(true); setEditError('');
    try {
      const r = await fetch(`/api/influencers/${id}/info`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...editForm,
          platforms: editForm.platforms.filter(p => p.label || p.url),
        }),
      });
      if (!r.ok) throw new Error();
      setInf(await r.json());
      setEditOpen(false);
    } catch { setEditError('Failed to save.'); }
    finally { setEditSaving(false); }
  };

  // ── Notes ──
  const addNote = async () => {
    if (!noteText.trim()) return;
    setNoteLoading(true);
    const newNote = { text: noteText.trim(), created_at: new Date().toISOString() };
    const notes = [...(inf.notes || []), newNote];
    const r = await fetch(`/api/influencers/${id}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes, action: 'add' }),
    });
    if (r.ok) { setInf(await r.json()); setNoteText(''); }
    setNoteLoading(false);
  };
  const deleteNote = async (idx) => {
    const notes = inf.notes.filter((_, i) => i !== idx);
    const r = await fetch(`/api/influencers/${id}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes, action: 'delete' }),
    });
    if (r.ok) setInf(await r.json());
  };

  // ── Refresh stats ──
  const refreshStats = async () => {
    setStatsLoading(true);
    try {
      const r = await fetch(`/api/influencers/${id}/refresh-stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: parseInt(selectedDays) }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setOrders(data.orders || []);
      setInf(i => ({
        ...i,
        last_stats_total: data.total_sale,
        last_stats_used: data.used_times,
        last_stats_days: parseInt(selectedDays),
        last_stats_refreshed_at: new Date().toISOString(),
      }));
    } finally { setStatsLoading(false); }
  };

  // ── Payment info edit ──
  const openPayInfo = () => {
    setPayInfoForm({
      payment_method: inf.payment_method || '',
      phone_number: inf.phone_number || '',
      billing_address: {
        line1:       inf.billing_address?.line1       || '',
        line2:       inf.billing_address?.line2       || '',
        city:        inf.billing_address?.city        || '',
        province:    inf.billing_address?.province    || '',
        postal_code: inf.billing_address?.postal_code || '',
        country:     inf.billing_address?.country     || '',
      },
    });
    setPayInfoError('');
    setPayInfoOpen(true);
  };
  const setPayInfoField = (k, v) => setPayInfoForm(f => ({ ...f, [k]: v }));
  const setAddrField = (k, v) => setPayInfoForm(f => ({
    ...f, billing_address: { ...f.billing_address, [k]: v },
  }));
  const handlePayInfoSave = async () => {
    setPayInfoSaving(true); setPayInfoError('');
    try {
      const r = await fetch(`/api/influencers/${id}/payment-info`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payInfoForm),
      });
      if (!r.ok) throw new Error();
      setInf(await r.json());
      setPayInfoOpen(false);
    } catch { setPayInfoError('Failed to save.'); }
    finally { setPayInfoSaving(false); }
  };

  // ── Payment record ──
  const openPayModal = () => {
    setPayForm({ payment_date: new Date().toISOString().slice(0, 10), amount: '', method: '' });
    setPayError(''); setPayConfirmed(false); setPayModalOpen(true);
  };
  const handlePaySave = async () => {
    if (!payConfirmed) { setPayError('Please confirm that payment records cannot be modified or deleted.'); return; }
    if (!payForm.amount || !payForm.payment_date) { setPayError('Date and amount are required.'); return; }
    setPaySaving(true); setPayError('');
    try {
      const r = await fetch(`/api/influencers/${id}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payForm),
      });
      if (!r.ok) throw new Error();
      await load();
      setPayModalOpen(false);
    } catch { setPayError('Failed to save payment.'); }
    finally { setPaySaving(false); }
  };

  // ── Commission calc ──
  const commissionAmt = (inf.last_stats_total != null && inf.commission_rate)
    ? (parseFloat(inf.last_stats_total) * parseFloat(inf.commission_rate) / 100).toFixed(2)
    : null;

  // ── Order table rows ──
  const orderRows = orders.map(o => [
    o.name
      ? <a href={`https://admin.shopify.com/store/beaute-hera/orders/${o.id}`}
          target="_blank" rel="noopener noreferrer"
          style={{ color: '#005bd3', textDecoration: 'none' }}>{o.name}</a>
      : '—',
    o.customer_name || '—',
    o.destination || '—',
    `$${parseFloat(o.subtotal_price || 0).toFixed(2)}`,
  ]);

  // ── Billing address display ──
  const billingLines = inf.billing_address
    ? [
        inf.billing_address.line1,
        inf.billing_address.line2,
        inf.billing_address.city,
        inf.billing_address.province,
        inf.billing_address.postal_code,
        inf.billing_address.country,
      ].filter(Boolean)
    : [];

  // ── History action label map ──
  const actionLabel = {
    created: 'Created',
    info_updated: 'Info updated',
    status_changed: 'Status changed',
    note_added: 'Note added',
    note_deleted: 'Note deleted',
    payment_added: 'Payment added',
    stats_refreshed: 'Sales stats refreshed',
  };

  return (
    <Page
      title={inf.name}
      backAction={{ content: 'Influencers', onAction: () => navigate('/crm/influencers') }}
      titleMetadata={statusBadge(inf.status)}
    >
      <BlockStack gap="500">

        {/* ── Card 1: Info ── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="start">
              <InlineStack gap="600">
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Created</Text>
                  <Text variant="bodyMd">{fmt(inf.created_at)}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Last Active</Text>
                  <Text variant="bodyMd">{fmt(inf.last_active_at)}</Text>
                </BlockStack>
              </InlineStack>
              <div style={{ minWidth: 160 }}>
                <Select label="Status" labelInline options={STATUS_OPTIONS}
                  value={inf.status} onChange={handleStatusChange} />
              </div>
            </InlineStack>

            <Divider />

            <InlineStack align="space-between" blockAlign="start">
              <InlineStack gap="600" wrap>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Email</Text>
                  <Text variant="bodyMd">{inf.email || '—'}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Platforms</Text>
                  <InlineStack gap="200">
                    {(inf.platforms || []).length === 0 && <Text variant="bodyMd">—</Text>}
                    {(inf.platforms || []).map((p, i) =>
                      p.url
                        ? <a key={i} href={p.url} target="_blank" rel="noopener noreferrer"
                            style={{ color: '#005bd3', textDecoration: 'none', fontSize: 14 }}>{p.label || p.url}</a>
                        : <Text key={i} variant="bodyMd">{p.label}</Text>
                    )}
                  </InlineStack>
                </BlockStack>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Discount Code</Text>
                  <Text variant="bodyMd">{inf.code || '—'}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Commission Rate</Text>
                  <Text variant="bodyMd">{inf.commission_rate != null ? `${inf.commission_rate}%` : '—'}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Type</Text>
                  <Text variant="bodyMd">{inf.type || '—'}</Text>
                </BlockStack>
              </InlineStack>
              <Button onClick={openEdit}>Edit</Button>
            </InlineStack>

            <Divider />

            {/* Notes */}
            <BlockStack gap="300">
              <Text variant="bodyMd" fontWeight="semibold">Notes</Text>
              {(inf.notes || []).length === 0 && <Text tone="subdued">No notes.</Text>}
              {(inf.notes || []).map((n, idx) => (
                <InlineStack key={idx} align="space-between" blockAlign="start">
                  <BlockStack gap="050">
                    <Text variant="bodyMd">{n.text}</Text>
                    <Text variant="bodySm" tone="subdued">{fmt(n.created_at)}</Text>
                  </BlockStack>
                  <Button size="slim" tone="critical" onClick={() => deleteNote(idx)}>Delete</Button>
                </InlineStack>
              ))}
              <InlineStack gap="200" blockAlign="end">
                <div style={{ flex: 1 }}>
                  <TextField label="" labelHidden placeholder="Add a note…"
                    value={noteText} onChange={setNoteText} multiline={2} autoComplete="off" />
                </div>
                <Button onClick={addNote} loading={noteLoading} disabled={!noteText.trim()}>Add Note</Button>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Card>

        {/* ── Card 2: Sales Stats ── */}
        {inf.code && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Code Usage</Text>
              <InlineStack gap="600" wrap>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Code</Text>
                  <a
                    href={`https://admin.shopify.com/store/beaute-hera/discounts?search=${encodeURIComponent(inf.code)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#005bd3', textDecoration: 'none', fontWeight: 600, fontSize: 14 }}
                  >
                    {inf.code} ↗
                  </a>
                </BlockStack>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Used Times</Text>
                  <Text variant="bodyMd">{inf.last_stats_used ?? '—'}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Total Sale</Text>
                  <Text variant="bodyMd">
                    {inf.last_stats_total != null
                      ? `$${parseFloat(inf.last_stats_total).toLocaleString('en', { minimumFractionDigits: 2 })}`
                      : '—'}
                    {inf.last_stats_days
                      ? <Text as="span" tone="subdued" variant="bodySm"> (last {inf.last_stats_days}d)</Text>
                      : ''}
                  </Text>
                </BlockStack>
                {commissionAmt && (
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued">Commission</Text>
                    <Text variant="bodyMd">${parseFloat(commissionAmt).toLocaleString('en', { minimumFractionDigits: 2 })}</Text>
                  </BlockStack>
                )}
              </InlineStack>
              {inf.last_stats_refreshed_at && (
                <Text variant="bodySm" tone="subdued">Last refreshed: {fmt(inf.last_stats_refreshed_at)}</Text>
              )}
              <InlineStack gap="300" blockAlign="end">
                <div style={{ minWidth: 180 }}>
                  <Select label="" labelHidden options={DAYS_OPTIONS}
                    value={selectedDays} onChange={setSelectedDays} />
                </div>
                <Button onClick={refreshStats} loading={statsLoading}>Refresh</Button>
              </InlineStack>
              {orders.length > 0 && (
                <Box paddingBlockStart="200">
                  <Text variant="bodyMd" fontWeight="semibold" tone="subdued">
                    Recent {orders.length} orders
                  </Text>
                  <Box paddingBlockStart="200">
                    <DataTable
                      columnContentTypes={['text', 'text', 'text', 'numeric']}
                      headings={['Order #', 'Customer', 'Destination', 'Subtotal']}
                      rows={orderRows}
                    />
                  </Box>
                </Box>
              )}
            </BlockStack>
          </Card>
        )}

        {/* ── Card 3: Payment ── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <Text variant="headingMd">Payment</Text>
              <Button onClick={openPayInfo}>Edit</Button>
            </InlineStack>

            {/* Payment info fields — always shown, empty shows '—' */}
            <InlineStack gap="600" wrap>
              <BlockStack gap="100">
                <Text variant="bodySm" tone="subdued">Payment Method</Text>
                <Text variant="bodyMd">{inf.payment_method || '—'}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text variant="bodySm" tone="subdued">Phone</Text>
                <Text variant="bodyMd">{inf.phone_number || '—'}</Text>
              </BlockStack>
            </InlineStack>

            <BlockStack gap="100">
              <Text variant="bodySm" tone="subdued">Mailing Address</Text>
              {billingLines.length === 0
                ? <Text variant="bodyMd">—</Text>
                : billingLines.map((line, i) => (
                    <Text key={i} variant="bodyMd">{line}</Text>
                  ))
              }
            </BlockStack>

            <Divider />

            {/* Payment history */}
            <InlineStack align="space-between">
              <Text variant="bodyMd" fontWeight="semibold">Payment History</Text>
              <Button size="slim" onClick={openPayModal}>Add</Button>
            </InlineStack>
            {(inf.payment_history || []).length === 0 ? (
              <Text tone="subdued">No payment records.</Text>
            ) : (
              <DataTable
                columnContentTypes={['text', 'numeric', 'text']}
                headings={['Date', 'Amount', 'Method']}
                rows={(inf.payment_history || []).map(p => [
                  fmtDate(p.payment_date),
                  `$${parseFloat(p.amount).toLocaleString('en', { minimumFractionDigits: 2 })}`,
                  p.method || '—',
                ])}
              />
            )}
          </BlockStack>
        </Card>

        {/* ── Card 4: History ── */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Activity History</Text>
            {(inf.history || []).length === 0 && <Text tone="subdued">No history yet.</Text>}
            {(inf.history || []).map((h, i) => (
              <InlineStack key={i} align="space-between">
                <Text variant="bodyMd">{actionLabel[h.action] || h.action}{h.detail ? ` — ${h.detail}` : ''}</Text>
                <Text variant="bodySm" tone="subdued">{fmt(h.created_at)}</Text>
              </InlineStack>
            ))}
          </BlockStack>
        </Card>

      </BlockStack>

      {/* ── Edit Info Modal ── */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Influencer Info"
        primaryAction={{ content: editSaving ? 'Saving…' : 'Save', onAction: handleEditSave, disabled: editSaving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setEditOpen(false) }]}
      >
        <Modal.Section>
          {editError && <Box paddingBlockEnd="400"><Banner tone="critical">{editError}</Banner></Box>}
          <BlockStack gap="400">
            <TextField label="Name" value={editForm.name || ''} onChange={v => setEditField('name', v)} autoComplete="off" />
            <TextField label="Email" value={editForm.email || ''} onChange={v => setEditField('email', v)} autoComplete="off" />
            <BlockStack gap="200">
              <Text variant="bodyMd" fontWeight="semibold">Platforms</Text>
              {(editForm.platforms || []).map((p, idx) => (
                <InlineStack key={idx} gap="200" blockAlign="center">
                  <div style={{ flex: 1 }}>
                    <TextField label="Platform" labelHidden placeholder="e.g. TikTok"
                      value={p.label} onChange={v => setEditPlatform(idx, 'label', v)} autoComplete="off" />
                  </div>
                  <div style={{ flex: 2 }}>
                    <TextField label="Link" labelHidden placeholder="https://..."
                      value={p.url} onChange={v => setEditPlatform(idx, 'url', v)} autoComplete="off" />
                  </div>
                  {(editForm.platforms || []).length > 1 && (
                    <Button size="slim" tone="critical"
                      onClick={() => setEditForm(f => ({ ...f, platforms: f.platforms.filter((_, i) => i !== idx) }))}>✕</Button>
                  )}
                </InlineStack>
              ))}
              <Button size="slim"
                onClick={() => setEditForm(f => ({ ...f, platforms: [...(f.platforms || []), EMPTY_PLATFORM] }))}>
                + Add Platform
              </Button>
            </BlockStack>
            <TextField label="Discount Code" value={editForm.code || ''} onChange={v => setEditField('code', v)} autoComplete="off" />
            <TextField label="Commission Rate (%)" value={String(editForm.commission_rate || '')}
              onChange={v => setEditField('commission_rate', v)} autoComplete="off" type="number" />
            <TextField label="Type" value={editForm.type || ''} onChange={v => setEditField('type', v)} autoComplete="off" />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Edit Payment Info Modal ── */}
      <Modal open={payInfoOpen} onClose={() => setPayInfoOpen(false)} title="Edit Payment Info"
        primaryAction={{ content: payInfoSaving ? 'Saving…' : 'Save', onAction: handlePayInfoSave, disabled: payInfoSaving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setPayInfoOpen(false) }]}
      >
        <Modal.Section>
          {payInfoError && <Box paddingBlockEnd="400"><Banner tone="critical">{payInfoError}</Banner></Box>}
          <BlockStack gap="400">
            <TextField label="Payment Method" value={payInfoForm.payment_method}
              onChange={v => setPayInfoField('payment_method', v)} autoComplete="off"
              placeholder="e.g. PayPal, E-Transfer, Bank Transfer" />
            <TextField label="Phone" value={payInfoForm.phone_number}
              onChange={v => setPayInfoField('phone_number', v)} autoComplete="off" />
            <TextField label="Mailing Address Line 1" value={payInfoForm.billing_address.line1}
              onChange={v => setAddrField('line1', v)} autoComplete="off" />
            <TextField label="Mailing Address Line 2" value={payInfoForm.billing_address.line2}
              onChange={v => setAddrField('line2', v)} autoComplete="off" />
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <TextField label="City" value={payInfoForm.billing_address.city}
                  onChange={v => setAddrField('city', v)} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Province / State" value={payInfoForm.billing_address.province}
                  onChange={v => setAddrField('province', v)} autoComplete="off" />
              </div>
            </InlineStack>
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <TextField label="Postal Code" value={payInfoForm.billing_address.postal_code}
                  onChange={v => setAddrField('postal_code', v)} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Country" value={payInfoForm.billing_address.country}
                  onChange={v => setAddrField('country', v)} autoComplete="off" />
              </div>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Add Payment Record Modal ── */}
      <Modal open={payModalOpen} onClose={() => setPayModalOpen(false)} title="Add Payment Record"
        primaryAction={{ content: paySaving ? 'Saving…' : 'Save', onAction: handlePaySave, disabled: paySaving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setPayModalOpen(false) }]}
      >
        <Modal.Section>
          {payError && <Box paddingBlockEnd="400"><Banner tone="critical">{payError}</Banner></Box>}
          <BlockStack gap="400">
            <TextField label="Payment Date" type="date" value={payForm.payment_date}
              onChange={v => setPayForm(f => ({ ...f, payment_date: v }))} autoComplete="off" />
            <TextField label="Amount ($)" type="number" value={payForm.amount}
              onChange={v => setPayForm(f => ({ ...f, amount: v }))} autoComplete="off" />
            <TextField label="Method" value={payForm.method}
              onChange={v => setPayForm(f => ({ ...f, method: v }))} autoComplete="off"
              placeholder="e.g. PayPal, E-Transfer" />
            <Banner tone="warning">
              <InlineStack gap="200" blockAlign="center">
                <input type="checkbox" id="payConfirm" checked={payConfirmed}
                  onChange={e => setPayConfirmed(e.target.checked)} />
                <label htmlFor="payConfirm" style={{ cursor: 'pointer', fontSize: 14 }}>
                  I understand that payment records cannot be modified or deleted after saving.
                </label>
              </InlineStack>
            </Banner>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}