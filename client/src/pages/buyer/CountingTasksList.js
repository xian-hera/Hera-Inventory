import React from 'react';
import { Page } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function CountingTasksList() {
  const navigate = useNavigate();
  return (
    <Page title="Counting tasks" backAction={{ onAction: () => navigate('/buyer') }}>
      {/* Coming soon */}
    </Page>
  );
}

export default CountingTasksList;