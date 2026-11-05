// Online › Wig Try-on — API helpers + shared bits (2026-11-04).
// Server: server/routes/wigTryon.js (/api/wig-tryon). Spec: claude/WIG_TRYON_FEATURE_SPEC.md.

export const ADMIN_PRODUCT = 'https://admin.shopify.com/store/beaute-hera/products/';
export const ADMIN_CUSTOMER = 'https://admin.shopify.com/store/beaute-hera/customers/';

async function call(method, url, body) {
  const res = await fetch(`/api/wig-tryon${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
export const api = {
  get: (u) => call('GET', u),
  post: (u, b) => call('POST', u, b || {}),
  put: (u, b) => call('PUT', u, b || {}),
};

// Local calendar date 'YYYY-MM-DD' (the Hub is used in Montreal / Toronto time).
export const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const RANGES = [
  { label: 'Today', value: 'today' },
  { label: 'Last 7 days', value: '7' },
  { label: 'This month', value: 'month' },
  { label: 'Last 30 days', value: '30' },
  { label: 'Last 90 days', value: '90' },
];
export function rangeDates(value) {
  const now = new Date();
  const to = ymd(now);
  if (value === 'today') return { from: to, to };
  if (value === 'month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  const n = parseInt(value, 10) || 7;
  const f = new Date(now); f.setDate(f.getDate() - (n - 1));
  return { from: ymd(f), to };
}

export const EVENT_LABEL = {
  button_click: 'Button click',
  login_completed: 'Logged in',
  color_selected: 'Colour selected',
  consent_accepted: 'Consent accepted',
  selfie_submitted: 'Selfie uploaded',
  selfie_accepted: 'Selfie OK',
  selfie_rejected: 'Selfie rejected',
  generation_success: 'Generated',
  generation_failed: 'Generation failed',
  image_downloaded: 'Downloaded',
  blocked_account_limit: 'Blocked: account limit',
  blocked_ip_limit: 'Blocked: IP limit',
  blocked_global_limit: 'Blocked: daily total',
};

// Selfie check reason codes (server/services/wigTryonStore.js SELFIE_REASONS).
export const REASON_LABEL = {
  ok: 'OK',
  no_person: 'No person',
  multiple_people: 'More than one person',
  face_not_visible: 'Face not visible / covered / turned away',
  head_cut_off: 'Head cut off',
  face_too_small: 'Face too small',
  blurry_or_dark: 'Blurry or too dark',
  not_a_real_photo: 'Not a real photo',
  inappropriate: 'Inappropriate',
  check_failed: 'Check failed (OpenAI error)',
  check_error_allowed: 'Check failed — let through',
};

// Resize a picked photo in the browser (max side 1536 px, JPEG) — keeps the
// upload small and turns PNG / WebP into JPEG. Returns a data: URL.
export function photoToJpeg(file, maxSide = 1536) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This photo format cannot be read by the browser (try JPEG or PNG).')); };
    img.src = url;
  });
}

// Image models for /v1/images/edits (OpenAI docs, checked 2026-11-05; gpt-image-1 was
// shut down 2026-10-23). Any other name can still be saved in Settings.
export const IMAGE_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'];

// Vision models for the selfie check (/v1/responses), cheapest first (OpenAI docs, checked
// 2026-11-05). Not listed: gpt-5-mini / gpt-5-nano (shut down 2026-12-11), gpt-4.1-nano (shut down).
export const CHECK_MODELS = [
  { value: 'gpt-6-luna', label: 'gpt-6-luna — cheapest, high-volume (default)' },
  { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
  { value: 'gpt-5.4-nano', label: 'gpt-5.4-nano (removed 2027-04-01)' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
  { value: 'gpt-6.1-terra', label: 'gpt-6.1-terra — stronger visual reasoning, ~10× luna price' },
  { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
  { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini (removed 2027-01-14)' },
];

export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtMs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
export const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
export const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export const TH = { textAlign: 'left', padding: '10px 8px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid #e1e3e5', verticalAlign: 'bottom', whiteSpace: 'nowrap' };
export const TD = { padding: '8px', fontSize: 13, borderTop: '1px solid #f1f1f1', verticalAlign: 'top', wordBreak: 'break-word' };
