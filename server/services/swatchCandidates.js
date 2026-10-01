// Online › Swatch — stored "possible match" candidates (2026-10-01, Hera:
// the management list must read the database only, no work on page open).
//
// For every scanned vendor + colour code, the best file of the vendor's
// library (spec §5.5 rules) is stored in swatch_scan_codes.candidate_*.
// Recomputed when something that can change it happens: a scan finishes,
// images are added / renamed / deleted, a library is created / relinked /
// deleted, or "Refresh matches" is pressed.
const { pool } = require('../database/init');
const { Matcher, fileStem } = require('./swatchMatch');
const { getConfig } = require('./swatchStore');

async function makeMatcher(extraNames = []) {
  const cfg = await getConfig();
  const codes = await pool.query('SELECT DISTINCT code FROM swatch_scan_codes');
  const names = await pool.query('SELECT original_name FROM swatch_images');
  const m = new Matcher({ abbr: cfg.abbreviations });
  for (const r of codes.rows) m.addVocab(r.code);
  for (const r of names.rows) m.addVocab(fileStem(r.original_name));
  for (const n of extraNames) m.addVocab(fileStem(n));
  return m;
}

// libraryId = null -> every library (and clear rows whose vendor has none).
async function refreshCandidates(libraryId = null) {
  const started = Date.now();
  const libs = (await pool.query(
    'SELECT * FROM swatch_libraries WHERE ($1::int IS NULL OR id = $1)', [libraryId])).rows;
  if (libraryId === null) {
    await pool.query('UPDATE swatch_scan_codes SET candidate_image_id = NULL, candidate_kind = NULL, candidate_cost = NULL');
  }
  const m = await makeMatcher();
  let updated = 0;
  for (const lib of libs) {
    const files = (await pool.query('SELECT id, original_name FROM swatch_images WHERE library_id = $1 ORDER BY original_name', [lib.id]))
      .rows.map(i => ({ id: i.id, name: i.original_name, stems: [fileStem(i.original_name)] }));
    const rows = (await pool.query('SELECT vendor, code, code_key FROM swatch_scan_codes WHERE vendor = ANY($1)', [lib.vendors])).rows;
    const vendors = [], keys = [], ids = [], kinds = [], costs = [];
    for (const r of rows) {
      const best = files.length ? m.matchCode(r.code, files) : { best: null };
      vendors.push(r.vendor);
      keys.push(r.code_key);
      ids.push(best.best ? best.best.file.id : null);
      kinds.push(best.best ? best.status : null);
      costs.push(best.best ? best.best.cost : null);
    }
    if (rows.length) {
      await pool.query(`
        UPDATE swatch_scan_codes s SET candidate_image_id = u.id, candidate_kind = u.kind, candidate_cost = u.cost
        FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[]) AS u(vendor, code_key, id, kind, cost)
        WHERE s.vendor = u.vendor AND s.code_key = u.code_key`,
      [vendors, keys, ids, kinds, costs]);
      updated += rows.length;
    }
  }
  return { libraries: libs.length, codes: updated, ms: Date.now() - started };
}

// Fire-and-log helper for routes: a failure here must not fail the write.
async function tryRefresh(libraryId = null) {
  try {
    return await refreshCandidates(libraryId);
  } catch (e) {
    console.error('[swatch] refreshCandidates failed:', e);
    return null;
  }
}

module.exports = { makeMatcher, refreshCandidates, tryRefresh };
