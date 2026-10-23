import React, { useState, useEffect, useCallback } from 'react';
import { Page, Card, BlockStack, Button, Text, TextField, Banner, Modal } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { isPinVerified, verifyPin, fetchWithAccount, logoutPin } from '../../accountMemory';

// Warehouse access (2026-10-23, Hera) — PIN + user group.
//
// PIN: same as Online / Purchasing — key 'wh_pin' (default 3591), checked once
// per visit to Warehouse, remembered for the Shopify account for 30 days on
// any device (localStorage fallback), until Log out in Warehouse Settings.
// Changing the PIN logs every account out of Warehouse.
//
// User group: up to 3 groups (Warehouse Settings › User Group), each a name +
// the tabs it may open (Settings is one of the choices). The first time an
// account enters Warehouse it picks a group; it is remembered for the
// account (server) and the device (localStorage) until "Reset User". No
// groups → everyone sees every tab, as before. A group without Settings
// sees "Reset User" where the Settings button was.

export const WH_TAB_PATHS = {
  schedule: '/warehouse',
  'receive-shipments': '/warehouse/receive-shipments',
  'hq-transfers': '/warehouse/hq-transfers',
  delivery: '/warehouse/delivery',
  settings: '/warehouse/settings',
};
export const WH_TAB_LABELS = {
  schedule: 'Schedule',
  'receive-shipments': 'Receive Shipments',
  'hq-transfers': 'HQ Transfers',
  delivery: 'Delivery',
  settings: 'Settings',
};
export const WH_ALL_TABS = Object.keys(WH_TAB_PATHS);

const PIN_KEY = 'wh_pin';
const PIN_EXPIRY_DAYS = 30;
const LS_GROUP = 'wh_user_group';

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function lsRemove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

// Per visit: PIN entered / group worked out. Reset when leaving Warehouse
// through its back arrow (leaveWarehouse) or by Log out / Reset User.
let pinOkThisVisit = false;
let groupState = null; // { groups, group } once worked out this visit

export function leaveWarehouse() { pinOkThisVisit = false; groupState = null; }

