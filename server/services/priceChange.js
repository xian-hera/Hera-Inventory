// Price Change — scheduled price changes in Shopify + store label tasks
// (2026-10-08, Hera). Spec: claude/PRICE_CHANGE_SCHEDULE_REVERSE_SPEC.md
//
// Life of a task (price_change_tasks.status):
//   scheduled → applying → applied → active (published to stores) → archived
//                       ↘ failed (nothing could be changed)
//   - "applying": Hub reads every item's CURRENT values in Shopify, records
//     them (old_*), and writes the new Price / Compare-at / Discontinued.
//   - "applied": changes are live; the task is published to the stores
//     10 minutes later (publish_at) so the new prices have settled.
//   - "active": stores see it (Label print → Price Change Tasks).
//   - "archived": every store location marked it Done; kept 30 days.
// A Reverse is its own task (reverse_of = original id), created when the
// original is applied and scheduled for the reverse time; when it runs it
// restores the values recorded by the original — only for items still
// carrying the values the original set (changed by hand → skipped).
const { pool } = require('../database/init');
const { gql, userErrorText, searchQuote } = require('./shopifyGql');
const { getSetting, setSetting } = require('./productData');

const TIMEZONE = 'America/Toronto';
const PUBLISH_DELAY_MIN = 10;
const MIN_LEAD_MIN = 5;          // a scheduled time must be at least this far ahead
const MIN_REVERSE_GAP_MIN = 15;  // reverse at least this long after the change
const TASK_TYPES = ['regular', 'promotion', 'discontinued'];
const SETTINGS_KEY = 'price_change_settings';
const STATUS_FILTER = '(product_status:active OR product_status:draft)';

// ─── Settings ────────────────────────────────────────────────────────────────
// { hiddenTypes: [], rules: [{ id, types: [], percent, cents }], keepExistingCompareAt: false,
//   emptyRules: [{ id, types: [], namespace, key }] }
// emptyRules (2026-10-09, Hera — "Empty Metafields for Discontinued"):
// variant metafields deleted (set to null) when a Discontinued task runs,
// for SKUs of the listed types.
async function getSettings() {
  const v = (await getSetting(SETTINGS_KEY, {})) || {};
  return {
    hiddenTypes: Array.isArray(v.hiddenTypes) ? v.hiddenTypes.map(String) : [],
    rules: Array.isArray(v.rules) ? v.rules : [],
    keepExistingCompareAt: v.keepExistingCompareAt === true,
    emptyRules: Array.isArray(v.emptyRules) ? v.emptyRules : [],
  };
}
// Discontinued tasks always write these two themselves — never emptied.
const RESERVED_METAFIELDS = ['custom.discontinued', 'custom.name'];
// Variant metafields to empty for one product type: [{ namespace, key }].
function emptyMetafieldsForType(emptyRules, productType) {
  const t = lc(productType);
  const out = new Map();
  for (const r of emptyRules || []) {
    if (!(r.types || []).some(x => lc(x) === t)) continue;
    const id = `${r.namespace}.${r.key}`;
    if (RESERVED_METAFIELDS.includes(id.toLowerCase())) continue;
    out.set(id, { namespace: r.namespace, key: r.key });
  }
  return [...out.values()];
}
async function saveSettings(s) {
  await setSetting(SETTINGS_KEY, s);
  return getSettings();
}
const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
function ruleForType(rules, productType) {
  const t = lc(productType);
  return (rules || []).find(r => (r.types || []).some(x => lc(x) === t)) || null;
}

// ─── Money ───────────────────────────────────────────────────────────────────
const toCents = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const fromCents = (c) => (c === null || c === undefined ? null : (c / 100).toFixed(2));
const sameMoney = (a, b) => toCents(a) === toCents(b);

// Discontinued rule: price − percent, then the cents are raised to the set
// value, carrying to the next dollar when needed (always up).
//   8.99, 40%, 99 → 5.394 → 5.39 → 5.99;   5.60 with 49 → 6.49.
function applyRule(price, rule) {
  const cur = toCents(price);
  if (cur === null) return null;
  const reduced = Math.floor((cur * (100 - Number(rule.percent))) / 100 + 1e-9);
  const cents = Math.max(0, Math.min(99, parseInt(rule.cents, 10) || 0));
  let v = Math.floor(reduced / 100) * 100 + cents;
  if (v < reduced) v += 100;
  return fromCents(v);
}

