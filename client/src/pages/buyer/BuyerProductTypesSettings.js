import React, { useState, useEffect, useCallback } from 'react';
import { Page, Layout, Card, BlockStack, InlineStack, Text, Checkbox, Banner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import { invalidateProductTypes } from '../../productTypes';

// Settings → Product Types (2026-10-21, Hera).
// The Hub's central list of product types. "Sync from Shopify" refreshes it:
// new types are added (on), types that no longer exist in Shopify are marked
// "Not in Shopify" and switched off. A switched-off type is hidden from every
// dropdown in the Hub (old tasks / records keep showing it).
function BuyerProductTypesSettings() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState(null); // { tone, text }

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/shopify/product-types/all');
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setRows([]);
      setNotice({ tone: 'critical', text: `Could not load types: ${e.message}` });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const sync = async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const res = await fetch('/api/shopify/product-types/sync', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      invalidateProductTypes();
      const parts = [`${d.total} types in Shopify.`];
      if (d.added) parts.push(`${d.added} new.`);
      if ((d.removed || []).length) parts.push(`No longer in Shopify (switched off): ${d.removed.join(', ')}.`);
      if (!d.added && !(d.removed || []).length) parts.push('No changes.');
      setNotice({ tone: 'success', text: parts.join(' ') });
      await load();
    } catch (e) {
      setNotice({ tone: 'critical', text: `Sync failed: ${e.message}` });
    } finally {
      setSyncing(false);
    }
  };

  const toggle = async (name, enabled) => {
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.name === name ? { ...r, enabled } : r)));
    try {
      const res = await fetch('/api/shopify/product-types/enabled', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, enabled }),
      });
      if (!res.ok) throw new Error('Save failed');
      invalidateProductTypes();
    } catch (e) {
      setRows(prev);
      setNotice({ tone: 'critical', text: e.message });
    }
  };

  return (
    <Page
      title="Product Types"
      backAction={{ onAction: () => navigate('/buyer/settings') }}
      primaryAction={{ content: 'Sync from Shopify', onAction: sync, loading: syncing }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}
            <Card>
              <BlockStack gap="300">
                <Text as="p" tone="subdued">
                  Tick the types the Hub should use. A type that is switched off does not appear in any dropdown.
                </Text>
                {rows === null ? (
                  <Text as="p" tone="subdued">Loading...</Text>
                ) : rows.length === 0 ? (
                  <Text as="p" tone="subdued">No types yet. Click Sync from Shopify.</Text>
                ) : (
                  rows.map((r) => (
                    <InlineStack key={r.name} gap="300" blockAlign="center">
                      <Checkbox label={r.name} checked={!!r.enabled} onChange={(v) => toggle(r.name, v)} />
                      {!r.in_shopify && <Text as="span" variant="bodySm" tone="subdued">Not in Shopify</Text>}
                    </InlineStack>
                  ))
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default BuyerProductTypesSettings;
