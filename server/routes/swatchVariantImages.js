// Online › Swatch › Variant images — temporary clean-up tool (Hera 2026-10-02).
// Mounted at /api/swatch/variant-images (from routes/swatch.js).
//
// Finds products by vendor / product type / status, or by one SKU (-> the
// product that SKU belongs to), lists the images attached to their variants,
// and on request deletes those images from the product for good
// (productDeleteMedia — irreversible).
//   - Only images attached to at least one variant are touched; product images
//     not attached to any variant stay.
//   - A variant image that is also the product's main image (featuredMedia) is
//     kept (Hera 2026-10-02).
// One job at a time, kept in memory: a preview job, then a delete job that
// works on exactly the previewed list (minus products the user unticked).
// A server restart drops the job — just run the preview again.
const express = require('express');
const router = express.Router();
const { gql, searchQuote, sleep } = require('../services/shopifyGql');
const { getSetting, setSetting } = require('../services/productData');

const LOG_KEY = 'swatch_variant_image_cleanup_log';
let job = null; // { id, kind, status, error, filters, progress, products, totals, results, startedAt, finishedAt }

const wrap = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(`[swatch variant images] ${req.method} ${req.originalUrl}:`, e);
    res.status(e.status || 500).json({ error: e.message });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const running = () => job && job.status === 'running';

// ─── Find products ───────────────────────────────────────────────────────────
async function productIdsByFilter({ vendor, productType, status }) {
  const parts = [];
  if (vendor) parts.push(`vendor:${searchQuote(vendor)}`);
  if (productType) parts.push(`product_type:${searchQuote(productType)}`);
  if (status) parts.push(`status:${status}`);
  const q = parts.join(' AND ');
  const ids = [];
  let after = null;
  for (;;) {
    const d = await gql(`query($q: String!, $after: String) {
      products(first: 250, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { id vendor productType } }
    }`, { q, after });
    // Shopify search is not always exact (e.g. vendor "OUTRE" vs "OUTRE X") —
    // keep only exact matches.
    for (const p of d.products.nodes) {
      if (vendor && p.vendor !== vendor) continue;
      if (productType && p.productType !== productType) continue;
      ids.push(p.id);
    }
    if (!d.products.pageInfo.hasNextPage) return ids;
    after = d.products.pageInfo.endCursor;
  }
}

async function productIdsBySku(sku) {
  const want = String(sku).trim().toUpperCase();
  const d = await gql(`query($q: String!) {
    productVariants(first: 50, query: $q) { nodes { sku product { id } } }
  }`, { q: `sku:${searchQuote(String(sku).trim())}` });
  return [...new Set(d.productVariants.nodes
    .filter(v => String(v.sku || '').trim().toUpperCase() === want)
    .map(v => v.product.id))];
}

// One product: its variant images (deduplicated), and the main image if it is one of them.
async function productDetail(id) {
  let after = null;
  let p = null;
  const media = new Map(); // mediaId -> { id, url, skus: [] }
  for (;;) {
    const d = await gql(`query($id: ID!, $after: String) {
      product(id: $id) {
        id title vendor productType status
        featuredMedia { id }
        variantsCount { count }
        variants(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { sku media(first: 3) { nodes { id ... on MediaImage { image { url } } } } }
        }
      }
    }`, { id, after });
    if (!d.product) return null;
    if (!p) p = d.product;
    for (const v of d.product.variants.nodes) {
      for (const m of v.media.nodes) {
        if (!media.has(m.id)) media.set(m.id, { id: m.id, url: (m.image && m.image.url) || null, skus: [] });
        if (v.sku) media.get(m.id).skus.push(v.sku);
      }
    }
    if (!d.product.variants.pageInfo.hasNextPage) break;
    after = d.product.variants.pageInfo.endCursor;
  }
  const featuredId = p.featuredMedia && p.featuredMedia.id;
  const all = [...media.values()];
  return {
    id: p.id, title: p.title, vendor: p.vendor, productType: p.productType, status: p.status,
    variantCount: p.variantsCount ? p.variantsCount.count : null,
    media: all.filter(m => m.id !== featuredId),            // to delete
    keptMain: all.find(m => m.id === featuredId) || null,    // variant image that is the main image
  };
}

function totalsOf(products) {
  return {
    products: products.length,
    images: products.reduce((n, p) => n + p.media.length, 0),
    keptMain: products.filter(p => p.keptMain).length,
  };
}

