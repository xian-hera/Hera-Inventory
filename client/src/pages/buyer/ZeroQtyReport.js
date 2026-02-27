import React from 'react';
import { Page } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function ZeroQtyReport() {
  const navigate = useNavigate();
  return (
    <Page title="0 quantity report" backAction={{ onAction: () => navigate('/buyer') }}>
      {/* Coming soon */}
    </Page>
  );
}

export default ZeroQtyReport;