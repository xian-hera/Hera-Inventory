const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

const HISTORY_LIMIT = 200;
const RECENT_LIMIT = 20;

async function shopifyRequest(client, query, variables = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return variables ? await client.request(query, { variables }) : await client.request(query);
    } catch (e) {
      const is429 = e?.response?.status === 429 || e?.message?.includes('hrottled');
      if (is429 && i < retries - 1) {
        await new Promise(r => setTimeout(r, (i + 1) * 1000));
        continue;
      }
      throw e;
    }
  }
}

// ─── Currency / discount / adjustment math ──────────────────────────────────

// Parses a discount cell such as "10%", "-2", "2", "" or null.
// Returns { isPercent, value } where value is the raw number (no sign flip applied).
function parseDiscountCell(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const isPercent = str.endsWith('%');
  const numStr = isPercent ? str.slice(0, -1) : str;
  const value = parseFloat(numStr);
  if (isNaN(value)) return null;
  return { isPercent, value };
}

// Parses the "Add adjustment" amount field, which uses the same "%"-suffix
// convention as the CSV unit-discount column to distinguish amount vs percentage.
function parseAdjustmentInput(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const str = String(raw).trim();
  const isPercent = str.endsWith('%');
  const numStr = isPercent ? str.slice(0, -1) : str;
  const value = parseFloat(numStr);
  if (isNaN(value)) return null;
  return { type: isPercent ? 'percentage' : 'amount', value };
}

// Converts + discounts each raw CSV row into { costBeforeAdjustment } (CAD),
// then applies the invoice-level adjustment (if any) across all rows to
// produce { effectiveCost } per row.
function computeLineItems(rawRows, { currency, fxRate }, adjustment) {
  const fx = currency === 'USD' ? Number(fxRate) : 1;

  const withDiscount = rawRows.map(row => {
    const rawCost = Number(row.cost);
    let costCAD = rawCost * fx;
    const discount = parseDiscountCell(row.unitDiscount);
    let costBeforeAdjustment = costCAD;
    if (discount) {
      if (discount.isPercent) {
        costBeforeAdjustment = costCAD - costCAD * (discount.value / 100);
      } else {
        costBeforeAdjustment = costCAD - discount.value * fx;
      }
    }
    return { ...row, rawCost, costBeforeAdjustment };
  });

  if (!adjustment) {
    return withDiscount.map(r => ({ ...r, effectiveCost: r.costBeforeAdjustment }));
  }

  const orderSubtotal = withDiscount.reduce((sum, r) => sum + r.costBeforeAdjustment * Number(r.quantity), 0);

  return withDiscount.map(r => {
    const lineTotal = r.costBeforeAdjustment * Number(r.quantity);
    let lineAdjustment;
    if (adjustment.type === 'amount') {
      lineAdjustment = orderSubtotal > 0 ? adjustment.value * (lineTotal / orderSubtotal) : 0;
    } else {
      lineAdjustment = lineTotal * (adjustment.value / 100);
    }
    const effectiveCost = Number(r.quantity) > 0 ? (lineTotal + lineAdjustment) / Number(r.quantity) : r.costBeforeAdjustment;
    return { ...r, effectiveCost };
  });
}

// ─── Home page / history ─────────────────────────────────────────────────────

