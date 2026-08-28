import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack, Text, TextField, Checkbox, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function BuyerPOCommitLater() {
  const navigate = useNavigate();

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [committing, setCommitting] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [search, setSearch] = useState('');

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

  const toggleSelectOne = (id) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll = () =>
    setSelectedIds(selectedIds.length === invoices.length ? [] : invoices.map(i => i.id));

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

  const rows = invoices.map(inv => [
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
    Number(inv.subtotal_cad || 0).toFixed(2),
  ]);

  return (
    <Page
      title="Commit later"
      backAction={{ onAction: () => navigate('/buyer/po-receiving') }}
      secondaryActions={[
        { content: 'Delete selected', destructive: true, disabled: selectedIds.length === 0, onAction: handleDelete },
        { content: 'Commit all', disabled: invoices.length === 0 || committing, onAction: () => handleCommit(invoices.map(i => i.id)) },
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
                {!loading && <Text tone="subdued" variant="bodySm">Found {invoices.length} matched</Text>}
              </BlockStack>
            </Card>

            <Card>
              {loading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : invoices.length === 0 ? (
                <Text tone="subdued" alignment="center">
                  {search ? 'No matching invoice found.' : 'No invoices waiting to be committed.'}
                </Text>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={{ padding: '8px', textAlign: 'left', width: '32px' }}>
                          <Checkbox
                            checked={selectedIds.length === invoices.length && invoices.length > 0}
                            indeterminate={selectedIds.length > 0 && selectedIds.length < invoices.length}
                            onChange={toggleSelectAll}
                          />
                        </th>
                        {['PO number', 'Supplier', 'Location', 'Quantity', 'Subtotal'].map((h, i) => (
                          <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={invoices[i].id} style={{ borderBottom: '1px solid #f1f1f1' }}>
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
