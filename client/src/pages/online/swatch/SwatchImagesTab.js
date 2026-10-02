// Online › Swatch › Images (spec §5.1 / §5.2): upload with a matching
// preview, then manage each image (codes, crop position, replace, delete).
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card, BlockStack, InlineStack, Text, Button, Select, TextField, Banner, DropZone, Checkbox, Modal, ProgressBar, Badge,
} from '@shopify/polaris';
import { api, fileToBase64, TH, TD, SwatchThumb } from './swatchApi';

const POSITIONS = [
  { label: 'Default (top)', value: '' },
  { label: 'Top', value: 'center top' },
  { label: 'Center', value: 'center center' },
  { label: 'Bottom', value: 'center bottom' },
  { label: 'Custom %…', value: 'custom' },
];

// ── Upload ───────────────────────────────────────────────────────────────────
function UploadCard({ library, onUploaded, setBanner, afterSave }) {
  const [items, setItems] = useState([]); // { file, name, shopifyName, already, exact, possible, chosen:Set, extra }
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState([]);

  const onDrop = async (_all, accepted) => {
    if (!accepted.length) return;
    setLoading(true);
    setResults([]);
    try {
      const d = await api.post(`/libraries/${library.id}/preview`, { names: accepted.map(f => f.name) });
      if (!d.codesInUse) setBanner({ tone: 'warning', text: 'No colour codes known for this library yet — run a scan in the Color codes tab first, or type the codes by hand.' });
      setItems(prev => [
        ...prev.filter(p => !accepted.some(f => f.name === p.name)),
        ...d.files.map((f, i) => ({
          file: accepted[i], name: f.name, shopifyName: f.shopifyName, already: f.alreadyUploaded,
          exact: f.exact, possible: f.possible,
          chosen: new Set(f.exact.map(x => x.code)), extra: '',
        })),
      ]);
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setLoading(false);
    }
  };

  const toggle = (idx, code) => setItems(list => list.map((it, i) => {
    if (i !== idx) return it;
    const s = new Set(it.chosen);
    if (s.has(code)) s.delete(code); else s.add(code);
    return { ...it, chosen: s };
  }));
  const codesOf = it => [...new Set([...it.chosen, ...it.extra.split(',').map(s => s.trim()).filter(Boolean)])];

  const uploadAll = async () => {
    const todo = items.filter(it => !it.already);
    setProgress({ done: 0, total: todo.length });
    const out = [];
    for (const it of todo) {
      try {
        const data = await fileToBase64(it.file);
        // Codes that already point to another image were shown in the
        // preview ("now on …"); a ticked one is moved to this image.
        await api.post(`/libraries/${library.id}/images`, { name: it.name, data, codes: codesOf(it), reassign: true, sync: false });
        out.push({ name: it.name, ok: true });
      } catch (e) {
        out.push({ name: it.name, ok: false, error: e.message });
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }
    try {
      const s = await api.post('/sync');
      afterSave({ synced: true, ...s });
    } catch (e) {
      afterSave({ synced: false, syncError: e.message });
    }
    setResults(out);
    setItems(list => list.filter(it => !out.some(o => o.ok && o.name === it.name)));
    setProgress(null);
    onUploaded();
  };

  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingSm" as="h3">Upload images to {library.name}</Text>
        <Text tone="subdued" variant="bodySm">
          Files keep their full original name, saved in Shopify Files as Hera_swatch_{library.prefix}_{'{name}'}. Exact matches are ticked;
          possible matches need your tick. You can also type extra codes (comma separated).
        </Text>
        <DropZone accept="image/jpeg,image/png,image/webp,image/gif" type="image" onDrop={onDrop} disabled={!!progress}>
          <DropZone.FileUpload actionTitle="Add images" actionHint="jpg, png, webp or gif — several at once" />
        </DropZone>
        {loading && <Text tone="subdued">Loading...</Text>}
        {items.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={TH}>File</th><th style={TH}>Colour codes</th><th style={TH}>Other codes</th><th style={TH} />
              </tr></thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={it.name}>
                    <td style={{ ...TD, maxWidth: 260 }}>
                      <div>{it.name}</div>
                      <div style={{ fontSize: 11, color: '#6d7175' }}>{it.shopifyName}</div>
                      {it.already && <Badge tone="warning">Already in this library — skipped (use Replace)</Badge>}
                    </td>
                    <td style={TD}>
                      <BlockStack gap="100">
                        {[...it.exact.map(x => ({ ...x, kind: 'exact' })), ...it.possible.map(x => ({ ...x, kind: 'possible' }))].map(x => (
                          <Checkbox key={x.code} checked={it.chosen.has(x.code)} onChange={() => toggle(idx, x.code)}
                            label={<span>{x.code} <span style={{ fontSize: 11, color: x.kind === 'exact' ? '#008060' : '#b98900' }}>{x.kind === 'exact' ? 'exact' : `possible ×${x.cost}`}</span>
                              {x.assignedTo && <span style={{ fontSize: 11, color: '#d72c0d' }}> · now on {x.assignedTo}</span>}</span>} />
                        ))}
                        {it.exact.length + it.possible.length === 0 && <Text tone="subdued" variant="bodySm">No match found</Text>}
                      </BlockStack>
                    </td>
                    <td style={{ ...TD, width: 220 }}>
                      <TextField label="" labelHidden value={it.extra} placeholder="#1B, #2" autoComplete="off"
                        onChange={(v) => setItems(list => list.map((x, i) => (i === idx ? { ...x, extra: v } : x)))} />
                    </td>
                    <td style={TD}><Button variant="plain" onClick={() => setItems(list => list.filter((_, i) => i !== idx))}>Remove</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {progress && <ProgressBar progress={(progress.done / Math.max(progress.total, 1)) * 100} size="small" />}
        {items.length > 0 && (
          <InlineStack gap="200">
            <Button variant="primary" onClick={uploadAll} loading={!!progress} disabled={!items.some(it => !it.already)}>
              Upload {items.filter(it => !it.already).length} image(s)
            </Button>
            {items.some(it => it.exact.length + it.possible.length === 0) && (
              <Button onClick={() => setItems(list => list.filter(it => it.exact.length + it.possible.length > 0))} disabled={!!progress}>
                {`Remove files with no match (${items.filter(it => it.exact.length + it.possible.length === 0).length})`}
              </Button>
            )}
            <Button onClick={() => setItems([])} disabled={!!progress}>Clear</Button>
          </InlineStack>
        )}
        {results.length > 0 && (
          <Banner tone={results.every(r => r.ok) ? 'success' : 'warning'} onDismiss={() => setResults([])}>
            <BlockStack gap="050">
              <Text>Uploaded {results.filter(r => r.ok).length} of {results.length}.</Text>
              {results.filter(r => !r.ok).map(r => <Text key={r.name}>{r.name}: {r.error}</Text>)}
            </BlockStack>
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}

// ── One image ────────────────────────────────────────────────────────────────
function ImageCard({ img, onChanged, setBanner, afterSave }) {
  const [editCodes, setEditCodes] = useState(null);
  const [customPos, setCustomPos] = useState(null);
  const [busy, setBusy] = useState('');
  const replaceRef = useRef(null);
  const posValue = !img.position ? '' : POSITIONS.some(p => p.value === img.position) ? img.position : 'custom';

  const save = async (body, label) => {
    setBusy(label);
    try {
      let d;
      try {
        d = await api.put(`/images/${img.id}`, body);
      } catch (e) {
        if (e.status !== 409) throw e;
        const list = (e.data.conflicts || []).map(c => `${c.code} (now on ${c.original_name})`).join(', ');
        if (!window.confirm(`These codes already point to another image: ${list}. Move them to this image?`)) return;
        d = await api.put(`/images/${img.id}`, { ...body, reassign: true });
      }
      afterSave(d);
      onChanged();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setBusy('');
    }
  };

  const replace = async (file) => {
    if (!file) return;
    setBusy('replace');
    try {
      const data = await fileToBase64(file);
      const d = await api.put(`/images/${img.id}/file`, { data, name: file.name });
      afterSave(d, `${img.original_name} replaced.`);
      onChanged();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${img.original_name}? It is also deleted from Shopify Files${img.codes.length ? `, and ${img.codes.join(', ')} will show an empty image` : ''}.`)) return;
    setBusy('delete');
    try {
      const d = await api.del(`/images/${img.id}`);
      afterSave(d);
      onChanged();
    } catch (e) {
      setBanner({ tone: 'critical', text: e.message });
      setBusy('');
    }
  };

  return (
    <div style={{ border: '1px solid #e1e3e5', borderRadius: 8, padding: 10, background: '#fff' }}>
      <InlineStack gap="300" wrap={false} blockAlign="start">
        <SwatchThumb url={img.url} position={img.position} width={72} height={81} />
        <BlockStack gap="100">
          <Text fontWeight="semibold" breakWord>{img.original_name}</Text>
          <div style={{ fontSize: 11, color: '#6d7175', wordBreak: 'break-all' }}>{img.filename}</div>
          <div style={{ fontSize: 12 }}>{img.codes.length ? img.codes.join(', ') : <span style={{ color: '#b98900' }}>No colour code</span>}</div>
        </BlockStack>
      </InlineStack>
      <div style={{ marginTop: 8 }}>
        <InlineStack gap="200" wrap blockAlign="end">
          <div style={{ width: 130 }}>
            <Select label="Crop" labelInline={false} options={POSITIONS} value={posValue}
              onChange={(v) => (v === 'custom' ? setCustomPos(img.position && posValue === 'custom' ? img.position : 'center 20%') : save({ position: v || null }, 'pos'))} />
          </div>
          <Button size="slim" onClick={() => setEditCodes(img.codes.join(', '))}>Codes</Button>
          <Button size="slim" onClick={() => replaceRef.current && replaceRef.current.click()} loading={busy === 'replace'}>Replace</Button>
          <Button size="slim" tone="critical" variant="plain" onClick={remove} loading={busy === 'delete'}>Delete</Button>
          <input ref={replaceRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { replace(e.target.files[0]); e.target.value = ''; }} />
        </InlineStack>
      </div>
      <Modal open={editCodes !== null} onClose={() => setEditCodes(null)} title={`Colour codes for ${img.original_name}`}
        primaryAction={{ content: 'Save', loading: busy === 'codes', onAction: async () => { await save({ codes: editCodes.split(',').map(s => s.trim()).filter(Boolean) }, 'codes'); setEditCodes(null); } }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setEditCodes(null) }]}>
        <Modal.Section>
          <TextField label="Codes (comma separated, e.g. #TT1B/BU, #TT1B/BURG)" value={editCodes || ''} onChange={setEditCodes} multiline={3} autoComplete="off" />
        </Modal.Section>
      </Modal>
      <Modal open={customPos !== null} onClose={() => setCustomPos(null)} title="Custom crop position"
        primaryAction={{ content: 'Save', onAction: async () => { await save({ position: customPos }, 'pos'); setCustomPos(null); } }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setCustomPos(null) }]}>
        <Modal.Section>
          <BlockStack gap="300">
            <TextField label="CSS background-position, e.g. center 20%" value={customPos || ''} onChange={setCustomPos} autoComplete="off" />
            <SwatchThumb url={img.url} position={customPos} width={72} height={81} />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </div>
  );
}

function SwatchImagesTab({ libraries, loadLibraries, setBanner, afterSave }) {
  const [libId, setLibId] = useState(libraries[0] ? String(libraries[0].id) : '');
  const [images, setImages] = useState(null);
  const [q, setQ] = useState('');
  const [onlyNoCode, setOnlyNoCode] = useState(false);
  const library = libraries.find(l => String(l.id) === libId);

  const load = useCallback(async () => {
    if (!libId) return;
    const d = await api.get(`/libraries/${libId}/images`);
    setImages(d.images);
  }, [libId]);
  useEffect(() => { setImages(null); load().catch(e => setBanner({ tone: 'critical', text: e.message })); }, [load, setBanner]);
  useEffect(() => { if (!libId && libraries[0]) setLibId(String(libraries[0].id)); }, [libraries, libId]);

  const changed = () => { load(); loadLibraries(); };

  if (!libraries.length) return <Card><Text tone="subdued">Create a library first (Libraries tab).</Text></Card>;

  const list = (images || []).filter(i => (!q || i.original_name.toUpperCase().includes(q.toUpperCase()) || i.codes.some(c => c.toUpperCase().includes(q.toUpperCase())))
    && (!onlyNoCode || !i.codes.length));

  return (
    <BlockStack gap="400">
      <div style={{ width: 260 }}>
        <Select label="Library" options={libraries.map(l => ({ label: `${l.name} (${l.image_count})`, value: String(l.id) }))} value={libId} onChange={setLibId} />
      </div>
      {library && <UploadCard library={library} onUploaded={changed} setBanner={setBanner} afterSave={afterSave} />}
      <Card>
        <BlockStack gap="300">
          <InlineStack gap="300" blockAlign="end" wrap>
            <div style={{ width: 240 }}><TextField label="Search" value={q} onChange={setQ} autoComplete="off" placeholder="File name or colour code" clearButton onClearButtonClick={() => setQ('')} /></div>
            <Checkbox label="Only images without a colour code" checked={onlyNoCode} onChange={setOnlyNoCode} />
          </InlineStack>
          {!images ? <Text tone="subdued">Loading...</Text> : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {list.map(img => <ImageCard key={img.id} img={img} onChanged={changed} setBanner={setBanner} afterSave={afterSave} />)}
              {list.length === 0 && <Text tone="subdued">No images.</Text>}
            </div>
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

export default SwatchImagesTab;
