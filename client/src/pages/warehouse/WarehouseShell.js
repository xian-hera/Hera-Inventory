import React, { useState, useEffect, useCallback } from 'react';
import { Page, InlineStack } from '@shopify/polaris';
import { useNavigate, useLocation } from 'react-router-dom';
import { confirmLeaveSchedule } from './whShared';

// Warehouse tabs (2026-10-21, Hera — claude/SCHEDULER_FEATURE_SPEC.md §10).
// Same pattern as Online (pages/online/OnlineHome.js): this shell is the
// "Warehouse" header (normal page width, Settings top-right) + the tab bar;
// each tab keeps its own URL and App.js wraps the tab page in
// <WarehouseShell tab="…">. Warehouse has no PIN.
//
// Badges: Receive Shipments = POs waiting (grey, low-key); HQ Transfers =
// HQ-origin transfers in Draft (red). Reloaded on every tab change and when a
// page fires 'warehouse-badges-refresh' (see whShared.refreshWarehouseBadges).
export const WAREHOUSE_TABS = [
  { id: 'schedule', label: 'Schedule', path: '/warehouse' },
  { id: 'receive-shipments', label: 'Receive Shipments', path: '/warehouse/receive-shipments' },
  { id: 'hq-transfers', label: 'HQ Transfers', path: '/warehouse/hq-transfers' },
];

const BADGE_BASE = {
  display: 'inline-block', minWidth: 18, height: 18, lineHeight: '18px', padding: '0 5px',
  marginLeft: 6, borderRadius: 9, fontSize: 11, fontWeight: 700, textAlign: 'center', verticalAlign: 'top',
};
const BADGE_RED = { ...BADGE_BASE, background: '#d72c0d', color: '#fff' };
const BADGE_GREY = { ...BADGE_BASE, background: '#d4d4d4', color: '#303030' };

function TabBar({ tab, badges, onSelect }) {
  return (
    <div style={{ borderBottom: '1px solid #e1e3e5', marginBottom: 4 }}>
      <InlineStack gap="100" wrap>
        {WAREHOUSE_TABS.map(t => {
          const active = t.id === tab;
          const count = t.id === 'receive-shipments' ? badges.receiveShipments
            : t.id === 'hq-transfers' ? badges.hqDraft : 0;
          return (
            <button key={t.id} type="button" onClick={() => onSelect(t)}
              style={{
                border: 'none', background: active ? '#e3e3e3' : 'transparent', cursor: 'pointer',
                padding: '8px 14px', margin: '0 0 6px', borderRadius: 8, fontSize: 14,
                fontWeight: active ? 600 : 450, color: '#303030', position: 'relative',
              }}>
              {t.label}
              {count > 0 && (
                <span style={t.id === 'hq-transfers' ? BADGE_RED : BADGE_GREY}>{count}</span>
              )}
            </button>
          );
        })}
      </InlineStack>
    </div>
  );
}

function WarehouseShell({ tab = 'schedule', children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [badges, setBadges] = useState({ receiveShipments: 0, hqDraft: 0 });

  const loadBadges = useCallback(() => {
    fetch('/api/warehouse/badges')
      .then(r => r.json())
      .then(d => setBadges({ receiveShipments: d.receiveShipments || 0, hqDraft: d.hqDraft || 0 }))
      .catch(() => {});
  }, []);
  useEffect(() => { loadBadges(); }, [location.pathname, loadBadges]);
  useEffect(() => {
    window.addEventListener('warehouse-badges-refresh', loadBadges);
    return () => window.removeEventListener('warehouse-badges-refresh', loadBadges);
  }, [loadBadges]);

  return (
    <>
      <Page
        title="Warehouse"
        backAction={{ onAction: () => { if (confirmLeaveSchedule()) navigate('/'); } }}
        secondaryActions={[{ content: 'Settings', onAction: () => { if (confirmLeaveSchedule()) navigate('/warehouse/settings'); } }]}
      >
        <TabBar tab={tab} badges={badges} onSelect={(t) => { if (t.id !== tab && confirmLeaveSchedule()) navigate(t.path); }} />
      </Page>
      {/* The tab's own page (rendered with inTabs: no title / back arrow of its own). */}
      {children}
    </>
  );
}

export default WarehouseShell;
