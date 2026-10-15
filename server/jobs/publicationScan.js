// Online › Publication — background scan + bulk publish / unpublish
// (2026-10-15, Hera). Spec: claude/PUBLICATION_FEATURE_SPEC.md §4.
//
// Scan: one bulk operation over productVariants (Active products of the chosen
// types). For every variant it reads, per publication, whether the variant AND
// its product are published (variant-level publishing, API 2026-07), the two
// metafields chosen in Settings, the quantity at the fulfillment location and
// the quantity summed over every location. Filtering happens here, and the
// matching rows go to publication_scan_items (only the latest scan is kept).
//
// Products with only the default variant ("no variants") are judged by the
// PRODUCT's publications, and publish/unpublish act on the product and its
// variant together (spec §4.4). Otherwise only the variant is touched.
const { pool } = require('../database/init');
const { gql, userErrorText, sleep, searchQuote } = require('../services/shopifyGql');
const { listPublications } = require('../services/productData');
const { getSettings, missingForScan } = require('../services/publicationSettings');

let runningScan = null;   // { id, objects }
let runningAction = null; // { id, kind, total, done, failed: [], succeeded, finishedAt, error }
const actions = new Map(); // id -> action status (kept in memory; no history, spec §4.5)
let actionSeq = 0;

const fail = (status, message) => Object.assign(new Error(message), { status });

// ─── Scan ────────────────────────────────────────────────────────────────────
const COMPARES = ['lt', 'gt', 'eq'];
const DISCONTINUED = ['true', 'false', 'empty'];

function cleanParams(body) {
  const b = body || {};
  const types = Array.isArray(b.types) ? [...new Set(b.types.map(String).filter(Boolean))] : [];
  const channels = Array.isArray(b.channels) ? [...new Set(b.channels.map(String).filter(Boolean))] : [];
  if (!types.length) throw fail(400, 'Choose at least one Type.');
  if (!channels.length) throw fail(400, 'Choose at least one Channel.');
  const published = b.published === 'no' ? 'no' : (b.published === 'yes' ? 'yes' : null);
  if (!published) throw fail(400, 'Choose Published Yes or No.');
  const discontinued = DISCONTINUED.includes(b.discontinued) ? b.discontinued : null;
  if (!discontinued) throw fail(400, 'Choose Discontinued True, False or Empty.');
  const qty = (q, label) => {
    const o = q || {};
    if (!COMPARES.includes(o.compare)) throw fail(400, `${label}: choose less than, more than or equals to.`);
    const n = Number(o.value);
    if (!Number.isInteger(n) || n < 0) throw fail(400, `${label}: enter a whole number (0 or more).`);
    return { compare: o.compare, value: n };
  };
  return {
    types, channels, published, discontinued,
    // "Product matches too" (Hera 2026-10-15): the product must also be in the
    // wanted state on every chosen channel, not only the variant.
    productToo: b.productToo === true,
    fulfillmentQty: qty(b.fulfillmentQty, 'Fulfillment Qty'),
    totalQty: qty(b.totalQty, 'Total Qty'),
  };
}

function compare(n, q) {
  if (q.compare === 'lt') return n < q.value;
  if (q.compare === 'gt') return n > q.value;
  return n === q.value;
}

function metaState(m) {
  const v = m && m.value != null ? String(m.value).trim().toLowerCase() : '';
  if (!v) return 'empty';
  if (v === 'true') return 'true';
  if (v === 'false') return 'false';
  return 'other';
}

// product_status must be lowercase: tested 2026-10-15 on the live store,
// productVariants(query: "product_status:ACTIVE") matches NOTHING (the docs'
// uppercase example is wrong), while "product_status:active" works. With the
// uppercase value every scan came back empty.
function bulkQuery({ types, pubs, settings, locationId }) {
  const q = `product_status:active AND (${types.map(t => `product_type:${searchQuote(t)}`).join(' OR ')})`;
  const pubFields = pubs.map((p, i) => `p${i}: publishedOnPublication(publicationId: ${JSON.stringify(p.id)})`).join('\n            ');
  const mf = (alias, m) => `${alias}: metafield(namespace: ${JSON.stringify(m.namespace)}, key: ${JSON.stringify(m.key)}) { value }`;
  const productMeta = [];
  const variantMeta = [];
  (settings.discontinued.owner === 'product' ? productMeta : variantMeta).push(mf('disc', settings.discontinued));
  (settings.posOnly.owner === 'product' ? productMeta : variantMeta).push(mf('pos', settings.posOnly));
  const qtyName = JSON.stringify(settings.qty);
  return `{
    productVariants(query: ${JSON.stringify(q)}) {
      edges { node {
        id title
        ${pubFields}
        ${variantMeta.join('\n        ')}
        product {
          id title vendor hasOnlyDefaultVariant
          ${pubFields}
          ${productMeta.join('\n          ')}
        }
        inventoryItem {
          fulfil: inventoryLevel(locationId: ${JSON.stringify(locationId)}) { quantities(names: [${qtyName}]) { name quantity } }
          inventoryLevels { edges { node { quantities(names: [${qtyName}]) { name quantity } } } }
        }
      } }
    }
  }`;
}

