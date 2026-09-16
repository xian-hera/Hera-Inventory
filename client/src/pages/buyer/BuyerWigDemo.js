import React, { useState, useEffect, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Checkbox, Banner, Spinner, Button, Modal
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';

const LOCATIONS = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'EDM01','EDM02','CAL01','OTT01','OTT02','OTT03','QC01','HQ'
];

// Import — one-time bulk migration tool (Hera, 2026-09-15: bring in the wig
// demo list currently tracked elsewhere), removed 2026-09-16 after that
// migration was done, then restored the same day per Hera's request ("一切
// 照原样"). At restore time the removal itself had never been committed, but
// Hera opted to have this rebuilt from claude/DEMO_WIG_FEATURE_SPEC.md §13
// (the original design notes) rather than pulled byte-for-byte from git
// history — so the *behavior* matches what was there before, but comments/
// exact wording may not be identical to the original.
//
// Recognized CSV header names (case-insensitive, trimmed) → the field they
// map to, same alias-matching approach as BuyerPOImportInvoice.js's CSV
// upload (CSV_HEADER_ALIASES there).
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

  // Import (restored 2026-09-16, see the module-level comment above).
  const importInputRef = useRef(null);
  const [csvFileName, setCsvFileName] = useState('');
  const [csvRows, setCsvRows] = useState([]);       // [{ sku, location }, ...], already validated per-row
  const [csvNotices, setCsvNotices] = useState([]); // parse-time skip notices (missing SKU/Location cell)
  const [showImportModal, setShowImportModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null); // { imported, skipped } from the server, once run

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

  // CSV parsing (item-level rules per Hera, 2026-09-15): identify a SKU (or
  // Barcode) column and a Location (or Location code) column, case-
  // insensitive. Every row must have both — a row missing either is skipped
  // with a notice rather than rejecting the whole file. If neither column
  // can be identified at all, reject outright with an error banner instead
  // of opening the confirm modal.
  const handleImportFileSelected = (e) => {
    const file = e.target.files[0];
    if (e.target) e.target.value = ''; // allow re-selecting the same file after a previous import
    if (!file) return;
    setError('');
    Papa.parse(file, {
      skipEmptyLines: true,
      complete: (result) => {
        const allRows = result.data;
        setCsvFileName(file.name);
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

        const skuIdx = fieldToIndex.sku;
        const locationIdx = fieldToIndex.location;
        if (skuIdx === undefined || locationIdx === undefined) {
          setError('CSV must have a SKU (or Barcode) column and a Location (or Location code) column.');
          return;
        }

        const notices = [];
        const rows = [];
        dataRows.forEach((row, i) => {
          const sku = (row[skuIdx] || '').toString().trim();
          const location = (row[locationIdx] || '').toString().trim();
          if (!sku || !location) {
            notices.push(`Row ${i + 2}: skipped — missing SKU or Location.`);
            return;
          }
          rows.push({ sku, location });
        });

        setCsvRows(rows);
        setCsvNotices(notices);
        setImportResult(null);
        setShowImportModal(true);
      },
    });
  };

  // Actually runs the import (POST /api/wig-demo/import) — duplicate
  // (location, SKU) detection, the "already the current demo" / "not found /
  // not Active / not WIG / no stock" skip rules, and the real Shopify calls
  // all happen server-side (see server/routes/wigDemo.js). This just sends
  // the parsed rows and shows the per-row result.
  const handleConfirmImport = async () => {
    setImporting(true);
    setError('');
    try {
      const res = await fetch('/api/wig-demo/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: csvRows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setImportResult(data);
      fetchItems(); // pick up newly-imported demos without a manual refresh
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  };

  const closeImportModal = () => {
    setShowImportModal(false);
    setCsvRows([]);
    setCsvNotices([]);
    setCsvFileName('');
    setImportResult(null);
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
                <Button onClick={() => importInputRef.current?.click()}>Import</Button>
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
                      {/* Column order per Hera (2026-09-15): SKU, Name, Color,
                          Wig number, Demo date — Wig number (custom.wig_number
                          product metafield, see attachWigNumbers() in
                          wigDemo.js) sits between Color and Demo date. */}
                      <div style={{
                        display: 'grid', gridTemplateColumns: '32px 100px 1fr 90px 70px 90px',
                        gap: '8px', padding: '8px 0', borderBottom: '2px solid #e1e3e5',
                        fontSize: '12px', fontWeight: '600', color: '#6d7175',
                      }}>
                        <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={toggleAllInCard} />
                        <span>SKU</span>
                        <span>Name</span>
                        <span>Color</span>
                        <span>Wig number</span>
                        <span>Demo date</span>
                      </div>
                      {rows.map(item => (
                        <div key={item.id} style={{
                          display: 'grid', gridTemplateColumns: '32px 100px 1fr 90px 70px 90px',
                          gap: '8px', padding: '10px 0', borderBottom: '1px solid #f1f1f1',
                          alignItems: 'center',
                        }}>
                          <Checkbox checked={selectedIds.includes(item.id)} onChange={() => toggleSelectOne(item.id)} />
                          <div style={{ fontSize: '13px', wordBreak: 'break-word' }}>{item.barcode}</div>
                          <div style={{ fontSize: '14px', fontWeight: '500', wordBreak: 'break-word' }}>{item.name || '-'}</div>
                          <div style={{ fontSize: '13px' }}>{item.variant_name || '-'}</div>
                          <div style={{ fontSize: '13px', wordBreak: 'break-word' }}>{item.wig_number || '-'}</div>
                          <div style={{ fontSize: '13px' }}>{formatDemoDate(item.created_at)}</div>
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
          title={importResult ? 'Import result' : 'Import Wig Demos'}
          primaryAction={
            importResult
              ? { content: 'Done', onAction: closeImportModal }
              : {
                  content: `Import ${csvRows.length} row(s)`,
                  onAction: handleConfirmImport,
                  loading: importing,
                  disabled: csvRows.length === 0 || importing,
                }
          }
          secondaryActions={importResult ? [] : [{ content: 'Cancel', onAction: closeImportModal }]}
        >
          <Modal.Section>
            {importResult ? (
              <BlockStack gap="300">
                <Text variant="bodyMd" fontWeight="semibold">
                  Imported {importResult.imported.length} of {importResult.imported.length + importResult.skipped.length}
                </Text>
                {importResult.skipped.length > 0 && (
                  <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                    <BlockStack gap="150">
                      {importResult.skipped.map((s, i) => (
                        <Text key={i} tone="subdued" variant="bodySm">
                          {s.sku} / {s.location}: {s.reason}
                        </Text>
                      ))}
                    </BlockStack>
                  </div>
                )}
              </BlockStack>
            ) : (
              <BlockStack gap="300">
                <Text variant="bodySm" tone="subdued">{csvFileName}</Text>
                <Text variant="bodyMd">Ready to import {csvRows.length} row(s).</Text>
                {csvNotices.length > 0 && (
                  <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                    <BlockStack gap="100">
                      {csvNotices.map((n, i) => (
                        <Text key={i} tone="subdued" variant="bodySm">{n}</Text>
                      ))}
                    </BlockStack>
                  </div>
                )}
              </BlockStack>
            )}
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}

export default BuyerWigDemo;
