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

// Converts + discounts each row into { costBeforeAdjustment } (CAD), then
// applies the invoice-level adjustment (if any) across all rows to produce
// { effectiveCost } per row. `row.rawCost` must already be resolved (either
// the CSV's own cost cell, or the supplier's metafield-synced cost used as a
// fallback when the CSV cell was blank — see the resolution pass in POST
// /process) — this function only does currency conversion + discount +
// adjustment math, it doesn't know about the fallback. A row whose rawCost
// is null (no CSV cost AND no fallback available) carries null all the way
// through instead of producing NaN — POST /process flags such rows via
// has_missing_cost and commitInvoice() refuses to commit them.
function computeLineItems(rawRows, { currency, fxRate }, adjustment) {
  const fx = currency === 'USD' ? Number(fxRate) : 1;

  const withDiscount = rawRows.map(row => {
    if (row.rawCost === null) return { ...row, costBeforeAdjustment: null };
    // row.rawCost is the cost used for math — either the CSV cell or (when
    // that was blank) the Supplier cost metafield fallback. Both are always
    // in the supplier's own invoice currency, so fx applies uniformly here
    // regardless of which one it is (row.displayRawCost, carried through
    // separately, is what actually reflects "was there a real CSV value" —
    // see POST /process).
    const rawCost = Number(row.rawCost);
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

  // Rows with no cost contribute 0 to the order subtotal and simply keep a
  // null effective cost — they don't participate in the adjustment spread.
  const orderSubtotal = withDiscount.reduce((sum, r) => sum + (r.costBeforeAdjustment ?? 0) * Number(r.quantity), 0);

  return withDiscount.map(r => {
    if (r.costBeforeAdjustment === null) return { ...r, effectiveCost: null };
    const lineTotal = r.costBeforeAdjustment * Number(r.quantity);
    let lineAdjustment;
    if (adjustment.type === 'amount') {
      // adjustment.value is entered in the supplier's own currency (Card 3's
      // "amount in USD" placeholder for a USD supplier) — convert to CAD via
      // fx before spreading it proportionally across the CAD line totals.
      // Percentage-type adjustments don't need this: a percentage of the CAD
      // subtotal is the same percentage regardless of currency.
      lineAdjustment = orderSubtotal > 0 ? adjustment.value * fx * (lineTotal / orderSubtotal) : 0;
    } else {
      lineAdjustment = lineTotal * (adjustment.value / 100);
    }
    const effectiveCost = Number(r.quantity) > 0 ? (lineTotal + lineAdjustment) / Number(r.quantity) : r.costBeforeAdjustment;
    return { ...r, effectiveCost };
  });
}

// Generates the next auto-assigned, canonical PO number: PO-A000, PO-A001,
// … PO-A999, PO-B000, … Assigned once, at the moment a pending invoice row
// is first created (POST /process with no invoiceId) — never reassigned on
// reprocess or commit. Mirrors generateTaskNo() in server/routes/tasks.js.
async function generatePoNumber(client) {
  const result = await client.query('SELECT last_number, last_letter FROM po_number_counter WHERE id = 1 FOR UPDATE');
  let { last_number, last_letter } = result.rows[0];

  last_number += 1;
  if (last_number > 999) {
    last_number = 0;
    last_letter = String.fromCharCode(last_letter.charCodeAt(0) + 1);
  }

  await client.query(
    'UPDATE po_number_counter SET last_number = $1, last_letter = $2 WHERE id = 1',
    [last_number, last_letter]
  );

  return `PO-${last_letter}${String(last_number).padStart(3, '0')}`;
}

// ─── Home page / history ─────────────────────────────────────────────────────

// GET /api/po-invoices/recent — last 20 committed, for the PO Receiving home page.
router.get('/recent', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.id, i.invoice_number, i.po_number, i.committed_at, i.is_promotional, s.name AS supplier_name,
              COALESCE(SUM(it.quantity * it.effective_cost), 0) AS subtotal_cad
       FROM po_invoices i
       JOIN po_suppliers s ON s.id = i.supplier_id
       LEFT JOIN po_invoice_items it ON it.invoice_id = i.id
       WHERE i.status = 'committed'
       GROUP BY i.id, s.name
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
// Optional ?q= searches supplier name, receiving location, invoice number,
// PO number, and any line item's SKU or code (case-insensitive, partial
// match). The match is resolved in a subquery (by invoice id), same
// technique as /pending below, so the subtotal SUM still totals ALL of a
// matched invoice's items, not just the ones that happened to match.
router.get('/history', async (req, res) => {
  try {
    const { q } = req.query;
    const params = [];
    let query = `
      SELECT i.id, i.invoice_number, i.po_number, i.committed_at, i.is_promotional, i.location, s.name AS supplier_name,
             COALESCE(SUM(it.quantity * it.effective_cost), 0) AS subtotal_cad
      FROM po_invoices i
      JOIN po_suppliers s ON s.id = i.supplier_id
      LEFT JOIN po_invoice_items it ON it.invoice_id = i.id
      WHERE i.status = 'committed'`;
    if (q) {
      params.push(`%${q}%`);
      query += ` AND i.id IN (
        SELECT DISTINCT i2.id
        FROM po_invoices i2
        JOIN po_suppliers s2 ON s2.id = i2.supplier_id
        LEFT JOIN po_invoice_items it2 ON it2.invoice_id = i2.id
        WHERE i2.status = 'committed'
          AND (s2.name ILIKE $${params.length} OR i2.location ILIKE $${params.length} OR i2.invoice_number ILIKE $${params.length} OR i2.po_number ILIKE $${params.length} OR it2.sku ILIKE $${params.length} OR it2.code ILIKE $${params.length})
      )`;
    }
    query += ` GROUP BY i.id, s.name`;
    params.push(HISTORY_LIMIT);
    query += ` ORDER BY i.committed_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/po-invoices/history error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/po-invoices/check-number — kept only so any stale cached client
// build doesn't 404; invoice_number is a free-text reference now (can
// repeat), so there is nothing to check any more. See POST /process and the
// "PO number" auto-numbering it does instead.
router.get('/check-number', async (req, res) => {
  res.json({ available: true });
});

// ─── Processing (create or re-process a pending invoice) ────────────────────

// POST /api/po-invoices/process
// Body: {
//   invoiceId?: number,            // present when re-processing an existing pending invoice
//   invoiceNumber?: string,        // optional free-text reference, can repeat, can be blank
//   supplierId, location, adjustment: string|null,
//   rows: [{ code, sku, name, quantity, cost, unitDiscount }]
// }
// A row is skipped entirely (treated as if it doesn't exist) when quantity
// is blank/non-numeric, or when it has neither a code nor a SKU. Otherwise:
// a SKU given directly on the row resolves it with no lookup needed; a code
// with no SKU resolves through this supplier's saved code→SKU mapping
// (po_supplier_skus) same as before, and is flagged "missing" if that
// mapping doesn't have it. Either way, a blank CSV cost falls back to that
// supplier_skus row's metafield-synced cost (in the supplier's native
// currency, same convention as a CSV cost cell) — if neither is available,
// the item is flagged via has_missing_cost instead of writing a fabricated
// cost into Shopify's average-cost calculation at commit time.
router.post('/process', async (req, res) => {
  const client = await pool.connect();
  try {
    const { invoiceId, invoiceNumber, supplierId, location, adjustment: adjustmentRaw, rows } = req.body;

    if (!supplierId || !location || !rows?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const validRows = rows.filter(r => {
      const qty = parseFloat(r.quantity);
      if (isNaN(qty)) return false;
      return !!String(r.code || '').trim() || !!String(r.sku || '').trim();
    });
    if (validRows.length === 0) {
      return res.status(400).json({ error: 'No usable rows in this CSV — every row needs a quantity and at least a code or a SKU.' });
    }

    // A CSV is expected to be homogeneous: either every usable row carries a
    // SKU directly, or none of them do (resolving purely through this
    // supplier's code→SKU mapping instead). A mix of the two within one file
    // is treated as malformed input rather than guessed at row-by-row.
    const rowsWithSku = validRows.filter(r => !!String(r.sku || '').trim());
    const rowsWithoutSku = validRows.filter(r => !String(r.sku || '').trim());
    if (rowsWithSku.length > 0 && rowsWithoutSku.length > 0) {
      return res.status(400).json({
        error: 'processing failed: mixed SKU presence — some rows have a SKU, others do not. Every row in the CSV must either all have a SKU or all omit it.',
      });
    }

    // Duplicate unit code within this CSV, among rows that resolve purely by
    // code (no SKU given) → hard error: with no SKU to disambiguate, a
    // repeated code has no way to know which line it actually refers to.
    // A code repeated across rows that each carry their own SKU is fine and
    // expected (one code shared by several SKUs of the same product) — those
    // rows don't rely on the code→SKU lookup at all, so there's no ambiguity.
    // (codesForDupeCheck is also reused below for the code→SKU DB lookup,
    // regardless of which branch this file fell into.)
    const codesForDupeCheck = validRows.map(r => String(r.code || '').trim()).filter(Boolean);
    if (rowsWithoutSku.length === validRows.length) {
      const seen = new Set();
      const dupeCodes = new Set();
      for (const c of codesForDupeCheck) {
        if (seen.has(c)) dupeCodes.add(c);
        seen.add(c);
      }
      if (dupeCodes.size > 0) {
        return res.status(400).json({
          error: `Duplicate unit code(s) in CSV: ${Array.from(dupeCodes).join(', ')}. Please fix the CSV and re-upload.`,
        });
      }
    }

    const supplierRes = await pool.query('SELECT * FROM po_suppliers WHERE id = $1', [supplierId]);
    if (supplierRes.rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    const supplier = supplierRes.rows[0];

    const locRes = await pool.query('SELECT shopify_location_id FROM location_map WHERE location_name = $1', [location]);
    if (locRes.rows.length === 0) return res.status(400).json({ error: 'Unknown location' });
    const shopifyLocationId = locRes.rows[0].shopify_location_id;

    // Look up both directions within this supplier's saved mapping: by code
    // (the existing path) and by SKU directly (for rows given as SKU, and as
    // a secondary lookup for the cost/name fallback).
    const codesToLookup = [...new Set(codesForDupeCheck)];
    const skusToLookup = [...new Set(validRows.map(r => String(r.sku || '').trim()).filter(Boolean))];

    const byCodeRes = codesToLookup.length > 0
      ? await pool.query(
          'SELECT code, sku, name, metafield_cost FROM po_supplier_skus WHERE supplier_id = $1 AND code = ANY($2)',
          [supplierId, codesToLookup]
        )
      : { rows: [] };
    const bySkuRes = skusToLookup.length > 0
      ? await pool.query(
          // DISTINCT ON: a supplier can have two codes mapping to the same
          // SKU (a collision) — pick one deterministically rather than error.
          'SELECT DISTINCT ON (sku) code, sku, name, metafield_cost FROM po_supplier_skus WHERE supplier_id = $1 AND sku = ANY($2) ORDER BY sku, updated_at DESC',
          [supplierId, skusToLookup]
        )
      : { rows: [] };
    // Grouped by code (not deduped to one row) since a code can now
    // legitimately map to more than one SKU — needed to detect the case
    // below where a code-only row can't be resolved unambiguously.
    const byCodeGroups = new Map();
    byCodeRes.rows.forEach(r => {
      const list = byCodeGroups.get(r.code) || [];
      list.push(r);
      byCodeGroups.set(r.code, list);
    });
    // Single-row-per-code convenience map, used only as a secondary
    // name/cost *hint* below (when a row is given directly as SKU) — not for
    // identity resolution, so picking one arbitrarily there is harmless.
    const supplierSkuByCode = new Map(byCodeRes.rows.map(r => [r.code, r]));
    const supplierSkuBySku = new Map(bySkuRes.rows.map(r => [r.sku, r]));

    const fx = supplier.currency === 'USD' ? Number(supplier.fx_rate) : 1;

    const resolved = validRows.map(row => {
      const skuGiven = String(row.sku || '').trim();
      const codeGiven = String(row.code || '').trim();
      let sku, isMissing, supplierRow, viaCode;

      if (skuGiven) {
        sku = skuGiven;
        isMissing = false;
        viaCode = false;
        supplierRow = supplierSkuBySku.get(skuGiven) || (codeGiven ? supplierSkuByCode.get(codeGiven) : null);
      } else {
        // A code-only row can only be resolved when this code maps to
        // exactly one SKU for this supplier. If it maps to more than one
        // (a shared-code product), there's no way to tell which SKU this
        // row means — treat it the same as "missing" rather than silently
        // guessing one.
        const codeMatches = byCodeGroups.get(codeGiven) || [];
        supplierRow = codeMatches.length === 1 ? codeMatches[0] : null;
        sku = supplierRow?.sku || null;
        isMissing = !sku;
        viaCode = true;
      }

      // The Supplier cost metafield is buyer-entered in the SAME currency as
      // this supplier's invoices (CAD for a CAD supplier, USD for a USD
      // supplier) — so when it's used as a cost fallback it goes through the
      // exact same fx math as a real CSV cost cell.
      //
      // Two different values are tracked here on purpose:
      //  - displayRawCost: the literal CSV cost cell, or null if it was
      //    blank. This is what the "Invoice cost" column shows, and it's the
      //    gate for cost-comparison highlighting (see GET responses below) —
      //    a row with no real invoice cost is never compared/highlighted,
      //    even though it may still have a usable cost for Shopify via the
      //    fallback.
      //  - rawCost (returned below, consumed by computeLineItems): the CSV
      //    cell if present, else the metafield fallback — used for the
      //    actual fx/discount/adjustment math so inventory + cost can still
      //    be committed for a row with no CSV cost at all.
      const displayRawCostParsed = parseFloat(row.cost);
      const displayRawCost = isNaN(displayRawCostParsed) ? null : displayRawCostParsed;

      let rawCost = displayRawCost;
      if (rawCost === null) {
        const fallback = supplierRow?.metafield_cost;
        rawCost = (fallback !== null && fallback !== undefined) ? Number(fallback) : null;
      }
      const costMissing = rawCost === null;

      const supplierCostRaw = (supplierRow?.metafield_cost !== null && supplierRow?.metafield_cost !== undefined)
        ? Number(supplierRow.metafield_cost)
        : null;

      return {
        code: codeGiven || null,
        sku,
        viaCode,
        name: row.name,
        quantity: row.quantity,
        unitDiscount: row.unitDiscount,
        rawCost,
        displayRawCost,
        costMissing,
        isMissing,
        supplierCostRaw,
        fallbackName: supplierRow?.name || null,
      };
    });

    const adjustment = parseAdjustmentInput(adjustmentRaw);
    const computed = computeLineItems(resolved, { currency: supplier.currency, fxRate: supplier.fx_rate }, adjustment);

    // SKU collision: two different codes (within this invoice) resolving to
    // the same SKU via the code→SKU mapping. Rows given directly as SKU
    // don't participate — there's no mapping ambiguity to flag for them.
    const skuToCodes = new Map();
    computed.forEach(r => {
      if (r.viaCode && r.sku && !r.isMissing) {
        const list = skuToCodes.get(r.sku) || [];
        list.push(r.code);
        skuToCodes.set(r.sku, list);
      }
    });
    const hasCollision = Array.from(skuToCodes.values()).some(list => list.length > 1);

    let hasMissing = false;
    let hasMissingCost = false;
    const finalItems = computed.map(r => {
      if (r.isMissing) hasMissing = true;
      if (r.costMissing) hasMissingCost = true;
      return {
        code: r.code,
        sku: r.sku,
        name: r.name || r.fallbackName || null,
        quantity: Number(r.quantity),
        // The literal CSV cost cell only — null when it was blank, even if a
        // Supplier cost metafield fallback was used for the actual math
        // below. This is what "Invoice cost" shows, and it's the gate for
        // cost-comparison highlighting: a row with no real invoice cost is
        // never compared/highlighted.
        raw_cost: r.displayRawCost,
        unit_discount_raw: r.unitDiscount ?? null,
        cost_before_adjustment: r.costBeforeAdjustment,
        effective_cost: r.effectiveCost,
        supplier_cost_raw: r.supplierCostRaw,
        is_missing: r.isMissing,
      };
    });

    await client.query('BEGIN');

    let invoiceRow;
    if (invoiceId) {
      const updated = await client.query(
        `UPDATE po_invoices SET
           invoice_number = $1, supplier_id = $2, location = $3,
           shopify_location_id = $4, adjustment_type = $5, adjustment_value = $6,
           has_missing_sku = $7, has_sku_collision = $8, has_missing_cost = $9, updated_at = NOW()
         WHERE id = $10 AND status = 'pending' RETURNING *`,
        [
          invoiceNumber || null, supplierId, location, shopifyLocationId,
          adjustment?.type || null, adjustment?.value ?? null, hasMissing, hasCollision, hasMissingCost, invoiceId,
        ]
      );
      if (updated.rows.length === 0) throw new Error('Invoice not found or already committed');
      invoiceRow = updated.rows[0];
      await client.query('DELETE FROM po_invoice_items WHERE invoice_id = $1', [invoiceId]);
    } else {
      const poNumber = await generatePoNumber(client);
      const inserted = await client.query(
        `INSERT INTO po_invoices
           (invoice_number, supplier_id, location, shopify_location_id,
            adjustment_type, adjustment_value, has_missing_sku, has_sku_collision, has_missing_cost, po_number, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',NOW()) RETURNING *`,
        [
          invoiceNumber || null, supplierId, location, shopifyLocationId,
          adjustment?.type || null, adjustment?.value ?? null, hasMissing, hasCollision, hasMissingCost, poNumber,
        ]
      );
      invoiceRow = inserted.rows[0];
    }

    for (const item of finalItems) {
      await client.query(
        `INSERT INTO po_invoice_items
           (invoice_id, code, sku, name, quantity, raw_cost, unit_discount_raw, cost_before_adjustment, effective_cost, supplier_cost_raw, is_missing)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          invoiceRow.id, item.code, item.sku, item.name, item.quantity, item.raw_cost,
          item.unit_discount_raw, item.cost_before_adjustment, item.effective_cost, item.supplier_cost_raw, item.is_missing,
        ]
      );
    }

    await client.query('COMMIT');

    res.json({ invoice: invoiceRow, items: finalItems, hasMissing, hasCollision, hasMissingCost });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/po-invoices/process error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── Pending (Commit later) ──────────────────────────────────────────────────

// GET /api/po-invoices/pending — optional ?q= searches supplier name,
// receiving location, invoice number, PO number, and any line item's SKU or
// code (case-insensitive, partial match). The search match is resolved in a
// subquery (by invoice id) rather than filtered directly on the joined
// po_invoice_items rows, so the quantity/subtotal SUMs below still total ALL
// of a matched invoice's items, not just the ones that happened to match.
router.get('/pending', async (req, res) => {
  try {
    const { q } = req.query;
    const params = [];
    let query = `
      SELECT i.id, i.invoice_number, i.po_number, i.location, s.name AS supplier_name,
             COALESCE(SUM(it.quantity), 0) AS quantity,
             COALESCE(SUM(it.quantity * it.effective_cost), 0) AS subtotal_cad
      FROM po_invoices i
      JOIN po_suppliers s ON s.id = i.supplier_id
      LEFT JOIN po_invoice_items it ON it.invoice_id = i.id
      WHERE i.status = 'pending'`;
    if (q) {
      params.push(`%${q}%`);
      query += ` AND i.id IN (
        SELECT DISTINCT i2.id
        FROM po_invoices i2
        JOIN po_suppliers s2 ON s2.id = i2.supplier_id
        LEFT JOIN po_invoice_items it2 ON it2.invoice_id = i2.id
        WHERE i2.status = 'pending'
          AND (s2.name ILIKE $${params.length} OR i2.location ILIKE $${params.length} OR i2.invoice_number ILIKE $${params.length} OR i2.po_number ILIKE $${params.length} OR it2.sku ILIKE $${params.length} OR it2.code ILIKE $${params.length})
      )`;
    }
    query += ` GROUP BY i.id, i.invoice_number, i.po_number, i.location, s.name ORDER BY i.created_at DESC`;
    const result = await pool.query(query, params);
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
      // Group by code first: a code can now legitimately map to more than
      // one SKU (a shared-code product). Only resolve here when exactly one
      // SKU matches — otherwise this item stays "missing" rather than
      // silently picking one of several possible SKUs.
      const byCode = new Map();
      skuRes.rows.forEach(r => {
        const list = byCode.get(r.code) || [];
        list.push(r.sku);
        byCode.set(r.code, list);
      });
      const found = new Map(
        [...byCode.entries()].filter(([, skus]) => skus.length === 1).map(([code, skus]) => [code, skus[0]])
      );
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
  // has_missing_cost no longer blocks commit — a line item with no cost
  // source still receives its inventory quantity, it just skips the cost
  // (and average-cost) update below, same as a promotional invoice does.

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

    const hasCost = item.effective_cost !== null && item.effective_cost !== undefined;

    if (!invoice.is_promotional && hasCost) {
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

      // Keyed by sku, not code: cost is a property of the physical SKU that
      // was actually received, not of the (possibly shared) code label on
      // the invoice line. Keying by code would apply this SKU's cost to
      // every other SKU sharing that code, and would silently update
      // nothing at all for a line item resolved directly by SKU with no
      // code on it (item.code is null there).
      await pool.query(
        `UPDATE po_supplier_skus SET
           last_cost = $1, cost_sum = cost_sum + $1, cost_count = cost_count + 1,
           name = $2, updated_at = NOW()
         WHERE supplier_id = $3 AND sku = $4`,
        [item.effective_cost, item.name, invoice.supplier_id, item.sku]
      );
    } else {
      await pool.query(
        `UPDATE po_supplier_skus SET name = $1, updated_at = NOW() WHERE supplier_id = $2 AND sku = $3`,
        [item.name, invoice.supplier_id, item.sku]
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

// ─── Export CSV ───────────────────────────────────────────────────────────

// GET /api/po-invoices/:id/export-csv — works for a pending or committed
// invoice alike. Columns: Code, Wig number, SKU, Name, Qty.
//
// Name is ALWAYS the variant's live custom.name metafield value, not
// whatever name ended up stored on the line item (CSV-given or fallback) —
// per Hera's spec this export intentionally re-reads it fresh from Shopify.
//
// Wig number lookup only happens at all when this invoice's supplier carries
// the WIG type (Supplier management → Types carrying — the invoice-level
// Type filter that used to gate this was removed from Import an invoice).
// For a supplier that doesn't carry WIG, every row's Wig number is left
// blank and no per-item product-type lookup happens — keeps the common case
// fast. For one that does, each item's product type is checked and only the
// WIG ones get their custom.wig_number metafield pulled.
router.get('/:id/export-csv', async (req, res) => {
  try {
    const { id } = req.params;
    const invRes = await pool.query(
      `SELECT i.*, s.types_carrying FROM po_invoices i JOIN po_suppliers s ON s.id = i.supplier_id WHERE i.id = $1`,
      [id]
    );
    if (invRes.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = invRes.rows[0];
    const supplierCarriesWig = (invoice.types_carrying || []).includes('WIG');

    const itemsRes = await pool.query('SELECT * FROM po_invoice_items WHERE invoice_id = $1 ORDER BY id ASC', [id]);
    const items = itemsRes.rows;

    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const rows = [];
    for (const item of items) {
      let name = '';
      let wigNumber = '';
      if (item.sku) {
        try {
          const query = supplierCarriesWig
            ? `{
                productVariants(first: 1, query: "barcode:${item.sku}") {
                  edges { node {
                    customName: metafield(namespace: "custom", key: "name") { value }
                    product {
                      productType
                      wigNumber: metafield(namespace: "custom", key: "wig_number") { value }
                    }
                  } }
                }
              }`
            : `{
                productVariants(first: 1, query: "barcode:${item.sku}") {
                  edges { node {
                    customName: metafield(namespace: "custom", key: "name") { value }
                  } }
                }
              }`;
          const response = await shopifyRequest(client, query);
          const node = response?.data?.productVariants?.edges?.[0]?.node;
          name = node?.customName?.value || '';
          if (supplierCarriesWig && node?.product?.productType === 'WIG') {
            wigNumber = node?.product?.wigNumber?.value || '';
          }
        } catch (e) {
          console.error(`export-csv: metafield lookup failed for SKU ${item.sku}:`, e.message);
        }
      }
      rows.push([item.code || '', wigNumber, item.sku || '', name, item.quantity]);
    }

    const escapeCsv = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = ['Code,Wig number,SKU,Name,Qty', ...rows.map(r => r.map(escapeCsv).join(','))].join('\n');

    const filename = `${invoice.po_number || invoice.invoice_number || 'invoice'}-export.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    console.error('GET /api/po-invoices/:id/export-csv error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Committed history detail (settings clear-all) ───────────────────────────

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