async function runPreview(filters) {
  const ids = filters.sku ? await productIdsBySku(filters.sku) : await productIdsByFilter(filters);
  job.progress = { done: 0, total: ids.length };
  const products = [];
  let withoutVariantImages = 0;
  for (const id of ids) {
    const p = await productDetail(id);
    if (p && (p.media.length || p.keptMain)) products.push(p);
    else withoutVariantImages++;
    job.progress.done++;
  }
  products.sort((a, b) => a.title.localeCompare(b.title));
  job.products = products;
  job.totals = { ...totalsOf(products), searched: ids.length, withoutVariantImages };
}

// ─── Delete ──────────────────────────────────────────────────────────────────
async function deleteMedia(productId, mediaIds) {
  const deleted = [];
  for (let i = 0; i < mediaIds.length; i += 50) {
    // productDeleteMedia is deprecated in favour of fileUpdate, but it is the
    // call that deletes a product's media for good (fileDelete would also
    // remove a shared file from other products).
    const d = await gql(`mutation($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        mediaUserErrors { field message }
      }
    }`, { productId, mediaIds: mediaIds.slice(i, i + 50) });
    const r = d.productDeleteMedia;
    const errs = (r.mediaUserErrors || []).map(e => e.message).join('; ');
    if (errs) throw new Error(errs);
    deleted.push(...(r.deletedMediaIds || []));
    await sleep(200);
  }
  return deleted;
}

async function runDelete(products) {
  job.progress = { done: 0, total: products.length };
  job.results = [];
  for (const p of products) {
    try {
      const deleted = await deleteMedia(p.id, p.media.map(m => m.id));
      job.results.push({ id: p.id, title: p.title, ok: true, deleted: deleted.length });
    } catch (e) {
      job.results.push({ id: p.id, title: p.title, ok: false, error: e.message });
    }
    job.progress.done++;
  }
  const ok = job.results.filter(r => r.ok);
  const entry = {
    at: new Date().toISOString(), filters: job.filters,
    products: ok.length, images: ok.reduce((n, r) => n + r.deleted, 0),
    failed: job.results.length - ok.length,
  };
  const log = await getSetting(LOG_KEY, []);
  await setSetting(LOG_KEY, [entry, ...(Array.isArray(log) ? log : [])].slice(0, 50));
}

function start(kind, filters, fn) {
  job = { id: `${Date.now()}`, kind, status: 'running', error: null, filters, progress: { done: 0, total: 0 },
    products: job && kind === 'delete' ? job.products : [], totals: job && kind === 'delete' ? job.totals : null,
    results: [], startedAt: new Date().toISOString(), finishedAt: null };
  const mine = job;
  fn().then(() => { mine.status = 'done'; }, (e) => {
    console.error(`[swatch variant images] ${kind} failed:`, e);
    mine.status = 'error';
    mine.error = e.message;
  }).finally(() => { mine.finishedAt = new Date().toISOString(); });
  return mine;
}

// ─── Routes ──────────────────────────────────────────────────────────────────
// Body: { sku } or { vendor?, productType?, status? } (vendor or type required).
router.post('/preview', wrap(async (req, res) => {
  if (running()) throw fail(409, 'Another find / delete is still running');
  const b = req.body || {};
  const sku = String(b.sku || '').trim();
  const status = ['active', 'draft', 'archived'].includes(b.status) ? b.status : '';
  const filters = sku
    ? { sku }
    : { vendor: String(b.vendor || '').trim(), productType: String(b.productType || '').trim(), status };
  if (!sku && !filters.vendor && !filters.productType) throw fail(400, 'Choose a vendor or a product type (or enter a SKU)');
  const j = start('preview', filters, () => runPreview(filters));
  res.json({ jobId: j.id });
}));

router.get('/job', wrap(async (req, res) => {
  res.json({ job });
}));

// Body: { jobId, excludeProductIds: [] } — deletes what the preview job found.
router.post('/delete', wrap(async (req, res) => {
  if (running()) throw fail(409, 'Another find / delete is still running');
  const b = req.body || {};
  if (!job || job.kind !== 'preview' || job.status !== 'done' || job.id !== String(b.jobId)) {
    throw fail(409, 'The list has changed or expired — please find the products again');
  }
  const exclude = new Set((b.excludeProductIds || []).map(String));
  const products = job.products.filter(p => !exclude.has(p.id) && p.media.length);
  if (!products.length) throw fail(400, 'Nothing to delete');
  const j = start('delete', job.filters, () => runDelete(products));
  res.json({ jobId: j.id });
}));

router.get('/log', wrap(async (req, res) => {
  res.json({ log: await getSetting(LOG_KEY, []) });
}));

module.exports = router;
