import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Checkbox, Banner, Spinner, Button, Modal
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01','HQ'
];

// Recognized Import CSV header names (case-insensitive, trimmed) -> the
// field they map to. Mirrors the header-alias pattern used by PO Receiving's
// CSV import (BuyerPOImportInvoice.js), just with a 2-column set — SKU and
// Location are both required on every row.
const IMPORT_CSV_HEADER_ALIASES = {
  sku: 'sku',
  barcode: 'sku',
  location: 'location',
  'location code': 'location',
};

function formatDemoDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function BuyerWigDemo() {
  const navigate = useNavigate();

  const [selectedLocations, setSelectedLocations] = useState([...LOCATIONS]);
  const [items, setItems]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);

  // Import (bulk, from a CSV of {sku, location} rows — see project doc for
  // why this is a normal-flow server route rather than a local script).
  const importInputRef = useRef(null);
  const [csvFileName, setCsvFileName] = useState('');
  const [csvRows, setCsvRows] = useState([]);
  const [csvNotices, setCsvNotices] = useState([]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (selectedLocations.length > 0 && selectedLocations.length < LOCATIONS.length) {
        params.append('locations', selectedLocations.join(','));
      } else if (selectedLocations.length === 0) {
        setItems([]);
        setLoading(false);
        return;
      }
      const res = await fetch(`/api/wig-demo/buyer?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [selectedLocations]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const toggleSelectOne = (id) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleCancelDemo = async () => {
    if (selectedIds.length === 0) return;
    setCancelling(true);
    setError('');
    try {
      const res = await fetch('/api/wig-demo', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel');
      setItems(prev => prev.filter(i => !(data.deletedIds || []).includes(i.id)));
      setSelectedIds([]);
      if (data.errors?.length > 0) setError(data.errors.join('\n'));
    } catch (e) {
      setError(e.message);
    } finally {
      setCancelling(false);
    }
  };

  // Parses the uploaded CSV into {sku, location} rows and opens the confirm
  // modal — the actual import (Shopify lookups + inventory moves + DB
  // inserts) only happens once the buyer confirms in that modal, in
  // handleConfirmImport below.
  const handleImportFileSelected = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      skipEmptyLines: true,
      complete: (result) => {
        const allRows = result.data;
        if (allRows.length === 0) {
          setError('CSV is empty.');
          return;
        }

        const headerRow = allRows[0];
        const dataRows = allRows.slice(1);
        const normalize = (h) => (h || '').toString().trim().toLowerCase();

        const fieldToIndex = {};
        headerRow.forEach((h, i) => {
          const field = IMPORT_CSV_HEADER_ALIASES[normalize(h)];
          if (field && fieldToIndex[field] === undefined) fieldToIndex[field] = i;
        });

        if (fieldToIndex.sku === undefined || fieldToIndex.location === undefined) {
          setError('CSV must have a "SKU" column and a "Location" column.');
          return;
        }

        const notices = [];
        const parsed = [];
        dataRows.forEach((row, idx) => {
          const rowHasAnyValue = row.some(c => (c || '').toString().trim());
          if (!rowHasAnyValue) return;
          const sku = (row[fieldToIndex.sku] || '').toString().trim();
          const location = (row[fieldToIndex.location] || '').toString().trim().toUpperCase();
          if (!sku || !location) {
            notices.push(`Row ${idx + 2}: missing SKU or Location — skipped.`);
            return;
          }
          parsed.push({ sku, location });
        });

        if (parsed.length === 0) {
          setError('No usable rows found in this CSV — every row is missing a SKU or a Location.');
          return;
        }

        setCsvFileName(file.name);
        setCsvRows(parsed);
        setCsvNotices(notices);
        setImportResult(null);
        setShowImportModal(true);
        setError('');
      },
      error: () => setError('Failed to parse CSV'),
    });
    e.target.value = '';
  };

  const handleConfirmImport = async () => {
    setImporting(true);
    try {
      const res = await fetch('/api/wig-demo/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: csvRows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setImportResult({ imported: data.imported || [], skipped: data.skipped || [] });
      fetchItems();
    } catch (e) {
      setError(e.message);
      setShowImportModal(false);
    } finally {
      setImporting(false);
    }
  };

  const closeImportModal = () => {
    if (importing) return;
    setShowImportModal(false);
    setImportResult(null);
    setCsvRows([]);
    setCsvNotices([]);
  };

  // Group into one card per location — only locations that currently have at
  // least one demo get a card, in LOCATIONS order (not just whatever order
  // rows happen to come back in).
  const byLocation = {};
  items.forEach(item => {
    if (!byLocation[item.location]) byLocation[item.location] = [];
    byLocation[item.location].push(item);
  });
  const locationsWithDemos = LOCATIONS.filter(loc => byLocation[loc]?.length > 0);

  return (
    <Page title="Wig DEMO" backAction={{ onAction: () => navigate('/buyer') }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

            <InlineStack align="space-between" blockAlign="end" wrap gap="300">
              <MultiSelectDropdown
                label="Locations"
                options={LOCATIONS}
                selected={selectedLocations}
                onChange={setSelectedLocations}
                showSelectAll
              />
              <InlineStack gap="200" blockAlign="end">
                <input
                  type="file"
                  accept=".csv"
                  ref={importInputRef}
                  style={{ display: 'none' }}
                  onChange={handleImportFileSelected}
                />
                <Button onClick={() => importInputRef.current.click()}>Import</Button>
                <button
                  disabled={selectedIds.length === 0 || cancelling}
                  onClick={handleCancelDemo}
                  style={{
                    padding: '9px 18px', borderRadius: '20px', border: 'none',
                    background: selectedIds.length === 0 || cancelling ? '#f6f6f7' : '#d72c0d',
                    color: selectedIds.length === 0 || cancelling ? '#8c9196' : 'white',
                    cursor: selectedIds.length === 0 || cancelling ? 'not-allowed' : 'pointer',
                    fontSize: '13px', fontWeight: '700', whiteSpace: 'nowrap',
                  }}
                >
                  {cancelling ? 'Cancelling…' : 'Cancel DEMO'}
                </button>
              </InlineStack>
            </InlineStack>

            {loading ? (
              <InlineStack align="center"><Spinner /></InlineStack>
            ) : locationsWithDemos.length === 0 ? (
              <Card>
                <Text tone="subdued" alignment="center">No current demos for the selected location(s).</Text>
              </Card>
            ) : (
              locationsWithDemos.map(loc => {
                const rows = byLocation[loc];
                const allSelected = rows.every(r => selectedIds.includes(r.id));
                const someSelected = rows.some(r => selectedIds.includes(r.id));
                const toggleAllInCard = () => {
                  const ids = rows.map(r => r.id);
                  setSelectedIds(prev => allSelected
                    ? prev.filter(id => !ids.includes(id))
                    : [...new Set([...prev, ...ids])]);
                };
                return (
                  <Card key={loc}>
                    <BlockStack gap="300">
                      <Text variant="headingSm" fontWeight="bold">{loc}</Text>
                      <div style={{
                        display: 'grid', gridTemplateColumns: '32px 100px 1fr 110px 70px',
                        gap: '8px', padding: '8px 0', borderBottom: '2px solid #e1e3e5',
                        fontSize: '12px', fontWeight: '600', color: '#6d7175',
                      }}>
                        <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={toggleAllInCard} />
                        <span>SKU</span>
                        <span>Name</span>
                        <span>Demo date</span>
                        <span>Color</span>
                      </div>
                      {rows.map(item => (
                        <div key={item.id} style={{
                          display: 'grid', gridTemplateColumns: '32px 100px 1fr 110px 70px',
                          gap: '8px', padding: '10px 0', borderBottom: '1px solid #f1f1f1',
                          alignItems: 'center',
                        }}>
                          <Checkbox checked={selectedIds.includes(item.id)} onChange={() => toggleSelectOne(item.id)} />
                          <div style={{ fontSize: '13px', wordBreak: 'break-word' }}>{item.barcode}</div>
                          <div style={{ fontSize: '14px', fontWeight: '500', wordBreak: 'break-word' }}>{item.name || '-'}</div>
                          <div style={{ fontSize: '13px' }}>{formatDemoDate(item.created_at)}</div>
                          <div style={{ fontSize: '13px' }}>{item.variant_name || '-'}</div>
                        </div>
                      ))}
                    </BlockStack>
                  </Card>
                );
              })
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>

      {showImportModal && (
        <Modal
          open
          onClose={closeImportModal}
          title="Import Wig Demos"
          primaryAction={!importResult ? {
            content: importing ? 'Importing…' : `Import ${csvRows.length} row(s)`,
            onAction: handleConfirmImport,
            loading: importing,
            disabled: importing,
          } : {
            content: 'Done',
            onAction: closeImportModal,
          }}
          secondaryActions={!importResult ? [{
            content: 'Cancel',
            onAction: closeImportModal,
            disabled: importing,
          }] : []}
        >
          <Modal.Section>
            <BlockStack gap="300">
              {!importResult ? (
                <>
                  <Text>
                    {csvFileName ? `${csvFileName} — ` : ''}{csvRows.length} row(s) ready to import.
                    Each row looks up its SKU in Shopify (must be an Active WIG product with available
                    stock at that location), moves 1 unit from Available to Unavailable, and adds it as
                    that location's current demo.
                  </Text>
                  {csvNotices.length > 0 && (
                    <div style={{ fontSize: '13px', color: '#8c9196' }}>
                      {csvNotices.map((n, i) => <div key={i}>{n}</div>)}
                    </div>
                  )}
                </>
              ) : (
                <BlockStack gap="300">
                  <Text fontWeight="bold">
                    Imported {importResult.imported.length} of {csvRows.length}.
                  </Text>
                  {importResult.skipped.length > 0 && (
                    <BlockStack gap="150">
                      <Text fontWeight="bold" tone="critical">
                        Skipped ({importResult.skipped.length}):
                      </Text>
                      <div style={{ maxHeight: '240px', overflowY: 'auto', fontSize: '13px' }}>
                        {importResult.skipped.map((s, i) => (
                          <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid #f1f1f1' }}>
                            <strong>{s.sku}</strong> @ {s.location}: {s.reason}
                          </div>
                        ))}
                      </div>
                    </BlockStack>
                  )}
                </BlockStack>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}

export default BuyerWigDemo;
