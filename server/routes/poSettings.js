const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { runGlobalUpdate, getGlobalStatus, getMetafieldSettings } = require('../jobs/poSkuUpdater');

const MAX_GROUPS = 4;

async function saveGroups(groups) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('po_metafield_groups', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
    [JSON.stringify(groups)]
  );
}

// GET /api/po-settings/metafields
router.get('/metafields', async (req, res) => {
  try {
    const { packageSize, groups } = await getMetafieldSettings();
    res.json({ packageSize, groups });
  } catch (e) {
    console.error('GET /api/po-settings/metafields error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/po-settings/metafields/package-size
// Body: { type: 'product'|'variant', namespaceKey: 'custom.sample' }
router.patch('/metafields/package-size', async (req, res) => {
  try {
    const { type, namespaceKey } = req.body;
    if (!type || !namespaceKey) return res.status(400).json({ error: 'type and namespaceKey are required' });
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('po_package_size_metafield', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify({ type, namespaceKey })]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/po-settings/metafields/package-size error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/po-settings/metafields/groups — add a new empty group (max 4)
router.post('/metafields/groups', async (req, res) => {
  try {
    const { groups } = await getMetafieldSettings();
    if (groups.length >= MAX_GROUPS) return res.status(400).json({ error: `Maximum ${MAX_GROUPS} groups allowed` });
    groups.push({ name: null, code: null, cost: null });
    await saveGroups(groups);
    res.json({ groups });
  } catch (e) {
    console.error('POST /api/po-settings/metafields/groups error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/po-settings/metafields/groups/:index
// Body: { field: 'name'|'code', type: 'product'|'variant', namespaceKey: '...' }
router.patch('/metafields/groups/:index', async (req, res) => {
  try {
    const index = Number(req.params.index);
    const { field, type, namespaceKey } = req.body;
    if (!['name', 'code', 'cost'].includes(field)) return res.status(400).json({ error: 'field must be name, code, or cost' });
    if (!type || !namespaceKey) return res.status(400).json({ error: 'type and namespaceKey are required' });

    const { groups } = await getMetafieldSettings();
    if (!groups[index]) return res.status(404).json({ error: 'Group not found' });

    groups[index] = { ...groups[index], [field]: { type, namespaceKey } };
    await saveGroups(groups);
    res.json({ groups });
  } catch (e) {
    console.error('PATCH /api/po-settings/metafields/groups/:index error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/po-settings/metafields/groups/:index — removes the group; later groups shift down
router.delete('/metafields/groups/:index', async (req, res) => {
  try {
    const index = Number(req.params.index);
    const { groups } = await getMetafieldSettings();
    if (!groups[index]) return res.status(404).json({ error: 'Group not found' });
    if (groups.length <= 1) return res.status(400).json({ error: 'At least one group must remain' });

    groups.splice(index, 1);
    await saveGroups(groups);
    res.json({ groups });
  } catch (e) {
    console.error('DELETE /api/po-settings/metafields/groups/:index error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Cost comparison ──────────────────────────────────────────────────────
// Controls which stored cost field gets compared against Supplier cost for
// the highlight/sort-to-top treatment on the Import an Invoice / Invoice
// detail line item tables. This is read at render time (not baked in when
// an invoice is processed), so changing it here immediately changes how
// already-processed pending and committed invoices display too.
const COST_COMPARISON_DEFAULT = { cad: 'invoice_cost', usd: 'invoice_cost' };
const COST_COMPARISON_OPTIONS = ['invoice_cost', 'effective_cost'];

// GET /api/po-settings/cost-comparison
router.get('/cost-comparison', async (req, res) => {
  try {
    const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'po_cost_comparison'`);
    res.json({ ...COST_COMPARISON_DEFAULT, ...(result.rows[0]?.value || {}) });
  } catch (e) {
    console.error('GET /api/po-settings/cost-comparison error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/po-settings/cost-comparison — body: { cad?: 'invoice_cost'|'effective_cost', usd?: 'invoice_cost'|'effective_cost' }
router.patch('/cost-comparison', async (req, res) => {
  try {
    const { cad, usd } = req.body;
    if (cad !== undefined && !COST_COMPARISON_OPTIONS.includes(cad)) {
      return res.status(400).json({ error: 'cad must be invoice_cost or effective_cost' });
    }
    if (usd !== undefined && !COST_COMPARISON_OPTIONS.includes(usd)) {
      return res.status(400).json({ error: 'usd must be invoice_cost or effective_cost' });
    }
    const current = await pool.query(`SELECT value FROM app_settings WHERE key = 'po_cost_comparison'`);
    const merged = { ...COST_COMPARISON_DEFAULT, ...(current.rows[0]?.value || {}) };
    if (cad !== undefined) merged.cad = cad;
    if (usd !== undefined) merged.usd = usd;

    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('po_cost_comparison', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(merged)]
    );
    res.json(merged);
  } catch (e) {
    console.error('PATCH /api/po-settings/cost-comparison error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PO lock (2026-10, Hera) ──────────────────────────────────────────────
// Switch (default OFF): when ON, items that are in a not-yet-committed
// invoice at the store's location are locked in the manager's Weekly Count /
// Manual Count (see server/poLock.js). OFF = managers count normally and
// never see anything; the Buyer's task detail always highlights such items
// and always skips them on commit.
const { isManagerLockEnabled } = require('../poLock');

// GET /api/po-settings/po-lock → { enabled }
router.get('/po-lock', async (req, res) => {
  try {
    res.json({ enabled: await isManagerLockEnabled() });
  } catch (e) {
    console.error('GET /api/po-settings/po-lock error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/po-settings/po-lock — body: { enabled: boolean }
router.put('/po-lock', async (req, res) => {
  try {
    const enabled = !!(req.body && req.body.enabled);
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('po_lock_enabled', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify({ enabled })]
    );
    res.json({ enabled });
  } catch (e) {
    console.error('PUT /api/po-settings/po-lock error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Ship to HQ rules (2026-10-22, Hera) ────────────────────────────────────
// Purchasing › Settings › Ship to HQ: rules for POs that are NOT added to WH ›
// Receive Shipments. app_settings 'po_hq_ship_rules' = [{ supplierId,
// locations: [name], shipToHq: boolean }]. When a new PO's supplier +
// location match a rule, Create New Purchase Order shows the "Shipping to
// HQ" switch with the rule's value as default. One supplier + location pair
// may be in only ONE rule. The whole list is saved at once (card's Save).
// GET → { rules }   PUT { rules } → { rules }
function cleanHqShipRules(raw) {
  if (!Array.isArray(raw)) throw Object.assign(new Error('rules must be a list'), { status: 400 });
  const seen = new Map(); // 'supplierId|location' → rule number
  return raw.map((r, i) => {
    const supplierId = parseInt(r && r.supplierId, 10);
    const locations = [...new Set((Array.isArray(r && r.locations) ? r.locations : []).map(l => String(l || '').trim()).filter(Boolean))];
    if (!Number.isInteger(supplierId) || supplierId <= 0) throw Object.assign(new Error(`Rule #${i + 1}: choose a supplier.`), { status: 400 });
    if (locations.length === 0) throw Object.assign(new Error(`Rule #${i + 1}: choose at least one location.`), { status: 400 });
    for (const l of locations) {
      const k = `${supplierId}|${l}`;
      if (seen.has(k)) throw Object.assign(new Error(`Rule #${i + 1}: ${l} is already in Rule #${seen.get(k)} for this supplier.`), { status: 400 });
      seen.set(k, i + 1);
    }
    return { supplierId, locations, shipToHq: !!(r && r.shipToHq) };
  });
}

router.get('/hq-ship-rules', async (req, res) => {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'po_hq_ship_rules'`);
    const rules = r.rows.length && Array.isArray(r.rows[0].value) ? r.rows[0].value : [];
    res.json({ rules });
  } catch (e) {
    console.error('GET /api/po-settings/hq-ship-rules error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/hq-ship-rules', async (req, res) => {
  try {
    const rules = cleanHqShipRules(req.body && req.body.rules);
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('po_hq_ship_rules', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(rules)]
    );
    res.json({ rules });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('PUT /api/po-settings/hq-ship-rules error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/po-settings/type-update-history
router.get('/type-update-history', async (req, res) => {
  try {
    const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'po_type_update_history'`);
    res.json(result.rows[0]?.value || {});
  } catch (e) {
    console.error('GET /api/po-settings/type-update-history error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/po-settings/update-sku-global — fire and forget, client polls status
// Body: { types: string[] }
router.post('/update-sku-global', async (req, res) => {
  try {
    const { types } = req.body;
    if (!types || types.length === 0) return res.status(400).json({ error: 'At least one type is required' });

    const status = getGlobalStatus();
    if (status.isRunning) return res.status(409).json({ error: 'An update is already in progress' });

    runGlobalUpdate(types).catch(e => console.error('[poSettings] update-sku-global error:', e.message));
    res.json({ started: true });
  } catch (e) {
    console.error('POST /api/po-settings/update-sku-global error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/po-settings/update-sku-global/status
router.get('/update-sku-global/status', async (req, res) => {
  res.json(getGlobalStatus());
});

module.exports = router;
