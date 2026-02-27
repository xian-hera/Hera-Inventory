import React from 'react';
import { Page } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function PreviewTask() {
  const navigate = useNavigate();
  return (
    <Page title="Preview task" backAction={{ onAction: () => navigate('/buyer/counting-tasks/new') }}>
      {/* Coming soon */}
    </Page>
  );
}

export default PreviewTask;