async function runBulk(query, onCount) {
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
    onCount(Number(op.objectCount || 0));
  }
}

const qtyOf = (level) => {
  const q = level && level.quantities && level.quantities[0];
  return q ? Number(q.quantity) || 0 : 0;
};

// One variant against the filters. Returns every check
// and the table row.
function evaluate(v, levelList, params, settings, pubs) {
  const p = v.product || {};
  const isDefault = !!p.hasOnlyDefaultVariant;
  const published = (obj) => new Set(pubs.filter((x, i) => obj && obj[`p${i}`] === true).map(x => x.id));
  // §4.4: a product with only the default variant is judged by the product.
  const on = published(isDefault ? p : v);
  const productOn = published(p);
  const wantOn = params.published === 'yes';
  const disc = metaState(settings.discontinued.owner === 'product' ? p.disc : v.disc);
  const fulfilQty = qtyOf(v.inventoryItem && v.inventoryItem.fulfil);
  const totalQty = levelList.reduce((s, l) => s + qtyOf(l), 0);
  const checks = {
    published: params.channels.every(id => on.has(id) === wantOn)
      && (!params.productToo || params.channels.every(id => productOn.has(id) === wantOn)),
    discontinued: disc === params.discontinued,
    fulfillmentQty: compare(fulfilQty, params.fulfillmentQty),
    totalQty: compare(totalQty, params.totalQty),
  };
  const pos = metaState(settings.posOnly.owner === 'product' ? p.pos : v.pos);
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    values: { isDefault, publishedOn: pubs.filter(x => on.has(x.id)).map(x => x.name), discontinued: disc, fulfilQty, totalQty },
    row: {
      productId: p.id, variantId: v.id, isDefault,
      title: p.title || '', variantName: isDefault ? '' : (v.title || ''), vendor: p.vendor || '',
      posOnly: pos === 'true' ? 'True' : (pos === 'false' ? 'False' : ''),
      fulfilQty, totalQty, pubIds: [...on],
    },
  };
}

// Reads the bulk result file: variants by id + inventory level lines by variant id.
async function readBulk(url) {
  // Lines come ungrouped (API 2026-01+): a level line may arrive before its
  // variant, so collect everything first and join afterwards.
  const variants = new Map();
  const levels = new Map(); // variant id -> [level]
  if (url) {
    const text = await (await fetch(url)).text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o.__parentId) {
        if (!levels.has(o.__parentId)) levels.set(o.__parentId, []);
        levels.get(o.__parentId).push(o);
      } else if (o.id && o.id.includes('/ProductVariant/')) {
        variants.set(o.id, o);
      }
    }
  }
  return { variants, levels };
}

