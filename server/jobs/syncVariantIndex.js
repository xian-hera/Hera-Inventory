const { pool } = require('../database/init');

// Tracks whether a sync is currently running, to prevent overlapping runs.
let isSyncing = false;
let lastSyncedAt = null;
let lastSyncCount = null;
let schedulerTimer = null;

async function syncVariantIndex() {
  if (isSyncing) {
    console.log('[syncVariantIndex] Already running, skipping.');
    return { skipped: true };
  }
  isSyncing = true;
  console.log('[syncVariantIndex] Starting sync...');
  const startedAt = Date.now();

  try {
    const { getShopify, getSession } = require('../shopify');
    const session = await getSession();
    if (!session) {
      console.error('[syncVariantIndex] No session, aborting.');
      isSyncing = false;
      return { error: 'No session' };
    }

    const shopify = getShopify();
    const client = new shopify.clients.Graphql({ session });

    const gqlQuery = `
      query getVariants($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id sku barcode
              metafield(namespace: "custom", key: "name") { value }
              product {
                id title productType vendor
              }
            }
          }
        }
      }
    `;

    let cursor = null;
    let hasNextPage = true;
    let total = 0;

    while (hasNextPage) {
      const response = await client.request(gqlQuery, { variables: { cursor } });
      const page = response?.data?.productVariants;
      if (!page) break;

      const edges = page.edges;
      hasNextPage = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;

      for (const { node: v } of edges) {
        await pool.query(
          `INSERT INTO variant_search_index
             (shopify_variant_id, shopify_product_id, sku, barcode,
              custom_name, product_title, product_type, vendor, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (shopify_variant_id) DO UPDATE SET
             shopify_product_id = EXCLUDED.shopify_product_id,
             sku                = EXCLUDED.sku,
             barcode            = EXCLUDED.barcode,
             custom_name        = EXCLUDED.custom_name,
             product_title      = EXCLUDED.product_title,
             product_type       = EXCLUDED.product_type,
             vendor             = EXCLUDED.vendor,
             synced_at          = NOW()`,
          [
            v.id,
            v.product.id,
            v.sku || null,
            v.barcode || null,
            v.metafield?.value || null,
            v.product.title || null,
            v.product.productType || null,
            v.product.vendor || null,
          ]
        );
        total++;
      }

      // Polite delay to avoid Shopify rate limiting
      if (hasNextPage) await new Promise(r => setTimeout(r, 500));
    }

    // Remove variants that were not touched in this sync run (deleted from Shopify)
    const deleted = await pool.query(
      `DELETE FROM variant_search_index WHERE synced_at < NOW() - INTERVAL '1 hour'`
    );

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    lastSyncedAt = new Date().toISOString();
    lastSyncCount = total;
    console.log(`[syncVariantIndex] Done. Upserted ${total} variants, removed ${deleted.rowCount} stale rows. (${elapsed}s)`);
    return { total, removed: deleted.rowCount, elapsed };
  } catch (e) {
    console.error('[syncVariantIndex] Error:', e.message);
    return { error: e.message };
  } finally {
    isSyncing = false;
  }
}

// Read interval from app_settings, default to 12 hours
async function getSyncIntervalHours() {
  try {
    const res = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'variant_sync_interval_hours'`
    );
    if (res.rows.length > 0) {
      const val = parseInt(res.rows[0].value);
      if (!isNaN(val) && val >= 1) return val;
    }
  } catch (e) {
    console.error('[syncVariantIndex] Failed to read interval setting:', e.message);
  }
  return 12;
}

// Start the scheduler. Runs once immediately (unless skipInitialSync is true),
// then on the configured interval.
// Calling startSyncScheduler again cancels the previous timer and restarts with the new interval.
async function startSyncScheduler({ skipInitialSync = false } = {}) {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  const intervalHours = await getSyncIntervalHours();
  const intervalMs = intervalHours * 60 * 60 * 1000;

  console.log(`[syncVariantIndex] Scheduler started. Interval: ${intervalHours}h`);

  if (!skipInitialSync) {
    syncVariantIndex().catch(e => console.error('[syncVariantIndex] Initial sync error:', e));
  }

  const scheduleNext = () => {
    schedulerTimer = setTimeout(async () => {
      await syncVariantIndex().catch(e => console.error('[syncVariantIndex] Scheduled sync error:', e));
      scheduleNext();
    }, intervalMs);
  };

  scheduleNext();
}

function getSyncStatus() {
  return {
    isSyncing,
    lastSyncedAt,
    lastSyncCount,
  };
}

module.exports = { syncVariantIndex, startSyncScheduler, getSyncStatus };