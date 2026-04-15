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
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01','HQ'
];

// All uppercase, matching Shopify admin product types
const TYPE_OPTIONS = [
  'BRAID', 'HAIR', 'HAIR & SKIN CARE',
  'JEWELRY', 'K-BEAUTY', 'MAKEUP', 'TOOLS & ACCESSORIES', 'WIG',
];

const BUILT_IN_REASONS = [
  { key: 'damaged_delivery',  label: 'Damaged',    sub: 'during delivery' },
  { key: 'damaged_employee',  label: 'Damaged',    sub: 'by employee or customer' },
  { key: 'expired',           label: 'Expired',    sub: null },
  { key: 'stolen',            label: 'Stolen',     sub: null },
  { key: 'tester',            label: 'Tester',     sub: null },
  { key: 'other',             label: 'Other',      sub: null },
];

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getFullYear()}.${months[d.getMonth()]}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function getReasonDisplay(reasonKey, reasonDetail, customReasons) {
  const builtin = BUILT_IN_REASONS.find(r => r.key === reasonKey);
  if (builtin) {
    return { label: builtin.label, sub: builtin.key === 'other' ? (reasonDetail || null) : builtin.sub };
  }
  const custom = customReasons.find(r => r.reason_key === reasonKey);
  if (custom) return { label: custom.reason_label, sub: null };
  return { label: reasonKey, sub: null };
}

