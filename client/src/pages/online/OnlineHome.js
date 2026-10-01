import React, { useState, useEffect, useCallback } from 'react';
import { Page, Button, BlockStack, InlineStack, Text, TextField, Banner, Modal } from '@shopify/polaris';
import { useNavigate, useLocation } from 'react-router-dom';
// PIN check/verify now go through the current Shopify account first, with
// the old localStorage 30-day check as the fallback (2026-09-29) — see
// client/src/accountMemory.js.
import { isPinVerified, verifyPin } from '../../accountMemory';

// Online — new section split out of CRM/Growth (2026-09-21, Hera): holds
// Birthday Reward + Influencer Management, which used to live under /crm
// gated by crm_pin. This section has its own independent PIN/login state
// (online_pin / online_pin_verified) — logging into Operation does not log
// you into Online and vice versa. Structure mirrors CRMHome.js exactly
// (same PIN-gate pattern, same 30-day device-remember window); only the
// gated key, localStorage key, and the two buttons differ.
// localStorage key ('online_pin_verified') moved to PIN_LOCAL_KEYS in client/src/accountMemory.js (2026-09-29).
const PIN_EXPIRY_DAYS         = 30;

// Tabs (2026-10-01, Hera — claude/ONLINE_DASHBOARD_SPEC.md §1): the four
// buttons that used to be on this page became tabs next to the new
// Dashboard. OnlineHome is now the shell around every tab: PIN gate, the
// "Online" header with Settings, and the tab bar. Each tab keeps its own URL
// (App.js wraps the tab pages in <OnlineHome tab="…">).
const TABS = [
  { id: 'dashboard', label: 'Dashboard', path: '/online' },
  { id: 'new-products', label: 'New Products', path: '/online/new-products' },
  { id: 'birthday-reward', label: 'Birthday Reward', path: '/online/birthday-reward' },
  { id: 'influencers', label: 'Influencer Management', path: '/online/influencers' },
  { id: 'swatch', label: 'Swatch', path: '/online/swatch' },
];

// The PIN is checked once per visit to the Online section, not again on
// every tab change.
let verifiedThisVisit = false;

function TabBar({ tab, newProductsCount, onSelect }) {
  return (
    <div style={{ borderBottom: '1px solid #e1e3e5', marginBottom: 4 }}>
      <InlineStack gap="100" wrap>
        {TABS.map(t => {
          const active = t.id === tab;
          return (
            <button key={t.id} type="button" onClick={() => onSelect(t)}
              style={{
                border: 'none', background: active ? '#e3e3e3' : 'transparent', cursor: 'pointer',
                padding: '8px 14px', margin: '0 0 6px', borderRadius: 8, fontSize: 14,
                fontWeight: active ? 600 : 450, color: '#303030', position: 'relative',
              }}>
              {t.label}
              {t.id === 'new-products' && newProductsCount > 0 && (
                <span style={{
                  display: 'inline-block', minWidth: 18, height: 18, lineHeight: '18px', padding: '0 5px',
                  marginLeft: 6, borderRadius: 9, background: '#d72c0d', color: '#fff', fontSize: 11,
                  fontWeight: 700, textAlign: 'center', verticalAlign: 'top',
                }}>{newProductsCount}</span>
              )}
            </button>
          );
        })}
      </InlineStack>
    </div>
  );
}

function OnlineHome({ tab = 'dashboard', children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [newProductsCount, setNewProductsCount] = useState(0);


  const [ready, setReady]         = useState(verifiedThisVisit);
  const [showModal, setShowModal] = useState(false);
  const [pinInput, setPinInput]   = useState('');
  const [pinError, setPinError]   = useState('');
  const [showHint, setShowHint]   = useState(false);
  const [hint, setHint]           = useState('');
  const [verifying, setVerifying] = useState(false);

  // Red badge on New Products = number of items in its list. Refreshed on
  // every tab change and when the New Products page reloads its list.
  const loadCount = useCallback(() => {
    fetch('/api/new-products/count').then(r => r.json()).then(d => setNewProductsCount(d.count || 0)).catch(() => {});
  }, []);
  useEffect(() => { if (ready) loadCount(); }, [ready, location.pathname, loadCount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener('online-badges-refresh', loadCount);
    return () => window.removeEventListener('online-badges-refresh', loadCount);
  }, [loadCount]);

  useEffect(() => {
    if (verifiedThisVisit) { setReady(true); return undefined; }
    fetch('/api/settings/pin/hint?key=online_pin')
      .then(r => r.json())
      .then(data => setHint(data.hint || ''))
      .catch(() => {});

    let cancelled = false;
    isPinVerified('online_pin').then((ok) => {
      if (cancelled) return;
      if (ok) { verifiedThisVisit = true; setReady(true); }
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
      const result = await verifyPin('online_pin', pinInput);
      if (result.ok) {
        verifiedThisVisit = true;
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
  const leave = () => { verifiedThisVisit = false; navigate('/'); };

  return (
    <>
    <Page
      title="Online"
      backAction={{ onAction: leave }}
      secondaryActions={ready ? [{ content: 'Settings', onAction: () => navigate('/online/settings') }] : []}
    >
      {ready && <TabBar tab={tab} newProductsCount={newProductsCount} onSelect={(t) => navigate(t.path)} />}
      <Modal
        open={showModal}
        onClose={handleClose}
        title="Online Access"
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
    {/* The tab's own page (rendered with inTabs: no title / back arrow of its own). */}
    {ready && children}
    </>
  );
}

export default OnlineHome;
