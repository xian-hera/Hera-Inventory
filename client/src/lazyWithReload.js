// lazyWithReload (2026-10-06) — route-level lazy loading, see App.js.
//
// A thin wrapper around React.lazy(). Pages are now downloaded per section
// (Purchasing / Store / Operation / Online / Warehouse) the first time the
// user enters that section, instead of all at once.
//
// Why the wrapper: every deploy replaces the section files with new ones
// (new file names). A browser tab that was opened BEFORE a deploy still
// asks for the OLD file names when the user enters a section for the first
// time, and those no longer exist on the server -> "ChunkLoadError".
// When that happens we reload the page once, which picks up the new build.
//
// Loop guard: the time of the last automatic reload is kept in
// sessionStorage; we never auto-reload twice within 10 seconds. If the load
// still fails after that (or sessionStorage is unavailable), the error is
// passed on to the page error boundary (components/PageErrorBoundary.js),
// which shows a "Reload page" button instead.

import { lazy } from 'react';

const RELOAD_KEY = 'hub_chunk_reload_at';
const RELOAD_GUARD_MS = 10000;

function isChunkLoadError(err) {
  if (!err) return false;
  if (err.name === 'ChunkLoadError') return true;
  const msg = String(err.message || err);
  return /Loading (CSS )?chunk [\w-]+ failed/i.test(msg);
}

// Returns true if we are allowed to auto-reload now (and records the time).
// Returns false if we reloaded very recently, or if sessionStorage can't be
// used — in that case we must not reload, or we could loop forever.
function claimReload() {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY)) || 0;
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return true;
  } catch (e) {
    return false;
  }
}

export default function lazyWithReload(importFn) {
  return lazy(() =>
    importFn().catch((err) => {
      if (isChunkLoadError(err) && claimReload()) {
        window.location.reload();
        // Never resolve: keep showing "Loading..." until the reload happens.
        return new Promise(() => {});
      }
      throw err;
    })
  );
}
