import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button,
  Select, TextField, Banner, Spinner, Badge, Divider, Box,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

const HOUR_OPTIONS   = Array.from({ length: 24 }, (_, i) => ({ label: `${String(i).padStart(2, '0')}`, value: String(i) }));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => ({ label: `${String(i).padStart(2, '0')}`, value: String(i) }));

function BirthdayReward() {
  const navigate = useNavigate();

  const [config, setConfig]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState('');

  // Local form state
  const [enabled,           setEnabled]           = useState(true);
  const [addJobEnabled,     setAddJobEnabled]     = useState(true);
  const [addJobHour,        setAddJobHour]        = useState('9');
  const [addJobMinute,      setAddJobMinute]      = useState('0');
  const [removeJobEnabled,  setRemoveJobEnabled]  = useState(true);
  const [removeJobHour,     setRemoveJobHour]     = useState('23');
  const [removeJobMinute,   setRemoveJobMinute]   = useState('50');
  const [tagDelayHours,     setTagDelayHours]     = useState('48');
  const [campaignTag,       setCampaignTag]       = useState('birthday_campaign');

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      const res  = await fetch('/api/birthday-config');
      const data = await res.json();
      setConfig(data);
      setEnabled(data.enabled);
      setAddJobEnabled(data.add_job_enabled);
      setAddJobHour(String(data.add_job_hour));
      setAddJobMinute(String(data.add_job_minute));
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

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

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
          add_job_enabled:    addJobEnabled,
          add_job_hour:       parseInt(addJobHour),
          add_job_minute:     parseInt(addJobMinute),
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

  return (
    <Page
      title="Birthday Reward"
      backAction={{ onAction: () => navigate('/crm') }}
      primaryAction={{ content: saving ? 'Saving...' : 'Save', onAction: handleSave, loading: saving }}
    >
      <Layout>

        {/* 顶部：浏览表单按钮 */}
        <Layout.Section>
          <InlineStack align="end">
            <Button onClick={() => navigate('/crm/birthday-reward/subscribers')}>
              View Subscriber List
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
                    When disabled, all webhooks, jobs, and tag operations are paused.
                  </Text>
                </BlockStack>
                <Button
                  variant={enabled ? 'primary' : 'secondary'}
                  tone={enabled ? undefined : 'critical'}
                  onClick={() => setEnabled((v) => !v)}
                >
                  {enabled ? 'Enabled' : 'Disabled'}
                </Button>
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
                This tag is added on birthdays and removed after the delay period.
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

        {/* Card 3：添加 tag Job */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingMd">Add Tag Job</Text>
                  <Text variant="bodySm" tone="subdued">
                    Runs daily to add the campaign tag to customers whose birthday is tomorrow.
                  </Text>
                </BlockStack>
                <Badge tone={addJobEnabled ? 'success' : 'critical'}>
                  {addJobEnabled ? 'On' : 'Off'}
                </Badge>
              </InlineStack>

              <Divider />

              <InlineStack gap="400" blockAlign="end">
                <Box minWidth="120px">
                  <Select
                    label="Hour"
                    options={HOUR_OPTIONS}
                    value={addJobHour}
                    onChange={setAddJobHour}
                  />
                </Box>
                <Box minWidth="120px">
                  <Select
                    label="Minute"
                    options={MINUTE_OPTIONS}
                    value={addJobMinute}
                    onChange={setAddJobMinute}
                  />
                </Box>
                <Button
                  variant={addJobEnabled ? 'secondary' : 'primary'}
                  onClick={() => setAddJobEnabled((v) => !v)}
                >
                  {addJobEnabled ? 'Disable Job' : 'Enable Job'}
                </Button>
              </InlineStack>

              <Text variant="bodySm" tone="subdued">
                Scheduled time (Montreal): {String(addJobHour).padStart(2, '0')}:{String(addJobMinute).padStart(2, '0')}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Card 4：移除 tag Job */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingMd">Remove Tag Job</Text>
                  <Text variant="bodySm" tone="subdued">
                    Runs daily to remove expired campaign tags.
                  </Text>
                </BlockStack>
                <Badge tone={removeJobEnabled ? 'success' : 'critical'}>
                  {removeJobEnabled ? 'On' : 'Off'}
                </Badge>
              </InlineStack>

              <Divider />

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
                  variant={removeJobEnabled ? 'secondary' : 'primary'}
                  onClick={() => setRemoveJobEnabled((v) => !v)}
                >
                  {removeJobEnabled ? 'Disable Job' : 'Enable Job'}
                </Button>
              </InlineStack>

              <Divider />

              <TextField
                label="Tag delay (hours)"
                type="number"
                value={tagDelayHours}
                onChange={setTagDelayHours}
                helpText="How many hours after adding the tag before it is automatically removed."
                autoComplete="off"
                min="1"
              />

              <Text variant="bodySm" tone="subdued">
                Scheduled time (Montreal): {String(removeJobHour).padStart(2, '0')}:{String(removeJobMinute).padStart(2, '0')}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>
    </Page>
  );
}

export default BirthdayReward;