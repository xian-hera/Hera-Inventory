// Online › Wig Try-on — product lookup, colour reference, generation jobs
// (2026-11-04, Hera). Spec: claude/WIG_TRYON_FEATURE_SPEC.md.
//
// PRIVACY: the selfie and the generated image live only in this process's
// memory (the `jobs` Map below). Nothing image-related is written to the
// database, disk or Shopify. A finished job is dropped after JOB_TTL_MS.
// Hub runs as ONE Render instance; with several instances a job would have to
// be polled on the instance that created it.
const crypto = require('crypto');
const { pool } = require('../database/init');
const { gql } = require('./shopifyGql');
const { codeKey } = require('./swatchMatch');
const swatchStore = require('./swatchStore');
const store = require('./wigTryonStore');
const { editImage, checkSelfie, fetchImage, sniffMime } = require('./wigTryonOpenAI');

const MAX_SELFIE_BYTES = 10 * 1024 * 1024;
const JOB_TTL_MS = 10 * 60 * 1000;
// A checked selfie stays in memory 30 minutes after its LAST use (Hera 2026-11-05),
// so the customer can try other wigs in the same visit without uploading again.
const SELFIE_TTL_MS = 30 * 60 * 1000;

// ─── Product data (Admin API, cached 5 min) ─────────────────────────────────
const productCache = new Map(); // gid -> { at, data }
const PRODUCT_TTL_MS = 5 * 60 * 1000;

const toGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Product/${String(id).replace(/\D/g, '')}`);
const numId = (gid) => { const m = String(gid || '').match(/(\d+)$/); return m ? m[1] : ''; };

const PRODUCT_QUERY = `
  query WigTryonProduct($id: ID!) {
    product(id: $id) {
      id title handle productType vendor status
      options { name values }
      media(first: 50) { nodes { id mediaContentType ... on MediaImage { image { url width height altText } } } }
    }
  }`;

async function getProduct(id) {
  const gid = toGid(id);
  const hit = productCache.get(gid);
  if (hit && Date.now() - hit.at < PRODUCT_TTL_MS) return hit.data;
  const d = await gql(PRODUCT_QUERY, { id: gid });
  const p = d && d.product;
  if (!p) return null;
  const data = {
    id: p.id, numericId: numId(p.id), title: p.title, handle: p.handle,
    productType: p.productType, vendor: p.vendor, status: p.status,
    options: p.options || [],
    media: ((p.media && p.media.nodes) || [])
      .filter(m => m.image && m.image.url)
      .map(m => ({ id: m.id, numericId: numId(m.id), url: m.image.url, width: m.image.width, height: m.image.height, alt: m.image.altText })),
  };
  productCache.set(gid, { at: Date.now(), data });
  return data;
}

async function searchProducts(config, q) {
  const types = (config.eligibleTypes || []).map(t => `product_type:${JSON.stringify(t)}`).join(' OR ');
  const parts = [];
  if (types) parts.push(`(${types})`);
  if (q) parts.push(`(${String(q).replace(/["\\]/g, ' ').trim()})`);
  const d = await gql(`
    query WigTryonSearch($q: String) {
      products(first: 25, query: $q, sortKey: RELEVANCE) {
        nodes { id title vendor productType status featuredMedia { preview { image { url } } } }
      }
    }`, { q: parts.join(' AND ') || null });
  return ((d.products && d.products.nodes) || []).map(p => ({
    id: p.id, numericId: numId(p.id), title: p.title, vendor: p.vendor, productType: p.productType, status: p.status,
    image: p.featuredMedia && p.featuredMedia.preview && p.featuredMedia.preview.image ? p.featuredMedia.preview.image.url : null,
  }));
}

// Which option holds the colour: the Swatch rule's option for this type,
// otherwise an option called Color / Colour.
async function colorOptionName(product) {
  const names = (product.options || []).map(o => o.name);
  try {
    const sc = await swatchStore.getConfig();
    const hit = swatchStore.ruleOptionFor(sc.rules, product.productType, names);
    if (hit) return hit;
  } catch (e) { /* swatch config unreadable — fall back */ }
  return names.find(n => /^colou?r$/i.test(String(n).trim())) || null;
}

async function colorValues(product) {
  const name = await colorOptionName(product);
  const opt = name ? (product.options || []).find(o => o.name === name) : null;
  return { optionName: name, values: opt ? opt.values : [] };
}

// Colour reference image = the Swatch library image for vendor + colour code
// (spec §4: reuse the Swatch colour cards). Returns { url, filename } or null.
async function colorReference(vendor, colorName) {
  const lib = await swatchStore.libraryForVendor(vendor);
  if (!lib) return null;
  const r = await pool.query(`
    SELECT i.url, i.filename FROM swatch_codes c JOIN swatch_images i ON i.id = c.image_id
    WHERE c.library_id = $1 AND c.code_key = $2 LIMIT 1`, [lib.id, codeKey(colorName)]);
  return r.rows[0] && r.rows[0].url ? r.rows[0] : null;
}

// ─── Selfie input ───────────────────────────────────────────────────────────
// base64 (with or without data: prefix) -> { buffer, mime }; throws readable errors.
function decodeSelfie(b64) {
  if (!b64 || typeof b64 !== 'string') throw new Error('Photo is missing');
  const raw = b64.replace(/^data:[^,]*,/, '');
  if (raw.length > Math.ceil(MAX_SELFIE_BYTES * 4 / 3) + 16) throw new Error('Photo is too large (max 10 MB)');
  const buffer = Buffer.from(raw, 'base64');
  const mime = sniffMime(buffer);
  if (!mime) throw new Error('Photo must be a JPEG, PNG or WebP image');
  return { buffer, mime };
}

// ─── Jobs (memory only) ─────────────────────────────────────────────────────
const jobs = new Map();

function sweepJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
}
setInterval(sweepJobs, 60 * 1000).unref();

function getJob(id, ownerKey) {
  const j = jobs.get(String(id || ''));
  if (!j || j.ownerKey !== ownerKey) return null;
  return j;
}

// Resolves everything a generation needs. Throws Error with .publicMessage
// for problems the customer may see.
// Product photo = the product's FIRST image, always (Hera 2026-11-04 — the
// customer no longer picks a photo, so it is not checked either).
async function prepare({ config, productId, colorName, requireEligible = true }) {
  const product = await getProduct(productId);
  if (!product) throw Object.assign(new Error('Product not found'), { code: 'bad_request' });
  if (requireEligible && !store.isEligibleType(config, product.productType)) {
    throw Object.assign(new Error(`Product type "${product.productType}" is not enabled for try-on`), { code: 'bad_request' });
  }
  const media = product.media[0];
  if (!media) throw Object.assign(new Error('This product has no photo'), { code: 'bad_request' });

  let color = null;
  if (colorName) {
    const { values } = await colorValues(product);
    const want = codeKey(colorName);
    const value = values.find(v => codeKey(v) === want);
    if (!value) throw Object.assign(new Error(`Colour "${colorName}" is not a colour of this product`), { code: 'bad_request' });
    const ref = await colorReference(product.vendor, value);
    color = { name: value, ref }; // ref null = no swatch image -> generate without colour image
  }
  return { product, media, color };
}

// Starts a generation in the background; returns the job id right away.
// ctx: { source, ownerKey, customerId, ipHash, sessionId, usageDate (when a
// quota was taken; refunded on failure), promptTemplate, promptVersion }
function startJob({ config, prepared, selfie, ctx }) {
  sweepJobs();
  const id = crypto.randomUUID();
  const job = { id, ownerKey: ctx.ownerKey, status: 'running', createdAt: Date.now(), result: null, error: null, info: {} };
  jobs.set(id, job);

  (async () => {
    const t0 = Date.now();
    const { product, media, color } = prepared;
    const useColor = !!(color && color.ref);
    const evBase = {
      source: ctx.source, session_id: ctx.sessionId, customer_id: ctx.customerId, ip_hash: ctx.ipHash,
      product_id: product.numericId, product_title: product.title, vendor: product.vendor,
      color_name: color ? color.name : null, prompt_version: ctx.promptVersion, model: config.openai.model,
    };
    try {
      const productImg = await fetchImage(media.url);
      const images = [
        { ...productImg, name: 'image1_product' },
        { ...selfie, name: 'image2_selfie' },
      ];
      if (useColor) images.push({ ...(await fetchImage(color.ref.url)), name: 'image3_color' });
      const prompt = store.renderPrompt(ctx.promptTemplate, {
        product_title: product.title,
        color_name: useColor ? color.name : '',
        image_count: images.length,
      });
      const out = await editImage({ images, prompt, openai: config.openai });
      job.result = { b64: out.b64, mime: out.mime };
      job.status = 'done';
      job.info = {
        durationMs: Date.now() - t0, usage: out.usage, prompt,
        colorUsed: useColor, colorMissingImage: !!(color && !color.ref),
      };
      await store.logEvent({
        ...evBase, event_type: 'generation_success', duration_ms: Date.now() - t0,
        input_tokens: out.usage.input_tokens ?? null, output_tokens: out.usage.output_tokens ?? null,
        error_reason: color && !color.ref ? 'no swatch image for colour — generated without colour reference' : null,
      });
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      job.info = { durationMs: Date.now() - t0 };
      console.error('[wig-tryon] generation failed:', e.message);
      await store.logEvent({ ...evBase, event_type: 'generation_failed', duration_ms: Date.now() - t0, error_reason: e.message });
      if (ctx.usageDate) await store.refundQuota({ customerId: ctx.customerId, ipHash: ctx.ipHash, usageDate: ctx.usageDate });
    }
  })();

  return id;
}

// ─── Checked selfies waiting for generation (memory only) ──────────────────
// After the selfie check passes, the photo waits here (SELFIE_TTL_MS after last use) and
// /generate refers to it by selfieId — so the customer uploads once and a
// generation can only start from a selfie that passed the check.
const selfies = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, x] of selfies) if (now - x.createdAt > SELFIE_TTL_MS) selfies.delete(id);
}, 60 * 1000).unref();

