import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Button, BlockStack, Card, Text, InlineStack, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// BOX PO home (see claude/BOX_PO_FEATURE_SPEC.md): Create BOX PO / Ongoing
// BOX PO buttons, plus the last 30 confirmed tasks with a View all -> Past
// BOX PO (90-day retention, see /api/box-po/past).
function BuyerBoxPO() {
  const navigate = useNavigate();
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/box-po/recent')
      .then(r => r.json())
      .then(data => setRecent(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <Page title="BOX PO" backAction={{ onAction: () => navigate('/buyer/po-receiving') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving/box-po/create')}>
              Create BOX PO
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving/box-po/ongoing')}>
              Ongoing BOX PO
            </Button>

            <Card>
              <BlockStack gap="300">
                {loading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : recent.length === 0 ? (
                  <Text tone="subdued">No confirmed BOX PO tasks yet.</Text>
                ) : (
                  recent.map((bp, idx) => (
                    <div
                      key={bp.id}
                      onClick={() => navigate(`/buyer/po-receiving/box-po/${bp.id}`)}
                      style={{
                        cursor: 'pointer',
                        ...(idx > 0 ? { borderTop: '1px solid #f1f1f1', paddingTop: '12px' } : {}),
                      }}
                    >
                      <InlineStack gap="300" blockAlign="center" wrap>
                        <Text variant="bodySm" tone="subdued">{formatDate(bp.confirmed_at)}</Text>
                        <Text variant="bodySm" tone="subdued">{bp.supplier_name}</Text>
                        <Text variant="bodySm" as="span" fontWeight="bold">{bp.box_po_number}</Text>
                        <Text variant="bodySm" tone="subdued">confirmed</Text>
                      </InlineStack>
                    </div>
                  ))
                )}
                {!loading && recent.length > 0 && (
                  <InlineStack align="end">
                    <span
                      style={{ cursor: 'pointer', textDecoration: 'underline', fontSize: '14px' }}
                      onClick={() => navigate('/buyer/po-receiving/box-po/past')}
                    >
                      View all
                    </span>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerBoxPO;
