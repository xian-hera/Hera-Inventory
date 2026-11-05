// Online › Wig Try-on › Prompt & Test.
// Prompts are versioned: saving always creates a new version (never edits an
// old one), so every generation can be traced to the exact prompt it used.
// The test panel runs a real generation from the Hub (not counted in quotas,
// logged as "Hub test") with either the editor's unsaved text or a saved version.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card, BlockStack, InlineStack, InlineGrid, Text, TextField, Button, Badge, Checkbox, Select, Banner, Box, Collapsible,
} from '@shopify/polaris';
import { api, IMAGE_MODELS, CHECK_MODELS, photoToJpeg, fmtTime, fmtMs, fmtNum, ADMIN_PRODUCT, REASON_LABEL, TH, TD } from './wigTryonApi';

const PLACEHOLDER_HELP = 'Placeholders: {{product_title}} {{color_name}} {{image_count}}. '
  + '{{#color}}…{{/color}} is kept only when a colour reference image is sent; {{^color}}…{{/color}} only when it is not. '
  + 'Image order sent to OpenAI: 1 = product photo, 2 = selfie, 3 = colour reference.';

function Versions({ prompts, activeVersion, pinned, onLoad, onActivate }) {
  return (
    <Box overflowX="auto">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={TH}>Version</th><th style={TH}>Note</th><th style={TH}>Saved</th><th style={TH}>OK / failed</th><th style={TH} /></tr></thead>
        <tbody>
          {prompts.map(p => (
            <tr key={p.version}>
              <td style={TD}>
                <InlineStack gap="100" blockAlign="center">
                  <Text fontWeight="semibold">v{p.version}</Text>
                  {p.version === activeVersion && <Badge tone="success">{pinned ? 'In use' : 'In use (latest)'}</Badge>}
                </InlineStack>
              </td>
              <td style={TD}>{p.note || ''}</td>
              <td style={TD}>{fmtTime(p.created_at)}</td>
              <td style={TD}>{p.success_count} / {p.failed_count}</td>
              <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                <InlineStack gap="200">
                  <Button size="slim" onClick={() => onLoad(p)}>Open in editor</Button>
                  {p.version !== activeVersion && <Button size="slim" onClick={() => onActivate(p.version)}>Use on storefront</Button>}
                </InlineStack>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  );
}

function TestPanel({ editorText, editorFrom, prompts, setBanner, onDone }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [product, setProduct] = useState(null); // { product, colors, colorOption }
  const [runCheck, setRunCheck] = useState(true);
  const [check, setCheck] = useState(null); // last selfie check result
  const [checking, setChecking] = useState(false);
  const [colorName, setColorName] = useState('');
  const [selfie, setSelfie] = useState(null); // data URL
  const [promptSource, setPromptSource] = useState('editor');
  const [quality, setQuality] = useState('');
  const [model, setModel] = useState('');
  const [checkModel, setCheckModel] = useState('');
  const [job, setJob] = useState(null); // { id, status, image, info, error, startedAt }
  const [showPrompt, setShowPrompt] = useState(false);
  const fileRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => { const r = pollRef; return () => clearTimeout(r.current); }, []);

  const search = async () => {
    setSearching(true);
    try { setResults((await api.get(`/products?q=${encodeURIComponent(q)}`)).products); } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
    setSearching(false);
  };
  const pick = async (p) => {
    try {
      const d = await api.get(`/products/${p.numericId}`);
      setProduct(d);
      setColorName('');
      setResults(null);
    } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
  };
  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { setSelfie(await photoToJpeg(f)); setCheck(null); } catch (err) { setBanner({ tone: 'critical', text: err.message }); }
  };

  const poll = useCallback((id, startedAt) => {
    pollRef.current = setTimeout(async () => {
      try {
        const d = await api.get(`/jobs/${id}`);
        if (d.status === 'running') { setJob(j => ({ ...j, elapsedMs: d.elapsedMs })); poll(id, startedAt); return; }
        setJob({ id, startedAt, ...d });
        onDone();
      } catch (e) { setJob({ id, status: 'failed', error: e.message }); }
    }, 3000);
  }, [onDone]);

  const run = async () => {
    const body = { productId: product.product.numericId, colorName: colorName || null, selfie, runCheck };
    if (promptSource === 'editor') body.template = editorText;
    else body.promptVersion = parseInt(promptSource, 10);
    if (checkModel) body.checkModel = checkModel;
    if (quality || model) body.openai = { ...(quality ? { quality } : {}), ...(model ? { model } : {}) };
    try {
      setJob(null);
      setChecking(runCheck);
      const d = await api.post('/test', body);
      setChecking(false);
      setCheck(d.check || null);
      if (d.rejected) return;
      if (d.colorMissingImage) setBanner({ tone: 'warning', text: `No Swatch image for colour ${colorName} — generating without a colour reference.` });
      const startedAt = Date.now();
      setJob({ id: d.jobId, status: 'running', startedAt });
      poll(d.jobId, startedAt);
    } catch (e) { setChecking(false); setBanner({ tone: 'critical', text: e.message }); }
  };

  // Check only (no generation) — to tune the selfie check cheaply.
  const checkOnly = async () => {
    setChecking(true);
    try { setCheck((await api.post('/check', { selfie, checkModel: checkModel || undefined })).check); onDone(); } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
    setChecking(false);
  };

  const running = job && job.status === 'running';
  const promptOptions = [
    { label: `Editor text (unsaved)${editorFrom ? ` — based on v${editorFrom}` : ''}`, value: 'editor' },
    ...prompts.map(p => ({ label: `v${p.version}${p.note ? ` — ${p.note}` : ''}`, value: String(p.version) })),
  ];

  return (
    <Card>
      <BlockStack gap="400">
        <Text variant="headingMd">Test generation</Text>
        <Text tone="subdued" variant="bodySm">Same steps as a customer: colour → selfie → selfie check → generation. Runs real OpenAI calls (same cost as a customer try-on) but does not use any customer quota. The photo and the result are not saved.</Text>

        {/* 1. Product */}
        <BlockStack gap="200">
          <Text fontWeight="semibold">1. Product</Text>
          {product ? (
            <InlineStack gap="200" blockAlign="center">
              <a href={`${ADMIN_PRODUCT}${product.product.numericId}`} target="_blank" rel="noreferrer">{product.product.title}</a>
              <Text tone="subdued">{product.product.vendor} · {product.product.productType}</Text>
              <Button variant="plain" onClick={() => setProduct(null)}>Change</Button>
            </InlineStack>
          ) : (
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="end">
                <div style={{ flex: 1, minWidth: 240 }}>
                  <TextField label="Search wigs" labelHidden placeholder="Search by title, vendor…" value={q} onChange={setQ} autoComplete="off"
                    connectedRight={<Button onClick={search} loading={searching}>Search</Button>}
                    onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
                </div>
              </InlineStack>
              {results && (results.length ? (
                <BlockStack gap="100">
                  {results.map(p => (
                    <button key={p.id} type="button" onClick={() => pick(p)}
                      style={{ display: 'flex', gap: 10, alignItems: 'center', border: '1px solid #e1e3e5', borderRadius: 8, padding: 6, background: '#fff', cursor: 'pointer', textAlign: 'left' }}>
                      <div style={{ width: 40, height: 40, flex: 'none', borderRadius: 4, background: p.image ? `#f6f6f7 url("${p.image}${p.image.includes('?') ? '&' : '?'}width=80") center/cover` : '#f6f6f7' }} />
                      <span><b>{p.title}</b><br /><span style={{ color: '#6d7175', fontSize: 12 }}>{p.vendor} · {p.productType} · {p.status}</span></span>
                    </button>
                  ))}
                </BlockStack>
              ) : <Text tone="subdued">No products found (only the product types in Settings are searched).</Text>)}
            </BlockStack>
          )}
        </BlockStack>

        {product && (
          <>
            {/* Product photo = always the first image (same as the storefront) */}
            <BlockStack gap="200">
              <Text fontWeight="semibold">Product photo used</Text>
              {product.product.media[0] ? (
                <InlineStack gap="200" blockAlign="center">
                  <div style={{
                    width: 84, height: 105, borderRadius: 6, border: '1px solid #e1e3e5',
                    background: `#f6f6f7 url("${product.product.media[0].url}${product.product.media[0].url.includes('?') ? '&' : '?'}width=200") center top/cover`,
                  }} />
                  <Text tone="subdued" variant="bodySm">Always the product's first image.</Text>
                </InlineStack>
              ) : <Text tone="critical">This product has no image — it cannot be tried on.</Text>}
            </BlockStack>

            {/* 2. Colour */}
            <BlockStack gap="200">
              <Text fontWeight="semibold">2. Colour</Text>
              {product.colors.length ? (
                <InlineStack gap="300" blockAlign="center">
                  <div style={{ minWidth: 260 }}>
                    <Select label="Colour" labelHidden value={colorName} onChange={setColorName}
                      options={[{ label: 'No colour — keep the photo’s colour', value: '' },
                        ...product.colors.map(c => ({ label: `${c.name}${c.swatchUrl ? '' : '  (no Swatch image)'}`, value: c.name }))]} />
                  </div>
                  {colorName && (() => {
                    const c = product.colors.find(x => x.name === colorName);
                    return c && c.swatchUrl
                      ? <div style={{ width: 48, height: 54, borderRadius: 4, border: '1px solid #e1e3e5', background: `url("${c.swatchUrl}${c.swatchUrl.includes('?') ? '&' : '?'}width=120") center top/cover` }} />
                      : <Text tone="caution">No Swatch image — would generate without a colour reference.</Text>;
                  })()}
                </InlineStack>
              ) : <Text tone="subdued">This product has no colour option{product.colorOption ? '' : ' (no Swatch rule and no option named Color)'}.</Text>}
            </BlockStack>

            {/* 4. Selfie */}
            <BlockStack gap="200">
              <Text fontWeight="semibold">3. Selfie</Text>
              <InlineStack gap="300" blockAlign="center">
                {selfie && <img src={selfie} alt="" style={{ width: 84, height: 105, objectFit: 'cover', borderRadius: 6, border: '1px solid #e1e3e5' }} />}
                <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
                <Button onClick={() => fileRef.current && fileRef.current.click()}>{selfie ? 'Change photo' : 'Choose photo'}</Button>
                {selfie && <Button onClick={checkOnly} loading={checking} disabled={checking || running}>Check selfie only</Button>}
              </InlineStack>
              {check && (
                <Banner tone={check.suitable ? 'success' : 'warning'}>
                  <BlockStack gap="100">
                    <Text fontWeight="semibold">{check.suitable ? 'Selfie OK' : `Selfie rejected: ${REASON_LABEL[check.reason] || check.reason}`}{check.error ? ' (check failed)' : ''}</Text>
                    {check.note && <Text variant="bodySm">{check.note}</Text>}
                    <Text variant="bodySm" tone="subdued">{check.model ? `${check.model} · ` : ''}{fmtMs(check.durationMs)} · {fmtNum(check.usage && check.usage.input_tokens)} in / {fmtNum(check.usage && check.usage.output_tokens)} out tokens</Text>
                  </BlockStack>
                </Banner>
              )}
            </BlockStack>

            {/* 4. Prompt + run */}
            <InlineStack gap="300" blockAlign="end" wrap>
              <div style={{ minWidth: 320 }}><Select label="Prompt" options={promptOptions} value={promptSource} onChange={setPromptSource} /></div>
              <div style={{ minWidth: 200 }}>
                <Select label="Check model (this test only)" value={checkModel} onChange={setCheckModel}
                  options={[{ label: 'As in Settings', value: '' }, ...CHECK_MODELS.map(m => ({ label: m.value, value: m.value }))]} />
              </div>
              <div style={{ minWidth: 200 }}>
                <Select label="Model (this test only)" value={model} onChange={setModel}
                  options={[{ label: 'As in Settings', value: '' }, ...IMAGE_MODELS.map(m => ({ label: m, value: m }))]} />
              </div>
              <div style={{ minWidth: 180 }}>
                <Select label="Quality (this test only)" value={quality} onChange={setQuality}
                  options={[{ label: 'As in Settings', value: '' }, ...['low', 'medium', 'high', 'xhigh', 'max'].map(v => ({ label: v, value: v }))]} />
              </div>
              <Checkbox label="Check the selfie first (like the storefront)" checked={runCheck} onChange={setRunCheck} />
              <Button variant="primary" onClick={run} loading={running || checking} disabled={!product.product.media[0] || !selfie || running || checking}>Generate</Button>
            </InlineStack>
          </>
        )}

        {job && (
          <Box padding="300" background="bg-surface-secondary" borderRadius="200">
            {job.status === 'running' && <Text tone="subdued">Generating... {Math.round((job.elapsedMs || 0) / 1000)} s</Text>}
            {job.status === 'failed' && <Banner tone="critical">Generation failed: {job.error}</Banner>}
            {job.status === 'done' && (
              <BlockStack gap="300">
                <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                  <img src={job.image} alt="Try-on result" style={{ width: '100%', maxWidth: 480, borderRadius: 8 }} />
                  <BlockStack gap="200">
                    <Text>Model: {job.info.model || '—'} · quality {job.info.quality || '—'}</Text>
                    <Text>Time: {fmtMs(job.info.durationMs)}</Text>
                    <Text>Tokens: {fmtNum(job.info.usage && job.info.usage.input_tokens)} in / {fmtNum(job.info.usage && job.info.usage.output_tokens)} out</Text>
                    <Text>Colour reference: {job.info.colorUsed ? 'used' : 'not used'}</Text>
                    <InlineStack gap="200">
                      <a href={job.image} download="wig-tryon-test.jpg"><Button>Download</Button></a>
                      <Button variant="plain" onClick={() => setShowPrompt(v => !v)}>{showPrompt ? 'Hide' : 'Show'} prompt sent</Button>
                    </InlineStack>
                    <Collapsible open={showPrompt} id="wig-tryon-prompt-sent">
                      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #e1e3e5' }}>{job.info.prompt}</pre>
                    </Collapsible>
                  </BlockStack>
                </InlineGrid>
              </BlockStack>
            )}
          </Box>
        )}
      </BlockStack>
    </Card>
  );
}

export default function WigTryonPrompt({ reload, setBanner }) {
  const [data, setData] = useState(null); // { prompts, activeVersion, pinned }
  const [text, setText] = useState('');
  const [from, setFrom] = useState(null); // version the editor text came from
  const [note, setNote] = useState('');
  const [activate, setActivate] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (initEditor) => {
    try {
      const d = await api.get('/prompts');
      setData(d);
      if (initEditor) {
        const cur = d.prompts.find(p => p.version === d.activeVersion) || d.prompts[0];
        if (cur) { setText(cur.template); setFrom(cur.version); }
      }
    } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
  }, [setBanner]);
  useEffect(() => { load(true); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const d = await api.post('/prompts', { template: text, note, activate });
      setFrom(d.prompt.version);
      setNote('');
      setBanner({ tone: 'success', text: `Saved as v${d.prompt.version}${activate ? ' and now used on the storefront' : ''}.` });
      await load(false);
      reload();
    } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
    setSaving(false);
  };
  const activateVersion = async (v) => {
    try {
      await api.post(`/prompts/${v}/activate`);
      setBanner({ tone: 'success', text: `v${v} is now used on the storefront.` });
      await load(false);
      reload();
    } catch (e) { setBanner({ tone: 'critical', text: e.message }); }
  };

  if (!data) return <Text tone="subdued">Loading...</Text>;
  const original = (data.prompts.find(p => p.version === from) || {}).template;
  const changed = text !== original;

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text variant="headingMd">Prompt editor</Text>
            <Text tone="subdued">{from ? `Opened from v${from}` : 'New'}{changed ? ' · edited (not saved)' : ''}</Text>
          </InlineStack>
          <TextField label="Prompt" labelHidden multiline={14} value={text} onChange={setText} autoComplete="off" monospaced helpText={PLACEHOLDER_HELP} />
          <InlineStack gap="300" blockAlign="end" wrap>
            <div style={{ flex: 1, minWidth: 260 }}><TextField label="Note for this version (optional)" value={note} onChange={setNote} autoComplete="off" placeholder="e.g. keep skin tone stronger" /></div>
            <Checkbox label="Use on the storefront after saving" checked={activate} onChange={setActivate} />
            <Button variant="primary" onClick={save} loading={saving} disabled={!text.trim() || !changed}>Save as new version</Button>
          </InlineStack>
        </BlockStack>
      </Card>

      <TestPanel editorText={text} editorFrom={from} prompts={data.prompts} setBanner={setBanner} onDone={() => load(false)} />

      <Card>
        <BlockStack gap="200">
          <Text variant="headingMd">Versions</Text>
          <Versions prompts={data.prompts} activeVersion={data.activeVersion} pinned={data.pinned}
            onLoad={(p) => { setText(p.template); setFrom(p.version); }} onActivate={activateVersion} />
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
