// shopifyInventoryReader (2026-10-06, Hera) — reliable inventory reads for
// Purchasing › Inventory Count › Create New Count.
//
// Used by routes/shopify.js:
//   POST /api/shopify/products        (requestReliable — page through products)
//   POST /api/shopify/quantity-check  (readVariantInventory — quantity filter)
//   POST /api/shopify/soh-check       (readVariantInventory + resolveBarcodes — "Exclude 0")
//
// Why this exists: the old quantity-check / soh-check looked every item up again
// by a `barcode:` TEXT SEARCH and silently skipped anything that failed or was not
// found. A skipped item was never put on any store's "exclude" list, so it ended
// up in EVERY store's task — a wrong result that looked normal. Rules now:
//   1. Read inventory by variant ID (nodes(ids:)) — exact, no search index, no
//      special-character / SKU-fallback problems.
//   2. Every requested ID must come back. Failed requests are retried patiently
//      (throttling waits for Shopify's cost budget; network errors / timeouts /
//      Shopify 5xx are retried too). Only after all retries is a batch given up,
//      and then its IDs are reported back as `unverified` — never treated as
//      "passes" or "fails". The route/page decides what to do with them.
//   3. A variant that no longer exists, or whose product is no longer Active, is
//      reported as `gone`.
//   4. A location where the item has no inventory level (inventory not tracked
//      there) counts as quantity 0 — same as before (Hera, 2026-10-06).

const { activeFilter } = require('../shopify');

const config = {
  // Wait before retry #1..#5 (6 attempts in total, ~31 s of waiting at most).
  retryDelaysMs: [1000, 2000, 4000, 8000, 16000],
  // A single request that hangs longer than this is abandoned and retried.
  requestTimeoutMs: 30000,
};
// Shopify rejects a single query whose requested cost exceeds 1000 points; aim
// for about half of that per request. (Hera's store: Plus plan — 20000-point
// bucket restoring 1000 points/s — so two of these in parallel are fine.)
const TARGET_COST = 500;
const CONCURRENCY = 2;

const RETRIABLE_ERROR_CLASSES = new Set([
  'HttpThrottlingError',
  'HttpInternalError',
  'HttpRequestError',
  'HttpMaxRetriesError',
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class RequestTimeoutError extends Error {}
class RequestAbortedError extends Error {}

function graphqlErrorCode(e) {
  return e?.body?.errors?.graphQLErrors?.[0]?.extensions?.code || null;
}

// True for failures that can succeed on a later attempt (throttling, network,
// timeouts, Shopify-side 5xx). False for errors that will fail the same way every
// time (bad query, access denied, cost too high) — retrying those only wastes time.
function isRetriable(e) {
  if (!e) return false;
  if (e instanceof RequestTimeoutError) return true;
  if (e.isEmptyResponse) return true;
  const cls = e.constructor && e.constructor.name;
  if (RETRIABLE_ERROR_CLASSES.has(cls)) return true;
  const code = graphqlErrorCode(e);
  if (code === 'THROTTLED' || code === 'INTERNAL_SERVER_ERROR') return true;
  const msg = String(e.message || '');
  if (/throttl/i.test(msg)) return true;
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i.test(msg)) return true;
  if (typeof e.code === 'string' && /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR)/.test(e.code)) return true;
  return false;
}

// How long Shopify's cost bucket needs to refill enough for the failed query.
function throttleWaitMs(e) {
  if (typeof e?.retryAfter === 'number' && e.retryAfter > 0) return Math.ceil(e.retryAfter * 1000);
  const cost = e?.body?.extensions?.cost;
  const status = cost?.throttleStatus;
  if (cost && status && status.restoreRate > 0) {
    const missing = (cost.requestedQueryCost || 0) - (status.currentlyAvailable || 0);
    if (missing > 0) return Math.ceil((missing / status.restoreRate) * 1000) + 250;
  }
  return 0;
}

