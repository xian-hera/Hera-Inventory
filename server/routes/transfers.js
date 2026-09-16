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
//
// ── 2026-09-10 addendum — "Commit from any status" (commitOne() below):
// Buyer can now hit Commit from Loading/Pending/Good to go/In transit/
// Receiving, not just Counted. Per Shopify dev support (asked 2026-09-10):
// there is no documented shortcut mutation to jump an InventoryTransfer
// straight to TRANSFERRED, and skipping the ready-to-ship/in-transit steps
// is undocumented behavior that risks incorrect committed/incoming
// inventory numbers — so commitOne() still walks the same documented state
// machine, it just does so automatically in one click:
//   no shipment yet (Loading/Pending)   → inventoryTransferMarkAsReadyToShip
//                                          (only from these two statuses,
//                                          matching the existing Confirm/
//                                          submit-loading logic) →
//                                          inventoryShipmentCreateInTransit
//                                          (create + mark-in-transit in one
//                                          call — see ensureShipmentInTransit())
//   shipment exists, status Good to go  → inventoryShipmentMarkInTransit
//                                          (the shipment was created DRAFT
//                                          by the normal submit-loading/
//                                          confirm path and never dispatched)
//   shipment exists, In transit/
//   Receiving/Counted                   → already in transit, nothing extra
// ...then the existing mismatch-check + inventoryShipmentReceive logic runs
// unchanged. Uses whatever quantities are already on the transfer (qty_loaded
// if set, else the transfer quantity) as the "as received" quantities — a
// no-discrepancy fast path, not a substitute for Counted's real reconciliation.

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

