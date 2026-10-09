// Purchasing user groups (2026-10-09, Hera) — mounted at /api/user-groups.
// Full description: claude/USER_GROUPS_FEATURE.md
//
// Rules (agreed with Hera):
//  * Settings → User Group defines groups; each group owns some product types;
//    one type belongs to at most one group (case-insensitive).
//  * A type that belongs to NO group is visible to every group.
//  * A task / PO / supplier / Transfer is visible to a group when ANY of its
//    types is not owned by another group (i.e. it is mine or unassigned), or
//    when it has no type at all. "ALL" (or no group chosen) sees everything.
//  * Transfers carry a TAG, not a type: Settings → Transfer → "Tag of Types"
//    (transfer_tag_types) says which types a tag stands for. A tag with no
//    mapping counts as unassigned (visible to all).
//  * This is a VIEW filter, not a permission: the current group travels in the
//    `X-User-Group` request header (a group id or 'ALL'), set by the frontend
//    (client/src/userGroup.js); users change it themselves. The account →
//    group memory (account_groups) only exists so a new device / wiped
//    browser storage still knows the choice.

const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { getAccountId } = require('../accountAuth');

const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();

async function loadGroups(db = pool) {
  const r = await db.query('SELECT id, name, types FROM user_groups ORDER BY LOWER(name) ASC, id ASC');
  return r.rows;
}

async function loadTagTypes(db = pool) {
  const r = await db.query('SELECT id, tag, types FROM transfer_tag_types ORDER BY LOWER(tag) ASC, id ASC');
  return r.rows;
}

// What the current request may NOT see. Returns null when nothing is filtered
// (no header, 'ALL', unknown / deleted group id) — callers then skip their
// extra condition entirely, so behaviour is exactly the same as before this
// feature. Otherwise { groupId, blockedTypes, hiddenTags } (all lower-case):
//   blockedTypes = types owned by OTHER groups
//   hiddenTags   = Transfer tags whose mapped types are ALL blocked
async function getGroupFilter(req) {
  try {
    const raw = String((req && req.headers && req.headers['x-user-group']) || '').trim();
    if (!raw || raw.toUpperCase() === 'ALL') return null;
    const id = parseInt(raw, 10);
    if (!id) return null;
    const groups = await loadGroups();
    const mine = groups.find((g) => g.id === id);
    if (!mine) return null;
    const blocked = new Set();
    groups.filter((g) => g.id !== id).forEach((g) => (g.types || []).forEach((t) => blocked.add(lc(t))));
    (mine.types || []).forEach((t) => blocked.delete(lc(t)));
    const tagTypes = await loadTagTypes();
    const hiddenTags = tagTypes
      .filter((r) => (r.types || []).length > 0 && r.types.every((t) => blocked.has(lc(t))))
      .map((r) => lc(r.tag));
    return { groupId: id, blockedTypes: [...blocked], hiddenTags };
  } catch (e) {
    // A problem here must never hide the lists — fall back to "no filter".
    console.error('[user-groups] getGroupFilter failed:', e.message);
    return null;
  }
}

// SQL: a text[] column is visible when it is empty / NULL, or has at least
// one element that is not in the blocked list. $n = text[] of lower-case
// blocked values (blockedTypes for type columns, hiddenTags for the tags column).
function arrayVisibleSql(col, paramIdx) {
  return `(COALESCE(cardinality(${col}), 0) = 0 OR EXISTS (SELECT 1 FROM unnest(${col}) AS _gt(x) WHERE LOWER(TRIM(_gt.x)) <> ALL($${paramIdx}::text[])))`;
}

// SQL: a single text column (e.g. stock_losses.product_type).
function scalarVisibleSql(col, paramIdx) {
  return `(${col} IS NULL OR TRIM(${col}) = '' OR LOWER(TRIM(${col})) <> ALL($${paramIdx}::text[]))`;
}