// GET /api/po-invoices/recent — last 20 committed, for the PO Receiving home page.
router.get('/recent', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.id, i.invoice_number, i.committed_at, i.is_promotional, s.name AS supplier_name
       FROM po_invoices i JOIN po_suppliers s ON s.id = i.supplier_id
       WHERE i.status = 'committed'
       ORDER BY i.committed_at DESC LIMIT $1`,
      [RECENT_LIMIT]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/po-invoices/recent error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/po-invoices/history — last 200 committed, for the "View all" page.
router.get('/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.id, i.invoice_number, i.committed_at, i.is_promotional, s.name AS supplier_name
       FROM po_invoices i JOIN po_suppliers s ON s.id = i.supplier_id
       WHERE i.status = 'committed'
       ORDER BY i.committed_at DESC LIMIT $1`,
      [HISTORY_LIMIT]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/po-invoices/history error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/po-invoices/check-number?number=... — advisory only; the
// authoritative check happens again in POST /process to avoid races.
router.get('/check-number', async (req, res) => {
  try {
    const { number } = req.query;
    if (!number) return res.json({ available: true });
    const result = await pool.query('SELECT id FROM po_invoices WHERE LOWER(invoice_number) = LOWER($1)', [number]);
    res.json({ available: result.rows.length === 0 });
  } catch (e) {
    console.error('GET /api/po-invoices/check-number error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Processing (create or re-process a pending invoice) ────────────────────

// POST /api/po-invoices/process
// Body: {
//   invoiceId?: number,            // present when re-processing an existing pending invoice
//   invoiceNumber, supplierId, productTypes: string[], location, adjustment: string|null,
//   rows: [{ code, name, quantity, cost, unitDiscount }]
// }
router.post('/process', async (req, res) => {
  const client = await pool.connect();
  try {
    const { invoiceId, invoiceNumber, supplierId, productTypes, location, adjustment: adjustmentRaw, rows } = req.body;

    if (!invoiceNumber || !supplierId || !productTypes?.length || !location || !rows?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Duplicate unit code within this CSV → hard error, no processing.
    const codes = rows.map(r => String(r.code || '').trim());
    const seen = new Set();
    const dupeCodes = new Set();
    for (const c of codes) {
      if (seen.has(c)) dupeCodes.add(c);
      seen.add(c);
    }
    if (dupeCodes.size > 0) {
      return res.status(400).json({
        error: `Duplicate unit code(s) in CSV: ${Array.from(dupeCodes).join(', ')}. Please fix the CSV and re-upload.`,
      });
    }

    // Uniqueness check (case-insensitive), excluding this invoice if re-processing.
    const dupeParams = invoiceId ? [invoiceNumber, invoiceId] : [invoiceNumber];
    const dupeQuery = invoiceId
      ? 'SELECT id FROM po_invoices WHERE LOWER(invoice_number) = LOWER($1) AND id != $2'
      : 'SELECT id FROM po_invoices WHERE LOWER(invoice_number) = LOWER($1)';
    const dupeInvoice = await pool.query(dupeQuery, dupeParams);
    if (dupeInvoice.rows.length > 0) {
      return res.status(409).json({ error: 'An invoice with this number already exists' });
    }

    const supplierRes = await pool.query('SELECT * FROM po_suppliers WHERE id = $1', [supplierId]);
    if (supplierRes.rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    const supplier = supplierRes.rows[0];

    const locRes = await pool.query('SELECT shopify_location_id FROM location_map WHERE location_name = $1', [location]);
    if (locRes.rows.length === 0) return res.status(400).json({ error: 'Unknown location' });
    const shopifyLocationId = locRes.rows[0].shopify_location_id;

    // Look up code → sku within this supplier's mapping.
    const skuRes = await pool.query(
      'SELECT code, sku, name FROM po_supplier_skus WHERE supplier_id = $1 AND code = ANY($2)',
      [supplierId, codes]
    );
    const skuByCode = new Map(skuRes.rows.map(r => [r.code, r]));

    const adjustment = parseAdjustmentInput(adjustmentRaw);
    const computed = computeLineItems(rows, { currency: supplier.currency, fxRate: supplier.fx_rate }, adjustment);

    // SKU collision: two different codes resolving to the same SKU.
    const skuToCodes = new Map();
    computed.forEach(r => {
      const mapped = skuByCode.get(String(r.code).trim());
      if (mapped?.sku) {
        const list = skuToCodes.get(mapped.sku) || [];
        list.push(r.code);
        skuToCodes.set(mapped.sku, list);
      }
    });
    const hasCollision = Array.from(skuToCodes.values()).some(list => list.length > 1);

    let hasMissing = false;
    const finalItems = computed.map(r => {
      const mapped = skuByCode.get(String(r.code).trim());
      const isMissing = !mapped?.sku;
      if (isMissing) hasMissing = true;
      return {
        code: r.code,
        sku: mapped?.sku || null,
        name: r.name,
        quantity: Number(r.quantity),
        raw_cost: r.rawCost,
        unit_discount_raw: r.unitDiscount ?? null,
        cost_before_adjustment: r.costBeforeAdjustment,
        effective_cost: r.effectiveCost,
        is_missing: isMissing,
      };
    });

    await client.query('BEGIN');

    let invoiceRow;
    if (invoiceId) {
      const updated = await client.query(
        `UPDATE po_invoices SET
           invoice_number = $1, supplier_id = $2, product_types = $3, location = $4,
           shopify_location_id = $5, adjustment_type = $6, adjustment_value = $7,
           has_missing_sku = $8, has_sku_collision = $9, updated_at = NOW()
         WHERE id = $10 AND status = 'pending' RETURNING *`,
        [
          invoiceNumber, supplierId, productTypes, location, shopifyLocationId,
          adjustment?.type || null, adjustment?.value ?? null, hasMissing, hasCollision, invoiceId,
        ]
      );
      if (updated.rows.length === 0) throw new Error('Invoice not found or already committed');
      invoiceRow = updated.rows[0];
      await client.query('DELETE FROM po_invoice_items WHERE invoice_id = $1', [invoiceId]);
    } else {
      const inserted = await client.query(
        `INSERT INTO po_invoices
           (invoice_number, supplier_id, product_types, location, shopify_location_id,
            adjustment_type, adjustment_value, has_missing_sku, has_sku_collision, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW()) RETURNING *`,
        [
          invoiceNumber, supplierId, productTypes, location, shopifyLocationId,
          adjustment?.type || null, adjustment?.value ?? null, hasMissing, hasCollision,
        ]
      );
      invoiceRow = inserted.rows[0];
    }

    for (const item of finalItems) {
      await client.query(
        `INSERT INTO po_invoice_items
           (invoice_id, code, sku, name, quantity, raw_cost, unit_discount_raw, cost_before_adjustment, effective_cost, is_missing)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          invoiceRow.id, item.code, item.sku, item.name, item.quantity, item.raw_cost,
          item.unit_discount_raw, item.cost_before_adjustment, item.effective_cost, item.is_missing,
        ]
      );
    }

    await client.query('COMMIT');

    res.json({ invoice: invoiceRow, items: finalItems, hasMissing, hasCollision });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/po-invoices/process error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── Pending (Commit later) ──────────────────────────────────────────────────

// GET /api/po-invoices/pending
router.get('/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.id, i.invoice_number, i.location, s.name AS supplier_name,
              COALESCE(SUM(it.quantity), 0) AS quantity
       FROM po_invoices i
       JOIN po_suppliers s ON s.id = i.supplier_id
       LEFT JOIN po_invoice_items it ON it.invoice_id = i.id
       WHERE i.status = 'pending'
       GROUP BY i.id, i.invoice_number, i.location, s.name
       ORDER BY i.created_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/po-invoices/pending error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/po-invoices/pending/:id — re-matches only the rows that were
// missing a SKU last time; everything else is returned as stored.
router.get('/pending/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const invRes = await pool.query(
      `SELECT i.*, s.name AS supplier_name, s.currency AS supplier_currency, s.fx_rate
       FROM po_invoices i JOIN po_suppliers s ON s.id = i.supplier_id WHERE i.id = $1`,
      [id]
    );
    if (invRes.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = invRes.rows[0];

    const itemsRes = await pool.query('SELECT * FROM po_invoice_items WHERE invoice_id = $1 ORDER BY is_missing DESC, id ASC', [id]);
    let items = itemsRes.rows;

    const missingCodes = items.filter(i => i.is_missing).map(i => i.code);
    if (missingCodes.length > 0) {
      const skuRes = await pool.query(
        'SELECT code, sku FROM po_supplier_skus WHERE supplier_id = $1 AND code = ANY($2)',
        [invoice.supplier_id, missingCodes]
      );
      const found = new Map(skuRes.rows.map(r => [r.code, r.sku]));
      let changed = false;
      items = items.map(item => {
        if (item.is_missing && found.has(item.code)) {
          changed = true;
          return { ...item, sku: found.get(item.code), is_missing: false };
        }
        return item;
      });
      if (changed) {
        for (const item of items) {
          await pool.query('UPDATE po_invoice_items SET sku = $1, is_missing = $2 WHERE id = $3', [item.sku, item.is_missing, item.id]);
        }
        const stillMissing = items.some(i => i.is_missing);
        await pool.query('UPDATE po_invoices SET has_missing_sku = $1 WHERE id = $2', [stillMissing, id]);
        invoice.has_missing_sku = stillMissing;
      }
    }

    res.json({ invoice, items });
  } catch (e) {
    console.error('GET /api/po-invoices/pending/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/po-invoices/pending/:id — edits that don't require re-processing
// (supplier / type / location / adjustment / promotional flag).
router.patch('/pending/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { isPromotional } = req.body;
    if (isPromotional === undefined) return res.status(400).json({ error: 'Nothing to update' });

    const result = await pool.query(
      `UPDATE po_invoices SET is_promotional = $1, updated_at = NOW() WHERE id = $2 AND status = 'pending' RETURNING *`,
      [isPromotional, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found or already committed' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PATCH /api/po-invoices/pending/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/po-invoices/pending — body: { ids: [...] }
router.delete('/pending', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
    await pool.query(`DELETE FROM po_invoices WHERE id = ANY($1) AND status = 'pending'`, [ids]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/po-invoices/pending error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Commit ───────────────────────────────────────────────────────────────

async function getVariantSnapshot(client, barcode) {
  const query = `
    query getVariant($barcode: String!) {
      productVariants(first: 1, query: $barcode) {
        edges {
          node {
            id
            inventoryItem {
              id
              unitCost { amount }
              inventoryLevels(first: 50) {
                edges { node { quantities(names: ["available"]) { name quantity } } }
              }
            }
          }
        }
      }
    }
  `;
  const response = await shopifyRequest(client, query, { barcode: `barcode:${barcode}` });
  const node = response?.data?.productVariants?.edges?.[0]?.node;
  if (!node) return null;
  const currentQty = (node.inventoryItem.inventoryLevels?.edges || [])
    .reduce((sum, e) => sum + (e.node.quantities.find(q => q.name === 'available')?.quantity || 0), 0);
  const currentCost = node.inventoryItem.unitCost?.amount ? Number(node.inventoryItem.unitCost.amount) : 0;
  return { inventoryItemId: node.inventoryItem.id, currentQty, currentCost };
}

// Commits a single invoice: updates Shopify cost (moving weighted average,
// skipped entirely for promotional invoices) and adds the received quantity
// to the specified location. Throws on any blocking condition or Shopify error.
async function commitInvoice(invoiceId) {
  const invRes = await pool.query('SELECT * FROM po_invoices WHERE id = $1', [invoiceId]);
  if (invRes.rows.length === 0) throw new Error('Invoice not found');
  const invoice = invRes.rows[0];
  if (invoice.status === 'committed') return { alreadyCommitted: true };
  if (invoice.has_missing_sku) throw new Error('Invoice has line item(s) missing SKU');
  if (invoice.has_sku_collision) throw new Error('Invoice has line item(s) with a SKU collision');

  const itemsRes = await pool.query('SELECT * FROM po_invoice_items WHERE invoice_id = $1', [invoiceId]);
  const items = itemsRes.rows;

  const { getShopify, getSession } = require('../shopify');
  const session = await getSession();
  const shopify = getShopify();
  const client = new shopify.clients.Graphql({ session });

  for (const item of items) {
    // Resumability: if a previous attempt at this commit already applied this
    // item's Shopify changes before failing partway through, skip it now so
    // it isn't double-applied (inventory added twice, average cost skewed).
    if (item.committed) continue;

    const snapshot = await getVariantSnapshot(client, item.sku);
    if (!snapshot) throw new Error(`SKU ${item.sku}: inventory item not found in Shopify`);

    if (!invoice.is_promotional) {
      const totalQty = snapshot.currentQty + item.quantity;
      const newCost = totalQty > 0
        ? (snapshot.currentQty * snapshot.currentCost + item.quantity * Number(item.effective_cost)) / totalQty
        : Number(item.effective_cost);

      const costResp = await shopifyRequest(client, `
        mutation updateCost($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) {
            inventoryItem { id }
            userErrors { field message }
          }
        }
      `, { id: snapshot.inventoryItemId, input: { cost: newCost } });
      const costErrors = costResp?.data?.inventoryItemUpdate?.userErrors || [];
      if (costErrors.length > 0) {
        throw new Error(`SKU ${item.sku}: cost update failed — ${costErrors.map(e => e.message).join('; ')}`);
      }

      await pool.query(
        `UPDATE po_supplier_skus SET
           last_cost = $1, cost_sum = cost_sum + $1, cost_count = cost_count + 1,
           name = $2, updated_at = NOW()
         WHERE supplier_id = $3 AND code = $4`,
        [item.effective_cost, item.name, invoice.supplier_id, item.code]
      );
    } else {
      await pool.query(
        `UPDATE po_supplier_skus SET name = $1, updated_at = NOW() WHERE supplier_id = $2 AND code = $3`,
        [item.name, invoice.supplier_id, item.code]
      );
    }

    const invResp = await shopifyRequest(client, `
      mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          inventoryAdjustmentGroup { id }
          userErrors { field message code }
        }
      }
    `, {
      input: {
        reason: 'received',
        name: 'available',
        changes: [{
          inventoryItemId: snapshot.inventoryItemId,
          locationId: invoice.shopify_location_id,
          delta: item.quantity,
        }],
      },
    });
    const invErrors = invResp?.data?.inventoryAdjustQuantities?.userErrors || [];
    if (invErrors.length > 0) {
      throw new Error(`SKU ${item.sku}: inventory adjustment failed — ${invErrors.map(e => e.message).join('; ')}`);
    }

    // Mark this item done immediately so a mid-loop failure on a later item
    // leaves an accurate record of what has already been applied to Shopify.
    await pool.query(`UPDATE po_invoice_items SET committed = TRUE WHERE id = $1`, [item.id]);
  }

  await pool.query(`UPDATE po_invoices SET status = 'committed', committed_at = NOW() WHERE id = $1`, [invoiceId]);
  await pool.query('UPDATE po_suppliers SET last_committed_at = NOW() WHERE id = $1', [invoice.supplier_id]);

  // Retention: keep only the most recent 200 committed invoices.
  await pool.query(`
    DELETE FROM po_invoices WHERE status = 'committed' AND id NOT IN (
      SELECT id FROM po_invoices WHERE status = 'committed' ORDER BY committed_at DESC LIMIT ${HISTORY_LIMIT}
    )
  `);

  return { success: true };
}

// POST /api/po-invoices/pending/:id/commit
router.post('/pending/:id/commit', async (req, res) => {
  try {
    const result = await commitInvoice(Number(req.params.id));
    res.json(result);
  } catch (e) {
    console.error('POST /api/po-invoices/pending/:id/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/po-invoices/pending/commit-many — body: { ids: [...] }
// Skips invoices with missing SKU / collisions and reports which were skipped.
router.post('/pending/commit-many', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });

    const skipped = [];
    for (const id of ids) {
      try {
        await commitInvoice(id);
      } catch (e) {
        const numRes = await pool.query('SELECT invoice_number FROM po_invoices WHERE id = $1', [id]);
        skipped.push({ id, invoiceNumber: numRes.rows[0]?.invoice_number || id, reason: e.message });
      }
    }

    res.json({ success: true, skipped });
  } catch (e) {
    console.error('POST /api/po-invoices/pending/commit-many error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Committed history detail ────────────────────────────────────────────────

// GET /api/po-invoices/committed/:id
router.get('/committed/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const invRes = await pool.query(
      `SELECT i.*, s.name AS supplier_name, s.currency AS supplier_currency, s.fx_rate
       FROM po_invoices i JOIN po_suppliers s ON s.id = i.supplier_id WHERE i.id = $1 AND i.status = 'committed'`,
      [id]
    );
    if (invRes.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const itemsRes = await pool.query('SELECT * FROM po_invoice_items WHERE invoice_id = $1 ORDER BY id ASC', [id]);
    res.json({ invoice: invRes.rows[0], items: itemsRes.rows });
  } catch (e) {
    console.error('GET /api/po-invoices/committed/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/po-invoices/committed/:id — removes the local history record only.
router.delete('/committed/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM po_invoices WHERE id = $1 AND status = 'committed'`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/po-invoices/committed/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/po-invoices/committed — clears all committed history (Settings page).
router.delete('/committed', async (req, res) => {
  try {
    await pool.query(`DELETE FROM po_invoices WHERE status = 'committed'`);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/po-invoices/committed error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
