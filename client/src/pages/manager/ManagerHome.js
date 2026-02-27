import React, { useState, useEffect } from 'react';
import { Page, Layout, Button, BlockStack, Select, Banner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QUE01'
];

function ManagerHome() {
  const navigate = useNavigate();
  const [location, setLocation] = useState('');
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('managerLocation');
    if (saved) setLocation(saved);
  }, []);

  const handleLocationChange = (value) => {
    setLocation(value);
    localStorage.setItem('managerLocation', value);
    setShowWarning(false);
  };

  const handleCountingTasks = () => {
    if (!location) {
      setShowWarning(true);
      return;
    }
    navigate('/manager/counting-tasks');
  };

  const handleZeroQty = () => {
    if (!location) {
      setShowWarning(true);
      return;
    }
    navigate('/manager/zero-qty-report');
  };

  const locationOptions = [
    { label: 'Select location', value: '' },
    ...LOCATIONS.map(l => ({ label: l, value: l }))
  ];

  return (
    <Page title="Manager" backAction={{ onAction: () => navigate('/') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Select
              label="Location"
              options={locationOptions}
              value={location}
              onChange={handleLocationChange}
            />
            {showWarning && (
              <Banner tone="critical">
                Please select a location first.
              </Banner>
            )}
            <Button size="large" fullWidth onClick={handleCountingTasks}>
              Counting tasks
            </Button>
            <Button size="large" fullWidth onClick={handleZeroQty}>
              0 quantity report
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerHome;