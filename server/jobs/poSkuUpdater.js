// Core "Update SKU" logic for the PO Receiving (Purchasing) feature.
//
// Every variant may carry up to 4 "metafield groups" describing which
// supplier(s) it is bought from. Each group has a "name" metafield and a
// "code" metafield (configured in Settings → Metafields). Group order
// matters: for a single-supplier update we stop at the first group whose
// name value matches that supplier's name (case-sensitive, exact). For the
// global update (Settings → SKU & supplier code) we check every group on
// every variant, since one variant can carry more than one supplier at once
// (e.g. group 1 = Supplier A, group 2 = Supplier B).
//
// "Package size" is a single global metafield (not per-group) read at the
// same time and stored on po_supplier_skus.pack_size.
//
// Matching a supplier's own SKU list is additive/update-only: an existing
// (supplier_id, code) mapping is never deleted here, even if this run no
// longer finds it — per product decision, stale mappings are left in place
// for the buyer to clean up manually.

const { pool } = require('../database/init');

let singleSupplierStatus = { isRunning: false, supplierId: null, startedAt: null, finishedAt: null, error: null };
let globalStatus = { isRunning: false, types: [], startedAt: null, finishedAt: null, error: null, unregisteredSuppliers: [] };

function getSingleSupplierStatus() {
  return singleSupplierStatus;
}

function getGlobalStatus() {
  return globalStatus;
}

// namespace.key string -> { namespace, key }
function splitNamespaceKey(namespaceKey) {
  if (!namespaceKey || !namespaceKey.includes('.')) return null;
  const idx = namespaceKey.indexOf('.');
  return { namespace: namespaceKey.slice(0, idx), key: namespaceKey.slice(idx + 1) };
}

async function getMetafieldSettings() {
  const res = await pool.query(
    `SELECT key, value FROM app_settings WHERE key IN ('po_package_size_metafield', 'po_metafield_groups')`
  );
  const map = {};
  res.rows.forEach(r => { map[r.key] = r.value; });
  return {
    packageSize: map['po_package_size_metafield'] || null, // { type: 'product'|'variant', namespaceKey }
    groups: map['po_metafield_groups'] || [],               // [{ name: {type, namespaceKey}, code: {type, namespaceKey} }, ...]
  };
}

// Builds the GraphQL alias fields for a given metafield config at product or variant level.
// Returns { productFields: string, variantFields: string, aliasMap: [{alias, level, purpose, groupIndex}] }
function buildMetafieldAliases(packageSize, groups) {
  const productFields = [];
  const variantFields = [];
  const aliasMap = [];

  const addField = (level, namespaceKey, alias, meta) => {
    const parsed = splitNamespaceKey(namespaceKey);
    if (!parsed) return;
    const gql = `${alias}: metafield(namespace: "${parsed.namespace}", key: "${parsed.key}") { value }`;
    if (level === 'product') productFields.push(gql);
    else variantFields.push(gql);
    aliasMap.push({ alias, ...meta });
  };

  if (packageSize && packageSize.namespaceKey) {
    addField(packageSize.type === 'product' ? 'product' : 'variant', packageSize.namespaceKey, 'pkgSize', { purpose: 'packageSize' });
  }

  groups.forEach((g, i) => {
    if (g?.name?.namespaceKey) {
      addField(g.name.type === 'product' ? 'product' : 'variant', g.name.namespaceKey, `grp${i}Name`, { purpose: 'name', groupIndex: i });
    }
    if (g?.code?.namespaceKey) {
      addField(g.code.type === 'product' ? 'product' : 'variant', g.code.namespaceKey, `grp${i}Code`, { purpose: 'code', groupIndex: i });
    }
  });

  return { productFields, variantFields, aliasMap };
}

async function shopifyRequest(client, query, variables = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return variables ? await client.request(query, { variables }) : await client.request(query);
    } catch (e) {
      const is429 = e?.response?.status === 429 || e?.message?.includes('hrottled');
      if (is429 && i < retries - 1) {
        await new Promise(r => setTimeout(r, (i + 1) * 1000));
        continue;
      }
      throw e;
    }
  }
}

// Fetches every variant of every product whose product_type is in `types`,
// with barcode, custom.name, and all configured metafield aliases attached.
// Returns a flat array of variant records.
async function fetchVariantsForTypes(client, types, packageSize, groups) {
  const { productFields, variantFields } = buildMetafieldAliases(packageSize, groups);

  const typeQuery = types.length > 0
    ? `(${types.map(t => `product_type:"${t}"`).join(' OR ')})`
    : 'status:active';

  const gqlQuery = `
    query getVariantsForTypes($queryString: String!, $cursor: String) {
      products(first: 100, query: $queryString, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            productType
            ${productFields.join('\n')}
            variants(first: 100) {
              edges {
                node {
                  id
                  barcode
                  customName: metafield(namespace: "custom", key: "name") { value }
                  ${variantFields.join('\n')}
                }
              }
            }
          }
        }
      }
    }
  `;

  const variants = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await shopifyRequest(client, gqlQuery, { queryString: typeQuery, cursor });
    const page = response?.data?.products;
    if (!page) break;
    for (const { node: product } of page.edges) {
      for (const { node: variant } of product.variants.edges) {
        variants.push({ product, variant });
      }
      // small politeness delay handled by pagination cadence below
    }
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
    if (hasNextPage) await new Promise(r => setTimeout(r, 300));
  }

  return variants;
}

function readAliasValue(product, variant, alias) {
  return product?.[alias]?.value ?? variant?.[alias]?.value ?? null;
}

