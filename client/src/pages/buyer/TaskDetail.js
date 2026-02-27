import React from 'react';
import { Page } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function TaskDetail() {
  const navigate = useNavigate();
  return (
    <Page title="Task detail" backAction={{ onAction: () => navigate('/buyer/counting-tasks') }}>
      {/* Coming soon */}
    </Page>
  );
}

export default TaskDetail;