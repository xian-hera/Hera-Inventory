// Store › Transfers › History: tags + source in the snapshot (2026-11-09, Hera).
// History rows written before this kept no tags, so a transfer deleted later
// (e.g. an Online transfer deleted in Hub) showed no Online pill. Once:
//   1. rows whose transfer still exists get its tags / source copied in;
//   2. rows whose transfer is gone get the Online tag when Hub's messages to
//      Fulfiller (integration_outbox) name that Shopify transfer.
// Rows that already have `tags` are not touched. Called from initDatabase().
async function backfillHistoryTransferSnapshot(client) {
  await client.query(`
    UPDATE manager_history h
       SET detail = h.detail || jsonb_build_object('tags', to_jsonb(COALESCE(t.tags, '{}'::text[])), 'source', COALESCE(t.source, 'hub'))
      FROM transfers t
     WHERE h.kind LIKE 'transfer_%' AND t.transfer_no = h.ref_no AND NOT (h.detail ? 'tags')
  `);
  await client.query(`
    UPDATE manager_history h
       SET detail = h.detail || '{"tags": ["Online"], "source": "fulfiller"}'::jsonb
     WHERE h.kind LIKE 'transfer_%' AND NOT (h.detail ? 'tags')
       AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.transfer_no = h.ref_no)
       AND h.detail->>'shopify_transfer_name' IN (
         SELECT x->>'shopifyTransferName'
           FROM integration_outbox o,
                jsonb_array_elements(CASE WHEN jsonb_typeof(o.payload->'transfers') = 'array' THEN o.payload->'transfers'
                                          ELSE jsonb_build_array(o.payload) END) x
          WHERE x->>'shopifyTransferName' IS NOT NULL)
  `);
}

module.exports = { backfillHistoryTransferSnapshot };
