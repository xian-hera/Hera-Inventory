import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, DataTable, Checkbox, Banner, Badge, Spinner
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01'
];

// 改动一：9个 Type
const TYPE_OPTIONS = [
  'Braid', 'Hair', 'Hair & Skin Care', 'Hera Beauty',
  'Jewelry', 'K-Beauty', 'Makeup', 'Tools & Accessories', 'Wig',
];

const TYPE_LABEL_MAP = {
  'Hair & Skin Care': 'Care',
  'Tools & Accessories': 'Tools + Acc.',
};

function typeDisplay(type) {
  return TYPE_LABEL_MAP[type] || type;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function ZeroQtyReport() {
  const navigate = useNavigate();
  const [reports, setReports]                   = useState([]);
  const [loading, setLoading]                   = useState(false);
  const [error, setError]                       = useState('');
  const [committing, setCommitting]             = useState(false);
  const [selectedTypes, setSelectedTypes]       = useState([]);
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [selectedStatuses, setSelectedStatuses] = useState([]);
  const [date, setDate]                         = useState('ALL');
  const [selectedIds, setSelectedIds]           = useState([]);
  const [sortMode, setSortMode]                 = useState(0);
  // 改动五.3：每行的 adjustment 编辑值，key = report.id
  const [adjustments, setAdjustments]           = useState({});

  const handleSort = () => setSortMode(prev => (prev + 1) % 3);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (selectedTypes.length > 0) params.append('type', selectedTypes.join(','));
      if (selectedLocations.length > 0) params.append('location', selectedLocations.join(','));
      if (selectedStatuses.length > 0) params.append('status', selectedStatuses.join(','));
      if (date !== 'ALL') params.append('date', date);
      const res = await fetch(`/api/reports?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setReports(data);
      // 初始化 adjustment 值
      const initAdj = {};
      data.forEach(r => {
        if (r.status === 'reviewing') {
          const adj = (r.poh ?? 0) - (r.soh ?? 0);
          initAdj[r.id] = String(adj);
        }
      });
      setAdjustments(initAdj);
    } catch (e) {
      setError('Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [selectedTypes, selectedLocations, selectedStatuses, date]);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  // 改动五.3：commit 时使用 adjustments 中的值
  const handleCommitOne = async (id) => {
    // 改动五.2：只有 committed 状态的可以 archive，reviewing 状态不能，这里是 commit reviewing
    try {
      const adjVal = adjustments[id] !== undefined ? parseInt(adjustments[id]) : undefined;
      const res = await fetch(`/api/reports/${id}/commit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adjVal !== undefined && !isNaN(adjVal) ? { adjustment: adjVal } : {}),
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
        const adjVal = adjustments[id] !== undefined ? parseInt(adjustments[id]) : undefined;
        await fetch(`/api/reports/${id}/commit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(adjVal !== undefined && !isNaN(adjVal) ? { adjustment: adjVal } : {}),
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
        const adjVal = adjustments[id] !== undefined ? parseInt(adjustments[id]) : undefined;
        await fetch(`/api/reports/${id}/commit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(adjVal !== undefined && !isNaN(adjVal) ? { adjustment: adjVal } : {}),
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
    // 改动五.2：只 archive committed 状态，过滤掉 reviewing
    const committedIds = selectedIds.filter(id => {
      const r = reports.find(r => r.id === id);
      return r && r.status === 'committed';
    });
    if (committedIds.length === 0) {
      setError('Only committed reports can be archived.');
      return;
    }
    if (committedIds.length < selectedIds.length) {
      setError(`${selectedIds.length - committedIds.length} reviewing report(s) skipped — only committed reports can be archived.`);
    }
    await fetch('/api/reports/archive', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: committedIds }),
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

  const sortedReports = (() => {
    if (sortMode === 0) return reports;
    const sorted = [...reports].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    );
    return sortMode === 2 ? sorted.reverse() : sorted;
  })();

  const sortLabel = sortMode === 0 ? 'Sort' : sortMode === 1 ? 'Sort A→Z ✓' : 'Sort Z→A ✓';

  const rows = sortedReports.map(report => {
    // 改动五.1：archived 状态显示 archived
    const statusCell = (() => {
      if (report.status === 'reviewing') return <Badge tone="warning">reviewing</Badge>;
      if (report.status === 'committed') return <Badge tone="success">committed</Badge>;
      if (report.status === 'archived')  return <Badge>archived</Badge>;
      return <Badge>{report.status}</Badge>;
    })();

    // 改动五.3：reviewing 状态显示 adjustment 输入框 + commit 按钮
    const actionCell = (() => {
      if (report.status !== 'reviewing') return statusCell;
      const adj = adjustments[report.id] ?? '';
      const defaultAdj = (report.poh ?? 0) - (report.soh ?? 0);
      return (
        <InlineStack gap="100" align="start">
          <input
            type="number"
            value={adj}
            onChange={e => setAdjustments(prev => ({ ...prev, [report.id]: e.target.value }))}
            placeholder={String(defaultAdj)}
            style={{
              width: '64px', padding: '4px 6px', border: '1px solid #c9cccf',
              borderRadius: '6px', fontSize: '13px', textAlign: 'center',
            }}
          />
          <Button size="slim" onClick={() => handleCommitOne(report.id)}>Commit</Button>
        </InlineStack>
      );
    })();

    return [
      <Checkbox checked={selectedIds.includes(report.id)} onChange={() => toggleSelectOne(report.id)} />,
      // 改动一：显示 type 而非 department
      typeDisplay(report.type) || '-',
      report.location || '-',
      formatDate(report.submitted_at),
      <div style={{ maxWidth: '200px', wordBreak: 'break-word', whiteSpace: 'normal' }}>{report.name || '-'}</div>,
      report.barcode || '-',
      report.soh ?? '-',
      report.poh ?? '-',
      actionCell,
    ];
  });

  return (
    <Page title="Zero/Low Inventory Count" backAction={{ onAction: () => navigate('/buyer') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <InlineStack gap="400" wrap>
                {/* 改动一：Types 多选，替换 Department */}
                <MultiSelectDropdown
                  label="Types"
                  options={TYPE_OPTIONS}
                  selected={selectedTypes}
                  onChange={setSelectedTypes}
                  labelMap={TYPE_LABEL_MAP}
                />
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
                  <select
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    style={{ padding: '6px 10px', border: '1px solid #c9cccf', borderRadius: '6px', fontSize: '14px' }}
                  >
                    <option value="ALL">ALL</option>
                    <option value="today">Today</option>
                    <option value="7days">7 days</option>
                    <option value="30days">30 days</option>
                  </select>
                </BlockStack>
              </InlineStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" gap="200">
                  <button
                    onClick={handleSort}
                    style={{
                      padding: '6px 14px', borderRadius: '20px', border: '1px solid #c9cccf',
                      background: sortMode !== 0 ? '#1a1a1a' : 'white',
                      color: sortMode !== 0 ? 'white' : '#202223',
                      cursor: 'pointer', fontSize: '13px',
                      fontWeight: sortMode !== 0 ? '600' : '400', whiteSpace: 'nowrap',
                    }}
                  >
                    {sortLabel}
                  </button>
                  <InlineStack gap="200">
                    <Button disabled={selectedIds.length === 0 || committing} onClick={handleCommitSelected} loading={committing}>
                      Commit selected
                    </Button>
                    <Button onClick={handleCommitAll} loading={committing}>Commit all</Button>
                    <Button tone="critical" disabled={selectedIds.length === 0} onClick={handleDelete}>Delete</Button>
                    <Button disabled={selectedIds.length === 0} onClick={handleArchive}>Archive</Button>
                  </InlineStack>
                </InlineStack>

                {loading ? <Spinner /> : (
                  <div style={{ overflowX: 'hidden', width: '100%' }}>
                    <DataTable
                      columnContentTypes={['text','text','text','text','text','text','numeric','numeric','text']}
                      headings={[
                        <Checkbox
                          checked={selectedIds.length === reports.length && reports.length > 0}
                          indeterminate={selectedIds.length > 0 && selectedIds.length < reports.length}
                          onChange={toggleSelectAll}
                        />,
                        'Type', 'Location', 'Date', 'Name', 'SKU', 'System', 'Actual', '',
                      ]}
                      rows={rows}
                    />
                  </div>
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