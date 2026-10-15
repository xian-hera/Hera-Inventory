// Online › Publication — Settings sub-tab (2026-10-15, Hera).
// Spec: claude/PUBLICATION_FEATURE_SPEC.md §5. Stored in app_settings.
const { getSetting, setSetting } = require('./productData');

const SETTINGS_KEY = 'publication_settings';

// owner: 'product' = every variant reads its product's metafield;
//        'variant' = the variant's own metafield.
const DEFAULT_SETTINGS = {
  discontinued: { owner: 'variant', namespace: 'custom', key: 'discontinued' },
  posOnly: { owner: 'product', namespace: 'custom', key: 'pos_only' },
  fulfillmentLocation: null, // location_map name, e.g. "MTL10"
  qty: 'available',          // 'available' | 'on_hand'
};

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function cleanMetafield(m, fallback) {
  const s = m || {};
  return {
    owner: s.owner === 'product' ? 'product' : (s.owner === 'variant' ? 'variant' : fallback.owner),
    namespace: typeof s.namespace === 'string' ? s.namespace.trim() : fallback.namespace,
    key: typeof s.key === 'string' ? s.key.trim() : fallback.key,
  };
}

function merge(saved) {
  const s = saved || {};
  return {
    discontinued: cleanMetafield(s.discontinued, DEFAULT_SETTINGS.discontinued),
    posOnly: cleanMetafield(s.posOnly, DEFAULT_SETTINGS.posOnly),
    fulfillmentLocation: s.fulfillmentLocation ? String(s.fulfillmentLocation) : null,
    qty: s.qty === 'on_hand' ? 'on_hand' : 'available',
  };
}

async function getSettings() {
  return merge(await getSetting(SETTINGS_KEY, null));
}

// Throws { status: 400 } on bad input; returns the saved settings.
async function saveSettings(input) {
  const next = merge(input);
  for (const [label, m] of [['Discontinued', next.discontinued], ['POS_Only', next.posOnly]]) {
    if (!m.namespace || !m.key) throw Object.assign(new Error(`${label}: fill in Name space and Key.`), { status: 400 });
    if (!NAME_RE.test(m.namespace) || !NAME_RE.test(m.key)) {
      throw Object.assign(new Error(`${label}: Name space and Key may only contain letters, numbers, "_" and "-".`), { status: 400 });
    }
  }
  await setSetting(SETTINGS_KEY, next);
  return next;
}

// What still has to be set before a scan can run ([] = ready).
function missingForScan(s) {
  const out = [];
  if (!s.fulfillmentLocation) out.push('Fulfillment location');
  if (!s.discontinued.namespace || !s.discontinued.key) out.push('Discontinued metafield');
  if (!s.posOnly.namespace || !s.posOnly.key) out.push('POS_Only metafield');
  return out;
}

module.exports = { getSettings, saveSettings, missingForScan, DEFAULT_SETTINGS };
