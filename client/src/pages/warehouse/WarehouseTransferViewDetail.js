import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Banner, Spinner,
} from '@shopify/polaris';
import { useNavigate, useParams } from 'react-router-dom';
import { StatusBadge, TagPills } from '../shared/transferStatus';

// Read-only transfer detail for Warehouse's "Pick up from store" card
// (2026-10-05, Hera). Those transfers (neither from nor to is HQ) used to be
// unclickable because Warehouse only needs to pick them up, not know what's
// inside — now Warehouse can open one to see the contents, but nothing here
// is actionable: no buttons at all except the back arrow (no Export PDF, no
// Refresh qty, no note, no status actions). Columns are just SKU / Name /
// Transfer qty (confirmed with Hera) — no Wig Number (Warehouse never shows
// it), no Qty loaded. Line items a Buyer edit removed (edit_state 'removed')
// are left out, since they're no longer part of the transfer.
function WarehouseTransferViewDetail() {
  const navigate = useNavigate();
  const { transferId } = useParams();

  const [transfer, setTransfer] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    fetch(`/api/transfers/${transferId}?role=warehouse`)
      .then(async r => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed to load transfer');
        return data;
      })
      .then(data => {
        setTransfer(data.transfer);
        setItems(Array.isArray(data.items) ? data.items : []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [transferId]);

  const back = () => navigate('/warehouse');

  if (loading) {
    return (
      <Page title="Transfer" backAction={{ onAction: back }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }
  if (!transfer) {
    return (
      <Page title="Transfer" backAction={{ onAction: back }}>
        <Layout><Layout.Section>{error && <Banner tone="critical">{error}</Banner>}</Layout.Section></Layout>
      </Page>
    );
  }

  const visibleItems = items
    .filter(i => i.edit_state !== 'removed')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <div style={{ maxWidth: '100vw', overflowX: 'hidden' }}>
      <Page
        title={transfer.shopify_transfer_name || transfer.transfer_no}
        backAction={{ onAction: back }}
        titleMetadata={
          <InlineStack gap="150" blockAlign="center">
            <TagPills tags={transfer.tags} />
            <StatusBadge status={transfer.status} />
          </InlineStack>
        }
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

              <InlineStack gap="600" wrap>
                <BlockStack gap="050">
                  <Text variant="bodySm" tone="subdued">From</Text>
                  <Text fontWeight="bold">{transfer.from_location}</Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text variant="bodySm" tone="subdued">To</Text>
                  <Text fontWeight="bold">{transfer.to_location}</Text>
                </BlockStack>
              </InlineStack>

              <Card>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>SKU</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Name</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6d7175' }}>Transfer qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleItems.map(item => (
                        <tr key={item.id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                          <td style={{ padding: '10px' }}>{item.sku}</td>
                          <td style={{ padding: '10px' }}>{item.name}</td>
                          <td style={{ padding: '10px' }}>{item.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <div style={{ height: 'var(--shopify-safe-area-inset-bottom, 80px)' }} />
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </div>
  );
}

export default WarehouseTransferViewDetail;
