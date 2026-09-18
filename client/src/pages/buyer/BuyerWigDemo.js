import React, { useState, useEffect, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Checkbox, Banner, Button, Modal, Tooltip
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

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

  const [items, setItems]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [refreshingWigNumbers, setRefreshingWigNumbers] = useState(false);

  // Which location cards are expanded (2026-09-16, Hera: every location with
  // at least 1 demo now always gets a card — the top Locations filter that
  // used to narrow this down is gone — but each card starts collapsed to a
  // one-line "location + demo count" header, since with every location
  // showing there could be a lot of cards on screen at once). Set of
  // location codes; a location's full list only renders while its code is
  // in this set.
  const [expandedLocations, setExpandedLocations] = useState(new Set());
  const toggleLocationExpanded = (loc) => {
    setExpandedLocations(prev => {
      const next = new Set(prev);
      if (next.has(loc)) next.delete(loc); else next.add(loc);
      return next;
    });
  };

  // Import (restored 2026-09-16, see the module-level comment above).
  const importInputRef = useRef(null);
  const [csvFileName, setCsvFileName] = useState('');
  const [csvRows, setCsvRows] = useState([]);       // [{ sku, location }, ...], already validated per-row
  const [csvNotices, setCsvNotices] = useState([]); // parse-time skip notices (missing SKU/Location cell)
  const [showImportModal, setShowImportModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null); // { imported, skipped } from the server, once run

  // No locations filter anymore (2026-09-16, Hera: with every location that
  // has a demo now showing as its own collapsible card, the top filter isn't
  // needed) — always fetch every location's demos (GET /api/wig-demo/buyer
  // with no `locations` param means "all", per that route's own contract).
  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/wig-demo/buyer');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const toggleSelectOne = (id) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  // Refresh Wig Number (Hera, 2026-09-17): re-queries Shopify live for every
  // demo's wig_number and updates the DB (see POST /refresh-wig-numbers in
  // server/routes/wigDemo.js), across ALL locations — Buyer's own scope is
  // "every location" per Hera (this also doubles as the one-time backfill
  // for the rows that predate the wig_number column being persisted at all).
  // The endpoint returns the refreshed list in the same shape as GET /buyer,
  // so this just replaces items with the response directly.
  const handleRefreshWigNumbers = async () => {
    setRefreshingWigNumbers(true);
    setError('');
    try {
      const res = await fetch('/api/wig-demo/refresh-wig-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to refresh wig numbers');
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to refresh wig numbers');
    } finally {
      setRefreshingWigNumbers(false);
    }
  };

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

            {/* Import (left) and Cancel DEMO (right) — Hera, 2026-09-16:
                Cancel DEMO should be the same Polaris Button style as
                Import, just a different (critical/red) tone, and pushed to
                the far right rather than sitting next to Import. (The
                Locations filter that used to sit above this row is gone —
                see the "no locations filter" comment on fetchItems above —
                so this is now the top row of the page.) */}
            <InlineStack align="space-between" blockAlign="center" wrap gap="200">
              <InlineStack gap="200" blockAlign="center">
                <input
                  type="file"
                  accept=".csv"
                  ref={importInputRef}
                  style={{ display: 'none' }}
                  onChange={handleImportFileSelected}
                />
                <Tooltip content="CSV MUST have header SKU and Location.">
                  <Button onClick={() => importInputRef.current?.click()}>Import</Button>
                </Tooltip>
              </InlineStack>
              {/* Refresh Wig Number (Hera, 2026-09-17): immediately left of
                  Cancel DEMO. */}
              <InlineStack gap="200" blockAlign="center">
                <Button
                  disabled={refreshingWigNumbers}
                  loading={refreshingWigNumbers}
                  onClick={handleRefreshWigNumbers}
                >
                  Refresh Wig Number
                </Button>
                <Button
                  tone="critical"
                  disabled={selectedIds.length === 0 || cancelling}
                  loading={cancelling}
                  onClick={handleCancelDemo}
                >
                  Cancel DEMO
                </Button>
              </InlineStack>
            </InlineStack>

            {loading ? (
              <Text alignment="center" tone="subdued">Loading...</Text>
            ) : locationsWithDemos.length === 0 ? (
              <Card>
                <Text tone="subdued" alignment="center">No current demos.</Text>
              </Card>
            ) : (
              locationsWithDemos.map(loc => {
                const rows = byLocation[loc];
                const isExpanded = expandedLocations.has(loc);
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
                      {/* Card header — always visible, click anywhere on it to
                          expand/collapse (Hera, 2026-09-16). Keeps showing the
                          demo count (rows.length, i.e. how many line items are
                          in the list below) after the location name whether
                          collapsed or expanded, per Hera's spec, so this text
                          isn't inside the `isExpanded &&` block below. The "▸"/
                          "▾" is a plain character rather than a Polaris icon —
                          this codebase has never pulled in @shopify/polaris-
                          icons (see claude/DEMO_WIG_FEATURE_SPEC.md §15.2), so
                          a text glyph avoids adding that dependency for one
                          small affordance. */}
                      <div
                        onClick={() => toggleLocationExpanded(loc)}
                        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
                      >
                        <Text tone="subdued">{isExpanded ? '▾' : '▸'}</Text>
                        <Text variant="headingSm" fontWeight="bold">{loc}</Text>
                        <Text tone="subdued">{rows.length} demo{rows.length === 1 ? '' : 's'}</Text>
                      </div>
                      {isExpanded && (
                        <>
                          {/* Column structure (2026-09-18, Hera — replaces the
                              2026-09-15 order): SKU, Name, Brand, Color, Wig
                              No., Demo date. Two changes from before: (1) SKU
                              and Name are merged into one stacked cell (SKU
                              on top, Name below) instead of two separate grid
                              columns — same stacking style Manager's list
                              already used; (2) a new Brand column (Shopify's
                              product vendor) sits right after that stacked
                              cell. Name itself is no longer raw custom.name —
                              it's the server-computed display_name
                              ("{sub_type 缩写} {custom.wig_name}", see
                              buildDisplayName() in server/routes/wigDemo.js)
                              — so the old Name-shortening logic this page
                              never actually had (that was Manager-only) still
                              isn't needed here either. "Wig number" header
                              relabeled "Wig No." */}
                          {/* Column widths (2026-09-17, Hera: Color and Wig
                              number were getting squeezed enough that long
                              values could visually overlap) — Color and Wig
                              No. keep their wordBreak safety net below, plus
                              the 10px gap between columns from that same
                              round. Widths rebalanced 2026-09-18 to fit the
                              new Brand column into the same overall row. */}
                          <div style={{
                            display: 'grid', gridTemplateColumns: '32px 1fr 90px 105px 75px 90px',
                            gap: '10px', padding: '8px 0', borderBottom: '2px solid #e1e3e5',
                            fontSize: '12px', fontWeight: '600', color: '#6d7175',
                          }}>
                            <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={toggleAllInCard} />
                            <span>SKU / Name</span>
                            <span>Brand</span>
                            <span>Color</span>
                            <span>Wig No.</span>
                            <span>Demo date</span>
                          </div>
                          {rows.map(item => (
                            <div key={item.id} style={{
                              display: 'grid', gridTemplateColumns: '32px 1fr 90px 105px 75px 90px',
                              gap: '10px', padding: '10px 0', borderBottom: '1px solid #f1f1f1',
                              alignItems: 'start',
                            }}>
                              <Checkbox checked={selectedIds.includes(item.id)} onChange={() => toggleSelectOne(item.id)} />
                              <div>
                                <div style={{ fontSize: '13px', wordBreak: 'break-word' }}>{item.barcode}</div>
                                <div style={{ fontSize: '14px', fontWeight: '500', wordBreak: 'break-word', marginTop: '2px' }}>
                                  {item.display_name || '-'}
                                </div>
                              </div>
                              <div style={{ fontSize: '13px', wordBreak: 'break-word' }}>{item.vendor || '-'}</div>
                              <div style={{ fontSize: '13px', wordBreak: 'break-word' }}>{item.variant_name || '-'}</div>
                              <div style={{ fontSize: '13px', wordBreak: 'break-word' }}>{item.wig_number || '-'}</div>
                              <div style={{ fontSize: '13px' }}>{formatDemoDate(item.created_at)}</div>
                            </div>
                          ))}
                        </>
                      )}
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
