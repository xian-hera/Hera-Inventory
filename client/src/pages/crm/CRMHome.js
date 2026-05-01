import React, { useState, useEffect } from 'react';
import { Page, Layout, Button, BlockStack, Text, TextField, Banner, Modal } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const CRM_PIN_VERIFIED_KEY = 'crm_pin_verified';  // { expiry: timestamp }
const PIN_EXPIRY_DAYS      = 30;

function CRMHome() {
  const navigate = useNavigate();

  const [ready, setReady]         = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [pinInput, setPinInput]   = useState('');
  const [pinError, setPinError]   = useState('');
  const [showHint, setShowHint]   = useState(false);
  const [hint, setHint]           = useState('');
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    // Fetch hint from backend
    fetch('/api/settings/pin/hint?key=crm_pin')
      .then(r => r.json())
      .then(data => setHint(data.hint || ''))
      .catch(() => {});

    if (isDeviceVerified()) {
      setReady(true);
    } else {
      setShowModal(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isDeviceVerified = () => {
    try {
      const stored = localStorage.getItem(CRM_PIN_VERIFIED_KEY);
      if (!stored) return false;
      const { expiry } = JSON.parse(stored);
      return Date.now() < expiry;
    } catch (e) { return false; }
  };

  const handleConfirm = async () => {
    setVerifying(true);
    setPinError('');
    try {
      const res = await fetch('/api/settings/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'crm_pin', pin: pinInput }),
      });
      if (res.ok) {
        const expiry = Date.now() + PIN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
        localStorage.setItem(CRM_PIN_VERIFIED_KEY, JSON.stringify({ expiry }));
        setShowModal(false);
        setReady(true);
      } else {
        setPinError('Incorrect PIN. Please try again.');
        setPinInput('');
      }
    } catch (e) {
      setPinError('Network error. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  // Cancel → go back to home
  const handleClose = () => {
    navigate('/');
  };

  return (
    <Page
      title="CRM / Growth"
      backAction={{ onAction: () => navigate('/') }}
      secondaryActions={ready ? [{ content: 'Settings', onAction: () => navigate('/crm/settings') }] : []}
    >
      {ready && (
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Button size="large" fullWidth onClick={() => navigate('/crm/hairdressers')}>
                Hairdresser Management
              </Button>
              <Button size="large" fullWidth onClick={() => navigate('/crm/birthday-reward')}>
                Birthday Reward
              </Button>
              <Button size="large" fullWidth onClick={() => navigate('/crm/influencers')}>
                Influencer Management
              </Button>
            </BlockStack>
          </Layout.Section>
        </Layout>
      )}

      <Modal
        open={showModal}
        onClose={handleClose}
        title="CRM Access"
        primaryAction={{
          content: 'Confirm',
          onAction: handleConfirm,
          disabled: pinInput.length !== 4 || verifying,
          loading: verifying,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: handleClose }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {pinError && (
              <Banner tone="critical" onDismiss={() => setPinError('')}>
                {pinError}
              </Banner>
            )}
            <TextField
              label="Enter PIN"
              type="password"
              value={pinInput}
              onChange={(val) => {
                if (/^\d{0,4}$/.test(val)) setPinInput(val);
                setPinError('');
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && pinInput.length === 4) handleConfirm(); }}
              autoComplete="off"
              maxLength={4}
              placeholder="4-digit PIN"
            />
            <Button variant="plain" onClick={() => setShowHint((v) => !v)}>
              {showHint ? 'Hide hint' : 'Hint'}
            </Button>
            {showHint && (
              <Text variant="bodySm" tone="subdued">
                {hint || 'No hint set.'}
              </Text>
            )}
            <Text variant="bodySm" tone="subdued">
              This device will be remembered for {PIN_EXPIRY_DAYS} days after a successful login.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default CRMHome;