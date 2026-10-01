// Online › Swatch › Colour codes — the management list (spec §5.4 / §5.6).
// Data comes from the Hub's own product scan (Admin API, every Active
// product), not from the storefront.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Card, BlockStack, InlineStack, Text, Button, Select, Badge, Modal, TextField, Checkbox,
} from '@shopify/polaris';
import MultiSelectDropdown from '../../../components/MultiSelectDropdown';
import FullBleed from '../../../components/FullBleed';
import { api, ADMIN_PRODUCT, TH, TD, SwatchThumb, fmtTime } from './swatchApi';

const FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Matched', value: 'matched' },
  { label: 'No match', value: 'none' },
  { label: 'Possible match', value: 'possible' },
  { label: 'Ignored', value: 'ignored' },
  { label: 'Suggested Ignore', value: 'suggest' },
];

function StatusBadge({ row }) {
  if (row.ignored) return <Badge>Ignored</Badge>;
  if (row.status === 'matched') return <Badge tone="success">Matched</Badge>;
  if (row.status === 'possible') return <Badge tone="attention">{row.candidate && row.candidate.kind === 'exact' ? 'Exact match — not confirmed' : 'Possible match'}</Badge>;
  return <Badge tone="critical">No match</Badge>;
}

function ProductLinks({ products, onViewAll }) {
  const shown = products.slice(0, 5);
  return (
    <BlockStack gap="050">
      {shown.map(p => (
        <a key={p.id} href={`${ADMIN_PRODUCT}${p.id}`} target="_blank" rel="noreferrer" style={{ color: '#2c6ecb' }}>{p.title}</a>
      ))}
      {products.length > 5 && <div><Button variant="plain" onClick={onViewAll}>View all ({products.length})</Button></div>}
    </BlockStack>
  );
}