async function getJson(url, options) {
  try {
    const r = await fetchWithAccount(url, options);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// → { groups, group } — group null = full access (no groups) or must choose
// (groups.length > 0). On a network problem: full access (never lock out).
async function loadGroupState() {
  const data = await getJson('/api/warehouse/user-groups');
  if (!data || !Array.isArray(data.groups)) return { groups: [], group: null };
  const groups = data.groups;
  if (groups.length === 0) { lsRemove(LS_GROUP); return { groups, group: null }; }
  const my = await getJson('/api/warehouse/user-groups/my');
  let gid = my && my.identified ? my.groupId : null;
  if (!(my && my.identified)) gid = parseInt(lsGet(LS_GROUP), 10) || null;
  const group = groups.find(g => Number(g.id) === Number(gid)) || null;
  if (group) lsSet(LS_GROUP, String(group.id)); else lsRemove(LS_GROUP);
  return { groups, group };
}

export async function resetWarehouseUser() {
  lsRemove(LS_GROUP);
  groupState = null;
  await getJson('/api/warehouse/user-groups/my', { method: 'DELETE' });
}

// ── PIN modal ────────────────────────────────────────────────────────────────
function PinModal({ open, onDone, onCancel }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [showHint, setShowHint] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch(`/api/settings/pin/hint?key=${PIN_KEY}`).then(r => r.json()).then(d => setHint(d.hint || '')).catch(() => {});
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await verifyPin(PIN_KEY, pin);
      if (result.ok) onDone();
      else if (result.wrong) { setError('Incorrect PIN. Please try again.'); setPin(''); }
      else setError('Network error. Please try again.');
    } catch (e) {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Warehouse Access"
      primaryAction={{ content: 'Confirm', onAction: confirm, disabled: pin.length !== 4 || busy, loading: busy }}
      secondaryActions={[{ content: 'Cancel', onAction: onCancel }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
          <TextField
            label="Enter PIN"
            type="password"
            value={pin}
            onChange={(v) => { if (/^\d{0,4}$/.test(v)) setPin(v); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && pin.length === 4) confirm(); }}
            autoComplete="off"
            maxLength={4}
            placeholder="4-digit PIN"
          />
          <Button variant="plain" onClick={() => setShowHint(v => !v)}>{showHint ? 'Hide hint' : 'Hint'}</Button>
          {showHint && <Text variant="bodySm" tone="subdued">{hint || 'No hint set.'}</Text>}
          <Text variant="bodySm" tone="subdued">
            This Shopify account will be remembered for {PIN_EXPIRY_DAYS} days after a successful login, on any device.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Choose User Group page ───────────────────────────────────────────────────
function ChooseGroup({ groups, onChosen, onBack }) {
  const [busy, setBusy] = useState(null);
  const pick = async (g) => {
    setBusy(g.id);
    lsSet(LS_GROUP, String(g.id));
    await getJson('/api/warehouse/user-groups/my', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: g.id }),
    });
    setBusy(null);
    onChosen(g);
  };
  return (
    <Page title="Choose User Group" backAction={{ onAction: onBack }} narrowWidth>
      <Card>
        <BlockStack gap="300">
          <Text tone="subdued">Pick your group. It is remembered for this account until you reset it.</Text>
          {groups.map(g => (
            <Button key={g.id} size="large" fullWidth onClick={() => pick(g)} loading={busy === g.id} disabled={busy !== null}>
              {g.name}
            </Button>
          ))}
        </BlockStack>
      </Card>
    </Page>
  );
}

// Gate used by WarehouseShell (tabs) and Warehouse Settings. `tab` = the tab
// being opened. Renders children(access) once the PIN is OK and the group is
// known; access = { group, allowedTabs, canSettings, resetUser }.
export function WarehouseGate({ tab, children }) {
  const navigate = useNavigate();
  const [pinOk, setPinOk] = useState(pinOkThisVisit);
  const [askPin, setAskPin] = useState(false);
  const [state, setState] = useState(groupState);

  useEffect(() => {
    if (pinOkThisVisit) return undefined;
    let cancelled = false;
    isPinVerified(PIN_KEY).then((ok) => {
      if (cancelled) return;
      if (ok) { pinOkThisVisit = true; setPinOk(true); } else setAskPin(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!pinOk || state) return undefined;
    let cancelled = false;
    loadGroupState().then((s) => { if (!cancelled) { groupState = s; setState(s); } });
    return () => { cancelled = true; };
  }, [pinOk, state]);

  const allowedTabs = state && state.group ? state.group.tabs : WH_ALL_TABS;
  const mustChoose = state && state.groups.length > 0 && !state.group;
  const blocked = state && !mustChoose && !allowedTabs.includes(tab);

  // A tab this group may not open → its first allowed tab.
  useEffect(() => {
    if (!blocked) return;
    const first = allowedTabs[0];
    navigate(first ? WH_TAB_PATHS[first] : '/', { replace: true });
  }, [blocked]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetUser = useCallback(async () => {
    await resetWarehouseUser();
    setState(null); // reloads the groups → Choose User Group
  }, []);

  if (askPin && !pinOk) {
    return (
      <PinModal
        open
        onDone={() => { pinOkThisVisit = true; setAskPin(false); setPinOk(true); }}
        onCancel={() => navigate('/')}
      />
    );
  }
  if (!pinOk || !state) {
    return <Page title="Warehouse"><Text tone="subdued">Loading...</Text></Page>;
  }
  if (mustChoose) {
    return (
      <ChooseGroup
        groups={state.groups}
        onBack={() => { leaveWarehouse(); navigate('/'); }}
        onChosen={(g) => {
          const next = { groups: state.groups, group: g };
          groupState = next;
          setState(next);
          if (!g.tabs.includes(tab)) navigate(WH_TAB_PATHS[g.tabs[0]], { replace: true });
        }}
      />
    );
  }
  if (blocked) return null;
  return children({ group: state.group, allowedTabs, canSettings: allowedTabs.includes('settings'), resetUser });
}

// Warehouse Settings › Log out: forget the PIN for this account (all its
// devices) and leave Warehouse.
export async function logoutWarehouse() {
  await logoutPin(PIN_KEY);
  leaveWarehouse();
}

export const WH_PIN_KEY = PIN_KEY;
