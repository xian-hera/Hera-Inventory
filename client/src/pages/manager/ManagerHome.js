import React, { useState, useEffect } from 'react';
import {
  Page, Layout, Button, BlockStack,
  Text, Banner, Popover, ActionList
} from '@shopify/polaris';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useLocationMap } from '../shared/locationMap';
import ManagerDashboard, { useStoreDashboard } from './ManagerDashboard';
// Store location is remembered per Shopify account (2026-09-29) — loaded
// by ManagerLocationGate before this page renders; see
// client/src/accountMemory.js. localStorage 'managerLocation' is still
// written as the fallback.
import { getManagerLocation, saveManagerLocation } from '../../accountMemory';

// Store home (2026-10-22, Hera — claude/STORE_DASHBOARD_AND_LINE_NOTES.md):
// title "Store" + the location as a green pill (click → pick a location from
// the list, saved at once; "Choose Location" when none is chosen). The old
// "Location" card (Select + Confirm / Change) was replaced by that pill.
// Two tabs: Dashboard (ManagerDashboard.js) and Tasks (the buttons below,
// unchanged). Which tab opens:
//   - coming from the Hub home (Store button, state.entry = 'hub') → Dashboard
//     when it has anything in it, otherwise Tasks;
//   - ?tab=dashboard / ?tab=tasks in the URL → that tab (detail pages opened
//     from the Dashboard come back to ?tab=dashboard);
//   - otherwise (back from a Tasks page) → the tab last shown in this
//     browser session.
const TAB_KEY = 'storeHomeTab';
function readTab() { try { return sessionStorage.getItem(TAB_KEY); } catch (e) { return null; } }
function writeTab(t) { try { sessionStorage.setItem(TAB_KEY, t); } catch (e) { /* private mode */ } }

const PILL_STYLE = {
  display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', cursor: 'pointer',
  padding: '3px 12px', borderRadius: 999, background: '#4a7c45', color: '#fff',
  fontSize: 14, fontWeight: 700, lineHeight: '20px', whiteSpace: 'nowrap',
};

function StoreTabs({ tab, onSelect }) {
  const tabs = [{ id: 'dashboard', label: 'Dashboard' }, { id: 'tasks', label: 'Tasks' }];
  return (
    <div className="store-tabs" style={{ display: 'flex', gap: 6 }}>
      <style>{'@media (max-width: 767px) { .store-tabs { padding-left: 12px; } }'}</style>
      {tabs.map(t => {
        const active = t.id === tab;
        return (
          <button key={t.id} type="button" onClick={() => onSelect(t.id)} style={{
            border: 'none', cursor: 'pointer', padding: '8px 16px', borderRadius: 999, fontSize: 15,
            background: active ? '#e3e3e3' : 'transparent', fontWeight: active ? 600 : 450, color: '#303030',
          }}>{t.label}</button>
        );
      })}
    </div>
  );
}