function ReasonCell({ reasonKey, reasonDetail, photoUrls, customReasons }) {
  const { label, sub } = getReasonDisplay(reasonKey, reasonDetail, customReasons);
  const hasPhotos = photoUrls && photoUrls.length > 0;

  const handleDownload = () => {
    photoUrls.forEach((url, i) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = url.split('/').pop() || `photo_${i + 1}`;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: '700', fontSize: '13px' }}>{label}</span>
        {hasPhotos && (
          <span
            onClick={handleDownload}
            style={{ fontSize: '12px', color: '#005bd3', textDecoration: 'underline', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            {photoUrls.length} photo{photoUrls.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
      {sub && (
        <div
          style={{ fontSize: '12px', color: '#6d7175', maxWidth: '140px', overflowX: 'auto', whiteSpace: 'nowrap', cursor: 'default' }}
          title={sub}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function BuyerStockLosses() {
  const navigate = useNavigate();

  const [entries, setEntries]                   = useState([]);
  const [loading, setLoading]                   = useState(false);
  const [error, setError]                       = useState('');
  const [committing, setCommitting]             = useState(false);

  const [selectedTypes, setSelectedTypes]       = useState([]);
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [selectedStatuses, setSelectedStatuses] = useState(['reviewing', 'committed']);
  const [selectedReason, setSelectedReason]     = useState('ALL');
  const [date, setDate]                         = useState('ALL');

  const [selectedIds, setSelectedIds]           = useState([]);
  const [customReasons, setCustomReasons]       = useState([]);

  useEffect(() => {
    fetch('/api/stock-losses-settings/custom-reasons')
      .then(r => r.json())
      .then(data => setCustomReasons(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (selectedTypes.length > 0)     params.append('types', selectedTypes.join(','));
      if (selectedLocations.length > 0) params.append('location', selectedLocations.join(','));
      if (selectedStatuses.length > 0)  params.append('status', selectedStatuses.join(','));
      if (selectedReason !== 'ALL')     params.append('reason', selectedReason);
      if (date !== 'ALL')               params.append('date', date);

      const res = await fetch(`/api/stock-losses/buyer?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEntries(data);
    } catch (e) {
      setError('Failed to load entries');
    } finally {
      setLoading(false);
    }
  }, [selectedTypes, selectedLocations, selectedStatuses, selectedReason, date]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const handleCommitOne = async (id) => {
    try {
      const res = await fetch(`/api/stock-losses/${id}/commit`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      fetchEntries();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleCommitSelected = async () => {
    if (selectedIds.length === 0) return;
    setCommitting(true);
    try {
      const res = await fetch('/api/stock-losses/commit-many', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.warnings?.length > 0) setError(data.warnings.join('\n'));
      setSelectedIds([]);
      fetchEntries();
    } catch (e) {
      setError(e.message);
    } finally {
      setCommitting(false);
    }
  };

  const handleCommitAll = async () => {
    setCommitting(true);
    try {
      const ids = entries.filter(e => e.status === 'reviewing').map(e => e.id);
      if (ids.length === 0) { setCommitting(false); return; }
      const res = await fetch('/api/stock-losses/commit-many', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.warnings?.length > 0) setError(data.warnings.join('\n'));
      setSelectedIds([]);
      fetchEntries();
    } catch (e) {
      setError(e.message);
    } finally {
      setCommitting(false);
    }
  };

  const handleDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedIds.length} entr${selectedIds.length > 1 ? 'ies' : 'y'}? Photos will also be deleted.`)) return;
    try {
      const res = await fetch('/api/stock-losses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      if (!res.ok) throw new Error('Delete failed');
      setSelectedIds([]);
      fetchEntries();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleArchive = async () => {
    if (selectedIds.length === 0) return;
    try {
      const res = await fetch('/api/stock-losses/archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      if (!res.ok) throw new Error('Archive failed');
      setSelectedIds([]);
      fetchEntries();
    } catch (e) {
      setError(e.message);
    }
  };

  const toggleSelectOne = (id) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll = () =>
    setSelectedIds(selectedIds.length === entries.length ? [] : entries.map(e => e.id));

  const reasonFilterOptions = [
    'ALL',
    ...BUILT_IN_REASONS.map(r => r.key),
    ...customReasons.map(r => r.reason_key),
  ];
  const reasonFilterLabel = (key) => {
    if (key === 'ALL') return 'ALL';
    const b = BUILT_IN_REASONS.find(r => r.key === key);
    if (b) return b.label + (b.sub ? ` (${b.sub})` : '');
    const c = customReasons.find(r => r.reason_key === key);
    return c ? c.reason_label : key;
  };

  const rows = entries.map(entry => {
    const statusBadge = (() => {
      if (entry.status === 'reviewing') return <Badge tone="warning">reviewing</Badge>;
      if (entry.status === 'committed') return <Badge tone="success">committed</Badge>;
      if (entry.status === 'archived')  return <Badge>archived</Badge>;
      return <Badge>{entry.status}</Badge>;
    })();

    const actionCell = entry.status === 'reviewing' ? (
      <Button size="slim" onClick={() => handleCommitOne(entry.id)} loading={committing}>
        Commit
      </Button>
    ) : statusBadge;

    return [
      <Checkbox
        checked={selectedIds.includes(entry.id)}
        onChange={() => toggleSelectOne(entry.id)}
      />,
      entry.product_type || '-',
      entry.location || '-',
      formatDate(entry.submitted_at),
      <div>
        <div style={{ fontSize: '13px', fontWeight: '500', wordBreak: 'break-word' }}>
          {entry.name || '-'}
        </div>
        <div style={{ fontSize: '12px', color: '#6d7175' }}>{entry.barcode || '-'}</div>
      </div>,
      <ReasonCell
        reasonKey={entry.reason}
        reasonDetail={entry.reason_detail}
        photoUrls={entry.photo_urls || []}
        customReasons={customReasons}
      />,
      entry.soh ?? '-',
      <Text fontWeight="bold" tone={entry.adjustment < 0 ? 'critical' : 'success'}>
        {entry.adjustment > 0 ? `+${entry.adjustment}` : entry.adjustment}
      </Text>,
      actionCell,
    ];
  });

  return (
    <Page
      title="Stock Losses"
      backAction={{ onAction: () => navigate('/buyer') }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <Card>
              <InlineStack gap="400" wrap>
                <MultiSelectDropdown
                  label="Types"
                  options={TYPE_OPTIONS}
                  selected={selectedTypes}
                  onChange={setSelectedTypes}
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
                  <Text variant="bodySm" tone="subdued">Reason</Text>
                  <select
                    value={selectedReason}
                    onChange={e => setSelectedReason(e.target.value)}
                    style={{ padding: '6px 10px', border: '1px solid #c9cccf', borderRadius: '6px', fontSize: '14px' }}
                  >
                    {reasonFilterOptions.map(key => (
                      <option key={key} value={key}>{reasonFilterLabel(key)}</option>
                    ))}
                  </select>
                </BlockStack>
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
                <InlineStack align="end" gap="200">
                  <Button disabled={selectedIds.length === 0 || committing} onClick={handleCommitSelected} loading={committing}>
                    Commit selected
                  </Button>
                  <Button onClick={handleCommitAll} loading={committing}>
                    Commit all
                  </Button>
                  <Button tone="critical" disabled={selectedIds.length === 0} onClick={handleDelete}>
                    Delete
                  </Button>
                  <Button disabled={selectedIds.length === 0} onClick={handleArchive}>
                    Archive
                  </Button>
                </InlineStack>

                {loading ? (
                  <InlineStack align="center"><Spinner /></InlineStack>
                ) : entries.length === 0 ? (
                  <Text tone="subdued" alignment="center">No entries found.</Text>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                          <th style={{ padding: '8px', textAlign: 'left', width: '32px' }}>
                            <Checkbox
                              checked={selectedIds.length === entries.length && entries.length > 0}
                              indeterminate={selectedIds.length > 0 && selectedIds.length < entries.length}
                              onChange={toggleSelectAll}
                            />
                          </th>
                          {['Type','Location','Date','Name / SKU','Reason','System','Adjustment',''].map((h, i) => (
                            <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: '600', color: '#6d7175', whiteSpace: 'nowrap' }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, i) => (
                          <tr key={entries[i].id} style={{ borderBottom: '1px solid #f1f1f1' }}>
                            {row.map((cell, j) => (
                              <td key={j} style={{ padding: '10px 10px', verticalAlign: 'top' }}>
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
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

export default BuyerStockLosses;