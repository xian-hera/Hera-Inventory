import React from 'react';
import {
  Page, Layout, Button, BlockStack
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function BuyerPOReceiving() {
  const navigate = useNavigate();

  return (
    <Page
      title="Receiving PO"
      backAction={{ onAction: () => navigate('/buyer') }}
      secondaryActions={[{ content: 'BOX PO', onAction: () => navigate('/buyer/po-receiving/box-po') }]}
      primaryAction={{ content: 'Settings', onAction: () => navigate('/buyer/po-receiving/settings') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving/import')}>
              Create New Purchase Order
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving/commit-later')}>
              Purchase Order List
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/buyer/po-receiving/suppliers')}>
              Supplier Management
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerPOReceiving;