async function scan(scanId, params, settings) {
  const loc = await pool.query('SELECT shopify_location_id FROM location_map WHERE location_name = $1', [settings.fulfillmentLocation]);
  if (!loc.rows.length || !loc.rows[0].shopify_location_id) throw new Error(`Location ${settings.fulfillmentLocation} was not found in the location map.`);
  const pubs = await listPublications();
  const pubIndex = new Map(pubs.map((p, i) => [p.id, i]));
  const missing = params.channels.filter(id => !pubIndex.has(id));
  if (missing.length) throw new Error('A chosen channel no longer exists in Shopify. Reload the page and choose again.');

  const url = await runBulk(bulkQuery({ types: params.types, pubs, settings, locationId: loc.rows[0].shopify_location_id }),
    n => { if (runningScan) runningScan.objects = n; });

  const { variants, levels } = await readBulk(url);

  const rows = [];
  for (const v of variants.values()) {
    const r = evaluate(v, levels.get(v.id) || [], params, settings, pubs);
    if (r.pass) rows.push(r.row);
  }
  rows.sort((a, b) => a.title.localeCompare(b.title) || a.variantName.localeCompare(b.variantName));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only the latest scan is kept.
    await client.query('DELETE FROM publication_scans WHERE id <> $1', [scanId]);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = [];
      const args = [];
      chunk.forEach((r, j) => {
        const b = j * 11;
        values.push(`(${Array.from({ length: 11 }, (_, k) => `$${b + k + 1}`).join(',')})`);
        args.push(scanId, r.productId, r.variantId, r.isDefault, r.title, r.variantName, r.vendor, r.posOnly, r.fulfilQty, r.totalQty, r.pubIds);
      });
      await client.query(
        `INSERT INTO publication_scan_items (scan_id, product_id, variant_id, is_default_variant, title, variant_name, vendor, pos_only, fulfillment_qty, total_qty, publication_ids)
         VALUES ${values.join(',')}`,
        args
      );
    }
    await client.query(
      `UPDATE publication_scans SET status = 'done', objects = $2, matched = $3, finished_at = NOW(),
         params = params || $4::jsonb WHERE id = $1`,
      [scanId, variants.size, rows.length, JSON.stringify({ channelNames: Object.fromEntries(pubs.map(p => [p.id, p.name])) })]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function startScan(body) {
  if (runningScan) throw fail(409, 'A scan is already running.');
  if (runningAction) throw fail(409, 'Wait for the publish / unpublish to finish first.');
  const settings = await getSettings();
  const missing = missingForScan(settings);
  if (missing.length) throw fail(400, `Set ${missing.join(', ')} in Settings first.`);
  const params = cleanParams(body);
  const stored = { ...params, fulfillmentLocation: settings.fulfillmentLocation, qty: settings.qty };
  const r = await pool.query(`INSERT INTO publication_scans (status, params) VALUES ('running', $1::jsonb) RETURNING id`, [JSON.stringify(stored)]);
  const id = r.rows[0].id;
  runningScan = { id, objects: 0 };
  scan(id, params, settings)
    .catch(async e => {
      console.error('[publication scan] failed:', e);
      await pool.query(`UPDATE publication_scans SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [id, e.message]).catch(() => {});
    })
    .finally(() => { runningScan = null; });
  return getScan(id);
}

function scanRow(r) {
  if (!r) return null;
  const s = {
    id: r.id, status: r.status, params: r.params, objects: r.objects, matched: r.matched,
    error: r.error, createdAt: r.created_at, finishedAt: r.finished_at,
  };
  if (runningScan && runningScan.id === r.id) s.objects = runningScan.objects;
  // A "running" row left behind by a server restart is not running any more.
  else if (s.status === 'running') { s.status = 'failed'; s.error = 'Interrupted (server restarted). Scan again.'; }
  return s;
}

async function getScan(id) {
  const r = await pool.query('SELECT * FROM publication_scans WHERE id = $1', [id]);
  return scanRow(r.rows[0]);
}

async function getLatestScan() {
  const r = await pool.query('SELECT * FROM publication_scans ORDER BY id DESC LIMIT 1');
  return scanRow(r.rows[0]);
}

// The scan whose rows the table shows: the newest finished one (a running or
// failed newer scan does not hide the previous results).
async function getLatestDoneScan() {
  const r = await pool.query("SELECT * FROM publication_scans WHERE status = 'done' ORDER BY id DESC LIMIT 1");
  return scanRow(r.rows[0]);
}

// ─── Publish / Unpublish ─────────────────────────────────────────────────────
const MUTATION = {
  publish: `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
  unpublish: `mutation($id: ID!, $input: [PublicationInput!]!) { publishableUnpublish(id: $id, input: $input) { userErrors { field message } } }`,
};

async function runAction(action, rows, pubIds) {
  const input = pubIds.map(publicationId => ({ publicationId }));
  // Publish also publishes the PRODUCT (Hera 2026-10-15): a variant is only
  // visible on a channel when its product is published there too. Each product
  // is published once per action; its result is reused for its other rows.
  const productResult = new Map(); // product id -> error text ('' = ok)
  for (const row of rows) {
    // Unpublish: the variant only, except default-variant products (§4.4),
    // where product and variant go together.
    const withProduct = action.kind === 'publish' || row.is_default_variant;
    const targets = withProduct ? [row.product_id, row.variant_id] : [row.variant_id];
    const errors = [];
    for (const id of targets) {
      const isProduct = id === row.product_id;
      if (isProduct && productResult.has(id)) {
        if (productResult.get(id)) errors.push(`Product: ${productResult.get(id)}`);
        continue;
      }
      try {
        const d = await gql(MUTATION[action.kind], { id, input });
        const payload = d[action.kind === 'publish' ? 'publishablePublish' : 'publishableUnpublish'];
        const t = userErrorText(payload);
        if (isProduct) productResult.set(id, t);
        if (t) errors.push(isProduct ? `Product: ${t}` : t);
      } catch (e) {
        if (isProduct) productResult.set(id, e.message);
        errors.push(isProduct ? `Product: ${e.message}` : e.message);
      }
    }
    if (errors.length) {
      action.failed.push({ title: row.title, variantName: row.variant_name, reason: [...new Set(errors)].join('; ') });
    } else {
      action.succeeded++;
      const current = new Set(row.publication_ids || []);
      pubIds.forEach(id => (action.kind === 'publish' ? current.add(id) : current.delete(id)));
      await pool.query('UPDATE publication_scan_items SET publication_ids = $2 WHERE id = $1', [row.id, [...current]])
        .catch(e => console.error('[publication] row update failed:', e.message));
    }
    action.done++;
  }
}

async function startAction(kind, body) {
  if (!['publish', 'unpublish'].includes(kind)) throw fail(400, 'Unknown action');
  if (runningAction) throw fail(409, 'A publish / unpublish is already running.');
  if (runningScan) throw fail(409, 'Wait for the scan to finish first.');
  // allInScan (Hera 2026-10-15, "Select all in result"): every row of the scan
  // the page shows (scanId), instead of the rows ticked on the current page.
  const allInScan = body.allInScan === true;
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(Number).filter(Number.isInteger) : [];
  const groupIds = Array.isArray(body.groupIds) ? body.groupIds.map(Number).filter(Number.isInteger) : [];
  if (!allInScan && !itemIds.length) throw fail(400, 'Select at least one row.');
  if (!groupIds.length) throw fail(400, 'Choose at least one group.');

  const g = await pool.query('SELECT publication_ids FROM publication_channel_groups WHERE id = ANY($1)', [groupIds]);
  if (g.rows.length !== groupIds.length) throw fail(400, 'A chosen group no longer exists. Reload the page.');
  // Channels of every chosen group, de-duplicated; channels removed from Shopify are skipped.
  const live = new Set((await listPublications()).map(p => p.id));
  const pubIds = [...new Set(g.rows.flatMap(r => r.publication_ids || []))].filter(id => live.has(id));
  if (!pubIds.length) throw fail(400, 'The chosen groups have no existing channels.');

  const latest = await getLatestDoneScan();
  if (!latest) throw fail(400, 'Scan first.');
  if (allInScan && Number(body.scanId) !== latest.id) throw fail(409, 'The scan results have changed. Reload the page.');
  const rows = allInScan
    ? (await pool.query('SELECT * FROM publication_scan_items WHERE scan_id = $1 ORDER BY id', [latest.id])).rows
    : (await pool.query(
      'SELECT * FROM publication_scan_items WHERE scan_id = $1 AND id = ANY($2) ORDER BY id', [latest.id, itemIds])).rows;
  if (!rows.length) throw fail(400, 'The selected rows are no longer in the scan results. Reload the page.');

  const id = ++actionSeq;
  const action = { id, kind, total: rows.length, done: 0, succeeded: 0, failed: [], status: 'running', error: null, channels: pubIds.length };
  actions.set(id, action);
  runningAction = action;
  runAction(action, rows, pubIds)
    .then(() => { action.status = 'done'; })
    .catch(e => { console.error('[publication action] failed:', e); action.status = 'failed'; action.error = e.message; })
    .finally(() => {
      runningAction = null;
      action.finishedAt = new Date().toISOString();
      // Keep only the last few results in memory.
      for (const k of [...actions.keys()]) if (k < id - 20) actions.delete(k);
    });
  return action;
}

function getAction(id) {
  return actions.get(Number(id)) || null;
}

module.exports = { startScan, getScan, getLatestScan, getLatestDoneScan, startAction, getAction, cleanParams };