// ── GET /api/user-groups → { groups: [{ id, name, types }] } ────────────────
router.get('/', async (req, res) => {
  try {
    res.json({ groups: await loadGroups() });
  } catch (e) {
    console.error('GET /api/user-groups error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/user-groups/context ─────────────────────────────────────────────
// For the frontend dropdowns: what the CURRENT group (X-User-Group header)
// may not see. → { active, blockedTypes, hiddenTags }
router.get('/context', async (req, res) => {
  try {
    const f = await getGroupFilter(req);
    if (!f) return res.json({ active: false, blockedTypes: [], hiddenTags: [] });
    res.json({ active: true, blockedTypes: f.blockedTypes, hiddenTags: f.hiddenTags });
  } catch (e) {
    console.error('GET /api/user-groups/context error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/user-groups  Body: { groups: [{ id?, name, types: [] }] } ──────
// Settings → User Group → card Save. The list REPLACES the stored groups:
// rows with an id are updated, rows without are created, stored groups missing
// from the list are deleted (and every account that had picked one is reset).
router.put('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const input = Array.isArray(req.body && req.body.groups) ? req.body.groups : null;
    if (!input) return res.status(400).json({ error: 'groups required' });

    const cleaned = [];
    const seenNames = new Set();
    const seenTypes = new Map(); // lower type -> group name
    for (const g of input) {
      const name = String((g && g.name) || '').trim();
      if (!name) return res.status(400).json({ error: 'Group name is required.' });
      if (name.length > 64) return res.status(400).json({ error: 'Group name is too long.' });
      if (seenNames.has(lc(name))) return res.status(400).json({ error: `Group name "${name}" is used twice.` });
      seenNames.add(lc(name));
      const types = [];
      const typeSeen = new Set();
      for (const t of Array.isArray(g.types) ? g.types : []) {
        const tt = String(t || '').trim();
        if (!tt || typeSeen.has(lc(tt))) continue;
        typeSeen.add(lc(tt));
        types.push(tt);
      }
      if (types.length === 0) return res.status(400).json({ error: `Group "${name}" needs at least one type.` });
      for (const t of types) {
        if (seenTypes.has(lc(t))) {
          return res.status(400).json({ error: `Type "${t}" is in both "${seenTypes.get(lc(t))}" and "${name}". A type can belong to only one group.` });
        }
        seenTypes.set(lc(t), name);
      }
      cleaned.push({ id: g.id ? parseInt(g.id, 10) : null, name, types });
    }

    await client.query('BEGIN');
    const existing = await loadGroups(client);
    const keepIds = new Set(cleaned.filter((g) => g.id).map((g) => g.id));
    const removed = existing.filter((g) => !keepIds.has(g.id)).map((g) => g.id);

    if (removed.length) {
      await client.query('DELETE FROM user_groups WHERE id = ANY($1::int[])', [removed]);
      await client.query('DELETE FROM account_groups WHERE choice = ANY($1::text[])', [removed.map(String)]);
    }
    // Two-step rename safety: the unique index is on LOWER(name), so move every
    // updated group to a temporary unique name first (a swap of two names would
    // otherwise collide mid-way).
    for (const g of cleaned.filter((x) => x.id && existing.some((e) => e.id === x.id))) {
      await client.query('UPDATE user_groups SET name = $1 WHERE id = $2', [`__tmp_${g.id}_${Date.now()}`, g.id]);
    }
    for (const g of cleaned) {
      if (g.id && existing.some((e) => e.id === g.id)) {
        await client.query('UPDATE user_groups SET name = $1, types = $2 WHERE id = $3', [g.name, g.types, g.id]);
      } else {
        await client.query('INSERT INTO user_groups (name, types) VALUES ($1, $2)', [g.name, g.types]);
      }
    }
    await client.query('COMMIT');
    res.json({ groups: await loadGroups() });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('PUT /api/user-groups error:', e);
    if (e && e.code === '23505') return res.status(400).json({ error: 'Group names must be unique.' });
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Account memory: which group this Shopify account picked ─────────────────
// Like routes/accountMemory.js these never answer 401 (client/src/index.js
// turns a 401 { reauth } into a full-page OAuth redirect) — an unidentified
// request just gets { identified: false } and the frontend falls back to
// localStorage.

// GET /api/user-groups/my → { identified, choice } ; choice = 'ALL' | <group id as number> | null
router.get('/my', async (req, res) => {
  try {
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, choice: null });
    const r = await pool.query('SELECT choice FROM account_groups WHERE account_id = $1', [accountId]);
    const raw = r.rows[0] && r.rows[0].choice;
    if (!raw) return res.json({ identified: true, choice: null });
    if (raw === 'ALL') return res.json({ identified: true, choice: 'ALL' });
    const id = parseInt(raw, 10);
    const groups = await loadGroups();
    if (id && groups.some((g) => g.id === id)) return res.json({ identified: true, choice: id });
    // The group was deleted: forget it so the account picks again.
    await pool.query('DELETE FROM account_groups WHERE account_id = $1', [accountId]);
    res.json({ identified: true, choice: null });
  } catch (e) {
    console.error('GET /api/user-groups/my error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/user-groups/my  Body: { choice: 'ALL' | <group id> }
router.put('/my', async (req, res) => {
  try {
    const rawChoice = req.body && req.body.choice;
    let choice;
    if (String(rawChoice).toUpperCase() === 'ALL') {
      choice = 'ALL';
    } else {
      const id = parseInt(rawChoice, 10);
      const groups = await loadGroups();
      if (!id || !groups.some((g) => g.id === id)) return res.status(400).json({ error: 'Unknown group' });
      choice = String(id);
    }
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, success: false });
    await pool.query(
      `INSERT INTO account_groups (account_id, choice, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (account_id) DO UPDATE SET choice = EXCLUDED.choice, updated_at = NOW()`,
      [accountId, choice]
    );
    res.json({ identified: true, success: true });
  } catch (e) {
    console.error('PUT /api/user-groups/my error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/user-groups/my — "Reset my group"
router.delete('/my', async (req, res) => {
  try {
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, success: false });
    await pool.query('DELETE FROM account_groups WHERE account_id = $1', [accountId]);
    res.json({ identified: true, success: true });
  } catch (e) {
    console.error('DELETE /api/user-groups/my error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.getGroupFilter = getGroupFilter;
module.exports.arrayVisibleSql = arrayVisibleSql;
module.exports.scalarVisibleSql = scalarVisibleSql;
