import React, { useState, useEffect } from 'react';
import { Page, Layout, Button, BlockStack } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

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

function ManagerInventoryCount() {
  const navigate = useNavigate();
  const [weeklyCount, setWeeklyCount] = useState(0);
  const location = localStorage.getItem('managerLocation') || '';

  useEffect(() => {
    if (!location) return;
    fetch(`/api/badges/manager?location=${encodeURIComponent(location)}`)
      .then(r => r.json())
      .then(data => setWeeklyCount(data.weeklyCountingTasks || 0))
      .catch(() => {});
  }, [location]);

  return (
    <Page title="Inventory Count" backAction={{ onAction: () => navigate('/manager') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={() => navigate('/manager/counting-tasks')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Weekly Inventory Count
                <Badge count={weeklyCount} />
              </span>
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/manager/zero-qty-report')}>
              Zero/Low Inventory Count
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerInventoryCount;