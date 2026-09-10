const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../database/init');
const { getShopify, getSession, activeFilter } = require('../shopify');

const RECENT_LIMIT = 20;
const HISTORY_LIMIT = 200;
const HQ_LOCATION_NAME = 'HQ';

// Full Ongoing Transfer lifecycle (Buyer/Warehouse/Manager, 7 statuses).
// See claude/TRANSFER_FEATURE_SPEC.md in the project's Claude knowledge base
// for the complete narrated spec this file implements — every endpoint below
// has a matching section there. Role separation (buyer/warehouse/manager) is
// NOT enforced server-side, same as the rest of this app (e.g. PO Receiving's
// manager endpoints in poInvoices.js) — each page passes its own role/location
// context as a param and this file trusts it.
//
// ── Shopify mutation design (confirmed against shopify.dev docs 2026-09,
// but the shipment-auto-creation point below is a runtime assumption that
// needs verifying against a real transfer the first time this runs — same
// "verify when it first runs" caveat as buildTransferAdminUrl already had):
//   - Create                         → inventoryTransferCreate (unchanged)
//   - Pending → Confirm (qty edit)   → inventoryTransferSetItems (transfer's
//                                       own line items; only valid pre-ship,
//                                       which Loading/Pending both are)
//   - Loading/Pending → Good to go   → inventoryTransferMarkAsReadyToShip
//                                       (this is what triggers Shopify's own
//                                       origin-location inventory commit —
//                                       see spec doc section 2)
//   - Shipment for this transfer     → inventoryShipmentCreate, called right
//                                       after mark-as-ready-to-ship with the
//                                       Warehouse/Manager's qty_loaded values.
//                                       ASSUMPTION, NOT YET CONFIRMED: whether
//                                       Shopify auto-creates a shipment at
//                                       mark-as-ready-to-ship already (in
//                                       which case this call would need to
//                                       target that existing shipment instead
//                                       — see ensureShipment() below, which
//                                       falls back to reading
//                                       transfer.shipments if create fails).
//   - Good to go → In transit        → inventoryShipmentMarkInTransit
//   - Loading → Cancel                → inventoryTransferCancel
//   - Counted → Commit               → if any receivedQty != transferQty:
//                                       inventoryShipmentUpdateItemQuantities
//                                       to align, then always
//                                       inventoryShipmentReceive with
//                                       bulkReceiveAction: 'ACCEPTED' (the
//                                       only two enum values are ACCEPTED/
//                                       REJECTED — ACCEPTED-for-everything is
//                                       Shopify's "mark as transferred")
//   - Inventory correction (Confirm) → inventoryAdjustQuantities (delta)

async function generateTransferNo(client) {
  const result = await client.query('SELECT last_number, last_letter FROM transfer_number_counter WHERE id = 1 FOR UPDATE');
  let { last_number, last_letter } = result.rows[0];

  last_number += 1;
  if (last_number > 9999) {
    last_number = 0;
    last_letter = String.fromCharCode(last_letter.charCodeAt(0) + 1);
  }

  await client.query(
    'UPDATE transfer_number_counter SET last_number = $1, last_letter = $2 WHERE id = 1',
    [last_number, last_letter]
  );

  return `T-${last_letter}${String(last_number).padStart(4, '0')}`;
}

// Shopify's unified admin domain serves a single transfer at
// https://admin.shopify.com/store/<handle>/transfers/<numeric id>. The store
// handle comes from SHOP (e.g. "beaute-hera.myshopify.com" → "beaute-hera"),
// same env var the rest of the app already uses for auth.
function buildTransferAdminUrl(shopifyTransferGid) {
  const match = /InventoryTransfer\/(\d+)/.exec(shopifyTransferGid || '');
  if (!match) return null;
  const handle = (process.env.SHOP || '').replace(/\.myshopify\.com$/, '');
  if (!handle) return null;
  return `https://admin.shopify.com/store/${handle}/transfers/${match[1]}`;
}

async function graphql(client, query, variables) {
  const response = await client.request(query, { variables });
  return response?.data;
}