function putSelfie(selfie, ownerKey) {
  const id = crypto.randomUUID();
  selfies.set(id, { ...selfie, ownerKey, createdAt: Date.now() });
  return id;
}
// "Try another" (Hera 2026-11-05) re-uses the same checked selfie with
// another colour, so a selfie is NOT removed when used: it stays until the
// customer removes it (discardSelfie) or SELFIE_TTL_MS after its last use. Closing the
// window no longer removes it (2026-11-05: kept for other wigs in the same visit).
function takeSelfie(id, ownerKey) {
  const x = selfies.get(String(id || ''));
  if (!x || x.ownerKey !== ownerKey) return null;
  x.createdAt = Date.now();
  return { buffer: x.buffer, mime: x.mime };
}
// Still there for this owner? (also counts as a use: restarts the 30 minutes)
function hasSelfie(id, ownerKey) {
  const x = selfies.get(String(id || ''));
  if (!x || x.ownerKey !== ownerKey || Date.now() - x.createdAt > SELFIE_TTL_MS) return false;
  x.createdAt = Date.now();
  return true;
}
function discardSelfie(id, ownerKey) {
  const x = selfies.get(String(id || ''));
  if (x && x.ownerKey === ownerKey) selfies.delete(String(id));
}

// Selfie checks per owner per day (memory; resets on restart — only a cost guard).
const checkCounts = new Map(); // `${date}|${owner}` -> n
function countCheck(date, ownerKey, max) {
  const k = `${date}|${ownerKey}`;
  const n = (checkCounts.get(k) || 0) + 1;
  if (n > max) return false;
  checkCounts.set(k, n);
  if (checkCounts.size > 50000) for (const key of checkCounts.keys()) if (!key.startsWith(`${date}|`)) checkCounts.delete(key);
  return true;
}

// Runs the selfie check. Returns { suitable, reason, note, usage, durationMs, error? }.
// When the check is switched off: always suitable. When the check call fails:
// suitable if failOpen, otherwise rejected with reason 'check_failed'.
async function runSelfieCheck(config, selfie) {
  const check = config.selfieCheck;
  if (!check.enabled) return { suitable: true, reason: 'ok', note: 'check switched off', usage: {}, durationMs: 0, skipped: true };
  const t0 = Date.now();
  try {
    const r = await checkSelfie({ image: selfie, check, reasons: store.SELFIE_REASONS });
    return { ...r, durationMs: Date.now() - t0 };
  } catch (e) {
    console.error('[wig-tryon] selfie check failed:', e.message);
    return { suitable: !!check.failOpen, reason: check.failOpen ? 'ok' : 'check_failed', note: `check error: ${e.message}`, usage: {}, durationMs: Date.now() - t0, error: e.message };
  }
}

module.exports = {
  putSelfie, takeSelfie, hasSelfie, discardSelfie, countCheck, runSelfieCheck,
  getProduct, searchProducts, colorValues, colorReference, decodeSelfie,
  prepare, startJob, getJob, MAX_SELFIE_BYTES,
};
