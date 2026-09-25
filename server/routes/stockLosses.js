const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../database/init');

// Poll Shopify until a newly created file finishes processing and has a
// permanent CDN url. Shopify's fileCreate is async: right after creation
// file.image.url is usually null/undefined and the file status is
// PROCESSING. Without waiting for READY, callers would fall back to the
// temporary stagedUploadsCreate resourceUrl (shopify-staged-uploads/tmp/...),
// which Shopify garbage-collects after a few days — causing NoSuchKey
// errors later on. This function waits (with retries) until Shopify
// reports the file as READY and returns a real, permanent url.
async function waitForFileReady(client, gid, { maxAttempts = 10, delayMs = 1500 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await client.request(`
      query getFile($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            id
            status
            image { url }
          }
        }
      }
    `, {
      variables: { id: gid }
    });

    const node = res.data?.node;
    if (node?.status === 'READY' && node?.image?.url) {
      return node.image.url;
    }
    if (node?.status === 'FAILED') {
      throw new Error('Shopify file processing failed');
    }

    // Not ready yet — wait before checking again.
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  // Gave up waiting; caller decides how to handle a null url.
  return null;
}

// Runs in the background after a stock-loss entry with photos is created.
// Not awaited by the request handler — the HTTP response has already been
// sent by the time this resolves. Waits for each photo's Shopify file to
// finish processing, then writes the final permanent urls (and
// photo_status = 'ready') back onto the row. If any photo fails to
// process, or an unexpected error occurs, marks photo_status = 'failed'
// so the manager UI can show "Photo failed, please recreate".
async function processPhotosForEntry(rowId, gids) {
  if (!gids || gids.length === 0) return;
  try {
    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const urls = [];
    for (const gid of gids) {
      const url = await waitForFileReady(client, gid, { maxAttempts: 8, delayMs: 3000 });
      if (!url) {
        console.error(`processPhotosForEntry: gid ${gid} not ready for row ${rowId}`);
        await pool.query(
          "UPDATE stock_losses SET photo_status = 'failed', photo_status_updated_at = NOW() WHERE id = $1",
          [rowId]
        );
        return;
      }
      urls.push(url);
    }

    await pool.query(
      "UPDATE stock_losses SET photo_urls = $1, photo_status = 'ready', photo_status_updated_at = NOW() WHERE id = $2",
      [urls, rowId]
    );
  } catch (e) {
    console.error(`processPhotosForEntry error for row ${rowId}:`, e.message);
    try {
      await pool.query(
        "UPDATE stock_losses SET photo_status = 'failed', photo_status_updated_at = NOW() WHERE id = $1",
        [rowId]
      );
    } catch (e2) {
      console.error('processPhotosForEntry: failed to mark row as failed:', e2.message);
    }
  }
}

const STUCK_PHOTO_TIMEOUT_MINUTES = 10;

// Safety net: if the server restarts while processPhotosForEntry() is
// mid-flight, or a background job dies without updating the row (e.g. an
// uncaught exception, process crash), the row would stay 'processing'
// forever with nothing watching it. This periodic sweep marks any row
// stuck in 'processing' past a timeout as 'failed', so the manager sees
// "please recreate" instead of an item silently stuck forever. It does
// not retry — genuinely legitimate processing should finish within the
// retry budget in processPhotosForEntry (~24s per photo), so anything
// still 'processing' after this timeout is almost certainly abandoned.
async function sweepStuckPhotoRows() {
  try {
    const result = await pool.query(
      `UPDATE stock_losses
       SET photo_status = 'failed', photo_status_updated_at = NOW()
       WHERE photo_status = 'processing'
         AND photo_status_updated_at < NOW() - INTERVAL '${STUCK_PHOTO_TIMEOUT_MINUTES} minutes'
       RETURNING id`
    );
    if (result.rows.length > 0) {
      console.error(
        `sweepStuckPhotoRows: marked ${result.rows.length} stuck row(s) as failed:`,
        result.rows.map(r => r.id)
      );
    }
  } catch (e) {
    console.error('sweepStuckPhotoRows error:', e.message);
  }
}

// Run once shortly after the process starts (covers rows left stuck by a
// previous crash/restart), then periodically thereafter.
setTimeout(sweepStuckPhotoRows, 15000);
setInterval(sweepStuckPhotoRows, 2 * 60 * 1000);

// 2026-09-25, Hera — Commit rules:
//   - Only 'reviewing' entries can be committed. 'committed' / 'archived' /
//     'pending' entries are refused (an archived entry can never be
//     committed again, so its loss can't be deducted twice).
//   - A successful commit archives the entry right away
//     (status 'archived', committed_at + archived_at set).
//   - If Shopify rejects the adjustment (userErrors, or no adjustment group
//     returned), the entry stays 'reviewing' and the error goes back to the
//     buyer instead of being marked done.
//   - Each commit holds a row lock (SELECT ... FOR UPDATE inside a
//     transaction) while it talks to Shopify, so a double click, or
//     "Commit" + "Commit all" at the same time, can't deduct the same entry
//     twice: the second request waits, then sees the entry is no longer
//     'reviewing' and skips it.
function entryLabel(row) {
  return row.name ? `${row.name} (${row.barcode})` : `Barcode ${row.barcode}`;
}

// Throws when Shopify did not apply the adjustment.
function assertAdjustApplied(adjustRes, row) {
  const topErrors = adjustRes?.errors;
  if (topErrors && (Array.isArray(topErrors) ? topErrors.length : true)) {
    const msg = Array.isArray(topErrors) ? topErrors.map(e => e.message).join(', ') : (topErrors.message || String(topErrors));
    throw new Error(`${entryLabel(row)}: Shopify rejected the adjustment — ${msg}`);
  }
  const payload = adjustRes?.data?.inventoryAdjustQuantities;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`${entryLabel(row)}: Shopify rejected the adjustment — ${userErrors.map(e => e.message).join(', ')}`);
  }
  if (!payload?.inventoryAdjustmentGroup?.id) {
    throw new Error(`${entryLabel(row)}: Shopify did not confirm the adjustment`);
  }
}

