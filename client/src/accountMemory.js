// Per-account memory — frontend side (2026-09-29, Hera).
//
// WHY: the PIN "remember this device for 30 days" and the Store (manager)
// location used to live only in localStorage. The Hub runs as a cross-site
// iframe inside Shopify Admin, and on iOS (Shopify app / WebKit) that
// iframe's localStorage gets wiped whenever the WebView is recreated — so
// iOS users had to enter the PIN / pick the location again and again. It
// also explained "sometimes it remembers, sometimes not" on desktop:
// different browsers / Admin-embedded vs direct URL are separate storages.
//
// NOW: the backend remembers it per Shopify staff account (every store has
// its own account). This file gets a Shopify App Bridge session token and
// talks to /api/account-memory (server/routes/accountMemory.js).
//
// FALLBACK (never blocks a page): if no account can be identified (App
// Bridge missing / slow, server error, network error...), every function
// here behaves exactly like the old localStorage code did. localStorage is
// also still written on every success, so the fallback always has the most
// recent value.

const TOKEN_TIMEOUT_MS = 4000;
const PIN_EXPIRY_DAYS = 30;

// localStorage keys — unchanged from before this change.
export const PIN_LOCAL_KEYS = {
  buyer_pin: 'buyer_pin_verified',
  crm_pin: 'crm_pin_verified',
  online_pin: 'online_pin_verified',
};
const MANAGER_LOCATION_KEY = 'managerLocation';

// ── localStorage helpers (wrapped: storage can throw on iOS / private mode) ──
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function lsRemove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

// ── session token ────────────────────────────────────────────────────────────
// Resolves to a token string, or null (never rejects).
export async function getSessionToken() {
  try {
    const sb = typeof window !== 'undefined' ? window.shopify : undefined;
    if (!sb || typeof sb.idToken !== 'function') return null;
    const token = await Promise.race([
      sb.idToken(),
      new Promise((resolve) => setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS)),
    ]);
    return typeof token === 'string' && token ? token : null;
  } catch (e) {
    return null;
  }
}

// fetch() with the session token attached when we have one. Used only for
// /api/account-memory and /api/settings/pin/verify.
export async function fetchWithAccount(url, options = {}) {
  const token = await getSessionToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

// Returns parsed JSON for a 2xx response, or null for anything else.
async function accountJson(url, options) {
  try {
    const res = await fetchWithAccount(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ═══ PIN ═════════════════════════════════════════════════════════════════════

function isPinVerifiedLocally(pinKey) {
  try {
    const stored = lsGet(PIN_LOCAL_KEYS[pinKey]);
    if (!stored) return false;
    const { expiry } = JSON.parse(stored);
    return Date.now() < expiry;
  } catch (e) { return false; }
}

// true → let the user straight in; false → show the PIN modal.
// Account identified → the server's answer wins. Not identified → old
// localStorage check.
export async function isPinVerified(pinKey) {
  const data = await accountJson(`/api/account-memory/pin-status?key=${encodeURIComponent(pinKey)}`);
  if (data && data.identified) return !!data.verified;
  return isPinVerifiedLocally(pinKey);
}

// Verifies a PIN. Returns { ok: true } / { ok: false, wrong: true } (wrong
// PIN) / { ok: false, wrong: false } (network/server error). On success the
// server has already remembered it for the account (if identified), and the
// old localStorage entry is written too (fallback).
export async function verifyPin(pinKey, pin) {
  let res;
  try {
    res = await fetchWithAccount('/api/settings/pin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: pinKey, pin }),
    });
  } catch (e) {
    return { ok: false, wrong: false };
  }
  if (res.ok) {
    const expiry = Date.now() + PIN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    lsSet(PIN_LOCAL_KEYS[pinKey], JSON.stringify({ expiry }));
    return { ok: true };
  }
  // /pin/verify answers 401 for a wrong PIN (no `reauth` flag, so the global
  // fetch interceptor in index.js leaves it alone — same as before).
  return { ok: false, wrong: res.status === 401 };
}

// Settings → Log out: forget for this account (server) AND this device.
export async function logoutPin(pinKey) {
  lsRemove(PIN_LOCAL_KEYS[pinKey]);
  await accountJson('/api/account-memory/pin-logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: pinKey }),
  });
}

// ═══ Store (manager) location ════════════════════════════════════════════════
// Loaded once per app load into a module-level cache. ManagerLocationGate
// (below) waits for that before rendering any /manager page, so every
// manager page can read it synchronously with getManagerLocation() — the
// same way they used to read localStorage.

let locationState = { loaded: false, identified: false, location: '' };
let locationPromise = null;

export function loadManagerLocation() {
  if (!locationPromise) {
    locationPromise = (async () => {
      const data = await accountJson('/api/account-memory/location');
      if (data && data.identified) {
        const loc = data.location || '';
        locationState = { loaded: true, identified: true, location: loc };
        // Mirror into localStorage so the fallback stays in step.
        if (loc) lsSet(MANAGER_LOCATION_KEY, loc);
      } else {
        locationState = { loaded: true, identified: false, location: lsGet(MANAGER_LOCATION_KEY) || '' };
      }
      return locationState;
    })();
  }
  return locationPromise;
}

// Synchronous read for manager pages. Before the first load finishes (should
// not happen behind ManagerLocationGate) it answers from localStorage.
export function getManagerLocation() {
  if (locationState.loaded) return locationState.location || '';
  return lsGet(MANAGER_LOCATION_KEY) || '';
}

export function isManagerLocationLoaded() {
  return locationState.loaded;
}

export function isManagerLocationFromAccount() {
  return locationState.loaded && locationState.identified;
}

// Manager Home → Confirm. Saves for the account (overwrite) and this device.
export async function saveManagerLocation(location) {
  lsSet(MANAGER_LOCATION_KEY, location);
  locationState = { ...locationState, loaded: true, location };
  const data = await accountJson('/api/account-memory/location', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location }),
  });
  if (data && data.identified) locationState = { ...locationState, identified: true };
  return !!(data && data.success);
}

// Manager Home → Change. The account's saved location is NOT deleted — it is
// only overwritten when a new one is confirmed (Hera, 2026-09-29). Without an
// account (fallback) it behaves as before: this device forgets it.
export function beginChangeManagerLocation() {
  if (!isManagerLocationFromAccount()) {
    lsRemove(MANAGER_LOCATION_KEY);
    locationState = { ...locationState, location: '' };
  }
}
