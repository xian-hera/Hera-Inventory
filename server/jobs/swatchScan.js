// Online › Swatch — product scan (spec §5.4 / §5.6).
// Reads every Active product with a bulk operation, keeps the products that
// hit a replacement rule (§3), and stores one row per vendor + colour code in
// swatch_scan_codes. The management list is built from these rows.
const { pool } = require('../database/init');
const { gql, userErrorText, sleep } = require('../services/shopifyGql');
const { codeKey } = require('../services/swatchMatch');
const { getConfig, ruleOptionFor, getScanMeta, setScanMeta } = require('../services/swatchStore');

let running = null;

async function locationId(name) {
  const r = await pool.query('SELECT shopify_location_id FROM location_map WHERE location_name = $1', [name]);
  return r.rows.length ? r.rows[0].shopify_location_id : null;
}

function bulkQuery(locId) {
  const level = locId
    ? `inventoryItem { inventoryLevel(locationId: ${JSON.stringify(locId)}) { quantities(names: ["available"]) { quantity } } }`
    : '';
  return `{
    products(query: "status:active") {
      edges { node {
        id title vendor productType
        options { name }
        variants { edges { node {
          id sku availableForSale inventoryQuantity
          selectedOptions { name value }
          metafield(namespace: "custom", key: "discontinued") { value }
          ${level}
        } } }
      } }
    }
  }`;
}

async function runBulk(query) {
  const start = await gql(`
    mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`,
  { q: query });
  const err = userErrorText(start.bulkOperationRunQuery);
  if (err) throw new Error(`bulkOperationRunQuery: ${err}`);
  const id = start.bulkOperationRunQuery.bulkOperation.id;
  const began = Date.now();
  for (;;) {
    await sleep(3000);
    const d = await gql(`query($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode objectCount url } } }`, { id });
    const op = d.node;
    if (op.status === 'COMPLETED') return op.url; // null when nothing matched
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(op.status)) throw new Error(`Bulk operation ${op.status} ${op.errorCode || ''}`.trim());
    if (Date.now() - began > 30 * 60 * 1000) throw new Error('Bulk operation took longer than 30 minutes');
    if (running) running.objects = Number(op.objectCount || 0);
  }
}

async function scan() {
  const cfg = await getConfig();
  const locName = cfg.suggestIgnore.locationName;
  const minTotal = Number(cfg.suggestIgnore.minTotal) || 0;
  const locId = await locationId(locName);

  const url = await runBulk(bulkQuery(locId));
  const products = new Map();
  if (url) {
    const text = await (await fetch(url)).text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (!o.__parentId) products.set(o.id, { ...o, variants: [] });
      else if (products.has(o.__parentId)) products.get(o.__parentId).variants.push(o);
    }
  }

  const groups = new Map(); // vendor|key -> row
  let hitProducts = 0;
  for (const p of products.values()) {
    const opt = ruleOptionFor(cfg.rules, p.productType, (p.options || []).map(o => o.name));
    if (!opt) continue;
    hitProducts++;
    const pid = p.id.split('/').pop();
    for (const v of p.variants) {
      const so = (v.selectedOptions || []).find(s => s.name === opt);
      if (!so) continue;
      const key = codeKey(so.value);
      if (!key) continue;
      const gk = `${p.vendor}\u0000${key}`;
      if (!groups.has(gk)) groups.set(gk, { vendor: p.vendor, code: so.value, key, products: new Map(), variants: 0, hidden: 0, flagged: 0 });
      const g = groups.get(gk);
      g.products.set(pid, p.title);
      g.variants++;
      const disc = !!(v.metafield && String(v.metafield.value) === 'true');
      if (!v.availableForSale && disc) g.hidden++;
      const lvl = v.inventoryItem && v.inventoryItem.inventoryLevel;
      const atLoc = lvl && lvl.quantities && lvl.quantities[0] ? Number(lvl.quantities[0].quantity) : 0;
      const total = Number(v.inventoryQuantity || 0);
      if (disc && atLoc <= 0 && total < minTotal) g.flagged++;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM swatch_scan_codes');
    for (const g of groups.values()) {
      await client.query(
        `INSERT INTO swatch_scan_codes (vendor, code, code_key, products, variant_count, hidden, suggest_ignore)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [g.vendor, g.code, g.key,
          JSON.stringify([...g.products].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title))),
          g.variants, g.hidden === g.variants, g.flagged === g.variants]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { products: products.size, hitProducts, codes: groups.size, locationFound: !!locId };
}

// Starts a scan in the background unless one is already running.
async function startScan() {
  if (running) return getScanStatus();
  running = { startedAt: new Date().toISOString(), objects: 0 };
  await setScanMeta({ ...(await getScanMeta()), status: 'running', startedAt: running.startedAt, error: null });
  scan()
    .then(async r => {
      await setScanMeta({ status: 'done', startedAt: running.startedAt, finishedAt: new Date().toISOString(), error: null, ...r });
    })
    .catch(async e => {
      console.error('[swatch scan] failed:', e);
      const prev = await getScanMeta();
      await setScanMeta({ ...prev, status: 'failed', error: e.message, failedAt: new Date().toISOString() });
    })
    .finally(() => { running = null; });
  return getScanStatus();
}

async function getScanStatus() {
  const meta = await getScanMeta();
  if (running) return { ...meta, status: 'running', objects: running.objects };
  // A "running" left behind by a server restart is not running any more.
  if (meta.status === 'running') return { ...meta, status: 'failed', error: 'Interrupted (server restarted)' };
  return meta;
}

module.exports = { startScan, getScanStatus };
