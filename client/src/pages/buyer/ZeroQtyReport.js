import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Select, Text, DataTable, Checkbox, Banner, Badge, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01'
];

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ZeroQtyReport() {
  const navigate = useNavigate();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [committing, setCommitting] = useState(false);
  const [department, setDepartment] = useState('ALL');
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [selectedStatuses, setSelectedStatuses] = useState([]);
  const [date, setDate] = useState('ALL');
  const [selectedIds, setSelectedIds] = useState([]);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (department !== 'ALL') params.append('department', department);
      if (selectedLocations.length > 0) params.append('location', selectedLocations.join(','));
      if (selectedStatuses.length > 0) params.append('status', selectedStatuses.join(','));
      if (date !== 'ALL') params.append('date', date);
      const res = await fetch(`/api/reports?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setReports(data);
    } catch (e) {
      setError('Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [department, selectedLocations, selectedStatuses, date]);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  const handleCommitOne = async (id) => {
    try {
      const res = await fetch(`/api/reports/${id}/commit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('Failed to commit');
      fetchReports();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleCommitSelected = async () => {
    if (selectedIds.length === 0) return;
    setCommitting(true);
    try {
      for (const id of selectedIds) {
        await fetch(`/api/reports/${id}/commit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
        });
      }
      setSelectedIds([]);
      fetchReports();
    } catch (e) {
      setError('Failed to commit');
    } finally {
      setCommitting(false);
    }
  };

  const handleCommitAll = async () => {
    setCommitting(true);
    try {
      const ids = reports.filter(r => r.status === 'reviewing').map(r => r.id);
      for (const id of ids) {
        await fetch(`/api/reports/${id}/commit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
        });
      }
      setSelectedIds([]);
      fetchReports();
    } catch (e) {
      setError('Failed to commit all');
    } finally {
      setCommitting(false);
    }
  };

  const handleDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedIds.length} report(s)?`)) return;
    await fetch('/api/reports', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds }),
    });
    setSelectedIds([]);
    fetchReports();
  };

  const handleArchive = async () => {
    if (selectedIds.length === 0) return;
    await fetch('/api/reports/archive', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds }),
    });
    setSelectedIds([]);
    fetchReports();
  };

  const toggleSelectOne = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleSelectAll = () => {
    setSelectedIds(selectedIds.length === reports.length ? [] : reports.map(r => r.id));
  };

  const rows = reports.map(report => [
    <Checkbox checked={selectedIds.includes(report.id)} onChange={() => toggleSelectOne(report.id)} />,
    report.name || '-',
    report.barcode || '-',
    report.department || '-',
    report.location || '-',
    report.soh ?? '-',
    report.poh ?? '-',
    formatDate(report.submitted_at),
    report.status === 'reviewing'
      ? <Button size="slim" onClick={() => handleCommitOne(report.id)}>Commit</Button>
      : <Badge tone="success">committed</Badge>,
  ]);

  return (
    <Page title="0 quantity report" backAction={{ onAction: () => navigate('/buyer') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

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
                <MultiSelectDropdown
                  label="Location"
                  options={LOCATIONS}
                  selected={selectedLocations}
                  onChange={setSelectedLocations}
                />
                <MultiSelectDropdown
                  label="Status"
                  options={['reviewing', 'committed', 'archived']}
                  selected={selectedStatuses}
                  onChange={setSelectedStatuses}
                />
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
              <BlockStack gap="300">
                <InlineStack align="end" gap="200">
                  <Button disabled={selectedIds.length === 0 || committing} onClick={handleCommitSelected} loading={committing}>
                    Commit selected
                  </Button>
                  <Button onClick={handleCommitAll} loading={committing}>Commit all</Button>
                  <Button tone="critical" disabled={selectedIds.length === 0} onClick={handleDelete}>Delete</Button>
                  <Button disabled={selectedIds.length === 0} onClick={handleArchive}>Archive</Button>
                </InlineStack>
                {loading ? <Spinner /> : (
                  <DataTable
                    columnContentTypes={['text','text','text','text','text','numeric','numeric','text','text']}
                    headings={[
                      <Checkbox
                        checked={selectedIds.length === reports.length && reports.length > 0}
                        indeterminate={selectedIds.length > 0 && selectedIds.length < reports.length}
                        onChange={toggleSelectAll}
                      />,
                      'Name', 'SKU', 'Department', 'Location', 'SOH', 'POH', 'Date', '',
                    ]}
                    rows={rows}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default ZeroQtyReport;