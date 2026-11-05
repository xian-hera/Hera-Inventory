// Online › Wig Try-on (2026-11-04, Hera). Spec: claude/WIG_TRYON_FEATURE_SPEC.md.
//
// Two routers:
//  - adminRouter  -> /api/wig-tryon        Hub pages (behind the usual /api session middleware)
//  - proxyRouter  -> /proxy/wig-tryon      storefront, reached ONLY through the Shopify
//                                          App Proxy (herabeauty.ca/apps/hera-tryon/*).
//    Every proxy request must carry Shopify's HMAC `signature`; the logged-in
//    customer comes from Shopify's `logged_in_customer_id`, never from the browser.
const express = require('express');
const crypto = require('crypto');
const store = require('../services/wigTryonStore');
const tryon = require('../services/wigTryon');
const { queueState } = require('../services/wigTryonOpenAI');
const { syncTryonMetafield } = require('../services/wigTryonShopify');
const { gql } = require('../services/shopifyGql');
const { getSetting } = require('../services/productData');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const errMsg = (e) => (e && e.message) || 'Something went wrong';

// Logs one selfie check as selfie_accepted / selfie_rejected (reason code in
// error_reason, the model's short note in detail).
async function logCheck(ctx, config, check) {
  await store.logEvent({
    source: ctx.source, event_type: check.suitable ? 'selfie_accepted' : 'selfie_rejected',
    session_id: ctx.sessionId, customer_id: ctx.customerId, ip_hash: ctx.ipHash,
    product_id: ctx.product ? ctx.product.numericId : ctx.productId, product_title: ctx.product ? ctx.product.title : null,
    vendor: ctx.product ? ctx.product.vendor : null, color_name: ctx.colorName,
    model: check.skipped ? null : config.selfieCheck.model, duration_ms: check.durationMs,
    input_tokens: check.usage && check.usage.input_tokens, output_tokens: check.usage && check.usage.output_tokens,
    error_reason: check.suitable ? (check.error ? 'check_error_allowed' : null) : check.reason,
    detail: check.note,
  });
}

// ═══════════════════════════════ Admin ═══════════════════════════════════════
const adminRouter = express.Router();

