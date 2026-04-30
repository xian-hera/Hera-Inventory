import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, IndexTable, Text, Badge, TextField,
  InlineStack, Button, Spinner, Banner, Box, BlockStack,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function BirthdaySubscribers() {
  const navigate = useNavigate();

  const [rows, setRows]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [search, setSearch]       = useState('');
  const [filterTag, setFilterTag] = useState(false);

  const fetchSubscribers = useCallback(async () => {
    try {
      setLoading(true);
      const res  = await fetch('/api/birthday-config/subscribers');
      const data = await res.json();
      setRows(data);
    } catch (err) {
      setError('Failed to load subscribers: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSubscribers(); }, [fetchSubscribers]);

  const filtered = rows.filter((r) => {
    const matchSearch = !search || r.email.toLowerCase().includes(search.toLowerCase());
    const matchTag    = !filterTag || r.has_tag;
    return matchSearch && matchTag;
  });

  const handleDownloadCSV = () => {
    const headers = ['Email', 'Birth Month', 'Birth Day', 'Has Tag', 'Added At'];
    const csvRows = [
      headers.join(','),
      ...filtered.map((r) =>
        [
          r.email,
          r.birth_month,
          r.birth_day,
          r.has_tag ? 'Yes' : 'No',
          new Date(r.created_at).toLocaleDateString(),
        ].join(',')
      ),
    ];
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `birthday_subscribers_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resourceName = { singular: 'subscriber', plural: 'subscribers' };

  return (
    <Page
      title="Birthday Subscribers"
      backAction={{ onAction: () => navigate('/crm/birthday-reward') }}
      primaryAction={{ content: 'Download CSV', onAction: handleDownloadCSV }}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="end" gap="400">
                <Box minWidth="300px">
                  <TextField
                    label="Search by email"
                    value={search}
                    onChange={setSearch}
                    clearButton
                    onClearButtonClick={() => setSearch('')}
                    autoComplete="off"
                  />
                </Box>
                <Button
                  variant={filterTag ? 'primary' : 'secondary'}
                  onClick={() => setFilterTag((v) => !v)}
                >
                  {filterTag ? 'Showing: Has Tag' : 'Show All'}
                </Button>
              </InlineStack>

              <Text variant="bodySm" tone="subdued">
                {filtered.length} subscriber{filtered.length !== 1 ? 's' : ''}
                {filterTag ? ' with active tag' : ''}
              </Text>

              {loading ? (
                <InlineStack align="center"><Spinner /></InlineStack>
              ) : (
                <IndexTable
                  resourceName={resourceName}
                  itemCount={filtered.length}
                  headings={[
                    { title: 'Email' },
                    { title: 'Birthday' },
                    { title: 'Tag Status' },
                    { title: 'Added' },
                  ]}
                  selectable={false}
                >
                  {filtered.map((row, i) => (
                    <IndexTable.Row id={row.customer_id} key={row.customer_id} position={i}>
                      <IndexTable.Cell>
                        <Text variant="bodyMd">{row.email}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text variant="bodyMd">
                          {String(row.birth_month).padStart(2, '0')} / {String(row.birth_day).padStart(2, '0')}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.has_tag
                          ? <Badge tone="success">Has Tag</Badge>
                          : <Badge tone="new">No Tag</Badge>}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text variant="bodyMd" tone="subdued">
                          {new Date(row.created_at).toLocaleDateString()}
                        </Text>
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

export default BirthdaySubscribers;