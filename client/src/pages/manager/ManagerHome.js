import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Select, Text, Banner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { useLocationMap } from '../shared/locationMap';

// Location list: comes from the shared location map (pages/shared/locationMap.js,
// 2026-09-24). The hardcoded 19-code LOCATIONS constant that used to live here
// (this device's "Select location" dropdown) was removed. A location already
// saved on this device (localStorage 'managerLocation') is unaffected.

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
  const [location, setLocation]       = useState('');
  const { names: locationNames, error: locationsError } = useLocationMap();
  const [confirmed, setConfirmed]     = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [badges, setBadges]           = useState({ inventoryCount: 0, labelPrint: 0, poReceiving: 0, transfer: 0 });

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
          labelPrint:     data.labelPrintTasks     || 0,
          poReceiving:    data.poReceivingTasks     || 0,
          transfer:       data.transferTasks        || 0,
        });
      })
      .catch(() => {});
  }, [confirmed, location]);

  const handleConfirmLocation = () => {
    if (!location) { setShowWarning(true); return; }
    localStorage.setItem('managerLocation', location);
    setConfirmed(true);
    setShowWarning(false);
  };

  const handleChangeLocation = () => {
    setConfirmed(false);
    setLocation('');
    localStorage.removeItem('managerLocation');
    setBadges({ inventoryCount: 0, labelPrint: 0, poReceiving: 0, transfer: 0 });
  };

  const handleNavigate = (path) => {
    if (!confirmed) { setShowWarning(true); return; }
    navigate(path);
  };

  const locationOptions = [
    { label: 'Select location', value: '' },
    ...locationNames.map(l => ({ label: l, value: l })),
  ];

  return (
    <Page title="Task" backAction={{ onAction: () => navigate('/') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {locationsError && !confirmed && (
              <Banner tone="critical">Could not load the location list: {locationsError}</Banner>
            )}
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
                      onChange={(val) => { setLocation(val); setShowWarning(false); }}
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

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/inventory-count')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Inventory Count
                <Badge count={badges.inventoryCount} />
              </span>
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/wig-demo')}>
              Demo Wig
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/stock-losses')}>
              Stock Loss
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/restock-plan')}>
              Restock
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/po-receiving')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                PO Receiving
                <Badge count={badges.poReceiving} />
              </span>
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/transfer')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Transfer
                <Badge count={badges.transfer} />
              </span>
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/label-print')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Label Print
                <Badge count={badges.labelPrint} />
              </span>
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/employee-cap')}>
              Employee Cap
            </Button>

          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Bottom safe-area spacer (2026-09-18, Hera): same fix as
          ManagerWigDemo.js — on Android, opening this page inside Shopify's
          own app leaves the last button sitting right under Shopify's
          native bottom button/nav bar, unreachable to tap. See the
          .mobile-bottom-safe-area comment in client/public/index.html for
          the full explanation; only takes effect on phone-width screens. */}
      <div className="mobile-bottom-safe-area" aria-hidden="true" />
    </Page>
  );
}

export default ManagerHome;