// Location list: comes from the shared location map (pages/shared/locationMap.js,
// 2026-09-24). The hardcoded 19-code LOCATIONS constant that used to live here
// (this device's "Select location" dropdown) was removed. A location already
// saved on this device (localStorage 'managerLocation') is unaffected.
// (2026-09-29) The confirmed location is now remembered per Shopify account
// (forever, overwritten only by confirming a different one) instead of per
// device. A remembered location that is no longer in the location map
// (renamed/removed in Shopify) is ignored and the picker is shown again.

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
  const routerLocation = useLocation();
  const [searchParams] = useSearchParams();
  const [location, setLocation]       = useState('');
  const { names: locationNames, error: locationsError } = useLocationMap();
  const [confirmed, setConfirmed]     = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [badges, setBadges]           = useState({ inventoryCount: 0, labelPrint: 0, poReceiving: 0, transfer: 0 });
  const [pickerOpen, setPickerOpen]   = useState(false);

  // Dashboard data (also decides the first tab, see the comment at the top).
  const activeLocation = confirmed ? location : '';
  const dashboard = useStoreDashboard(activeLocation || getManagerLocation() || '');
  const urlTab = searchParams.get('tab');
  const fromHub = routerLocation.state && routerLocation.state.entry === 'hub';
  const initialTab = (urlTab === 'dashboard' || urlTab === 'tasks') ? urlTab : (fromHub ? null : readTab());
  const [tab, setTab] = useState(initialTab); // null = decide when the Dashboard has loaded
  useEffect(() => {
    if (tab) return;
    if (!getManagerLocation()) { setTab('tasks'); writeTab('tasks'); return; }
    if (dashboard.loading) return;
    const t = dashboard.hasContent ? 'dashboard' : 'tasks';
    setTab(t);
    writeTab(t);
  }, [tab, dashboard.loading, dashboard.hasContent]);
  const selectTab = (t) => {
    setTab(t);
    writeTab(t);
    navigate(`/manager?tab=${t}`, { replace: true });
  };

  useEffect(() => {
    const saved = getManagerLocation();
    if (saved) {
      setLocation(saved);
      setConfirmed(true);
    }
  }, []);

  // Remembered location no longer in the (successfully loaded) location
  // map → treat as not chosen, so nobody works on a store that no longer
  // exists under that name. Nothing is deleted; confirming a new one
  // overwrites it.
  useEffect(() => {
    if (!confirmed || !location || locationNames.length === 0) return;
    if (!locationNames.includes(location)) {
      setConfirmed(false);
      setLocation('');
    }
  }, [confirmed, location, locationNames]);

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

  // Location pill → pick a location: saved at once for the Shopify account
  // (server, overwrite) + this device, like the old Confirm. Not awaited:
  // the UI moves on immediately, like before.
  const handlePickLocation = (name) => {
    setPickerOpen(false);
    if (!name) return;
    saveManagerLocation(name);
    setLocation(name);
    setConfirmed(true);
    setShowWarning(false);
  };

  const handleNavigate = (path) => {
    if (!confirmed) { setShowWarning(true); return; }
    navigate(path);
  };

  const locationPill = (
    <Popover
      active={pickerOpen}
      onClose={() => setPickerOpen(false)}
      preferredAlignment="left"
      activator={(
        <button type="button" style={PILL_STYLE} onClick={() => setPickerOpen(v => !v)}>
          {confirmed && location ? location : 'Choose Location'}
          <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.85 }}>▼</span>
        </button>
      )}
    >
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        <ActionList
          actionRole="menuitem"
          items={locationNames.map(l => ({
            content: l,
            active: confirmed && l === location,
            onAction: () => handlePickLocation(l),
          }))}
        />
      </div>
    </Popover>
  );

  return (
    <Page
      title="Store"
      titleMetadata={locationPill}
      backAction={{ onAction: () => navigate('/') }}
      // New Arrival (2026-09-29, Hera): top-right, same row as the title.
      primaryAction={{ content: 'New Arrival', onAction: () => handleNavigate('/manager/new-arrival') }}
    >
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

            <StoreTabs tab={tab} onSelect={selectTab} />

            {!tab && <Text tone="subdued">Loading...</Text>}

            {tab === 'dashboard' && <ManagerDashboard location={activeLocation} dashboard={dashboard} />}

            {tab === 'tasks' && (
            <BlockStack gap="400">
            {/* Tasks menu (2026-10-22, Hera): Weekly / Manual Inventory Count are
                their own buttons now (the "Inventory Count" sub-menu page is no longer
                linked); PO Receiving → Purchase Orders, Transfer → Transfers,
                Label Print → Price Change; new order below. */}
            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/counting-tasks')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Weekly Inventory Count
                <Badge count={badges.inventoryCount} />
              </span>
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/zero-qty-report')}>
              Manual Inventory Count
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/stock-losses')}>
              Stock Loss
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/po-receiving')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Purchase Orders
                <Badge count={badges.poReceiving} />
              </span>
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/transfer')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Transfers
                <Badge count={badges.transfer} />
              </span>
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/label-print')}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Label Print{/* was "Price Change" (2026-10-26, Hera) */}
                <Badge count={badges.labelPrint} />
              </span>
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/restock-plan')}>
              Restock
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/wig-demo')}>
              Demo Wig
            </Button>

            <Button size="large" fullWidth onClick={() => handleNavigate('/manager/employee-cap')}>
              Employee Cap
            </Button>
            </BlockStack>
            )}

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