import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Checkbox, Banner, Spinner, Badge
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const STATUS_PILLS = {
  pending: { label: 'Pending', tone: 'attention' },
  sent_to_store: { label: 'Sent to store', tone: 'info' },
  store_counted: { label: 'Store counted', tone: 'success' },
  committed: { label: 'committed', tone: 'success' },
  // Every invoice auto-archives on commit (item 9) — the archived pill
  // renders identically to the committed one.
  archived: { label: 'committed', tone: 'success' },
};

// Fixed status filter options (item 10) — no longer derived from whatever
// statuses happen to be present in the current result set. 'committed' is a
// permanent legacy synonym for 'archived' (rows written before commits
// started auto-archiving), so it's folded into the "Archived" filter option
// rather than getting its own.
const STATUS_FILTER_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'sent_to_store', label: 'Sent to store' },
  { value: 'store_counted', label: 'Store counted' },
  { value: 'archived', label: 'Archived' },
];
const DEFAULT_STATUS_FILTER = ['pending', 'sent_to_store', 'store_counted'];

function normalizedStatus(inv) {
  const s = inv.status || 'pending';
  return s === 'committed' ? 'archived' : s;
}

function BuyerPOCommitLater() {
  const navigate = useNavigate();

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [committing, setCommitting] = useState(false);
  const [sendingToStore, setSendingToStore] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [search, setSearch] = useState('');

  // Filter card — Status / Location / Supplier, each a multi-select whose
  // own option list is built only from what's actually present in the
  // current (search-matched) result set, not some fixed global list. An
  // empty selection on any of the three means "no filter on that column".
  // The three filters combine with each other, and with the search box,
  // as a plain intersection — every active constraint must match.
  const [statusFilter, setStatusFilter] = useState(DEFAULT_STATUS_FILTER);
  const [locationFilter, setLocationFilter] = useState([]);
  const [supplierFilter, setSupplierFilter] = useState([]);

  // quiet=true skips the full-page loading spinner — used while polling for
  // commit progress so the table doesn't flicker every couple seconds.
  const fetchInvoices = useCallback(async (q, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      const res = await fetch(`/api/po-invoices/pending${params}`);
      const data = await res.json();
      setInvoices(Array.isArray(data) ? data : []);
    } catch (e) {
      setError('Failed to load invoices');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchInvoices(''); }, [fetchInvoices]);

  // Each invoice locks its own commit independently (see
  // acquireInvoiceCommitLock in server/routes/poInvoices.js) — there's no
  // single global "is anything committing" lock — so this only drives the
  // page-wide "It is OK to leave this page" note and the live per-row
  // progress polling; it does NOT block committing OTHER, not-currently-
  // committing invoices.
  const anyCommitting = useMemo(() => invoices.some(inv => inv.committing), [invoices]);

  // Invoices whose last background commit attempt failed (persisted on
  // po_invoices.commit_error by runInvoiceCommit — see
  // server/routes/poInvoices.js) and aren't currently mid-retry. Surfaced
  // both as a summary banner above the table and per-row in the Status
  // column below, since the commit runs server-side and the failure is
  // otherwise invisible to anyone who wasn't watching at the moment it ran.
  const failedInvoices = useMemo(
    () => filteredInvoices.filter(inv => inv.commit_error && !inv.committing),
    [filteredInvoices]
  );

  useEffect(() => {
    if (!anyCommitting) return;
    const interval = setInterval(() => fetchInvoices(search, true), 1500);
    return () => clearInterval(interval);
  }, [anyCommitting, search, fetchInvoices]);

  const handleClearSearch = () => {
    setSearch('');
    setSelectedIds([]);
    fetchInvoices('');
  };

  const locationOptions = useMemo(
    () => [...new Set(invoices.map(inv => inv.location).filter(Boolean))].sort(),
    [invoices]
  );
  const supplierOptions = useMemo(
    () => [...new Set(invoices.map(inv => inv.supplier_name).filter(Boolean))].sort(),
    [invoices]
  );

  const filteredInvoices = useMemo(() => invoices.filter(inv => {
    // Status is now a fixed, always-active multi-select (item 10) — unlike
    // Location/Supplier below, an empty selection here means "show nothing",
    // not "no filter" (there's no dynamic "ALL" placeholder value for it
    // any more).
    if (!statusFilter.includes(normalizedStatus(inv))) return false;
    if (locationFilter.length > 0 && !locationFilter.includes(inv.location)) return false;
    if (supplierFilter.length > 0 && !supplierFilter.includes(inv.supplier_name)) return false;
    return true;
  }), [invoices, statusFilter, locationFilter, supplierFilter]);

  const archivedSelected = statusFilter.includes('archived');
  const isDefaultStatusFilter = statusFilter.length === DEFAULT_STATUS_FILTER.length
    && DEFAULT_STATUS_FILTER.every(s => statusFilter.includes(s));

  // Committing rows can't be (de)selected — they're already locked into the
  // commit that's running for them. Committed/archived rows are read-only
  // history now that this list shows every status (item 6) — nothing left
  // to commit or bulk-delete on them here (use the row's own Delete action
  // on the committed-detail page instead).
  const selectableInvoices = useMemo(
    () => filteredInvoices.filter(i => !i.committing && i.status !== 'committed' && i.status !== 'archived'),
    [filteredInvoices]
  );

  const toggleSelectOne = (id) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll = () =>
    setSelectedIds(selectedIds.length === selectableInvoices.length ? [] : selectableInvoices.map(i => i.id));

  const handleCommit = async (ids) => {
    if (ids.length === 0) return;
    setCommitting(true);
    setError('');
    try {
      // Starts a commit for each eligible invoice and returns immediately —
      // the actual work runs in the background on the server (see POST
      // /api/po-invoices/pending/commit-many). Progress is picked up by the
      // polling effect above, driven off each row's own `committing` flag.
      const res = await fetch('/api/po-invoices/pending/commit-many', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.rejected?.length > 0) {
        setError(
          `${data.rejected.length} invoice(s) could not be started: ` +
          data.rejected.map(s => `${s.invoiceNumber} (${s.reason})`).join(', ')
        );
      }
      setSelectedIds([]);
      fetchInvoices(search);
    } catch (e) {
      setError(e.message);
    } finally {
      setCommitting(false);
    }
  };

  // Bulk "Send Selected to Store" — mirrors handleCommit's shape (fetch,
  // report any rejected ids, clear selection, refetch), but hits the
  // synchronous send-to-store-many endpoint rather than the background
  // commit-many job, since flipping status here needs no Shopify calls.
  const handleSendToStore = async (ids) => {
    if (ids.length === 0) return;
    setSendingToStore(true);
    setError('');
    try {
      const res = await fetch('/api/po-invoices/pending/send-to-store-many', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.rejected?.length > 0) {
        setError(
          `${data.rejected.length} invoice(s) could not be sent to store: ` +
          data.rejected.map(r => `${r.invoiceNumber} (${r.reason})`).join(', ')
        );
      }
      setSelectedIds([]);
      fetchInvoices(search);
    } catch (e) {
      setError(e.message);
    } finally {
      setSendingToStore(false);
    }
  };

  const handleDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedIds.length} invoice(s)? This cannot be undone.`)) return;
    try {
      const res = await fetch('/api/po-invoices/pending', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      if (!res.ok) throw new Error('Delete failed');
      setSelectedIds([]);
      fetchInvoices(search);
    } catch (e) {
      setError(e.message);
    }
  };

  const rows = filteredInvoices.map(inv => [
    <Checkbox
      checked={selectedIds.includes(inv.id)}
      onChange={() => toggleSelectOne(inv.id)}
      disabled={inv.committing || inv.status === 'committed' || inv.status === 'archived'}
    />,
    <BlockStack gap="0">
      <span
        style={{ cursor: 'pointer', textDecoration: 'underline' }}
        onClick={() => navigate(
          (inv.status === 'committed' || inv.status === 'archived')
            ? `/buyer/po-receiving/committed/${inv.id}`
            : `/buyer/po-receiving/pending/${inv.id}`
        )}
      >
        {inv.po_number || inv.invoice_number}
      </span>
      {inv.po_number && inv.invoice_number && (
        <Text variant="bodySm" tone="subdued">Ref: {inv.invoice_number}</Text>
      )}
    </BlockStack>,
    inv.supplier_name,
    inv.location,
    inv.quantity,
    (
      <span style={{ whiteSpace: 'nowrap' }}>
        {inv.supplier_currency === 'USD' && (
          <span style={{ color: '#6d7175', marginRight: '10px' }}>
            USD {Number(inv.subtotal_usd || 0).toFixed(2)}
          </span>
        )}
        {Number(inv.subtotal_cad || 0).toFixed(2)}
      </span>
    ),
    (() => {
      if (inv.committing) {
        return <Text variant="bodySm">{`Committing ${inv.committed_count || 0} / ${inv.item_count || 0}`}</Text>;
      }
      if (inv.commit_error) {
        return <Text tone="critical" variant="bodySm" fontWeight="medium">Commit failed</Text>;
      }
      const p = STATUS_PILLS[inv.status] || STATUS_PILLS.pending;
      return <Badge tone={p.tone}>{p.label}</Badge>;
    })(),
  ]);

  return (
    <Page
      title="Purchase Order List"
      backAction={{ onAction: () => navigate('/buyer/po-receiving') }}
      secondaryActions={[
        { content: 'Delete Selected', destructive: true, disabled: selectedIds.length === 0, onAction: handleDelete },
        { content: 'Send Selected to Store', disabled: selectedIds.length === 0 || sendingToStore, onAction: () => handleSendToStore(selectedIds) },
        { content: 'Commit Selected', disabled: selectedIds.length === 0 || committing, onAction: () => handleCommit(selectedIds) },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
            {anyCommitting && <Text variant="bodySm" tone="subdued">It is OK to leave this page</Text>}

            {failedInvoices.length > 0 && (
              <Banner tone="critical">
                <BlockStack gap="100">
                  {failedInvoices.map(inv => (
                    <Text key={inv.id} variant="bodySm">
                      {(inv.po_number || inv.invoice_number)}: {inv.commit_error}
                    </Text>
                  ))}
                </BlockStack>
              </Banner>
            )}

            <Card>
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label=""
                      labelHidden
                      placeholder="Search by Supplier name, Receiving location, PO number, invoice number, SKU or code"
                      value={search}
                      onChange={setSearch}
                      onKeyDown={(e) => { if (e.key === 'Enter') fetchInvoices(search); }}
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={handleClearSearch}
                    />
                  </div>
                  <Button onClick={() => fetchInvoices(search)}>Search</Button>
                </InlineStack>

                <InlineStack gap="200" wrap>
                  {/* Fixed 4-option status filter (item 10) — widened to 2x
                      the other filters' width so a full comma-separated
                      selection (up to all four labels) still fits. */}
                  <div style={{ minWidth: '280px' }}>
                    <MultiSelectDropdown
                      label="Status"
                      options={STATUS_FILTER_OPTIONS}
                      selected={statusFilter}
                      onChange={setStatusFilter}
                      placeholder="ALL"
                    />
                  </div>
                  <MultiSelectDropdown
                    label="Location"
                    options={locationOptions}
                    selected={locationFilter}
                    onChange={setLocationFilter}
                    placeholder="ALL"
                  />
                  <MultiSelectDropdown
                    label="Supplier"
                    options={supplierOptions}
                    selected={supplierFilter}
                    onChange={setSupplierFilter}
                    placeholder="ALL"
                  />
                  {(!isDefaultStatusFilter || locationFilter.length > 0 || supplierFilter.length > 0) && (
                    <div style={{ paddingTop: '22px' }}>
                      <Button size="slim" onClick={() => { setStatusFilter(DEFAULT_STATUS_FILTER); setLocationFilter([]); setSupplierFilter([]); }}>
                        Clear filters
                      </Button>
                    </div>
                  )}
                </InlineStack>

                {archivedSelected && (
                  <Text tone="critical" variant="bodySm">
                    Archived invoices are saved for 90 days. Beyond will be deleted.
                  </Text>
                )}

                {!loading && (
                  <Text tone="subdued" variant="bodySm">
                    Found {invoices.length} matched{filteredInvoices.length !== invoices.length ? `, ${filteredInvoices.length} shown after filters` : ''}
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              {loading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : filteredInvoices.length === 0 ? (
                <Text tone="subdued" alignment="center">
                  {invoices.length > 0 ? 'No invoice matches the current filters.' : (search ? 'No matching invoice found.' : 'No invoices found.')}
                </Text>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={{ padding: '8px', textAlign: 'left', width: '32px' }}>
                          <Checkbox
                            checked={selectedIds.length === selectableInvoices.length && selectableInvoices.length > 0}
                            indeterminate={selectedIds.length > 0 && selectedIds.length < selectableInvoices.length}
                            onChange={toggleSelectAll}
                          />
                        </th>
                        {['PO Number', 'Supplier', 'Location', 'Quantity', 'Subtotal', 'Status'].map((h, i) => (
                          <th
                            key={i}
                            style={{
                              padding: '8px 10px', textAlign: 'left', fontWeight: '600',
                              color: '#6d7175', whiteSpace: 'nowrap',
                              ...(h === 'Subtotal' ? { minWidth: '150px' } : {}),
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={filteredInvoices[i].id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                          {row.map((cell, j) => (
                            <td key={j} style={{ padding: '10px 10px', verticalAlign: 'top' }}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOCommitLater;
