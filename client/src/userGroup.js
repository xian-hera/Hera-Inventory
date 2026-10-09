// Purchasing user groups — frontend side (2026-10-09, Hera).
// Full description: claude/USER_GROUPS_FEATURE.md. Server side: routes/userGroups.js.
//
// A Purchasing user picks a "user group" (a set of product types) once; the
// Hub remembers it per Shopify account (server) and per device (localStorage
// fallback). The current choice travels with EVERY /api request in the
// `X-User-Group` header (added by the fetch interceptor in index.js), and the
// Buyer list endpoints use it to hide what belongs to other groups. It is a
// VIEW filter, not a permission.
//
// Choice values: 'ALL' (see everything), a group id (number), or null (not
// chosen yet — no header is sent, lists are unfiltered).
//
// Rule for dropdowns (types / tags / suppliers): a value is hidden only when
// it belongs to ANOTHER group; types in no group are visible to every group.
// useGroupContext() gives pages the helpers; pages keep their own existing
// hidden-type rules and just apply these on top.

import { useEffect, useState } from 'react';
import { fetchWithAccount } from './accountMemory';

const LS_KEY = 'hera_user_group';

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function lsRemove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

function parseChoice(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (String(raw).toUpperCase() === 'ALL') return 'ALL';
  const id = parseInt(raw, 10);
  return id ? id : null;
}

// Current choice. Starts from localStorage so the header is already right on
// the first request after a reload; the gate then confirms it with the server.
let choice = parseChoice(lsGet(LS_KEY));
let groupsCache = null; // [{ id, name, types }] once loaded

// ── header (used by the interceptor in index.js) ─────────────────────────────
export function groupHeaderValue() {
  return choice === null ? null : String(choice);
}

export function getGroupChoice() { return choice; }
export function getCachedGroups() { return groupsCache; }

function setChoice(next) {
  choice = next;
  if (next === null) lsRemove(LS_KEY); else lsSet(LS_KEY, String(next));
  ctxCache = { key: null, promise: null, data: null }; // dropdown context depends on the choice
}

// ── server calls ─────────────────────────────────────────────────────────────
async function getJson(url, options) {
  try {
    const res = await fetchWithAccount(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// → [{ id, name, types }] or null on error. Never throws.
export async function fetchGroups() {
  const data = await getJson('/api/user-groups');
  if (data && Array.isArray(data.groups)) {
    groupsCache = data.groups;
    return data.groups;
  }
  return null;
}

// Called once per app load by BuyerGroupGate. Works out whether the user has to
// pick a group. Never rejects: on any problem the gate lets the user through.
export async function loadGroupState() {
  const groups = await fetchGroups();
  if (groups === null) return { ok: false, groups: [] };
  if (groups.length === 0) {
    setChoice(null);
    return { ok: true, groups };
  }
  const mine = await getJson('/api/user-groups/my');
  if (mine && mine.identified) {
    setChoice(parseChoice(mine.choice)); // server wins (null = pick again)
    return { ok: true, groups };
  }
  // Account not identified → the choice remembered on this device, if still valid.
  const local = choice;
  const valid = local === 'ALL' || (typeof local === 'number' && groups.some((g) => g.id === local));
  if (!valid) setChoice(null);
  return { ok: true, groups };
}

// Pick a group (or 'ALL'). Remembered for the account; localStorage always.
export async function chooseGroup(next) {
  setChoice(parseChoice(next));
  await getJson('/api/user-groups/my', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ choice: next }),
  });
}

// Settings → Reset my group: forget it for the account and this device. The
// gate asks again the next time a Purchasing page opens.
export async function resetMyGroup() {
  setChoice(null);
  await getJson('/api/user-groups/my', { method: 'DELETE' });
}

// ── dropdown context ─────────────────────────────────────────────────────────
let ctxCache = { key: null, promise: null, data: null };

function buildContext(raw) {
  const blocked = new Set((raw.blockedTypes || []).map((t) => String(t).trim().toLowerCase()));
  const hiddenTags = new Set((raw.hiddenTags || []).map((t) => String(t).trim().toLowerCase()));
  const active = !!raw.active;
  const typeAllowed = (t) => !active || !blocked.has(String(t == null ? '' : t).trim().toLowerCase());
  const tagAllowed = (t) => !active || !hiddenTags.has(String(t == null ? '' : t).trim().toLowerCase());
  return {
    ready: true,
    active,
    typeAllowed,
    tagAllowed,
    // true when a list of types (a supplier's carried types, a task's types) is
    // visible: empty, or at least one type is allowed.
    typesVisible: (arr) => !active || !Array.isArray(arr) || arr.length === 0 || arr.some(typeAllowed),
    // Keeps only the allowed entries of a list of strings or { value, label }.
    filterTypes: (options) => (Array.isArray(options)
      ? options.filter((o) => typeAllowed(typeof o === 'string' ? o : o && o.value))
      : options),
    filterTags: (tags) => (Array.isArray(tags)
      ? tags.filter((t) => tagAllowed(typeof t === 'string' ? t : t && t.tag))
      : tags),
  };
}

const NOT_READY = {
  ready: false,
  active: false,
  typeAllowed: () => true,
  tagAllowed: () => true,
  typesVisible: () => true,
  filterTypes: (o) => o,
  filterTags: (t) => t,
};

function loadContext() {
  const key = groupHeaderValue() || 'none';
  if (ctxCache.key === key && ctxCache.promise) return ctxCache.promise;
  const promise = fetch('/api/user-groups/context')
    .then((r) => (r.ok ? r.json() : { active: false }))
    .catch(() => ({ active: false }))
    .then((raw) => {
      const data = buildContext(raw);
      if (ctxCache.key === key) ctxCache.data = data;
      return data;
    });
  ctxCache = { key, promise, data: null };
  return promise;
}

// Hook for pages that fill dropdowns / filters. Before the answer arrives it
// returns an "allow everything" context with ready: false.
export function useGroupContext() {
  const key = groupHeaderValue() || 'none';
  const cached = ctxCache.key === key && ctxCache.data ? ctxCache.data : null;
  const [ctx, setCtx] = useState(cached || NOT_READY);
  useEffect(() => {
    let cancelled = false;
    loadContext().then((d) => { if (!cancelled) setCtx(d); });
    return () => { cancelled = true; };
  }, [key]);
  return ctx;
}
