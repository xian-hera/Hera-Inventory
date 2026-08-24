import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Badge, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';

function BuyerPOInvoiceDetail() {
  const navigate = useNavigate();
  const { invoiceId } = useParams();

  const [invoice, setInvoice] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  return (
    <Page
      title={invoice.invoice_number}
      titleMetadata={
        <InlineStack gap="150">
          <Badge tone="success">committed</Badge>
          {invoice.is_promotional && <Badge>Promotional</Badge>}
        </InlineStack>
      }
      backAction={{ onAction: () => navigate('/buyer/po-receiving') }}
      secondaryActions={[{ content: 'Delete', destructive: true, onAction: handleDelete }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

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
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                      {['SKU', 'code', 'name', 'quantity', 'cost'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => (
                      <tr key={it.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                        <td style={{ padding: '10px' }}>{it.sku}</td>
                        <td style={{ padding: '10px' }}>{it.code}</td>
                        <td style={{ padding: '10px' }}>{it.name}</td>
                        <td style={{ padding: '10px' }}>{it.quantity}</td>
                        <td style={{ padding: '10px' }}>
                          {Number(it.cost_before_adjustment).toFixed(2) !== Number(it.effective_cost).toFixed(2) && (
                            <span style={{ textDecoration: 'line-through', color: '#8c9196', fontSize: '11px', marginRight: '6px' }}>
                              {Number(it.cost_before_adjustment).toFixed(2)}
                            </span>
                          )}
                          {Number(it.effective_cost).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOInvoiceDetail;