// Creates (or reuses) the InventoryShipment backing a transfer's ship/receive
// lifecycle, using the Warehouse/Manager's confirmed qty_loaded values as the
// shipment's line item quantities. See the file-level comment above for the
// "does mark-as-ready-to-ship auto-create one already" caveat this guards
// against.
async function ensureShipment(shopifyClient, transferRow, items) {
  if (transferRow.shopify_shipment_id) return transferRow.shopify_shipment_id;

  const createMutation = `
    mutation inventoryShipmentCreate($input: InventoryShipmentCreateInput!, $idempotencyKey: String!) {
      inventoryShipmentCreate(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryShipment { id lineItems(first: 250) { edges { node { id inventoryItem { id } } } } }
        userErrors { field message }
      }
    }
  `;
  const input = {
    transferId: transferRow.shopify_transfer_id,
    lineItems: items.map(i => ({
      inventoryItemId: i.inventory_item_id,
      quantity: i.qty_loaded != null ? i.qty_loaded : i.quantity,
    })),
  };
  const data = await graphql(shopifyClient, createMutation, { input, idempotencyKey: crypto.randomUUID() });
  const result = data?.inventoryShipmentCreate;
  const userErrors = result?.userErrors || [];
  if (userErrors.length > 0 || !result?.inventoryShipment?.id) {
    // Fall back: a shipment may already exist on the transfer (see the
    // "ASSUMPTION" note above) — read it back instead of failing outright.
    const lookup = `
      query transferShipments($id: ID!) {
        inventoryTransfer(id: $id) {
          shipments(first: 5) { edges { node { id lineItems(first: 250) { edges { node { id inventoryItem { id } } } } } } }
        }
      }
    `;
    const lookupData = await graphql(shopifyClient, lookup, { id: transferRow.shopify_transfer_id });
    const existing = lookupData?.inventoryTransfer?.shipments?.edges?.[0]?.node;
    if (!existing) {
      throw new Error(`Failed to create or find shipment: ${userErrors.map(e => e.message).join('; ') || 'unknown error'}`);
    }
    await mapShipmentLineItems(existing, items);
    return existing.id;
  }
  await mapShipmentLineItems(result.inventoryShipment, items);
  return result.inventoryShipment.id;
}

// Records each item's shipmentLineItemId so later per-item shipment
// mutations (update quantities, receive) can target the right line.
async function mapShipmentLineItems(shipment, items) {
  const edges = shipment?.lineItems?.edges || [];
  const byInventoryItemId = new Map(edges.map(({ node }) => [node.inventoryItem.id, node.id]));
  for (const item of items) {
    const shipmentLineItemId = byInventoryItemId.get(item.inventory_item_id);
    if (shipmentLineItemId) {
      await pool.query('UPDATE transfer_items SET shipment_line_item_id = $1 WHERE id = $2', [shipmentLineItemId, item.id]);
    }
  }
}

// Note visibility (spec doc section 0): Buyer's note is visible to everyone;
// a Warehouse or Manager note is visible only to its author role + Buyer.
function applyNoteVisibility(transfer, role) {
  const out = { ...transfer };
  if (transfer.note_by && transfer.note_by !== 'buyer' && role !== 'buyer' && role !== transfer.note_by) {
    out.note = null;
    out.note_by = null;
  }
  return out;
}

// Wig Number (spec doc section 6, new §6 "Wig Number 列的显示规则"): every
// Manager-facing transfer page shows a Wig Number column, populated live from
// Shopify (never persisted) for any line item whose product is productType
// 'WIG' — read from the custom.wig_number metafield. Unlike PO Invoices'
// version of this same lookup (poInvoices.js, GET /manager/receiving/:id),
// there's no "does this supplier carry WIG" gate here since transfers don't
// have suppliers — every item is just checked directly. Batched by SKU
// (barcode), 50 at a time, for the same rate-limit reason documented there.
// Warehouse pages never call this (confirmed with Hera — Wig Number is
// Manager-only).
async function attachWigNumbers(shopifyClient, items) {
  const skus = [...new Set(items.map(i => i.sku).filter(Boolean))];
  if (skus.length === 0) return;
  const wigNumberBySku = new Map();
  const CHUNK_SIZE = 50;
  for (let i = 0; i < skus.length; i += CHUNK_SIZE) {
    const chunk = skus.slice(i, i + CHUNK_SIZE);
    const filter = activeFilter(chunk.map(s => `barcode:${s}`).join(' OR '));
    const query = `
      query wigNumbers($filter: String!) {
        productVariants(first: ${chunk.length}, query: $filter) {
          edges { node {
            barcode
            product {
              productType
              wigNumber: metafield(namespace: "custom", key: "wig_number") { value }
            }
          } }
        }
      }
    `;
    try {
      const data = await graphql(shopifyClient, query, { filter });
      const edges = data?.productVariants?.edges || [];
      edges.forEach(({ node }) => {
        if (node?.barcode && node?.product?.productType === 'WIG') {
          wigNumberBySku.set(node.barcode, node.product.wigNumber?.value || '');
        }
      });
    } catch (e) {
      console.error('attachWigNumbers: batched lookup failed:', e.message);
    }
  }
  items.forEach(item => {
    item.wig_number = item.sku && wigNumberBySku.has(item.sku) ? wigNumberBySku.get(item.sku) : '';
  });
}

