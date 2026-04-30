import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Button, BlockStack, TextField, Banner, Modal, Text
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const CRM_PIN_CONFIG_KEY   = 'crm_pin_config';
const CRM_PIN_VERIFIED_KEY = 'crm_pin_verified';
const DEFAULT_PIN          = '3591';

function CRMSettings() {
  const navigate = useNavigate();

  const [showModal, setShowModal]       = useState(false);
  const [step, setStep]                 = useState('verify');
  const [currentInput, setCurrentInput] = useState('');
  const [newPin, setNewPin]             = useState('');
  const [newHint, setNewHint]           = useState('');
  const [modalError, setModalError]     = useState('');
  const [success, setSuccess]           = useState(false);
  const [pinConfig, setPinConfig]       = useState({ pin: DEFAULT_PIN, hint: '' });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(CRM_PIN_CONFIG_KEY);
      if (stored) setPinConfig(JSON.parse(stored));
    } catch (e) {}
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
    localStorage.removeItem(CRM_PIN_VERIFIED_KEY);
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
    localStorage.setItem(CRM_PIN_CONFIG_KEY, JSON.stringify(updated));
    localStorage.removeItem(CRM_PIN_VERIFIED_KEY);
    setPinConfig(updated);
    setSuccess(true);
    setTimeout(() => closeModal(), 1400);
  };

  const primaryAction = step === 'verify'
    ? { content: 'Verify', onAction: handleVerify, disabled: currentInput.length !== 4 }
    : { content: 'Save PIN', onAction: handleSave, disabled: newPin.length !== 4 };

  return (
    <Page title="CRM Settings" backAction={{ onAction: () => navigate('/crm') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={openModal}>
              Set PIN
            </Button>
            <Button size="large" fullWidth tone="critical" onClick={handleLogout}>
              Log out
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
  );
}

export default CRMSettings;