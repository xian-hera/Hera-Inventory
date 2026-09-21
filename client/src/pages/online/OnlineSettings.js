import React, { useState } from 'react';
import {
  Page, Layout, Button, BlockStack, TextField, Banner, Modal, Text
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

// Online Settings — same style, similar functionality as CRMSettings.js
// (2026-09-21, Hera): Set PIN + Log out only, no "Sync Employees from
// Connecteam" (that stays Operation-only, unrelated to this section).
// Independent PIN key ('online_pin') and localStorage key
// ('online_pin_verified') from Operation's crm_pin — changing this PIN
// never touches Operation's, and vice versa. Default PIN is 0000 here
// (Operation/Purchasing default to 3591) — see server/routes/settings.js.
const ONLINE_PIN_VERIFIED_KEY = 'online_pin_verified';

function OnlineSettings() {
  const navigate = useNavigate();

  // ── PIN modal state ────────────────────────────────────────────────────────
  const [showModal, setShowModal]       = useState(false);
  const [step, setStep]                 = useState('verify');
  const [currentInput, setCurrentInput] = useState('');
  const [verifiedPin, setVerifiedPin]   = useState('');
  const [newPin, setNewPin]             = useState('');
  const [newHint, setNewHint]           = useState('');
  const [modalError, setModalError]     = useState('');
  const [success, setSuccess]           = useState(false);
  const [loading, setLoading]           = useState(false);

  const openModal = () => {
    setStep('verify');
    setCurrentInput('');
    setVerifiedPin('');
    setNewPin('');
    setNewHint('');
    setModalError('');
    setSuccess(false);
    setShowModal(true);
  };

  const closeModal = () => setShowModal(false);

  const handleLogout = () => {
    localStorage.removeItem(ONLINE_PIN_VERIFIED_KEY);
    navigate('/');
  };

  const handleVerify = async () => {
    setLoading(true);
    setModalError('');
    try {
      const res = await fetch('/api/settings/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'online_pin', pin: currentInput }),
      });
      if (res.ok) {
        const hintRes  = await fetch('/api/settings/pin/hint?key=online_pin');
        const hintData = await hintRes.json().catch(() => ({}));
        setNewHint(hintData.hint || '');
        setVerifiedPin(currentInput);
        setStep('set');
        setCurrentInput('');
      } else {
        setModalError('Incorrect PIN.');
        setCurrentInput('');
      }
    } catch (e) {
      setModalError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!/^\d{4}$/.test(newPin)) {
      setModalError('PIN must be exactly 4 digits.');
      return;
    }
    setLoading(true);
    setModalError('');
    try {
      const res = await fetch('/api/settings/pin/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'online_pin', currentPin: verifiedPin, newPin, hint: newHint }),
      });
      if (res.ok) {
        localStorage.removeItem(ONLINE_PIN_VERIFIED_KEY);
        setSuccess(true);
        setTimeout(() => closeModal(), 1400);
      } else {
        const data = await res.json().catch(() => ({}));
        setModalError(data.error || 'Failed to update PIN.');
      }
    } catch (e) {
      setModalError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const primaryAction = step === 'verify'
    ? { content: 'Verify', onAction: handleVerify, disabled: currentInput.length !== 4 || loading, loading }
    : { content: 'Save PIN', onAction: handleSave, disabled: newPin.length !== 4 || loading, loading };

  return (
    <Page title="Online Settings" backAction={{ onAction: () => navigate('/online') }}>
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

      {/* ── PIN Modal ── */}
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
                helpText="Default PIN is 0000 if it has never been changed."
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

export default OnlineSettings;
