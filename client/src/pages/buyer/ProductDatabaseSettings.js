import React, { useState, useEffect, useRef } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Button, TextField, Banner, Spinner, Badge,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function ProductDatabaseSettings() {
  const navigate = useNavigate();

  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [syncing, setSyncing]           = useState(false);
  const [error, setError]               = useState('');
  const [saveSuccess, setSaveSuccess]   = useState(false);
  const [syncStarted, setSyncStarted]   = useState(false);

  const [intervalHours, setIntervalHours]   = useState('12');
  const [intervalInput, setIntervalInput]   = useState('12');
  const [totalVariants, setTotalVariants]   = useState(null);
  const [lastSyncedAt, setLastSyncedAt]     = useState(null);
  const [lastSyncCount, setLastSyncCount]   = useState(null);
  const [isSyncing, setIsSyncing]           = useState(false);

  const pollTimer = useRef(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/shopify/product-db-settings');
      if (!res.ok) throw new Error('Failed to load settings');
      const data = await res.json();
      setIntervalHours(String(data.intervalHours));
      setIntervalInput(String(data.intervalHours));
      setTotalVariants(data.totalVariants);
      setLastSyncedAt(data.lastSyncedAt);
      setLastSyncCount(data.lastSyncCount);
      setIsSyncing(data.isSyncing);
      return data.isSyncing;
    } catch (e) {
      setError(e.message);
      return false;
    }
  };

  // Poll every 4 seconds while a sync is running
  const startPolling = () => {
    if (pollTimer.current) return;
    pollTimer.current = setInterval(async () => {
      const stillSyncing = await fetchStatus();
      if (!stillSyncing) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
        setSyncing(false);
      }
    }, 4000);
  };

  useEffect(() => {
    fetchStatus().then(stillSyncing => {
      setLoading(false);
      if (stillSyncing) {
        setSyncing(true);
        startPolling();
      }
    });
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  const handleSave = async () => {
    const hours = parseInt(intervalInput);
    if (isNaN(hours) || hours < 1 || hours > 168) {
      setError('Please enter a number between 1 and 168.');
      return;
    }
    setSaving(true);
    setError('');
    setSaveSuccess(false);
    try {
      const res = await fetch('/api/shopify/product-db-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalHours: hours }),
      });
      if (!res.ok) throw new Error('Failed to save settings');
      setIntervalHours(String(hours));
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncStarted(false);
    setError('');
    try {
      const res = await fetch('/api/shopify/sync-variant-index', { method: 'POST' });
      if (res.status === 409) {
        // Already running — just start polling
        setIsSyncing(true);
        startPolling();
        return;
      }
      if (!res.ok) throw new Error('Failed to start sync');
      setSyncStarted(true);
      setIsSyncing(true);
      startPolling();
    } catch (e) {
      setError(e.message);
      setSyncing(false);
    }
  };

  const formatDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  };

  const isDirty = intervalInput !== intervalHours;

  return (
    <Page
      title="Product Database"
      backAction={{ onAction: () => navigate('/buyer/settings') }}
    >
      <Layout>

        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>
          </Layout.Section>
        )}

        {loading ? (
          <Layout.Section>
            <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
              <Spinner />
            </div>
          </Layout.Section>
        ) : (
          <>
            {/* Status card */}
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingSm">Database Status</Text>

                  <InlineStack gap="600" wrap={false}>
                    <BlockStack gap="100">
                      <Text variant="bodySm" tone="subdued">Total variants indexed</Text>
                      <Text variant="bodyMd" fontWeight="semibold">
                        {totalVariants !== null ? totalVariants.toLocaleString() : '—'}
                      </Text>
                    </BlockStack>

                    <BlockStack gap="100">
                      <Text variant="bodySm" tone="subdued">Last synced</Text>
                      <Text variant="bodyMd" fontWeight="semibold">{formatDate(lastSyncedAt)}</Text>
                    </BlockStack>

                    {lastSyncCount !== null && (
                      <BlockStack gap="100">
                        <Text variant="bodySm" tone="subdued">Variants in last sync</Text>
                        <Text variant="bodyMd" fontWeight="semibold">{lastSyncCount.toLocaleString()}</Text>
                      </BlockStack>
                    )}

                    <BlockStack gap="100">
                      <Text variant="bodySm" tone="subdued">Status</Text>
                      {isSyncing
                        ? <Badge tone="attention">Syncing…</Badge>
                        : <Badge tone="success">Idle</Badge>
                      }
                    </BlockStack>
                  </InlineStack>

                  <InlineStack gap="300" align="start">
                    <Button
                      variant="primary"
                      onClick={handleSyncNow}
                      loading={syncing}
                      disabled={syncing}
                    >
                      Sync now
                    </Button>
                    {syncStarted && !syncing && (
                      <Text variant="bodySm" tone="success">Sync complete.</Text>
                    )}
                    {syncing && (
                      <Text variant="bodySm" tone="subdued">
                        Syncing in background — this may take 1–2 minutes…
                      </Text>
                    )}
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>

            {/* Interval settings card */}
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingSm">Auto Sync Interval</Text>
                  <Text variant="bodySm" tone="subdued">
                    The product database syncs automatically from Shopify on this interval.
                    Minimum 1 hour, maximum 168 hours (7 days).
                  </Text>

                  <InlineStack gap="300" align="start" blockAlign="end">
                    <div style={{ width: 120 }}>
                      <TextField
                        label="Interval (hours)"
                        type="number"
                        min="1"
                        max="168"
                        value={intervalInput}
                        onChange={(val) => {
                          setIntervalInput(val);
                          setError('');
                          setSaveSuccess(false);
                        }}
                        autoComplete="off"
                      />
                    </div>
                    <div style={{ paddingBottom: 2 }}>
                      <Button
                        variant="primary"
                        onClick={handleSave}
                        loading={saving}
                        disabled={saving || !isDirty}
                      >
                        Save
                      </Button>
                    </div>
                  </InlineStack>

                  {saveSuccess && (
                    <Banner tone="success">
                      Sync interval updated to {intervalHours} hour{intervalHours !== '1' ? 's' : ''}.
                      The scheduler has been restarted.
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          </>
        )}

      </Layout>
    </Page>
  );
}

export default ProductDatabaseSettings;