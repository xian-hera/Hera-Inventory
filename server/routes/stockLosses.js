const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// GET /api/stock-losses?location=MTL01
router.get('/', async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'location required' });

    const result = await pool.query(
      `SELECT * FROM stock_losses
       WHERE location = $1
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

    const result = await pool.query(
      `INSERT INTO stock_losses
        (barcode, name, product_type, vendor, location, shopify_location_id,
         reason, reason_label, reason_detail, qty, adjustment, soh,
         photo_urls, shopify_file_gids, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'reviewing',NOW())
       RETURNING *`,
      [
        barcode, name || '', product_type || null, vendor || null,
        location, shopify_location_id || '',
        reason, reason_label || reason, reason_detail || null,
        qty, adjustment, soh ?? null,
        photo_urls || [], shopify_file_gids || [],
      ]
    );
    res.json({ success: true, row: result.rows[0] });
  } catch (e) {
    console.error('POST /api/stock-losses error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/stock-losses/:id/commit
router.patch('/:id/commit', async (req, res) => {
  try {
    const { id } = req.params;
    const entry = await pool.query('SELECT * FROM stock_losses WHERE id = $1', [id]);
    if (entry.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    const row = entry.rows[0];

    if (row.status === 'committed') return res.json({ success: true, alreadyCommitted: true });

    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const variantRes = await client.request(`
      query {
        productVariants(first: 1, query: "barcode:${row.barcode}") {
          edges { node { inventoryItem { id } } }
        }
      }
    `);
    const invItemId = variantRes.data?.productVariants?.edges?.[0]?.node?.inventoryItem?.id;
    if (!invItemId) return res.status(404).json({ error: 'Inventory item not found in Shopify' });

    await client.request(`
      mutation {
        inventoryAdjustQuantities(input: {
          reason: "shrinkage",
          name: "available",
          changes: [{
            inventoryItemId: "${invItemId}",
            locationId: "${row.shopify_location_id}",
            delta: ${row.adjustment}
          }]
        }) {
          inventoryAdjustmentGroup { id }
          userErrors { field message code }
        }
      }
    `);

    await pool.query(
      "UPDATE stock_losses SET status = 'committed', committed_at = NOW() WHERE id = $1",
      [id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/stock-losses/:id/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/stock-losses/commit-many
router.patch('/commit-many', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });

    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const errors = [];

    for (const id of ids) {
      try {
        const entry = await pool.query('SELECT * FROM stock_losses WHERE id = $1', [id]);
        if (entry.rows.length === 0) { errors.push(`ID ${id}: not found`); continue; }
        const row = entry.rows[0];
        if (row.status === 'committed') continue;

        const variantRes = await client.request(`
          query {
            productVariants(first: 1, query: "barcode:${row.barcode}") {
              edges { node { inventoryItem { id } } }
            }
          }
        `);
        const invItemId = variantRes.data?.productVariants?.edges?.[0]?.node?.inventoryItem?.id;
        if (!invItemId) { errors.push(`Barcode ${row.barcode}: inventory item not found`); continue; }

        await client.request(`
          mutation {
            inventoryAdjustQuantities(input: {
              reason: "shrinkage",
              name: "available",
              changes: [{
                inventoryItemId: "${invItemId}",
                locationId: "${row.shopify_location_id}",
                delta: ${row.adjustment}
              }]
            }) {
              inventoryAdjustmentGroup { id }
              userErrors { field message code }
            }
          }
        `);

        await pool.query(
          "UPDATE stock_losses SET status = 'committed', committed_at = NOW() WHERE id = $1",
          [id]
        );
      } catch (e) {
        errors.push(`ID ${id}: ${e.message}`);
      }
    }

    if (errors.length > 0) return res.json({ success: true, warnings: errors });
    res.json({ success: true });
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
    await pool.query(
      "UPDATE stock_losses SET status = 'archived', archived_at = NOW() WHERE id = ANY($1)",
      [ids]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/stock-losses/archive error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/stock-losses
// Deletes entries and their Shopify Files photos (one by one per API spec)
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

    // Delete from Shopify Files one by one (API accepts single ID per call)
    if (allGids.length > 0) {
      try {
        const { getShopify, getSession } = require('../shopify');
        const session = await getSession();
        const shopify = getShopify();
        const client = new shopify.clients.Graphql({ session });

        for (const gid of allGids) {
          try {
            await client.request(`
              mutation {
                fileDelete(fileId: "${gid}") {
                  deletedFileId
                  userErrors { field message }
                }
              }
            `);
          } catch (e) {
            console.error(`fileDelete failed for ${gid} (non-fatal):`, e.message);
          }
        }
      } catch (e) {
        console.error('Shopify fileDelete setup error (non-fatal):', e.message);
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

    res.json({
      gid: file.id,
      url: file.image?.url || target.resourceUrl,
    });
  } catch (e) {
    console.error('POST /api/stock-losses/upload-photo error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;