// ─── Time (Eastern) ──────────────────────────────────────────────────────────
function tzOffsetMs(date, tz = TIMEZONE) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
// 'YYYY-MM-DD' + 'HH:MM' in Toronto → Date (UTC instant). null if invalid.
function torontoToDate(ymd, hm) {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  const m2 = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  if (!m1 || !m2) return null;
  const base = Date.UTC(+m1[1], +m1[2] - 1, +m1[3], +m2[1], +m2[2]);
  let guess = base;
  for (let i = 0; i < 3; i++) guess = base - tzOffsetMs(new Date(guess));
  return new Date(guess);
}

// ─── Shopify lookups ─────────────────────────────────────────────────────────
// Exact SKU → variants (Active + Draft). Map sku → [variant].
async function findBySku(skus) {
  const out = new Map();
  const list = [...new Set(skus.map(s => String(s || '').trim()).filter(Boolean))];
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    const parts = chunk.map((s, j) =>
      `a${j}: productVariants(first: 10, query: ${JSON.stringify(`sku:${searchQuote(s)} AND ${STATUS_FILTER}`)}) {
        nodes { id sku title price compareAtPrice barcode
          name: metafield(namespace: "custom", key: "name") { value }
          product { id title productType status } }
      }`).join('\n');
    const data = await gql(`{ ${parts} }`);
    chunk.forEach((s, j) => {
      const nodes = ((data[`a${j}`] && data[`a${j}`].nodes) || [])
        .filter(n => n.product && n.product.status !== 'ARCHIVED')
        .filter(n => String(n.sku || '').trim() === s); // search is token based — exact only
      out.set(s, nodes);
    });
  }
  return out;
}

