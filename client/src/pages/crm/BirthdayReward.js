import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button,
  Select, TextField, Banner, Spinner, Badge, Divider, Box, IndexTable,
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

function BirthdayReward() {
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

  const fetchActive = useCallback(async () => {
    try {
      setActiveLoading(true);
      const res  = await fetch('/api/birthday-config/active');
      const data = await res.json();
      setActiveRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError('Failed to load active customers: ' + err.message);
    } finally {
      setActiveLoading(false);
    }
  }, []);

  useEffect(() => { fetchConfig(); fetchActive(); }, [fetchConfig, fetchActive]);

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
      <Page title="Birthday Reward" backAction={{ onAction: () => navigate('/crm') }}>
        <Layout><Layout.Section><InlineStack align="center"><Spinner /></InlineStack></Layout.Section></Layout>
      </Page>
    );
  }

  const resourceName = { singular: 'customer', plural: 'customers' };

  return (
    <Page
      title="Birthday Reward"
      backAction={{ onAction: () => navigate('/crm') }}
      primaryAction={{ content: saving ? 'Saving...' : 'Save', onAction: handleSave, loading: saving }}
    >
      <Layout>

        {/* 顶部：查看消费记录按钮 */}
        <Layout.Section>
          <InlineStack align="end">
            <Button onClick={() => navigate('/crm/birthday-reward/orders')}>
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
                <Button variant="plain" onClick={fetchActive}>Refresh</Button>
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
    </Page>
  );
}

export default BirthdayReward;