import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button,
  Select, TextField, Banner, Spinner, Badge, Divider, Box, IndexTable,
  Modal, ProgressBar,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const HOUR_OPTIONS   = Array.from({ length: 24 }, (_, i) => ({ label: `${String(i).padStart(2, '0')}`, value: String(i) }));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => ({ label: `${String(i).padStart(2, '0')}`, value: String(i) }));

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// inTabs (2026-10-01): shown as a tab of Online (OnlineHome) — no title or back arrow of its own.
function BirthdayReward({ inTabs = false } = {}) {
  const navigate = useNavigate();

  const [config, setConfig]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState('');

  // ── 配置项（仅保留 Remove Job 相关） ──
  const [enabled,          setEnabled]          = useState(true);
  const [removeJobEnabled, setRemoveJobEnabled] = useState(true);
  const [removeJobHour,    setRemoveJobHour]    = useState('23');
  const [removeJobMinute,  setRemoveJobMinute]  = useState('30');
  const [tagDelayHours,    setTagDelayHours]    = useState('48');
  const [campaignTag,      setCampaignTag]      = useState('birthday_campaign');

  // ── 当前持有 tag 的顾客 ──
  const [activeRows, setActiveRows]       = useState([]);
  const [activeLoading, setActiveLoading] = useState(true);

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      const res  = await fetch('/api/birthday-config');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`); // 2026-10-01
      setConfig(data);
      setEnabled(data.enabled);
      setRemoveJobEnabled(data.remove_job_enabled);
      setRemoveJobHour(String(data.remove_job_hour));
      setRemoveJobMinute(String(data.remove_job_minute));
      setTagDelayHours(String(data.tag_delay_hours));
      setCampaignTag(data.campaign_tag);
    } catch (err) {
      setError('Failed to load config: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── 处理失败的记录（2026-10-01） ──
  const [failedCount, setFailedCount] = useState(0);
  const [retrying, setRetrying]       = useState(false);
  const [retryInfo, setRetryInfo]     = useState('');

  const fetchActive = useCallback(async () => {
    try {
      setActiveLoading(true);
      const res  = await fetch('/api/birthday-config/active');
      const data = await res.json();
      // 2026-10-01：后端出错时显示错误，而不是静默显示空列表
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setActiveRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError('Failed to load active customers: ' + err.message);
    } finally {
      setActiveLoading(false);
    }
    // 同时刷新 failed 数量（失败不影响主列表）
    try {
      const r = await fetch('/api/birthday-config/failed-count');
      const d = await r.json();
      if (r.ok) setFailedCount(Number(d.count) || 0);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchConfig(); fetchActive(); }, [fetchConfig, fetchActive]);

  // ── 清理过期 tag（2026-10-01） ──
  // view: 'preview' | 'running' | 'done'
  const [cleanupOpen, setCleanupOpen]       = useState(false);
  const [cleanupView, setCleanupView]       = useState('preview');
  const [cleanupPreview, setCleanupPreview] = useState(null);
  const [cleanupState, setCleanupState]     = useState(null);
  const [cleanupBusy, setCleanupBusy]       = useState(false);
  const [cleanupError, setCleanupError]     = useState('');
  const pollRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };
  useEffect(() => stopPolling, []);

  const pollCleanupStatus = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch('/api/birthday-config/cleanup-stale-tags/status');
        const s = await r.json();
        setCleanupState(s);
        if (!s.running) {
          stopPolling();
          setCleanupView('done');
          fetchActive();
        }
      } catch { /* 下次再试 */ }
    }, 2000);
  }, [fetchActive]);

  const openCleanup = async () => {
    setCleanupOpen(true);
    setCleanupError('');
    setCleanupPreview(null);
    setCleanupBusy(true);
    try {
      // 若已有清理在运行（比如刷新过页面），直接显示进度
      const sr = await fetch('/api/birthday-config/cleanup-stale-tags/status');
      const s  = await sr.json();
      if (s.running) {
        setCleanupState(s);
        setCleanupView('running');
        pollCleanupStatus();
        return;
      }
      setCleanupView('preview');
      const res  = await fetch('/api/birthday-config/cleanup-stale-tags/preview');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setCleanupPreview(data);
    } catch (err) {
      setCleanupError(err.message);
    } finally {
      setCleanupBusy(false);
    }
  };

  const startCleanup = async () => {
    setCleanupBusy(true);
    setCleanupError('');
    try {
      const res  = await fetch('/api/birthday-config/cleanup-stale-tags', { method: 'POST' });
      const data = await res.json();
      if (!res.ok && res.status !== 409) throw new Error(data?.error || `HTTP ${res.status}`);
      setCleanupState(data.state || data);
      setCleanupView('running');
      pollCleanupStatus();
    } catch (err) {
      setCleanupError(err.message);
    } finally {
      setCleanupBusy(false);
    }
  };

  const closeCleanup = () => {
    // 运行中关闭弹窗不会中断后台任务，重新打开可继续看进度
    stopPolling();
    setCleanupOpen(false);
  };

  // 把 failed 记录改回 pending，等下一次 Remove Job 重新处理
  const handleRetryFailed = async () => {
    try {
      setRetrying(true);
      const res  = await fetch('/api/birthday-config/retry-failed', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setRetryInfo(`${data.reset} record(s) queued for retry. They will be processed at the next scheduled removal time.`);
      await fetchActive();
    } catch (err) {
      setError('Failed to retry: ' + err.message);
    } finally {
      setRetrying(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await fetch('/api/birthday-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          remove_job_enabled: removeJobEnabled,
          remove_job_hour:    parseInt(removeJobHour),
          remove_job_minute:  parseInt(removeJobMinute),
          tag_delay_hours:    parseInt(tagDelayHours),
          campaign_tag:       campaignTag.trim(),
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError('Failed to save: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Page title={inTabs ? undefined : 'Birthday Reward'} backAction={inTabs ? undefined : { onAction: () => navigate('/online') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }

  const resourceName = { singular: 'customer', plural: 'customers' };

  return (
    <Page
      title={inTabs ? undefined : 'Birthday Reward'}
      backAction={inTabs ? undefined : { onAction: () => navigate('/online') }}
      primaryAction={{ content: saving ? 'Saving...' : 'Save', onAction: handleSave, loading: saving }}
    >
      <Layout>

        {/* 顶部：查看消费记录按钮 */}
        <Layout.Section>
          <InlineStack align="end">
            <Button onClick={() => navigate('/online/birthday-reward/orders')}>
              View Spending Records
            </Button>
          </InlineStack>
        </Layout.Section>

        {saved && (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => setSaved(false)}>
              Settings saved and scheduler restarted.
            </Banner>
          </Layout.Section>
        )}

        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>
          </Layout.Section>
        )}

        {retryInfo && (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => setRetryInfo('')}>{retryInfo}</Banner>
          </Layout.Section>
        )}

        {/* 2026-10-01：处理失败的记录提示 + 重试 */}
        {failedCount > 0 && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={`${failedCount} tag removal${failedCount !== 1 ? 's' : ''} failed`}
              action={{ content: 'Retry failed', onAction: handleRetryFailed, loading: retrying }}
              secondaryAction={{ content: 'View records', onAction: () => navigate('/online/birthday-reward/orders') }}
            >
              These customers may still hold the tag in Shopify, and their spending was not recorded.
              Retrying moves them back to Active; they will be processed at the next scheduled removal time.
            </Banner>
          </Layout.Section>
        )}

        {/* Card 1：总开关 */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingMd">Master Switch</Text>
                  <Text variant="bodySm" tone="subdued">
                    When disabled, the claim endpoint and the tag removal job are paused.
                  </Text>
                </BlockStack>
                <InlineStack gap="300" blockAlign="center">
                  <Badge tone={enabled ? 'success' : 'critical'}>
                    {enabled ? 'Active' : 'Inactive'}
                  </Badge>
                  <Button
                    tone={enabled ? 'critical' : undefined}
                    onClick={() => setEnabled((v) => !v)}
                  >
                    {enabled ? 'Disable' : 'Enable'}
                  </Button>
                </InlineStack>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Card 2：Tag 名称 */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Campaign Tag</Text>
              <Text variant="bodySm" tone="subdued">
                The tag added when a customer claims their birthday reward, and removed after the delay period.
              </Text>
              <TextField
                label="Tag name"
                value={campaignTag}
                onChange={setCampaignTag}
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Card 3：移除 tag Job 设置 */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingMd">Tag Removal</Text>
                  <Text variant="bodySm" tone="subdued">
                    Sets how long a tag lasts and when each day it is removed.
                  </Text>
                </BlockStack>
                <Badge tone={removeJobEnabled ? 'success' : 'critical'}>
                  {removeJobEnabled ? 'On' : 'Off'}
                </Badge>
              </InlineStack>

              <Divider />

              <TextField
                label="Tag duration (hours)"
                type="number"
                value={tagDelayHours}
                onChange={setTagDelayHours}
                helpText="How many hours after a customer claims the reward before the tag is scheduled for removal."
                autoComplete="off"
                min="1"
              />

              <Text variant="bodySm" tone="subdued">
                Removal time (the tag is removed at this time on the day the duration elapses):
              </Text>

              <InlineStack gap="400" blockAlign="end">
                <Box minWidth="120px">
                  <Select
                    label="Hour"
                    options={HOUR_OPTIONS}
                    value={removeJobHour}
                    onChange={setRemoveJobHour}
                  />
                </Box>
                <Box minWidth="120px">
                  <Select
                    label="Minute"
                    options={MINUTE_OPTIONS}
                    value={removeJobMinute}
                    onChange={setRemoveJobMinute}
                  />
                </Box>
                <Button
                  tone={removeJobEnabled ? 'critical' : undefined}
                  onClick={() => setRemoveJobEnabled((v) => !v)}
                >
                  {removeJobEnabled ? 'Disable Job' : 'Enable Job'}
                </Button>
              </InlineStack>

              <Text variant="bodySm" tone="subdued">
                Scheduled removal time (Montreal): {String(removeJobHour).padStart(2, '0')}:{String(removeJobMinute).padStart(2, '0')}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Card 4：当前持有 tag 的顾客 */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd">Customers With Active Tag</Text>
                <InlineStack gap="300" blockAlign="center">
                  <Button variant="plain" tone="critical" onClick={openCleanup}>Clean up expired tags</Button>
                  <Button variant="plain" onClick={fetchActive}>Refresh</Button>
                </InlineStack>
              </InlineStack>
              <Text variant="bodySm" tone="subdued">
                {activeRows.length} customer{activeRows.length !== 1 ? 's' : ''} currently hold the tag.
              </Text>

              {activeLoading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : (
                <IndexTable
                  resourceName={resourceName}
                  itemCount={activeRows.length}
                  headings={[
                    { title: 'Customer' },
                    { title: 'Tag added' },
                    { title: 'Scheduled removal' },
                  ]}
                  selectable={false}
                >
                  {activeRows.map((row, i) => (
                    <IndexTable.Row id={String(row.id)} key={row.id} position={i}>
                      <IndexTable.Cell>
                        <Text variant="bodyMd">{row.email || row.customer_id}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text variant="bodyMd">{formatDateTime(row.tag_added_at)}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text variant="bodyMd" tone="subdued">{formatDateTime(row.tag_remove_at)}</Text>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>

      {/* 2026-10-01：清理过期 tag 弹窗 */}
      <Modal
        open={cleanupOpen}
        onClose={closeCleanup}
        title="Clean up expired tags"
        primaryAction={
          cleanupView === 'preview'
            ? {
                content: cleanupPreview ? `Remove ${cleanupPreview.toRemove} tag${cleanupPreview.toRemove !== 1 ? 's' : ''}` : 'Remove',
                destructive: true,
                onAction: startCleanup,
                loading: cleanupBusy,
                disabled: !cleanupPreview || cleanupPreview.toRemove === 0,
              }
            : { content: 'Close', onAction: closeCleanup }
        }
        secondaryActions={cleanupView === 'preview' ? [{ content: 'Cancel', onAction: closeCleanup }] : []}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {cleanupError && <Banner tone="critical">{cleanupError}</Banner>}

            {cleanupView === 'preview' && (
              cleanupBusy && !cleanupPreview ? (
                <InlineStack align="center" gap="200"><Spinner size="small" /><Text>Scanning Shopify customers…</Text></InlineStack>
              ) : cleanupPreview ? (
                <BlockStack gap="200">
                  <Text variant="bodyMd">
                    <b>{cleanupPreview.tagged}</b> customer{cleanupPreview.tagged !== 1 ? 's' : ''} currently hold the tag
                    “{cleanupPreview.tag}” in Shopify.
                  </Text>
                  <Text variant="bodyMd">
                    <b>{cleanupPreview.keep}</b> {cleanupPreview.keep !== 1 ? 'are' : 'is'} still within the valid period and will be kept.
                  </Text>
                  <Text variant="bodyMd">
                    <b>{cleanupPreview.toRemove}</b> will have the tag removed.
                  </Text>
                  <Text variant="bodySm" tone="subdued">
                    This only removes the tag in Shopify. To record spending for failed records, also use “Retry failed”.
                  </Text>
                </BlockStack>
              ) : null
            )}

            {cleanupView !== 'preview' && cleanupState && (
              <BlockStack gap="200">
                {cleanupState.phase === 'scanning' ? (
                  <InlineStack gap="200"><Spinner size="small" /><Text>Scanning Shopify customers…</Text></InlineStack>
                ) : (
                  <>
                    <ProgressBar
                      progress={cleanupState.total ? Math.round(((cleanupState.removed + cleanupState.failed) / cleanupState.total) * 100) : 100}
                      tone={cleanupState.failed ? 'critical' : 'success'}
                    />
                    <Text variant="bodyMd">
                      {cleanupView === 'done' ? 'Finished. ' : 'Removing… '}
                      {cleanupState.removed} / {cleanupState.total} removed
                      {cleanupState.failed ? `, ${cleanupState.failed} failed` : ''}
                    </Text>
                  </>
                )}
                {cleanupView === 'running' && (
                  <Text variant="bodySm" tone="subdued">
                    You can close this window — the cleanup keeps running on the server.
                  </Text>
                )}
                {cleanupState.errors?.length > 0 && (
                  <Banner tone="warning" title="Errors">
                    {cleanupState.errors.map((e, i) => (
                      <div key={i}>{e.customerId ? `${e.customerId}: ` : ''}{e.message}</div>
                    ))}
                  </Banner>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default BirthdayReward;