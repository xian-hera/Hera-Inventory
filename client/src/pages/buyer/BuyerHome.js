import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Button, BlockStack, Banner
} from '@shopify/polaris';
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

function ExclamationBadge() {
  return <span style={BADGE_STYLE}>!</span>;
}

function BuyerHome() {
  const navigate = useNavigate();

  const [badges, setBadges] = useState({
    inventoryCount: 0,
    stockLosses: 0,
    priceChangeAlert: false,
  });

  useEffect(() => {
    fetch('/api/badges/buyer')
      .then(r => r.json())
      .then(data => {
        setBadges({
          inventoryCount: (data.weeklyReviewing || 0) + (data.zeroLowReviewing || 0),
          stockLosses: data.stockLossesReviewing || 0,
          priceChangeAlert: data.priceChangeAlert || false,
        });
      })
      .catch(() => {});
  }, []);

  return (
    <Page title="Task" backAction={{ onAction: () => navigate('/') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* Inventory Count */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/inventory-count')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Inventory Count
                <Badge count={badges.inventoryCount} />
              </span>
            </Button>

            {/* Stock Losses */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/stock-losses')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Stock Losses
                <Badge count={badges.stockLosses} />
              </span>
            </Button>

            {/* Price Change */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/price-change')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Price Change
                {badges.priceChangeAlert && <ExclamationBadge />}
              </span>
            </Button>

            {/* Settings */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/settings')}>
              Settings
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerHome;