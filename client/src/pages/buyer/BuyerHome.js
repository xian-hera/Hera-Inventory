import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Button, BlockStack, TextField, Banner, Modal, Text
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import BuyerNav from '../../components/BuyerNav';

const PIN_CONFIG_KEY   = 'buyer_pin_config';
const PIN_VERIFIED_KEY = 'buyer_pin_verified';
const DEFAULT_PIN      = '3591';

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

function ExclamationBadge() {
  return <span style={BADGE_STYLE}>!</span>;
}

function BuyerHome() {
  const navigate = useNavigate();

  const [showModal, setShowModal]       = useState(false);
  const [step, setStep]                 = useState('verify');
  const [currentInput, setCurrentInput] = useState('');
  const [newPin, setNewPin]             = useState('');
  const [newHint, setNewHint]           = useState('');
  const [modalError, setModalError]     = useState('');
  const [success, setSuccess]           = useState(false);
  const [pinConfig, setPinConfig]       = useState({ pin: DEFAULT_PIN, hint: '' });

  const [badges, setBadges] = useState({
    inventoryCount: 0,
    priceChangeAlert: false,
  });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(PIN_CONFIG_KEY);
      if (stored) setPinConfig(JSON.parse(stored));
    } catch (e) {}
  }, []);

  useEffect(() => {
    fetch('/api/badges/buyer')
      .then(r => r.json())
      .then(data => {
        setBadges({
          inventoryCount: (data.weeklyReviewing || 0) + (data.zeroLowReviewing || 0) + (data.stockLossesReviewing || 0),
          priceChangeAlert: data.priceChangeAlert || false,
        });
      })
      .catch(() => {});
  }, []);

  const openModal = () => {
    setStep('verify');
    setCurrentInput('');
    setNewPin('');
    setNewHint(pinConfig.hint || '');
    setModalError('');
    setSuccess(false);
    setShowModal(true);
  };

  const closeModal = () => setShowModal(false);

  const handleLogout = () => {
    localStorage.removeItem(PIN_VERIFIED_KEY);
    navigate('/');
  };

  const handleVerify = () => {
    if (currentInput === pinConfig.pin) {
      setStep('set');
      setCurrentInput('');
      setModalError('');
    } else {
      setModalError('Incorrect PIN.');
      setCurrentInput('');
    }
  };

  const handleSave = () => {
    if (!/^\d{4}$/.test(newPin)) {
      setModalError('PIN must be exactly 4 digits.');
      return;
    }
    const updated = { pin: newPin, hint: newHint.trim() };
    localStorage.setItem(PIN_CONFIG_KEY, JSON.stringify(updated));
    localStorage.removeItem(PIN_VERIFIED_KEY);
    setPinConfig(updated);
    setSuccess(true);
    setTimeout(() => closeModal(), 1400);
  };

  const primaryAction = step === 'verify'
    ? { content: 'Verify', onAction: handleVerify, disabled: currentInput.length !== 4 }
    : { content: 'Save PIN', onAction: handleSave, disabled: newPin.length !== 4 };

  return (
    <>
      <BuyerNav />
      <Page title="Purchasing" backAction={{ onAction: () => navigate('/') }}>
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {/* Inventory Count */}
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <Button size="large" fullWidth onClick={() => navigate('/buyer/inventory-count')}>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      Inventory Count
                      <Badge count={badges.inventoryCount} />
                    </span>
                  </Button>
                </div>
              </div>

              {/* Price Change */}
              <Button size="large" fullWidth onClick={() => navigate('/buyer/price-change')}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  Price Change
                  {badges.priceChangeAlert && <ExclamationBadge />}
                </span>
              </Button>

              {/* Settings */}
              <Button size="large" fullWidth onClick={() => navigate('/buyer/settings')}>
                Settings
              </Button>
            </BlockStack>
          </Layout.Section>
        </Layout>

        <Modal
          open={showModal}
          onClose={closeModal}
          title="Set PIN"
          primaryAction={primaryAction}
          secondaryActions={[{ content: 'Cancel', onAction: closeModal }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              {modalError && (
                <Banner tone="critical" onDismiss={() => setModalError('')}>{modalError}</Banner>
              )}
              {success && (
                <Banner tone="success">PIN updated successfully.</Banner>
              )}
              {step === 'verify' && !success && (
                <TextField
                  label="Current PIN"
                  type="password"
                  value={currentInput}
                  onChange={(val) => {
                    if (/^\d{0,4}$/.test(val)) setCurrentInput(val);
                    setModalError('');
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && currentInput.length === 4) handleVerify(); }}
                  autoComplete="off"
                  maxLength={4}
                  placeholder="Enter current PIN"
                  helpText="Default PIN is 3591 if it has never been changed."
                />
              )}
              {step === 'set' && !success && (
                <>
                  <TextField
                    label="New PIN (4 digits)"
                    type="password"
                    value={newPin}
                    onChange={(val) => {
                      if (/^\d{0,4}$/.test(val)) setNewPin(val);
                      setModalError('');
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && newPin.length === 4) handleSave(); }}
                    autoComplete="off"
                    maxLength={4}
                    placeholder="Choose a 4-digit PIN"
                  />
                  <TextField
                    label="Hint (optional)"
                    value={newHint}
                    onChange={setNewHint}
                    autoComplete="off"
                    placeholder="e.g. Year + first initial"
                    helpText="This hint is shown on the PIN login screen. Keep it vague."
                    multiline={2}
                  />
                  <Text variant="bodySm" tone="subdued">
                    Changing the PIN will sign out all devices. They will need to re-enter the new PIN.
                  </Text>
                </>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      </Page>
    </>
  );
}

export default BuyerHome;