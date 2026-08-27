import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Badge, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import InfoTooltip from '../../components/InfoTooltip';

const EFFECTIVE_COST_TOOLTIP_USD = `effective cost = invoice cost + adjustment + unit discount + converted to CAD`;
const EFFECTIVE_COST_TOOLTIP_CAD = `effective cost = invoice cost + adjustment + unit discount`;

function BuyerPOInvoiceDetail() {
  const navigate = useNavigate();
  const { invoiceId } = useParams();

  const [invoice, setInvoice] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exportingCsv, setExportingCsv] = useState(false);
  // Which stored cost field ('invoice_cost' | 'effective_cost') to compare
  // against Supplier cost for the highlight treatment — configured in
  // Settings, separately per supplier currency. Read at render time, so a
  // Settings change immediately changes how this already-committed invoice
  // is displayed too.
  const [costComparison, setCostComparison] = useState({ cad: 'invoice_cost', usd: 'invoice_cost' });

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/po-invoices/committed/${invoiceId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setInvoice(data.invoice);
        setItems(data.items);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
    fetch('/api/po-settings/cost-comparison')
      .then(r => r.json())
      .then(data => setCostComparison({ cad: data.cad || 'invoice_cost', usd: data.usd || 'invoice_cost' }))
      .catch(() => {});
  }, [invoiceId]);

  const handleDelete = async () => {
    if (!window.confirm('Delete this invoice record? This only removes the local history — it does not reverse the Shopify inventory or cost changes already made. This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/po-invoices/committed/${invoiceId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      navigate('/buyer/po-receiving');
    } catch (e) {
      setError(e.message);
    }
  };

  const handleExportCsv = async () => {
    if (!invoiceId) return;
    setExportingCsv(true);
    setError('');
    try {
      const res = await fetch(`/api/po-invoices/${invoiceId}/export-csv`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(invoice && (invoice.po_number || invoice.invoice_number)) || 'invoice'}-export.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setExportingCsv(false);
    }
  };

  if (loading) {
    return (
      <Page title="Invoice" backAction={{ onAction: () => navigate('/buyer/po-receiving') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }
  if (!invoice) {
    return (
      <Page title="Invoice" backAction={{ onAction: () => navigate('/buyer/po-receiving') }}>
        <Layout><Layout.Section>{error && <Banner tone="critical">{error}</Banner>}</Layout.Section></Layout>
      </Page>
    );
  }

  const isUsdSupplier = invoice.supplier_currency === 'USD';

  // Comparison only ever happens when BOTH Invoice cost and Supplier cost are
  // real values — a row with no CSV cost (fallback-derived, raw_cost null)
  // is never compared/highlighted, regardless of which field Settings has
  // configured for this currency to compare against.
  const isHighlighted = (it) => {
    if (it.raw_cost === null || it.raw_cost === undefined) return false;
    if (it.supplier_cost_raw === null || it.supplier_cost_raw === undefined) return false;
    const mode = isUsdSupplier ? costComparison.usd : costComparison.cad;
    const compareField = mode === 'effective_cost' ? it.effective_cost : it.raw_cost;
    if (compareField === null || compareField === undefined) return false;
    return Number(compareField).toFixed(2) !== Number(it.supplier_cost_raw).toFixed(2);
  };

  // Priority: missing SKU first (shouldn't occur on a committed invoice, but
  // kept for consistency with the Import page's ordering), then a cost
  // mismatch highlighted row, then everything else.
  const sortedItems = [...items].sort((a, b) => {
    const missingDiff = (b.is_missing ? 1 : 0) - (a.is_missing ? 1 : 0);
    if (missingDiff !== 0) return missingDiff;
    return (isHighlighted(b) ? 1 : 0) - (isHighlighted(a) ? 1 : 0);
  });
  const subtotalCad = items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.effective_cost) || 0), 0);
  const subtotalUsd = isUsdSupplier
    ? items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.raw_cost) || 0), 0)
    : null;

  return (
    <Page
      title={invoice.po_number || invoice.invoice_number}
      titleMetadata={
        <InlineStack gap="150">
          <Badge tone="success">committed</Badge>
          {invoice.is_promotional && <Badge>Promotional</Badge>}
        </InlineStack>
      }
      backAction={{ onAction: () => navigate('/buyer/po-receiving') }}
      secondaryActions={[
        { content: 'Export CSV', onAction: handleExportCsv, loading: exportingCsv, disabled: exportingCsv },
        { content: 'Delete', destructive: true, onAction: handleDelete },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            {invoice.po_number && invoice.invoice_number && (
              <Text tone="subdued" variant="bodySm">Ref: {invoice.invoice_number}</Text>
            )}

            <InlineStack gap="500" wrap>
              <Text>{invoice.supplier_name}</Text>
              <Text tone="subdued">{invoice.supplier_currency}</Text>
              <Text tone="subdued">{invoice.supplier_currency === 'USD' ? invoice.fx_rate : '/'}</Text>
              <Text tone="subdued">{(invoice.product_types || []).join(', ')}</Text>
              <Text tone="subdued">{invoice.location}</Text>
            </InlineStack>
            {invoice.adjustment_type && (
              <Text tone="subdued">
                Adjustment: {invoice.adjustment_type === 'percentage' ? `${invoice.adjustment_value}%` : `$${invoice.adjustment_value}`}
              </Text>
            )}

            <Card>
              <BlockStack gap="200">
                <InlineStack align="end" gap="400">
                  {isUsdSupplier && (
                    <Text tone="subdued" variant="bodySm">USD subtotal: {subtotalUsd.toFixed(2)}</Text>
                  )}
                  <Text variant="bodyMd" fontWeight="bold">CAD subtotal: {subtotalCad.toFixed(2)}</Text>
                </InlineStack>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        {['SKU', 'code', 'name', 'quantity'].map(h => (
                          <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{h}</th>
                        ))}
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Invoice cost</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>
                          <InfoTooltip text={isUsdSupplier ? EFFECTIVE_COST_TOOLTIP_USD : EFFECTIVE_COST_TOOLTIP_CAD}>
                            effective cost
                          </InfoTooltip>
                        </th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Supplier cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedItems.map((it) => {
                        const highlighted = isHighlighted(it);
                        const compareMode = isUsdSupplier ? costComparison.usd : costComparison.cad;
                        const hasRawCost = it.raw_cost !== null && it.raw_cost !== undefined;
                        const hasEffectiveCost = it.effective_cost !== null && it.effective_cost !== undefined;
                        const rawCostCad = isUsdSupplier && hasRawCost ? Number(it.raw_cost) * Number(invoice.fx_rate || 1) : null;
                        const showStrike = isUsdSupplier && rawCostCad !== null && hasEffectiveCost
                          && rawCostCad.toFixed(2) !== Number(it.effective_cost).toFixed(2);
                        return (
                          <tr key={it.id} style={{ borderBottom: '1px solid #f1f1f1', background: highlighted ? '#fff8e1' : undefined }}>
                            <td style={{ padding: '10px' }}>{it.sku}</td>
                            <td style={{ padding: '10px' }}>{it.code}</td>
                            <td style={{ padding: '10px' }}>{it.name}</td>
                            <td style={{ padding: '10px' }}>{it.quantity}</td>
                            <td style={{ padding: '10px', fontWeight: highlighted && compareMode === 'invoice_cost' ? 'bold' : undefined }}>
                              {hasRawCost ? Number(it.raw_cost).toFixed(2) : '—'}
                            </td>
                            <td style={{ padding: '10px', fontWeight: highlighted && compareMode === 'effective_cost' ? 'bold' : undefined }}>
                              {!hasEffectiveCost ? (
                                <Text tone="critical">missing</Text>
                              ) : (
                                <>
                                  {showStrike && (
                                    <span style={{ textDecoration: 'line-through', color: '#8c9196', fontSize: '11px', marginRight: '6px' }}>
                                      {rawCostCad.toFixed(2)}
                                    </span>
                                  )}
                                  {Number(it.effective_cost).toFixed(2)}
                                </>
                              )}
                            </td>
                            <td style={{ padding: '10px', fontWeight: highlighted ? 'bold' : undefined }}>
                              {it.supplier_cost_raw !== null && it.supplier_cost_raw !== undefined ? Number(it.supplier_cost_raw).toFixed(2) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOInvoiceDetail;
