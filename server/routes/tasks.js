const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../database/init');

// GET /api/tasks - get all tasks with filters
router.get('/', async (req, res) => {
  try {
    const { types, location, status, date } = req.query;

    let conditions = [];
    let params = [];
    let paramIndex = 1;

    // types filter: task must contain ALL of the selected types (or ANY — here we use overlap &&)
    // Logic: if any selected type is in the task's types array, it matches
    if (types && types !== 'ALL') {
      const typeList = types.split(',').map(t => t.trim());
      conditions.push(`types && $${paramIndex++}`);
      params.push(typeList);
    }

    if (location && location !== 'ALL') {
      const locations = location.split(',');
      conditions.push(`location = ANY($${paramIndex++})`);
      params.push(locations);
    }

    if (status && status !== 'ALL') {
      const statuses = status.split(',');
      conditions.push(`status = ANY($${paramIndex++})`);
      params.push(statuses);
    }

    if (date && date !== 'ALL') {
      let interval;
      if (date === 'today') interval = '1 day';
      else if (date === '7days') interval = '7 days';
      else if (date === '30days') interval = '30 days';
      if (interval) {
        conditions.push(`created_at >= NOW() - INTERVAL '${interval}'`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT 
        t.*,
        COUNT(ti.id) FILTER (
          WHERE ti.soh IS NOT NULL AND ti.is_correct = FALSE AND ti.poh IS NOT NULL
        ) AS inaccurate_count,
        COUNT(ti.id) FILTER (
          WHERE ti.soh IS NOT NULL
        ) AS processed_count,
        COUNT(ti.id) AS total_count
      FROM tasks t
      LEFT JOIN task_items ti ON ti.task_id = t.id
      ${whereClause}
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tasks - delete selected tasks
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
    await pool.query('DELETE FROM tasks WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/archive - archive selected tasks
router.patch('/archive', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
    await pool.query(
      "UPDATE tasks SET status = 'archived', updated_at = NOW() WHERE id = ANY($1)",
      [ids]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/archive error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Generate next task number
async function generateTaskNo(client) {
  const result = await client.query('SELECT last_number, last_letter FROM task_counter WHERE id = 1 FOR UPDATE');
  let { last_number, last_letter } = result.rows[0];

  last_number += 1;
  if (last_number > 9999) {
    last_number = 0;
    last_letter = String.fromCharCode(last_letter.charCodeAt(0) + 1);
  }

  await client.query(
    'UPDATE task_counter SET last_number = $1, last_letter = $2 WHERE id = 1',
    [last_number, last_letter]
  );

  return `${last_letter}${String(last_number).padStart(4, '0')}`;
}

// POST /api/tasks - create new task(s)
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { types, locations, filterSummary, items, notes, publish, excludedBarcodes, scanCount } = req.body;
    if (!types || types.length === 0 || !locations || locations.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const locMap = await pool.query('SELECT location_name, shopify_location_id FROM location_map');
    const locationIdMap = {};
    locMap.rows.forEach(r => { locationIdMap[r.location_name] = r.shopify_location_id; });

    const status = publish ? 'counting' : 'draft';
    const scanCountMode = !!scanCount;
    const createdTasks = [];

    await client.query('BEGIN');

    for (const location of locations) {
      const shopifyLocationId = locationIdMap[location] || '';
      const taskNo = await generateTaskNo(client);

      const taskResult = await client.query(
        `INSERT INTO tasks (task_no, types, location, shopify_location_id, status, filter_summary, notes, scan_count_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [taskNo, types, location, shopifyLocationId, status, filterSummary, JSON.stringify(notes || []), scanCountMode]
      );

      const task = taskResult.rows[0];

      const locationExcluded = (excludedBarcodes && excludedBarcodes[location]) || [];
      for (const item of items) {
        if (locationExcluded.includes(item.barcode)) continue;
        await client.query(
          `INSERT INTO task_items (task_id, barcode, name) VALUES ($1, $2, $3)`,
          [task.id, item.barcode, item.name]
        );
      }

      createdTasks.push(task);
    }

    await client.query('COMMIT');
    res.json({ success: true, tasks: createdTasks });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/tasks error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/tasks/:id - get single task with items
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const taskResult = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const itemsResult = await pool.query(
      'SELECT * FROM task_items WHERE task_id = $1 ORDER BY id',
      [id]
    );

    res.json({ ...taskResult.rows[0], items: itemsResult.rows });
  } catch (e) {
    console.error('GET /api/tasks/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/notes
router.patch('/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    await pool.query(
      'UPDATE tasks SET notes = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(notes), id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/notes error:', e);
    res.status(500).json({ error: e.message });
  }
});

// A commit that's been sitting in `committing = TRUE` longer than this is
// treated as abandoned (e.g. the server restarted mid-commit, such as a
// Render redeploy) rather than genuinely in progress, and can be reclaimed
// by a fresh commit request. Safe to reclaim: task_items.is_committed is
// per-item and already-applied items are skipped on the retry, so reclaiming
// a stale lock never re-applies a Shopify change that already went through.
const TASK_COMMIT_STALE_MS = 5 * 60 * 1000;

// The actual commit work, run in the background (not awaited by the PATCH
// handler below) so the request can return immediately and the frontend can
// poll GET /api/tasks/:id for live progress instead of blocking on one long
// request. This is the same per-item logic the route used to run inline;
// only the "how the caller finds out what happened" part changed — results
// now land on the task row (`commit_warnings`, `committing`) instead of in
// the original HTTP response, since by the time this finishes nobody may
// still be listening on that response.
async function runTaskCommit(id, itemIds) {
  const errors = [];
  try {
    const taskRes = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    const task = taskRes.rows[0];
    if (!task) return; // task deleted mid-flight — nothing to do

    const items = await pool.query(
      'SELECT * FROM task_items WHERE id = ANY($1) AND task_id = $2',
      [itemIds, id]
    );

    const { getShopify, getSession, activeFilter } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const shopifyLocationId = task.shopify_location_id;

    const shopifyRequest = async (fn, retries = 2) => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await fn();
        } catch (e) {
          const isTimeout = e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' ||
            (e.message && (e.message.includes('ETIMEDOUT') || e.message.includes('ECONNRESET')));
          if (isTimeout && attempt < retries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
    };

    for (const item of items.rows) {
      if (item.is_correct || item.poh === null || item.soh === null) continue;

      const delta = item.poh - item.soh;

      if (delta === 0) {
        await pool.query('UPDATE task_items SET is_committed = TRUE WHERE id = $1', [item.id]);
        continue;
      }

      try {
        // Step 1: fetch inventoryItem id and current on_hand in a single query
        const variantRes = await shopifyRequest(() =>
          client.request(`{
            productVariants(first: 1, query: "${activeFilter(`barcode:${item.barcode}`)}") {
              edges {
                node {
                  inventoryItem {
                    id
                    inventoryLevel(locationId: "${shopifyLocationId}", includeInactive: true) {
                      quantities(names: ["on_hand"]) { name quantity }
                    }
                  }
                }
              }
            }
          }`)
        );
        const inventoryItem = variantRes.data?.productVariants?.edges[0]?.node?.inventoryItem;
        const invItemId = inventoryItem?.id;
        if (!invItemId) {
          errors.push(`Barcode ${item.barcode}: inventory item not found in Shopify`);
          continue;
        }

        // Step 2: compute new on_hand by applying delta to current on_hand
        const currentOnHand = inventoryItem?.inventoryLevel?.quantities?.find(q => q.name === "on_hand")?.quantity ?? null;
        if (currentOnHand === null) {
          errors.push(`Barcode ${item.barcode}: could not read current on_hand from Shopify`);
          continue;
        }
        const newOnHand = currentOnHand + delta;

        // Step 3: set new on_hand as absolute value with compare-and-swap.
        // @idempotent(key: ...) is required as of API 2026-04 (a separate
        // breaking change from the pre-existing changeFromQuantity above —
        // see Shopify changelog "Making idempotency mandatory for inventory
        // adjustments and refund mutations"). Generated once outside the
        // retry closure so a retry after a network timeout reuses the same
        // key — the whole point of idempotency: if the first attempt
        // actually succeeded server-side before the response was lost,
        // Shopify recognizes the retry and doesn't double-apply it.
        const setOnHandIdempotencyKey = crypto.randomUUID();
        const setRes = await shopifyRequest(() =>
          client.request(`
            mutation {
              inventorySetOnHandQuantities(input: {
                reason: "cycle_count_available",
                setQuantities: [{
                  inventoryItemId: "${invItemId}",
                  locationId: "${shopifyLocationId}",
                  quantity: ${newOnHand},
                  changeFromQuantity: ${currentOnHand}
                }]
              }) @idempotent(key: "${setOnHandIdempotencyKey}") {
                userErrors { field message }
              }
            }
          `)
        );

        const userErrors = setRes.data?.inventorySetOnHandQuantities?.userErrors;
        if (userErrors && userErrors.length > 0) {
          errors.push(`Barcode ${item.barcode}: ${userErrors.map(e => e.message).join(", ")}`);
          continue;
        }

        await pool.query("UPDATE task_items SET is_committed = TRUE WHERE id = $1", [item.id]);
      } catch (e) {
        console.error(`Commit failed for item ${item.id} (barcode: ${item.barcode}):`, e.message);
        errors.push(`Barcode ${item.barcode}: ${e.message}`);
      }
    }

    // Check if all inaccurate items are committed
    const remaining = await pool.query(
      `SELECT COUNT(*) FROM task_items
       WHERE task_id = $1 AND is_correct = FALSE AND poh IS NOT NULL AND is_committed = FALSE`,
      [id]
    );

    if (parseInt(remaining.rows[0].count) === 0) {
      const inaccurateTotal = await pool.query(
        `SELECT COUNT(*) FROM task_items
         WHERE task_id = $1 AND is_correct = FALSE AND poh IS NOT NULL`,
        [id]
      );
      const allGreen = parseInt(inaccurateTotal.rows[0].count) === 0;

      if (allGreen) {
        const currentNotes = (await pool.query('SELECT notes FROM tasks WHERE id = $1', [id])).rows[0]?.notes || [];
        const autoNote = { text: 'Automatically committed and archived', created_at: new Date().toISOString() };
        const updatedNotes = [...currentNotes, autoNote];
        await pool.query(
          "UPDATE tasks SET status = 'archived', notes = $1, updated_at = NOW() WHERE id = $2",
          [JSON.stringify(updatedNotes), id]
        );
      } else {
        await pool.query(
          "UPDATE tasks SET status = 'committed', updated_at = NOW() WHERE id = $1",
          [id]
        );
      }
    }
  } catch (e) {
    console.error(`runTaskCommit fatal error for task ${id}:`, e.message);
    errors.push(`Commit failed: ${e.message}`);
  } finally {
    // Always clear the lock, even on a fatal (non-per-item) error, so the
    // buyer isn't left staring at a permanently-disabled Commit button.
    await pool.query(
      `UPDATE tasks SET committing = FALSE, commit_warnings = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(errors), id]
    ).catch(e => console.error(`Failed to clear committing flag for task ${id}:`, e.message));
  }
}

// PATCH /api/tasks/:id/commit — starts a commit and returns immediately;
// the frontend polls GET /api/tasks/:id (committing / commit_total /
// commit_item_ids / items[].is_committed / commit_warnings) for progress.
// See runTaskCommit above for the actual work.
router.patch('/:id/commit', async (req, res) => {
  try {
    const { id } = req.params;
    const { itemIds } = req.body;
    if (!itemIds || itemIds.length === 0) {
      return res.status(400).json({ error: 'No items to commit.' });
    }

    const taskRes = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (taskRes.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskRes.rows[0];

    if (task.status === 'counting') {
      return res.status(400).json({ error: 'Counting not finished yet.' });
    }

    if (task.committing) {
      const startedAt = task.commit_started_at ? new Date(task.commit_started_at).getTime() : 0;
      if (Date.now() - startedAt < TASK_COMMIT_STALE_MS) {
        return res.status(409).json({ error: 'This task is already being committed — please wait for it to finish.' });
      }
      // Stale lock (server likely restarted mid-commit) — safe to reclaim,
      // see TASK_COMMIT_STALE_MS comment above.
    }

    await pool.query(
      `UPDATE tasks SET committing = TRUE, commit_started_at = NOW(), commit_total = $1, commit_item_ids = $2, commit_warnings = NULL WHERE id = $3`,
      [itemIds.length, itemIds, id]
    );

    res.json({ started: true, total: itemIds.length });

    runTaskCommit(id, itemIds); // fire-and-forget — intentionally not awaited
  } catch (e) {
    console.error('PATCH /api/tasks/:id/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/submit
router.patch('/:id/submit', async (req, res) => {
  try {
    const { id } = req.params;
    const taskRes = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    const task = taskRes.rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });

    await pool.query(
      "UPDATE tasks SET status = 'reviewing', updated_at = NOW() WHERE id = $1",
      [id]
    );

    // Freeze a snapshot of this task for the manager's own History (Weekly
    // Inventory Count page) — see server/routes/managerHistory.js. Captured
    // from what the manager was just looking at, not re-read afterward, so
    // a later buyer edit (poh is editable while status is 'reviewing') never
    // changes what this History entry shows. A failure here is logged only —
    // it must never block the manager's actual submit.
    try {
      const itemsRes = await pool.query('SELECT * FROM task_items WHERE task_id = $1 ORDER BY id', [id]);
      const { insertManagerHistory } = require('./managerHistory');
      await insertManagerHistory({
        kind: 'task',
        location: task.location,
        ref_no: task.task_no,
        label: 'Submitted',
        summary: { types: task.types },
        detail: {
          task_no: task.task_no,
          types: task.types,
          location: task.location,
          scan_count_mode: task.scan_count_mode,
          notes: task.notes,
          task_created_at: task.created_at,
          items: itemsRes.rows,
        },
      });
    } catch (histErr) {
      console.error(`Failed to record manager history for task ${id} submit:`, histErr.message);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/submit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:taskId/items/:itemId/poh
router.patch('/:taskId/items/:itemId/poh', async (req, res) => {
  try {
    const { taskId, itemId } = req.params;
    const { poh } = req.body;
    if (poh === undefined || poh === null) return res.status(400).json({ error: 'poh required' });

    const pohVal = parseInt(poh);
    if (isNaN(pohVal)) return res.status(400).json({ error: 'poh must be a number' });

    const itemRes = await pool.query(
      'SELECT * FROM task_items WHERE id = $1 AND task_id = $2',
      [itemId, taskId]
    );
    if (itemRes.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    const item = itemRes.rows[0];

    const isCorrect = item.soh !== null && pohVal === item.soh;

    await pool.query(
      `UPDATE task_items SET poh = $1, is_correct = $2 WHERE id = $3`,
      [pohVal, isCorrect, itemId]
    );

    const updated = await pool.query('SELECT * FROM task_items WHERE id = $1', [itemId]);
    res.json(updated.rows[0]);
  } catch (e) {
    console.error('PATCH /:taskId/items/:itemId/poh error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:taskId/items/:itemId/scan
router.patch('/:taskId/items/:itemId/scan', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { scan_history, poh, soh } = req.body;
    // is_correct 不再信任前端传来的值，服务端根据 poh === soh 重新计算，
    // 避免前端逻辑错误（例如按"最后一次操作类型"而非"数量是否一致"判断）污染数据库。
    const isCorrect = soh !== null && soh !== undefined && poh === soh;
    await pool.query(
      `UPDATE task_items 
       SET scan_history = $1, poh = $2, soh = $3, is_correct = $4
       WHERE id = $5`,
      [JSON.stringify(scan_history), poh, soh, isCorrect, itemId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH scan error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Scan Count mode ──────────────────────────────────────────────────────
// The three endpoints below are used ONLY by tasks created with
// scan_count_mode = TRUE (see the "Scan count" checkbox in CreatingTask.js).
// They read/write task_items.scan_count exclusively and never touch
// scan_history/poh/is_correct except at /complete-scan time (mirroring what
// a normal-mode Submit does). The existing /scan, /poh and /submit endpoints
// above are completely untouched by this section, so non-scan-count tasks
// are unaffected.

// PATCH /api/tasks/:taskId/items/:itemId/scan-count
// Atomically increments the scan tally for one item. Called silently by the
// manager's barcode-scan listener while working a Scan Count task — no
// popup, no feedback either way (including for a barcode not found in the
// task, which is handled by the caller before this is ever hit).
router.patch('/:taskId/items/:itemId/scan-count', async (req, res) => {
  try {
    const { taskId, itemId } = req.params;
    const result = await pool.query(
      `UPDATE task_items SET scan_count = scan_count + 1, ever_scanned = TRUE
       WHERE id = $1 AND task_id = $2 RETURNING id, scan_count`,
      [itemId, taskId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PATCH /:taskId/items/:itemId/scan-count error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/restart-scan
// "Restart Counting" — zeroes out scan_count for every item in the task, so
// the manager can start over if scans were duplicated/missed and can't be
// corrected any other way. Only meaningful (and only exposed in the UI)
// while the task is still in 'counting' status.
router.patch('/:id/restart-scan', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE task_items SET scan_count = 0, ever_scanned = FALSE WHERE task_id = $1', [id]);
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /:id/restart-scan error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/complete-scan
// "Complete Scan & Submit" — for every item in the task, looks up its
// current Shopify "available" quantity (soh) at the task's location, sets
// poh = scan_count (per Hera's spec: N scans = final counted quantity),
// recomputes is_correct the same way /scan and /poh already do (poh ===
// soh), then submits the task exactly like the normal-mode Submit does
// (status -> 'reviewing'). From that point on, the buyer's existing
// commit flow (PATCH /:id/commit) needs no changes: it just diffs poh vs
// soh, which now happens to have come from a scan tally instead of a
// manual count.
router.patch('/:id/complete-scan', async (req, res) => {
  try {
    const { id } = req.params;
    const task = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (task.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    if (!task.rows[0].scan_count_mode) {
      return res.status(400).json({ error: 'Task is not a Scan Count task' });
    }
    const shopifyLocationId = task.rows[0].shopify_location_id;

    const items = await pool.query('SELECT * FROM task_items WHERE task_id = $1', [id]);

    const { getShopify, getSession } = require('../shopify');
    const { fetchInventoryForBarcode } = require('./shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const warnings = [];

    for (const item of items.rows) {
      try {
        const info = await fetchInventoryForBarcode(client, item.barcode, shopifyLocationId);
        if (!info) {
          warnings.push(`Barcode ${item.barcode}: not found in Shopify`);
          continue;
        }
        const soh = info.soh;
        const poh = item.scan_count;
        const isCorrect = soh !== null && soh !== undefined && poh === soh;
        await pool.query(
          `UPDATE task_items SET soh = $1, poh = $2, is_correct = $3 WHERE id = $4`,
          [soh, poh, isCorrect, item.id]
        );
      } catch (e) {
        console.error(`complete-scan failed for item ${item.id} (barcode: ${item.barcode}):`, e.message);
        warnings.push(`Barcode ${item.barcode}: ${e.message}`);
      }
    }

    await pool.query(
      "UPDATE tasks SET status = 'reviewing', updated_at = NOW() WHERE id = $1",
      [id]
    );

    // Same manager-History freeze as the normal-mode /submit above — a Scan
    // Count task also leaves the manager's live list the moment this runs,
    // so it needs the same record. Read task_items fresh here (rather than
    // reusing the `items` fetched at the top of this handler) so the frozen
    // snapshot has the final soh/poh/is_correct values just written above,
    // not the pre-scan-complete state.
    try {
      const finalItemsRes = await pool.query('SELECT * FROM task_items WHERE task_id = $1 ORDER BY id', [id]);
      const { insertManagerHistory } = require('./managerHistory');
      await insertManagerHistory({
        kind: 'task',
        location: task.rows[0].location,
        ref_no: task.rows[0].task_no,
        label: 'Submitted',
        summary: { types: task.rows[0].types },
        detail: {
          task_no: task.rows[0].task_no,
          types: task.rows[0].types,
          location: task.rows[0].location,
          scan_count_mode: task.rows[0].scan_count_mode,
          notes: task.rows[0].notes,
          task_created_at: task.rows[0].created_at,
          items: finalItemsRes.rows,
        },
      });
    } catch (histErr) {
      console.error(`Failed to record manager history for task ${id} complete-scan:`, histErr.message);
    }

    if (warnings.length > 0) return res.json({ success: true, warnings });
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /:id/complete-scan error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────

// DELETE /api/tasks/:taskId/items
router.delete('/:taskId/items', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { itemIds } = req.body;
    if (!itemIds || itemIds.length === 0) return res.status(400).json({ error: 'No itemIds provided' });
    await pool.query('DELETE FROM task_items WHERE id = ANY($1) AND task_id = $2', [itemIds, taskId]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/tasks/:taskId/items error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id/publish
router.patch('/:id/publish', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      "UPDATE tasks SET status = 'counting', updated_at = NOW() WHERE id = $1 AND status = 'draft'",
      [id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/publish error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;