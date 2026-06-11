import React, { useState, useCallback } from 'react';
import {
  Page, Layout, Card, IndexTable, Text, Badge, TextField,
  InlineStack, Button, Spinner, Banner, Box, BlockStack, Select, Modal,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

function money(amount, currency) {
  const n = Number(amount || 0);
  return `${n.toFixed(2)} ${currency || 'CAD'}`;
}

const RANGE_OPTIONS = [
  { label: 'Last 30 days', value: '30' },
  { label: 'All time', value: 'all' },
];

function BirthdayOrders() {
  const navigate = useNavigate();

  const [rows, setRows]         = useState([]);
  const [earliest, setEarliest] = useState(null);
  const [loaded, setLoaded]     = useState(false);   // 是否已点过 Calculate
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [info, setInfo]         = useState('');

  const [range, setRange]   = useState('30');         // 默认 30 天
  const [search, setSearch] = useState('');
  const [onlyWithOrders, setOnlyWithOrders] = useState(false);
  const [expanded, setExpanded] = useState({});

  const [purgeOpen, setPurgeOpen]     = useState(false);
  const [purging, setPurging]         = useState(false);

  // 点 Calculate 才查表
  const handleCalculate = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const res  = await fetch(`/api/birthday-config/orders?range=${range}`);
      const data = await res.json();
      setRows(Array.isArray(data.records) ? data.records : []);
      setEarliest(data.earliest || null);
      setLoaded(true);
    } catch (err) {
      setError('Failed to load spending records: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [range]);

  const handlePurge = async () => {
    try {
      setPurging(true);
      const res  = await fetch('/api/birthday-config/orders/purge', { method: 'DELETE' });
      const data = await res.json();
      setInfo(`Deleted ${data.deleted} record(s) older than 365 days.`);
      setPurgeOpen(false);
      // 清空后刷新当前视图（若已加载过）
      if (loaded) await handleCalculate();
    } catch (err) {
      setError('Failed to purge: ' + err.message);
      setPurgeOpen(false);
    } finally {
      setPurging(false);
    }
  };

  const filtered = rows.filter((r) => {
    const label = (r.email || r.customer_id || '').toLowerCase();
    const matchSearch = !search || label.includes(search.toLowerCase());
    const matchOrders = !onlyWithOrders || Number(r.order_count) > 0;
    return matchSearch && matchOrders;
  });

  const toggleExpand = (logId) => {
    setExpanded((prev) => ({ ...prev, [logId]: !prev[logId] }));
  };

  // CSV：一行一笔订单；没有订单的顾客也保留一行（订单字段留空）
  const handleDownloadCSV = () => {
    const headers = [
      'Customer', 'Tag Added', 'Tag Removed (scheduled)', 'Status',
      'Order Count', 'Total Amount', 'Currency',
      'Order Name', 'Order Amount', 'Order Date',
    ];
    const lines = [headers.join(',')];

    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    filtered.forEach((r) => {
      const base = [
        r.email || r.customer_id,
        formatDate(r.tag_added_at),
        formatDate(r.tag_remove_at),
        r.status,
        r.order_count,
        Number(r.total_amount || 0).toFixed(2),
        r.currency || '',
      ];
      const orders = Array.isArray(r.orders) ? r.orders : [];
      if (orders.length === 0) {
        lines.push([...base, '', '', ''].map(esc).join(','));
      } else {
        orders.forEach((o) => {
          lines.push([
            ...base,
            o.orderName,
            Number(o.amount || 0).toFixed(2),
            formatDate(o.createdAt),
          ].map(esc).join(','));
        });
      }
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `birthday_spending_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resourceName = { singular: 'record', plural: 'records' };

  return (
    <Page
      title="Birthday Spending Records"
      subtitle="Orders placed by customers while they held the campaign tag"
      backAction={{ onAction: () => navigate('/crm/birthday-reward') }}
      primaryAction={{ content: 'Download CSV', onAction: handleDownloadCSV, disabled: !loaded || filtered.length === 0 }}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>
          </Layout.Section>
        )}
        {info && (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => setInfo('')}>{info}</Banner>
          </Layout.Section>
        )}

        {/* 控制区：范围选择 + Calculate + 清空按钮 */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="end" gap="400">
                <InlineStack gap="400" blockAlign="end">
                  <Box minWidth="200px">
                    <Select
                      label="Date range"
                      options={RANGE_OPTIONS}
                      value={range}
                      onChange={setRange}
                    />
                  </Box>
                  <Button variant="primary" onClick={handleCalculate} loading={loading}>
                    Calculate
                  </Button>
                </InlineStack>
                <Button tone="critical" onClick={() => setPurgeOpen(true)}>
                  Delete records older than 365 days
                </Button>
              </InlineStack>

              <Text variant="bodySm" tone="subdued">
                {earliest
                  ? `Records since: ${formatDate(earliest)}`
                  : 'Records since: — (no data yet)'}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* 结果区 */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {!loaded ? (
                <Box padding="400">
                  <Text variant="bodyMd" tone="subdued" alignment="center">
                    Choose a date range and press Calculate to load spending records.
                  </Text>
                </Box>
              ) : (
                <>
                  <InlineStack align="space-between" blockAlign="end" gap="400">
                    <Box minWidth="300px">
                      <TextField
                        label="Search by customer"
                        value={search}
                        onChange={setSearch}
                        clearButton
                        onClearButtonClick={() => setSearch('')}
                        autoComplete="off"
                      />
                    </Box>
                    <Button
                      variant={onlyWithOrders ? 'primary' : 'secondary'}
                      onClick={() => setOnlyWithOrders((v) => !v)}
                    >
                      {onlyWithOrders ? 'Showing: With Orders' : 'Show All'}
                    </Button>
                  </InlineStack>

                  <Text variant="bodySm" tone="subdued">
                    {filtered.length} record{filtered.length !== 1 ? 's' : ''}
                    {onlyWithOrders ? ' with orders' : ''}
                    {range === '30' ? ' · last 30 days' : ' · all time'}
                  </Text>

                  {loading ? (
                    <InlineStack align="center"><Spinner /></InlineStack>
                  ) : (
                    <IndexTable
                      resourceName={resourceName}
                      itemCount={filtered.length}
                      headings={[
                        { title: 'Customer' },
                        { title: 'Tag period' },
                        { title: 'Status' },
                        { title: 'Orders' },
                        { title: 'Total' },
                        { title: '' },
                      ]}
                      selectable={false}
                    >
                      {filtered.map((r, i) => {
                        const orders = Array.isArray(r.orders) ? r.orders : [];
                        const isOpen = !!expanded[r.log_id];
                        return (
                          <React.Fragment key={r.log_id}>
                            <IndexTable.Row id={String(r.log_id)} position={i}>
                              <IndexTable.Cell>
                                <Text variant="bodyMd">{r.email || r.customer_id}</Text>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <Text variant="bodyMd" tone="subdued">
                                  {formatDate(r.tag_added_at)} → {formatDate(r.tag_remove_at)}
                                </Text>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                {r.status === 'pending'
                                  ? <Badge tone="attention">Active</Badge>
                                  : r.status === 'removed'
                                    ? <Badge tone="success">Completed</Badge>
                                    : <Badge tone="critical">Failed</Badge>}
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <Text variant="bodyMd">{r.order_count}</Text>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <Text variant="bodyMd">{money(r.total_amount, r.currency)}</Text>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                {orders.length > 0 && (
                                  <Button variant="plain" onClick={() => toggleExpand(r.log_id)}>
                                    {isOpen ? 'Hide' : 'Details'}
                                  </Button>
                                )}
                              </IndexTable.Cell>
                            </IndexTable.Row>

                            {isOpen && orders.map((o, j) => (
                              <IndexTable.Row
                                id={`${r.log_id}-order-${j}`}
                                key={`${r.log_id}-order-${j}`}
                                position={i + 0.5}
                              >
                                <IndexTable.Cell>
                                  <Text variant="bodySm" tone="subdued">↳ {o.orderName}</Text>
                                </IndexTable.Cell>
                                <IndexTable.Cell>
                                  <Text variant="bodySm" tone="subdued">{formatDate(o.createdAt)}</Text>
                                </IndexTable.Cell>
                                <IndexTable.Cell><Text variant="bodySm"> </Text></IndexTable.Cell>
                                <IndexTable.Cell><Text variant="bodySm"> </Text></IndexTable.Cell>
                                <IndexTable.Cell>
                                  <Text variant="bodySm">{money(o.amount, o.currency)}</Text>
                                </IndexTable.Cell>
                                <IndexTable.Cell><Text variant="bodySm"> </Text></IndexTable.Cell>
                              </IndexTable.Row>
                            ))}
                          </React.Fragment>
                        );
                      })}
                    </IndexTable>
                  )}
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* 清空确认弹窗 */}
      <Modal
        open={purgeOpen}
        onClose={() => setPurgeOpen(false)}
        title="Delete old records"
        primaryAction={{
          content: 'Delete',
          destructive: true,
          onAction: handlePurge,
          loading: purging,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setPurgeOpen(false) }]}
      >
        <Modal.Section>
          <Text variant="bodyMd">
            This permanently deletes all spending records whose tag period began more than 365 days ago.
            This cannot be undone.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default BirthdayOrders;