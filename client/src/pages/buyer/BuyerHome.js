import React from 'react';
import { Page, Layout, Button, BlockStack } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function BuyerHome() {
  const navigate = useNavigate();
  return (
    <Page title="Buyer" backAction={{ onAction: () => navigate('/') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={() => navigate('/buyer/counting-tasks')}>
              Counting tasks
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/buyer/zero-qty-report')}>
              0 quantity report
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerHome;