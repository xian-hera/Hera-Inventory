// Online › Wig Try-on — settings, prompts, events, quotas, stats (2026-11-04, Hera).
// Spec: claude/WIG_TRYON_FEATURE_SPEC.md.
const crypto = require('crypto');
const { pool } = require('../database/init');
const { getSetting, setSetting } = require('./productData');

const CONFIG_KEY = 'wig_tryon_config';
const TZ = 'America/Toronto'; // same zone every Hub scheduler uses
const TODAY_SQL = `(NOW() AT TIME ZONE '${TZ}')::date`;

// ─── Default prompt (version 1 is created from this on first read) ──────────
// Placeholders: {{product_title}} {{color_name}} {{image_count}}
// Sections: {{#color}}…{{/color}} kept only when a colour reference image is
// sent; {{^color}}…{{/color}} kept only when it is not.
// Image order sent to OpenAI: 1 = product photo, 2 = selfie, 3 = colour reference.
const DEFAULT_PROMPT = `You are given {{image_count}} images.
Image 1: a product photo of a wig ("{{product_title}}"), usually worn by a model.
Image 2: a selfie of the customer.
{{#color}}Image 3: a close-up reference of the hair colour "{{color_name}}".
{{/color}}
Create one realistic photo of the customer from Image 2 wearing the wig from Image 1.
- Keep the customer's face exactly as in Image 2: identity, facial features, skin tone, expression and age. Do not beautify, slim, retouch or change makeup.
- Copy the wig from Image 1 faithfully: hairstyle, cut, length, parting, hairline, volume, curl or wave pattern and texture.
{{#color}}- Colour the wig to match Image 3 exactly (shade, highlights, roots, ombré). Ignore the colour shown in Image 1.
{{/color}}{{^color}}- Keep the wig's colour exactly as in Image 1.
{{/color}}- Fit the wig naturally to the customer's head and face shape. The customer's own hair must be fully hidden under the wig.
- Head-and-shoulders portrait, soft natural front lighting, plain light background, photorealistic. No text, no logos, no watermark.`;

// ─── Selfie check (2026-11-04, Hera: the API checks the selfie is usable;
// the product photo is no longer checked — it is always the product's FIRST image).
// The model must answer with one of these reason codes; the customer sees the
// EN / FR message for that code from config.selfieText, never the model's own words.
const SELFIE_REASONS = ['ok', 'no_person', 'multiple_people', 'face_not_visible', 'head_cut_off',
  'face_too_small', 'blurry_or_dark', 'not_a_real_photo', 'inappropriate'];

const DEFAULT_CHECK_PROMPT = `You check whether a customer's photo can be used for a virtual wig try-on. Another AI will keep this person's face and put a wig on their head, so the face and the whole head must be clearly visible.

The photo is suitable only if ALL of these are true:
- It is a real photo of exactly one real person (not a drawing, cartoon, screenshot, or a photo of a screen or printed picture).
- The face is clearly visible and roughly facing the camera (turned up to about 30 degrees is fine).
- The whole head, from the top of the hair (or head covering) to the chin, is inside the frame.
- The head is reasonably large: at least about a quarter of the image height.
- The photo is in focus and bright enough to see the facial features.
- Nothing covers the eyes, nose or mouth (sunglasses, mask, hand, phone, heavy filter or sticker). Normal clear glasses are fine. A wig cap, bonnet, headscarf, hat or the person's own hair are fine as long as the face is visible.
- No nudity or other inappropriate content.

If several problems exist, report the most important one. Use reason "ok" only when suitable is true.`;

const SELFIE_TEXT = {
  no_person: { en: "We couldn't find a person in this photo. Please upload a selfie.", fr: "Nous ne trouvons personne sur cette photo. Veuillez téléverser un selfie." },
  multiple_people: { en: 'Please use a photo with only you in it.', fr: "Veuillez utiliser une photo où vous êtes seule." },
  face_not_visible: { en: 'Please use a photo where your face is clearly visible and facing the camera, without sunglasses or a mask.', fr: "Veuillez utiliser une photo où votre visage est bien visible, face à l'appareil, sans lunettes de soleil ni masque." },
  head_cut_off: { en: 'Please make sure your whole head, from the top of your hair to your chin, is in the photo.', fr: 'Assurez-vous que toute votre tête, du haut des cheveux au menton, est dans la photo.' },
  face_too_small: { en: 'Your face is too small in this photo. Please take a closer selfie.', fr: 'Votre visage est trop petit sur cette photo. Veuillez prendre un selfie plus rapproché.' },
  blurry_or_dark: { en: 'This photo is too blurry or too dark. Please take a clear photo in good light.', fr: 'Cette photo est trop floue ou trop sombre. Veuillez prendre une photo nette avec un bon éclairage.' },
  not_a_real_photo: { en: 'Please upload a real photo of yourself (not a drawing or a screenshot).', fr: "Veuillez téléverser une vraie photo de vous (pas un dessin ni une capture d'écran)." },
  inappropriate: { en: 'This photo cannot be used. Please upload a different selfie.', fr: 'Cette photo ne peut pas être utilisée. Veuillez téléverser un autre selfie.' },
};