async function fetchTransferWithItems(id) {
  const transferRes = await pool.query('SELECT * FROM transfers WHERE id = $1', [id]);
  if (transferRes.rows.length === 0) return null;
  const itemsRes = await pool.query('SELECT * FROM transfer_items WHERE transfer_id = $1 ORDER BY id ASC', [id]);
  return { transfer: transferRes.rows[0], items: itemsRes.rows };
}

// ─── Create Transfer ────────────────────────────────────────────────────────

// POST /api/transfers — Create Transfer's "Create" button.
// Body: { fromLocationId, fromLocationName, toLocationId, toLocationName,
//          referenceName, tags, note, items: [{ sku, name, inventoryItemId, quantity, fromQty }] }
router.post('/', async (req, res) => {
  const {
    fromLocationId, fromLocationName, toLocationId, toLocationName,
    referenceName, tags, note, items,
  } = req.body;

  if (!fromLocationId || !toLocationId) {
    return res.status(400).json({ error: 'fromLocationId and toLocationId are required' });
  }
  if (fromLocationId === toLocationId) {
    return res.status(400).json({ error: 'From and To locations must be different' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one line item is required' });
  }
  const overStock = items.find(i => Number(i.quantity) > Number(i.fromQty));
  if (overStock) {
    return res.status(400).json({ error: `Transfer qty for ${overStock.sku} exceeds available quantity at ${fromLocationName}` });
  }

  const session = await getSession();
  if (!session) return res.status(401).json({ error: 'No session' });

  try {
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const mutation = `
      mutation inventoryTransferCreate($input: InventoryTransferCreateInput!, $idempotencyKey: String!) {
        inventoryTransferCreate(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryTransfer { id status name }
          userErrors { field message }
        }
      }
    `;
    const input = {
      originLocationId: fromLocationId,
      destinationLocationId: toLocationId,
      referenceName: referenceName || null,
      note: note || null,
      tags: Array.isArray(tags) ? tags : [],
      lineItems: items.map(i => ({ inventoryItemId: i.inventoryItemId, quantity: Number(i.quantity) })),
    };

    const data = await graphql(client, mutation, { input, idempotencyKey: crypto.randomUUID() });
    const result = data?.inventoryTransferCreate;
    const userErrors = result?.userErrors || [];
    if (userErrors.length > 0) {
      return res.status(400).json({ error: userErrors.map(e => e.message).join('; ') });
    }
    const shopifyTransfer = result?.inventoryTransfer;
    if (!shopifyTransfer?.id) {
      return res.status(500).json({ error: 'Shopify did not return a transfer id' });
    }

    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      const transferNo = await generateTransferNo(dbClient);
      const transferRes = await dbClient.query(
        `INSERT INTO transfers
           (transfer_no, shopify_transfer_id, shopify_transfer_name, shopify_transfer_url, from_location, to_location,
            from_location_id, to_location_id, status, note, note_by, reference_name, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'loading', $9, $10, $11, $12)
         RETURNING *`,
        [
          transferNo, shopifyTransfer.id, shopifyTransfer.name || null, buildTransferAdminUrl(shopifyTransfer.id),
          fromLocationName || fromLocationId, toLocationName || toLocationId,
          fromLocationId, toLocationId,
          note || null, note ? 'buyer' : null, referenceName || null, Array.isArray(tags) ? tags : [],
        ]
      );
      const transfer = transferRes.rows[0];

      for (const item of items) {
        await dbClient.query(
          `INSERT INTO transfer_items (transfer_id, sku, name, quantity, inventory_item_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [transfer.id, item.sku, item.name || null, Number(item.quantity), item.inventoryItemId || null]
        );
      }

      await dbClient.query('COMMIT');
      res.json({ success: true, transfer });
    } catch (dbError) {
      await dbClient.query('ROLLBACK');
      console.error('POST /api/transfers db error after Shopify create:', dbError);
      res.status(500).json({
        error: `Shopify transfer ${shopifyTransfer.id} was created, but saving it locally failed: ${dbError.message}`,
      });
    } finally {
      dbClient.release();
    }
  } catch (e) {
    console.error('POST /api/transfers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Buyer: Transfer home / history ─────────────────────────────────────────

router.get('/recent', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, transfer_no, shopify_transfer_id, shopify_transfer_name, shopify_transfer_url,
              from_location, to_location, committed_at
       FROM transfers
       WHERE status = 'committed'
       ORDER BY committed_at DESC
       LIMIT $1`,
      [RECENT_LIMIT]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/transfers/recent error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { q } = req.query;
    const params = [];
    let query = `
      SELECT id, transfer_no, shopify_transfer_id, shopify_transfer_name, shopify_transfer_url,
             from_location, to_location, committed_at
      FROM transfers
      WHERE status = 'committed'`;
    if (q) {
      params.push(`%${q}%`);
      query += ` AND id IN (
        SELECT DISTINCT t2.id
        FROM transfers t2
        LEFT JOIN transfer_items it2 ON it2.transfer_id = t2.id
        WHERE t2.status = 'committed'
          AND (it2.sku ILIKE $${params.length} OR it2.name ILIKE $${params.length})
      )`;
    }
    params.push(HISTORY_LIMIT);
    query += ` ORDER BY committed_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/transfers/history error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/transfers/ongoing — Buyer sees all 7 statuses except committed
// (committed lives in /recent + /history instead — see spec doc section 3).
router.get('/ongoing', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, transfer_no, shopify_transfer_id, shopify_transfer_name, shopify_transfer_url,
              from_location, to_location, status, created_at
       FROM transfers
       WHERE status != 'committed'
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/transfers/ongoing error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Warehouse home ──────────────────────────────────────────────────────────

// GET /api/transfers/warehouse/home — two lists: HQ-origin (clickable, needs
// full item detail) and non-HQ-origin ("Pick up from store", not clickable —
// Warehouse only needs from/to/status). Warehouse sees Loading/Pending/
// Good to go/In transit (spec doc section 5).
router.get('/warehouse/home', async (req, res) => {
  try {
    const statuses = ['loading', 'pending', 'good_to_go', 'in_transit'];
    const result = await pool.query(
      `SELECT id, transfer_no, from_location, to_location, status
       FROM transfers
       WHERE status = ANY($1)
       ORDER BY created_at ASC`,
      [statuses]
    );
    const hq = result.rows.filter(r => r.from_location === HQ_LOCATION_NAME);
    const pickupFromStore = result.rows.filter(r => r.from_location !== HQ_LOCATION_NAME);
    res.json({ hq, pickupFromStore });
  } catch (e) {
    console.error('GET /api/transfers/warehouse/home error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Manager home ────────────────────────────────────────────────────────────

// GET /api/transfers/manager/home?location=... — Receiving (this location is
// the to_location, statuses In transit/Receiving) and Sending (this location
// is the from_location, statuses Loading/Good to go/Pending) — spec doc
// section 6. Manager never sees In transit on the Sending side (confirmed:
// the transfer becomes invisible to Manager the moment they click "Truck
// picked up").
router.get('/manager/home', async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: 'Missing location' });

    const receiving = await pool.query(
      `SELECT id, transfer_no, from_location, to_location, status
       FROM transfers
       WHERE to_location = $1 AND status IN ('in_transit','receiving')
       ORDER BY created_at ASC`,
      [location]
    );
    const sending = await pool.query(
      `SELECT id, transfer_no, from_location, to_location, status
       FROM transfers
       WHERE from_location = $1 AND status IN ('loading','good_to_go','pending')
       ORDER BY created_at ASC`,
      [location]
    );
    res.json({ receiving: receiving.rows, sending: sending.rows });
  } catch (e) {
    console.error('GET /api/transfers/manager/home error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Tag pool (BuyerTransferSettings.js, spec doc section 3) ────────────────
// Must be registered before GET /:id below — otherwise GET /api/transfers/tags
// matches the /:id pattern first (with id="tags") and fails with
// "invalid input syntax for type integer" when that literal string is used
// in the SQL query for fetchTransferWithItems.

router.get('/tags', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, tag FROM transfer_tag_pool ORDER BY tag ASC');
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/transfers/tags error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/tags', async (req, res) => {
  try {
    const { tag } = req.body;
    const trimmed = (tag || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'Tag is required' });
    if (trimmed.length > 20) return res.status(400).json({ error: 'Tag must be 20 characters or fewer' });
    const existing = await pool.query('SELECT id FROM transfer_tag_pool WHERE LOWER(tag) = LOWER($1)', [trimmed]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'A tag with this name already exists' });
    const result = await pool.query('INSERT INTO transfer_tag_pool (tag) VALUES ($1) RETURNING id, tag', [trimmed]);
    res.json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/transfers/tags error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/tags/:tagId', async (req, res) => {
  try {
    // Deleting a Tag pool entry never touches published transfers (spec doc
    // section 3): the pool is only ever read as Create Transfer's candidate
    // list, never linked back to an existing transfer's own tags.
    await pool.query('DELETE FROM transfer_tag_pool WHERE id = $1', [req.params.tagId]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/transfers/tags/:tagId error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Detail ──────────────────────────────────────────────────────────────────

// GET /api/transfers/:id?role=buyer|warehouse|manager
router.get('/:id', async (req, res) => {
  try {
    const { role } = req.query;
    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });

    if (role === 'manager') {
      const session = await getSession();
      if (session) {
        try {
          const shopify = getShopify();
          const client = new shopify.clients.Graphql({ session });
          await attachWigNumbers(client, found.items);
        } catch (e) {
          console.error('GET /api/transfers/:id: wig number lookup failed:', e.message);
        }
      }
    }

    res.json({
      transfer: applyNoteVisibility(found.transfer, role || 'buyer'),
      items: found.items,
    });
  } catch (e) {
    console.error('GET /api/transfers/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Note (spec doc section 0) ───────────────────────────────────────────────

// POST /api/transfers/:id/note — { role: 'buyer'|'warehouse'|'manager', text }
// Only one note exists at a time; adding one replaces whatever was there.
router.post('/:id/note', async (req, res) => {
  try {
    const { role, text } = req.body;
    if (!['buyer', 'warehouse', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    await pool.query('UPDATE transfers SET note = $1, note_by = $2, updated_at = NOW() WHERE id = $3', [text || null, role, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/:id/note error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/note', async (req, res) => {
  try {
    await pool.query('UPDATE transfers SET note = NULL, note_by = NULL, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/transfers/:id/note error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Loading (Warehouse, or Manager as from-location) ───────────────────────

// POST /api/transfers/:id/qty-loaded — one line item's stepper+check
// confirmation. Body: { itemId, qty }.
router.post('/:id/qty-loaded', async (req, res) => {
  try {
    const { itemId, qty } = req.body;
    await pool.query(
      'UPDATE transfer_items SET qty_loaded = $1, loaded_confirmed = TRUE WHERE id = $2 AND transfer_id = $3',
      [Number(qty), itemId, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/:id/qty-loaded error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/transfers/:id/submit-loading — the Loading page's "Submit to
// Buyer" / "Good to go" button (disabled until every item is confirmed —
// enforced here too, not just client-side). If any item's qty_loaded !=
// quantity: advance to Pending. Otherwise: mark Good to go directly —
// inventoryTransferMarkAsReadyToShip, then create the shipment from the
// confirmed qty_loaded values.
router.post('/:id/submit-loading', async (req, res) => {
  try {
    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    const { transfer, items } = found;

    if (items.some(i => !i.loaded_confirmed)) {
      return res.status(400).json({ error: 'All line items must be confirmed before submitting' });
    }
    const hasMismatch = items.some(i => i.qty_loaded !== i.quantity);

    if (hasMismatch) {
      await pool.query("UPDATE transfers SET status = 'pending', updated_at = NOW() WHERE id = $1", [transfer.id]);
      return res.json({ success: true, status: 'pending' });
    }

    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const markReadyMutation = `
      mutation inventoryTransferMarkAsReadyToShip($input: InventoryTransferMarkAsReadyToShipInput!, $idempotencyKey: String!) {
        inventoryTransferMarkAsReadyToShip(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryTransfer { id }
          userErrors { field message }
        }
      }
    `;
    const markData = await graphql(client, markReadyMutation, {
      input: { id: transfer.shopify_transfer_id },
      idempotencyKey: crypto.randomUUID(),
    });
    const markErrors = markData?.inventoryTransferMarkAsReadyToShip?.userErrors || [];
    if (markErrors.length > 0) {
      return res.status(400).json({ error: markErrors.map(e => e.message).join('; ') });
    }

    const shipmentId = await ensureShipment(client, transfer, items);
    await pool.query(
      "UPDATE transfers SET status = 'good_to_go', shopify_shipment_id = $1, updated_at = NOW() WHERE id = $2",
      [shipmentId, transfer.id]
    );
    res.json({ success: true, status: 'good_to_go' });
  } catch (e) {
    console.error('POST /api/transfers/:id/submit-loading error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Pending → Confirm (Buyer) ───────────────────────────────────────────────

// POST /api/transfers/:id/confirm — Body: { items: [{ itemId, inventoryItemId,
// quantity, availableQty }] } — the Pending page's final (possibly
// stepper-adjusted) quantities plus each item's freshly-refreshed from-
// location Available qty. Does, in order (spec doc section 4):
//   A. inventoryTransferSetItems — push the adjusted quantities to Shopify
//   B. inventoryAdjustQuantities (delta) on each changed line item, so the
//      from-location's Available is corrected to match reality
//   C. advance the transfer to Good to go (mark-as-ready-to-ship + shipment,
//      same as the no-mismatch path in submit-loading)
router.post('/:id/confirm', async (req, res) => {
  try {
    const { items: confirmedItems } = req.body;
    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    const { transfer, items } = found;

    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const changedItems = confirmedItems.filter(ci => {
      const dbItem = items.find(i => i.id === ci.itemId);
      return dbItem && Number(ci.quantity) !== dbItem.quantity;
    });

    // A. Push adjusted quantities to the Shopify transfer.
    if (changedItems.length > 0) {
      const setItemsMutation = `
        mutation inventoryTransferSetItems($input: InventoryTransferSetItemsInput!, $idempotencyKey: String!) {
          inventoryTransferSetItems(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryTransfer { id }
            userErrors { field message }
          }
        }
      `;
      const setData = await graphql(client, setItemsMutation, {
        input: {
          id: transfer.shopify_transfer_id,
          lineItems: changedItems.map(ci => ({ inventoryItemId: ci.inventoryItemId, quantity: Number(ci.quantity) })),
        },
        idempotencyKey: crypto.randomUUID(),
      });
      const setErrors = setData?.inventoryTransferSetItems?.userErrors || [];
      if (setErrors.length > 0) {
        return res.status(400).json({ error: setErrors.map(e => e.message).join('; ') });
      }

      // B. Delta-correct the from-location's Available for each changed item
      // — delta = actual current Available minus what Buyer previously
      // believed it was (the transfer qty being replaced), per the worked
      // example in spec doc section 4.
      const changes = changedItems.map(ci => {
        const dbItem = items.find(i => i.id === ci.itemId);
        return {
          inventoryItemId: ci.inventoryItemId,
          locationId: transfer.from_location_id,
          delta: Number(ci.quantity) - dbItem.quantity,
          // Required as of Shopify API version 2026-04 (compare-and-swap
          // protection). We already have a freshly-refreshed from-location
          // Available qty for this item in ci.availableQty (see the route
          // comment above), so use the real value here instead of opting
          // out — this actually adds protection against a stale confirm
          // (e.g. two tabs open) that wasn't possible before this field
          // existed. Falls back to null (opt-out) if a caller doesn't send it.
          changeFromQuantity: (ci.availableQty !== undefined && ci.availableQty !== null)
            ? Number(ci.availableQty)
            : null,
        };
      });
      // @idempotent(key: ...) required as of API 2026-04 too (separate
      // breaking change from changeFromQuantity above — see Shopify
      // changelog "Making idempotency mandatory for inventory adjustments
      // and refund mutations"). Fresh UUID per call: this is a new
      // inventory correction each time, not a retry of a prior one.
      const adjustMutation = `
        mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
          inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            userErrors { field message }
          }
        }
      `;
      const adjustData = await graphql(client, adjustMutation, {
        input: { reason: 'correction', name: 'available', changes },
        idempotencyKey: crypto.randomUUID(),
      });
      const adjustErrors = adjustData?.inventoryAdjustQuantities?.userErrors || [];
      if (adjustErrors.length > 0) {
        return res.status(400).json({ error: adjustErrors.map(e => e.message).join('; ') });
      }

      for (const ci of changedItems) {
        await pool.query('UPDATE transfer_items SET quantity = $1 WHERE id = $2', [Number(ci.quantity), ci.itemId]);
      }
    }

    // C. Advance to Good to go.
    const markReadyMutation = `
      mutation inventoryTransferMarkAsReadyToShip($input: InventoryTransferMarkAsReadyToShipInput!, $idempotencyKey: String!) {
        inventoryTransferMarkAsReadyToShip(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryTransfer { id }
          userErrors { field message }
        }
      }
    `;
    const markData = await graphql(client, markReadyMutation, {
      input: { id: transfer.shopify_transfer_id },
      idempotencyKey: crypto.randomUUID(),
    });
    const markErrors = markData?.inventoryTransferMarkAsReadyToShip?.userErrors || [];
    if (markErrors.length > 0) {
      return res.status(400).json({ error: markErrors.map(e => e.message).join('; ') });
    }

    const refreshed = await fetchTransferWithItems(transfer.id);
    const shipmentId = await ensureShipment(client, transfer, refreshed.items);
    await pool.query(
      "UPDATE transfers SET status = 'good_to_go', shopify_shipment_id = $1, updated_at = NOW() WHERE id = $2",
      [shipmentId, transfer.id]
    );
    res.json({ success: true, status: 'good_to_go' });
  } catch (e) {
    console.error('POST /api/transfers/:id/confirm error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Loading → Cancel (Buyer) ────────────────────────────────────────────────

router.post('/:id/cancel', async (req, res) => {
  try {
    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    const { transfer } = found;

    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const cancelMutation = `
      mutation inventoryTransferCancel($id: ID!, $idempotencyKey: String!) {
        inventoryTransferCancel(id: $id) @idempotent(key: $idempotencyKey) {
          inventoryTransfer { id }
          userErrors { field message }
        }
      }
    `;
    const data = await graphql(client, cancelMutation, { id: transfer.shopify_transfer_id, idempotencyKey: crypto.randomUUID() });
    const errors = data?.inventoryTransferCancel?.userErrors || [];
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.map(e => e.message).join('; ') });
    }
    await pool.query('DELETE FROM transfers WHERE id = $1', [transfer.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/:id/cancel error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Good to go → In transit (Warehouse "Dispatch" / Manager "Truck picked up") ──

// Handles both the Warehouse "Dispatch" button and the Manager "Truck picked
// up" button (spec doc: same effect, different label per role/page).
router.post('/:id/dispatch', async (req, res) => {
  try {
    await dispatchOne(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/:id/dispatch error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/transfers/warehouse/dispatch-selected — Body: { ids: [...] }
router.post('/warehouse/dispatch-selected', async (req, res) => {
  const { ids } = req.body;
  const results = [];
  for (const id of ids || []) {
    try {
      await dispatchOne(id);
      results.push({ id, success: true });
    } catch (e) {
      results.push({ id, success: false, error: e.message });
    }
  }
  res.json({ results });
});

// POST /api/transfers/warehouse/dispatch-all-good-to-go
router.post('/warehouse/dispatch-all-good-to-go', async (req, res) => {
  try {
    const goodToGo = await pool.query("SELECT id FROM transfers WHERE status = 'good_to_go'");
    const results = [];
    for (const row of goodToGo.rows) {
      try {
        await dispatchOne(row.id);
        results.push({ id: row.id, success: true });
      } catch (e) {
        results.push({ id: row.id, success: false, error: e.message });
      }
    }
    res.json({ results });
  } catch (e) {
    console.error('POST /api/transfers/warehouse/dispatch-all-good-to-go error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Shared by the two batch endpoints above and, indirectly, the single
// /:id/dispatch route's logic (kept as a small helper rather than an HTTP
// self-call).
async function dispatchOne(id) {
  const found = await fetchTransferWithItems(id);
  if (!found) throw new Error('Transfer not found');
  const { transfer } = found;
  if (!transfer.shopify_shipment_id) throw new Error('No shipment on this transfer yet');

  const session = await getSession();
  if (!session) throw new Error('No session');
  const shopify = getShopify();
  const client = new shopify.clients.Graphql({ session });

  const mutation = `
    mutation inventoryShipmentMarkInTransit($id: ID!, $idempotencyKey: String!) {
      inventoryShipmentMarkInTransit(id: $id) @idempotent(key: $idempotencyKey) {
        inventoryShipment { id }
        userErrors { field message }
      }
    }
  `;
  const data = await graphql(client, mutation, { id: transfer.shopify_shipment_id, idempotencyKey: crypto.randomUUID() });
  const errors = data?.inventoryShipmentMarkInTransit?.userErrors || [];
  if (errors.length > 0) throw new Error(errors.map(e => e.message).join('; '));
  await pool.query("UPDATE transfers SET status = 'in_transit', dispatched_at = NOW(), updated_at = NOW() WHERE id = $1", [transfer.id]);
}

// ─── Manager: Receiving side ─────────────────────────────────────────────────

// POST /api/transfers/:id/delivered — In transit → Receiving. No Shopify
// call (spec doc section 6: this is purely our own status advance).
router.post('/:id/delivered', async (req, res) => {
  try {
    await pool.query("UPDATE transfers SET status = 'receiving', delivered_at = NOW(), updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/:id/delivered error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/transfers/:id/count — one line item's count-modal submission.
// Body: { itemId, count }.
router.post('/:id/count', async (req, res) => {
  try {
    const { itemId, count } = req.body;
    await pool.query(
      'UPDATE transfer_items SET received_quantity = $1, counted_confirmed = TRUE WHERE id = $2 AND transfer_id = $3',
      [Number(count), itemId, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/:id/count error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/transfers/:id/submit-count — Receiving → Counted. Blocked if any
// line item hasn't been counted yet.
router.post('/:id/submit-count', async (req, res) => {
  try {
    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    if (found.items.some(i => !i.counted_confirmed)) {
      return res.status(400).json({ error: 'All line items must be counted before submitting' });
    }
    await pool.query("UPDATE transfers SET status = 'counted', counted_at = NOW(), updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/:id/submit-count error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Counted → Commit (Buyer) ────────────────────────────────────────────────

// Shared by /:id/commit and /commit-selected — see spec doc section 4's
// "已更正" Commit logic and section 2's Shipment-level mutation table.
async function commitOne(id) {
  const found = await fetchTransferWithItems(id);
  if (!found) throw new Error('Transfer not found');
  const { transfer, items } = found;
  if (!transfer.shopify_shipment_id) throw new Error('No shipment on this transfer');

  const session = await getSession();
  if (!session) throw new Error('No session');
  const shopify = getShopify();
  const client = new shopify.clients.Graphql({ session });

  const mismatched = items.filter(i => i.received_quantity != null && i.received_quantity !== i.quantity);
  if (mismatched.length > 0) {
    const updateMutation = `
      mutation inventoryShipmentUpdateItemQuantities($input: InventoryShipmentUpdateItemQuantitiesInput!, $idempotencyKey: String!) {
        inventoryShipmentUpdateItemQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryShipment { id }
          userErrors { field message }
        }
      }
    `;
    const data = await graphql(client, updateMutation, {
      input: {
        id: transfer.shopify_shipment_id,
        items: mismatched.map(i => ({ shipmentLineItemId: i.shipment_line_item_id, quantity: i.received_quantity })),
      },
      idempotencyKey: crypto.randomUUID(),
    });
    const errors = data?.inventoryShipmentUpdateItemQuantities?.userErrors || [];
    if (errors.length > 0) throw new Error(errors.map(e => e.message).join('; '));
  }

  const receiveMutation = `
    mutation inventoryShipmentReceive($id: ID!, $bulkReceiveAction: InventoryShipmentReceiveLineItemReason!, $idempotencyKey: String!) {
      inventoryShipmentReceive(id: $id, bulkReceiveAction: $bulkReceiveAction) @idempotent(key: $idempotencyKey) {
        inventoryShipment { id }
        userErrors { field message }
      }
    }
  `;
  const receiveData = await graphql(client, receiveMutation, {
    id: transfer.shopify_shipment_id,
    bulkReceiveAction: 'ACCEPTED',
    idempotencyKey: crypto.randomUUID(),
  });
  const receiveErrors = receiveData?.inventoryShipmentReceive?.userErrors || [];
  if (receiveErrors.length > 0) throw new Error(receiveErrors.map(e => e.message).join('; '));

  for (const item of mismatched) {
    await pool.query('UPDATE transfer_items SET quantity = $1 WHERE id = $2', [item.received_quantity, item.id]);
  }
  await pool.query("UPDATE transfers SET status = 'committed', committed_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
}

router.post('/:id/commit', async (req, res) => {
  try {
    await commitOne(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/:id/commit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/transfers/commit-selected — Ongoing list's "Commit selected".
// Confirmed by Hera: batch = the same per-transfer Commit logic, run for
// each selected transfer individually.
router.post('/commit-selected', async (req, res) => {
  const { ids } = req.body;
  const results = [];
  for (const id of ids || []) {
    try {
      await commitOne(id);
      results.push({ id, success: true });
    } catch (e) {
      results.push({ id, success: false, error: e.message });
    }
  }
  res.json({ results });
});

// ─── Delete selected (Buyer, Ongoing list / Pending line items) ─────────────

// DELETE /api/transfers/:id/items — Body: { itemIds: [...] } — Pending page's
// "Delete selected" for line items.
router.delete('/:id/items', async (req, res) => {
  try {
    const { itemIds } = req.body;
    await pool.query('DELETE FROM transfer_items WHERE transfer_id = $1 AND id = ANY($2)', [req.params.id, itemIds || []]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/transfers/:id/items error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/transfers/delete-selected — Ongoing list's "Delete selected"
// (whole transfers, not yet committed).
router.post('/delete-selected', async (req, res) => {
  try {
    const { ids } = req.body;
    await pool.query("DELETE FROM transfers WHERE id = ANY($1) AND status != 'committed'", [ids || []]);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/delete-selected error:', e);
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;
