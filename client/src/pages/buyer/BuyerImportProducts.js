// Buyer → Import Products (2026-09-24, Hera).
// Spec: claude/IMPORT_PRODUCTS_FEATURE_SPEC.md (§3 Start, §4 Presets, §6 table,
// §7 import rules, §8 results). Model logic lives in ./importProducts/.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import {
  Page, Card, BlockStack, InlineStack, Text, Button, ButtonGroup, Select, Banner, Tooltip, ProgressBar, Spinner,
  Modal, List,
} from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
import MultiSelectDropdown from '../../components/MultiSelectDropdown';
import { useLocationMap } from '../shared/locationMap';
import ImportTable from './importProducts/ImportTable';
import FullBleed from '../../components/FullBleed';
import {
  MAX_ROWS, MAX_COLUMNS, PRESETS, buildColumns, buildRows, groupRows, validate,
  productLevelConflicts, buildPayload, cellValue, colFor,
  applyTypeRules, normalizeSubCollections, isSubTypeCol, isSubCollectionCol, subCollectionOptions, subCollectionKey, subCollectionItems,
  assignTargets, columnTargetValue,
} from './importProducts/importModel';

// Header Rule (2026-10-06, Hera): how column headers are recognised.
function HeaderRuleModal({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="How Hub reads your column headers">
      <Modal.Section>
        <List type="number">
          <List.Item>
            <b>Shopify fields</b> — use Shopify's product CSV names: Title, Handle, SKU, Barcode, Vendor, Type, Tags, Status,
            Price, Compare-at price, Cost per item, Charge tax, Option1 name, Option1 value…
          </List.Item>
          <List.Item>
            <b>Metafields</b> — use the metafield's name as shown in Shopify (Settings › Custom data), e.g. <i>Package_Qty</i>,{' '}
            <i>Supplier_A_Cost</i>. Case doesn't matter, and spaces, "_" and "-" count as the same: "Package Qty" = "package_qty".
          </List.Item>
          {/* Adding products / variants (Hera 2026-10-07) */}
          <List.Item>
            <b>Handle</b> — new product (a single product, or a new product with variants): leave Handle empty.
            New variants for an existing product: copy that product's Handle from Shopify into the Handle column;
            each row is one new variant. The existing product's own fields are not changed.
          </List.Item>
          <List.Item>
            <b>Options</b> — when adding variants (to an existing product, or a new product with variants), include the
            columns Option1 name and Option1 value. With more than one option, e.g. hair Color and Length, also add
            Option2 name and Option2 value.
          </List.Item>
          <List.Item>
            <b>Option names are case sensitive</b> — "Color" and "color" are different. Use exactly the name the product has in Shopify.
          </List.Item>
          <List.Item>
            <b>Never imported</b> — images, Published, market prices, inventory quantity, Google Shopping.
          </List.Item>
          <List.Item>
            <b>Anything else</b> is listed as <i>not matched</i> and skipped. Use <b>Manually Assign</b> to point it to a field.
          </List.Item>
        </List>
      </Modal.Section>
    </Modal>
  );
}

const NARROW = { maxWidth: '62.375rem', margin: '0 auto', width: '100%' };
const STORE_ADMIN = 'https://admin.shopify.com/store/beaute-hera/products/';

