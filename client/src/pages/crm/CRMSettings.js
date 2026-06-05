import React, { useState } from 'react';
import {
  Page, Layout, Button, BlockStack, TextField, Banner, Modal, Text
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const CRM_PIN_VERIFIED_KEY = 'crm_pin_verified';

// Random word list for sync confirmation
const CONFIRM_WORDS = [
  'ALPINE', 'BRIDGE', 'CANVAS', 'DAGGER', 'ENGINE',
  'FALCON', 'GARDEN', 'HARBOR', 'ISLAND', 'JUNGLE',
  'KETTLE', 'LANTERN', 'MARBLE', 'NECTAR', 'OYSTER',
];

function randomWord() {
  return CONFIRM_WORDS[Math.floor(Math.random() * CONFIRM_WORDS.length)];
}

function CRMSettings() {
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

  // ── Sync modal state ───────────────────────────────────────────────────────
  const [showSyncModal, setShowSyncModal]   = useState(false);
  const [syncWord, setSyncWord]             = useState('');
  const [syncInput, setSyncInput]           = useState('');
  const [syncError, setSyncError]           = useState('');
  const [syncing, setSyncing]               = useState(false);
  const [syncResult, setSyncResult]         = useState('');

  // ── PIN modal handlers ─────────────────────────────────────────────────────

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
    localStorage.removeItem(CRM_PIN_VERIFIED_KEY);
    navigate('/');
  };

  const handleVerify = async () => {
    setLoading(true);
    setModalError('');
    try {
      const res = await fetch('/api/settings/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'crm_pin', pin: currentInput }),
      });
      if (res.ok) {
        const hintRes  = await fetch('/api/settings/pin/hint?key=crm_pin');
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
        body: JSON.stringify({ key: 'crm_pin', currentPin: verifiedPin, newPin, hint: newHint }),
      });
      if (res.ok) {
        localStorage.removeItem(CRM_PIN_VERIFIED_KEY);
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

  // ── Sync modal handlers ────────────────────────────────────────────────────

  const openSyncModal = () => {
    setSyncWord(randomWord());
    setSyncInput('');
    setSyncError('');
    setSyncResult('');
    setShowSyncModal(true);
  };

  const closeSyncModal = () => {
    if (syncing) return;
    setShowSyncModal(false);
  };

  const handleSync = async () => {
    if (syncInput.trim().toUpperCase() !== syncWord) {
      setSyncError(`Please type exactly: ${syncWord}`);
      return;
    }
    setSyncing(true);
    setSyncError('');
    setSyncResult('');
    try {
      const res  = await fetch('/api/employees/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      setSyncResult(`Sync complete — ${data.synced} employees processed.`);
    } catch (e) {
      setSyncError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Page title="CRM Settings" backAction={{ onAction: () => navigate('/crm') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Button size="large" fullWidth onClick={openModal}>
              Set PIN
            </Button>
            <Button size="large" fullWidth onClick={openSyncModal}>
              Sync Employees from Connecteam
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

      {/* ── Sync Modal ── */}
      <Modal
        open={showSyncModal}
        onClose={closeSyncModal}
        title="Sync Employees from Connecteam"
        primaryAction={{
          content: syncing ? 'Syncing…' : 'Confirm Sync',
          onAction: handleSync,
          disabled: syncInput.trim().toUpperCase() !== syncWord || syncing,
          loading: syncing,
          destructive: true,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: closeSyncModal, disabled: syncing }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {syncError && (
              <Banner tone="critical" onDismiss={() => setSyncError('')}>{syncError}</Banner>
            )}
            {syncResult && (
              <Banner tone="success">{syncResult}</Banner>
            )}
            {!syncResult && (
              <>
                <Banner tone="warning">
                  Sync should only be performed once during initial setup, or when instructed. Running it repeatedly is unnecessary and may cause data issues.
                </Banner>
                <Text variant="bodyMd">
                  To confirm, type <strong>{syncWord}</strong> below:
                </Text>
                <input
                  value={syncInput}
                  onChange={e => { setSyncInput(e.target.value); setSyncError(''); }}
                  placeholder={syncWord}
                  autoComplete="off"
                  autoFocus
                  style={{
                    width: '100%', padding: '10px 12px', fontSize: '16px',
                    border: `1px solid ${syncInput.trim().toUpperCase() === syncWord ? '#008060' : '#c9cccf'}`,
                    borderRadius: '8px', outline: 'none', boxSizing: 'border-box',
                    letterSpacing: '2px', textTransform: 'uppercase',
                  }}
                />
              </>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default CRMSettings;