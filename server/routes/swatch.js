// Online › Swatch (see claude/SWATCH_FEATURE_SPEC.md).
//
// PHASE 0 (2026-10-01): only two debug endpoints, used to check that the
// Theme App Extension "Hera Swatch" can read an app-data metafield.
// The metafield lives on this app's AppInstallation (not on the shop), so
// only Hera Hub can write it and only Hera Hub's embed can read it
// (Liquid: app.metafields.hera_swatch.config).
//
//   GET  /api/swatch/debug/metafield  -> read the current value
//   POST /api/swatch/debug/metafield  -> write a small fixed test JSON
//
// In Phase 1 the real config sync (syncSwatchMetafield) replaces the test
// payload; the namespace stays the same.
const express = require('express');
const router = express.Router();
const { gql, userErrorText } = require('../services/shopifyGql');

const NAMESPACE = 'hera_swatch';
const KEY = 'config';

const READ_QUERY = `
  query SwatchMetafield($namespace: String!, $key: String!) {
    currentAppInstallation {
      id
      metafield(namespace: $namespace, key: $key) {
        id
        type
        value
        updatedAt
      }
    }
  }
`;

const SET_MUTATION = `
  mutation SwatchMetafieldSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key type updatedAt }
      userErrors { field message code }
    }
  }
`;

router.get('/debug/metafield', async (req, res) => {
  try {
    const data = await gql(READ_QUERY, { namespace: NAMESPACE, key: KEY });
    const inst = data.currentAppInstallation;
    const mf = inst && inst.metafield;
    res.json({
      appInstallationId: inst ? inst.id : null,
      namespace: NAMESPACE,
      key: KEY,
      found: !!mf,
      type: mf ? mf.type : null,
      updatedAt: mf ? mf.updatedAt : null,
      bytes: mf ? Buffer.byteLength(mf.value || '', 'utf8') : 0,
      value: mf ? JSON.parse(mf.value) : null,
    });
  } catch (e) {
    console.error('GET /api/swatch/debug/metafield error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/debug/metafield', async (req, res) => {
  try {
    const data = await gql(READ_QUERY, { namespace: NAMESPACE, key: KEY });
    const ownerId = data.currentAppInstallation && data.currentAppInstallation.id;
    if (!ownerId) return res.status(500).json({ error: 'currentAppInstallation not found' });

    const value = { version: 0, note: 'phase 0 test', writtenAt: new Date().toISOString() };
    const out = await gql(SET_MUTATION, {
      metafields: [{ ownerId, namespace: NAMESPACE, key: KEY, type: 'json', value: JSON.stringify(value) }],
    });
    const errText = userErrorText(out.metafieldsSet);
    if (errText) return res.status(400).json({ error: errText });
    res.json({ ok: true, ownerId, written: value, metafield: out.metafieldsSet.metafields[0] });
  } catch (e) {
    console.error('POST /api/swatch/debug/metafield error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