function readPackageSize(product, variant) {
  const raw = readAliasValue(product, variant, 'pkgSize');
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

async function upsertMapping({ supplierId, code, sku, productType, packSize, fallbackName }) {
  await pool.query(
    `INSERT INTO po_supplier_skus (supplier_id, code, sku, name, product_type, pack_size, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (supplier_id, code) DO UPDATE SET
       sku          = EXCLUDED.sku,
       product_type = EXCLUDED.product_type,
       pack_size    = EXCLUDED.pack_size,
       updated_at   = NOW()`,
    [supplierId, code, sku, fallbackName || null, productType || null, packSize]
  );
}

// Runs Update SKU for exactly one supplier, scanning only the product types
// that supplier carries. Stops at the first matching group per variant.
async function runSingleSupplierUpdate(supplierId) {
  if (singleSupplierStatus.isRunning) {
    throw new Error('An Update SKU run is already in progress');
  }
  singleSupplierStatus = { isRunning: true, supplierId, startedAt: new Date().toISOString(), finishedAt: null, error: null };

  try {
    const supplierRes = await pool.query('SELECT * FROM po_suppliers WHERE id = $1', [supplierId]);
    if (supplierRes.rows.length === 0) throw new Error('Supplier not found');
    const supplier = supplierRes.rows[0];

    const { packageSize, groups } = await getMetafieldSettings();
    if (groups.length === 0) throw new Error('No metafield groups configured in Settings');

    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const records = await fetchVariantsForTypes(client, supplier.types_carrying || [], packageSize, groups);

    let matched = 0;
    for (const { product, variant } of records) {
      if (!variant.barcode) continue;
      for (let i = 0; i < groups.length; i++) {
        const nameVal = readAliasValue(product, variant, `grp${i}Name`);
        if (nameVal === null || nameVal === '') continue;
        if (nameVal !== supplier.name) continue; // exact, case-sensitive
        const codeVal = readAliasValue(product, variant, `grp${i}Code`);
        if (!codeVal) break; // matched name but no code value — nothing to map, don't check other groups either
        await upsertMapping({
          supplierId,
          code: codeVal,
          sku: variant.barcode,
          productType: product.productType,
          packSize: readPackageSize(product, variant),
          fallbackName: variant.customName?.value || product.productType || null,
        });
        matched++;
        break; // this supplier only matches one group per variant
      }
    }

    singleSupplierStatus = { isRunning: false, supplierId, startedAt: singleSupplierStatus.startedAt, finishedAt: new Date().toISOString(), error: null, matched };
    return { matched };
  } catch (e) {
    singleSupplierStatus = { isRunning: false, supplierId, startedAt: singleSupplierStatus.startedAt, finishedAt: new Date().toISOString(), error: e.message };
    throw e;
  }
}

// Runs the global Settings → "SKU & supplier code" update for the given
// product types. Every group on every variant is checked (unlike the
// single-supplier run) because one variant can belong to several suppliers
// at once. Names that don't match any known supplier are collected and
// returned so the UI can prompt "unregistered supplier found".
async function runGlobalUpdate(types) {
  if (globalStatus.isRunning) {
    throw new Error('An Update run is already in progress');
  }
  globalStatus = { isRunning: true, types, startedAt: new Date().toISOString(), finishedAt: null, error: null, unregisteredSuppliers: [] };

  try {
    const { packageSize, groups } = await getMetafieldSettings();
    if (groups.length === 0) throw new Error('No metafield groups configured in Settings');

    const suppliersRes = await pool.query('SELECT id, name FROM po_suppliers');
    const supplierByName = new Map(suppliersRes.rows.map(s => [s.name, s.id]));

    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const records = await fetchVariantsForTypes(client, types, packageSize, groups);

    const unregistered = new Map(); // name -> sample product title/type

    for (const { product, variant } of records) {
      if (!variant.barcode) continue;
      for (let i = 0; i < groups.length; i++) {
        const nameVal = readAliasValue(product, variant, `grp${i}Name`);
        if (nameVal === null || nameVal === '') continue;
        const supplierId = supplierByName.get(nameVal);
        if (!supplierId) {
          if (!unregistered.has(nameVal)) unregistered.set(nameVal, product.productType || '');
          continue;
        }
        const codeVal = readAliasValue(product, variant, `grp${i}Code`);
        if (!codeVal) continue;
        await upsertMapping({
          supplierId,
          code: codeVal,
          sku: variant.barcode,
          productType: product.productType,
          packSize: readPackageSize(product, variant),
          fallbackName: variant.customName?.value || product.productType || null,
        });
      }
    }

    const now = new Date().toISOString();
    for (const t of types) {
      const historyRes = await pool.query(`SELECT value FROM app_settings WHERE key = 'po_type_update_history'`);
      const history = historyRes.rows[0]?.value || {};
      history[t] = { lastUpdatedAt: now };
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('po_type_update_history', $1::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
        [JSON.stringify(history)]
      );
    }

    const unregisteredSuppliers = Array.from(unregistered.entries()).map(([name, sampleType]) => ({ name, sampleType }));
    globalStatus = { isRunning: false, types, startedAt: globalStatus.startedAt, finishedAt: now, error: null, unregisteredSuppliers };
    return { unregisteredSuppliers };
  } catch (e) {
    globalStatus = { isRunning: false, types, startedAt: globalStatus.startedAt, finishedAt: new Date().toISOString(), error: e.message, unregisteredSuppliers: [] };
    throw e;
  }
}

module.exports = {
  runSingleSupplierUpdate,
  runGlobalUpdate,
  getSingleSupplierStatus,
  getGlobalStatus,
  getMetafieldSettings,
};
