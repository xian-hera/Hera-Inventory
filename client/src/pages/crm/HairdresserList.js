import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Button, TextField,
  Text, Spinner, Banner, Modal, DataTable, Divider, EmptyState,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function HairdresserList() {
  const navigate = useNavigate();

  // Hairdresser list
  const [hairdressers, setHairdressers]   = useState([]);
  const [listLoading, setListLoading]     = useState(true);
  const [listError, setListError]         = useState('');

  // Search
  const [searchQuery, setSearchQuery]     = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching]         = useState(false);
  const [searchError, setSearchError]     = useState('');

  // Add
  const [addingId, setAddingId]           = useState(null); // shopify_customer_id being added

  // Delete confirmation
  const [deleteTarget, setDeleteTarget]   = useState(null); // { id, name }
  const [deleting, setDeleting]           = useState(false);
  const [deleteError, setDeleteError]     = useState('');

  // CSV import
  const csvInputRef                           = useRef(null);
  const [importing, setImporting]             = useState(false);
  const [importResult, setImportResult]       = useState(null); // { added, already_exists, not_found, errors }
  const [showImportModal, setShowImportModal] = useState(false);

  // Bulk generate links
  const [bulkGenerating, setBulkGenerating]         = useState(false);
  const [bulkGenerateResult, setBulkGenerateResult] = useState(null); // { generated, message }
  const [showBulkModal, setShowBulkModal]           = useState(false);

  // ── Fetch hairdresser list ────────────────────────────────────────────────
  const fetchHairdressers = useCallback(async () => {
    setListLoading(true);
    setListError('');
    try {
      const res = await fetch('/api/hairdressers');
      if (!res.ok) throw new Error('Failed to load hairdressers');
      const data = await res.json();
      setHairdressers(data);
    } catch (e) {
      setListError(e.message);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { fetchHairdressers(); }, [fetchHairdressers]);

  // ── Customer search (debounced) ───────────────────────────────────────────
  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError('');
      try {
        const res = await fetch(`/api/shopify/search-customers?q=${encodeURIComponent(searchQuery.trim())}`);
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        setSearchResults(data);
      } catch (e) {
        setSearchError(e.message);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ── Add hairdresser ───────────────────────────────────────────────────────
  const handleAdd = async (customer) => {
    setAddingId(customer.id);
    try {
      const res = await fetch('/api/hairdressers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopify_customer_id: customer.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to add hairdresser');
      }
      setSearchQuery('');
      setSearchResults([]);
      await fetchHairdressers();
    } catch (e) {
      setSearchError(e.message);
    } finally {
      setAddingId(null);
    }
  };

  // ── Delete hairdresser ────────────────────────────────────────────────────
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const res = await fetch(`/api/hairdressers/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete hairdresser');
      setDeleteTarget(null);
      await fetchHairdressers();
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  // ── Already-added check ───────────────────────────────────────────────────
  const isAlreadyAdded = (shopifyId) =>
    hairdressers.some((h) => h.shopify_customer_id === String(shopifyId));

  // ── CSV import ────────────────────────────────────────────────────────────
  const handleImportClick = () => {
    setImportResult(null);
    csvInputRef.current?.click();
  };

  const handleCsvFile = async (e) => {
    const file = e.target.files?.[0];
    // Reset input so the same file can be re-selected if needed
    e.target.value = '';
    if (!file) return;

    setImporting(true);
    setImportResult(null);

    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) throw new Error('CSV file is empty or has no data rows');

      // Find the index of the "email" column (case-insensitive)
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
      const emailIdx = headers.indexOf('email');
      if (emailIdx === -1) throw new Error('No "email" column found in CSV');

      // Extract emails from data rows
      const emails = lines.slice(1).map(line => {
        const cols = line.split(',');
        return (cols[emailIdx] || '').trim().replace(/^"|"$/g, '');
      }).filter(Boolean);

      if (emails.length === 0) throw new Error('No email addresses found in CSV');

      const res = await fetch('/api/hairdressers/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Import failed');
      }
      const result = await res.json();
      setImportResult(result);
      setShowImportModal(true);
      if (result.added?.length > 0) await fetchHairdressers();
    } catch (e) {
      setImportResult({ fatalError: e.message });
      setShowImportModal(true);
    } finally {
      setImporting(false);
    }
  };

  // ── Bulk generate links ───────────────────────────────────────────────────
  const handleBulkGenerate = async () => {
    setBulkGenerating(true);
    setBulkGenerateResult(null);
    try {
      const res = await fetch('/api/hairdressers/bulk-generate-links', { method: 'POST' });
      if (!res.ok) throw new Error('Bulk generate failed');
      const data = await res.json();
      setBulkGenerateResult(data);
      setShowBulkModal(true);
      await fetchHairdressers();
    } catch (e) {
      setBulkGenerateResult({ error: e.message });
      setShowBulkModal(true);
    } finally {
      setBulkGenerating(false);
    }
  };

  // ── List summary stats ────────────────────────────────────────────────────
  const totalCount       = hairdressers.length;
  const withCustomers    = hairdressers.filter(h => (h.bound_customers ?? 0) >= 1).length;
  const totalCustomers   = hairdressers.reduce((sum, h) => sum + (h.bound_customers ?? 0), 0);

  // ── Render ────────────────────────────────────────────────────────────────
  const formatDate = (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  };

  return (
    <Page
      title="Hairdresser Management"
      backAction={{ onAction: () => navigate('/crm') }}
    >
      {/* Hidden file input for CSV import */}
      <input
        ref={csvInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        onChange={handleCsvFile}
      />

      <Layout>

        {/* ── Add Hairdresser ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingSm" as="h2">Add Hairdresser</Text>
                <Button
                  size="slim"
                  loading={importing}
                  onClick={handleImportClick}
                >
                  Import CSV
                </Button>
              </InlineStack>

              <TextField
                label="Search by name or email"
                value={searchQuery}
                onChange={(val) => { setSearchQuery(val); setSearchError(''); }}
                placeholder="e.g. Jenny or jenny@example.com"
                autoComplete="off"
                clearButton
                onClearButtonClick={() => { setSearchQuery(''); setSearchResults([]); }}
              />

              {searchError && (
                <Banner tone="critical" onDismiss={() => setSearchError('')}>
                  {searchError}
                </Banner>
              )}

              {searching && (
                <InlineStack align="center">
                  <Spinner size="small" />
                </InlineStack>
              )}

              {!searching && searchResults.length > 0 && (
                <BlockStack gap="200">
                  {searchResults.map((c) => {
                    const already = isAlreadyAdded(c.id);
                    return (
                      <div
                        key={c.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 0',
                          borderBottom: '1px solid #e1e3e5',
                        }}
                      >
                        <BlockStack gap="050">
                          <Text variant="bodyMd" fontWeight="semibold">{c.name}</Text>
                          <Text variant="bodySm" tone="subdued">{c.email}{c.phone ? ` · ${c.phone}` : ''}</Text>
                        </BlockStack>
                        <Button
                          size="slim"
                          disabled={already || addingId === c.id}
                          loading={addingId === c.id}
                          onClick={() => handleAdd(c)}
                        >
                          {already ? 'Added' : 'Add'}
                        </Button>
                      </div>
                    );
                  })}
                </BlockStack>
              )}

              {!searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && !searchError && (
                <Text tone="subdued" variant="bodySm">No customers found.</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Hairdresser List ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingSm" as="h2">
                    Hairdressers{!listLoading && (
                      <Text as="span" variant="headingSm" tone="subdued">
                        {' '}(All {totalCount}, with customer {withCustomers}, All customer {totalCustomers})
                      </Text>
                    )}
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Button
                    size="slim"
                    onClick={() => navigate('/crm/hairdressers/settle-commissions')}
                  >
                    Settle Commissions
                  </Button>
                  <Button
                    size="slim"
                    loading={bulkGenerating}
                    onClick={handleBulkGenerate}
                  >
                    Bulk Generate Links
                  </Button>
                </InlineStack>
              </InlineStack>

              {listError && (
                <Banner tone="critical" onDismiss={() => setListError('')}>
                  {listError}
                </Banner>
              )}

              {listLoading ? (
                <InlineStack align="center"><Spinner size="small" /></InlineStack>
              ) : hairdressers.length === 0 ? (
                <EmptyState
                  heading="No hairdressers yet"
                  image=""
                >
                  <p>Search for a customer above and click Add.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text', 'numeric', 'text', 'text']}
                  headings={['Name', 'Email', 'Phone', 'Customers', 'Last link generated', 'Actions']}
                  rows={hairdressers.map((h) => [
                    <Text fontWeight="semibold">{h.name}</Text>,
                    <Text tone="subdued">{h.email || '—'}</Text>,
                    <Text tone="subdued">{h.phone || '—'}</Text>,
                    <Text>{h.bound_customers ?? 0}</Text>,
                    <Text tone="subdued">{formatDate(h.last_generated_at)}</Text>,
                    <InlineStack gap="200">
                      <Button
                        size="slim"
                        onClick={() => navigate(`/crm/hairdressers/${h.id}`)}
                      >
                        View
                      </Button>
                      <Button
                        size="slim"
                        tone="critical"
                        onClick={() => setDeleteTarget({ id: h.id, name: h.name })}
                      >
                        Delete
                      </Button>
                    </InlineStack>,
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>

      {/* ── Delete confirmation modal ── */}
      <Modal
        open={!!deleteTarget}
        onClose={() => { setDeleteTarget(null); setDeleteError(''); }}
        title="Delete hairdresser"
        primaryAction={{
          content: 'Delete',
          destructive: true,
          loading: deleting,
          onAction: handleDeleteConfirm,
        }}
        secondaryActions={[{
          content: 'Cancel',
          onAction: () => { setDeleteTarget(null); setDeleteError(''); },
        }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {deleteError && <Banner tone="critical">{deleteError}</Banner>}
            <Text>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>?
              This will remove all their referral links, customer bindings, and statistics.
              This action cannot be undone.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── CSV import result modal ── */}
      <Modal
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        title="CSV Import Result"
        primaryAction={{ content: 'Done', onAction: () => setShowImportModal(false) }}
      >
        <Modal.Section>
          {importResult?.fatalError ? (
            <Banner tone="critical">{importResult.fatalError}</Banner>
          ) : importResult && (
            <BlockStack gap="300">
              {importResult.added?.length > 0 && (
                <Banner tone="success">
                  {importResult.added.length} hairdresser{importResult.added.length !== 1 ? 's' : ''} added successfully.
                </Banner>
              )}
              {importResult.already_exists?.length > 0 && (
                <BlockStack gap="100">
                  <Text variant="bodyMd" fontWeight="semibold">Already in system ({importResult.already_exists.length})</Text>
                  {importResult.already_exists.map(e => (
                    <Text key={e} variant="bodySm" tone="subdued">{e}</Text>
                  ))}
                </BlockStack>
              )}
              {importResult.not_found?.length > 0 && (
                <BlockStack gap="100">
                  <Text variant="bodyMd" fontWeight="semibold">No Shopify account found ({importResult.not_found.length})</Text>
                  {importResult.not_found.map(e => (
                    <Text key={e} variant="bodySm" tone="subdued">{e}</Text>
                  ))}
                </BlockStack>
              )}
              {importResult.errors?.length > 0 && (
                <BlockStack gap="100">
                  <Text variant="bodyMd" fontWeight="semibold" tone="critical">Errors ({importResult.errors.length})</Text>
                  {importResult.errors.map(({ email, message }) => (
                    <Text key={email} variant="bodySm" tone="critical">{email}: {message}</Text>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>

      {/* ── Bulk generate links result modal ── */}
      <Modal
        open={showBulkModal}
        onClose={() => setShowBulkModal(false)}
        title="Bulk Generate Links"
        primaryAction={{ content: 'Done', onAction: () => setShowBulkModal(false) }}
      >
        <Modal.Section>
          {bulkGenerateResult?.error ? (
            <Banner tone="critical">{bulkGenerateResult.error}</Banner>
          ) : bulkGenerateResult && (
            <Text>
              {bulkGenerateResult.generated > 0
                ? `Referral links generated for ${bulkGenerateResult.generated} hairdresser${bulkGenerateResult.generated !== 1 ? 's' : ''}.`
                : (bulkGenerateResult.message || 'All hairdressers already have links.')}
            </Text>
          )}
        </Modal.Section>
      </Modal>

    </Page>
  );
}

export default HairdresserList;