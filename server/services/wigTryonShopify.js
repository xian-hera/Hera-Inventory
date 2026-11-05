// Online › Wig Try-on — storefront data in the app-data metafield
// hera_tryon.config (2026-11-05). The App embed "Hera Wig Try-on" (Liquid)
// reads it to decide where to show the icon and to get its texts, so a page
// load never waits for Render. Written on every settings save.
const { pool } = require('../database/init');
const { gql, userErrorText } = require('./shopifyGql');
const { getConfig } = require('./wigTryonStore');

const NAMESPACE = 'hera_tryon';

function buildPayload(cfg) {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mode: cfg.mode,
    requireLogin: cfg.requireLogin,
    colorEnabled: cfg.colorEnabled,
    // compared case-insensitively with product.type (translated names may be listed too)
    types: (cfg.eligibleTypes || []).map(t => String(t).trim().toUpperCase()).filter(Boolean),
    // Liquid: {{ iconFile | file_url }}; empty = built-in icon
    iconFile: cfg.storefront.iconFile ? cfg.storefront.iconFile.filename : '',
    iconSize: cfg.storefront.iconSize,
    iconOffset: cfg.storefront.iconOffset,
    privacyUrl: cfg.storefront.privacyUrl,
    proxyPath: cfg.storefront.proxyPath,
    gallerySelector: cfg.storefront.gallerySelector,
    // { en: { key: text }, fr: { key: text } } — Liquid outputs ui[lang] as one JSON object.
    // An empty French text falls back to English here.
    ui: {
      en: Object.fromEntries(Object.entries(cfg.ui).map(([k, v]) => [k, v.en || ''])),
      fr: Object.fromEntries(Object.entries(cfg.ui).map(([k, v]) => [k, v.fr || v.en || ''])),
    },
  };
}

async function syncTryonMetafield(cfgIn) {
  const cfg = cfgIn || await getConfig();
  const value = buildPayload(cfg);
  const inst = await gql('{ currentAppInstallation { id } }');
  const out = await gql(`
    mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { key } userErrors { field message code } } }`,
  { m: [{ ownerId: inst.currentAppInstallation.id, namespace: NAMESPACE, key: 'config', type: 'json', value: JSON.stringify(value) }] });
  const err = userErrorText(out.metafieldsSet);
  if (err) throw new Error(`metafieldsSet: ${err}`);
  const syncedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('wig_tryon_last_sync', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify({ syncedAt })]);
  return { syncedAt };
}

module.exports = { NAMESPACE, buildPayload, syncTryonMetafield };
