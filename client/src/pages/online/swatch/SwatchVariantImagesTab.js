// Online › Swatch › Variant images — temporary clean-up tool (Hera 2026-10-02).
// Server: server/routes/swatchVariantImages.js (/api/swatch/variant-images).
// Find products (vendor / type / status, or one SKU), review the images
// attached to their variants, then delete those images from the products.
// Product images not attached to a variant stay; a variant image that is also
// the main image is kept. Deleting cannot be undone.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, BlockStack, InlineStack, Text, Button, Select, TextField, Banner, Checkbox, Modal, ProgressBar, Badge } from '@shopify/polaris';
import { api, thumb, TH, TD, ADMIN_PRODUCT, fmtTime } from './swatchApi';

const STATUS_OPTIONS = [
  { label: 'Active', value: 'active' },
  { label: 'Draft', value: 'draft' },
  { label: 'Archived', value: 'archived' },
  { label: 'Any status', value: '' },
];
const numericId = (gid) => String(gid || '').split('/').pop();
const MAX_THUMBS = 12;

function filterText(f) {
  if (!f) return '';
  if (f.sku) return `SKU ${f.sku}`;
  return [f.vendor && `Vendor ${f.vendor}`, f.productType && `Type ${f.productType}`, `Status ${f.status || 'any'}`].filter(Boolean).join(' · ');
}

function Thumb({ url, title, kept }) {
  return (
    <div title={title} style={{
      width: 40, height: 46, flex: 'none', borderRadius: 4, border: kept ? '2px solid #008060' : '1px solid #e1e3e5',
      background: url ? `#fff url("${thumb(url, 120)}") center top / cover no-repeat` : '#f6f6f7',
    }} />
  );
}

