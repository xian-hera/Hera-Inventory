const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
// Scheduled price changes / reverse / task types / WIG part (2026-10-08,
// Hera). Spec: claude/PRICE_CHANGE_SCHEDULE_REVERSE_SPEC.md
const PC = require('../services/priceChange');
// Purchasing user groups (2026-10-09): Buyer lists show only tasks whose
// product_types are the current group's or unassigned. See routes/userGroups.js.
const { getGroupFilter, arrayVisibleSql } = require('./userGroups');

async function generateTaskNo(client) {
  const res = await client.query(
    'SELECT last_number FROM price_change_counter WHERE id = 1 FOR UPDATE'
  );
  const next = res.rows[0].last_number + 1;
  await client.query(
    'UPDATE price_change_counter SET last_number = $1 WHERE id = 1',
    [next]
  );
  return String(next).padStart(6, '0');
}

async function cleanupExpired() {
  await pool.query(
    `DELETE FROM price_change_location_status
     WHERE status = 'done' AND auto_delete_at IS NOT NULL AND auto_delete_at < NOW()`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BUYER ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/price-change-tasks
router.get('/', async (req, res) => {
  try {
    await cleanupExpired();
    const groupFilter = await getGroupFilter(req);
    const gParams = groupFilter ? [groupFilter.blockedTypes] : [];
    const gSql = groupFilter ? `AND ${arrayVisibleSql('t.product_types', 1)}` : '';
    const result = await pool.query(`
      SELECT
        t.*,
        -- DISTINCT (2026-10-08): the join with location rows used to count
        -- every item once per location. Skipped items are not counted.
        COUNT(DISTINCT i.id) FILTER (WHERE i.apply_status IS NULL OR i.apply_status = 'done') AS item_count,
        ARRAY_AGG(DISTINCT ls.location) FILTER (WHERE ls.status = 'pending') AS unfinished_locations,
        (SELECT row_to_json(x) FROM (SELECT rt.task_no, rt.scheduled_at, rt.status FROM price_change_tasks rt
           WHERE rt.id = t.reverse_task_id) x) AS reverse_task,
        (SELECT ro.task_no FROM price_change_tasks ro WHERE ro.id = t.reverse_of) AS reverse_of_no
      FROM price_change_tasks t
      LEFT JOIN price_change_items i ON i.task_id = t.id
      LEFT JOIN price_change_location_status ls ON ls.task_id = t.id
      WHERE t.status = 'active' ${gSql}
      GROUP BY t.id
      ORDER BY COALESCE(t.published_at, t.created_at) DESC
    `, gParams);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/price-change-tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/price-change-tasks
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { locations, items, note, label_type } = req.body;
    if (!locations || locations.length === 0) {
      return res.status(400).json({ error: 'locations required' });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'items required' });
    }

    await client.query('BEGIN');
    const taskNo = await generateTaskNo(client);

    const taskRes = await client.query(
      `INSERT INTO price_change_tasks (task_no, note, locations, label_type)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [taskNo, note || null, locations, label_type || 'Regular price']
    );
    const task = taskRes.rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO price_change_items (task_id, sku, name, price, barcode, compare_at_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [task.id, item.sku, item.name || null, item.price || null, item.barcode || null, item.compare_at_price || null]
      );
    }

    for (const loc of locations) {
      await client.query(
        `INSERT INTO price_change_location_status (task_id, location, status)
         VALUES ($1, $2, 'pending')`,
        [task.id, loc]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, task });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/price-change-tasks error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// DELETE /api/price-change-tasks
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids' });
    await pool.query('DELETE FROM price_change_tasks WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/price-change-tasks/archive
router.patch('/archive', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids' });
    await pool.query(
      "UPDATE price_change_tasks SET status = 'archived' WHERE id = ANY($1)",
      [ids]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULED PRICE CHANGES (2026-10-08, Hera)
// ═══════════════════════════════════════════════════════════════════════════
const typeOk = (t) => PC.TASK_TYPES.includes(t);
const minutesFromNow = (m) => new Date(Date.now() + m * 60000);

// Validate { date, time } (Eastern) → Date, or throw a readable error.
function whenOf(v, label) {
  const d = v && PC.torontoToDate(v.date, v.time);
  if (!d) throw new Error(`${label}: choose a date and a time.`);
  return d;
}
function checkTimes(applyAt, reverseAt, { now = false } = {}) {
  if (!now && applyAt < minutesFromNow(PC.MIN_LEAD_MIN)) throw new Error(`The change time must be at least ${PC.MIN_LEAD_MIN} minutes from now.`);
  if (reverseAt && reverseAt < new Date(applyAt.getTime() + PC.MIN_REVERSE_GAP_MIN * 60000)) {
    throw new Error(`The reverse time must be at least ${PC.MIN_REVERSE_GAP_MIN} minutes after the change time.`);
  }
}

// ── Settings ──
router.get('/settings', async (req, res) => {
  try { res.json(await PC.getSettings()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/settings/types', async (req, res) => {
  try {
    const s = await PC.getSettings();
    s.hiddenTypes = Array.isArray(req.body.hiddenTypes) ? req.body.hiddenTypes.map(String) : [];
    res.json(await PC.saveSettings(s));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/settings/compare-at', async (req, res) => {
  try {
    const s = await PC.getSettings();
    s.keepExistingCompareAt = req.body.keepExisting === true;
    res.json(await PC.saveSettings(s));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/settings/rules', async (req, res) => {
  try {
    const types = Array.isArray(req.body.types) ? req.body.types.map(String).filter(Boolean) : [];
    const percent = Number(req.body.percent);
    const cents = Number(req.body.cents);
    if (!types.length) return res.status(400).json({ error: 'Choose at least one type.' });
    if (!(percent > 0 && percent < 100)) return res.status(400).json({ error: 'The reduction must be between 0 and 100 %.' });
    if (!(Number.isInteger(cents) && cents >= 0 && cents <= 99)) return res.status(400).json({ error: 'Cents must be a whole number from 0 to 99.' });
    const s = await PC.getSettings();
    const clash = types.find(t => PC.ruleForType(s.rules, t));
    if (clash) return res.status(400).json({ error: `"${clash}" already has a rule — a type can only be in one rule.` });
    s.rules = [...s.rules, { id: `r${Date.now()}`, types, percent, cents }];
    res.json(await PC.saveSettings(s));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/settings/rules/:ruleId', async (req, res) => {
  try {
    const s = await PC.getSettings();
    s.rules = s.rules.filter(r => r.id !== req.params.ruleId);
    res.json(await PC.saveSettings(s));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Empty Metafields for Discontinued (2026-10-09, Hera) ──
// body { types: [], namespace, key } — variant metafields only.
// Warns (does not refuse) when Shopify has no definition for it.
router.post('/settings/empty-rules', async (req, res) => {
  try {
    const types = Array.isArray(req.body.types) ? req.body.types.map(String).filter(Boolean) : [];
    const namespace = String(req.body.namespace || '').trim();
    const key = String(req.body.key || '').trim();
    if (!types.length) return res.status(400).json({ error: 'Choose at least one type.' });
    if (!namespace || !key) return res.status(400).json({ error: 'Fill in Name space and Key.' });
    if (!/^[A-Za-z0-9_-]+$/.test(namespace) || !/^[A-Za-z0-9_-]+$/.test(key)) {
      return res.status(400).json({ error: 'Name space and Key may only contain letters, numbers, "_" and "-".' });
    }
    const id = `${namespace}.${key}`;
    if (PC.RESERVED_METAFIELDS.includes(id.toLowerCase())) {
      return res.status(400).json({ error: `${id} is already set by Discontinued tasks — it can't be emptied.` });
    }
    const s = await PC.getSettings();
    const lcx = (x) => String(x).trim().toLowerCase();
    for (const t of types) {
      const dup = s.emptyRules.find(r => lcx(`${r.namespace}.${r.key}`) === lcx(id) && (r.types || []).some(x => lcx(x) === lcx(t)));
      if (dup) return res.status(400).json({ error: `"${t}" already has a rule for ${id}.` });
    }
    let warning = null;
    try {
      const { fetchDefinitions } = require('../services/productData');
      const defs = await fetchDefinitions('PRODUCTVARIANT');
      if (!defs.some(d => d.namespace === namespace && d.key === key)) {
        warning = `No variant metafield definition ${id} was found in Shopify. The rule was saved; check the Name space and Key.`;
      }
    } catch (e) {
      warning = `Could not check ${id} in Shopify (${e.message}). The rule was saved.`;
    }
    s.emptyRules = [...s.emptyRules, { id: `e${Date.now()}`, types, namespace, key }];
    const saved = await PC.saveSettings(s);
    res.json({ ...saved, warning });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/settings/empty-rules/:ruleId', async (req, res) => {
  try {
    const s = await PC.getSettings();
    s.emptyRules = s.emptyRules.filter(r => r.id !== req.params.ruleId);
    res.json(await PC.saveSettings(s));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Process (Upload CSV step) ──
// body { productTypes, taskType, rows: [{ row, sku, price }] }
router.post('/process', async (req, res) => {
  try {
    const { productTypes, taskType, rows } = req.body || {};
    if (!Array.isArray(productTypes) || !productTypes.length) return res.status(400).json({ error: 'Choose at least one type.' });
    if (!typeOk(taskType)) return res.status(400).json({ error: 'Choose a task type.' });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows in the CSV.' });
    if (rows.length > 2000) return res.status(400).json({ error: 'Too many rows (limit 2000).' });
    res.json(await PC.processRows({ productTypes, taskType, rows }));
  } catch (e) {
    console.error('POST /api/price-change-tasks/process error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Create a scheduled task ──
// body { productTypes, locations, taskType, note, items, when: { date, time } | 'now',
//        reverse: { date, time, taskType } | null }
router.post('/scheduled', async (req, res) => {
  const client = await pool.connect();
  try {
    const { productTypes, locations, taskType, note, items, when, reverse } = req.body || {};
    if (!Array.isArray(productTypes) || !productTypes.length) return res.status(400).json({ error: 'Choose at least one type.' });
    if (!Array.isArray(locations) || !locations.length) return res.status(400).json({ error: 'Choose at least one location.' });
    if (!typeOk(taskType)) return res.status(400).json({ error: 'Choose a task type.' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items.' });
    const now = when === 'now';
    let applyAt; let reverseAt = null;
    try {
      applyAt = now ? new Date() : whenOf(when, 'Change time');
      if (reverse) {
        // Reverse is for Promotion tasks only (2026-10-09, Hera).
        if (taskType !== 'promotion') throw new Error('Only Promotion tasks can have a reverse.');
        if (!typeOk(reverse.taskType)) throw new Error('Reverse: choose the task type the stores will see.');
        reverseAt = whenOf(reverse, 'Reverse time');
      }
      checkTimes(applyAt, reverseAt, { now });
    } catch (e) { return res.status(400).json({ error: e.message }); }

    await client.query('BEGIN');
    const taskNo = await PC.nextTaskNo(client);
    const t = (await client.query(
      `INSERT INTO price_change_tasks (task_no, note, locations, status, task_type, product_types, scheduled_at, reverse_at, reverse_task_type)
       VALUES ($1, $2, $3, 'scheduled', $4, $5, $6, $7, $8) RETURNING *`,
      [taskNo, note || null, locations, taskType, productTypes, applyAt, reverseAt, reverse ? reverse.taskType : null]
    )).rows[0];
    for (const it of items) {
      await client.query(
        `INSERT INTO price_change_items (task_id, sku, name, barcode, price, variant_id, product_id, product_type, csv_price, apply_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
        [t.id, it.sku, it.name || null, it.barcode || null, it.csvPrice || null, it.variantId, it.productId, it.productType || null, it.csvPrice || null]
      );
    }
    await client.query('COMMIT');
    if (now) PC.runDue();
    res.json({ success: true, task: t });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/price-change-tasks/scheduled error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Scheduled Tasks card ──
router.get('/scheduled', async (req, res) => {
  try {
    const groupFilter = await getGroupFilter(req);
    const gParams = groupFilter ? [groupFilter.blockedTypes] : [];
    const gSql = groupFilter ? `AND ${arrayVisibleSql('t.product_types', 1)}` : '';
    const r = await pool.query(`
      SELECT t.id, t.task_no, t.note, t.locations, t.status, t.task_type, t.product_types, t.scheduled_at,
             t.publish_at, t.reverse_at, t.reverse_task_type, t.reverse_of, t.error,
             (SELECT ro.task_no FROM price_change_tasks ro WHERE ro.id = t.reverse_of) AS reverse_of_no,
             (SELECT COUNT(*)::int FROM price_change_items i WHERE i.task_id = t.id AND COALESCE(i.apply_status, 'pending') <> 'skipped') AS item_count
      FROM price_change_tasks t
      WHERE t.status IN ('scheduled', 'applying', 'applied', 'failed') ${gSql}
      ORDER BY t.scheduled_at NULLS LAST, t.id
    `, gParams);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete scheduled (not yet applied) or failed tasks. Nothing in Shopify changes.
router.post('/scheduled/delete', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    const r = await pool.query(
      `DELETE FROM price_change_tasks WHERE id = ANY($1) AND status IN ('scheduled', 'failed') RETURNING id`, [ids]
    );
    await pool.query('DELETE FROM price_change_items WHERE task_id = ANY($1)', [r.rows.map(x => x.id)]);
    res.json({ deleted: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Publish now: apply now (stores get it 10 minutes later); a planned reverse is kept.
router.post('/publish-now', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    const tooSoon = await pool.query(
      `SELECT task_no FROM price_change_tasks WHERE id = ANY($1) AND status = 'scheduled'
         AND reverse_at IS NOT NULL AND reverse_at < NOW() + make_interval(mins => $2::int)`,
      [ids, PC.MIN_REVERSE_GAP_MIN]
    );
    if (tooSoon.rows.length) {
      return res.status(400).json({ error: `Task ${tooSoon.rows.map(x => x.task_no).join(', ')}: the reverse would be less than ${PC.MIN_REVERSE_GAP_MIN} minutes after the change — change or remove the reverse first.` });
    }
    const r = await pool.query(
      `UPDATE price_change_tasks SET scheduled_at = NOW() WHERE id = ANY($1) AND status = 'scheduled' RETURNING id`, [ids]
    );
    PC.runDue();
    res.json({ started: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Change the times of a scheduled task. body { when?: {date,time}, reverse?: {date,time,taskType} | null }
router.patch('/:id/schedule', async (req, res) => {
  try {
    const t = (await pool.query('SELECT * FROM price_change_tasks WHERE id = $1', [req.params.id])).rows[0];
    if (!t || t.status !== 'scheduled') return res.status(400).json({ error: 'Only a task that has not run yet can be changed.' });
    const b = req.body || {};
    let applyAt = t.scheduled_at;
    let reverseAt = t.reverse_at;
    let reverseType = t.reverse_task_type;
    try {
      if (b.when) applyAt = whenOf(b.when, 'Change time');
      if (b.reverse === null) { reverseAt = null; reverseType = null; }
      else if (b.reverse) {
        if (t.reverse_of) throw new Error('A reverse task has no reverse of its own.');
        // New reverses only for Promotion (2026-10-09); one already planned
        // on another type can still be moved or removed.
        if (!t.reverse_at && t.task_type !== 'promotion') throw new Error('Only Promotion tasks can have a reverse.');
        reverseAt = b.reverse.date ? whenOf(b.reverse, 'Reverse time') : reverseAt;
        reverseType = b.reverse.taskType || reverseType;
        if (!typeOk(reverseType)) throw new Error('Reverse: choose the task type the stores will see.');
      }
      checkTimes(new Date(applyAt), reverseAt ? new Date(reverseAt) : null);
    } catch (e) { return res.status(400).json({ error: e.message }); }
    const r = await pool.query(
      `UPDATE price_change_tasks SET scheduled_at = $2, reverse_at = $3, reverse_task_type = $4
       WHERE id = $1 AND status = 'scheduled' RETURNING *`,
      [t.id, applyAt, reverseAt, reverseAt ? reverseType : null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Task + items for the buyer's detail modals (any status).
router.get('/:id/detail', async (req, res) => {
  try {
    const t = (await pool.query(
      `SELECT t.*, (SELECT ro.task_no FROM price_change_tasks ro WHERE ro.id = t.reverse_of) AS reverse_of_no,
              (SELECT row_to_json(x) FROM (SELECT rt.task_no, rt.scheduled_at, rt.status FROM price_change_tasks rt WHERE rt.id = t.reverse_task_id) x) AS reverse_task
       FROM price_change_tasks t WHERE t.id = $1`, [req.params.id]
    )).rows[0];
    if (!t) return res.status(404).json({ error: 'Task not found' });
    const items = (await pool.query('SELECT * FROM price_change_items WHERE task_id = $1 ORDER BY id', [t.id])).rows;
    const settings = await PC.getSettings();
    // Not applied yet: say where the new price will come from.
    for (const it of items) {
      if (t.status === 'scheduled' && !t.reverse_of && !it.csv_price && t.task_type === 'discontinued') {
        const rule = PC.ruleForType(settings.rules, it.product_type);
        it.rule_text = rule ? `−${rule.percent}%, cents → .${String(rule.cents).padStart(2, '0')}` : 'No rule — will be skipped';
      }
    }
    res.json({ task: t, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Archived (all stores Done; kept 30 days) ──
router.get('/archived', async (req, res) => {
  try {
    const old = await pool.query(
      `SELECT id FROM price_change_tasks WHERE status = 'archived' AND COALESCE(archived_at, created_at) < NOW() - INTERVAL '30 days'`
    );
    const oldIds = old.rows.map(r => r.id);
    if (oldIds.length) {
      await pool.query('DELETE FROM price_change_location_status WHERE task_id = ANY($1)', [oldIds]);
      await pool.query('DELETE FROM price_change_items WHERE task_id = ANY($1)', [oldIds]);
      await pool.query('DELETE FROM price_change_tasks WHERE id = ANY($1)', [oldIds]);
    }
    const groupFilter = await getGroupFilter(req);
    const gParams = groupFilter ? [groupFilter.blockedTypes] : [];
    const gSql = groupFilter ? `AND ${arrayVisibleSql('t.product_types', 1)}` : '';
    const r = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*)::int FROM price_change_items i WHERE i.task_id = t.id AND (i.apply_status IS NULL OR i.apply_status = 'done')) AS item_count
      FROM price_change_tasks t WHERE t.status = 'archived' ${gSql}
      ORDER BY COALESCE(t.archived_at, t.created_at) DESC
    `, gParams);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live Price / Compare-at by exact SKU, for the store task page.
// body { skus } → { [sku]: { price, compareAt } }
router.post('/live-prices', async (req, res) => {
  try {
    const skus = Array.isArray(req.body.skus) ? req.body.skus.map(String).slice(0, 1000) : [];
    const found = await PC.findBySku(skus);
    const out = {};
    for (const [sku, list] of found) if (list.length === 1) out[sku] = { price: list[0].price, compareAt: list[0].compareAtPrice };
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/price-change-tasks/:id/items[?part=main|wig]
// part (2026-10-08): 'wig' = WIG items only, 'main' = everything else.
// Items a scheduled change skipped are left out.
router.get('/:id/items', async (req, res) => {
  try {
    const part = req.query.part === 'wig' ? 'wig' : req.query.part === 'main' ? 'main' : '';
    const partSql = part === 'wig' ? "AND LOWER(COALESCE(product_type, '')) = 'wig'"
      : part === 'main' ? "AND LOWER(COALESCE(product_type, '')) <> 'wig'" : '';
    const result = await pool.query(
      `SELECT * FROM price_change_items WHERE task_id = $1 AND (apply_status IS NULL OR apply_status = 'done') ${partSql} ORDER BY id`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MANAGER ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/price-change-tasks/manager?location=MTL01
router.get('/manager', async (req, res) => {
  try {
    await cleanupExpired();
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'location required' });

    // One row per task part (2026-10-08): 'main' and, when the task has WIG
    // items, 'wig' — each with its own items, types and Done status.
    const result = await pool.query(`
      SELECT
        t.id, t.task_no, t.note, t.created_at, t.published_at, t.label_type, t.task_type,
        ls.part,
        COUNT(i.id) AS item_count,
        ARRAY_AGG(DISTINCT i.product_type) FILTER (WHERE i.product_type IS NOT NULL) AS item_types,
        ls.status AS location_status,
        ls.printed_at,
        ls.auto_delete_at
      FROM price_change_tasks t
      JOIN price_change_location_status ls
        ON ls.task_id = t.id AND ls.location = $1
      LEFT JOIN price_change_items i ON i.task_id = t.id
        AND (i.apply_status IS NULL OR i.apply_status = 'done')
        AND (CASE WHEN LOWER(COALESCE(i.product_type, '')) = 'wig' THEN 'wig' ELSE 'main' END) = COALESCE(ls.part, 'main')
      WHERE t.status = 'active'
        AND (ls.status = 'pending' OR (ls.status = 'done' AND ls.auto_delete_at > NOW()))
      GROUP BY t.id, ls.part, ls.status, ls.printed_at, ls.auto_delete_at
      ORDER BY COALESCE(t.published_at, t.created_at) DESC, ls.part
    `, [location]);

    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/price-change-tasks/manager error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/price-change-tasks/:id/print
// Records printed_at only — does NOT change status or trigger auto-deletion
router.patch('/:id/print', async (req, res) => {
  try {
    const { location } = req.body;
    if (!location) return res.status(400).json({ error: 'location required' });

    await pool.query(
      `UPDATE price_change_location_status
       SET printed_at = NOW()
       WHERE task_id = $1 AND location = $2`,
      [req.params.id, location]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/price-change-tasks/:id/print error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/price-change-tasks/:id/done
// Manager marks task as done — sets status to 'done', auto-deletes after 2 hours
router.patch('/:id/done', async (req, res) => {
  try {
    const { location } = req.body;
    if (!location) return res.status(400).json({ error: 'location required' });
    // part (2026-10-08): the WIG part is marked Done on its own. Without a
    // part (older pages) every part of this location is marked Done.
    const part = req.body.part === 'wig' ? 'wig' : req.body.part === 'main' ? 'main' : null;

    const autoDeleteAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE price_change_location_status
       SET status = 'done', auto_delete_at = $1
       WHERE task_id = $2 AND location = $3 AND ($4::text IS NULL OR COALESCE(part, 'main') = $4)`,
      [autoDeleteAt, req.params.id, location, part]
    );

    // Every location (and part) done → archived (2026-10-08, Hera).
    await pool.query(
      `UPDATE price_change_tasks SET status = 'archived', archived_at = NOW()
       WHERE id = $1 AND status = 'active'
         AND NOT EXISTS (SELECT 1 FROM price_change_location_status WHERE task_id = $1 AND status = 'pending')`,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/price-change-tasks/:id/done error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;