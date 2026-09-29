// ManagerLocationGate (2026-09-29, Hera).
//
// Wraps every /manager route in App.js. Before rendering the page it waits
// for the Store location to be loaded once (from the current Shopify
// account, or the localStorage fallback — see client/src/accountMemory.js).
// That way every manager page can keep reading the location synchronously
// on its first render (getManagerLocation()), the same as when it read
// localStorage directly, and no page ever fires a request with an empty
// location just because the answer hadn't arrived yet — including when a
// manager page is opened/refreshed directly.
//
// loadManagerLocation() never rejects (it falls back to localStorage), so
// this can't get stuck; the spinner is only shown for the first load of the
// app — after that the value is cached and pages render immediately.

import React, { useEffect, useState } from 'react';
import { Spinner } from '@shopify/polaris';
import { loadManagerLocation, isManagerLocationLoaded } from '../accountMemory';

export default function ManagerLocationGate({ children }) {
  const [ready, setReady] = useState(isManagerLocationLoaded());

  useEffect(() => {
    if (ready) return undefined;
    let cancelled = false;
    loadManagerLocation().finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [ready]);

  if (!ready) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
        <Spinner accessibilityLabel="Loading" size="large" />
      </div>
    );
  }
  return children;
}