function downloadCsv(job, excluded) {
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [['Product', 'Product ID', 'Vendor', 'Type', 'Status', 'Action', 'Media ID', 'SKUs', 'Image URL'].map(esc).join(',')];
  for (const p of job.products) {
    const action = excluded.has(p.id) ? 'skipped (unticked)' : 'delete';
    for (const m of p.media) lines.push([p.title, numericId(p.id), p.vendor, p.productType, p.status, action, numericId(m.id), m.skus.join(' '), m.url].map(esc).join(','));
    if (p.keptMain) lines.push([p.title, numericId(p.id), p.vendor, p.productType, p.status, 'kept (main image)', numericId(p.keptMain.id), p.keptMain.skus.join(' '), p.keptMain.url].map(esc).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `variant-images-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function SwatchVariantImagesTab({ meta }) {
  const [vendor, setVendor] = useState('');
  const [productType, setProductType] = useState('');
  const [status, setStatus] = useState('active');
  const [sku, setSku] = useState('');
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [excluded, setExcluded] = useState(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [log, setLog] = useState([]);
  const timer = useRef(null);

  const loadLog = useCallback(() => api.get('/variant-images/log').then(d => setLog(d.log || [])).catch(() => {}), []);

  const poll = useCallback(async () => {
    try {
      const d = await api.get('/variant-images/job');
      setJob(d.job);
      if (d.job && d.job.status === 'running') timer.current = setTimeout(poll, 1500);
      else if (d.job && d.job.kind === 'delete') loadLog();
    } catch (e) {
      setError(e.message);
    }
  }, [loadLog]);

  useEffect(() => {
    poll();
    loadLog();
    return () => clearTimeout(timer.current);
  }, [poll, loadLog]);

  const find = async (body) => {
    setError(null);
    setExcluded(new Set());
    try {
      await api.post('/variant-images/preview', body);
      clearTimeout(timer.current);
      poll();
    } catch (e) {
      setError(e.message);
    }
  };

  const doDelete = async () => {
    setConfirmOpen(false);
    setConfirmText('');
    setError(null);
    try {
      await api.post('/variant-images/delete', { jobId: job.id, excludeProductIds: [...excluded] });
      clearTimeout(timer.current);
      poll();
    } catch (e) {
      setError(e.message);
    }
  };

  const vendorOptions = [{ label: 'Any vendor', value: '' }, ...(meta.vendors || []).map(v => ({ label: v, value: v }))];
  const typeOptions = [{ label: 'Any type', value: '' }, ...(meta.productTypes || []).map(t => ({ label: t, value: t }))];
  const isRunning = job && job.status === 'running';
  const preview = job && job.kind === 'preview' && job.status === 'done' ? job : null;
  const toDelete = preview ? preview.products.filter(p => !excluded.has(p.id) && p.media.length) : [];
  const imageCount = toDelete.reduce((n, p) => n + p.media.length, 0);
  const toggle = (id) => setExcluded(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <BlockStack gap="400">
      <Banner tone="warning">
        Temporary tool. Deletes the images attached to variants from the products, for good — they cannot be recovered.
        Product images that are not attached to a variant stay. A variant image that is also the product's main image is kept.
      </Banner>
      {error && <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>}

      <Card>
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">Find by filter</Text>
          <InlineStack gap="300" blockAlign="end" wrap>
            <div style={{ minWidth: 220 }}><Select label="Vendor" options={vendorOptions} value={vendor} onChange={setVendor} /></div>
            <div style={{ minWidth: 220 }}><Select label="Product type" options={typeOptions} value={productType} onChange={setProductType} /></div>
            <div style={{ minWidth: 160 }}><Select label="Product status" options={STATUS_OPTIONS} value={status} onChange={setStatus} /></div>
            <Button onClick={() => find({ vendor, productType, status })} disabled={isRunning || (!vendor && !productType)}>Find products</Button>
          </InlineStack>
          <Text tone="subdued" variant="bodySm">Choose a vendor or a product type (or both). Vendor and type lists come from Swatch's cached list — refresh it in the Libraries or Colour codes tab if one is missing.</Text>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">Find by SKU</Text>
          <InlineStack gap="300" blockAlign="end" wrap>
            <div style={{ minWidth: 260 }}>
              <TextField label="SKU" value={sku} onChange={setSku} autoComplete="off" placeholder="Any SKU of the product" />
            </div>
            <Button onClick={() => find({ sku })} disabled={isRunning || !sku.trim()}>Find product</Button>
          </InlineStack>
          <Text tone="subdued" variant="bodySm">Finds the product this SKU belongs to; all of that product's variant images are listed.</Text>
        </BlockStack>
      </Card>

      {isRunning && (
        <Card>
          <BlockStack gap="200">
            <Text>{job.kind === 'preview' ? 'Finding products' : 'Deleting images'}… {job.progress.done} / {job.progress.total || '?'}</Text>
            <ProgressBar progress={job.progress.total ? (job.progress.done / job.progress.total) * 100 : 0} size="small" />
            <Text tone="subdued" variant="bodySm">This runs on the server — you can leave this page and come back.</Text>
          </BlockStack>
        </Card>
      )}

      {job && job.status === 'error' && <Banner tone="critical">{job.kind === 'preview' ? 'Finding' : 'Deleting'} stopped: {job.error}</Banner>}

      {job && job.kind === 'delete' && job.status === 'done' && (
        <Banner tone={job.results.every(r => r.ok) ? 'success' : 'warning'}>
          <BlockStack gap="050">
            <Text>Deleted {job.results.filter(r => r.ok).reduce((n, r) => n + r.deleted, 0)} images from {job.results.filter(r => r.ok).length} products ({filterText(job.filters)}).</Text>
            {job.results.filter(r => !r.ok).map(r => <Text key={r.id}>{r.title}: {r.error}</Text>)}
          </BlockStack>
        </Banner>
      )}

      {preview && (
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <BlockStack gap="050">
                <Text variant="headingSm" as="h3">{filterText(preview.filters)}</Text>
                <Text tone="subdued" variant="bodySm">
                  {preview.totals.searched} products found · {preview.totals.withoutVariantImages} without variant images ·
                  {' '}{preview.totals.products} with variant images · {preview.totals.keptMain} main images kept
                </Text>
              </BlockStack>
              <InlineStack gap="200">
                <Button onClick={() => downloadCsv(preview, excluded)} disabled={!preview.products.length}>Download list (CSV)</Button>
                <Button tone="critical" variant="primary" disabled={!imageCount} onClick={() => setConfirmOpen(true)}>
                  {`Delete ${imageCount} images from ${toDelete.length} products`}
                </Button>
              </InlineStack>
            </InlineStack>
            {preview.products.length === 0 ? <Text tone="subdued">No variant images in these products.</Text> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={TH} /><th style={TH}>Product</th><th style={TH}>Vendor / type / status</th><th style={TH}>Images to delete</th><th style={TH}>Kept (main image)</th>
                  </tr></thead>
                  <tbody>
                    {preview.products.map(p => (
                      <tr key={p.id} style={{ opacity: excluded.has(p.id) ? 0.45 : 1 }}>
                        <td style={{ ...TD, width: 32 }}>
                          <Checkbox label="" labelHidden checked={!excluded.has(p.id)} disabled={!p.media.length} onChange={() => toggle(p.id)} />
                        </td>
                        <td style={{ ...TD, maxWidth: 280 }}>
                          <a href={`${ADMIN_PRODUCT}${numericId(p.id)}`} target="_blank" rel="noreferrer">{p.title}</a>
                          <div style={{ fontSize: 11, color: '#6d7175' }}>{p.variantCount} variants</div>
                        </td>
                        <td style={TD}>{p.vendor}<br />{p.productType}<br /><Badge>{p.status}</Badge></td>
                        <td style={TD}>
                          <InlineStack gap="100" wrap>
                            {p.media.slice(0, MAX_THUMBS).map(m => <Thumb key={m.id} url={m.url} title={m.skus.join(', ')} />)}
                            {p.media.length > MAX_THUMBS && <Text tone="subdued" variant="bodySm">+{p.media.length - MAX_THUMBS}</Text>}
                            {!p.media.length && <Text tone="subdued" variant="bodySm">—</Text>}
                          </InlineStack>
                          {p.media.length > 0 && <div style={{ fontSize: 11, color: '#6d7175', marginTop: 4 }}>{p.media.length} images</div>}
                        </td>
                        <td style={TD}>{p.keptMain ? <Thumb url={p.keptMain.url} title={p.keptMain.skus.join(', ')} kept /> : <Text tone="subdued" variant="bodySm">—</Text>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </BlockStack>
        </Card>
      )}

      {log.length > 0 && (
        <Card>
          <BlockStack gap="200">
            <Text variant="headingSm" as="h3">Recent deletions</Text>
            {log.slice(0, 10).map((e, i) => (
              <Text key={i} tone="subdued" variant="bodySm">
                {fmtTime(e.at)} · {filterText(e.filters)} · {e.images} images from {e.products} products{e.failed ? ` · ${e.failed} failed` : ''}
              </Text>
            ))}
          </BlockStack>
        </Card>
      )}

      <Modal open={confirmOpen} onClose={() => { setConfirmOpen(false); setConfirmText(''); }}
        title={`Delete ${imageCount} images from ${toDelete.length} products?`}
        primaryAction={{ content: 'Delete for good', destructive: true, disabled: confirmText !== 'DELETE', onAction: doDelete }}
        secondaryActions={[{ content: 'Cancel', onAction: () => { setConfirmOpen(false); setConfirmText(''); } }]}>
        <Modal.Section>
          <BlockStack gap="300">
            <Text>These images are removed from the products and cannot be recovered. Tip: download the list (CSV) first.</Text>
            <TextField label="Type DELETE to confirm" value={confirmText} onChange={setConfirmText} autoComplete="off" />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}

export default SwatchVariantImagesTab;