// "Commit immediately" fast path (spec doc addendum, 2026-09-10): Buyer can
// hit Commit from ANY status (Loading/Pending/Good to go/In transit/
// Receiving/Counted), not just Counted. Per Shopify dev support's guidance
// obtained 2026-09-10 (documented state machine, no shortcut mutation
// exists to jump an InventoryTransfer straight to TRANSFERRED, and skipping
// ready-to-ship/in-transit is undocumented behavior that risks incorrect
// committed/incoming inventory numbers), the safe sequence is still
// ready-to-ship -> shipment in transit -> receive — this just chains those
// steps automatically in commitOne() below instead of requiring the Buyer
// to click through Loading -> Good to go -> In transit -> Receiving ->
// Counted manually. Creates the shipment already IN_TRANSIT in one call
// (inventoryShipmentCreateInTransit) rather than ensureShipment()'s
// create-as-DRAFT-then-dispatch-later — same defensive "read back an
// existing shipment if create fails" fallback as ensureShipment(), for the
// same reason (guards against the still-unconfirmed "does Shopify
// auto-create a shipment" question noted at the top of this file).
async function ensureShipmentInTransit(shopifyClient, transferRow, items) {
  if (transferRow.shopify_shipment_id) return transferRow.shopify_shipment_id;

  const createMutation = `
    mutation inventoryShipmentCreateInTransit($input: InventoryShipmentCreateInput!, $idempotencyKey: String!) {
      inventoryShipmentCreateInTransit(input: $input) @idempotent(key: $idempotencyKey) {
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
  const result = data?.inventoryShipmentCreateInTransit;
  const userErrors = result?.userErrors || [];
  if (userErrors.length > 0 || !result?.inventoryShipment?.id) {
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
      throw new Error(`Failed to create in-transit shipment: ${userErrors.map(e => e.message).join('; ') || 'unknown error'}`);
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

// ── 2026-09-15 七项改动的共享 helper（见 spec doc 第 11 节）───────────────────

// Line items still on the transfer for Shopify-facing purposes — a Buyer
// Edit (see /:id/edit below) soft-deletes a removed line item (edit_state =
// 'removed', kept in the DB purely for the cross-role strikethrough display)
// instead of hard-deleting it immediately, so every place that builds a
// Shopify mutation payload from `items` must first filter these out.
function activeItems(items) {
  return items.filter(i => i.edit_state !== 'removed');
}

// Optimistic-concurrency check for change 1's "This transfer has been
// updated by someone else" modal. Every status-changing endpoint that a
// detail page's main button can call accepts an optional expectedUpdatedAt
// (ISO string of the transfers.updated_at the page loaded). If the caller
// passes it and it no longer matches, the click is stale — someone else
// moved this transfer forward first — so we refuse instead of silently
// operating on a transfer the caller's screen doesn't actually reflect
// anymore. Not passing expectedUpdatedAt at all skips the check (used by
// bulk/batch callers like commit-selected/dispatch-selected, which don't
// hold a single per-transfer snapshot).
async function checkNotStale(id, expectedUpdatedAt) {
  if (!expectedUpdatedAt) return;
  const { rows } = await pool.query('SELECT updated_at FROM transfers WHERE id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('Transfer not found');
    err.statusCode = 404;
    throw err;
  }
  const current = new Date(rows[0].updated_at).getTime();
  const expected = new Date(expectedUpdatedAt).getTime();
  if (Number.isFinite(current) && Number.isFinite(expected) && current !== expected) {
    const err = new Error('This transfer has been updated by someone else');
    err.statusCode = 409;
    throw err;
  }
}

// Hold (spec doc section 改动六): while on_hold, EVERY role — including Buyer
// themselves — is blocked from any action that changes this transfer's
// status. Buyer must Release before advancing it further, same as everyone
// else ("当 Buyer hold 一个 transfer 之后，buyer 自己也需要先 release，才能推进其状态").
// The `asBuyer` param callers still pass is kept only so Hold/Release
// themselves (and Edit — see /:id/edit) can identify the caller for other
// purposes; it is NOT a bypass here.
async function assertNotHeld(id, _asBuyer) {
  const { rows } = await pool.query('SELECT on_hold FROM transfers WHERE id = $1', [id]);
  if (rows[0]?.on_hold) {
    const err = new Error('Buyer put this transfer on hold');
    err.statusCode = 423;
    throw err;
  }
}

// Shared catch-block responder — checkNotStale/assertNotHeld throw with a
// statusCode (409/423/404); anything else is a real server error (500).
function sendErr(res, e, logPrefix) {
  console.error(`${logPrefix} error:`, e.message);
  res.status(e.statusCode || 500).json({ error: e.message });
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

// Refresh from/to location qty snapshot for every SKU on a transfer — the
// backing logic for the "Refresh qty" button (Buyer/Warehouse/Manager).
// Same one-SKU-at-a-time GraphQL lookup as shopify.js's GET
// /inventory-by-sku, just run server-side against every line item in one
// request and written straight into transfer_items.from_qty_snapshot /
// to_qty_snapshot, instead of the frontend firing one fetch per SKU and
// holding the result only in memory (see the from_qty_snapshot column
// comment in init.js for why this replaced the old "query on every page
// load" behavior).
async function refreshQtySnapshots(shopifyClient, transferRow, items) {
  for (const item of items) {
    if (!item.sku) continue;
    try {
      const query = `{
        productVariants(first: 1, query: "${activeFilter(`sku:${item.sku.replace(/"/g, '')}`)}") {
          edges { node {
            inventoryItem {
              inventoryLevels(first: 20, includeInactive: true) {
                edges { node { location { id } quantities(names: ["available"]) { name quantity } } }
              }
            }
          } }
        }
      }`;
      const data = await graphql(shopifyClient, query);
      const edge = data?.productVariants?.edges?.[0];
      if (!edge) continue;
      const levels = edge.node.inventoryItem.inventoryLevels.edges;
      const fromLevel = levels.find(e => e.node.location.id === transferRow.from_location_id);
      const toLevel = levels.find(e => e.node.location.id === transferRow.to_location_id);
      const fromQty = fromLevel?.node.quantities.find(q => q.name === 'available')?.quantity;
      const toQty = toLevel?.node.quantities.find(q => q.name === 'available')?.quantity;
      await pool.query(
        'UPDATE transfer_items SET from_qty_snapshot = $1, to_qty_snapshot = $2 WHERE id = $3',
        [fromQty ?? null, toQty ?? null, item.id]
      );
    } catch (e) {
      console.error(`refreshQtySnapshots: lookup failed for SKU ${item.sku}:`, e.message);
    }
  }
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
          `INSERT INTO transfer_items (transfer_id, sku, name, quantity, inventory_item_id, from_qty_snapshot, to_qty_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            transfer.id, item.sku, item.name || null, Number(item.quantity), item.inventoryItemId || null,
            item.fromQty != null ? Number(item.fromQty) : null,
            item.toQty != null ? Number(item.toQty) : null,
          ]
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

// 2026-09-15: nothing rests at status='committed' anymore — commitOne() now
// moves straight to 'archived' (spec doc 改动三). /recent and /history read
// archived rows instead; 'committed' is kept in the CHECK constraint only for
// backward compatibility with old rows/callers, not as a state anything new
// writes.
router.get('/recent', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, transfer_no, shopify_transfer_id, shopify_transfer_name, shopify_transfer_url,
              from_location, to_location, committed_at, auto_committed
       FROM transfers
       WHERE status = 'archived'
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
             from_location, to_location, committed_at, auto_committed
      FROM transfers
      WHERE status = 'archived'`;
    if (q) {
      params.push(`%${q}%`);
      query += ` AND id IN (
        SELECT DISTINCT t2.id
        FROM transfers t2
        LEFT JOIN transfer_items it2 ON it2.transfer_id = t2.id
        WHERE t2.status = 'archived'
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

// GET /api/transfers/ongoing?includeArchived=true — Buyer sees every status
// except archived by default (spec doc 改动三: Archived is a filter, off by
// default). Passing includeArchived=true shows archived rows too — the
// frontend uses this to power the Ongoing list's "Show archived" toggle,
// reading auto_committed off each row to badge the ones that skipped Buyer
// review entirely.
// 2026-09-16: "Show archived" toggle removed (Buyer replaced it with a
// front-end Status/From/To filter set) — this route no longer filters by
// status at all, it just returns every transfer and lets
// BuyerTransferOngoing.js decide what to display.
router.get('/ongoing', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, transfer_no, shopify_transfer_id, shopify_transfer_name, shopify_transfer_url,
              from_location, to_location, status, created_at, on_hold, auto_committed
       FROM transfers
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
      `SELECT id, transfer_no, shopify_transfer_name, from_location, to_location, status, on_hold
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

// GET /api/transfers/warehouse/receiving-to-hq — 改动二第 1/2 点: a third
// Warehouse home card, "Receiving to HQ" — every transfer whose to_location
// is HQ, In transit or Receiving. Unlike the from-HQ card above, this one is
// keyed off to_location, not from_location — Warehouse acts as the
// to-location's receiving/counting role here, mirroring what Manager does
// for a store (see WarehouseTransferReceivingDetail.js).
router.get('/warehouse/receiving-to-hq', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, transfer_no, shopify_transfer_name, from_location, to_location, status, on_hold
       FROM transfers
       WHERE to_location = $1 AND status IN ('in_transit', 'receiving')
       ORDER BY created_at ASC`,
      [HQ_LOCATION_NAME]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/transfers/warehouse/receiving-to-hq error:', e);
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
      `SELECT id, transfer_no, shopify_transfer_name, from_location, to_location, status, on_hold
       FROM transfers
       WHERE to_location = $1 AND status IN ('in_transit','receiving')
       ORDER BY created_at ASC`,
      [location]
    );
    const sending = await pool.query(
      `SELECT id, transfer_no, shopify_transfer_name, from_location, to_location, status, on_hold
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

    // Wig Number: Manager pages always show it; Warehouse only in the new
    // Receiving to HQ flow (改动二第 2 点 — same list structure as Manager's
    // Receiving side, Wig Number included), never in Warehouse's original
    // Loading/Dispatch pages. wigContext=receiving-hq is what
    // WarehouseTransferReceivingDetail.js passes.
    const needsWigNumbers = role === 'manager' || (role === 'warehouse' && req.query.wigContext === 'receiving-hq');
    if (needsWigNumbers) {
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

// ─── Refresh qty (Buyer/Warehouse/Manager "Refresh qty" button) ─────────────

// POST /api/transfers/:id/refresh-qty — re-queries Shopify for every line
// item's from/to location Available qty and writes it into
// transfer_items.from_qty_snapshot/to_qty_snapshot (see init.js's column
// comment). Returns the refreshed items so the caller can just replace its
// items state with the response instead of re-fetching the whole transfer.
router.post('/:id/refresh-qty', async (req, res) => {
  try {
    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    const { transfer, items } = found;

    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    await refreshQtySnapshots(client, transfer, items);
    const refreshed = await fetchTransferWithItems(transfer.id);
    res.json({ success: true, items: refreshed.items });
  } catch (e) {
    console.error('POST /api/transfers/:id/refresh-qty error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Hold / Release (Buyer, 改动六) ──────────────────────────────────────────
// Only meaningful on Loading/Pending/Good to go — the frontend only shows the
// button there — but not enforced here: Buyer can also release a transfer
// they advanced past Good to go themselves while held (see the Release
// button-visibility note in spec doc section 11 改动六).

router.post('/:id/hold', async (req, res) => {
  try {
    await pool.query('UPDATE transfers SET on_hold = TRUE, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/hold');
  }
});

router.post('/:id/release', async (req, res) => {
  try {
    await pool.query('UPDATE transfers SET on_hold = FALSE, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/release');
  }
});

// ─── Buyer Edit (改动四) ──────────────────────────────────────────────────────

// POST /api/transfers/:id/edit — only valid while status is Loading/Pending/
// Good to go. Body: {
//   expectedUpdatedAt,
//   added: [{ sku, name, inventoryItemId, quantity }],
//   removedItemIds: [itemId, ...],
//   quantityChanges: [{ itemId, quantity }],
// }
//
// Pushes the edit to Shopify at the Transfer layer (inventoryTransferSetItems
// handles both "add a new line item" and "change an existing one's quantity"
// in one mutation per shopify.dev; inventoryTransferRemoveItems handles
// deletions) and — only when this transfer already has a shipment (i.e. it
// was Good to go before this edit) — ALSO at the Shipment layer, because
// Dispatch/Commit read from the Shipment, not the Transfer, from that point
// on (see the spec doc discussion this resolved). ⚠️ inventoryTransferRemove
// Items / inventoryShipmentAddItems / inventoryShipmentRemoveItems have never
// been called anywhere in this codebase before this — their input shapes
// below are our best-guess construction from shopify.dev's mutation
// reference (mirroring inventoryTransferSetItems'/inventoryShipmentUpdate
// ItemQuantities' already-confirmed shapes), NOT yet exercised against a
// real transfer. If Save errors out with a GraphQL schema complaint (e.g.
// "not a defined input type" or an unknown field), send me the exact error —
// same pattern as the inventoryTransferMarkAsReadyToShip bug this session
// already found and fixed once.
//
// Always ends with status = 'loading', regardless of what status this
// transfer was in before the edit — even Good to go, per Hera's decision:
// Shopify has no mutation to un-mark a transfer as ready-to-ship, so its
// side stays Ready-to-ship/committed the whole time; only our own status
// label and the actual line items move.
router.post('/:id/edit', async (req, res) => {
  try {
    const { expectedUpdatedAt, added, removedItemIds, quantityChanges } = req.body || {};
    await checkNotStale(req.params.id, expectedUpdatedAt);

    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    const { transfer } = found;
    if (!['loading', 'pending', 'good_to_go'].includes(transfer.status)) {
      return res.status(400).json({ error: 'This transfer can no longer be edited' });
    }
    const itemsById = new Map(found.items.map(i => [i.id, i]));

    const addedList = added || [];
    const removedIds = removedItemIds || [];
    const qtyChanges = (quantityChanges || []).filter(c => !removedIds.includes(c.itemId));

    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    // A. Transfer layer — add + quantity-change in one inventoryTransferSetItems
    // call (it adds a line item that isn't on the transfer yet, or updates
    // the quantity of one that already is).
    const setLineItems = [
      ...addedList.map(a => ({ inventoryItemId: a.inventoryItemId, quantity: Number(a.quantity) })),
      ...qtyChanges.map(c => ({ inventoryItemId: itemsById.get(c.itemId)?.inventory_item_id, quantity: Number(c.quantity) })).filter(li => li.inventoryItemId),
    ];
    if (setLineItems.length > 0) {
      const setItemsMutation = `
        mutation inventoryTransferSetItems($input: InventoryTransferSetItemsInput!, $idempotencyKey: String!) {
          inventoryTransferSetItems(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryTransfer { id }
            userErrors { field message }
          }
        }
      `;
      const setData = await graphql(client, setItemsMutation, {
        input: { id: transfer.shopify_transfer_id, lineItems: setLineItems },
        idempotencyKey: crypto.randomUUID(),
      });
      const setErrors = setData?.inventoryTransferSetItems?.userErrors || [];
      if (setErrors.length > 0) return res.status(400).json({ error: setErrors.map(e => e.message).join('; ') });
    }

    // B. Transfer layer — removals.
    if (removedIds.length > 0) {
      const removeLineItems = removedIds
        .map(id => itemsById.get(id))
        .filter(Boolean)
        .map(i => ({ inventoryItemId: i.inventory_item_id, quantity: i.quantity }));
      if (removeLineItems.length > 0) {
        const removeMutation = `
          mutation inventoryTransferRemoveItems($input: InventoryTransferRemoveItemsInput!, $idempotencyKey: String!) {
            inventoryTransferRemoveItems(input: $input) @idempotent(key: $idempotencyKey) {
              inventoryTransfer { id }
              userErrors { field message }
            }
          }
        `;
        const removeData = await graphql(client, removeMutation, {
          input: { id: transfer.shopify_transfer_id, lineItems: removeLineItems },
          idempotencyKey: crypto.randomUUID(),
        });
        const removeErrors = removeData?.inventoryTransferRemoveItems?.userErrors || [];
        if (removeErrors.length > 0) return res.status(400).json({ error: removeErrors.map(e => e.message).join('; ') });
      }
    }

    // C. Shipment layer — only if this transfer already has a shipment (was
    // Good to go before this edit). Dispatch/Commit read the Shipment, not
    // the Transfer, so it has to be kept in sync too.
    if (transfer.shopify_shipment_id) {
      const shipmentId = transfer.shopify_shipment_id;

      if (qtyChanges.length > 0) {
        const shipmentQtyItems = qtyChanges
          .map(c => ({ shipmentLineItemId: itemsById.get(c.itemId)?.shipment_line_item_id, quantity: Number(c.quantity) }))
          .filter(li => li.shipmentLineItemId);
        if (shipmentQtyItems.length > 0) {
          // ⚠️ 2026-09-16 修正：这条 mutation 的参数是扁平的 id/items，不是包一层
          // 的 input 对象——之前一直以为是 wrapped input（还被记成"已确认可用"），
          // 直到这次临时工具真的跑到这条分支才被 Shopify 报错
          // "missing required arguments: id" 揭穿。已通过官方 mutation 参考页
          // 核实正确形状。见 claude/TRANSFER_FEATURE_SPEC.md 第 14 节。
          const updateMutation = `
            mutation inventoryShipmentUpdateItemQuantities($id: ID!, $items: [InventoryShipmentUpdateItemQuantitiesInput!], $idempotencyKey: String!) {
              inventoryShipmentUpdateItemQuantities(id: $id, items: $items) @idempotent(key: $idempotencyKey) {
                inventoryShipment { id }
                userErrors { field message }
              }
            }
          `;
          const data = await graphql(client, updateMutation, {
            id: shipmentId,
            items: shipmentQtyItems,
            idempotencyKey: crypto.randomUUID(),
          });
          const errors = data?.inventoryShipmentUpdateItemQuantities?.userErrors || [];
          if (errors.length > 0) return res.status(400).json({ error: errors.map(e => e.message).join('; ') });
        }
      }

      if (removedIds.length > 0) {
        const shipmentLineItemIdsToRemove = removedIds
          .map(id => itemsById.get(id)?.shipment_line_item_id)
          .filter(Boolean);
        if (shipmentLineItemIdsToRemove.length > 0) {
          const removeShipmentMutation = `
            mutation inventoryShipmentRemoveItems($input: InventoryShipmentRemoveItemsInput!, $idempotencyKey: String!) {
              inventoryShipmentRemoveItems(input: $input) @idempotent(key: $idempotencyKey) {
                inventoryShipment { id }
                userErrors { field message }
              }
            }
          `;
          const data = await graphql(client, removeShipmentMutation, {
            input: { id: shipmentId, lineItems: shipmentLineItemIdsToRemove.map(id => ({ id })) },
            idempotencyKey: crypto.randomUUID(),
          });
          const errors = data?.inventoryShipmentRemoveItems?.userErrors || [];
          if (errors.length > 0) console.error('inventoryShipmentRemoveItems userErrors (edit still applied at Transfer layer):', errors.map(e => e.message).join('; '));
        }
      }

      if (addedList.length > 0) {
        const addShipmentMutation = `
          mutation inventoryShipmentAddItems($input: InventoryShipmentAddItemsInput!, $idempotencyKey: String!) {
            inventoryShipmentAddItems(input: $input) @idempotent(key: $idempotencyKey) {
              inventoryShipment { id lineItems(first: 250) { edges { node { id inventoryItem { id } } } } }
              userErrors { field message }
            }
          }
        `;
        const data = await graphql(client, addShipmentMutation, {
          input: {
            id: shipmentId,
            lineItems: addedList.map(a => ({ inventoryItemId: a.inventoryItemId, quantity: Number(a.quantity) })),
          },
          idempotencyKey: crypto.randomUUID(),
        });
        const errors = data?.inventoryShipmentAddItems?.userErrors || [];
        if (errors.length > 0) console.error('inventoryShipmentAddItems userErrors (edit still applied at Transfer layer):', errors.map(e => e.message).join('; '));
        else if (data?.inventoryShipmentAddItems?.inventoryShipment) {
          // Re-map so the newly-added rows (inserted below) can pick up their
          // shipment_line_item_id in the same request cycle next time this
          // transfer is read — done after the INSERTs below instead, see D.
        }
      }
    }

    // D. Our own DB.
    for (const a of addedList) {
      await pool.query(
        `INSERT INTO transfer_items (transfer_id, sku, name, quantity, inventory_item_id, edit_state)
         VALUES ($1, $2, $3, $4, $5, 'added')`,
        [transfer.id, a.sku || null, a.name || null, Number(a.quantity), a.inventoryItemId]
      );
    }
    if (removedIds.length > 0) {
      await pool.query(
        `UPDATE transfer_items SET edit_state = 'removed' WHERE id = ANY($1)`,
        [removedIds]
      );
    }
    for (const c of qtyChanges) {
      await pool.query(
        `UPDATE transfer_items
         SET quantity = $1,
             edit_state = CASE WHEN edit_state = 'added' THEN 'added' ELSE 'qty_changed' END,
             loaded_confirmed = FALSE, qty_loaded = NULL,
             counted_confirmed = FALSE, received_quantity = NULL
         WHERE id = $2`,
        [Number(c.quantity), c.itemId]
      );
    }

    // If a shipment exists, re-map shipment_line_item_id for every active
    // item (covers the newly-added rows just inserted above, and keeps
    // everything else's mapping fresh too).
    if (transfer.shopify_shipment_id) {
      try {
        const lookup = `
          query shipmentLineItems($id: ID!) {
            inventoryShipment(id: $id) {
              id
              lineItems(first: 250) { edges { node { id inventoryItem { id } } } }
            }
          }
        `;
        const lookupData = await graphql(client, lookup, { id: transfer.shopify_shipment_id });
        const shipment = lookupData?.inventoryShipment;
        if (shipment) {
          const refreshedItems = await fetchTransferWithItems(transfer.id);
          await mapShipmentLineItems(shipment, activeItems(refreshedItems.items));
        }
      } catch (e) {
        console.error(`POST /api/transfers/:id/edit: shipment line item re-map failed for transfer ${transfer.id}:`, e.message);
      }
    }

    await pool.query("UPDATE transfers SET status = 'loading', updated_at = NOW() WHERE id = $1", [transfer.id]);

    const refreshed = await fetchTransferWithItems(transfer.id);
    res.json({ success: true, transfer: refreshed.transfer, items: refreshed.items });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/edit');
  }
});

// ─── Loading (Warehouse, or Manager as from-location) ───────────────────────

// POST /api/transfers/:id/qty-loaded — one line item's stepper+check
// confirmation. Body: { itemId, qty }.
router.post('/:id/qty-loaded', async (req, res) => {
  try {
    const { itemId, qty, asBuyer } = req.body;
    await assertNotHeld(req.params.id, asBuyer);
    await pool.query(
      'UPDATE transfer_items SET qty_loaded = $1, loaded_confirmed = TRUE WHERE id = $2 AND transfer_id = $3',
      [Number(qty), itemId, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/qty-loaded');
  }
});

// POST /api/transfers/:id/submit-loading — the Loading page's "Submit to
// Buyer" / "Good to go" button (disabled until every item is confirmed —
// enforced here too, not just client-side). If any item's qty_loaded !=
// quantity: advance to Pending. Otherwise: mark Good to go directly —
// inventoryTransferMarkAsReadyToShip, then create the shipment from the
// confirmed qty_loaded values.
// Body (all optional): { force, asBuyer, expectedUpdatedAt }. force (改动一
// 第 1 点, Buyer only): Buyer's main button on a Loading transfer can jump
// straight to Good to go even if line items are still unconfirmed — every
// unconfirmed active item is treated as "loaded exactly as transferred"
// (qty_loaded = quantity) and the Pending-on-mismatch branch is skipped
// entirely, matching "main button 默认为 Good to Go" from the spec.
router.post('/:id/submit-loading', async (req, res) => {
  try {
    const { force, asBuyer, expectedUpdatedAt } = req.body || {};
    await checkNotStale(req.params.id, expectedUpdatedAt);
    await assertNotHeld(req.params.id, asBuyer);

    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    const { transfer } = found;
    const items = activeItems(found.items);

    if (!force && items.some(i => !i.loaded_confirmed)) {
      return res.status(400).json({ error: 'All line items must be confirmed before submitting' });
    }
    if (force) {
      for (const i of items) {
        if (!i.loaded_confirmed) {
          await pool.query(
            'UPDATE transfer_items SET qty_loaded = quantity, loaded_confirmed = TRUE WHERE id = $1',
            [i.id]
          );
          i.qty_loaded = i.quantity;
          i.loaded_confirmed = true;
        }
      }
    }
    const hasMismatch = !force && items.some(i => i.qty_loaded !== i.quantity);

    if (hasMismatch) {
      await pool.query("UPDATE transfers SET status = 'pending', updated_at = NOW() WHERE id = $1", [transfer.id]);
      return res.json({ success: true, status: 'pending' });
    }

    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    // 2026-09-15: if a shipment already exists, this transfer was previously
    // advanced to Good to go and later reverted to Loading by a Buyer Edit
    // (改动四) — Shopify's side never actually left Ready-to-ship, only the
    // line items changed, so calling mark-as-ready-to-ship again would be
    // redundant (and may error). Skip straight to re-confirming the
    // shipment/status below.
    if (!transfer.shopify_shipment_id) {
      // 2026-09-15 fix: this mutation takes a plain `id: ID!` argument, NOT a
      // wrapped `input` object — confirmed against shopify.dev's mutation
      // reference (the only argument is `id`; there is no
      // InventoryTransferMarkAsReadyToShipInput type). The old
      // `input: InventoryTransferMarkAsReadyToShipInput!` shape below was
      // wrong from when this route was first written and only surfaced as a
      // real error once a Buyer actually hit a code path that called it —
      // same bug existed in the two other copies of this mutation in this
      // file (POST /:id/confirm and commitOne()), fixed there too.
      const markReadyMutation = `
        mutation inventoryTransferMarkAsReadyToShip($id: ID!, $idempotencyKey: String!) {
          inventoryTransferMarkAsReadyToShip(id: $id) @idempotent(key: $idempotencyKey) {
            inventoryTransfer { id }
            userErrors { field message }
          }
        }
      `;
      const markData = await graphql(client, markReadyMutation, {
        id: transfer.shopify_transfer_id,
        idempotencyKey: crypto.randomUUID(),
      });
      const markErrors = markData?.inventoryTransferMarkAsReadyToShip?.userErrors || [];
      if (markErrors.length > 0) {
        return res.status(400).json({ error: markErrors.map(e => e.message).join('; ') });
      }
    }

    const shipmentId = await ensureShipment(client, transfer, items);
    await pool.query(
      "UPDATE transfers SET status = 'good_to_go', shopify_shipment_id = $1, updated_at = NOW() WHERE id = $2",
      [shipmentId, transfer.id]
    );
    res.json({ success: true, status: 'good_to_go' });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/submit-loading');
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
    const { items: confirmedItems, expectedUpdatedAt } = req.body;
    await checkNotStale(req.params.id, expectedUpdatedAt);

    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    const { transfer } = found;
    const items = activeItems(found.items);

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

    // C. Advance to Good to go. 2026-09-15: skip mark-as-ready-to-ship if a
    // shipment already exists (this transfer was previously Good to go and
    // reverted to Loading/Pending by a Buyer Edit — see the same guard in
    // POST /:id/submit-loading above).
    if (!transfer.shopify_shipment_id) {
      // 2026-09-15 fix: plain `id: ID!` argument, not a wrapped input object —
      // see the comment on this same mutation in POST /:id/submit-loading above.
      const markReadyMutation = `
        mutation inventoryTransferMarkAsReadyToShip($id: ID!, $idempotencyKey: String!) {
          inventoryTransferMarkAsReadyToShip(id: $id) @idempotent(key: $idempotencyKey) {
            inventoryTransfer { id }
            userErrors { field message }
          }
        }
      `;
      const markData = await graphql(client, markReadyMutation, {
        id: transfer.shopify_transfer_id,
        idempotencyKey: crypto.randomUUID(),
      });
      const markErrors = markData?.inventoryTransferMarkAsReadyToShip?.userErrors || [];
      if (markErrors.length > 0) {
        return res.status(400).json({ error: markErrors.map(e => e.message).join('; ') });
      }
    }

    const refreshed = await fetchTransferWithItems(transfer.id);
    const shipmentId = await ensureShipment(client, transfer, activeItems(refreshed.items));
    await pool.query(
      "UPDATE transfers SET status = 'good_to_go', shopify_shipment_id = $1, updated_at = NOW() WHERE id = $2",
      [shipmentId, transfer.id]
    );
    res.json({ success: true, status: 'good_to_go' });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/confirm');
  }
});

// ─── Loading → Cancel (Buyer) ────────────────────────────────────────────────

router.post('/:id/cancel', async (req, res) => {
  try {
    await checkNotStale(req.params.id, (req.body || {}).expectedUpdatedAt);
    // 2026-09-15 改动六收尾修复: Cancel 会直接删掉这个 transfer，和其他状态
    // 推进类操作一样应该被 Hold 挡住，之前遗漏了这条。
    await assertNotHeld(req.params.id, (req.body || {}).asBuyer);
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
    sendErr(res, e, 'POST /api/transfers/:id/cancel');
  }
});

// ─── Good to go → In transit (Warehouse "Dispatch" / Manager "Truck picked up") ──

// Handles both the Warehouse "Dispatch" button and the Manager "Truck picked
// up" button (spec doc: same effect, different label per role/page).
router.post('/:id/dispatch', async (req, res) => {
  try {
    const { asBuyer, expectedUpdatedAt } = req.body || {};
    await checkNotStale(req.params.id, expectedUpdatedAt);
    await dispatchOne(req.params.id, asBuyer);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/dispatch');
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
async function dispatchOne(id, asBuyer) {
  await assertNotHeld(id, asBuyer);
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

  // Freeze a snapshot for the manager's own History (Transfer page, Sending
  // side — "Sent") — see server/routes/managerHistory.js. Only recorded when
  // the FROM location is a store, not HQ: this is the "Pick up from store"
  // flow where the from-location manager is the one who actually clicked
  // "Truck picked up" (same endpoint/action as Warehouse's own "Dispatch" on
  // an HQ-origin transfer, which has no Manager History page to record into).
  // A failure here is logged only — it must never block the dispatch itself.
  if (transfer.from_location !== HQ_LOCATION_NAME) {
    try {
      const { items } = found;
      await attachWigNumbers(client, items);
      const { insertManagerHistory } = require('./managerHistory');
      await insertManagerHistory({
        kind: 'transfer_sending',
        location: transfer.from_location,
        ref_no: transfer.transfer_no,
        label: 'Sent',
        summary: {},
        detail: {
          transfer_no: transfer.transfer_no,
          from_location: transfer.from_location,
          to_location: transfer.to_location,
          items,
        },
      });
    } catch (histErr) {
      console.error(`Failed to record manager history for transfer ${transfer.id} dispatch:`, histErr.message);
    }
  }
}

// ─── Manager: Receiving side ─────────────────────────────────────────────────

// POST /api/transfers/:id/delivered — In transit → Receiving. No Shopify
// call (spec doc section 6: this is purely our own status advance).
router.post('/:id/delivered', async (req, res) => {
  try {
    const { asBuyer, expectedUpdatedAt } = req.body || {};
    await checkNotStale(req.params.id, expectedUpdatedAt);
    await assertNotHeld(req.params.id, asBuyer);
    await pool.query("UPDATE transfers SET status = 'receiving', delivered_at = NOW(), updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/delivered');
  }
});

// POST /api/transfers/:id/count — one line item's count-modal submission.
// Body: { itemId, count }.
router.post('/:id/count', async (req, res) => {
  try {
    const { itemId, count, asBuyer } = req.body;
    await assertNotHeld(req.params.id, asBuyer);
    await pool.query(
      'UPDATE transfer_items SET received_quantity = $1, counted_confirmed = TRUE WHERE id = $2 AND transfer_id = $3',
      [Number(count), itemId, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/count');
  }
});

// POST /api/transfers/:id/submit-count — Receiving → Counted, blocked if any
// line item hasn't been counted yet — UNLESS force is set (改动二: Warehouse's
// "Submit Without Counting" button on a Receiving to HQ transfer, shown only
// when at least one item is still unprocessed). With force and at least one
// unprocessed item, the transfer goes to 'not_counted' instead of 'counted'
// (never auto-commits — Buyer always has to review/finish it). Without force
// — or with force passed but every item actually already processed, which
// the frontend shouldn't do but this guards against anyway — normal 'counted'
// path runs, and then (改动三) auto-commits + archives immediately if every
// item's received_quantity matches its transfer quantity exactly.
router.post('/:id/submit-count', async (req, res) => {
  try {
    const { force, asBuyer, expectedUpdatedAt } = req.body || {};
    await checkNotStale(req.params.id, expectedUpdatedAt);
    await assertNotHeld(req.params.id, asBuyer);

    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    const items = activeItems(found.items);
    const incomplete = items.some(i => !i.counted_confirmed);
    if (incomplete && !force) {
      return res.status(400).json({ error: 'All line items must be counted before submitting' });
    }
    if (incomplete && force) {
      await pool.query("UPDATE transfers SET status = 'not_counted', counted_at = NOW(), updated_at = NOW() WHERE id = $1", [req.params.id]);
      return res.json({ success: true, status: 'not_counted' });
    }

    const noQtyIssue = items.every(i => i.received_quantity === i.quantity);
    await pool.query("UPDATE transfers SET status = 'counted', counted_at = NOW(), updated_at = NOW() WHERE id = $1", [req.params.id]);

    // Freeze a snapshot of this transfer's counts for the manager's own
    // History (Transfer page, Receiving side — "Received") — see
    // server/routes/managerHistory.js. Independent of whatever happens to
    // this transfer afterward (buyer commit, etc). A failure here is logged
    // only — it must never block the manager's actual submit.
    try {
      const { transfer, items } = found;
      const session = await getSession();
      if (session) {
        const shopify = getShopify();
        const client = new shopify.clients.Graphql({ session });
        await attachWigNumbers(client, items);
      }
      const { insertManagerHistory } = require('./managerHistory');
      await insertManagerHistory({
        kind: 'transfer_receiving',
        location: transfer.to_location,
        ref_no: transfer.transfer_no,
        label: 'Received',
        summary: { from_location: transfer.from_location },
        detail: {
          transfer_no: transfer.transfer_no,
          from_location: transfer.from_location,
          to_location: transfer.to_location,
          items,
        },
      });
    } catch (histErr) {
      console.error(`Failed to record manager history for transfer ${req.params.id} submit-count:`, histErr.message);
    }

    // 改动三: no qty issue on a normally-completed count → auto commit +
    // archive right away, no Buyer review needed. A commit failure here
    // leaves the transfer sitting at 'counted' (already committed to the DB
    // above) for Buyer to commit manually instead — it must never turn this
    // Submit click itself into an error for Warehouse/Manager.
    if (noQtyIssue) {
      try {
        await commitOne(req.params.id, true);
        return res.json({ success: true, status: 'archived', autoCommitted: true });
      } catch (commitErr) {
        console.error(`Auto-commit failed for transfer ${req.params.id} after submit-count:`, commitErr.message);
      }
    }

    res.json({ success: true, status: 'counted' });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/submit-count');
  }
});

// ─── Counted → Commit (Buyer) ────────────────────────────────────────────────

// Shared by /:id/commit and /commit-selected — see spec doc section 4's
// "已更正" Commit logic and section 2's Shipment-level mutation table.
//
// 2026-09-10 addendum: Buyer can now hit Commit from ANY status, not just
// Counted (see ensureShipmentInTransit() above for the reasoning). Before
// the shared mismatch/receive logic below can run, this first makes sure a
// shipment exists and is IN_TRANSIT on Shopify's side, fast-forwarding
// through whatever steps this transfer hasn't been through yet:
//   - no shopify_shipment_id at all (Loading/Pending)  -> mark ready to
//     ship (only needed from these two, pre-ship, statuses), then create
//     the shipment already in transit.
//   - has a shipment, but status is still Good to go   -> that shipment
//     was created as DRAFT by the normal submit-loading/confirm path and
//     never dispatched — mark it in transit.
//   - has a shipment, status is In transit/Receiving/Counted -> already
//     in transit on Shopify's side, nothing to do here.
async function commitOne(id, autoCommitted) {
  const found = await fetchTransferWithItems(id);
  if (!found) throw new Error('Transfer not found');
  const { transfer } = found;
  const items = activeItems(found.items);

  const session = await getSession();
  if (!session) throw new Error('No session');
  const shopify = getShopify();
  const client = new shopify.clients.Graphql({ session });

  let shipmentId = transfer.shopify_shipment_id;

  if (!shipmentId) {
    if (transfer.status === 'loading' || transfer.status === 'pending') {
      // 2026-09-15 fix: plain `id: ID!` argument, not a wrapped input object —
      // see the comment on this same mutation in POST /:id/submit-loading above.
      const markReadyMutation = `
        mutation inventoryTransferMarkAsReadyToShip($id: ID!, $idempotencyKey: String!) {
          inventoryTransferMarkAsReadyToShip(id: $id) @idempotent(key: $idempotencyKey) {
            inventoryTransfer { id }
            userErrors { field message }
          }
        }
      `;
      const markData = await graphql(client, markReadyMutation, {
        id: transfer.shopify_transfer_id,
        idempotencyKey: crypto.randomUUID(),
      });
      const markErrors = markData?.inventoryTransferMarkAsReadyToShip?.userErrors || [];
      if (markErrors.length > 0) throw new Error(markErrors.map(e => e.message).join('; '));
    }
    shipmentId = await ensureShipmentInTransit(client, transfer, items);
    await pool.query('UPDATE transfers SET shopify_shipment_id = $1, updated_at = NOW() WHERE id = $2', [shipmentId, transfer.id]);
  } else if (transfer.status === 'good_to_go') {
    const inTransitMutation = `
      mutation inventoryShipmentMarkInTransit($id: ID!, $idempotencyKey: String!) {
        inventoryShipmentMarkInTransit(id: $id) @idempotent(key: $idempotencyKey) {
          inventoryShipment { id }
          userErrors { field message }
        }
      }
    `;
    const inTransitData = await graphql(client, inTransitMutation, { id: shipmentId, idempotencyKey: crypto.randomUUID() });
    const inTransitErrors = inTransitData?.inventoryShipmentMarkInTransit?.userErrors || [];
    if (inTransitErrors.length > 0) throw new Error(inTransitErrors.map(e => e.message).join('; '));
  }
  // in_transit / receiving / counted: shipment is already in transit — nothing to do above.

  const mismatched = items.filter(i => i.received_quantity != null && i.received_quantity !== i.quantity);
  if (mismatched.length > 0) {
    // ⚠️ 2026-09-16 修正：同上——扁平 id/items 参数，不是 wrapped input。
    // 见 claude/TRANSFER_FEATURE_SPEC.md 第 14 节。
    const updateMutation = `
      mutation inventoryShipmentUpdateItemQuantities($id: ID!, $items: [InventoryShipmentUpdateItemQuantitiesInput!], $idempotencyKey: String!) {
        inventoryShipmentUpdateItemQuantities(id: $id, items: $items) @idempotent(key: $idempotencyKey) {
          inventoryShipment { id }
          userErrors { field message }
        }
      }
    `;
    const data = await graphql(client, updateMutation, {
      id: shipmentId,
      items: mismatched.map(i => ({ shipmentLineItemId: i.shipment_line_item_id, quantity: i.received_quantity })),
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
    id: shipmentId,
    bulkReceiveAction: 'ACCEPTED',
    idempotencyKey: crypto.randomUUID(),
  });
  const receiveErrors = receiveData?.inventoryShipmentReceive?.userErrors || [];
  if (receiveErrors.length > 0) throw new Error(receiveErrors.map(e => e.message).join('; '));

  for (const item of mismatched) {
    await pool.query('UPDATE transfer_items SET quantity = $1 WHERE id = $2', [item.received_quantity, item.id]);
  }
  // 2026-09-15 (改动三): commit's terminal status is 'archived' now, not
  // 'committed' — nothing rests at 'committed' anymore, whether this was a
  // manual Buyer commit or an automatic one out of submit-count.
  // auto_committed only gets set true on the automatic path (default false,
  // per init.js) so Buyer can tell the two apart in the Ongoing list's
  // Archived filter.
  await pool.query(
    `UPDATE transfers SET status = 'archived', committed_at = NOW(), shopify_shipment_id = $1,
            auto_committed = $2, updated_at = NOW() WHERE id = $3`,
    [shipmentId, !!autoCommitted, id]
  );
  // 改动五: cross-role edit diff highlighting only holds until commit — once
  // archived, a 'removed' line item has no more reason to exist (it was
  // never really part of what got shipped/received) and every remaining
  // item's edit_state goes back to NULL.
  await pool.query("DELETE FROM transfer_items WHERE transfer_id = $1 AND edit_state = 'removed'", [id]);
  await pool.query("UPDATE transfer_items SET edit_state = NULL WHERE transfer_id = $1", [id]);
}

router.post('/:id/commit', async (req, res) => {
  try {
    const { expectedUpdatedAt } = req.body || {};
    await checkNotStale(req.params.id, expectedUpdatedAt);
    await commitOne(req.params.id, false);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e, 'POST /api/transfers/:id/commit');
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
      await commitOne(id, false);
      results.push({ id, success: true });
    } catch (e) {
      results.push({ id, success: false, error: e.message });
    }
  }
  res.json({ results });
});

// ─── Export PDF (Warehouse / Manager, any status) ───────────────────────────

// GET /api/transfers/:id/export-pdf?qtySide=from|to — Warehouse and
// Manager-as-from-location always pass qtySide=from; Manager-as-to-location
// (Receiving side) passes qtySide=to. Columns per Hera's spec (2026-09-10):
// Wig number / SKU / Name / {from or to location} qty / Transfer qty — Wig
// number is included even for Warehouse's printout here, unlike the on-screen
// table which never shows it for Warehouse (this is a deliberate difference
// for the printed copy). Same pdfkit table-drawing approach as
// poInvoices.js's GET /:id/export-pdf (kept as its own local copy per this
// codebase's convention — no shared pdf-table-utils module).
router.get('/:id/export-pdf', async (req, res) => {
  try {
    const { qtySide } = req.query;
    const found = await fetchTransferWithItems(req.params.id);
    if (!found) return res.status(404).json({ error: 'Transfer not found' });
    const { transfer, items } = found;

    const session = await getSession();
    if (session) {
      try {
        const shopify = getShopify();
        const client = new shopify.clients.Graphql({ session });
        await attachWigNumbers(client, items);
      } catch (e) {
        console.error('export-pdf: wig number lookup failed:', e.message);
      }
    }

    const useTo = qtySide === 'to';
    const qtyLabel = `${useTo ? transfer.to_location : transfer.from_location} qty`;
    const rows = items.map(item => [
      item.wig_number || '',
      item.sku || '',
      item.name || '',
      String((useTo ? item.to_qty_snapshot : item.from_qty_snapshot) ?? ''),
      String(item.quantity),
    ]);

    const PDFDocument = require('pdfkit');
    const filename = `${transfer.transfer_no || 'transfer'}-export.pdf`;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    doc.pipe(res);

    doc.fontSize(16).text(`${transfer.transfer_no || ''}  ${transfer.from_location} to ${transfer.to_location}`, { continued: false });
    doc.moveDown(0.5);

    const cols = [
      { label: 'Wig number', width: 80, key: 0 },
      { label: 'SKU', width: 100, key: 1 },
      { label: 'Name', width: 170, key: 2 },
      { label: qtyLabel, width: 80, key: 3 },
      { label: 'Transfer qty', width: 80, key: 4 },
    ];
    const startX = doc.page.margins.left;
    const tableWidth = cols.reduce((s, c) => s + c.width, 0);
    const rowVPad = 8;
    const headerHeight = 20;

    const drawHeader = (y) => {
      let x = startX;
      doc.fontSize(9).fillColor('#6d7175');
      cols.forEach(c => { doc.text(c.label, x, y, { width: c.width }); x += c.width; });
      doc.moveTo(startX, y + headerHeight - 6).lineTo(startX + tableWidth, y + headerHeight - 6)
        .strokeColor('#c9cccf').lineWidth(1).stroke();
    };

    let y = doc.y;
    drawHeader(y);
    y += headerHeight;
    doc.fillColor('#000');

    rows.forEach((r) => {
      doc.fontSize(9);
      const cellHeights = cols.map(c => doc.heightOfString(r[c.key] || '', { width: c.width }));
      const contentHeight = Math.max(...cellHeights, 10);
      const rowHeight = contentHeight + rowVPad;

      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader(y);
        y += headerHeight;
        doc.fillColor('#000');
      }

      let x = startX;
      cols.forEach((c) => {
        doc.text(r[c.key] || '', x, y, { width: c.width });
        x += c.width;
      });
      y += rowHeight;

      doc.moveTo(startX, y - 4).lineTo(startX + tableWidth, y - 4)
        .strokeColor('#f1f1f1').lineWidth(0.5).stroke();
      doc.fillColor('#000');
    });

    doc.end();
  } catch (e) {
    console.error('GET /api/transfers/:id/export-pdf error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Delete selected (Buyer, Ongoing list / Pending line items) ─────────────

// DELETE /api/transfers/:id/items — Body: { itemIds: [...] } — Pending page's
// "Delete selected" for line items.
router.delete('/:id/items', async (req, res) => {
  try {
    const { itemIds } = req.body;
    // 2026-09-15 改动六收尾修复: 这是 Pending 页"Delete selected line items"
    // 用的路由，会实际改变这个 transfer 的内容，之前的 Hold 检查遗漏了它。
    await assertNotHeld(req.params.id, (req.body || {}).asBuyer);
    await pool.query('DELETE FROM transfer_items WHERE transfer_id = $1 AND id = ANY($2)', [req.params.id, itemIds || []]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e, 'DELETE /api/transfers/:id/items');
  }
});

// POST /api/transfers/delete-selected — Ongoing list's "Delete selected"
// (whole transfers, not yet committed).
router.post('/delete-selected', async (req, res) => {
  try {
    const { ids } = req.body;
    // 2026-09-15 改动三修复: 'committed' 不再是任何 transfer 会停留的可见状态——
    // Commit 之后立即变成 'archived'，所以这里的保护条件必须跟着改成排除
    // 'archived'，否则一个已经 Commit/归档的 transfer 仍然会被这条路由整条删掉。
    await pool.query("DELETE FROM transfers WHERE id = ANY($1) AND status != 'archived'", [ids || []]);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/transfers/delete-selected error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEMP TOOL — 2026-09-16 CSV bulk-cancel test (delete this whole block,
// down to the matching "TEMP TOOL END" marker, plus the "CSV cancel test"
// button in client/src/pages/buyer/BuyerTransfer.js and the file
// client/src/pages/buyer/CsvCancelTestTool.js, once this investigation is
// done — nothing else in the app depends on any of this).
//
// Context: Hera has ~100+ Shopify inventory transfers stuck IN_PROGRESS
// that need to be canceled with their committed inventory restored to the
// origin location. `inventoryTransferCancel` only works on DRAFT/
// READY_TO_SHIP transfers (per Shopify's merchant docs), but the Admin UI
// lets you get an IN_PROGRESS transfer back to READY_TO_SHIP by editing its
// shipment and zeroing out every line item's quantity first. This route
// reproduces that same sequence through the public GraphQL Admin API, one
// transfer number at a time, and reports exactly what happened at each
// step — it does NOT touch our own `transfers` DB table at all, since these
// are Shopify-only transfers Hera is investigating outside the Hub's own
// feature set (see claude/TRANSFER_FEATURE_SPEC.md 第 14 节 for the research
// that led here).
//
// Safety gates baked into testCancelOne():
//   - Only an EXACT match on Shopify's own transfer `name` field is used —
//     never a fuzzy/first-result match — so a loosely-matching search
//     result can never get processed under the wrong transfer's identity.
//   - A transfer whose current status isn't IN_PROGRESS is skipped
//     untouched (no zero, no cancel) — this tool never touches a Draft,
//     Ready to ship, already-Canceled, or already-Transferred transfer.
//   - The zero-out step only proceeds to Cancel if a re-fetch confirms the
//     status actually flipped to READY_TO_SHIP — if it didn't, the tool
//     stops there and reports it, rather than guessing and calling Cancel
//     anyway.
// ═══════════════════════════════════════════════════════════════════════════

// Best-effort zero-out of one shipment's still-unreceived line items —
// tries inventoryShipmentUpdateItemQuantities first; if Shopify rejects
// that (e.g. an INVALID_QUANTITY-style error), falls back to
// inventoryShipmentRemoveItems (flat id/lineItems args per the shopify.dev
// mutation reference — NOT the same shape as the other, unverified
// inventoryShipmentRemoveItems call in the /:id/edit route above; this one
// was checked against the docs directly for this tool).
//
// ⚠️ 2026-09-16: inventoryShipmentUpdateItemQuantities's args were
// originally (wrongly) assumed to be a single wrapped `input` object — this
// is what this temp tool's first real test run against Shopify caught
// ("Field 'inventoryShipmentUpdateItemQuantities' is missing required
// arguments: id"). Confirmed via the official mutation reference page that
// it actually takes flat `id`/`items` args, same pattern as the earlier
// inventoryTransferMarkAsReadyToShip bug (see section 10). Fixed here AND
// in the two other call sites that had the same wrong shape (the /:id/edit
// route and commitOne's mismatched-quantity branch) — see
// claude/TRANSFER_FEATURE_SPEC.md 第 14 节.
async function zeroShipmentLineItems(client, shipmentId, lineItems) {
  const updateMutation = `
    mutation inventoryShipmentUpdateItemQuantities($id: ID!, $items: [InventoryShipmentUpdateItemQuantitiesInput!], $idempotencyKey: String!) {
      inventoryShipmentUpdateItemQuantities(id: $id, items: $items) @idempotent(key: $idempotencyKey) {
        inventoryShipment { id }
        userErrors { field message }
      }
    }
  `;
  const updateData = await graphql(client, updateMutation, {
    id: shipmentId,
    items: lineItems.map(li => ({ shipmentLineItemId: li.id, quantity: 0 })),
    idempotencyKey: crypto.randomUUID(),
  });
  const updateErrors = updateData?.inventoryShipmentUpdateItemQuantities?.userErrors || [];
  if (updateErrors.length === 0) return { ok: true };

  const removeMutation = `
    mutation inventoryShipmentRemoveItems($id: ID!, $lineItems: [ID!]!, $idempotencyKey: String!) {
      inventoryShipmentRemoveItems(id: $id, lineItems: $lineItems) @idempotent(key: $idempotencyKey) {
        inventoryShipment { id }
        userErrors { field message }
      }
    }
  `;
  const removeData = await graphql(client, removeMutation, {
    id: shipmentId,
    lineItems: lineItems.map(li => li.id),
    idempotencyKey: crypto.randomUUID(),
  });
  const removeErrors = removeData?.inventoryShipmentRemoveItems?.userErrors || [];
  if (removeErrors.length === 0) return { ok: true };

  return {
    ok: false,
    error: `update failed (${updateErrors.map(e => e.message).join('; ')}); remove also failed (${removeErrors.map(e => e.message).join('; ')})`,
  };
}

// Runs the full test sequence for one Shopify transfer name (e.g. "T4955")
// and returns a plain result object describing exactly what happened at
// each step, never throwing — every failure mode is reported in the
// returned object so the caller can render one row per input name.
async function testCancelOne(client, name) {
  const result = {
    name, found: false, originalStatus: null,
    zeroStep: null, statusAfterZero: null, cancelStep: null, finalStatus: null, error: null,
  };
  try {
    const searchQuery = `
      query FindTransferByName($q: String!) {
        inventoryTransfers(first: 10, query: $q) {
          edges { node { id name status } }
        }
      }
    `;
    const searchData = await graphql(client, searchQuery, { q: name });
    const edges = searchData?.inventoryTransfers?.edges || [];
    // Exact match only — see safety-gate comment on the block above.
    const match = edges.find(e => e.node.name === name);
    if (!match) {
      result.error = 'Not found in Shopify (no exact name match)';
      return result;
    }
    result.found = true;
    const transferId = match.node.id;
    result.originalStatus = match.node.status;
    result.finalStatus = match.node.status;

    if (match.node.status !== 'IN_PROGRESS') {
      result.zeroStep = 'skipped — not IN_PROGRESS, left untouched';
      return result;
    }

    const detailQuery = `
      query TransferShipments($id: ID!) {
        inventoryTransfer(id: $id) {
          shipments(first: 20) {
            edges {
              node {
                id
                status
                lineItems(first: 100) {
                  edges { node { id unreceivedQuantity } }
                }
              }
            }
          }
        }
      }
    `;
    const detailData = await graphql(client, detailQuery, { id: transferId });
    const shipmentEdges = detailData?.inventoryTransfer?.shipments?.edges || [];

    let zeroedAny = false;
    const zeroErrors = [];
    for (const { node: shipment } of shipmentEdges) {
      if (shipment.status === 'RECEIVED') continue;
      const pending = (shipment.lineItems?.edges || [])
        .map(e => e.node)
        .filter(li => li.unreceivedQuantity > 0);
      if (pending.length === 0) continue;
      const zeroResult = await zeroShipmentLineItems(client, shipment.id, pending);
      if (zeroResult.ok) zeroedAny = true;
      else zeroErrors.push(`shipment ${shipment.id}: ${zeroResult.error}`);
    }

    if (zeroErrors.length > 0) result.zeroStep = `failed — ${zeroErrors.join(' | ')}`;
    else if (!zeroedAny) result.zeroStep = 'no unreceived shipment line items found (nothing to zero)';
    else result.zeroStep = 'ok';

    const statusQuery = `query CheckStatus($id: ID!) { inventoryTransfer(id: $id) { status } }`;
    const statusData = await graphql(client, statusQuery, { id: transferId });
    const statusAfterZero = statusData?.inventoryTransfer?.status;
    result.statusAfterZero = statusAfterZero;
    result.finalStatus = statusAfterZero;

    if (statusAfterZero !== 'READY_TO_SHIP') {
      result.cancelStep = 'skipped — status did not revert to READY_TO_SHIP';
      return result;
    }

    const cancelMutation = `
      mutation inventoryTransferCancel($id: ID!, $idempotencyKey: String!) {
        inventoryTransferCancel(id: $id) @idempotent(key: $idempotencyKey) {
          inventoryTransfer { id status }
          userErrors { field message }
        }
      }
    `;
    const cancelData = await graphql(client, cancelMutation, { id: transferId, idempotencyKey: crypto.randomUUID() });
    const cancelErrors = cancelData?.inventoryTransferCancel?.userErrors || [];
    if (cancelErrors.length > 0) {
      result.cancelStep = `failed — ${cancelErrors.map(e => e.message).join('; ')}`;
      return result;
    }
    result.cancelStep = 'ok';
    result.finalStatus = cancelData?.inventoryTransferCancel?.inventoryTransfer?.status || 'CANCELED';
    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

// POST /api/transfers/csv-cancel-test — body: { transferNumbers: string[] }.
// Processes sequentially with a short pause between each transfer (gentle
// on Shopify's rate limits across what could be hundreds of rows) and
// returns one result object per input name, in input order.
router.post('/csv-cancel-test', async (req, res) => {
  try {
    const raw = (req.body || {}).transferNumbers;
    const names = Array.isArray(raw)
      ? [...new Set(raw.map(n => String(n || '').trim()).filter(Boolean))]
      : [];
    if (names.length === 0) return res.status(400).json({ error: 'No transfer numbers provided' });

    const session = await getSession();
    if (!session) return res.status(401).json({ error: 'No session' });
    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const results = [];
    for (const name of names) {
      results.push(await testCancelOne(client, name));
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    res.json({ results });
  } catch (e) {
    console.error('POST /api/transfers/csv-cancel-test error:', e);
    res.status(500).json({ error: e.message });
  }
});
// ═══════════════════════════════════════════════════════════════════════════
// TEMP TOOL END
// ═══════════════════════════════════════════════════════════════════════════


module.exports = router;
