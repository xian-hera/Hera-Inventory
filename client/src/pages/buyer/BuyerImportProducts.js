// Buyer → Import Products (2026-09-24, Hera).
// Spec: claude/IMPORT_PRODUCTS_FEATURE_SPEC.md (§3 Start, §4 Presets, §6 table,
// §7 import rules, §8 results). Model logic lives in ./importProducts/.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import {
  Page, Card, BlockStack, InlineStack, Text, Button, ButtonGroup, Select, Banner, Tooltip, ProgressBar, Spinner,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { useLocationMap } from '../shared/locationMap';
import ImportTable from './importProducts/ImportTable';
import FullBleed from '../../components/FullBleed';
import {
  MAX_ROWS, MAX_COLUMNS, PRESETS, buildColumns, buildRows, groupRows, validate,
  productLevelConflicts, buildPayload, cellValue, colFor,
} from './importProducts/importModel';

const NARROW = { maxWidth: '62.375rem', margin: '0 auto', width: '100%' };
const STORE_ADMIN = 'https://admin.shopify.com/store/beaute-hera/products/';

const numericId = (gid) => { const m = String(gid || '').match(/(\d+)$/); return m ? m[1] : ''; };
const pad = (n) => String(n).padStart(2, '0');

function presetOptions(p) {
  const opts = p.options.map(o => ({ label: o, value: o }));
  if (p.key === 'posOnly' || p.key === 'discontinued' || p.key === 'chargeTax') opts.push({ label: 'Read from CSV', value: 'csv' });
  return opts;
}

function ResultIcon({ result }) {
  const map = { failed: ['#d72c0d', '✕'], partial: ['#e8a33d', '✓'], success: ['#008060', '✓'] };
  const [bg, ch] = map[result] || map.failed;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26,
      borderRadius: '50%', background: bg, color: '#fff', fontWeight: 700, fontSize: 14,
    }}>{ch}</span>
  );
}