// Current state of variants by id. Map id → { sku, price, compareAt, discontinued, productId, productType }.
async function variantState(ids) {
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 50) {
    const data = await gql(
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant {
        id sku price compareAtPrice
        discontinued: metafield(namespace: "custom", key: "discontinued") { value }
        customName: metafield(namespace: "custom", key: "name") { value type }
        product { id productType status }
      } } }`,
      { ids: list.slice(i, i + 50) }
    );
    for (const n of data.nodes || []) {
      if (!n || !n.id || !n.product) continue;
      out.set(n.id, {
        sku: String(n.sku || '').trim(), price: n.price, compareAt: n.compareAtPrice,
        discontinued: n.discontinued ? n.discontinued.value : null,
        name: n.customName ? n.customName.value : null,
        nameType: n.customName ? n.customName.type : null,
        productId: n.product.id, productType: n.product.productType, status: n.product.status,
      });
    }
  }
  return out;
}

// Discontinued tasks also mark the variant's custom.name (2026-10-09, Hera):
//   empty → no change; already has "@" → no change;
//   has "#" → the "#" becomes "@"; several "#" next to each other ("##",
//   "###") become ONE "@" ("ABC ##123" → "ABC @123"). Names only ever have
//   one such group; if there were more, the last group is the one replaced.
//   otherwise "@" goes right before the first space, or at the end if none.
// Returns the new name, or null when nothing changes.
function discontinuedName(name) {
  const s = name == null ? '' : String(name);
  if (!s.trim() || s.includes('@')) return null;
  if (s.includes('#')) return s.replace(/#+(?=[^#]*$)/, '@');
  const sp = s.indexOf(' ');
  return sp >= 0 ? `${s.slice(0, sp)}@${s.slice(sp)}` : `${s}@`;
}

const variantName = (v) => {
  const custom = v.name && String(v.name.value || '').trim();
  if (custom) return custom;
  const vt = String(v.title || '').trim();
  return vt && vt !== 'Default Title' ? `${v.product.title} — ${vt}` : v.product.title;
};

// ─── Process (Upload CSV step) ───────────────────────────────────────────────
// rows: [{ row, sku, price }] (price '' / undefined = not given)
// → { items: [...], skipped: [{ row, sku, reason }] }
async function processRows({ productTypes, taskType, rows }) {
  const settings = await getSettings();
  const wanted = new Set((productTypes || []).map(lc));
  const skipped = [];
  const seen = new Map();
  const candidates = [];
  for (const r of rows || []) {
    const sku = String(r.sku || '').trim();
    if (!sku) continue;
    if (sku.includes('�')) { skipped.push({ row: r.row, sku, reason: 'SKU contains an unreadable character (�)' }); continue; }
    if (seen.has(sku)) { skipped.push({ row: r.row, sku, reason: `Duplicate SKU (also row ${seen.get(sku)})` }); continue; }
    seen.set(sku, r.row);
    const raw = r.price == null ? '' : String(r.price).trim();
    let csvPrice = null;
    if (raw !== '') {
      const c = toCents(raw);
      if (c === null || c < 0) { skipped.push({ row: r.row, sku, reason: `Price "${raw}" is not a valid price` }); continue; }
      csvPrice = fromCents(c);
    }
    candidates.push({ row: r.row, sku, csvPrice });
  }

  const found = await findBySku(candidates.map(c => c.sku));
  const items = [];
  for (const c of candidates) {
    const list = found.get(c.sku) || [];
    if (!list.length) { skipped.push({ row: c.row, sku: c.sku, reason: 'SKU not found in Shopify' }); continue; }
    if (list.length > 1) { skipped.push({ row: c.row, sku: c.sku, reason: `SKU matches ${list.length} variants` }); continue; }
    const v = list[0];
    const type = v.product.productType || '';
    if (!wanted.has(lc(type))) { skipped.push({ row: c.row, sku: c.sku, reason: `Type "${type || 'none'}" is not selected` }); continue; }
    let rule = null;
    if (c.csvPrice === null) {
      rule = taskType === 'discontinued' ? ruleForType(settings.rules, type) : null;
      if (!rule) {
        skipped.push({ row: c.row, sku: c.sku, reason: taskType === 'discontinued' ? `No price, and no Discontinued rule for "${type}"` : 'No price' });
        continue;
      }
    }
    items.push({
      row: c.row, sku: c.sku, variantId: v.id, productId: v.product.id, productType: type,
      name: variantName(v), barcode: v.barcode || '', csvPrice: c.csvPrice, currentPrice: v.price,
      rule: rule ? { percent: rule.percent, cents: rule.cents } : null,
    });
  }
  skipped.sort((a, b) => (a.row || 0) - (b.row || 0));
  return { items, skipped };
}

// ─── Task numbers ────────────────────────────────────────────────────────────
async function nextTaskNo(client) {
  const res = await client.query('SELECT last_number FROM price_change_counter WHERE id = 1 FOR UPDATE');
  const next = (res.rows[0] ? res.rows[0].last_number : 0) + 1;
  await client.query('UPDATE price_change_counter SET last_number = $1 WHERE id = 1', [next]);
  return String(next).padStart(6, '0');
}

// ─── Apply ───────────────────────────────────────────────────────────────────
async function writeVariants(byProduct) {
  // byProduct: Map productId → [{ itemId, input }] ; returns Map itemId → error
  const errors = new Map();
  for (const [pid, list] of byProduct) {
    try {
      const data = await gql(
        `mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $pid, variants: $v) { productVariants { id } userErrors { field message } }
        }`,
        { pid, v: list.map(x => x.input) }
      );
      const msg = userErrorText(data.productVariantsBulkUpdate);
      if (msg) list.forEach(x => errors.set(x.itemId, msg));
    } catch (e) {
      list.forEach(x => errors.set(x.itemId, e.message));
    }
  }
  return errors;
}

async function writeDiscontinued(sets, deletes) {
  // sets: [{ itemId, variantId, value }], deletes: [{ itemId, variantId }]
  const errors = new Map();
  for (let i = 0; i < sets.length; i += 25) {
    const batch = sets.slice(i, i + 25);
    try {
      const data = await gql(
        `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } } }`,
        { m: batch.map(b => ({ ownerId: b.variantId, namespace: 'custom', key: 'discontinued', type: 'boolean', value: b.value })) }
      );
      const msg = userErrorText(data.metafieldsSet);
      if (msg) batch.forEach(b => errors.set(b.itemId, `Discontinued not set — ${msg}`));
    } catch (e) {
      batch.forEach(b => errors.set(b.itemId, `Discontinued not set — ${e.message}`));
    }
  }
  for (let i = 0; i < deletes.length; i += 25) {
    const batch = deletes.slice(i, i + 25);
    try {
      const data = await gql(
        `mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { field message } } }`,
        { m: batch.map(b => ({ ownerId: b.variantId, namespace: 'custom', key: 'discontinued' })) }
      );
      const msg = userErrorText(data.metafieldsDelete);
      if (msg) batch.forEach(b => errors.set(b.itemId, `Discontinued not restored — ${msg}`));
    } catch (e) {
      batch.forEach(b => errors.set(b.itemId, `Discontinued not restored — ${e.message}`));
    }
  }
  return errors;
}

async function clearMetafields(dels) {
  // dels: [{ itemId, variantId, namespace, key }] — Empty Metafields rules
  const errors = new Map();
  for (let i = 0; i < dels.length; i += 25) {
    const batch = dels.slice(i, i + 25);
    try {
      const data = await gql(
        `mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { field message } } }`,
        { m: batch.map(b => ({ ownerId: b.variantId, namespace: b.namespace, key: b.key })) }
      );
      const msg = userErrorText(data.metafieldsDelete);
      if (msg) batch.forEach(b => errors.set(b.itemId, `Metafield not emptied — ${msg}`));
    } catch (e) {
      batch.forEach(b => errors.set(b.itemId, `Metafield not emptied — ${e.message}`));
    }
  }
  return errors;
}

async function writeNames(sets) {
  // sets: [{ itemId, variantId, value, type }] — custom.name (Discontinued)
  const errors = new Map();
  for (let i = 0; i < sets.length; i += 25) {
    const batch = sets.slice(i, i + 25);
    try {
      const data = await gql(
        `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } } }`,
        { m: batch.map(b => ({ ownerId: b.variantId, namespace: 'custom', key: 'name', type: b.type || 'single_line_text_field', value: b.value })) }
      );
      const msg = userErrorText(data.metafieldsSet);
      if (msg) batch.forEach(b => errors.set(b.itemId, `Name not changed — ${msg}`));
    } catch (e) {
      batch.forEach(b => errors.set(b.itemId, `Name not changed — ${e.message}`));
    }
  }
  return errors;
}

// price / compare_at_price are the store-facing columns of the original
// (hand-made) table — their type may be NUMERIC, so they get their own
// parameters ($10, $11) instead of sharing the TEXT ones.
const setItem = (id, f) => pool.query(
  `UPDATE price_change_items SET old_price = $2, old_compare_at = $3, old_discontinued = $4, set_discontinued = $5,
     new_price = $6, new_compare_at = $7, apply_status = $8, apply_note = $9,
     price = COALESCE($10, price), compare_at_price = $11,
     old_name = $12, new_name = $13,
     name = CASE WHEN $8 = 'done' AND $14 THEN $13 ELSE name END,
     applied_at = CASE WHEN $8 = 'writing' THEN applied_at ELSE NOW() END
   WHERE id = $1`,
  [id, f.oldPrice ?? null, f.oldCompareAt ?? null, f.oldDiscontinued ?? null, !!f.setDiscontinued,
    f.newPrice ?? null, f.newCompareAt ?? null, f.status, f.note ?? null,
    f.newPrice ?? null, f.newCompareAt ?? null,
    // custom.name (Discontinued): old_name / new_name; the item's display
    // name follows the new name once it is written ($14).
    f.oldName ?? null, f.newName ?? null, !!(f.newName && f.nameWritten)]
);
const skipItem = (id, note) => pool.query(
  `UPDATE price_change_items SET apply_status = 'skipped', apply_note = $2, applied_at = NOW() WHERE id = $1`, [id, note]
);

async function applyTask(taskId) {
  const task = (await pool.query('SELECT * FROM price_change_tasks WHERE id = $1', [taskId])).rows[0];
  if (!task) return;
  const settings = await getSettings();
  // 'writing' = values were recorded but the run stopped before it could
  // confirm the Shopify write (server restart) — checked below, never
  // computed twice.
  const items = (await pool.query(
    `SELECT * FROM price_change_items WHERE task_id = $1 AND (apply_status IS NULL OR apply_status IN ('pending', 'writing')) ORDER BY id`, [taskId]
  )).rows;
  const state = await variantState(items.map(i => i.variant_id));
  const originals = new Map();
  if (task.reverse_of) {
    const r = await pool.query('SELECT * FROM price_change_items WHERE task_id = $1', [task.reverse_of]);
    r.rows.forEach(x => originals.set(x.id, x));
  }

  const byProduct = new Map();
  const metaSet = [];
  const metaDel = [];
  const nameSet = [];
  const clearList = []; // Empty Metafields for Discontinued
  const queueClears = (it, cur) => {
    for (const m of emptyMetafieldsForType(settings.emptyRules, cur.productType)) {
      clearList.push({ itemId: it.id, variantId: it.variant_id, namespace: m.namespace, key: m.key });
    }
  };
  const planned = new Map(); // itemId → fields

  for (const it of items) {
    const cur = state.get(it.variant_id);
    if (!cur || cur.sku !== String(it.sku || '').trim()) { await skipItem(it.id, 'SKU no longer found in Shopify'); continue; }
    let f;
    if (it.apply_status === 'writing') {
      const recorded = {
        oldPrice: it.old_price, oldCompareAt: it.old_compare_at, oldDiscontinued: it.old_discontinued,
        newPrice: it.new_price, newCompareAt: it.new_compare_at, setDiscontinued: it.set_discontinued,
        oldName: it.old_name, newName: it.new_name,
      };
      const isNew = sameMoney(cur.price, it.new_price) && (toCents(cur.compareAt) || null) === (toCents(it.new_compare_at) || null);
      const isOld = sameMoney(cur.price, it.old_price) && (toCents(cur.compareAt) || null) === (toCents(it.old_compare_at) || null);
      // The name is only written if it still has the value read the first time.
      const nameLeft = !!it.new_name && (cur.name || null) === (it.old_name || null);
      if (isNew && !nameLeft) {
        await setItem(it.id, { ...recorded, status: 'done', nameWritten: !!it.new_name && cur.name === it.new_name });
        // Emptying is safe to repeat — make sure it happened.
        if (task.task_type === 'discontinued' && !task.reverse_of) queueClears(it, cur);
        continue;
      }
      if (!isNew && !isOld) { await skipItem(it.id, 'Changed in Shopify while the price change was running — not changed'); continue; }
      // write again with the values recorded the first time (price already
      // done → only the name is left)
      f = isNew ? { ...recorded, priceDone: true } : recorded;
      if (!nameLeft) f.newName = it.new_name && cur.name === it.new_name ? it.new_name : null;
    } else if (!task.reverse_of) {
      let newPrice = it.csv_price;
      if (newPrice == null || newPrice === '') {
        const rule = task.task_type === 'discontinued' ? ruleForType(settings.rules, cur.productType) : null;
        if (!rule) { await skipItem(it.id, 'No price, and no Discontinued rule for this type'); continue; }
        newPrice = applyRule(cur.price, rule);
      }
      let newCompareAt = cur.compareAt;
      if (task.task_type === 'promotion' || task.task_type === 'discontinued') {
        const hasCompare = toCents(cur.compareAt) !== null && toCents(cur.compareAt) > 0;
        newCompareAt = settings.keepExistingCompareAt && hasCompare ? cur.compareAt : cur.price;
      }
      f = {
        oldPrice: cur.price, oldCompareAt: cur.compareAt, oldDiscontinued: cur.discontinued,
        newPrice: fromCents(toCents(newPrice)), newCompareAt: newCompareAt == null ? null : fromCents(toCents(newCompareAt)),
        setDiscontinued: task.task_type === 'discontinued',
        oldName: cur.name, newName: task.task_type === 'discontinued' ? discontinuedName(cur.name) : null,
      };
    } else {
      // Reverse: restore what the original recorded, if nobody changed it since.
      const o = originals.get(it.source_item_id);
      if (!o || o.apply_status !== 'done') { await skipItem(it.id, 'Not changed by the original task'); continue; }
      const untouched = sameMoney(cur.price, o.new_price)
        && (toCents(cur.compareAt) || null) === (toCents(o.new_compare_at) || null)
        && (!o.set_discontinued || String(cur.discontinued) === 'true');
      if (!untouched) { await skipItem(it.id, 'Changed in Shopify since the price change — not reversed'); continue; }
      f = {
        oldPrice: cur.price, oldCompareAt: cur.compareAt, oldDiscontinued: cur.discontinued,
        newPrice: o.old_price, newCompareAt: o.old_compare_at, setDiscontinued: false,
        restoreDiscontinued: o.set_discontinued, restoreValue: o.old_discontinued,
      };
    }
    planned.set(it.id, f);
    // Record before writing, so a restart can tell what was meant.
    await setItem(it.id, { ...f, status: 'writing' });
    const input = { id: it.variant_id, price: f.newPrice, compareAtPrice: f.newCompareAt == null ? null : f.newCompareAt };
    if (!f.priceDone) {
      if (!byProduct.has(cur.productId)) byProduct.set(cur.productId, []);
      byProduct.get(cur.productId).push({ itemId: it.id, input });
    }
    if (f.setDiscontinued) metaSet.push({ itemId: it.id, variantId: it.variant_id, value: 'true' });
    // Reverse never touches custom.name (Hera 2026-10-09); f.newName is
    // only set by a Discontinued change.
    if (f.newName && cur.name !== f.newName) nameSet.push({ itemId: it.id, variantId: it.variant_id, value: f.newName, type: cur.nameType });
    if (f.setDiscontinued && task.task_type === 'discontinued' && !task.reverse_of) queueClears(it, cur);
    if (f.restoreDiscontinued) {
      if (f.restoreValue == null) metaDel.push({ itemId: it.id, variantId: it.variant_id });
      else metaSet.push({ itemId: it.id, variantId: it.variant_id, value: String(f.restoreValue) });
    }
  }

  const priceErrors = await writeVariants(byProduct);
  // Discontinued only for variants whose price write worked.
  const metaErrors = await writeDiscontinued(
    metaSet.filter(m => !priceErrors.has(m.itemId)), metaDel.filter(m => !priceErrors.has(m.itemId))
  );
  const nameErrors = await writeNames(nameSet.filter(m => !priceErrors.has(m.itemId)));
  // Only emptied for SKUs whose price change worked. The emptied fields are
  // not listed on the item (Hera); only a failure is noted.
  const clearErrors = await clearMetafields(clearList.filter(m => !priceErrors.has(m.itemId)));
  for (const [id, msg] of clearErrors) {
    if (!planned.has(id)) await pool.query(`UPDATE price_change_items SET apply_note = $2 WHERE id = $1`, [id, msg]);
  }
  for (const [id, f] of planned) {
    if (priceErrors.has(id)) await setItem(id, { ...f, status: 'failed', note: `Not changed — ${priceErrors.get(id)}` });
    else {
      const note = [metaErrors.get(id), nameErrors.get(id), clearErrors.get(id)].filter(Boolean).join(' · ') || null;
      // A name that could not be written is not recorded as the new name.
      const nameFailed = nameErrors.has(id);
      await setItem(id, { ...f, newName: nameFailed ? null : f.newName, status: 'done', note, nameWritten: !!f.newName && !nameFailed });
    }
  }

  const done = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM price_change_items WHERE task_id = $1 AND apply_status = 'done'`, [taskId]
  )).rows[0].n;
  if (!done) {
    await pool.query(`UPDATE price_change_tasks SET status = 'failed', applied_at = NOW(), error = $2 WHERE id = $1`,
      [taskId, 'Nothing was changed — see the items']);
    return;
  }
  await pool.query(
    `UPDATE price_change_tasks SET status = 'applied', applied_at = NOW(),
       publish_at = NOW() + make_interval(mins => $2::int), error = NULL WHERE id = $1`,
    [taskId, PUBLISH_DELAY_MIN]
  );
  // Reverse is offered for Promotion only (2026-10-09, Hera); a reverse
  // already scheduled on another type before that still runs.
  if (!task.reverse_of && task.reverse_at && !task.reverse_task_id) await createReverseTask(task);
}

