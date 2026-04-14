import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Select, Text, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01','HQ'
];

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

function ManagerHome() {
  const navigate = useNavigate();
  const [location, setLocation]     = useState('');
  const [confirmed, setConfirmed]   = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [badges, setBadges]         = useState({
    inventoryCount: 0,
    labelPrint: 0,
  });

  useEffect(() => {
    const saved = localStorage.getItem('managerLocation');
    if (saved) {
      setLocation(saved);
      setConfirmed(true);
    }
  }, []);

  useEffect(() => {
    if (!confirmed || !location) return;
    fetch(`/api/badges/manager?location=${encodeURIComponent(location)}`)
      .then(r => r.json())
      .then(data => {
        setBadges({
          inventoryCount: data.weeklyCountingTasks || 0,
          labelPrint: data.labelPrintTasks || 0,
        });
      })
      .catch(() => {});
  }, [confirmed, location]);

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
    setBadges({ inventoryCount: 0, labelPrint: 0 });
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

            {/* Inventory Count */}
            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/inventory-count')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Inventory Count
                <Badge count={badges.inventoryCount} />
              </span>
            </Button>

            {/* Restock */}
            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/restock-plan')}>
              Restock
            </Button>

            {/* Label Print */}
            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/label-print')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Label Print
                <Badge count={badges.labelPrint} />
              </span>
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerHome;