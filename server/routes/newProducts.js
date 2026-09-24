// /api/new-products — Online "New products" + "Finalized" + their Settings
// (2026-09-24). Spec: claude/IMPORT_PRODUCTS_FEATURE_SPEC.md §15–§18.
// Hub never deletes Shopify products: "Delete selected" only removes rows
// from the new_arrival table.
const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { gql, userErrorText } = require('../services/shopifyGql');
const { getSetting, setSetting, listPublications, fetchDefinitions } = require('../services/productData');
const { SETTINGS, DEFAULT_TAG, getGroups, groupForType, refreshRows } = require('../services/newArrival');

function rowToItem(r) {
  const c = r.cached || {};
  return {
    id: r.id,
    shopifyProductId: r.shopify_product_id,
    title: c.title || r.title,
    titleFr: c.titleFr || '',
    productType: c.productType || r.product_type,
    mediaCount: c.mediaCount == null ? null : c.mediaCount,
    descriptionHtml: c.descriptionHtml || '',
    descriptionText: c.descriptionText || '',
    descriptionFrHtml: c.descriptionFrHtml || '',
    descriptionFrText: c.descriptionFrText || '',
    weight: c.weight || '',
    tags: c.tags || [],
    metafields: c.metafields || {},
    available: c.available == null ? null : c.available,
    status: c.status || null,
    skus: r.skus || [],
    createdAt: r.created_at,
    finalizedAt: r.finalized_at,
    refreshedAt: r.refreshed_at,
    refreshError: r.refresh_error,
  };
}

async function tagSetting() {
  const v = await getSetting(SETTINGS.tag, DEFAULT_TAG);
  const days = parseInt(v && v.days, 10);
  return { tag: (v && v.tag) || DEFAULT_TAG.tag, days: days > 0 ? days : DEFAULT_TAG.days };
}

const ids = (body) => (Array.isArray(body && body.ids) ? body.ids.map(Number).filter(Boolean) : []);

// ─── New products ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const groups = await getGroups();
    const r = await pool.query(`SELECT * FROM new_arrival WHERE status = 'new' ORDER BY created_at DESC, id DESC`);
    const byGroup = new Map(groups.map(g => [g.id, []]));
    const ungrouped = [];
    for (const row of r.rows) {
      const item = rowToItem(row);
      const g = groupForType(groups, item.productType);
      if (g) byGroup.get(g.id).push(item); else ungrouped.push(item);
    }
    res.json({
      groups: groups.map(g => ({ id: g.id, name: g.name, metafields: g.metafields || [], items: byGroup.get(g.id) })),
      ungrouped,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const list = ids(req.body);
    res.json(await refreshRows(list, { withInventory: !!(req.body && req.body.withInventory) }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/delete', async (req, res) => {
  try {
    const list = ids(req.body);
    const r = await pool.query('DELETE FROM new_arrival WHERE id = ANY($1)', [list]);
    res.json({ deleted: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/finalize', async (req, res) => {
  try {
    const list = ids(req.body);
    const r = await pool.query(
      `UPDATE new_arrival SET status = 'finalized', finalized_at = NOW() WHERE id = ANY($1) AND status = 'new'`,
      [list]
    );
    res.json({ finalized: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Finalized ───────────────────────────────────────────────────────────────
router.get('/finalized', async (req, res) => {
  try {
    const { days } = await tagSetting();
    const r = await pool.query(`SELECT * FROM new_arrival WHERE status = 'finalized' ORDER BY finalized_at DESC, id DESC`);
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const recent = [];
    const older = [];
    for (const row of r.rows) {
      const item = rowToItem(row);
      (new Date(row.finalized_at).getTime() >= cutoff ? recent : older).push(item);
    }
    res.json({ days, recent, older });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Publish: Draft → Active, publish to the Settings channels, add the New
// Arrival tag (and schedule its removal), then remove the row. A failed
// product stays in the list with its error (Hera 2026-09-24).
router.post('/publish', async (req, res) => {
  try {
    const list = ids(req.body);
    const r = await pool.query(`SELECT * FROM new_arrival WHERE id = ANY($1) AND status = 'finalized'`, [list]);
    const channels = await getSetting(SETTINGS.publish, []);
    const { tag, days } = await tagSetting();
    const published = [];
    const failed = [];

    for (const row of r.rows) {
      const pid = row.shopify_product_id;
      const title = (row.cached && row.cached.title) || row.title;
      try {
        const data = await gql(
          `query($id: ID!) { product(id: $id) { id title status variants(first: 250) { nodes { sku } } } }`,
          { id: pid }
        );
        const p = data.product;
        if (!p) throw new Error('Product not found in Shopify');

        if (p.status !== 'ACTIVE') {
          const u = await gql(
            `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { userErrors { field message } } }`,
            { p: { id: pid, status: 'ACTIVE' } }
          );
          const msg = userErrorText(u.productUpdate);
          if (msg) throw new Error(`Could not set Active — ${msg}`);
        }

        if (Array.isArray(channels) && channels.length) {
          const pub = await gql(
            `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
            { id: pid, input: channels.map(c => ({ publicationId: c })) }
          );
          const msg = userErrorText(pub.publishablePublish);
          if (msg) throw new Error(`Publish failed — ${msg}`);
        }

        if (tag) {
          const t = await gql(
            `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
            { id: pid, tags: [tag] }
          );
          const msg = userErrorText(t.tagsAdd);
          if (msg) throw new Error(`Published, but adding tag failed — ${msg}`);
          await pool.query(
            `INSERT INTO new_arrival_tag_removals (shopify_product_id, tag, remove_at)
             VALUES ($1, $2, NOW() + make_interval(days => $3::int))`,
            [pid, tag, days]
          );
        }

        await pool.query('DELETE FROM new_arrival WHERE id = $1', [row.id]);
        published.push({ id: row.id, title: p.title, skus: p.variants.nodes.map(v => v.sku).filter(Boolean) });
      } catch (e) {
        await pool.query('UPDATE new_arrival SET refresh_error = $2 WHERE id = $1', [row.id, e.message]).catch(() => {});
        failed.push({ id: row.id, title, error: e.message });
      }
    }
    res.json({ published, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Settings ────────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    let publications = [];
    let publicationsError = '';
    try { publications = await listPublications(); } catch (e) { publicationsError = e.message; }
    res.json({
      publications,
      publicationsError,
      publishChannels: await getSetting(SETTINGS.publish, []),
      inventoryLocations: await getSetting(SETTINGS.inventory, []),
      tag: await tagSetting(),
      groups: await getGroups(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings/publish', async (req, res) => {
  try {
    const list = Array.isArray(req.body.channels) ? req.body.channels.map(String) : [];
    await setSetting(SETTINGS.publish, list);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings/inventory', async (req, res) => {
  try {
    const list = Array.isArray(req.body.locations) ? req.body.locations.map(String) : [];
    await setSetting(SETTINGS.inventory, list);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings/tag', async (req, res) => {
  try {
    const tag = String(req.body.tag || '').trim();
    const days = parseInt(req.body.days, 10);
    if (!tag) return res.status(400).json({ error: 'Tag cannot be empty' });
    if (tag.includes(',')) return res.status(400).json({ error: 'Tag cannot contain a comma' });
    if (!(days > 0 && days <= 3650)) return res.status(400).json({ error: 'Days must be a whole number between 1 and 3650' });
    await setSetting(SETTINGS.tag, { tag, days });
    res.json({ success: true, tag, days });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Look up a metafield definition before it is added to a group.
router.post('/settings/metafield-lookup', async (req, res) => {
  try {
    const level = req.body.level === 'variant' ? 'variant' : 'product';
    const namespace = String(req.body.namespace || '').trim();
    const key = String(req.body.key || '').trim();
    if (!namespace || !key) return res.status(400).json({ error: 'Namespace and key are required' });
    const defs = await fetchDefinitions(level === 'product' ? 'PRODUCT' : 'PRODUCTVARIANT');
    const d = defs.find(x => x.namespace === namespace && x.key === key);
    if (!d) return res.status(404).json({ error: 'Metafield definition not found' });
    res.json({ level, namespace, key, name: d.name, type: d.type });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Replace all groups (one transaction). A type may belong to one group only.
router.put('/settings/groups', async (req, res) => {
  const groups = Array.isArray(req.body.groups) ? req.body.groups : [];
  const seen = new Map();
  for (const g of groups) {
    if (!String(g.name || '').trim()) return res.status(400).json({ error: 'Every group needs a name' });
    for (const t of g.product_types || []) {
      const k = String(t).toLowerCase();
      if (seen.has(k)) return res.status(400).json({ error: `Type "${t}" is in both "${seen.get(k)}" and "${g.name}"` });
      seen.set(k, g.name);
    }
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('DELETE FROM online_np_groups');
    let order = 0;
    for (const g of groups) {
      const mfs = (Array.isArray(g.metafields) ? g.metafields : []).map(m => ({
        level: m.level === 'variant' ? 'variant' : 'product',
        namespace: String(m.namespace), key: String(m.key), name: String(m.name || m.key),
      }));
      await db.query(
        `INSERT INTO online_np_groups (name, sort_order, product_types, metafields) VALUES ($1, $2, $3, $4::jsonb)`,
        [String(g.name).trim(), order++, (g.product_types || []).map(String), JSON.stringify(mfs)]
      );
    }
    await db.query('COMMIT');
    res.json({ success: true, groups: await getGroups() });
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    db.release();
  }
});

module.exports = router;
