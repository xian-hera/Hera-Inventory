import React, { useState, useEffect } from 'react';
import { Page, Layout, Button, BlockStack } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { useGroupContext } from '../../userGroup';

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

// Add New Arrival modal (2026-09-29 … 2026-10-08) moved on 2026-10-21 (Hera) to
// AddNewArrivalModal.js — opened from the New Products page's top-right button.

function BuyerHome() {
  const navigate = useNavigate();
  const groupCtx = useGroupContext();

  const [badges, setBadges] = useState({
    weekly: 0,
    zeroLow: 0,
    stockLosses: 0,
    priceChangeAlert: false,
  });

  useEffect(() => {
    fetch('/api/badges/buyer')
      .then(r => r.json())
      .then(data => {
        setBadges({
          weekly: data.weeklyReviewing || 0,
          zeroLow: data.zeroLowReviewing || 0,
          stockLosses: data.stockLossesReviewing || 0,
          priceChangeAlert: data.priceChangeAlert || false,
        });
      })
      .catch(() => {});
  }, []);

  return (
    // 2026-10-21 (Hera): title "Task" → "Purchasing". The top-right Import Products
    // split button (Import Products + Add New Arrival) is gone — see the "New Product"
    // button at the bottom and the New Products page. Settings moved here from the bottom.
    <Page
      title="Purchasing"
      backAction={{ onAction: () => navigate('/') }}
      secondaryActions={[{ content: 'Settings', onAction: () => navigate('/buyer/settings') }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* 2026-10-21 (Hera): the two Inventory Count buttons moved here from the
                Inventory Count page (route /buyer/inventory-count is kept, not linked). */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/counting-tasks')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Weekly Inventory Count
                <Badge count={badges.weekly} />
              </span>
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/buyer/zero-qty-report')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Manual Inventory Count
                <Badge count={badges.zeroLow} />
              </span>
            </Button>

            {/* Stock Losses */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/stock-losses')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Stock Loss
                <Badge count={badges.stockLosses} />
              </span>
            </Button>

            {/* PO Receiving */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving')}>
              Purchase Orders
            </Button>

            {/* Transfers (2026-10-15, Hera: was "Transfer") */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/transfer')}>
              Transfers
            </Button>

            {/* Price Change */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/price-change')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Price Change
                {badges.priceChangeAlert && <ExclamationBadge />}
              </span>
            </Button>

            {/* Demo Wig (2026-09-17, Hera: rename "Wig DEMO" to "Wig - Demo"
                and move it to just before Settings; 2026-10-09: renamed to "Demo Wig") */}
            {/* 2026-10-15 (Hera): treated as Type WIG for user groups — hidden
                when WIG belongs to another group; shown for the group that has
                WIG, for ALL / no group, and when WIG is in no group. Only the
                button is hidden (the page itself is not blocked). */}
            {groupCtx.ready && groupCtx.typeAllowed('WIG') && (
              <Button size="large" fullWidth onClick={() => navigate('/buyer/wig-demo')}>
                Demo Wig
              </Button>
            )}

            {/* New Product (2026-10-21, Hera): opens the page the top-right Import Products button used to open */}
            <Button size="large" fullWidth onClick={() => navigate('/buyer/import-products')}>
              New Product
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerHome;