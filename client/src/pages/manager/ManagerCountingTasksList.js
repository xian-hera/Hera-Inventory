import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Select, Text, DataTable, Banner, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}.${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ManagerCountingTasksList() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [department, setDepartment] = useState('ALL');
  const [date, setDate] = useState('ALL');

  const location = localStorage.getItem('managerLocation') || '';

  const fetchTasks = useCallback(async () => {
    if (!location) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.append('status', 'counting');
      params.append('location', location);
      if (department !== 'ALL') params.append('department', department);
      if (date !== 'ALL') params.append('date', date);

      const res = await fetch(`/api/tasks?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTasks(data);
    } catch (e) {
      setError('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [location, department, date]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const rows = tasks.map(task => [
    <Button variant="plain" onClick={() => navigate(`/manager/counting-tasks/${task.id}`)}>
      {task.task_no}
    </Button>,
    task.department,
    task.inaccurate_count > 0 ? `${task.inaccurate_count} off qty` : '',
    formatDate(task.created_at),
    `${task.processed_count || 0}/${task.total_count || 0}`,
  ]);

  return (
    <Page
      title="Counting tasks"
      backAction={{ onAction: () => navigate('/manager') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical">{error}</Banner>}

            <Card>
              <InlineStack gap="400" wrap>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Department</Text>
                  <Select
                    label="" labelHidden
                    options={[
                      { label: 'ALL', value: 'ALL' },
                      { label: 'CARE', value: 'CARE' },
                      { label: 'HAIR', value: 'HAIR' },
                      { label: 'GENM', value: 'GENM' },
                    ]}
                    value={department}
                    onChange={setDepartment}
                  />
                </BlockStack>

                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">Date</Text>
                  <Select
                    label="" labelHidden
                    options={[
                      { label: 'ALL', value: 'ALL' },
                      { label: 'Today', value: 'today' },
                      { label: '7 days', value: '7days' },
                      { label: '30 days', value: '30days' },
                    ]}
                    value={date}
                    onChange={setDate}
                  />
                </BlockStack>
              </InlineStack>
            </Card>

            <Card>
              {loading ? <Spinner /> : (
                <DataTable
                  columnContentTypes={['text','text','text','text','text']}
                  headings={['No.', 'Department', '', 'Date', 'Progress']}
                  rows={rows}
                />
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ManagerCountingTasksList;