adminRouter.get('/config', async (req, res) => {
  try {
    const config = await store.getConfig();
    const active = await store.getActivePrompt(config);
    res.json({
      config,
      activePromptVersion: active ? active.version : null,
      today: await store.todayUsage(),
      hasApiKey: !!process.env.OPENAI_API_KEY,
      lastSync: await getSetting('wig_tryon_last_sync', null),
      defaults: { checkPrompt: store.DEFAULT_CHECK_PROMPT },
      queue: queueState(),
    });
  } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

// Every save also rewrites the storefront metafield (hera_tryon.config).
// A sync failure does not undo the save: { synced: false, syncError }.
adminRouter.put('/config', async (req, res) => {
  let config;
  try {
    config = await store.saveConfig(req.body || {});
  } catch (e) { return res.status(400).json({ error: errMsg(e) }); }
  try {
    const s = await syncTryonMetafield(config);
    res.json({ config, synced: true, syncedAt: s.syncedAt });
  } catch (e) {
    console.error('[wig-tryon] metafield sync failed:', e.message);
    res.json({ config, synced: false, syncError: errMsg(e) });
  }
});

adminRouter.post('/sync', async (req, res) => {
  try { res.json(await syncTryonMetafield()); } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

// GET /files?q= -> images in Content › Files (for the storefront icon).
adminRouter.get('/files', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const d = await gql(`query($q: String) {
      files(first: 60, query: $q, sortKey: CREATED_AT, reverse: true) {
        nodes { id createdAt ... on GenericFile { url mimeType } ... on MediaImage { mimeType image { url } } }
      }
    }`, { q: q || null });
    const files = (d.files.nodes || [])
      .map(n => ({ id: n.id, mimeType: n.mimeType, url: n.url || (n.image && n.image.url) || null }))
      .filter(f => f.url && (/^image\//i.test(f.mimeType || '') || /\.(svg|png|jpe?g|webp|gif)(\?|$)/i.test(f.url)))
      .map(f => ({ ...f, filename: decodeURIComponent(f.url.split('?')[0].split('/').pop()) }));
    res.json({ files });
  } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

adminRouter.get('/prompts', async (req, res) => {
  try {
    const config = await store.getConfig();
    const prompts = await store.listPrompts();
    const active = await store.getActivePrompt(config);
    res.json({ prompts, activeVersion: active ? active.version : null, pinned: config.activePromptVersion, defaultPrompt: store.DEFAULT_PROMPT });
  } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

// Save as a new version. { template, note, activate }
adminRouter.post('/prompts', async (req, res) => {
  try {
    const p = await store.addPrompt(req.body.template, req.body.note);
    if (req.body.activate) await store.saveConfig({ activePromptVersion: p.version });
    res.json({ prompt: p });
  } catch (e) { res.status(400).json({ error: errMsg(e) }); }
});

adminRouter.post('/prompts/:version/activate', async (req, res) => {
  try {
    const config = await store.saveConfig({ activePromptVersion: parseInt(req.params.version, 10) });
    res.json({ activeVersion: config.activePromptVersion });
  } catch (e) { res.status(400).json({ error: errMsg(e) }); }
});

adminRouter.get('/products', async (req, res) => {
  try {
    const config = await store.getConfig();
    res.json({ products: await tryon.searchProducts(config, req.query.q || '') });
  } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

adminRouter.get('/products/:id', async (req, res) => {
  try {
    const product = await tryon.getProduct(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const { optionName, values } = await tryon.colorValues(product);
    const colors = [];
    for (const v of values) {
      const ref = await tryon.colorReference(product.vendor, v);
      colors.push({ name: v, swatchUrl: ref ? ref.url : null });
    }
    res.json({ product, colorOption: optionName, colors });
  } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

// Admin selfie check only — to tune the check prompt cheaply. { selfie } -> check result.
adminRouter.post('/check', async (req, res) => {
  try {
    const config = await store.getConfig();
    const selfie = tryon.decodeSelfie((req.body || {}).selfie);
    const check = await tryon.runSelfieCheck({ ...config, selfieCheck: { ...config.selfieCheck, enabled: true } }, selfie);
    await logCheck({ source: 'admin_test' }, config, check);
    res.json({ check });
  } catch (e) { res.status(400).json({ error: errMsg(e) }); }
});

// Admin test generation — never touches quotas, logged as source 'admin_test'.
// { productId, colorName?, selfie (base64), template? (unsaved draft) | promptVersion?,
//   runCheck? (default true: run the selfie check first, like the storefront) }
// Product photo = the product's first image, same as the storefront.
adminRouter.post('/test', async (req, res) => {
  try {
    const config = await store.getConfig();
    const b = req.body || {};
    let promptTemplate; let promptVersion = null;
    if (b.template && String(b.template).trim()) {
      promptTemplate = String(b.template);
    } else {
      const p = b.promptVersion ? await store.getPrompt(parseInt(b.promptVersion, 10)) : await store.getActivePrompt(config);
      if (!p) return res.status(400).json({ error: 'Prompt version not found' });
      promptTemplate = p.template; promptVersion = p.version;
    }
    const selfie = tryon.decodeSelfie(b.selfie);
    const prepared = await tryon.prepare({ config, productId: b.productId, colorName: b.colorName || null, requireEligible: false });
    let check = null;
    if (b.runCheck !== false) {
      check = await tryon.runSelfieCheck({ ...config, selfieCheck: { ...config.selfieCheck, enabled: true } }, selfie);
      await logCheck({ source: 'admin_test', product: prepared.product, colorName: prepared.color && prepared.color.name }, config, check);
      if (!check.suitable) return res.json({ rejected: true, check });
    }
    // Optional per-test model / quality override, so settings can be compared without saving them.
    const runConfig = { ...config, openai: { ...config.openai, ...(b.openai || {}) } };
    const jobId = tryon.startJob({
      config: runConfig, prepared, selfie,
      ctx: { source: 'admin_test', ownerKey: 'admin', promptTemplate, promptVersion },
    });
    res.json({ jobId, check, colorMissingImage: !!(prepared.color && !prepared.color.ref) });
  } catch (e) { res.status(400).json({ error: errMsg(e) }); }
});

adminRouter.get('/jobs/:id', (req, res) => {
  const job = tryon.getJob(req.params.id, 'admin');
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  if (job.status === 'running') return res.json({ status: 'running', elapsedMs: Date.now() - job.createdAt });
  if (job.status === 'failed') return res.json({ status: 'failed', error: job.error, info: job.info });
  res.json({ status: 'done', image: `data:${job.result.mime};base64,${job.result.b64}`, info: job.info });
});

adminRouter.get('/stats', async (req, res) => {
  try {
    const config = await store.getConfig();
    const today = await store.todayString();
    const from = isDate(req.query.from) ? req.query.from : today;
    const to = isDate(req.query.to) ? req.query.to : today;
    const source = req.query.source === 'admin_test' ? 'admin_test' : 'storefront';
    res.json(await store.getStats(config, { from, to, source }));
  } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

adminRouter.get('/events', async (req, res) => {
  try {
    const q = req.query;
    res.json(await store.listEvents({
      from: isDate(q.from) ? q.from : null,
      to: isDate(q.to) ? q.to : null,
      source: ['storefront', 'admin_test'].includes(q.source) ? q.source : null,
      type: q.type ? String(q.type) : null,
      q: q.q ? String(q.q).slice(0, 100) : null,
      page: q.page, pageSize: q.pageSize,
    }));
  } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

// ═══════════════════════════════ App Proxy ═══════════════════════════════════
const proxyRouter = express.Router();

// Shopify app proxy signature (shopify.dev › App proxies › Authenticate):
// drop `signature`, join array values with ",", "key=value" pairs sorted and
// concatenated with no separator, HMAC-SHA256 with the app secret, hex.
function verifyProxySignature(rawQuery, secret) {
  const params = new URLSearchParams(rawQuery || '');
  const sig = params.get('signature');
  if (!sig || !secret) return false;
  const grouped = {};
  for (const [k, v] of params) {
    if (k === 'signature') continue;
    (grouped[k] = grouped[k] || []).push(v);
  }
  const message = Object.keys(grouped).map(k => `${k}=${grouped[k].join(',')}`).sort().join('');
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(sig), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MAX_SKEW_SEC = 300;

proxyRouter.use((req, res, next) => {
  const raw = (req.originalUrl.split('?')[1]) || '';
  if (!verifyProxySignature(raw, process.env.SHOPIFY_API_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const ts = parseInt(req.query.timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SEC) {
    return res.status(401).json({ error: 'Expired request' });
  }
  if (process.env.SHOP && req.query.shop && req.query.shop !== process.env.SHOP) {
    return res.status(401).json({ error: 'Wrong shop' });
  }
  const cid = String(req.query.logged_in_customer_id || '').replace(/\D/g, '');
  req.customerId = cid || null;
  // Shopify sets X-Forwarded-For to the customer's IP; Render appends its own
  // hops after it, so the first entry is the customer.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  req.ipHash = store.hashIp(xff || req.ip);
  req.lang = /^fr/i.test(String((req.body && req.body.locale) || req.query.locale || '')) ? 'fr' : 'en';
  res.set('Cache-Control', 'no-store');
  next();
});

const msg = (config, key, lang) => {
  const t = config.text[key] || {};
  return t[lang] || t.en || '';
};

// Who may read a job: the logged-in customer (IP may change between Wi-Fi and
// mobile data while polling), or the IP when nobody is logged in.
const ownerOf = (req) => (req.customerId ? `c:${req.customerId}` : `i:${req.ipHash || ''}`);

const BLOCK_EVENT = { account: 'blocked_account_limit', ip: 'blocked_ip_limit', global: 'blocked_global_limit' };
// Account and IP limits show the SAME text on purpose (spec §5).
const blockMessage = (config, layer, lang) => msg(config, layer === 'global' ? 'busy' : 'limitReached', lang);

// GET /status?product_id=…  — is the button usable right now, for this visitor?
proxyRouter.get('/status', async (req, res) => {
  try {
    const config = await store.getConfig();
    const out = {
      enabled: store.isOn(config),
      requireLogin: config.requireLogin,
      loggedIn: !!req.customerId,
      colorEnabled: config.colorEnabled,
      eligible: null,
      quota: null,
      remaining: null,
    };
    if (!store.isOn(config)) return res.json(out);
    if (req.query.product_id) {
      const p = await tryon.getProduct(req.query.product_id).catch(() => null);
      out.eligible = !!(p && store.isEligibleType(config, p.productType));
    }
    if (config.requireLogin && !req.customerId) {
      out.quota = { ok: false, code: 'login_required', message: msg(config, 'loginRequired', req.lang) };
    } else {
      const q = await store.checkQuota(config, { customerId: req.customerId, ipHash: req.ipHash });
      out.remaining = (await store.remaining(config, { customerId: req.customerId, ipHash: req.ipHash })).left;
      out.quota = q.ok ? { ok: true } : { ok: false, code: q.layer === 'global' ? 'busy' : 'limit', message: blockMessage(config, q.layer, req.lang) };
      // Only the pre-camera check logs a block (spec §3 step 6); plain page loads don't.
      if (!q.ok && req.query.check === 'precamera') {
        await store.logEvent({ event_type: BLOCK_EVENT[q.layer], session_id: req.query.session_id, customer_id: req.customerId, ip_hash: req.ipHash, product_id: req.query.product_id });
      }
    }
    res.json(out);
  } catch (e) {
    console.error('[wig-tryon] status:', e.message);
    res.status(500).json({ error: 'Service unavailable' });
  }
});

// POST /event { event_type, session_id, product_id?, color_name? } — funnel steps
// the browser sees (button_click is logged even when not logged in).
proxyRouter.post('/event', async (req, res) => {
  const b = req.body || {};
  if (!store.CLIENT_EVENTS.includes(b.event_type)) return res.status(400).json({ error: 'Unknown event' });
  await store.logEvent({
    event_type: b.event_type, session_id: b.session_id, customer_id: req.customerId, ip_hash: req.ipHash,
    product_id: b.product_id ? String(b.product_id).replace(/\D/g, '') : null, color_name: b.color_name,
  });
  res.json({ ok: true });
});

// POST /check-selfie { selfie (base64), product_id, color_name?, session_id, locale }
// Step after consent: the API checks the selfie is usable (one person, face
// visible, whole head in frame, sharp…). Passing photos wait in memory and
// /generate uses them by selfieId. A check does NOT use a try-on; it has its
// own daily cap (Settings › Selfie check › max per day).
proxyRouter.post('/check-selfie', async (req, res) => {
  const b = req.body || {};
  let config;
  try {
    config = await store.getConfig();
    if (!store.isOn(config)) return res.status(403).json({ code: 'disabled', message: msg(config, 'busy', req.lang) });
    if (config.requireLogin && !req.customerId) {
      return res.status(401).json({ code: 'login_required', message: msg(config, 'loginRequired', req.lang) });
    }
    const who = { customerId: req.customerId, ipHash: req.ipHash };
    const productId = b.product_id ? String(b.product_id).replace(/\D/g, '') : null;
    // No point checking a photo when no try-on is left today.
    const q = await store.checkQuota(config, who);
    if (!q.ok) {
      await store.logEvent({ event_type: BLOCK_EVENT[q.layer], session_id: b.session_id, customer_id: who.customerId, ip_hash: who.ipHash, product_id: productId });
      return res.status(429).json({ code: q.layer === 'global' ? 'busy' : 'limit', message: blockMessage(config, q.layer, req.lang) });
    }
    if (!tryon.countCheck(await store.todayString(), ownerOf(req), config.selfieCheck.maxPerDay)) {
      return res.status(429).json({ code: 'limit', message: msg(config, 'limitReached', req.lang) });
    }
    let selfie;
    try { selfie = tryon.decodeSelfie(b.selfie); } catch (e) {
      return res.status(400).json({ code: 'bad_photo', message: msg(config, 'badPhoto', req.lang) });
    }
    const ctx = { source: 'storefront', sessionId: b.session_id, customerId: who.customerId, ipHash: who.ipHash, productId, colorName: b.color_name || null };
    await store.logEvent({ event_type: 'selfie_submitted', session_id: b.session_id, customer_id: who.customerId, ip_hash: who.ipHash, product_id: productId, color_name: ctx.colorName });
    const check = await tryon.runSelfieCheck(config, selfie);
    await logCheck(ctx, config, check);
    if (!check.suitable) {
      const t = config.selfieText[check.reason];
      const message = t ? (t[req.lang] || t.en) : msg(config, 'failed', req.lang);
      return res.json({ ok: false, code: 'selfie_rejected', reason: check.reason, message });
    }
    res.json({ ok: true, selfieId: tryon.putSelfie(selfie, ownerOf(req)) });
  } catch (e) {
    console.error('[wig-tryon] check-selfie:', e.message);
    res.status(500).json({ code: 'error', message: config ? msg(config, 'failed', req.lang) : 'Error' });
  }
});

// POST /generate { product_id, color_name?, selfie_id, session_id, locale }
// Product photo = the product's first image. Uses one try-on (refunded if the
// generation fails on our / OpenAI's side).
proxyRouter.post('/generate', async (req, res) => {
  const b = req.body || {};
  let config;
  try {
    config = await store.getConfig();
    if (!store.isOn(config)) return res.status(403).json({ code: 'disabled', message: msg(config, 'busy', req.lang) });
    if (config.requireLogin && !req.customerId) {
      return res.status(401).json({ code: 'login_required', message: msg(config, 'loginRequired', req.lang) });
    }

    let prepared;
    try {
      prepared = await tryon.prepare({
        config, productId: b.product_id,
        colorName: config.colorEnabled && b.color_name ? b.color_name : null,
      });
    } catch (e) {
      return res.status(400).json({ code: 'bad_request', message: e.message });
    }

    const who = { customerId: req.customerId, ipHash: req.ipHash };
    const usageDate = await store.todayString();
    const q = await store.consumeQuota(config, who);
    if (!q.ok) {
      await store.logEvent({ event_type: BLOCK_EVENT[q.layer], session_id: b.session_id, customer_id: who.customerId, ip_hash: who.ipHash, product_id: prepared.product.numericId });
      return res.status(429).json({ code: q.layer === 'global' ? 'busy' : 'limit', message: blockMessage(config, q.layer, req.lang) });
    }
    // Only a selfie that passed /check-selfie, owned by this customer, used once.
    const selfie = tryon.takeSelfie(b.selfie_id, ownerOf(req));
    if (!selfie) {
      await store.refundQuota({ ...who, usageDate });
      return res.status(400).json({ code: 'selfie_expired', message: msg(config, 'selfieExpired', req.lang) });
    }
    store.maybeSendAlert(config, q.globalCount).catch(() => {});

    const prompt = await store.getActivePrompt(config);
    const jobId = tryon.startJob({
      config, prepared, selfie,
      ctx: {
        source: 'storefront', ownerKey: ownerOf(req),
        customerId: who.customerId, ipHash: who.ipHash, sessionId: b.session_id, usageDate,
        promptTemplate: prompt.template, promptVersion: prompt.version,
      },
    });
    const left = await store.remaining(config, who);
    res.json({ jobId, remaining: left.left });
  } catch (e) {
    console.error('[wig-tryon] generate:', e.message);
    res.status(500).json({ code: 'error', message: config ? msg(config, 'failed', req.lang) : 'Error' });
  }
});

// POST /discard-selfie { selfie_id } — the window was closed: forget the selfie now.
proxyRouter.post('/discard-selfie', (req, res) => {
  tryon.discardSelfie((req.body || {}).selfie_id, ownerOf(req));
  res.json({ ok: true });
});

// GET /jobs/:id — poll every few seconds. Only the same customer / IP can read it.
proxyRouter.get('/jobs/:id', async (req, res) => {
  const job = tryon.getJob(req.params.id, ownerOf(req));
  if (!job) return res.status(404).json({ status: 'expired' });
  if (job.status === 'running') return res.json({ status: 'running' });
  if (job.status === 'failed') {
    const config = await store.getConfig();
    return res.json({ status: 'failed', message: msg(config, 'failed', req.lang) });
  }
  res.json({ status: 'done', image: `data:${job.result.mime};base64,${job.result.b64}` });
});

module.exports = { adminRouter, proxyRouter, verifyProxySignature };
