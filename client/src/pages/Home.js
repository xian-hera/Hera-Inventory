import React from 'react';
import { Page, Layout, Button, BlockStack, Text } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function Home() {
  const navigate = useNavigate();

  return (
    <Page title="Hera Inventory counting">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button
              size="large"
              fullWidth
              onClick={() => navigate('/buyer')}
            >
              Buyer
            </Button>
            <Button
              size="large"
              fullWidth
              onClick={() => navigate('/manager')}
            >
              Manager
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default Home;
