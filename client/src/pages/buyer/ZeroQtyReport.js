import React, { useState, useEffect, useCallback } from 'react';
import {
  Page, Layout, Card, Button, BlockStack, InlineStack,
  Text, Checkbox, Banner, Badge, Spinner
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
  'HAIR & SKIN CARE': 'Care',
  'Tools & Accessories': 'Tools + Acc.',
  'TOOLS & ACCESSORIES': 'Tools + Acc.',
};

function typeDisplay(type) {
  return TYPE_LABEL_MAP[type] || type;
}

// Always-on location sort (item 3: the old toggleable Sort-by-name button
// was removed — the list is now unconditionally grouped by location).
// LOCATIONS above is already laid out in M/E/C/O/Q/H group order (MTL, EDM,
// CAL, OTT, QC prefixes; this list has no HQ entries today).
const LOCATION_ORDER = new Map(LOCATIONS.map((loc, i) => [loc, i]));

// Row-level divider styling — needs a plain <table> (not Polaris DataTable)
// to render as one continuous line: DataTable lays out each cell
// independently, so a per-cell border comes out broken/segmented rather
// than a single line spanning the row. Same-location rows keep their normal
// thin divider and spacing; a location-group boundary gets a
// darker/thicker divider with 130% of the normal vertical spacing on both
// sides of it (extra padding-top on the row that starts the new group,
// extra padding-bottom on the row that ends the previous one).
const ROW_V_PADDING = 10;
const GROUP_V_PADDING = Math.round(ROW_V_PADDING * 1.3);
const ROW_BORDER = '1px solid #f1f1f1';
// Same 1px weight as ROW_BORDER — only the color darkens to stand out from
// the light same-location divider (per user feedback: darker, not thicker).
const GROUP_BORDER = '1px solid #202223';

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
  const [selectedStatuses, setSelectedStatuses] = useState(['reviewing', 'committed']);
  const [date, setDate]                         = useState('ALL');
  const [selectedIds, setSelectedIds]           = useState([]);
  // 改动五.3：每行的 adjustment 编辑值，key = report.id
  const [adjustments, setAdjustments]           = useState({});

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

  // Always grouped/sorted by location (M/E/C/O/Q/H group order); a stable
  // sort keeps each group's original relative order intact.
  const sortedReports = [...reports].sort((a, b) => {
    const ai = LOCATION_ORDER.has(a.location) ? LOCATION_ORDER.get(a.location) : LOCATIONS.length;
    const bi = LOCATION_ORDER.has(b.location) ? LOCATION_ORDER.get(b.location) : LOCATIONS.length;
    return ai - bi;
  });

  function renderStatusCell(report) {
    // 改动五.1：archived 状态显示 archived
    if (report.status === 'reviewing') return <Badge tone="warning">reviewing</Badge>;
    if (report.status === 'committed') return <Badge tone="success">committed</Badge>;
    if (report.status === 'archived')  return <Badge>archived</Badge>;
    return <Badge>{report.status}</Badge>;
  }

  // 改动五.3：reviewing 状态显示 adjustment 输入框 + commit 按钮
  function renderActionCell(report) {
    if (report.status !== 'reviewing') return renderStatusCell(report);
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
  }

  return (
    <Page title="Manual Inventory Count" backAction={{ onAction: () => navigate('/buyer/inventory-count') }}>
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

            {/* padding="0" on the Card so the table (and its location-boundary
                dividers) can be genuinely flush with the card's left/right
                edges; padding is re-applied manually below to every
                non-table child so they don't visually touch the edges. */}
            <Card padding="0">
              <BlockStack gap="300">
                <div style={{ padding: '16px 16px 0' }}>
                  <InlineStack align="end" gap="200">
                    <Button disabled={selectedIds.length === 0 || committing} onClick={handleCommitSelected} loading={committing}>
                      Commit selected
                    </Button>
                    <Button onClick={handleCommitAll} loading={committing}>Commit all</Button>
                    <Button tone="critical" disabled={selectedIds.length === 0} onClick={handleDelete}>Delete</Button>
                    <Button disabled={selectedIds.length === 0} onClick={handleArchive}>Archive</Button>
                  </InlineStack>
                </div>

                {loading ? (
                  <div style={{ padding: '16px' }}>
                    <InlineStack align="center"><Spinner /></InlineStack>
                  </div>
                ) : sortedReports.length === 0 ? (
                  <div style={{ padding: '16px' }}>
                    <Text tone="subdued" alignment="center">No reports found.</Text>
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto', paddingBottom: '16px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          <th style={{ padding: '8px', textAlign: 'left', width: '32px' }}>
                            <Checkbox
                              checked={selectedIds.length === reports.length && reports.length > 0}
                              indeterminate={selectedIds.length > 0 && selectedIds.length < reports.length}
                              onChange={toggleSelectAll}
                            />
                          </th>
                          {['Type', 'Location', 'Date', 'Name', 'SKU', 'System', 'Actual', ''].map((h, i) => (
                            <th
                              key={i}
                              style={{ padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedReports.map((report, idx) => {
                          const isFirstOfGroup = idx > 0 && report.location !== sortedReports[idx - 1].location;
                          const isLastOfGroup = idx < sortedReports.length - 1 && report.location !== sortedReports[idx + 1].location;
                          const rowBorder = idx === 0 ? 'none' : (isFirstOfGroup ? GROUP_BORDER : ROW_BORDER);
                          const padTop = isFirstOfGroup ? GROUP_V_PADDING : ROW_V_PADDING;
                          const padBottom = isLastOfGroup ? GROUP_V_PADDING : ROW_V_PADDING;
                          const tdStyle = { padding: `${padTop}px 10px ${padBottom}px`, verticalAlign: 'top' };

                          return (
                            <tr key={report.id} style={{ borderTop: rowBorder }}>
                              <td style={tdStyle}>
                                <Checkbox checked={selectedIds.includes(report.id)} onChange={() => toggleSelectOne(report.id)} />
                              </td>
                              {/* 改动一：显示 type 而非 department */}
                              <td style={tdStyle}>{typeDisplay(report.type) || '-'}</td>
                              <td style={tdStyle}>{report.location || '-'}</td>
                              <td style={tdStyle}>{formatDate(report.submitted_at)}</td>
                              <td style={{ ...tdStyle, maxWidth: '200px', wordBreak: 'break-word', whiteSpace: 'normal' }}>{report.name || '-'}</td>
                              <td style={tdStyle}>{report.barcode || '-'}</td>
                              <td style={tdStyle}>{report.soh ?? '-'}</td>
                              <td style={tdStyle}>{report.poh ?? '-'}</td>
                              <td style={tdStyle}>{renderActionCell(report)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
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