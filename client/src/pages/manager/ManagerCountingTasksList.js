import React from 'react';
import { Page } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function ManagerCountingTasksList() {
  const navigate = useNavigate();
  return (
    <Page title="Counting tasks" backAction={{ onAction: () => navigate('/manager') }}>
      {/* Coming soon */}
    </Page>
  );
}

export default ManagerCountingTasksList;