function BuyerImportProducts() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const { names: locationNames } = useLocationMap();

  // ── Start ──
  const [types, setTypes] = useState([]);
  const [productType, setProductType] = useState('');
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState(null); // { headers, data }
  const [mode, setMode] = useState('add');
  const [stage, setStage] = useState('start'); // start → presets → table → importing → results
  const [startError, setStartError] = useState('');
  const [loadingStart, setLoadingStart] = useState(false);

  // ── Loaded on Start confirm ──
  const [columns, setColumns] = useState([]);
  const [ignoredHeaders, setIgnoredHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [pools, setPools] = useState({ categories: [], subTypes: [], subCollections: [], displaySections: [] });

  // ── Presets ──
  const [presets, setPresets] = useState(Object.fromEntries(PRESETS.map(p => [p.key, p.defaultValue])));
  const [locations, setLocations] = useState([]);
  const [defaultLocations, setDefaultLocations] = useState(null);

  // ── Table ──
  const [presetsOn, setPresetsOn] = useState(true);
  const [metafieldsOn, setMetafieldsOn] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [precheck, setPrecheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const newRowCounter = useRef(0);

  // ── Import / results ──
  const [job, setJob] = useState(null);
  const [importError, setImportError] = useState('');
  const [localResults, setLocalResults] = useState([]);

  useEffect(() => {
    fetch('/api/shopify/product-types').then(r => r.json()).then(d => setTypes(Array.isArray(d) ? d : [])).catch(() => setTypes([]));
    fetch('/api/import-products/settings').then(r => r.json())
      .then(d => setDefaultLocations(Array.isArray(d.defaultLocations) ? d.defaultLocations : []))
      .catch(() => setDefaultLocations([]));
  }, []);

  // Default Locations = Settings default, limited to locations still active.
  useEffect(() => {
    if (defaultLocations === null || !locationNames.length) return;
    setLocations(prev => (prev.length ? prev : defaultLocations.filter(n => locationNames.includes(n))));
  }, [defaultLocations, locationNames]);

  // Don't leave while importing (spec §7.1).
  useEffect(() => {
    if (stage !== 'importing') return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [stage]);

  // ── Start card ────────────────────────────────────────────────────────────
  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setStartError('');
    Papa.parse(f, {
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const all = res.data || [];
        if (!all.length) { setStartError('The CSV is empty.'); return; }
        setCsv({ headers: all[0], data: all.slice(1) });
        setFileName(f.name);
      },
      error: (err) => setStartError(`Could not read the CSV: ${err.message}`),
    });
  };

  const confirmStart = async () => {
    setStartError('');
    if (!productType) { setStartError('Select a Type.'); return; }
    if (!csv) { setStartError('Upload a CSV.'); return; }
    if (csv.data.length > MAX_ROWS) { setStartError(`Too many rows (${csv.data.length}). The limit is ${MAX_ROWS}.`); return; }
    if (csv.headers.length > MAX_COLUMNS) { setStartError(`Too many columns (${csv.headers.length}). The limit is ${MAX_COLUMNS}.`); return; }
    setLoadingStart(true);
    try {
      const [defsRes, optRes] = await Promise.all([
        fetch('/api/import-products/metafield-definitions'),
        fetch(`/api/import-products/options?type=${encodeURIComponent(productType)}`),
      ]);
      const defs = await defsRes.json();
      const opts = await optRes.json();
      if (!defsRes.ok) throw new Error(defs.error || 'Could not load metafield definitions');
      if (!optRes.ok) throw new Error(opts.error || 'Could not load options');
      const built = buildColumns(csv.headers, defs);
      setColumns(built.columns);
      setIgnoredHeaders(built.ignoredHeaders);
      const r = buildRows(csv.data, built.columns);
      if (!r.length) throw new Error('No data rows found in the CSV.');
      setRows(r);
      setPools(opts);
      setStage('presets');
    } catch (e) {
      setStartError(e.message);
    } finally {
      setLoadingStart(false);
    }
  };

  // ── Grouping / validation (derived) ───────────────────────────────────────
  const groups = useMemo(() => groupRows(rows, columns, mode, precheck && precheck.rows), [rows, columns, mode, precheck]);
  const validation = useMemo(
    () => validate({ rows, columns, groups, mode, presets, pools, precheck }),
    [rows, columns, groups, mode, presets, pools, precheck]
  );
  const conflicts = useMemo(() => (mode === 'add' ? productLevelConflicts(groups, columns) : {}), [groups, columns, mode]);
  const blockingCount = Object.keys(validation.cellErrors).length + Object.keys(validation.rowErrors).length;

  // ── Precheck (Shopify duplicates / matches) ───────────────────────────────
  const runPrecheck = useCallback(async (curRows, curColumns) => {
    setChecking(true);
    setCheckError('');
    try {
      const handleCol = colFor(curColumns, 'handle');
      const skuCol = colFor(curColumns, 'sku');
      const bcCol = colFor(curColumns, 'barcode');
      const g = groupRows(curRows, curColumns, mode, null);
      const payloadRows = [];
      for (const grp of g) {
        grp.rows.forEach((r, i) => {
          const manual = handleCol ? String(cellValue(r, handleCol)).trim() : '';
          payloadRows.push({
            rowNumber: r.rowNumber,
            groupKey: grp.key,
            handle: mode === 'add' ? (i === 0 ? (manual || grp.handle || '') : '') : manual,
            handleIsAuto: mode === 'add' && i === 0 && !manual,
            sku: skuCol ? String(cellValue(r, skuCol)).trim() : '',
            barcode: bcCol ? String(cellValue(r, bcCol)).trim() : '',
          });
        });
      }
      const res = await fetch('/api/import-products/precheck', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, rows: payloadRows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Check failed');
      setPrecheck(data);
    } catch (e) {
      setCheckError(e.message);
    } finally {
      setChecking(false);
    }
  }, [mode]);

  const confirmPresets = () => {
    setStage('table');
    runPrecheck(rows, columns);
  };

  // Re-check after an identifier changes (debounced).
  const recheckTimer = useRef(null);
  const scheduleRecheck = (nextRows) => {
    if (recheckTimer.current) clearTimeout(recheckTimer.current);
    recheckTimer.current = setTimeout(() => runPrecheck(nextRows, columns), 800);
  };

  const onEdit = (rowId, colId, value) => {
    const col = columns.find(c => c.id === colId);
    const next = rows.map(r => {
      if (r.id !== rowId) return r;
      const edits = { ...r.edits };
      const orig = r.values[colId] == null ? '' : String(r.values[colId]);
      // Picking the CSV value again removes the edit — except an explicit blank
      // on a preset column, which must stay so the preset doesn't refill it.
      if (String(value) === orig && !(orig === '' && col && col.preset)) delete edits[colId]; else edits[colId] = value;
      return { ...r, edits };
    });
    setRows(next);
    // Identifiers (and Title, which drives grouping/auto handles) → re-check.
    if (col && col.kind === 'field' && ['handle', 'sku', 'barcode', 'title'].includes(col.field)) {
      scheduleRecheck(next);
    }
  };

  const addLine = () => {
    newRowCounter.current += 1;
    const maxRow = rows.reduce((m, r) => Math.max(m, r.rowNumber), 1);
    setRows(prev => [...prev, { id: `n${newRowCounter.current}`, rowNumber: maxRow + 1, values: {}, edits: {}, isNew: true }]);
  };

  const deleteSelected = () => {
    if (!selectedIds.length) return;
    const next = rows.filter(r => !selectedIds.includes(r.id));
    setRows(next);
    setSelectedIds([]);
    scheduleRecheck(next);
  };

  // ── Import ────────────────────────────────────────────────────────────────
  const startImport = async () => {
    setImportError('');
    const local = [];
    let products = buildPayload({ groups, columns, mode, presets, precheck, skip: validation.skip });
    if (mode === 'add') {
      for (const g of groups) {
        if (validation.skip[g.key]) {
          const titleCol = colFor(columns, 'title');
          local.push({
            key: g.key, title: titleCol ? String(cellValue(g.rows[0], titleCol)) : '', productId: null,
            result: 'failed', report: validation.skip[g.key], rowNumbers: g.rows.map(r => r.rowNumber),
          });
        }
      }
    } else {
      // Rows that matched nothing never leave the browser.
      const unmatched = products.filter(p => !p.productId);
      for (const p of unmatched) {
        local.push({ key: p.key, title: '', productId: null, result: 'failed', report: validation.skip[p.key] || ['Not matched'], rowNumbers: p.variants.map(v => v.rowNumber) });
      }
      products = products.filter(p => p.productId);
    }
    setLocalResults(local);
    if (!products.length) { setJob({ status: 'done', results: [], total: 0, done: 0 }); setStage('results'); return; }
    try {
      const res = await fetch('/api/import-products/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, productType, locations, products }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed to start');
      setJob({ id: data.jobId, status: 'running', total: products.length, done: 0, results: [] });
      setStage('importing');
    } catch (e) {
      setImportError(e.message);
    }
  };

  // Poll the job.
  useEffect(() => {
    if (stage !== 'importing' || !job || !job.id) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/import-products/import/${job.id}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Lost track of the import');
        if (stop) return;
        setJob(data);
        if (data.status !== 'running') { setStage('results'); return; }
      } catch (e) {
        if (stop) return;
        setJob(j => ({ ...(j || {}), status: 'failed', fatal: e.message }));
        setStage('results');
        return;
      }
      if (!stop) setTimeout(tick, 1500);
    };
    const t = setTimeout(tick, 1000);
    return () => { stop = true; clearTimeout(t); };
  }, [stage, job && job.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const allResults = useMemo(() => {
    const order = { failed: 0, partial: 1, success: 2 };
    return [...localResults, ...((job && job.results) || [])].sort((a, b) => order[a.result] - order[b.result]);
  }, [localResults, job]);

  const downloadReport = () => {
    const csvCols = columns.filter(c => c.csvIndex != null).sort((a, b) => a.csvIndex - b.csvIndex);
    const fields = [...csvCols.map(c => c.header), 'Result', 'Report'];
    const byNumber = new Map(rows.map(r => [r.rowNumber, r]));
    const data = [];
    for (const res of allResults) {
      if (res.result === 'success') continue;
      for (const n of res.rowNumbers || []) {
        const r = byNumber.get(n);
        if (!r) continue;
        data.push([...csvCols.map(c => cellValue(r, c)), res.result, (res.report || []).join(' | ')]);
      }
    }
    const text = Papa.unparse({ fields, data });
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const d = new Date();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `import report ${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const locked = stage !== 'start';
  const presetsLocked = stage !== 'presets';
  const unmatchedCols = columns.filter(c => c.kind === 'unmatched');
  const counts = allResults.reduce((m, r) => { m[r.result] = (m[r.result] || 0) + 1; return m; }, {});

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    // Fixed-width page like Buyer Home; only the pre-import table breaks out
    // to full width (FullBleed) — Hera 2026-09-24.
    <Page
      title="Import Products"
      backAction={stage === 'importing' ? undefined : { onAction: () => navigate('/buyer') }}
      secondaryActions={stage === 'importing' ? [] : [{ content: 'Settings', onAction: () => navigate('/buyer/import-products/settings') }]}
    >
      <BlockStack gap="400">
        <div style={NARROW}>
          <BlockStack gap="400">
            {/* Start */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Start</Text>
                {startError && <Banner tone="critical" onDismiss={() => setStartError('')}>{startError}</Banner>}
                <InlineStack gap="400" blockAlign="end" wrap>
                  <div style={{ minWidth: 220 }}>
                    <Select
                      label="Type"
                      options={[{ label: 'Select type', value: '' }, ...types.map(t => ({ label: t, value: t }))]}
                      value={productType}
                      onChange={setProductType}
                      disabled={locked}
                    />
                  </div>
                  <InlineStack gap="200" blockAlign="center">
                    <Button onClick={() => fileRef.current && fileRef.current.click()} disabled={locked}>Upload CSV</Button>
                    <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={onFile} />
                    {fileName && <Text tone="subdued">{fileName} added</Text>}
                  </InlineStack>
                  <ButtonGroup variant="segmented">
                    <Button pressed={mode === 'add'} onClick={() => setMode('add')} disabled={locked}>Add new</Button>
                    <Button pressed={mode === 'update'} onClick={() => setMode('update')} disabled={locked}>Update existing</Button>
                  </ButtonGroup>
                  <div style={{ marginLeft: 'auto' }}>
                    <Button variant="primary" onClick={confirmStart} loading={loadingStart} disabled={locked}>Confirm</Button>
                  </div>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Presets */}
            {stage !== 'start' && (
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingMd" as="h2">Presets</Text>
                  <InlineStack gap="400" blockAlign="end" wrap>
                    {PRESETS.map(p => (p.key === 'channel' ? (
                      <div key={p.key} style={{ minWidth: 170 }}>
                        <Select label="Channel" options={[{ label: 'Point of Sale', value: 'Point of Sale' }]} value="Point of Sale" onChange={() => {}} disabled
                          helpText="Other channels can't be chosen here." />
                      </div>
                    ) : (
                      <div key={p.key} style={{ minWidth: 150 }}>
                        <Select
                          label={p.label}
                          options={presetOptions(p)}
                          value={presets[p.key]}
                          onChange={(v) => setPresets(s => ({ ...s, [p.key]: v }))}
                          disabled={presetsLocked}
                        />
                      </div>
                    )))}
                    <div style={{ minWidth: 200, opacity: presetsLocked ? 0.6 : 1, pointerEvents: presetsLocked ? 'none' : 'auto' }}>
                      <MultiSelectDropdown
                        label="Locations"
                        options={locationNames}
                        selected={locations}
                        onChange={setLocations}
                        placeholder="None"
                        showSelectAll
                      />
                    </div>
                  </InlineStack>
                  <InlineStack align="space-between" blockAlign="end">
                    <BlockStack gap="050">
                      <Text variant="bodySm" tone="subdued">Values populated by presets will show in green.</Text>
                      <Text variant="bodySm" tone="subdued">If a preset differs from a value in the CSV, the CSV value is used.</Text>
                    </BlockStack>
                    <Button variant="primary" onClick={confirmPresets} disabled={presetsLocked}>Confirm</Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {/* Button bar + banners */}
            {stage === 'table' && (
              <BlockStack gap="300">
                {ignoredHeaders.length > 0 && (
                  <Banner tone="info">Not imported (images, online-store publishing, market prices, etc.): {ignoredHeaders.join(', ')}</Banner>
                )}
                {unmatchedCols.length > 0 && (
                  <Banner tone="warning">Column {unmatchedCols.map(c => `"${c.header}"`).join(', ')} not matched — will be ignored.</Banner>
                )}
                {checking && <Banner tone="info"><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><span>Checking against Shopify…</span></InlineStack></Banner>}
                {checkError && <Banner tone="critical">Check against Shopify failed: {checkError}</Banner>}
                {blockingCount > 0 && <Banner tone="critical">{blockingCount} row(s) have values that must be fixed before importing (red cells).</Banner>}
                {importError && <Banner tone="critical" onDismiss={() => setImportError('')}>{importError}</Banner>}
                <InlineStack gap="200" align="end">
                  <Button onClick={addLine}>Add line</Button>
                  <Button tone="critical" variant="primary" onClick={deleteSelected} disabled={!selectedIds.length}>Delete selected</Button>
                  <Tooltip content="Display or hide grouped presets columns.">
                    <Button variant={presetsOn ? 'primary' : undefined} tone={presetsOn ? 'success' : undefined} onClick={() => setPresetsOn(v => !v)}>Presets columns</Button>
                  </Tooltip>
                  <Tooltip content="Group all metafield columns.">
                    <Button pressed={metafieldsOn} onClick={() => setMetafieldsOn(v => !v)}>Metafield columns</Button>
                  </Tooltip>
                  <Button variant="primary" onClick={startImport} disabled={checking || !!checkError || blockingCount > 0 || !precheck}>Import</Button>
                </InlineStack>
              </BlockStack>
            )}
          </BlockStack>
        </div>

        {stage === 'table' && (
          <FullBleed>
          <ImportTable
            columns={columns}
            rows={rows}
            groups={groups}
            mode={mode}
            presets={presets}
            pools={pools}
            presetsOn={presetsOn}
            metafieldsOn={metafieldsOn}
            validation={validation}
            conflicts={conflicts}
            precheck={precheck}
            selectedIds={selectedIds}
            onToggleRow={(id) => setSelectedIds(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]))}
            onToggleAll={setSelectedIds}
            onEdit={onEdit}
          />
          </FullBleed>
        )}

        {stage === 'importing' && job && (
          <div style={NARROW}>
            <Card>
              <BlockStack gap="300">
                <Banner tone="warning">Import in progress — please don't leave this page until it finishes.</Banner>
                <Text>Importing {job.done || 0} / {job.total || 0}…</Text>
                <ProgressBar progress={job.total ? Math.round(((job.done || 0) / job.total) * 100) : 0} />
              </BlockStack>
            </Card>
          </div>
        )}

        {stage === 'results' && (
          <div style={NARROW}>
            <BlockStack gap="300">
              {job && job.fatal && <Banner tone="critical">Import stopped after {job.done || 0} of {job.total || 0} products — {job.fatal}. The remaining {(job.total || 0) - (job.done || 0)} were not processed.</Banner>}
              {unmatchedCols.length > 0 && <Banner tone="warning">Column {unmatchedCols.map(c => `"${c.header}"`).join(', ')} not matched</Banner>}
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingSm">
                  {(counts.success || 0)} imported · {(counts.partial || 0)} partial · {(counts.failed || 0)} failed
                </Text>
                <InlineStack gap="200">
                  <Button onClick={downloadReport} disabled={!(counts.partial || counts.failed)}>Download report</Button>
                  <Button onClick={() => window.location.reload()}>New import</Button>
                </InlineStack>
              </InlineStack>
              <Card padding="0">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr>
                      {['Title', 'Report', 'Result'].map((h, i) => (
                        <th key={h} style={{ textAlign: i === 2 ? 'center' : 'left', padding: '12px 16px', borderBottom: '1px solid #e1e3e5', width: i === 2 ? 90 : i === 0 ? '30%' : undefined }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allResults.map((r, i) => (
                      <tr key={`${r.key}-${i}`}>
                        <td style={{ padding: '12px 16px', borderTop: '1px solid #f1f1f1', verticalAlign: 'top' }}>
                          {r.productId
                            ? <a href={`${STORE_ADMIN}${numericId(r.productId)}`} target="_blank" rel="noopener noreferrer">{r.title || '(untitled)'}</a>
                            : <span>{r.title || `Row ${(r.rowNumbers || []).join(', ')}`}</span>}
                        </td>
                        <td style={{ padding: '12px 16px', borderTop: '1px solid #f1f1f1', color: '#6d7175', fontSize: 13 }}>
                          {(r.report || []).map((line, j) => <div key={j}>{line}</div>)}
                        </td>
                        <td style={{ padding: '12px 16px', borderTop: '1px solid #f1f1f1', textAlign: 'center' }}><ResultIcon result={r.result} /></td>
                      </tr>
                    ))}
                    {allResults.length === 0 && <tr><td colSpan={3} style={{ padding: 24, textAlign: 'center', color: '#6d7175' }}>Nothing was imported.</td></tr>}
                  </tbody>
                </table>
              </Card>
            </BlockStack>
          </div>
        )}
      </BlockStack>
    </Page>
  );
}

export default BuyerImportProducts;