router.get('/', async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'location required' });

    const result = await pool.query(
      `SELECT * FROM stock_losses
       WHERE location = $1
         AND status = 'pending'
         AND submitted_at >= NOW() - INTERVAL '15 days'
       ORDER BY submitted_at DESC`,
      [location]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/stock-losses error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stock-losses/buyer
router.get('/buyer', async (req, res) => {
  try {
    const { location, status, reason, date, types } = req.query;

    let conditions = [];
    let params = [];
    let idx = 1;

    if (location && location !== 'ALL') {
      const locs = location.split(',');
      conditions.push(`location = ANY($${idx++})`);
      params.push(locs);
    }
    if (status && status !== 'ALL') {
      const statuses = status.split(',');
      conditions.push(`status = ANY($${idx++})`);
      params.push(statuses);
    }
    if (reason && reason !== 'ALL') {
      conditions.push(`reason = $${idx++}`);
      params.push(reason);
    }
    if (date && date !== 'ALL') {
      let interval;
      if (date === 'today') interval = '1 day';
      else if (date === '7days') interval = '7 days';
      else if (date === '30days') interval = '30 days';
      if (interval) {
        conditions.push(`submitted_at >= NOW() - INTERVAL '${interval}'`);
      }
    }
    if (types && types !== 'ALL') {
      const typeList = types.split(',');
      conditions.push(`product_type = ANY($${idx++})`);
      params.push(typeList);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM stock_losses ${where} ORDER BY submitted_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/stock-losses/buyer error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stock-losses
router.post('/', async (req, res) => {
  try {
    const {
      barcode, name, product_type, vendor,
      location, shopify_location_id,
      reason, reason_label, reason_detail,
      qty, soh,
      photo_urls, shopify_file_gids,
    } = req.body;

    if (!barcode || !location || !reason || qty === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const adjustment = -Math.abs(qty);
    const hasPhotos = (shopify_file_gids || []).length > 0;

    const result = await pool.query(
      `INSERT INTO stock_losses
        (barcode, name, product_type, vendor, location, shopify_location_id,
         reason, reason_label, reason_detail, qty, adjustment, soh,
         photo_urls, shopify_file_gids, status, submitted_at,
         photo_status, photo_status_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',NOW(),$15,$16)
       RETURNING *`,
      [
        barcode, name || '', product_type || null, vendor || null,
        location, shopify_location_id || '',
        reason, reason_label || reason, reason_detail || null,
        qty, adjustment, soh ?? null,
        photo_urls || [], shopify_file_gids || [],
        hasPhotos ? 'processing' : null,
        hasPhotos ? new Date() : null,
      ]
    );

    // Fire-and-forget: wait for Shopify to finish processing the photos
    // and write the permanent urls back onto this row once ready. Not
    // awaited — the response below goes out immediately regardless.
    if (hasPhotos) {
      processPhotosForEntry(result.rows[0].id, shopify_file_gids).catch(e => {
        console.error('processPhotosForEntry unhandled error:', e.message);
      });
    }

    res.json({ success: true, row: result.rows[0] });
  } catch (e) {
    console.error('POST /api/stock-losses error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/stock-losses/:id/commit
router.patch('/:id/commit', async (req, res) => {
  // Row lock held for the whole commit — see "Commit rules" above.
  const db = await pool.connect();
  try {
    const { id } = req.params;
    await db.query('BEGIN');
    const entry = await db.query('SELECT * FROM stock_losses WHERE id = $1 FOR UPDATE', [id]);
    if (entry.rows.length === 0) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Entry not found' }); }
    const row = entry.rows[0];

    // Only 'reviewing' can be committed (was: only 'committed' was skipped,
    // so an archived entry could be committed — and deducted — again).
    if (row.status !== 'reviewing') {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: `${entryLabel(row)} is ${row.status} and can't be committed.` });
    }

    const { getShopify, getSession, activeFilter } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const variantRes = await client.request(`
      query {
        productVariants(first: 1, query: "${activeFilter(`barcode:${row.barcode}`)}") {
          edges { node { inventoryItem { id } } }
        }
      }
    `);
    const invItemId = variantRes.data?.productVariants?.edges?.[0]?.node?.inventoryItem?.id;
    if (!invItemId) { await db.query('ROLLBACK'); return res.status(404).json({ error: `${entryLabel(row)}: inventory item not found in Shopify` }); }

    // changeFromQuantity became a required argument as of Shopify API version
    // 2026-04 (compare-and-swap protection against concurrent inventory
    // writes). We don't have a fresh location-scoped quantity in hand here,
    // so we pass null to explicitly opt out — identical to this mutation's
    // pre-2026-04 behavior, no functional change, just satisfies the new
    // required-argument validation.
    // Separately, API 2026-04 also requires an idempotency key via the
    // @idempotent directive on this mutation (a different breaking change —
    // see Shopify changelog "Making idempotency mandatory for inventory
    // adjustments and refund mutations"). A fresh UUID per call is correct:
    // this is a new inventory change each time, not a retry of a prior one.
    const adjustRes = await client.request(`
      mutation {
        inventoryAdjustQuantities(input: {
          reason: "shrinkage",
          name: "available",
          changes: [{
            inventoryItemId: "${invItemId}",
            locationId: "${row.shopify_location_id}",
            delta: ${row.adjustment},
            changeFromQuantity: null
          }]
        }) @idempotent(key: "${crypto.randomUUID()}") {
          inventoryAdjustmentGroup { id }
          userErrors { field message code }
        }
      }
    `);
    // Shopify refused → stays 'reviewing', error shown to the buyer.
    assertAdjustApplied(adjustRes, row);

    // Committed → archived straight away (Hera 2026-09-25).
    await db.query(
      "UPDATE stock_losses SET status = 'archived', committed_at = NOW(), archived_at = NOW() WHERE id = $1",
      [id]
    );
    await db.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch (_) { /* already closed */ }
    console.error('PATCH /api/stock-losses/:id/commit error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    db.release();
  }
});

// PATCH /api/stock-losses/submit-many — manager submits items to buyer (pending → reviewing)
router.patch('/submit-many', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
    // Server-side safety net mirroring the frontend's own check: never move
    // an item to 'reviewing' while its photos are still processing or
    // failed, even if a client somehow sends its id anyway.
    const result = await pool.query(
      `UPDATE stock_losses SET status = 'reviewing', submitted_at = NOW()
       WHERE id = ANY($1) AND status = 'pending'
         AND (photo_status IS NULL OR photo_status = 'ready')
       RETURNING id`,
      [ids]
    );
    const submittedIds = result.rows.map(r => r.id);
    const skippedIds = ids.filter(id => !submittedIds.includes(id));
    res.json({ success: true, submittedIds, skippedIds });
  } catch (e) {
    console.error('PATCH /api/stock-losses/submit-many error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/stock-losses/commit-many
router.patch('/commit-many', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });

    const { getShopify, getSession, activeFilter } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const errors = [];

    let committedCount = 0;
    for (const id of ids) {
      // One transaction + row lock per entry — see "Commit rules" above.
      const db = await pool.connect();
      let row = null;
      try {
        await db.query('BEGIN');
        const entry = await db.query('SELECT * FROM stock_losses WHERE id = $1 FOR UPDATE', [id]);
        if (entry.rows.length === 0) { await db.query('ROLLBACK'); errors.push(`ID ${id}: not found`); continue; }
        row = entry.rows[0];
        // Only 'reviewing' can be committed; anything else is skipped and
        // reported (was: only 'committed' was skipped).
        if (row.status !== 'reviewing') {
          await db.query('ROLLBACK');
          errors.push(`${entryLabel(row)} is ${row.status} — skipped`);
          continue;
        }

        const variantRes = await client.request(`
          query {
            productVariants(first: 1, query: "${activeFilter(`barcode:${row.barcode}`)}") {
              edges { node { inventoryItem { id } } }
            }
          }
        `);
        const invItemId = variantRes.data?.productVariants?.edges?.[0]?.node?.inventoryItem?.id;
        if (!invItemId) { await db.query('ROLLBACK'); errors.push(`${entryLabel(row)}: inventory item not found`); continue; }

        // See the single-item /:id/commit route above for why changeFromQuantity
        // is explicitly null here (required as of API 2026-04; null opts out
        // of the compare-and-swap check, matching this mutation's pre-2026-04
        // behavior) and why @idempotent(key: ...) is now required too (a
        // separate 2026-04 breaking change; fresh UUID per call is correct).
        const adjustRes = await client.request(`
          mutation {
            inventoryAdjustQuantities(input: {
              reason: "shrinkage",
              name: "available",
              changes: [{
                inventoryItemId: "${invItemId}",
                locationId: "${row.shopify_location_id}",
                delta: ${row.adjustment},
                changeFromQuantity: null
              }]
            }) @idempotent(key: "${crypto.randomUUID()}") {
              inventoryAdjustmentGroup { id }
              userErrors { field message code }
            }
          }
        `);
        // Shopify refused → stays 'reviewing', reported in warnings.
        assertAdjustApplied(adjustRes, row);

        // Committed → archived straight away (Hera 2026-09-25).
        await db.query(
          "UPDATE stock_losses SET status = 'archived', committed_at = NOW(), archived_at = NOW() WHERE id = $1",
          [id]
        );
        await db.query('COMMIT');
        committedCount++;
      } catch (e) {
        try { await db.query('ROLLBACK'); } catch (_) { /* already closed */ }
        const label = row ? entryLabel(row) : `ID ${id}`;
        const msg = e.message || String(e);
        errors.push(msg.startsWith(label) ? msg : `${label}: ${msg}`);
      } finally {
        db.release();
      }
    }

    if (errors.length > 0) return res.json({ success: true, committedCount, warnings: errors });
    res.json({ success: true, committedCount });
  } catch (e) {
    console.error('PATCH /api/stock-losses/commit-many error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/stock-losses/archive
router.patch('/archive', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
    // Only 'committed' entries can be archived (Hera 2026-09-25). New commits
    // archive themselves; this is for entries committed before that change.
    const result = await pool.query(
      "UPDATE stock_losses SET status = 'archived', archived_at = NOW() WHERE id = ANY($1) AND status = 'committed' RETURNING id",
      [ids]
    );
    const archivedIds = result.rows.map(r => r.id);
    const skippedCount = ids.filter(id => !archivedIds.includes(Number(id))).length;
    res.json({ success: true, archivedIds, skippedCount });
  } catch (e) {
    console.error('PATCH /api/stock-losses/archive error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/stock-losses
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });

    // Fetch gids before deleting
    const entries = await pool.query(
      'SELECT shopify_file_gids FROM stock_losses WHERE id = ANY($1)',
      [ids]
    );
    const allGids = entries.rows.flatMap(r => r.shopify_file_gids || []).filter(Boolean);

    // Delete from Shopify Files in a single batch call
    if (allGids.length > 0) {
      try {
        const { getShopify, getSession } = require('../shopify');
        const session = await getSession();
        const shopify = getShopify();
        const client = new shopify.clients.Graphql({ session });

        const gidList = allGids.map(g => `"${g}"`).join(', ');
        await client.request(`
          mutation {
            fileDelete(fileIds: [${gidList}]) {
              deletedFileIds
              userErrors { field message }
            }
          }
        `);
      } catch (e) {
        console.error('Shopify fileDelete error (non-fatal):', e.message);
      }
    }

    await pool.query('DELETE FROM stock_losses WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/stock-losses error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stock-losses/upload-photo
router.post('/upload-photo', async (req, res) => {
  try {
    const { base64, mimeType, sku, index } = req.body;
    if (!base64 || !mimeType || !sku) return res.status(400).json({ error: 'Missing fields' });

    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const ext = mimeType.split('/')[1] || 'jpg';
    const filename = `stock_losses_${sku}_${index || Date.now()}.${ext}`;
    const buffer = Buffer.from(base64, 'base64');
    const fileSize = String(buffer.length);

    // Step 1: Get staged upload URL
    const stageRes = await client.request(`
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        input: [{
          resource: 'IMAGE',
          filename,
          mimeType,
          fileSize,
          httpMethod: 'POST',
        }]
      }
    });

    const userErrors = stageRes.data?.stagedUploadsCreate?.userErrors || [];
    if (userErrors.length > 0) {
      return res.status(500).json({ error: userErrors[0].message });
    }

    const target = stageRes.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) return res.status(500).json({ error: 'Failed to get staged upload URL' });

    // Step 2: Upload file to staged URL
    const FormData = require('form-data');
    const axios = require('axios');
    const formData = new FormData();
    target.parameters.forEach(p => formData.append(p.name, p.value));
    formData.append('file', buffer, { filename, contentType: mimeType });

    await axios.post(target.url, formData, { headers: formData.getHeaders() });

    // Step 3: Create file record in Shopify
    const fileRes = await client.request(`
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            ... on MediaImage {
              image { url }
            }
          }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        files: [{
          filename,
          contentType: 'IMAGE',
          originalSource: target.resourceUrl,
        }]
      }
    });

    const fileUserErrors = fileRes.data?.fileCreate?.userErrors || [];
    if (fileUserErrors.length > 0) {
      return res.status(500).json({ error: fileUserErrors[0].message });
    }

    const file = fileRes.data?.fileCreate?.files?.[0];
    if (!file) return res.status(500).json({ error: 'Failed to create file in Shopify' });

    // Return immediately — do NOT block the request waiting for Shopify to
    // finish processing the image. Shopify's fileCreate is async, so
    // file.image?.url is usually still null/undefined at this point.
    // Deliberately do NOT fall back to target.resourceUrl here either —
    // that url is a temporary staged-upload link that Shopify garbage
    // collects after a few days, which is what caused the original
    // NoSuchKey bug. The gid is enough for the frontend to attach to the
    // entry; the permanent url gets filled in asynchronously by
    // processPhotosForEntry() once the entry is created via POST /.
    res.json({
      gid: file.id,
      url: file.image?.url || null,
    });
  } catch (e) {
    console.error('POST /api/stock-losses/upload-photo error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;