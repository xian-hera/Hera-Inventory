import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Checkbox, Banner, Spinner, Badge
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const STATUS_PILLS = {
  pending: { label: 'Commit later', tone: 'attention' },
  sent_to_store: { label: 'Sent to store', tone: 'info' },
  store_counted: { label: 'Store counted', tone: 'success' },
};

function BuyerPOCommitLater() {
  const navigate = useNavigate();

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [committing, setCommitting] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [search, setSearch] = useState('');

  // Filter card — Status / Location / Supplier, each a multi-select whose
  // own option list is built only from what's actually present in the
  // current (search-matched) result set, not some fixed global list. An
  // empty selection on any of the three means "no filter on that column".
  // The three filters combine with each other, and with the search box,
  // as a plain intersection — every active constraint must match.
  const [statusFilter, setStatusFilter] = useState([]);
  const [locationFilter, setLocationFilter] = useState([]);
  const [supplierFilter, setSupplierFilter] = useState([]);

  const fetchInvoices = useCallback(async (q) => {
    setLoading(true);
    try {
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      const res = await fetch(`/api/po-invoices/pending${params}`);
      const data = await res.json();
      setInvoices(Array.isArray(data) ? data : []);
    } catch (e) {
      setError('Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchInvoices(''); }, [fetchInvoices]);

  const handleClearSearch = () => {
    setSearch('');
    setSelectedIds([]);
    fetchInvoices('');
  };

  const statusOptions = useMemo(() => {
    const seen = new Set(invoices.map(inv => inv.status || 'pending'));
    return [...seen].map(s => ({ value: s, label: (STATUS_PILLS[s] || STATUS_PILLS.pending).label }));
  }, [invoices]);
  const locationOptions = useMemo(
    () => [...new Set(invoices.map(inv => inv.location).filter(Boolean))].sort(),
    [invoices]
  );
  const supplierOptions = useMemo(
    () => [...new Set(invoices.map(inv => inv.supplier_name).filter(Boolean))].sort(),
    [invoices]
  );

  const filteredInvoices = useMemo(() => invoices.filter(inv => {
    if (statusFilter.length > 0 && !statusFilter.includes(inv.status || 'pending')) return false;
    if (locationFilter.length > 0 && !locationFilter.includes(inv.location)) return false;
    if (supplierFilter.length > 0 && !supplierFilter.includes(inv.supplier_name)) return false;
    return true;
  }), [invoices, statusFilter, locationFilter, supplierFilter]);

  const toggleSelectOne = (id) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll = () =>
    setSelectedIds(selectedIds.length === filteredInvoices.length ? [] : filteredInvoices.map(i => i.id));

  const handleCommit = async (ids) => {
    if (ids.length === 0) return;
    setCommitting(true);
    setError('');
    try {
      const res = await fetch('/api/po-invoices/pending/commit-many', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.skipped?.length > 0) {
        setError(
          `Skipped ${data.skipped.length} invoice(s) because of missing SKU or a SKU collision: ` +
          data.skipped.map(s => s.invoiceNumber).join(', ')
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
    <Checkbox checked={selectedIds.includes(inv.id)} onChange={() => toggleSelectOne(inv.id)} />,
    <BlockStack gap="0">
      <span
        style={{ cursor: 'pointer', textDecoration: 'underline' }}
        onClick={() => navigate(`/buyer/po-receiving/pending/${inv.id}`)}
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
    (() => { const p = STATUS_PILLS[inv.status] || STATUS_PILLS.pending; return <Badge tone={p.tone}>{p.label}</Badge>; })(),
  ]);

  return (
    <Page
      title="Commit later"
      backAction={{ onAction: () => navigate('/buyer/po-receiving') }}
      secondaryActions={[
        { content: 'Delete selected', destructive: true, disabled: selectedIds.length === 0, onAction: handleDelete },
        { content: 'Commit all', disabled: filteredInvoices.length === 0 || committing, onAction: () => handleCommit(filteredInvoices.map(i => i.id)) },
        { content: 'Commit selected', disabled: selectedIds.length === 0 || committing, onAction: () => handleCommit(selectedIds) },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

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
                  <MultiSelectDropdown
                    label="Status"
                    options={statusOptions}
                    selected={statusFilter}
                    onChange={setStatusFilter}
                    placeholder="ALL"
                  />
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
                  {(statusFilter.length > 0 || locationFilter.length > 0 || supplierFilter.length > 0) && (
                    <div style={{ paddingTop: '22px' }}>
                      <Button size="slim" onClick={() => { setStatusFilter([]); setLocationFilter([]); setSupplierFilter([]); }}>
                        Clear filters
                      </Button>
                    </div>
                  )}
                </InlineStack>

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
                  {invoices.length > 0 ? 'No invoice matches the current filters.' : (search ? 'No matching invoice found.' : 'No invoices waiting to be committed.')}
                </Text>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={{ padding: '8px', textAlign: 'left', width: '32px' }}>
                          <Checkbox
                            checked={selectedIds.length === filteredInvoices.length && filteredInvoices.length > 0}
                            indeterminate={selectedIds.length > 0 && selectedIds.length < filteredInvoices.length}
                            onChange={toggleSelectAll}
                          />
                        </th>
                        {['PO number', 'Supplier', 'Location', 'Quantity', 'Subtotal', 'Status'].map((h, i) => (
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