// After a successful request: if the bucket is running low, pause a little so the
// next request is not throttled in the first place.
async function paceAfter(response) {
  const cost = response?.extensions?.cost;
  const status = cost?.throttleStatus;
  if (!cost || !status || !(status.restoreRate > 0)) return;
  const wanted = (cost.requestedQueryCost || 0) * 2;
  if (status.currentlyAvailable < wanted) {
    await sleep(Math.ceil(((wanted - status.currentlyAvailable) / status.restoreRate) * 1000));
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RequestTimeoutError(`Shopify request timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// One GraphQL request with patient retries. Returns the response (with `data`),
// or throws the last error once every attempt has failed / the error is not
// retriable. Throws RequestAbortedError if isAborted() becomes true.
async function requestReliable(client, query, variables, { label = 'shopify', isAborted } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= config.retryDelaysMs.length; attempt++) {
    if (isAborted && isAborted()) throw new RequestAbortedError('aborted');
    try {
      const response = await withTimeout(
        client.request(query, variables ? { variables } : undefined),
        config.requestTimeoutMs
      );
      if (!response || !response.data) {
        const empty = new Error('Shopify returned an empty response');
        empty.isEmptyResponse = true;
        throw empty;
      }
      await paceAfter(response);
      return response;
    } catch (e) {
      lastError = e;
      if (attempt === config.retryDelaysMs.length || !isRetriable(e)) break;
      const wait = Math.max(config.retryDelaysMs[attempt], throttleWaitMs(e));
      console.warn(`[${label}] attempt ${attempt + 1} failed (${e.message}); retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
  throw lastError;
}

// Runs async tasks in waves of `concurrency`.
async function runInWaves(tasks, concurrency, isAborted) {
  for (let i = 0; i < tasks.length; i += concurrency) {
    if (isAborted && isAborted()) throw new RequestAbortedError('aborted');
    await Promise.all(tasks.slice(i, i + concurrency).map(t => t()));
  }
}

// Reads the "available" quantity of every variant at every given location.
//   variantIds:  Shopify ProductVariant GIDs
//   locationIds: Shopify Location GIDs (result arrays follow this order)
// Returns {
//   quantities: { [variantId]: [qtyAtLocation0, qtyAtLocation1, ...] },
//   gone:       [variantId]  — deleted, or product no longer Active
//   unverified: [variantId]  — could not be read even after all retries
// }
async function readVariantInventory(client, variantIds, locationIds, { isAborted, label = 'inventory-read' } = {}) {
  const ids = [...new Set((variantIds || []).filter(Boolean))];
  const quantities = {};
  const gone = [];
  const unverified = [];
  if (ids.length === 0 || locationIds.length === 0) return { quantities, gone, unverified };

  // Estimated requested cost per variant: node + product + inventoryItem
  // + (inventoryLevel + quantities) per location.
  const costPerVariant = 3 + 2 * locationIds.length;
  const batchSize = Math.max(10, Math.min(250, Math.floor(TARGET_COST / costPerVariant)));

  const locationFields = locationIds.map((locId, i) =>
    `loc${i}: inventoryLevel(locationId: ${JSON.stringify(locId)}, includeInactive: true) {
          quantities(names: ["available"]) { name quantity }
        }`
  ).join('\n        ');

  const query = `
    query readVariantInventory($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          product { status }
          inventoryItem {
        ${locationFields}
          }
        }
      }
    }
  `;

  const batches = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

  const tasks = batches.map((batch, batchIndex) => async () => {
    try {
      const response = await requestReliable(client, query, { ids: batch }, { label: `${label} batch ${batchIndex}`, isAborted });
      const nodes = response.data.nodes;
      if (!Array.isArray(nodes) || nodes.length !== batch.length) {
        throw new Error(`expected ${batch.length} results, got ${Array.isArray(nodes) ? nodes.length : 'none'}`);
      }
      batch.forEach((id, i) => {
        const node = nodes[i];
        if (!node) { gone.push(id); return; }                          // deleted
        if (node.id !== id) { unverified.push(id); return; }            // should never happen
        if (node.product?.status !== 'ACTIVE') { gone.push(id); return; } // archived / draft
        quantities[id] = locationIds.map((_, j) =>
          node.inventoryItem?.[`loc${j}`]?.quantities?.find(q => q.name === 'available')?.quantity ?? 0
        );
      });
    } catch (e) {
      if (e instanceof RequestAbortedError) throw e;
      console.error(`[${label}] batch ${batchIndex} could not be read after all retries (${batch.length} variants): ${e.message}`);
      unverified.push(...batch);
    }
  });

  await runInWaves(tasks, CONCURRENCY, isAborted);
  return { quantities, gone, unverified };
}

// For items that only have a barcode (CSV import): find the Active variant it
// belongs to. Exactly one Active match → its ID. No match, or several
// candidates that can't be told apart → notFound. Request failed after all
// retries → unverified.
async function resolveBarcodes(client, barcodes, { isAborted, label = 'barcode-resolve' } = {}) {
  const list = [...new Set((barcodes || []).filter(Boolean))];
  const idByBarcode = {};
  const notFound = [];
  const unverified = [];

  const query = `
    query resolveBarcode($q: String!) {
      productVariants(first: 10, query: $q) {
        nodes { id barcode sku }
      }
    }
  `;
  // Quoted value: barcodes with spaces, colons or a leading "-" can't break the search.
  const quote = (v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`;

  const tasks = list.map(barcode => async () => {
    try {
      const response = await requestReliable(client, query, { q: activeFilter(`barcode:${quote(barcode)}`) }, { label, isAborted });
      const nodes = response.data.productVariants?.nodes || [];
      let match = nodes.length === 1 ? nodes[0] : null;
      if (!match && nodes.length > 1) {
        const exact = nodes.filter(n => n.barcode === barcode || n.sku === barcode);
        if (exact.length === 1) match = exact[0];
      }
      if (match) idByBarcode[barcode] = match.id;
      else notFound.push(barcode);
    } catch (e) {
      if (e instanceof RequestAbortedError) throw e;
      console.error(`[${label}] barcode ${barcode} could not be resolved after all retries: ${e.message}`);
      unverified.push(barcode);
    }
  });

  await runInWaves(tasks, 4, isAborted);
  return { idByBarcode, notFound, unverified };
}

module.exports = {
  requestReliable,
  readVariantInventory,
  resolveBarcodes,
  isRetriable,
  RequestAbortedError,
  // exported for tests (they shorten the waits)
  _internals: { config, throttleWaitMs },
};
