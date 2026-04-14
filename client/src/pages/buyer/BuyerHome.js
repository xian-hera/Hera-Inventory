import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Button, BlockStack, TextField, Banner, Modal, Text
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
// import BuyerNav from '../../components/BuyerNav';

const PIN_CONFIG_KEY   = 'buyer_pin_config';
const DEFAULT_PIN      = '3591';

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

  const [pinConfig, setPinConfig] = useState({ pin: DEFAULT_PIN, hint: '' });
  const [badges, setBadges] = useState({
    inventoryCount: 0,
    priceChangeAlert: false,
  });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(PIN_CONFIG_KEY);
      if (stored) setPinConfig(JSON.parse(stored));
    } catch (e) {}
  }, []);

  useEffect(() => {
    fetch('/api/badges/buyer')
      .then(r => r.json())
      .then(data => {
        setBadges({
          inventoryCount: (data.weeklyReviewing || 0) + (data.zeroLowReviewing || 0) + (data.stockLossesReviewing || 0),
          priceChangeAlert: data.priceChangeAlert || false,
        });
      })
      .catch(() => {});
  }, []);

  return (
    <Page title="Purchasing" backAction={{ onAction: () => navigate('/') }}>
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