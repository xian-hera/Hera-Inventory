import React, { useState, useEffect } from 'react';
import { Page, Layout, Button, BlockStack, Text, TextField, Banner, Modal } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
// PIN check/verify now go through the current Shopify account first, with
// the old localStorage 30-day check as the fallback (2026-09-29) — see
// client/src/accountMemory.js.
import { isPinVerified, verifyPin } from '../../accountMemory';

// localStorage key ('crm_pin_verified') moved to PIN_LOCAL_KEYS in client/src/accountMemory.js (2026-09-29).
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
    fetch('/api/settings/pin/hint?key=crm_pin')
      .then(r => r.json())
      .then(data => setHint(data.hint || ''))
      .catch(() => {});

    let cancelled = false;
    isPinVerified('crm_pin').then((ok) => {
      if (cancelled) return;
      if (ok) setReady(true);
      else setShowModal(true);
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // isDeviceVerified() (localStorage 30-day check) now lives in
  // accountMemory.js as the fallback inside isPinVerified().

  const handleConfirm = async () => {
    setVerifying(true);
    setPinError('');
    try {
      // verifyPin(): remembers it for the Shopify account (30 days) and
      // still writes the old localStorage entry as the fallback.
      const result = await verifyPin('crm_pin', pinInput);
      if (result.ok) {
        setShowModal(false);
        setReady(true);
      } else if (result.wrong) {
        setPinError('Incorrect PIN. Please try again.');
        setPinInput('');
      } else {
        setPinError('Network error. Please try again.');
      }
    } catch (e) {
      setPinError('Network error. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  const handleClose = () => { navigate('/'); };

  return (
    <Page
      title="Operation"
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
              {/* Birthday Reward and Influencer Management moved to the new
                  Online section (2026-09-21, Hera) — they now live under
                  /online, gated by their own independent online_pin, not
                  this crm_pin. See client/src/pages/online/OnlineHome.js. */}
              <Button size="large" fullWidth onClick={() => navigate('/crm/employee-cap')}>
                Employee Cap
              </Button>
            </BlockStack>
          </Layout.Section>
        </Layout>
      )}

      <Modal
        open={showModal}
        onClose={handleClose}
        title="Operation Access"
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
              This Shopify account will be remembered for {PIN_EXPIRY_DAYS} days after a successful login, on any device.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default CRMHome;