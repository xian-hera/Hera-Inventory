import React, { useState, useEffect } from 'react';
import { Page, Layout, Button, BlockStack } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const BADGE_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '20px',
  height: '20px',
  padding: '0 6px',
  borderRadius: '10px',
  background: '#E32A69',
  color: 'white',
  fontSize: '12px',
  fontWeight: '700',
  marginLeft: '8px',
  lineHeight: 1,
};

function Badge({ count }) {
  if (!count) return null;
  return <span style={BADGE_STYLE}>{count}</span>;
}

function BuyerInventoryCount() {
  const navigate = useNavigate();
  const [badges, setBadges] = useState({ weekly: 0, zeroLow: 0 });

  useEffect(() => {
    fetch('/api/badges/buyer')
      .then(r => r.json())
      .then(data => {
        setBadges({
          weekly: data.weeklyReviewing || 0,
          zeroLow: data.zeroLowReviewing || 0,
        });
      })
      .catch(() => {});
  }, []);

  return (
    <Page title="Inventory Count" backAction={{ onAction: () => navigate('/buyer') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={() => navigate('/buyer/counting-tasks')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Weekly Inventory Count
                <Badge count={badges.weekly} />
              </span>
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/buyer/zero-qty-report')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Zero/Low Inventory Count
                <Badge count={badges.zeroLow} />
              </span>
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerInventoryCount;