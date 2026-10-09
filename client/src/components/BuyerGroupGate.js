// BuyerGroupGate (2026-10-09, Hera) — layout route around every /buyer page.
//
// A Purchasing user must pick a user group before using Purchasing. When the
// Hub has no group on record for this account (never chosen, or "Reset my
// group" in Settings), the "Choose User Group" page is shown in place of the
// page they asked for; picking one continues straight to that page.
//
// Skipped (the page opens normally) when: no groups are defined in Settings,
// or the groups could not be loaded — this gate must never lock anyone out.
// Rendered inside a layout <Route> in App.js, so it re-checks on every Buyer
// navigation: after Reset my group the Settings page stays as it is and the
// next page the user opens asks for a group.

import React, { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Page, BlockStack, Text } from '@shopify/polaris';
import { loadGroupState, chooseGroup, getGroupChoice, getCachedGroups } from '../userGroup';

let gateLoaded = false;

function GroupCard({ title, subtitle, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: disabled ? 'default' : 'pointer',
        background: '#fff', border: '1px solid #c9cccf', borderRadius: '12px',
        padding: '20px 24px', WebkitTapHighlightColor: 'transparent', color: 'inherit',
      }}
    >
      <Text as="p" variant="headingLg">{title}</Text>
      <Text as="p" tone="subdued">{subtitle}</Text>
    </button>
  );
}

export default function BuyerGroupGate() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(!gateLoaded);
  const [saving, setSaving] = useState(false);
  const [, bump] = useState(0);

  useEffect(() => {
    if (gateLoaded) return undefined;
    let cancelled = false;
    loadGroupState().finally(() => {
      gateLoaded = true;
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
        <Text as="p" tone="subdued">Loading...</Text>
      </div>
    );
  }

  const groups = getCachedGroups() || [];
  const needChoice = groups.length > 0 && getGroupChoice() === null;
  if (!needChoice) return <Outlet />;

  const pick = async (value) => {
    if (saving) return;
    setSaving(true);
    try { await chooseGroup(value); } finally {
      setSaving(false);
      bump((n) => n + 1); // choice is set → the page the user asked for renders
    }
  };

  return (
    <Page title="Choose User Group" backAction={{ onAction: () => navigate('/') }}>
      <div style={{ maxWidth: '660px', margin: '0 auto' }}>
        <BlockStack gap="400">
          <Text as="p" tone="subdued" alignment="center">
            You can change or reset your choice in Settings - User group
          </Text>
          {groups.map((g) => (
            <GroupCard
              key={g.id}
              title={g.name}
              subtitle={(g.types || []).join(', ')}
              disabled={saving}
              onClick={() => pick(g.id)}
            />
          ))}
          <GroupCard title="ALL" subtitle="All the types" disabled={saving} onClick={() => pick('ALL')} />
        </BlockStack>
      </div>
    </Page>
  );
}
