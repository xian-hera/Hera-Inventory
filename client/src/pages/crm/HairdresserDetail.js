import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Button, Text,
  Spinner, Banner, Modal, DataTable, TextField, Divider,
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import QRCode from 'qrcode';

function HairdresserDetail() {
  const navigate  = useNavigate();
  const { id }    = useParams();

  // Hairdresser info
  const [hairdresser, setHairdresser]   = useState(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');

  // Referral link / QR
  const [activeLink, setActiveLink]     = useState(null);
  const [generating, setGenerating]     = useState(false);
  const [generateError, setGenerateError] = useState('');
  const qrCanvasRef                     = useRef(null);

  // Notes
  const [notes, setNotes]               = useState([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [noteInput, setNoteInput]       = useState('');
  const [savingNote, setSavingNote]     = useState(false);
  const [noteError, setNoteError]       = useState('');
  const [deletingNoteId, setDeletingNoteId] = useState(null);

  // Customers
  const [customers, setCustomers]       = useState([]);
  const [customersLoading, setCustomersLoading] = useState(true);

  // Unbind all
  const [showUnbindModal, setShowUnbindModal] = useState(false);
  const [unbinding, setUnbinding]             = useState(false);
  const [unbindError, setUnbindError]         = useState('');

  // Statistics
  const [dateFrom, setDateFrom]         = useState('');
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError]     = useState('');
  const [stats, setStats]               = useState(null);

  // Activity log
  const [activity, setActivity]         = useState([]);
  const [activityLoading, setActivityLoading] = useState(true);

  // ── Fetch hairdresser ─────────────────────────────────────────────────────
  const fetchHairdresser = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/hairdressers/${id}`);
      if (!res.ok) throw new Error('Hairdresser not found');
      const data = await res.json();
      setHairdresser(data);
      if (data.active_link) setActiveLink(data.active_link);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  // ── Fetch customers ───────────────────────────────────────────────────────
  const fetchCustomers = useCallback(async () => {
    setCustomersLoading(true);
    try {
      const res = await fetch(`/api/hairdressers/${id}/customers`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setCustomers(data);
    } catch (e) {
      // non-blocking
    } finally {
      setCustomersLoading(false);
    }
  }, [id]);

  // ── Fetch last statistics ─────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/hairdressers/${id}/statistics`);
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (e) {}
  }, [id]);

  // ── Fetch notes ───────────────────────────────────────────────────────────
  const fetchNotes = useCallback(async () => {
    setNotesLoading(true);
    try {
      const res = await fetch(`/api/hairdressers/${id}/notes`);
      if (res.ok) setNotes(await res.json());
    } catch (e) {}
    finally { setNotesLoading(false); }
  }, [id]);

  // ── Fetch activity log ────────────────────────────────────────────────────
  const fetchActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await fetch(`/api/hairdressers/${id}/activity`);
      if (res.ok) setActivity(await res.json());
    } catch (e) {}
    finally { setActivityLoading(false); }
  }, [id]);

  useEffect(() => {
    fetchHairdresser();
    fetchCustomers();
    fetchStats();
    fetchNotes();
    fetchActivity();
  }, [fetchHairdresser, fetchCustomers, fetchStats, fetchNotes, fetchActivity]);

  // ── Draw QR code whenever activeLink changes ──────────────────────────────
  useEffect(() => {
    if (!activeLink?.url || !qrCanvasRef.current) return;
    QRCode.toCanvas(qrCanvasRef.current, activeLink.url, {
      width: 220,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
  }, [activeLink]);

  // ── Generate link ─────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    setGenerating(true);
    setGenerateError('');
    try {
      const res = await fetch(`/api/hairdressers/${id}/generate-link`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to generate link');
      const data = await res.json();
      setActiveLink(data);
      await fetchActivity();
    } catch (e) {
      setGenerateError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  // ── Download QR as PNG ────────────────────────────────────────────────────
  const handleDownloadQR = () => {
    const canvas = qrCanvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `hairdresser-${hairdresser?.name?.replace(/\s+/g, '_') || id}-qr.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  // ── Add note ──────────────────────────────────────────────────────────────
  const handleAddNote = async () => {
    if (!noteInput.trim()) return;
    setSavingNote(true);
    setNoteError('');
    try {
      const res = await fetch(`/api/hairdressers/${id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteInput.trim() }),
      });
      if (!res.ok) throw new Error('Failed to save note');
      setNoteInput('');
      await fetchNotes();
      await fetchActivity();
    } catch (e) {
      setNoteError(e.message);
    } finally {
      setSavingNote(false);
    }
  };

  // ── Delete note ───────────────────────────────────────────────────────────
  const handleDeleteNote = async (noteId) => {
    setDeletingNoteId(noteId);
    try {
      const res = await fetch(`/api/hairdressers/${id}/notes/${noteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete note');
      await fetchNotes();
      await fetchActivity();
    } catch (e) {
      setNoteError(e.message);
    } finally {
      setDeletingNoteId(null);
    }
  };

  // ── Unbind all ────────────────────────────────────────────────────────────
  const handleUnbindConfirm = async () => {
    setUnbinding(true);
    setUnbindError('');
    try {
      const res = await fetch(`/api/hairdressers/${id}/tags`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to unbind customers');
      setShowUnbindModal(false);
      await fetchCustomers();
    } catch (e) {
      setUnbindError(e.message);
    } finally {
      setUnbinding(false);
    }
  };

  // ── Run statistics ────────────────────────────────────────────────────────
  const handleRunStats = async () => {
    if (!dateFrom) { setStatsError('Please select a start date.'); return; }
    setStatsLoading(true);
    setStatsError('');
    try {
      const res = await fetch(`/api/hairdressers/${id}/statistics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date_from: dateFrom }),
      });
      if (!res.ok) throw new Error('Failed to calculate statistics');
      const data = await res.json();
      setStats(data);
    } catch (e) {
      setStatsError(e.message);
    } finally {
      setStatsLoading(false);
    }
  };

  // ── Export CSV ────────────────────────────────────────────────────────────
  const handleExportCSV = () => {
    const headers = ['Name', 'Email', 'Phone number'];
    const rows = customers.map((c) => [
      c.name || '',
      c.email || '',
      c.phone || '',
    ]);
    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${hairdresser?.name?.replace(/\s+/g, '_') || id}-customers.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ── Activity label ────────────────────────────────────────────────────────
  const formatActivityAction = (action, detail) => {
    switch (action) {
      case 'created':            return 'Hairdresser created';
      case 'first_link_generated': return 'First referral link and QR code generated';
      case 'note_added':         return `Note added: "${detail}"`;
      case 'note_deleted':       return `Note deleted: "${detail}"`;
      default:                   return action;
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const formatDate = (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  };

  const formatDateTime = (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const formatCurrency = (val) => {
    if (val == null) return '—';
    return `$${Number(val).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  // ── Loading / error states ────────────────────────────────────────────────
  if (loading) {
    return (
      <Page title="Hairdresser" backAction={{ onAction: () => navigate('/crm/hairdressers') }}>
        <InlineStack align="center"><Spinner /></InlineStack>
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Hairdresser" backAction={{ onAction: () => navigate('/crm/hairdressers') }}>
        <Banner tone="critical">{error}</Banner>
      </Page>
    );
  }

  return (
    <Page
      title={hairdresser.name}
      subtitle={[hairdresser.email, hairdresser.phone].filter(Boolean).join(' · ')}
      backAction={{ onAction: () => navigate('/crm/hairdressers') }}
    >
      <Layout>

        {/* ── Referral Link & QR Code ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingSm" as="h2">Referral Link</Text>
                <Button
                  onClick={handleGenerate}
                  loading={generating}
                  tone={activeLink ? undefined : 'success'}
                >
                  {activeLink ? 'Regenerate' : 'Generate'}
                </Button>
              </InlineStack>

              {generateError && (
                <Banner tone="critical" onDismiss={() => setGenerateError('')}>
                  {generateError}
                </Banner>
              )}

              {activeLink ? (
                <BlockStack gap="300">
                  <Text variant="bodySm" tone="subdued">
                    Last generated: {formatDateTime(activeLink.generated_at)}
                  </Text>

                  <div style={{
                    background: '#f6f6f7',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    wordBreak: 'break-all',
                    fontFamily: 'monospace',
                    fontSize: '13px',
                  }}>
                    {activeLink.url}
                  </div>

                  <BlockStack gap="200" align="center">
                    <canvas ref={qrCanvasRef} style={{ borderRadius: '8px', display: 'block' }} />
                    <Button size="slim" onClick={handleDownloadQR}>
                      Download QR as PNG
                    </Button>
                  </BlockStack>
                </BlockStack>
              ) : (
                <Text tone="subdued" variant="bodySm">
                  No link generated yet. Click Generate to create one.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Notes ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingSm" as="h2">Notes</Text>

              {noteError && (
                <Banner tone="critical" onDismiss={() => setNoteError('')}>{noteError}</Banner>
              )}

              <InlineStack gap="200" blockAlign="end">
                <div style={{ flex: 1 }}>
                  <TextField
                    label=""
                    labelHidden
                    value={noteInput}
                    onChange={setNoteInput}
                    placeholder="Add a note..."
                    autoComplete="off"
                    multiline={2}
                  />
                </div>
                <Button
                  onClick={handleAddNote}
                  loading={savingNote}
                  disabled={!noteInput.trim()}
                >
                  Save
                </Button>
              </InlineStack>

              {notesLoading ? (
                <InlineStack align="center"><Spinner size="small" /></InlineStack>
              ) : notes.length === 0 ? (
                <Text tone="subdued" variant="bodySm">No notes yet.</Text>
              ) : (
                <BlockStack gap="300">
                  {notes.map((note) => (
                    <div
                      key={note.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        padding: '10px 12px',
                        background: '#f6f6f7',
                        borderRadius: '8px',
                        gap: '12px',
                      }}
                    >
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">{formatDateTime(note.created_at)}</Text>
                        <Text variant="bodyMd">{note.content}</Text>
                      </BlockStack>
                      <Button
                        size="slim"
                        tone="critical"
                        loading={deletingNoteId === note.id}
                        onClick={() => handleDeleteNote(note.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Bound Customers ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingSm" as="h2">Bound Customers</Text>
                  {!customersLoading && (
                    <Text variant="bodySm" tone="subdued">
                      {customers.length} customer{customers.length !== 1 ? 's' : ''}
                    </Text>
                  )}
                </BlockStack>
                <InlineStack gap="200">
                  <Button
                    disabled={customers.length === 0}
                    onClick={handleExportCSV}
                  >
                    Export
                  </Button>
                  <Button
                    tone="critical"
                    disabled={customers.length === 0}
                    onClick={() => setShowUnbindModal(true)}
                  >
                    Unbind All
                  </Button>
                </InlineStack>
              </InlineStack>

              {customersLoading ? (
                <InlineStack align="center"><Spinner size="small" /></InlineStack>
              ) : customers.length === 0 ? (
                <Text tone="subdued" variant="bodySm">No customers bound yet.</Text>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text']}
                  headings={['Name', 'Email', 'Bound on']}
                  rows={customers.map((c) => [
                    <Text>{c.name || '—'}</Text>,
                    <Text tone="subdued">{c.email || '—'}</Text>,
                    <Text tone="subdued">{formatDate(c.bound_at)}</Text>,
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Statistics ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingSm" as="h2">Statistics</Text>

              <InlineStack gap="300" blockAlign="end">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Start date"
                    type="date"
                    value={dateFrom}
                    onChange={(val) => { setDateFrom(val); setStatsError(''); }}
                    autoComplete="off"
                  />
                </div>
                <Button
                  onClick={handleRunStats}
                  loading={statsLoading}
                  disabled={!dateFrom}
                >
                  Calculate
                </Button>
              </InlineStack>

              {statsError && (
                <Banner tone="critical" onDismiss={() => setStatsError('')}>
                  {statsError}
                </Banner>
              )}

              {stats && (
                <>
                  <Divider />
                  <BlockStack gap="200">
                    <Text variant="bodySm" tone="subdued">
                      Last calculated: {formatDateTime(stats.calculated_at)}
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      Period: {formatDate(stats.date_from)} → today
                    </Text>
                    <InlineStack gap="600">
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">Total customers</Text>
                        <Text variant="headingMd">{stats.total_customers ?? '—'}</Text>
                      </BlockStack>
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">Total revenue</Text>
                        <Text variant="headingMd">{formatCurrency(stats.total_revenue)}</Text>
                      </BlockStack>
                    </InlineStack>
                  </BlockStack>
                </>
              )}

              {!stats && !statsLoading && (
                <Text tone="subdued" variant="bodySm">
                  No statistics calculated yet. Select a start date and click Calculate.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Activity Log ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingSm" as="h2">Activity Log</Text>

              {activityLoading ? (
                <InlineStack align="center"><Spinner size="small" /></InlineStack>
              ) : activity.length === 0 ? (
                <Text tone="subdued" variant="bodySm">No activity recorded yet.</Text>
              ) : (
                <BlockStack gap="200">
                  {activity.map((entry) => (
                    <div
                      key={entry.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        padding: '8px 0',
                        borderBottom: '1px solid #e1e3e5',
                        gap: '16px',
                      }}
                    >
                      <Text variant="bodyMd">
                        {formatActivityAction(entry.action, entry.detail)}
                      </Text>
                      <Text variant="bodySm" tone="subdued" style={{ whiteSpace: 'nowrap' }}>
                        {formatDateTime(entry.created_at)}
                      </Text>
                    </div>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>

      {/* ── Unbind All confirmation modal ── */}
      <Modal
        open={showUnbindModal}
        onClose={() => { setShowUnbindModal(false); setUnbindError(''); }}
        title="Unbind all customers"
        primaryAction={{
          content: 'Unbind All',
          destructive: true,
          loading: unbinding,
          onAction: handleUnbindConfirm,
        }}
        secondaryActions={[{
          content: 'Cancel',
          onAction: () => { setShowUnbindModal(false); setUnbindError(''); },
        }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {unbindError && <Banner tone="critical">{unbindError}</Banner>}
            <Text>
              This will remove all {customers.length} customer binding{customers.length !== 1 ? 's' : ''} for{' '}
              <strong>{hairdresser?.name}</strong> and clear their Shopify tags.
              Existing statistics are not affected. This action cannot be undone.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default HairdresserDetail;