// Pick an image of the library for a code.
function ChooseFileModal({ open, row, onClose, onPicked, setBanner }) {
  const [images, setImages] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!open || !row || !row.library) return;
    setImages(null);
    setQ('');
    api.get(`/libraries/${row.library.id}/images`).then(d => setImages(d.images)).catch(e => setBanner({ tone: 'critical', text: e.message }));
  }, [open, row, setBanner]);
  const list = (images || []).filter(i => !q || i.original_name.toUpperCase().includes(q.toUpperCase()));
  return (
    <Modal open={open} onClose={onClose} title={row ? `Choose the image for ${row.code}` : ''} size="large">
      <Modal.Section>
        <BlockStack gap="300">
          <TextField label="Search file name" value={q} onChange={setQ} autoComplete="off" clearButton onClearButtonClick={() => setQ('')} />
          {!images ? <Text tone="subdued">Loading...</Text> : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
              {list.map(i => (
                <button key={i.id} type="button" onClick={() => onPicked(i)}
                  style={{ border: '1px solid #e1e3e5', borderRadius: 8, background: '#fff', padding: 8, cursor: 'pointer', textAlign: 'left' }}>
                  <SwatchThumb url={i.url} position={i.position} width={72} height={81} />
                  <div style={{ fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>{i.original_name}</div>
                  {i.codes.length > 0 && <div style={{ fontSize: 11, color: '#6d7175' }}>{i.codes.join(', ')}</div>}
                </button>
              ))}
              {list.length === 0 && <Text tone="subdued">No images.</Text>}
            </div>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function ScanTypesModal({ open, onClose, meta, onStart }) {
  const [types, setTypes] = useState([]);
  const [optionName, setOptionName] = useState('Color');
  const [caseSensitive, setCaseSensitive] = useState(true);
  return (
    <Modal open={open} onClose={onClose} title="Scan chosen product types"
      primaryAction={{ content: 'Start scan', disabled: !types.length || !optionName.trim(), onAction: () => onStart({ productTypes: types, optionName: optionName.trim(), caseSensitive }) }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}>
      <Modal.Section>
        <BlockStack gap="300">
          <Text tone="subdued">Reads every Active product of these types and lists the values of the option below — useful before adding a rule. The result replaces the last scan.</Text>
          <MultiSelectDropdown label="Product types" options={meta.productTypes} selected={types} onChange={setTypes} placeholder="Choose…" />
          <TextField label="Option name" value={optionName} onChange={setOptionName} autoComplete="off" />
          <Checkbox label="Case sensitive" checked={caseSensitive} onChange={setCaseSensitive} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

const PAGE_SIZE = 100;

function SwatchCodesTab({ meta, refreshMeta, setBanner, config }) {
  const [vendors, setVendors] = useState([]);
  const [vendor, setVendor] = useState('');      // '' = all vendors
  const [type, setType] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [scan, setScan] = useState(null);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState('');
  const [viewAll, setViewAll] = useState(null);
  const [choose, setChoose] = useState(null);
  const [scanTypesOpen, setScanTypesOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [recalc, setRecalc] = useState(false);
  const pollRef = useRef(null);

  const loadVendors = useCallback(() => api.get('/vendors').then(d => setVendors(d.vendors)), []);
  const load = useCallback(async () => {
    const qs = new URLSearchParams({ filter });
    if (vendor) qs.set('vendor', vendor);
    if (type) qs.set('type', type);
    const d = await api.get(`/list?${qs}`);
    setData(d);
    setScan(d.scan);
    setSelected([]);
    setPage(0);
  }, [vendor, type, filter]);

  useEffect(() => { loadVendors().catch(e => setBanner({ tone: 'critical', text: e.message })); }, [loadVendors, setBanner]);
  useEffect(() => { setData(null); load().catch(e => setBanner({ tone: 'critical', text: e.message })); }, [load, setBanner]);

  // Poll while a scan runs, then reload.
  useEffect(() => {
    if (!scan || scan.status !== 'running') return undefined;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.get('/scan');
        setScan(s);
        if (s.status !== 'running') {
          clearInterval(pollRef.current);
          if (s.status === 'failed') setBanner({ tone: 'critical', text: `Scan failed: ${s.error}` });
          else setBanner({ tone: 'success', text: `Scan done: ${s.hitProducts} products, ${s.codes} colour codes.` });
          await loadVendors();
          await load();
        }
      } catch (e) { /* keep polling */ }
    }, 4000);
    return () => clearInterval(pollRef.current);
  }, [scan, load, loadVendors, setBanner]);

  const startScan = async (opts) => {
    setScanTypesOpen(false);
    try {
      setScan(await api.post('/scan', opts || {}));
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    }
  };

  const rows = useMemo(() => {
    const list = (data && data.rows) || [];
    if (!q) return list;
    const Q = q.toUpperCase();
    return list.filter(r => r.code.toUpperCase().includes(Q) || (r.file && r.file.name.toUpperCase().includes(Q)));
  }, [data, q]);

  useEffect(() => { setPage(0); }, [q]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Recompute the stored possible matches (normally automatic after scans,
  // uploads and library changes).
  const recalcMatches = async () => {
    setRecalc(true);
    try {
      await api.post('/refresh-matches');
      await load();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setRecalc(false);
    }
  };

  const typeOptions = [{ label: 'All types', value: '' }, ...meta.productTypes.map(t => ({ label: t, value: t }))];
  const keyOf = r => `${r.vendor}\u0000${r.codeKey}`;
  const allSelected = pageRows.length > 0 && pageRows.every(r => selected.includes(keyOf(r)));

  // Assign (confirm / choose) — asks before moving a code from another image.
  const assign = async (row, imageId) => {
    setBusy(keyOf(row));
    try {
      let d;
      try {
        d = await api.post('/codes', { libraryId: row.library.id, code: row.code, imageId });
      } catch (e) {
        if (e.status !== 409) throw e;
        if (!window.confirm(`${e.message}. Point it to the new image instead?`)) return;
        d = await api.post('/codes', { libraryId: row.library.id, code: row.code, imageId, reassign: true });
      }
      if (d.synced === false) setBanner({ tone: 'warning', text: `Saved, but the storefront data could not be updated: ${d.syncError}` });
      await load();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setBusy('');
    }
  };

  const unassign = async (row) => {
    if (!window.confirm(`Remove the image from ${row.code}? The storefront will show an empty image area for it.`)) return;
    setBusy(keyOf(row));
    try {
      await api.del('/codes', { libraryId: row.library.id, code: row.code });
      await load();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setBusy('');
    }
  };

  // Ignore / unignore the selected rows, grouped by library.
  const bulk = async (kind) => {
    const chosen = rows.filter(r => selected.includes(keyOf(r)) && r.library);
    if (!chosen.length) return;
    let reason = null;
    if (kind === 'ignore') {
      reason = window.prompt(`Ignore ${chosen.length} colour code(s). Reason (optional):`, '');
      if (reason === null) return;
    }
    setBusy(kind);
    try {
      const byLib = new Map();
      chosen.forEach(r => { if (!byLib.has(r.library.id)) byLib.set(r.library.id, []); byLib.get(r.library.id).push(r.code); });
      for (const [libraryId, codes] of byLib) {
        await api.post(kind === 'ignore' ? '/ignore' : '/unignore', { libraryId, codes, reason });
      }
      await load();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setBusy('');
    }
  };

  const noLibrarySelected = rows.some(r => selected.includes(keyOf(r)) && !r.library);
  const running = scan && scan.status === 'running';
  const vendorButtons = [{ vendor: '', label: 'All vendors' }, ...vendors.map(v => ({ vendor: v.vendor, label: v.vendor, noLib: !v.library_id }))];

  return (
    <BlockStack gap="400">
      <Card>
        <InlineStack gap="400" blockAlign="center" align="space-between" wrap>
          <BlockStack gap="100">
            <Text variant="headingSm" as="h3">Product scan</Text>
            <Text tone="subdued" variant="bodySm">
              {running ? `Scanning… ${scan.objects ? `${scan.objects} objects read` : ''}`
                : scan && scan.status === 'done' ? `Last scan ${fmtTime(scan.finishedAt)} · ${scan.hitProducts} products · ${scan.codes} colour codes`
                  + (scan.scannedWith ? ` · ${scan.scannedWith.map(r => `${r.optionName} in ${r.productTypes.join('/')}`).join('; ')}` : '')
                  : scan && scan.status === 'failed' ? `Last scan failed: ${scan.error}` : 'Never scanned'}
            </Text>
            <Text tone="subdued" variant="bodySm">Reads every Active product in Shopify (published online or not). The list below shows the result of the last scan — opening this page does not query Shopify.</Text>
          </BlockStack>
          <InlineStack gap="200">
            <Button onClick={() => startScan()} loading={running} disabled={running || !config.rules.length}>Scan with the rules</Button>
            <Button onClick={() => setScanTypesOpen(true)} disabled={running}>Scan chosen types…</Button>
            <Button variant="plain" onClick={refreshMeta}>Refresh type list</Button>
          </InlineStack>
        </InlineStack>
      </Card>

      <InlineStack gap="200" wrap>
        {vendorButtons.map(v => (
          <Button key={v.vendor || 'all'} pressed={vendor === v.vendor} onClick={() => setVendor(v.vendor)} size="slim">
            {v.label}{v.noLib ? ' (no library)' : ''}
          </Button>
        ))}
      </InlineStack>

      <FullBleed>
      <Card padding="0">
        <div style={{ padding: 12 }}>
          <InlineStack gap="300" blockAlign="end" wrap>
            <div style={{ width: 180 }}><Select label="Status" options={FILTERS.map(f => ({ ...f, label: data && data.counts ? `${f.label} (${data.counts[f.value]})` : f.label }))} value={filter} onChange={setFilter} /></div>
            <div style={{ width: 160 }}><Select label="Type" options={typeOptions} value={type} onChange={setType} /></div>
            <div style={{ width: 220 }}><TextField label="Search" value={q} onChange={setQ} autoComplete="off" placeholder="Colour code or file name" clearButton onClearButtonClick={() => setQ('')} /></div>
            <Button onClick={() => bulk('ignore')} disabled={!selected.length || noLibrarySelected || !!busy} loading={busy === 'ignore'}>Ignore selected</Button>
            <Button onClick={() => bulk('unignore')} disabled={!selected.length || noLibrarySelected || !!busy} loading={busy === 'unignore'}>Un-ignore selected</Button>
            <Button onClick={() => load()} disabled={!!busy}>Reload</Button>
            <Button onClick={recalcMatches} loading={recalc} disabled={!!busy}>Recalculate matches</Button>
          </InlineStack>
          {vendor && data && !data.library && (
            <div style={{ marginTop: 8 }}><Text tone="caution">{vendor} has no library yet — create one in the Libraries tab. Until then its swatches show an empty image area.</Text></div>
          )}
        </div>
        {!data ? <div style={{ padding: 16 }}><Text tone="subdued">Loading...</Text></div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...TH, width: 32 }}>
                    <Checkbox label="" labelHidden checked={allSelected} onChange={() => setSelected(allSelected ? [] : pageRows.map(keyOf))} />
                  </th>
                  {!vendor && <th style={TH}>Vendor</th>}
                  <th style={TH}>Variant name</th>
                  <th style={TH}>Products</th>
                  <th style={TH}>File name</th>
                  <th style={TH}>Alt text</th>
                  <th style={TH}>Status</th>
                  <th style={TH}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(r => {
                  const k = keyOf(r);
                  const f = r.file || r.candidate;
                  return (
                    <tr key={k} style={{ opacity: r.hidden ? 0.6 : 1 }}>
                      <td style={TD}><Checkbox label="" labelHidden checked={selected.includes(k)} onChange={() => setSelected(s => (s.includes(k) ? s.filter(x => x !== k) : [...s, k]))} /></td>
                      {!vendor && <td style={TD}>{r.vendor}</td>}
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <Text fontWeight="semibold">{r.code}</Text>
                        <div style={{ fontSize: 11, color: '#6d7175' }}>{r.productTypes.join(', ')} · {r.variantCount} SKU</div>
                        {r.hidden && <div style={{ fontSize: 11, color: '#6d7175' }}>Hidden on the storefront (sold out + discontinued)</div>}
                        {r.suggestIgnore && !r.ignored && <div style={{ fontSize: 11, color: '#b98900' }}>Suggested Ignore</div>}
                      </td>
                      <td style={{ ...TD, maxWidth: 320 }}><ProductLinks products={r.products} onViewAll={() => setViewAll(r)} /></td>
                      <td style={TD}>
                        {f ? (
                          <InlineStack gap="200" blockAlign="start" wrap={false}>
                            <SwatchThumb url={f.url} />
                            <div style={{ maxWidth: 220 }}>
                              <div>{f.filename || f.name}</div>
                              {!r.file && <div style={{ fontSize: 11, color: '#6d7175' }}>Candidate: {f.name}</div>}
                            </div>
                          </InlineStack>
                        ) : <Text tone="subdued">—</Text>}
                      </td>
                      <td style={{ ...TD, maxWidth: 220 }}>{r.file ? r.file.alt : ''}</td>
                      <td style={TD}>
                        <StatusBadge row={r} />
                        {r.ignored && r.ignored.reason && <div style={{ fontSize: 11, color: '#6d7175', marginTop: 4 }}>{r.ignored.reason}</div>}
                      </td>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {r.library ? (
                          <InlineStack gap="200">
                            {r.status === 'possible' && <Button size="slim" variant="primary" loading={busy === k} onClick={() => assign(r, r.candidate.imageId)}>Confirm</Button>}
                            <Button size="slim" onClick={() => setChoose(r)} disabled={busy === k}>{r.file ? 'Change' : 'Choose file'}</Button>
                            {r.file && <Button size="slim" tone="critical" variant="plain" onClick={() => unassign(r)} disabled={busy === k}>Remove</Button>}
                          </InlineStack>
                        ) : <Text tone="subdued" variant="bodySm">No library</Text>}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td style={TD} colSpan={8}><Text tone="subdued">{scan && scan.status === 'done' ? 'Nothing here.' : 'Run a scan first.'}</Text></td></tr>
                )}
              </tbody>
            </table>
            {pages > 1 && (
              <div style={{ padding: 12 }}>
                <InlineStack gap="200" blockAlign="center">
                  <Button size="slim" onClick={() => setPage(p => p - 1)} disabled={page === 0}>Previous</Button>
                  <Text variant="bodySm">Page {page + 1} of {pages} · {rows.length} rows</Text>
                  <Button size="slim" onClick={() => setPage(p => p + 1)} disabled={page >= pages - 1}>Next</Button>
                </InlineStack>
              </div>
            )}
          </div>
        )}
      </Card>
      </FullBleed>

      <Modal open={!!viewAll} onClose={() => setViewAll(null)} title={viewAll ? `${viewAll.code} — ${viewAll.products.length} products` : ''}>
        <Modal.Section>
          <BlockStack gap="100">
            {viewAll && viewAll.products.map(p => (
              <a key={p.id} href={`${ADMIN_PRODUCT}${p.id}`} target="_blank" rel="noreferrer" style={{ color: '#2c6ecb' }}>{p.title}</a>
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>
      <ChooseFileModal open={!!choose} row={choose} setBanner={setBanner} onClose={() => setChoose(null)}
        onPicked={(img) => { const r = choose; setChoose(null); assign(r, img.id); }} />
      <ScanTypesModal open={scanTypesOpen} onClose={() => setScanTypesOpen(false)} meta={meta} onStart={startScan} />
    </BlockStack>
  );
}

export default SwatchCodesTab;