// 2026-09-29 (Hera): buyers don't need to change these presets, so their
// dropdowns are no longer shown in the Presets card (now titled "Inventory
// Active Locations"). Hub fills EMPTY cells with these defaults; a value in
// the CSV always wins. Set SHOW_PRESET_DROPDOWNS to true to bring the
// dropdowns back.
// Update existing used to keep POS only / Discontinued on "Read from CSV";
// since 2026-10-05 (Hera) it uses the same False defaults as Add new.
// Note: an Update therefore sets POS only / Discontinued to False on every
// product whose CSV cell is empty.
const SHOW_PRESET_DROPDOWNS = false;
const HIDDEN_PRESET_DEFAULTS = {
  add: { status: 'Active', channel: 'Point of Sale', posOnly: 'False', discontinued: 'False', chargeTax: 'Yes' },
  update: { status: 'Active', channel: 'Point of Sale', posOnly: 'False', discontinued: 'False', chargeTax: 'Yes' },
};

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
  const [showHeaderRule, setShowHeaderRule] = useState(false);
  // Manually Assign (2026-10-06): definitions kept for re-processing;
  // manualMap = { [csvIndex]: target } applied on Confirm.
  const [definitions, setDefinitions] = useState([]);
  const [manualMap, setManualMap] = useState({});
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignDraft, setAssignDraft] = useState({}); // csvIndex → target value string

  // ── Loaded on Start confirm ──
  const [columns, setColumns] = useState([]);
  const [ignoredHeaders, setIgnoredHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [pools, setPools] = useState({ categories: [], subTypes: [], subCollections: [], subCollectionsBySubType: {}, displaySections: [] });

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
    // Type dropdown = Shopify product types minus the ones hidden in Import
    // Settings → Types (2026-09-30, Hera).
    Promise.all([
      fetch('/api/shopify/product-types').then(r => r.json()).catch(() => []),
      fetch('/api/import-products/settings').then(r => r.json()).catch(() => ({})),
    ]).then(([t, d]) => {
      const hidden = new Set((Array.isArray(d.hiddenTypes) ? d.hiddenTypes : []).map(x => String(x).toLowerCase()));
      setTypes((Array.isArray(t) ? t : []).filter(x => !hidden.has(String(x).toLowerCase())));
      setDefaultLocations(Array.isArray(d.defaultLocations) ? d.defaultLocations : []);
    });
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
      setDefinitions(defs);
      setManualMap({});
      const built = buildColumns(csv.headers, defs);
      // Display section only counts for HAIR & SKIN CARE (2026-09-25).
      const typedColumns = applyTypeRules(built.columns, productType);
      setColumns(typedColumns);
      setIgnoredHeaders(built.ignoredHeaders);
      // Sub collection values in Title Case (2026-09-25).
      const r = normalizeSubCollections(buildRows(csv.data, typedColumns), typedColumns);
      if (!r.length) throw new Error('No data rows found in the CSV.');
      setRows(r);
      setPools(opts);
      if (!SHOW_PRESET_DROPDOWNS) setPresets(HIDDEN_PRESET_DEFAULTS[mode] || HIDDEN_PRESET_DEFAULTS.add);
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
  // One line per blocking problem, e.g. 'Row 17: Price "-0.01" can't be negative'.
  const blockingIssues = useMemo(() => {
    const out = [];
    for (const r of rows) {
      for (const m of validation.rowErrors[r.id] || []) out.push(`Row ${r.rowNumber}: ${m}`);
      for (const m of Object.values(validation.cellErrors[r.id] || {})) out.push(`Row ${r.rowNumber}: ${m}`);
    }
    return out;
  }, [rows, validation]);

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
      // Changing the Sub type clears a Sub collection that doesn't belong to
      // the new Sub type (Hera 2026-09-25).
      if (col && isSubTypeCol(col)) {
        const scCol = columns.find(isSubCollectionCol);
        if (scCol) {
          const tmp = { ...r, edits };
          const current = String(cellValue(tmp, scCol)).trim();
          const opts = subCollectionOptions(tmp, columns, pools, true, presets) || [];
          // Cleared when any of its items doesn't belong to the new Sub type.
          const items = subCollectionItems(current);
          if (items.length && !items.every(it => opts.some(o => subCollectionKey(o) === subCollectionKey(it)))) {
            const scOrig = r.values[scCol.id] == null ? '' : String(r.values[scCol.id]);
            if (scOrig === '') delete edits[scCol.id]; else edits[scCol.id] = '';
          }
        }
      }
      return { ...r, edits };
    });
    setRows(next);
    // Identifiers (and Title, which drives grouping/auto handles) → re-check.
    if (col && col.kind === 'field' && ['handle', 'sku', 'barcode', 'title'].includes(col.field)) {
      scheduleRecheck(next);
    }
  };

  // Manually Assign → Confirm: re-process the CSV with the hand-picked
  // targets. Rows the buyer deleted stay deleted, added lines stay, and
  // edits are kept (columns keep the same id — it comes from the CSV
  // position). Identifiers may have changed, so Shopify is checked again.
  const openManualAssign = () => {
    const draft = {};
    for (const [idx, t] of Object.entries(manualMap)) {
      draft[idx] = t.kind === 'field' ? `field:${t.field}` : `mf:${t.level}.${t.namespace}.${t.key}`;
    }
    setAssignDraft(draft);
    setAssignOpen(true);
  };

  const applyManualAssign = () => {
    const targets = assignTargets(definitions);
    const byValue = new Map(targets.map(t => [t.value, t.target]));
    const nextMap = { ...manualMap };
    for (const [idx, v] of Object.entries(assignDraft)) {
      if (v && byValue.has(v)) nextMap[idx] = byValue.get(v); else delete nextMap[idx];
    }
    const built = buildColumns(csv.headers, definitions, nextMap);
    const typed = applyTypeRules(built.columns, productType);
    const fresh = normalizeSubCollections(buildRows(csv.data, typed), typed);
    const current = new Map(rows.map(r => [r.id, r]));
    const next = fresh
      .filter(r => current.has(r.id))
      .map(r => ({ ...r, edits: current.get(r.id).edits }));
    for (const r of rows) if (r.isNew) next.push(r);
    setManualMap(nextMap);
    setColumns(typed);
    setIgnoredHeaders(built.ignoredHeaders);
    setRows(next);
    setAssignOpen(false);
    setAssignDraft({});
    runPrecheck(next, typed);
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
            key: g.key,
            // Existing product (Handle filled, 2026-10-07): show its own title.
            title: (precheck && precheck.existing && precheck.existing[g.key] && precheck.existing[g.key].title)
              || (titleCol ? String(cellValue(g.rows[0], titleCol)) : ''),
            productId: null,
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
  // typeSkipped = Display section on a Type other than HAIR & SKIN CARE:
  // reported separately from "not matched" (2026-09-25).
  const unmatchedCols = columns.filter(c => c.kind === 'unmatched' && !c.typeSkipped);
  const typeSkippedCols = columns.filter(c => c.typeSkipped);
  // Handle notes (auto handle already used, 2026-10-07) are counted apart
  // from the Sub collection notes.
  const handleColId = (colFor(columns, 'handle') || {}).id;
  const handleWarningCount = Object.values(validation.cellWarnings || {}).reduce((n, m) => n + (handleColId && m[handleColId] ? 1 : 0), 0);
  const warningCount = Object.values(validation.cellWarnings || {}).reduce((n, m) => n + Object.keys(m).length, 0) - handleWarningCount;
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
      <HeaderRuleModal open={showHeaderRule} onClose={() => setShowHeaderRule(false)} />
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
                    {/* Header Rule (2026-10-06, Hera) */}
                    <Button variant="plain" onClick={() => setShowHeaderRule(true)}>Header Rule</Button>
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
                  {/* Still called the Presets card internally (Hera 2026-09-29). */}
                  <Text variant="headingMd" as="h2">Inventory Active Locations</Text>
                  <InlineStack gap="400" blockAlign="end" wrap>
                    {SHOW_PRESET_DROPDOWNS && PRESETS.map(p => (p.key === 'channel' ? (
                      <div key={p.key} style={{ minWidth: 170 }}>
                        <Select label="Channel" options={[{ label: 'Point of Sale', value: 'Point of Sale' }]} value="Point of Sale" onChange={() => {}} disabled />
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
                        // Shown the other way round (Hera 2026-09-24): name the
                        // locations that are NOT selected.
                        formatDisplay={(sel, all) => {
                          if (!sel.length) return 'None';
                          const excluded = all.filter(v => !sel.includes(v));
                          return excluded.length ? `Excluding ${excluded.join(', ')}` : 'All locations';
                        }}
                      />
                    </div>
                  </InlineStack>
                  <InlineStack align="space-between" blockAlign="end">
                    <BlockStack gap="050">
                      {SHOW_PRESET_DROPDOWNS ? (
                        <>
                          <Text variant="bodySm" tone="subdued">Values populated by presets will show in green.</Text>
                          <Text variant="bodySm" tone="subdued">If a preset differs from a value in the CSV, the CSV value is used.</Text>
                        </>
                      ) : (
                        <>
                          <Text variant="bodySm" tone="subdued">
                            {mode === 'add'
                              ? 'Empty cells get default values, shown in green: Status Active, Channel Point of Sale, POS only False, Discontinued False, Charge tax Yes.'
                              : 'Empty cells get default values, shown in green: Status Active, Channel Point of Sale, POS only False, Discontinued False, Charge tax Yes.'}
                          </Text>
                          <Text variant="bodySm" tone="subdued">If the CSV has a value, the CSV value is used.</Text>
                        </>
                      )}
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
                  <Banner tone="warning">
                    <BlockStack gap="200">
                      <span>Column {unmatchedCols.map(c => `"${c.header}"`).join(', ')} not matched — will be ignored.</span>
                      {!assignOpen && (
                        <InlineStack>
                          <Button onClick={openManualAssign}>Manually Assign</Button>
                        </InlineStack>
                      )}
                    </BlockStack>
                  </Banner>
                )}
                {unmatchedCols.length === 0 && Object.keys(manualMap).length > 0 && !assignOpen && (
                  <InlineStack><Button variant="plain" onClick={openManualAssign}>Edit manual assignments</Button></InlineStack>
                )}
                {/* Manually Assign (2026-10-06, Hera): one row per header Hub
                    didn't recognise; leave a row empty to keep ignoring it. */}
                {assignOpen && (() => {
                  const targets = assignTargets(definitions);
                  // Hand-assigned columns stay in the list so a choice can be
                  // changed or undone; their own targets don't count as taken.
                  // Columns Hub added itself (Handle, Sub type, Sub collection)
                  // don't count either: assigning a CSV column replaces them.
                  const taken = new Set(columns.filter(c => c.kind !== 'unmatched' && !c.manual && !c.synthetic).map(columnTargetValue).filter(Boolean));
                  const list = columns.filter(c => c.csvIndex != null && ((c.kind === 'unmatched' && !c.typeSkipped) || c.manual))
                    .sort((a, b) => a.csvIndex - b.csvIndex);
                  return (
                    <Card>
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text variant="headingMd" as="h2">Manually Assign</Text>
                          <Button variant="plain" onClick={() => setAssignOpen(false)}>Cancel</Button>
                        </InlineStack>
                        <Text tone="subdued">Leave a column empty to keep ignoring it.</Text>
                        {list.map(c => {
                          const mine = assignDraft[c.csvIndex] || '';
                          const usedElsewhere = new Set(Object.entries(assignDraft).filter(([k, v]) => v && Number(k) !== c.csvIndex).map(([, v]) => v));
                          const options = [{ label: "Don't import", value: '' },
                            ...targets.filter(t => t.value === mine || (!taken.has(t.value) && !usedElsewhere.has(t.value)))
                              .sort((a, b) => a.label.localeCompare(b.label))
                              .map(t => ({ label: t.label, value: t.value }))];
                          return (
                            <InlineStack key={c.id} gap="300" blockAlign="center" wrap={false}>
                              <div style={{ width: 220, fontWeight: 600, wordBreak: 'break-word' }}>{c.header}</div>
                              <Text tone="subdued">assign to</Text>
                              <div style={{ minWidth: 320 }}>
                                <Select label={`Assign ${c.header}`} labelHidden options={options} value={mine}
                                  onChange={(v) => setAssignDraft(d => ({ ...d, [c.csvIndex]: v }))} />
                              </div>
                            </InlineStack>
                          );
                        })}
                        <InlineStack align="end">
                          <Button variant="primary" onClick={applyManualAssign}>Confirm</Button>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  );
                })()}
                {typeSkippedCols.map(c => (
                  <Banner key={c.id} tone="warning">Column "{c.header}" will be ignored — {c.reason}.</Banner>
                ))}
                {handleWarningCount > 0 && (
                  <Banner tone="warning">{handleWarningCount} new product(s) have a Title whose handle is already used by another product (orange Handle cells). They will be created with a numbered handle. To add variants to the existing product instead, fill in its Handle.</Banner>
                )}
                {warningCount > 0 && (
                  <Banner tone="warning">{warningCount} sub collection value(s) are not listed under their row's sub type in Import Settings (orange cells). They will still be imported.</Banner>
                )}
                {checking && <Banner tone="info"><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><span>Checking against Shopify…</span></InlineStack></Banner>}
                {checkError && <Banner tone="critical">Check against Shopify failed: {checkError}</Banner>}
                {blockingCount > 0 && (
                  <Banner tone="critical">
                    {blockingCount} row(s) have values that must be fixed before importing (red cells).
                    {/* What exactly is wrong, row by row (2026-10-06, Hera). */}
                    {blockingIssues.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        {blockingIssues.slice(0, 15).map((m, i) => <div key={i}>{m}</div>)}
                        {blockingIssues.length > 15 && <div>…and {blockingIssues.length - 15} more (see the Check column).</div>}
                      </div>
                    )}
                  </Banner>
                )}
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
              {typeSkippedCols.map(c => (
                <Banner key={c.id} tone="warning">Column "{c.header}" was not imported — {c.reason}.</Banner>
              ))}
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
                          {(r.notes || []).map((line, j) => <div key={`n${j}`} style={{ color: '#202223' }}>{line}</div>)}
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
