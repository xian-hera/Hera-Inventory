import React from 'react';
import { Page } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function CreatingTask() {
  const navigate = useNavigate();
  return (
    <Page title="Creating task" backAction={{ onAction: () => navigate('/buyer/counting-tasks') }}>
      {/* Coming soon */}
    </Page>
  );
}

export default CreatingTask;