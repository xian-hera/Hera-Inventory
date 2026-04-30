import React, { useState, useEffect, useCallback } from 'react';
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
      <Layout>

        {/* ── Add Hairdresser ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingSm" as="h2">Add Hairdresser</Text>
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
              <Text variant="headingSm" as="h2">Hairdressers</Text>

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
                  columnContentTypes={['text', 'text', 'text', 'text', 'text']}
                  headings={['Name', 'Email', 'Phone', 'Last link generated', 'Actions']}
                  rows={hairdressers.map((h) => [
                    <Text fontWeight="semibold">{h.name}</Text>,
                    <Text tone="subdued">{h.email || '—'}</Text>,
                    <Text tone="subdued">{h.phone || '—'}</Text>,
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
    </Page>
  );
}

export default HairdresserList;