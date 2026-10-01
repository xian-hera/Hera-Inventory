// Online › Swatch — Shopify side: Files upload / update / delete and the
// app-data metafield sync read by the theme app extension (spec §2, §5.1).
const { pool } = require('../database/init');
const { gql, userErrorText, sleep } = require('./shopifyGql');
const { getConfig } = require('./swatchStore');

const NAMESPACE = 'hera_swatch';
const MAX_METAFIELD_BYTES = 120000; // Shopify JSON metafield limit is 128KB (§2)

// ─── Naming (Hera 2026-10-01) ────────────────────────────────────────────────
// File name: Hera_swatch_{prefix}_{original file name}
// Alt text : {library name} – {codes, comma separated}
const shopifyFileName = (prefix, originalName) => `Hera_swatch_${prefix}_${originalName}`;
// (no codes yet -> just the library name)
const altText = (libraryName, codes) => (codes && codes.length ? `${libraryName} – ${[...codes].sort().join(', ')}` : libraryName);

function guessMime(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'application/octet-stream';
}

// ─── Upload ──────────────────────────────────────────────────────────────────
async function stagedUpload(filename, mimeType, buffer) {
  const data = await gql(`
    mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`, { input: [{ resource: 'IMAGE', filename, mimeType, httpMethod: 'POST', fileSize: String(buffer.length) }] });
  const err = userErrorText(data.stagedUploadsCreate);
  if (err) throw new Error(`stagedUploadsCreate: ${err}`);
  const t = data.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of t.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch(t.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload to Shopify storage failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return t.resourceUrl;
}

const FILE_FIELDS = `
  id fileStatus alt
  fileErrors { code message details }
  ... on MediaImage { image { url width height } }
`;

// Wait until Shopify has processed the file (fileCreate / fileUpdate are async).
async function waitReady(fileId, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    const data = await gql(`query($id: ID!) { node(id: $id) { ${FILE_FIELDS} } }`, { id: fileId });
    const f = data.node;
    if (!f) throw new Error('File not found after upload');
    if (f.fileStatus === 'READY' && f.image && f.image.url) return f;
    if (f.fileStatus === 'FAILED') {
      throw new Error(`Shopify could not process the file: ${(f.fileErrors || []).map(e => e.message || e.code).join('; ') || 'FAILED'}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for Shopify to process the file');
    await sleep(1500);
  }
}

// "https://cdn.shopify.com/s/files/1/…/files/Hera_swatch_out_1B.jpg?v=123" -> "Hera_swatch_out_1B.jpg"
function filenameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop());
  } catch (e) {
    return null;
  }
}

async function findFileByName(filename) {
  const q = `filename:${JSON.stringify(filename)}`;
  const data = await gql(`query($q: String!) { files(first: 5, query: $q) { nodes { id ... on MediaImage { image { url } } } } }`, { q });
  return (data.files.nodes || []).filter(n => n.image && filenameFromUrl(n.image.url) === filename);
}

// Create a new file. Returns { id, filename, url, width, height }.
async function createFile({ filename, alt, buffer, mimeType }) {
  const existing = await findFileByName(filename);
  if (existing.length) throw new Error(`A file named "${filename}" already exists in Shopify Files`);
  const source = await stagedUpload(filename, mimeType, buffer);
  const data = await gql(`
    mutation($files: [FileCreateInput!]!) {
      fileCreate(files: $files) { files { id fileStatus } userErrors { field message code } }
    }`, { files: [{ originalSource: source, contentType: 'IMAGE', alt, filename, duplicateResolutionMode: 'RAISE_ERROR' }] });
  const err = userErrorText(data.fileCreate);
  if (err) throw new Error(`fileCreate: ${err}`);
  const f = await waitReady(data.fileCreate.files[0].id);
  return { id: f.id, filename: filenameFromUrl(f.image.url), url: f.image.url, width: f.image.width, height: f.image.height };
}

// Replace the picture of an existing file (same Shopify file id, same name).
async function replaceFileContent({ fileId, filename, buffer, mimeType }) {
  const source = await stagedUpload(filename, mimeType, buffer);
  const data = await gql(`
    mutation($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) { files { id } userErrors { field message code } }
    }`, { files: [{ id: fileId, originalSource: source }] });
  const err = userErrorText(data.fileUpdate);
  if (err) throw new Error(`fileUpdate: ${err}`);
  await sleep(1500);
  const f = await waitReady(fileId);
  return { id: f.id, filename: filenameFromUrl(f.image.url), url: f.image.url, width: f.image.width, height: f.image.height };
}

async function updateAlt(fileId, alt) {
  const data = await gql(`
    mutation($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) { files { id } userErrors { field message code } }
    }`, { files: [{ id: fileId, alt }] });
  const err = userErrorText(data.fileUpdate);
  if (err) throw new Error(`fileUpdate (alt): ${err}`);
}

async function deleteFile(fileId) {
  const data = await gql(`
    mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds userErrors { field message code } } }`,
  { ids: [fileId] });
  const err = userErrorText(data.fileDelete);
  // A file someone already removed in Shopify admin is not an error for us.
  if (err && !/not\s*found|does not exist/i.test(err)) throw new Error(`fileDelete: ${err}`);
}

// Re-write an image's alt text from its current codes.
async function refreshAlt(imageId) {
  const r = await pool.query(`
    SELECT i.shopify_file_id, l.name, COALESCE(array_agg(c.code) FILTER (WHERE c.id IS NOT NULL), '{}') AS codes
    FROM swatch_images i JOIN swatch_libraries l ON l.id = i.library_id
    LEFT JOIN swatch_codes c ON c.image_id = i.id WHERE i.id = $1
    GROUP BY i.id, l.name`, [imageId]);
  const row = r.rows[0];
  if (!row || !row.shopify_file_id) return;
  const alt = altText(row.name, row.codes);
  await updateAlt(row.shopify_file_id, alt);
  await pool.query('UPDATE swatch_images SET alt = $2, updated_at = NOW() WHERE id = $1', [imageId, alt]);
}

// ─── Metafield sync (§2) ─────────────────────────────────────────────────────
// hera_swatch.config      rules, vendor -> library prefix, style, text, icons
// hera_swatch.lib_{prefix} { "v":1, "codes": { "<code key>": { "f": file name, "p"?: position } } }
// Liquid builds image URLs with {{ f | file_url }}, so only file names are stored.
async function buildPayload() {
  const cfg = await getConfig();
  const libs = (await pool.query('SELECT * FROM swatch_libraries ORDER BY id')).rows;
  const rows = (await pool.query(`
    SELECT c.library_id, c.code_key, i.filename, i.position
    FROM swatch_codes c JOIN swatch_images i ON i.id = c.image_id
    WHERE i.filename IS NOT NULL ORDER BY c.code_key`)).rows;

  const vendorLibrary = {};
  for (const l of libs) for (const v of l.vendors) vendorLibrary[v] = l.prefix;

  const config = {
    version: 1,
    updatedAt: new Date().toISOString(),
    rules: cfg.rules.map(r => ({ optionName: r.optionName, caseSensitive: !!r.caseSensitive, productTypes: r.productTypes || [] })),
    selector: cfg.selector,
    vendorLibrary,
    style: cfg.style,
    text: cfg.text,
    icons: cfg.icons,
  };
  const metafields = { config };
  for (const l of libs) {
    const codes = {};
    for (const row of rows.filter(x => x.library_id === l.id)) {
      codes[row.code_key] = row.position ? { f: row.filename, p: row.position } : { f: row.filename };
    }
    metafields[`lib_${l.prefix}`] = { v: 1, codes };
  }
  return metafields;
}

async function syncSwatchMetafield() {
  const payload = await buildPayload();
  const sizes = {};
  for (const [key, value] of Object.entries(payload)) {
    sizes[key] = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (sizes[key] > MAX_METAFIELD_BYTES) {
      throw new Error(`hera_swatch.${key} would be ${sizes[key]} bytes (limit ${MAX_METAFIELD_BYTES}); nothing was written`);
    }
  }
  const inst = await gql(`{ currentAppInstallation { id metafields(first: 100, namespace: "${NAMESPACE}") { nodes { key } } } }`);
  const ownerId = inst.currentAppInstallation.id;
  const entries = Object.entries(payload);
  for (let i = 0; i < entries.length; i += 20) {
    const chunk = entries.slice(i, i + 20).map(([key, value]) => ({ ownerId, namespace: NAMESPACE, key, type: 'json', value: JSON.stringify(value) }));
    const out = await gql(`
      mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { key } userErrors { field message code } } }`,
    { m: chunk });
    const err = userErrorText(out.metafieldsSet);
    if (err) throw new Error(`metafieldsSet: ${err}`);
  }
  // Remove lib_* metafields of libraries that no longer exist.
  const stale = inst.currentAppInstallation.metafields.nodes.map(n => n.key).filter(k => k.startsWith('lib_') && !payload[k]);
  if (stale.length) {
    const out = await gql(`
      mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { deletedMetafields { key } userErrors { field message } } }`,
    { m: stale.map(key => ({ ownerId, namespace: NAMESPACE, key })) });
    const err = userErrorText(out.metafieldsDelete);
    if (err) throw new Error(`metafieldsDelete: ${err}`);
  }
  const syncedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('swatch_last_sync', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify({ syncedAt, sizes, removed: stale })]);
  return { syncedAt, sizes, removed: stale };
}

module.exports = {
  NAMESPACE, shopifyFileName, altText, guessMime,
  createFile, replaceFileContent, updateAlt, deleteFile, refreshAlt, findFileByName,
  buildPayload, syncSwatchMetafield,
};