const DEFAULT_CONFIG = {
  // Storefront switch (same three steps as Swatch, 2026-11-05):
  // 'off' = icon never shown; 'preview' = only in the theme editor and on
  // *.shopifypreview.com (test on a duplicated theme); 'live' = real store.
  // The app proxy answers in 'preview' and 'live' (it can't tell the two apart).
  mode: 'off',
  requireLogin: true,             // spec §3 step 2 (can be turned off while testing)
  eligibleTypes: ['WIG'],         // product types (case-insensitive)
  // Colour choice is part of the customer flow (Hera 2026-11-04: click → choose
  // colour → consent → selfie). Switch kept only to turn it off if needed.
  colorEnabled: true,
  activePromptVersion: null,      // null = latest version
  openai: {
    model: 'gpt-image-2',
    size: '1024x1536',
    quality: 'medium',
    outputFormat: 'jpeg',
    inputFidelity: '',            // '' = omit (gpt-image-2 must omit it)
    timeoutSec: 180,
    retries: 1,
    maxConcurrent: 3,
  },
  // Selfie check before generating (Responses API, vision model, JSON answer).
  // failOpen: if the check itself errors (OpenAI down / timeout), let the
  // customer continue instead of blocking them.
  selfieCheck: {
    enabled: true,
    model: 'gpt-6-luna',
    reasoningEffort: 'low',       // '' = not sent
    detail: 'auto',               // image detail: low | high | auto
    timeoutSec: 45,
    maxPerDay: 15,                // checks per customer (or IP when not logged in) per day
    failOpen: true,
    prompt: DEFAULT_CHECK_PROMPT,
  },
  // Storefront widget (App embed "Hera Wig Try-on", Hera's mock-ups 2026-11-05).
  // Synced to the app-data metafield hera_tryon.config on every save.
  storefront: {
    iconFile: null,               // { filename, url } from Shopify Files; null = built-in icon
    iconSize: 48,                 // px, square
    iconOffset: 12,               // px from the top-left corner of the product photo
    privacyUrl: '/policies/privacy-policy',
    proxyPath: '/apps/hera-tryon',
    gallerySelector: 'media-gallery[id$="__main"] .product__media-gallery-viewer-wrap',
  },
  // Widget texts, EN / FR.
  ui: {
    titleSuffix: { en: 'Try on', fr: 'Essayage' },
    leftToday: { en: 'try-ons left today', fr: "essais restants aujourd'hui" },
    chooseColor: { en: 'Choose color', fr: 'Choisir la couleur' },
    uploadSelfie: { en: 'Upload selfie', fr: 'Téléverser un selfie' },
    consentBefore: { en: 'To use AI try on, I agree to', fr: "Pour utiliser l'essayage IA, j'accepte la" },
    consentLink: { en: 'Privacy Policy', fr: 'Politique de confidentialité' },
    consentAfter: { en: 'of Hera Beauté.', fr: 'de Hera Beauté.' },
    requirements: { en: 'Face the camera in good light. Your whole head and hairline should be visible — no sunglasses, mask or hat covering your face.', fr: "Regardez l'appareil avec un bon éclairage. Toute votre tête doit être visible — sans lunettes de soleil, masque ni chapeau devant le visage." },
    description: { en: 'Your photo is only used to create try-on images. It is kept during this visit so you can try other wigs without uploading again, and deleted at the latest 30 minutes after your last try-on. The result is an AI preview; the real wig may look slightly different.', fr: "Votre photo sert uniquement à créer les images d'essayage. Elle est conservée pendant cette visite pour essayer d'autres perruques sans la téléverser de nouveau, puis supprimée au plus tard 30 minutes après votre dernier essai. Le résultat est un aperçu IA ; la perruque réelle peut être légèrement différente." },
    changePhoto: { en: 'Change photo', fr: 'Changer de photo' },
    removePhoto: { en: 'Remove photo', fr: 'Supprimer la photo' },
    tryButton: { en: 'Try it out!', fr: "Essayer !" },
    checking: { en: 'Checking your photo…', fr: 'Vérification de votre photo…' },
    selfieOk: { en: 'Photo looks good!', fr: 'La photo est parfaite !' },
    consentFirst: { en: 'Please accept the Privacy Policy first.', fr: "Veuillez d'abord accepter la politique de confidentialité." },
    chooseColorFirst: { en: 'Please choose a color.', fr: 'Veuillez choisir une couleur.' },
    uploadFirst: { en: 'Please upload a selfie.', fr: 'Veuillez téléverser un selfie.' },
    loading: { en: 'Your photo is being loaded\nPlease stay on this page', fr: 'Votre photo est en cours de création\nVeuillez rester sur cette page' },
    savePhoto: { en: 'Save photo', fr: 'Enregistrer' },
    tryAnother: { en: 'Try another', fr: 'Essayer une autre' },
    iconLabel: { en: 'AI wig try-on', fr: 'Essayage de perruque IA' },
  },
  // USD per 1M tokens, used only for the cost estimate on Overview.
  // Empty = no estimate (fill in from OpenAI's pricing page).
  pricing: { inputTextPerM: null, inputImagePerM: null, outputImagePerM: null },
  limits: {
    perCustomer: 3,
    perIp: 10,                    // keep higher than perCustomer (shared networks)
    globalDaily: 100,
    alertPct: 80,
  },
  // Customer-facing messages (EN / FR). Same text for account and IP limits
  // on purpose (spec §5) — never reveal which layer blocked.
  text: {
    limitReached: { en: "You've used all your try-ons for today. Please come back tomorrow.", fr: "Vous avez utilisé tous vos essais aujourd'hui. Revenez demain." },
    busy: { en: 'The AI try-on service is busy right now. Please try again later.', fr: "Le service d'essayage IA est très sollicité en ce moment. Veuillez réessayer plus tard." },
    loginRequired: { en: 'Please log in to use AI Try-On.', fr: "Veuillez vous connecter pour utiliser l'essayage IA." },
    failed: { en: 'Sorry, we could not create your try-on image. Please try again.', fr: "Désolé, nous n'avons pas pu créer votre image. Veuillez réessayer." },
    badPhoto: { en: 'Please upload a JPEG or PNG photo (max 10 MB).', fr: 'Veuillez téléverser une photo JPEG ou PNG (10 Mo maximum).' },
    selfieExpired: { en: 'Your photo has expired. Please upload it again.', fr: 'Votre photo a expiré. Veuillez la téléverser de nouveau.' },
  },
};

function mergeConfig(saved) {
  const s = saved || {};
  const text = {};
  for (const k of Object.keys(DEFAULT_CONFIG.text)) text[k] = { ...DEFAULT_CONFIG.text[k], ...((s.text || {})[k] || {}) };
  const ui = {};
  for (const k of Object.keys(DEFAULT_CONFIG.ui)) ui[k] = { ...DEFAULT_CONFIG.ui[k], ...((s.ui || {})[k] || {}) };
  // 'enabled' (first version) -> 'mode'
  let mode = s.mode;
  if (!['off', 'preview', 'live'].includes(mode)) mode = s.enabled === true ? 'live' : 'off';
  const selfieText = {};
  for (const k of Object.keys(SELFIE_TEXT)) selfieText[k] = { ...SELFIE_TEXT[k], ...((s.selfieText || {})[k] || {}) };
  return {
    ...DEFAULT_CONFIG,
    ...s,
    eligibleTypes: Array.isArray(s.eligibleTypes) ? s.eligibleTypes : DEFAULT_CONFIG.eligibleTypes,
    openai: { ...DEFAULT_CONFIG.openai, ...(s.openai || {}) },
    pricing: { ...DEFAULT_CONFIG.pricing, ...(s.pricing || {}) },
    limits: { ...DEFAULT_CONFIG.limits, ...(s.limits || {}) },
    selfieCheck: { ...DEFAULT_CONFIG.selfieCheck, ...(s.selfieCheck || {}) },
    storefront: { ...DEFAULT_CONFIG.storefront, ...(s.storefront || {}) },
    text,
    selfieText,
    ui,
    mode,
  };
}

async function getConfig() {
  return mergeConfig(await getSetting(CONFIG_KEY, null));
}

function toInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function toPrice(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function saveConfig(patch) {
  const cur = await getConfig();
  const p = patch || {};
  const next = mergeConfig({
    ...cur, ...p,
    openai: { ...cur.openai, ...(p.openai || {}) },
    pricing: { ...cur.pricing, ...(p.pricing || {}) },
    limits: { ...cur.limits, ...(p.limits || {}) },
    selfieCheck: { ...cur.selfieCheck, ...(p.selfieCheck || {}) },
    storefront: { ...cur.storefront, ...(p.storefront || {}) },
    ui: Object.fromEntries(Object.keys(cur.ui).map(k => [k, { ...cur.ui[k], ...((p.ui || {})[k] || {}) }])),
    selfieText: Object.fromEntries(Object.keys(cur.selfieText).map(k => [k, { ...cur.selfieText[k], ...((p.selfieText || {})[k] || {}) }])),
    text: Object.fromEntries(Object.keys(cur.text).map(k => [k, { ...cur.text[k], ...((p.text || {})[k] || {}) }])),
  });
  // sanitise
  delete next.enabled;
  const sf = next.storefront;
  const cleanPath = (v, d) => { const x = String(v || '').trim(); return /^\/[A-Za-z0-9/_\-.]*$/.test(x) ? x : d; };
  next.storefront = {
    iconFile: sf.iconFile && sf.iconFile.filename ? { filename: String(sf.iconFile.filename), url: String(sf.iconFile.url || '') } : null,
    iconSize: toInt(sf.iconSize, 24, 120, 48),
    iconOffset: toInt(sf.iconOffset, 0, 60, 12),
    privacyUrl: /^(https:\/\/|\/)[^\s"'<>]*$/.test(String(sf.privacyUrl || '').trim()) ? String(sf.privacyUrl).trim() : DEFAULT_CONFIG.storefront.privacyUrl,
    proxyPath: cleanPath(sf.proxyPath, DEFAULT_CONFIG.storefront.proxyPath),
    // CSS selector: no braces / angle brackets so it can't break out of the <style> tag
    gallerySelector: /^[^{}<>]{1,300}$/.test(String(sf.gallerySelector || '')) ? String(sf.gallerySelector).trim() : DEFAULT_CONFIG.storefront.gallerySelector,
  };
  next.requireLogin = !!next.requireLogin;
  next.colorEnabled = !!next.colorEnabled;
  next.eligibleTypes = [...new Set((next.eligibleTypes || []).map(t => String(t).trim()).filter(Boolean))];
  next.openai.model = String(next.openai.model || '').trim() || DEFAULT_CONFIG.openai.model;
  next.openai.timeoutSec = toInt(next.openai.timeoutSec, 30, 600, 180);
  next.openai.retries = toInt(next.openai.retries, 0, 3, 1);
  next.openai.maxConcurrent = toInt(next.openai.maxConcurrent, 1, 10, 3);
  if (!['', 'low', 'high'].includes(next.openai.inputFidelity)) next.openai.inputFidelity = '';
  if (!['jpeg', 'png', 'webp'].includes(next.openai.outputFormat)) next.openai.outputFormat = 'jpeg';
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(next.openai.quality)) next.openai.quality = 'medium';
  next.pricing = {
    inputTextPerM: toPrice(next.pricing.inputTextPerM),
    inputImagePerM: toPrice(next.pricing.inputImagePerM),
    outputImagePerM: toPrice(next.pricing.outputImagePerM),
  };
  next.limits = {
    perCustomer: toInt(next.limits.perCustomer, 0, 1000, 3),
    perIp: toInt(next.limits.perIp, 0, 10000, 10),
    globalDaily: toInt(next.limits.globalDaily, 0, 100000, 100),
    alertPct: toInt(next.limits.alertPct, 1, 100, 80),
  };
  const sc = next.selfieCheck;
  next.selfieCheck = {
    enabled: !!sc.enabled,
    model: String(sc.model || '').trim() || DEFAULT_CONFIG.selfieCheck.model,
    reasoningEffort: ['', 'none', 'minimal', 'low', 'medium', 'high'].includes(sc.reasoningEffort) ? sc.reasoningEffort : 'low',
    detail: ['low', 'high', 'auto'].includes(sc.detail) ? sc.detail : 'auto',
    timeoutSec: toInt(sc.timeoutSec, 5, 120, 45),
    maxPerDay: toInt(sc.maxPerDay, 1, 1000, 15),
    failOpen: !!sc.failOpen,
    prompt: String(sc.prompt || '').trim() || DEFAULT_CHECK_PROMPT,
  };
  if (next.activePromptVersion !== null) {
    const v = toInt(next.activePromptVersion, 1, 1e9, null);
    const ok = v && (await pool.query('SELECT 1 FROM wig_tryon_prompts WHERE version = $1', [v])).rows.length;
    if (!ok) throw new Error(`Prompt version ${next.activePromptVersion} does not exist`);
    next.activePromptVersion = v;
  }
  await setSetting(CONFIG_KEY, next);
  return next;
}

function isEligibleType(config, productType) {
  const t = String(productType || '').trim().toUpperCase();
  return !!t && (config.eligibleTypes || []).some(x => String(x).trim().toUpperCase() === t);
}

// ─── Prompts (versioned, never edited in place) ─────────────────────────────
async function ensureFirstPrompt() {
  const r = await pool.query('SELECT 1 FROM wig_tryon_prompts LIMIT 1');
  if (!r.rows.length) {
    await pool.query(
      `INSERT INTO wig_tryon_prompts (version, template, note) VALUES (1, $1, 'Initial draft (Claude)') ON CONFLICT DO NOTHING`,
      [DEFAULT_PROMPT]);
  }
}

async function listPrompts() {
  await ensureFirstPrompt();
  const r = await pool.query(`
    SELECT p.*,
      (SELECT COUNT(*)::int FROM wig_tryon_events e WHERE e.prompt_version = p.version AND e.event_type = 'generation_success') AS success_count,
      (SELECT COUNT(*)::int FROM wig_tryon_events e WHERE e.prompt_version = p.version AND e.event_type = 'generation_failed') AS failed_count
    FROM wig_tryon_prompts p ORDER BY p.version DESC`);
  return r.rows;
}

async function addPrompt(template, note) {
  const t = String(template || '').trim();
  if (!t) throw new Error('Prompt is empty');
  if (t.length > 20000) throw new Error('Prompt is too long');
  await ensureFirstPrompt();
  // MAX+1 inside one statement; PRIMARY KEY guards against a race.
  const r = await pool.query(`
    INSERT INTO wig_tryon_prompts (version, template, note)
    SELECT COALESCE(MAX(version), 0) + 1, $1, $2 FROM wig_tryon_prompts
    RETURNING *`, [t, note ? String(note).slice(0, 500) : null]);
  return r.rows[0];
}

// The prompt the storefront uses: activePromptVersion, or the latest one.
async function getActivePrompt(config) {
  await ensureFirstPrompt();
  if (config.activePromptVersion) {
    const r = await pool.query('SELECT * FROM wig_tryon_prompts WHERE version = $1', [config.activePromptVersion]);
    if (r.rows.length) return r.rows[0];
  }
  const r = await pool.query('SELECT * FROM wig_tryon_prompts ORDER BY version DESC LIMIT 1');
  return r.rows[0];
}

async function getPrompt(version) {
  const r = await pool.query('SELECT * FROM wig_tryon_prompts WHERE version = $1', [version]);
  return r.rows[0] || null;
}

// {{name}} placeholders + {{#color}}/{{^color}} sections.
function renderPrompt(template, vars) {
  const hasColor = !!vars.color_name;
  let out = String(template)
    .replace(/\{\{#color\}\}([\s\S]*?)\{\{\/color\}\}/g, (_, inner) => (hasColor ? inner : ''))
    .replace(/\{\{\^color\}\}([\s\S]*?)\{\{\/color\}\}/g, (_, inner) => (hasColor ? '' : inner));
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ─── IP hashing (no plain IPs stored) ───────────────────────────────────────
function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.WIG_TRYON_IP_SALT || process.env.SHOPIFY_API_SECRET || 'hera';
  return crypto.createHmac('sha256', salt).update(String(ip)).digest('hex').slice(0, 32);
}

// ─── Events ─────────────────────────────────────────────────────────────────
// Customer flow (Hera 2026-11-04): button → (login) → colour → consent → selfie
// upload → selfie check → generation → download. The product photo is always
// the product's first image, so there is no "photo selected" step any more.
const CLIENT_EVENTS = ['button_click', 'login_completed', 'color_selected', 'consent_accepted', 'image_downloaded'];
const SERVER_EVENTS = ['selfie_submitted', 'selfie_accepted', 'selfie_rejected', 'generation_success', 'generation_failed',
  'blocked_account_limit', 'blocked_ip_limit', 'blocked_global_limit'];
const FUNNEL = ['button_click', 'login_completed', 'color_selected', 'consent_accepted',
  'selfie_submitted', 'selfie_accepted', 'generation_success', 'image_downloaded'];

const clip = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));

async function logEvent(e) {
  try {
    await pool.query(`
      INSERT INTO wig_tryon_events (source, event_type, session_id, customer_id, ip_hash, product_id, product_title,
        vendor, color_name, prompt_version, model, duration_ms, input_tokens, output_tokens, error_reason, detail)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [e.source || 'storefront', e.event_type, clip(e.session_id, 64), clip(e.customer_id, 40), clip(e.ip_hash, 64),
      clip(e.product_id, 40), clip(e.product_title, 300), clip(e.vendor, 120), clip(e.color_name, 120),
      e.prompt_version || null, clip(e.model, 60), e.duration_ms ?? null, e.input_tokens ?? null,
      e.output_tokens ?? null, clip(e.error_reason, 500), clip(e.detail, 500)]);
  } catch (err) {
    console.error('[wig-tryon] logEvent failed:', err.message);
  }
}

// ─── Quotas ─────────────────────────────────────────────────────────────────
// Order (spec §5): global first, then account, then IP.
// Returns { ok: true } or { ok: false, layer: 'global'|'account'|'ip' }.
async function checkQuota(config, { customerId, ipHash }) {
  const L = config.limits;
  const g = await pool.query(`SELECT count FROM wig_tryon_usage_global WHERE usage_date = ${TODAY_SQL}`);
  if ((g.rows[0] ? g.rows[0].count : 0) >= L.globalDaily) return { ok: false, layer: 'global' };
  if (customerId) {
    const c = await pool.query(`SELECT count FROM wig_tryon_usage_customer WHERE usage_date = ${TODAY_SQL} AND customer_id = $1`, [customerId]);
    if ((c.rows[0] ? c.rows[0].count : 0) >= L.perCustomer) return { ok: false, layer: 'account' };
  }
  if (ipHash) {
    const i = await pool.query(`SELECT count FROM wig_tryon_usage_ip WHERE usage_date = ${TODAY_SQL} AND ip_hash = $1`, [ipHash]);
    if ((i.rows[0] ? i.rows[0].count : 0) >= L.perIp) return { ok: false, layer: 'ip' };
  }
  return { ok: true };
}

// Try-ons left today for this visitor = the smaller of account / IP left
// (never says which). Global is reported separately (busy).
async function remaining(config, { customerId, ipHash }) {
  const L = config.limits;
  const g = await pool.query(`SELECT count FROM wig_tryon_usage_global WHERE usage_date = ${TODAY_SQL}`);
  const globalLeft = L.globalDaily - (g.rows[0] ? g.rows[0].count : 0);
  let left = Infinity;
  if (customerId) {
    const c = await pool.query(`SELECT count FROM wig_tryon_usage_customer WHERE usage_date = ${TODAY_SQL} AND customer_id = $1`, [customerId]);
    left = Math.min(left, L.perCustomer - (c.rows[0] ? c.rows[0].count : 0));
  }
  if (ipHash) {
    const i = await pool.query(`SELECT count FROM wig_tryon_usage_ip WHERE usage_date = ${TODAY_SQL} AND ip_hash = $1`, [ipHash]);
    left = Math.min(left, L.perIp - (i.rows[0] ? i.rows[0].count : 0));
  }
  if (left === Infinity) left = L.perCustomer;
  return { left: Math.max(0, left), globalLeft: Math.max(0, globalLeft) };
}

// Atomically take one use from all three counters, or none.
// Returns { ok, layer?, globalCount? }.
async function consumeQuota(config, { customerId, ipHash }) {
  const L = config.limits;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const g = await client.query(`
      INSERT INTO wig_tryon_usage_global AS t (usage_date, count) VALUES (${TODAY_SQL}, 1)
      ON CONFLICT (usage_date) DO UPDATE SET count = t.count + 1 WHERE t.count < $1
      RETURNING count`, [L.globalDaily]);
    if (!g.rows.length || g.rows[0].count > L.globalDaily) { await client.query('ROLLBACK'); return { ok: false, layer: 'global' }; }
    if (customerId) {
      const c = await client.query(`
        INSERT INTO wig_tryon_usage_customer AS t (usage_date, customer_id, count) VALUES (${TODAY_SQL}, $2, 1)
        ON CONFLICT (usage_date, customer_id) DO UPDATE SET count = t.count + 1 WHERE t.count < $1
        RETURNING count`, [L.perCustomer, customerId]);
      if (!c.rows.length || c.rows[0].count > L.perCustomer) { await client.query('ROLLBACK'); return { ok: false, layer: 'account' }; }
    }
    if (ipHash) {
      const i = await client.query(`
        INSERT INTO wig_tryon_usage_ip AS t (usage_date, ip_hash, count) VALUES (${TODAY_SQL}, $2, 1)
        ON CONFLICT (usage_date, ip_hash) DO UPDATE SET count = t.count + 1 WHERE t.count < $1
        RETURNING count`, [L.perIp, ipHash]);
      if (!i.rows.length || i.rows[0].count > L.perIp) { await client.query('ROLLBACK'); return { ok: false, layer: 'ip' }; }
    }
    await client.query('COMMIT');
    return { ok: true, globalCount: g.rows[0].count };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Give the use back when the generation failed on our / OpenAI's side.
// usageDate = the date string the use was taken on (so a failure just after
// midnight refunds the right day).
async function refundQuota({ customerId, ipHash, usageDate }) {
  try {
    await pool.query('UPDATE wig_tryon_usage_global SET count = GREATEST(count - 1, 0) WHERE usage_date = $1', [usageDate]);
    if (customerId) await pool.query('UPDATE wig_tryon_usage_customer SET count = GREATEST(count - 1, 0) WHERE usage_date = $1 AND customer_id = $2', [usageDate, customerId]);
    if (ipHash) await pool.query('UPDATE wig_tryon_usage_ip SET count = GREATEST(count - 1, 0) WHERE usage_date = $1 AND ip_hash = $2', [usageDate, ipHash]);
  } catch (e) {
    console.error('[wig-tryon] refund failed:', e.message);
  }
}

async function todayString() {
  const r = await pool.query(`SELECT to_char(${TODAY_SQL}, 'YYYY-MM-DD') AS d`);
  return r.rows[0].d;
}

// 80 % alert (spec §5): once per day, as an Urgent temp task on Online ›
// Dashboard (the Online team's existing checklist).
async function maybeSendAlert(config, globalCount) {
  const L = config.limits;
  if (!L.globalDaily || globalCount < Math.ceil(L.globalDaily * L.alertPct / 100)) return;
  const r = await pool.query(`
    UPDATE wig_tryon_usage_global SET alert_sent_at = NOW()
    WHERE usage_date = ${TODAY_SQL} AND alert_sent_at IS NULL RETURNING usage_date`);
  if (!r.rows.length) return; // already sent today
  try {
    await pool.query('UPDATE online_tasks SET sort_order = sort_order + 1');
    await pool.query(`
      INSERT INTO online_tasks (type, priority, name, link, description, sort_order)
      VALUES ('temp', 'urgent', $1, NULL, $2, 0)`,
    [`Wig Try-on: ${L.alertPct}% of today's limit used`,
      `${globalCount} of ${L.globalDaily} try-ons used today. Raise the daily limit in Online › Wig Try-on › Settings if needed; otherwise the feature pauses for everyone when the limit is reached.`]);
  } catch (e) {
    console.error('[wig-tryon] alert task failed:', e.message);
  }
}

async function todayUsage() {
  const r = await pool.query(`SELECT count, alert_sent_at FROM wig_tryon_usage_global WHERE usage_date = ${TODAY_SQL}`);
  return { count: r.rows[0] ? r.rows[0].count : 0, alertSentAt: r.rows[0] ? r.rows[0].alert_sent_at : null };
}

// ─── Stats (Overview) ───────────────────────────────────────────────────────
// from / to = 'YYYY-MM-DD' (inclusive, Toronto dates).
function rangeWhere(from, to, startIdx = 1) {
  return {
    sql: `(created_at AT TIME ZONE '${TZ}')::date BETWEEN $${startIdx}::date AND $${startIdx + 1}::date`,
    params: [from, to],
  };
}

function estimateCost(pricing, row) {
  const { inputImagePerM, outputImagePerM } = pricing || {};
  if (inputImagePerM == null || outputImagePerM == null) return null;
  return ((Number(row.input_tokens) || 0) * inputImagePerM + (Number(row.output_tokens) || 0) * outputImagePerM) / 1e6;
}

async function getStats(config, { from, to, source = 'storefront' }) {
  const w = rangeWhere(from, to, 2);
  const base = `source = $1 AND ${w.sql}`;
  const params = [source, ...w.params];

  const gen = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'generation_success')::int AS success,
      COUNT(*) FILTER (WHERE event_type = 'generation_failed')::int AS failed,
      ROUND(AVG(duration_ms) FILTER (WHERE event_type = 'generation_success'))::int AS avg_ms,
      COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
    FROM wig_tryon_events WHERE ${base} AND event_type IN ('generation_success', 'generation_failed')`, params);

  const blocked = await pool.query(`
    SELECT event_type, COUNT(*)::int AS n FROM wig_tryon_events
    WHERE ${base} AND event_type LIKE 'blocked_%' GROUP BY event_type`, params);

  // Funnel = distinct sessions that reached each step.
  const funnel = await pool.query(`
    SELECT event_type, COUNT(DISTINCT COALESCE(session_id, 'e' || id))::int AS sessions, COUNT(*)::int AS events
    FROM wig_tryon_events WHERE ${base} GROUP BY event_type`, params);

  const products = await pool.query(`
    SELECT product_id, MAX(product_title) AS product_title, MAX(vendor) AS vendor,
      COUNT(*) FILTER (WHERE event_type = 'generation_success')::int AS success,
      COUNT(*) FILTER (WHERE event_type = 'generation_failed')::int AS failed,
      COUNT(*) FILTER (WHERE event_type = 'image_downloaded')::int AS downloads
    FROM wig_tryon_events
    WHERE ${base} AND product_id IS NOT NULL AND event_type IN ('generation_success', 'generation_failed', 'image_downloaded')
    GROUP BY product_id ORDER BY success DESC, failed DESC LIMIT 50`, params);

  const colors = await pool.query(`
    SELECT color_name, MAX(vendor) AS vendor,
      COUNT(*) FILTER (WHERE event_type = 'generation_success')::int AS success,
      COUNT(*) FILTER (WHERE event_type = 'generation_failed')::int AS failed
    FROM wig_tryon_events
    WHERE ${base} AND color_name IS NOT NULL AND event_type IN ('generation_success', 'generation_failed')
    GROUP BY color_name ORDER BY success DESC LIMIT 50`, params);

  const selfie = await pool.query(`
    SELECT event_type, error_reason, COUNT(*)::int AS n,
      COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens, COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
    FROM wig_tryon_events WHERE ${base} AND event_type IN ('selfie_accepted', 'selfie_rejected')
    GROUP BY event_type, error_reason`, params);

  const g = gen.rows[0];
  const sel = { accepted: 0, rejected: 0, reasons: {}, inputTokens: 0, outputTokens: 0 };
  for (const r of selfie.rows) {
    if (r.event_type === 'selfie_accepted') sel.accepted += r.n;
    else { sel.rejected += r.n; const k = r.error_reason || 'other'; sel.reasons[k] = (sel.reasons[k] || 0) + r.n; }
    sel.inputTokens += Number(r.input_tokens); sel.outputTokens += Number(r.output_tokens);
  }
  const funnelMap = Object.fromEntries(funnel.rows.map(r => [r.event_type, r]));
  return {
    from, to, source,
    generations: {
      success: g.success, failed: g.failed, avgMs: g.avg_ms,
      inputTokens: Number(g.input_tokens), outputTokens: Number(g.output_tokens),
      estCostUsd: estimateCost(config.pricing, g),
    },
    selfieCheck: sel,
    blocked: Object.fromEntries(blocked.rows.map(r => [r.event_type, r.n])),
    funnel: FUNNEL.map(step => ({
      step,
      sessions: funnelMap[step] ? funnelMap[step].sessions : 0,
      events: funnelMap[step] ? funnelMap[step].events : 0,
    })),
    products: products.rows,
    colors: colors.rows,
  };
}

async function listEvents({ from, to, source, type, q, page = 1, pageSize = 100 }) {
  const where = [];
  const params = [];
  if (from && to) {
    const w = rangeWhere(from, to, params.length + 1);
    where.push(w.sql); params.push(...w.params);
  }
  if (source) { params.push(source); where.push(`source = $${params.length}`); }
  if (type === 'generations') where.push(`event_type IN ('generation_success', 'generation_failed')`);
  else if (type === 'blocked') where.push(`event_type LIKE 'blocked_%'`);
  else if (type === 'selfie') where.push(`event_type IN ('selfie_accepted', 'selfie_rejected')`);
  else if (type) { params.push(type); where.push(`event_type = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    const i = params.length;
    where.push(`(product_title ILIKE $${i} OR customer_id ILIKE $${i} OR color_name ILIKE $${i} OR product_id ILIKE $${i} OR error_reason ILIKE $${i} OR detail ILIKE $${i})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM wig_tryon_events ${whereSql}`, params);
  const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 100));
  const p = Math.max(1, parseInt(page, 10) || 1);
  const rows = await pool.query(`
    SELECT * FROM wig_tryon_events ${whereSql}
    ORDER BY created_at DESC, id DESC LIMIT ${size} OFFSET ${(p - 1) * size}`, params);
  return { total: total.rows[0].n, page: p, pageSize: size, events: rows.rows };
}

module.exports = {
  DEFAULT_CONFIG, DEFAULT_PROMPT, DEFAULT_CHECK_PROMPT, SELFIE_REASONS, SELFIE_TEXT, TZ,
  getConfig, saveConfig, isEligibleType,
  listPrompts, addPrompt, getActivePrompt, getPrompt, renderPrompt,
  isOn: (config) => config.mode === 'preview' || config.mode === 'live',
  hashIp, CLIENT_EVENTS, SERVER_EVENTS, FUNNEL, logEvent,
  checkQuota, consumeQuota, remaining, refundQuota, todayString, maybeSendAlert, todayUsage,
  getStats, listEvents, estimateCost,
};
