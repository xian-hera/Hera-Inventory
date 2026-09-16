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

function BuyerTransfer() {
  const navigate = useNavigate();
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/transfers/recent')
      .then(r => r.json())
      .then(data => setRecent(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <Page
      title="Transfer"
      backAction={{ onAction: () => navigate('/buyer') }}
      primaryAction={{ content: 'Settings', onAction: () => navigate('/buyer/transfer/settings') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={() => navigate('/buyer/transfer/create')}>
              Create Transfer
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/buyer/transfer/ongoing')}>
              Ongoing Transfer
            </Button>

            {/* ═══ TEMP TOOL — Wig Cancel Test (see claude/TRANSFER_FEATURE_SPEC.md
                第 14 节). Delete this whole block, plus CsvCancelTestTool.js,
                the /buyer/transfer/csv-cancel-test route in App.js, and the
                matching TEMP TOOL block in server/routes/transfers.js, to
                remove this feature entirely. ═══ */}
            <Button size="large" fullWidth tone="critical" onClick={() => navigate('/buyer/transfer/csv-cancel-test')}>
              Wig Cancel Test (Temp Tool)
            </Button>
            {/* ═══ TEMP TOOL END ═══ */}

            <Card>
              <BlockStack gap="300">
                {loading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : recent.length === 0 ? (
                  <Text tone="subdued">No committed transfers yet.</Text>
                ) : (
                  recent.map((tr, idx) => (
                    <div
                      key={tr.id}
                      style={idx > 0 ? { borderTop: '1px solid #f1f1f1', paddingTop: '12px' } : undefined}
                    >
                      <InlineStack gap="300" blockAlign="center" wrap>
                        <Text variant="bodySm" tone="subdued">{formatDate(tr.committed_at)}</Text>
                        <Text variant="bodySm" tone="subdued">
                          {tr.from_location} to {tr.to_location}
                        </Text>
                        <Text
                          variant="bodySm"
                          as="span"
                          fontWeight="medium"
                        >
                          <span
                            style={{ cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' }}
                            onClick={() => navigate(`/buyer/transfer/${tr.id}`)}
                          >
                            {tr.transfer_no}
                          </span>
                        </Text>
                        {tr.shopify_transfer_url ? (
                          <a
                            href={tr.shopify_transfer_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: '13px', fontWeight: 600, textDecoration: 'underline', whiteSpace: 'nowrap' }}
                          >
                            {tr.shopify_transfer_name || tr.shopify_transfer_id}
                          </a>
                        ) : (
                          <Text variant="bodySm" tone="subdued">{tr.shopify_transfer_name || tr.shopify_transfer_id}</Text>
                        )}
                        <Text variant="bodySm" tone="subdued">committed</Text>
                      </InlineStack>
                    </div>
                  ))
                )}
                {!loading && recent.length > 0 && (
                  <InlineStack align="end">
                    <span
                      style={{ cursor: 'pointer', textDecoration: 'underline', fontSize: '14px' }}
                      onClick={() => navigate('/buyer/transfer/history')}
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

export default BuyerTransfer;
