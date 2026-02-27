import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Select, Text, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01'
];

function ManagerHome() {
  const navigate = useNavigate();
  const [location, setLocation] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('managerLocation');
    if (saved) {
      setLocation(saved);
      setConfirmed(true);
    }
  }, []);

  const handleConfirmLocation = () => {
    if (!location) {
      setShowWarning(true);
      return;
    }
    localStorage.setItem('managerLocation', location);
    setConfirmed(true);
    setShowWarning(false);
  };

  const handleChangeLocation = () => {
    setConfirmed(false);
    setLocation('');
    localStorage.removeItem('managerLocation');
  };

  const handleNavigate = (path) => {
    if (!confirmed) {
      setShowWarning(true);
      return;
    }
    navigate(path);
  };

  const locationOptions = [
    { label: 'Select location', value: '' },
    ...LOCATIONS.map(l => ({ label: l, value: l })),
  ];

  return (
    <Page title="Manager" backAction={{ onAction: () => navigate('/') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showWarning && (
              <Banner tone="critical" onDismiss={() => setShowWarning(false)}>
                Please select a location first.
              </Banner>
            )}

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm">Location</Text>

                {!confirmed ? (
                  <BlockStack gap="200">
                    <Select
                      label="" labelHidden
                      options={locationOptions}
                      value={location}
                      onChange={(val) => {
                        setLocation(val);
                        setShowWarning(false);
                      }}
                    />
                    <Button variant="primary" onClick={handleConfirmLocation}>
                      Confirm
                    </Button>
                  </BlockStack>
                ) : (
                  <InlineStack align="space-between">
                    <Text variant="bodyLg" fontWeight="bold">{location}</Text>
                    <Button onClick={handleChangeLocation}>Change</Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>

            <Button
              size="large"
              fullWidth
              onClick={() => handleNavigate('/manager/counting-tasks')}
            >
              Counting tasks
            </Button>
            <Button
              size="large"
              fullWidth
              onClick={() => handleNavigate('/manager/zero-qty-report')}
            >
              0 quantity report
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerHome;