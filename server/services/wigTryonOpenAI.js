// Online › Wig Try-on — OpenAI image edit call (2026-11-04, Hera).
// POST https://api.openai.com/v1/images/edits, multipart, several image[] inputs.
// Needs the OPENAI_API_KEY environment variable on Render.
// Uses Node's built-in fetch / FormData / Blob (Node 24) — no new dependency.

const OPENAI_URL = process.env.OPENAI_IMAGES_EDITS_URL || 'https://api.openai.com/v1/images/edits';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Small concurrency gate so a burst of customers cannot open dozens of
// OpenAI calls at once. Limit is read on every acquire (settings can change).
let running = 0;
const waiters = [];
async function acquire(limit) {
  if (running < limit) { running++; return; }
  await new Promise(resolve => waiters.push(resolve));
  running++;
}
function release() {
  running--;
  const next = waiters.shift();
  if (next) next();
}
function queueState() { return { running, waiting: waiters.length }; }

function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Downloads a merchant image (product media / swatch file on Shopify CDN).
async function fetchImage(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Image download failed (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = sniffMime(buf);
    if (!mime) throw new Error('Image download is not a JPEG / PNG / WebP');
    return { buffer: buf, mime };
  } finally {
    clearTimeout(t);
  }
}

class OpenAIError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.status = status;
    this.retryable = !!retryable;
  }
}

// images: [{ buffer, mime, name }] in prompt order.
// Returns { b64, mime, usage: { input_tokens, output_tokens, ... } }.
async function editImage({ images, prompt, openai }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new OpenAIError('OPENAI_API_KEY is not set on the server');
  const outputFormat = openai.outputFormat || 'jpeg';

  const build = () => {
    const fd = new FormData();
    fd.append('model', openai.model);
    fd.append('prompt', prompt);
    images.forEach((img, i) => {
      fd.append('image[]', new Blob([img.buffer], { type: img.mime }), img.name || `image${i + 1}.${EXT[img.mime] || 'jpg'}`);
    });
    if (openai.size) fd.append('size', openai.size);
    if (openai.quality) fd.append('quality', openai.quality);
    fd.append('output_format', outputFormat);
    if (outputFormat !== 'png') fd.append('output_compression', '90');
    if (openai.inputFidelity) fd.append('input_fidelity', openai.inputFidelity);
    fd.append('n', '1');
    return fd;
  };

  const attempts = 1 + (openai.retries || 0);
  let lastErr;
  await acquire(openai.maxConcurrent || 3);
  try {
    for (let a = 0; a < attempts; a++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), (openai.timeoutSec || 180) * 1000);
      try {
        const res = await fetch(OPENAI_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: build(),
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = (data && data.error && data.error.message) || `OpenAI HTTP ${res.status}`;
          throw new OpenAIError(msg, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
        }
        const item = data && data.data && data.data[0];
        if (!item || !item.b64_json) throw new OpenAIError('OpenAI returned no image', { retryable: false });
        return {
          b64: item.b64_json,
          mime: `image/${outputFormat === 'jpeg' ? 'jpeg' : outputFormat}`,
          usage: data.usage || {},
        };
      } catch (e) {
        lastErr = e.name === 'AbortError'
          ? new OpenAIError(`OpenAI timed out after ${openai.timeoutSec}s`, { retryable: true })
          : (e instanceof OpenAIError ? e : new OpenAIError(e.message, { retryable: true }));
        if (!lastErr.retryable || a === attempts - 1) throw lastErr;
        await sleep(2000 * (a + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  } finally {
    release();
  }
}

// ─── Selfie check (Responses API, vision + JSON schema) ─────────────────────
// Returns { suitable, reason, note, usage }. reason is one of `reasons`.
const RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || 'https://api.openai.com/v1/responses';

async function checkSelfie({ image, check, reasons }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new OpenAIError('OPENAI_API_KEY is not set on the server');
  const body = {
    model: check.model,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: check.prompt },
        { type: 'input_image', image_url: `data:${image.mime};base64,${image.buffer.toString('base64')}`, detail: check.detail || 'auto' },
      ],
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'selfie_check',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            suitable: { type: 'boolean' },
            reason: { type: 'string', enum: reasons },
            note: { type: 'string', description: 'One short English sentence explaining the decision, for the shop staff.' },
          },
          required: ['suitable', 'reason', 'note'],
          additionalProperties: false,
        },
      },
    },
  };
  if (check.reasoningEffort) body.reasoning = { effort: check.reasoningEffort };

  let lastErr;
  for (let a = 0; a < 2; a++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (check.timeoutSec || 45) * 1000);
    try {
      const res = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || `OpenAI HTTP ${res.status}`;
        throw new OpenAIError(msg, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
      }
      let text = typeof data.output_text === 'string' ? data.output_text : '';
      let refusal = '';
      if (!text) {
        for (const item of data.output || []) {
          if (item.type !== 'message') continue;
          for (const c of item.content || []) {
            if (c.type === 'output_text') text += c.text;
            else if (c.type === 'refusal') refusal += c.refusal;
          }
        }
      }
      if (!text && refusal) return { suitable: false, reason: 'inappropriate', note: `Model refused: ${refusal}`.slice(0, 300), usage: data.usage || {} };
      let out;
      try { out = JSON.parse(text); } catch (e) { throw new OpenAIError('Selfie check returned no JSON', { retryable: true }); }
      const reason = reasons.includes(out.reason) ? out.reason : (out.suitable ? 'ok' : 'face_not_visible');
      const suitable = !!out.suitable && reason === 'ok';
      return { suitable, reason: suitable ? 'ok' : (reason === 'ok' ? 'face_not_visible' : reason), note: String(out.note || '').slice(0, 300), usage: data.usage || {} };
    } catch (e) {
      lastErr = e.name === 'AbortError'
        ? new OpenAIError(`Selfie check timed out after ${check.timeoutSec}s`, { retryable: true })
        : (e instanceof OpenAIError ? e : new OpenAIError(e.message, { retryable: true }));
      if (!lastErr.retryable || a === 1) throw lastErr;
      await sleep(1000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

module.exports = { editImage, checkSelfie, fetchImage, sniffMime, OpenAIError, queueState };