async function createReverseTask(task) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taskNo = await nextTaskNo(client);
    const r = await client.query(
      // The note is carried over to the reverse task (2026-10-09, Hera).
      `INSERT INTO price_change_tasks (task_no, note, locations, status, task_type, product_types, scheduled_at, reverse_of)
       VALUES ($1, $7, $2, 'scheduled', $3, $4, $5, $6) RETURNING id`,
      [taskNo, task.locations, task.reverse_task_type || task.task_type, task.product_types, task.reverse_at, task.id, task.note || null]
    );
    const id = r.rows[0].id;
    await client.query(
      `INSERT INTO price_change_items (task_id, sku, name, barcode, variant_id, product_id, product_type, source_item_id)
       SELECT $1, sku, name, barcode, variant_id, product_id, product_type, id
       FROM price_change_items WHERE task_id = $2 AND apply_status = 'done' ORDER BY id`,
      [id, task.id]
    );
    await client.query('UPDATE price_change_tasks SET reverse_task_id = $2 WHERE id = $1', [task.id, id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[price-change] could not create reverse task:', e.message);
  } finally {
    client.release();
  }
}

// Store tasks: one location row per location and part ('main' = everything
// but WIG, 'wig' = WIG items), only for parts that have items.
async function publishTask(taskId) {
  const t = (await pool.query(
    `UPDATE price_change_tasks SET status = 'active', published_at = NOW()
     WHERE id = $1 AND status = 'applied' RETURNING id, locations`, [taskId]
  )).rows[0];
  if (!t) return;
  const parts = (await pool.query(
    `SELECT DISTINCT CASE WHEN LOWER(COALESCE(product_type, '')) = 'wig' THEN 'wig' ELSE 'main' END AS part
     FROM price_change_items WHERE task_id = $1 AND (apply_status IS NULL OR apply_status = 'done')`, [taskId]
  )).rows.map(r => r.part);
  for (const loc of t.locations || []) {
    for (const part of parts) {
      await pool.query(
        `INSERT INTO price_change_location_status (task_id, location, status, part) VALUES ($1, $2, 'pending', $3)`,
        [taskId, loc, part]
      );
    }
  }
}

