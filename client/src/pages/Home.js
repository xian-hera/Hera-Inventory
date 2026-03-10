import React, { useState, useEffect } from 'react';
import { Page, Layout, Button, BlockStack, Text, TextField, Banner, Modal } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const PIN_VERIFIED_KEY = 'buyer_pin_verified';   // { expiry: timestamp }
const PIN_CONFIG_KEY   = 'buyer_pin_config';     // { pin, hint }
const PIN_EXPIRY_DAYS  = 30;
const DEFAULT_PIN      = '3591';

function Home() {
  const navigate = useNavigate();
  const [showModal, setShowModal]   = useState(false);
  const [pinInput, setPinInput]     = useState('');
  const [pinError, setPinError]     = useState('');
  const [showHint, setShowHint]     = useState(false);
  const [pinConfig, setPinConfig]   = useState({ pin: DEFAULT_PIN, hint: '' });

  // Load PIN config from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(PIN_CONFIG_KEY);
      if (stored) setPinConfig(JSON.parse(stored));
    } catch (e) {}
  }, []);

  const isDeviceVerified = () => {
    try {
      const stored = localStorage.getItem(PIN_VERIFIED_KEY);
      if (!stored) return false;
      const { expiry } = JSON.parse(stored);
      return Date.now() < expiry;
    } catch (e) { return false; }
  };

  const handleBuyerClick = () => {
    if (isDeviceVerified()) {
      navigate('/buyer');
    } else {
      setPinInput('');
      setPinError('');
      setShowHint(false);
      setShowModal(true);
    }
  };

  const handleConfirm = () => {
    if (pinInput === pinConfig.pin) {
      const expiry = Date.now() + PIN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
      localStorage.setItem(PIN_VERIFIED_KEY, JSON.stringify({ expiry }));
      setShowModal(false);
      navigate('/buyer');
    } else {
      setPinError('Incorrect PIN. Please try again.');
      setPinInput('');
    }
  };

  const handleClose = () => {
    setShowModal(false);
    setPinInput('');
    setPinError('');
    setShowHint(false);
  };

  return (
    <Page title="Hera Inventory counting">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={handleBuyerClick}>
              Buyer
            </Button>
            <Button size="large" fullWidth onClick={() => navigate('/manager')}>
              Manager
            </Button>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={showModal}
        onClose={handleClose}
        title="Buyer Access"
        primaryAction={{
          content: 'Confirm',
          onAction: handleConfirm,
          disabled: pinInput.length !== 4,
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
            <Button
              variant="plain"
              onClick={() => setShowHint((v) => !v)}
            >
              {showHint ? 'Hide hint' : 'Hint'}
            </Button>
            {showHint && (
              <Text variant="bodySm" tone="subdued">
                {pinConfig.hint || 'No hint set.'}
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

export default Home;