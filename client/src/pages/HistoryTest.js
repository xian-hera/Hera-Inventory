import React, { useState, useEffect } from 'react';
import { Page, Card, BlockStack, Text, Banner, Spinner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const TEST_BARCODE = '827298696117';

function HistoryTest() {
  const navigate = useNavigate();
  const location = localStorage.getItem('managerLocation') || '';

  const [loading, setLoading] = useState(true);
  const [url, setUrl]         = useState(null);
  const [error, setError]     = useState('');

  useEffect(() => {
    const fetch_ = async () => {
      try {
        const locRes  = await fetch('/api/shopify/locations');
        const locData = await locRes.json();
        const loc     = locData.find(l => l.name === location);
        const locationId = loc ? encodeURIComponent(loc.id) : '';

        const res  = await fetch(`/api/shopify/inventory-history/${encodeURIComponent(TEST_BARCODE)}?locationId=${locationId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        setUrl(data.url);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    fetch_();
  }, [location]);

  return (
    <Page title="History Test" backAction={{ onAction: () => navigate('/manager') }}>
      <Card>
        <BlockStack gap="400">
          <Text variant="bodySm" tone="subdued">
            Location: <strong>{location || '(none)'}</strong> · Barcode: <strong>{TEST_BARCODE}</strong>
          </Text>

          {loading && <Spinner />}
          {error && <Banner tone="critical">{error}</Banner>}

          {url && (
            <BlockStack gap="300">
              <div style={{ background: '#f6f6f7', borderRadius: '8px', padding: '12px',
                fontSize: '12px', wordBreak: 'break-all', color: '#6d7175' }}>
                {url}
              </div>

              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'block', textAlign: 'center',
                  padding: '14px', borderRadius: '8px',
                  background: '#005bd3', color: 'white',
                  fontSize: '16px', fontWeight: '600',
                  textDecoration: 'none',
                }}
              >
                Open History ↗
              </a>
            </BlockStack>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}

export default HistoryTest;