// ─── Runner (called every minute and on demand) ─────────────────────────────
let running = false;
let again = false;
async function runDue() {
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      // Resume anything interrupted (server restart) — finished items are skipped.
      const stuck = await pool.query(`SELECT id FROM price_change_tasks WHERE status = 'applying'`);
      for (const r of stuck.rows) await safeApply(r.id);
      const due = await pool.query(
        `UPDATE price_change_tasks SET status = 'applying'
         WHERE id IN (SELECT id FROM price_change_tasks WHERE status = 'scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at, id)
         RETURNING id`
      );
      for (const r of due.rows.sort((a, b) => a.id - b.id)) await safeApply(r.id);
      const pub = await pool.query(`SELECT id FROM price_change_tasks WHERE status = 'applied' AND publish_at <= NOW() ORDER BY id`);
      for (const r of pub.rows) await publishTask(r.id).catch(e => console.error('[price-change] publish failed:', e.message));
    } while (again);
  } catch (e) {
    console.error('[price-change] runner failed:', e.message);
  } finally {
    running = false;
  }
}
async function safeApply(id) {
  try {
    await applyTask(id);
  } catch (e) {
    // Shopify unreachable etc. — back to scheduled, retried next minute.
    console.error(`[price-change] apply ${id} failed:`, e.message);
    await pool.query(`UPDATE price_change_tasks SET status = 'scheduled', error = $2 WHERE id = $1 AND status = 'applying'`, [id, e.message]).catch(() => {});
  }
}

module.exports = {
  TIMEZONE, PUBLISH_DELAY_MIN, MIN_LEAD_MIN, MIN_REVERSE_GAP_MIN, TASK_TYPES,
  getSettings, saveSettings, ruleForType, applyRule, toCents, fromCents, torontoToDate,
  findBySku, variantState, processRows, discontinuedName, emptyMetafieldsForType, RESERVED_METAFIELDS, nextTaskNo, applyTask, publishTask, runDue,
};
