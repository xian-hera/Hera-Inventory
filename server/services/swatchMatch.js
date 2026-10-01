// Online › Swatch — file name ↔ colour code matching (spec §5.5).
// Port of the matcher used for the 2026-09-30 / 10-01 comparison tables
// (Swatch_色号比对表_v3.xlsx), so the Hub gives the same answers.
//
//   score(code, fileStem, vocab) -> null            no match
//                                -> { cost: 0 }     exact match (完全匹配)
//                                -> { cost: n }     possible match, n abbreviations (可能匹配)
//
// Rules (Hera 2026-09-30):
//   A. digits must match one-to-one, order free ("27/613" == "27613")
//   B. separators (space / _ - . or none) are ignored
//   fixed abbreviations (ABBR) count as the full word; "H" before BLONDE = HONEY
//   single letters are never abbreviations; an extra / missing word = no match
//   possible match only for spelling differences or truncated words.

const DEFAULT_ABBR = {
  BU: 'BURGUNDY', BLU: 'BLUE', PUR: 'PURPLE', VIO: 'VIOLET', BRN: 'BROWN',
  MAC: 'MACCHIATO', BURG: 'BURGUNDY', OM: 'OMBRE', PIN: 'PINK', VV: 'VELVET',
  BG: 'BURGUNDY', HI: 'HIGH',
};

const IMG_EXT = /\.(jpe?g|png|webp|gif)$/i;

// "#TT/AUT/PINK" -> "TT/AUT/PINK" (spec §5.3: trim, drop a leading # or @, upper case)
function codeKey(code) {
  return String(code || '').trim().replace(/^[#@]+/, '').trim().toUpperCase();
}

// File name -> stem used for matching: drop (repeated) image extensions and a
// trailing " (2)" copy suffix. "TT_AUTUMN_PINK.jpg.jpg" -> "TT_AUTUMN_PINK".
function fileStem(name) {
  let stem = String(name || '').split(/[\\/]/).pop();
  while (IMG_EXT.test(stem)) stem = stem.replace(IMG_EXT, '');
  return stem.replace(/\s*\(\d+\)$/, '');
}

function rawParts(x) {
  const s = String(x || '').toUpperCase().replace(/^[#@]+/, '').trim();
  const out = [];
  for (const part of s.split(/[^A-Z0-9]+/)) {
    if (!part) continue;
    for (const m of part.match(/[A-Z]+|\d+/g) || []) out.push(m);
  }
  return out;
}

class Matcher {
  constructor({ abbr = DEFAULT_ABBR, vocabSources = [] } = {}) {
    this.abbr = abbr;
    this.vocab = new Set();
    for (const src of vocabSources) this.addVocab(src);
    this._parseCache = new Map();
  }

  // Words (≥2 letters) seen in any code or file name. Used to recognise glued
  // abbreviations (REDVV = RED + VELVET) and compound words (REDWINE).
  addVocab(text) {
    for (const m of rawParts(text)) {
      if (/^\d+$/.test(m)) continue;
      const w = this.abbr[m] || m;
      if (w.length >= 2) this.vocab.add(w);
    }
    this._parseCache && this._parseCache.clear();
  }

  splitGlued(m) {
    if (!this.vocab.size) return [m];
    for (const [k, full] of Object.entries(this.abbr)) {
      if (m.endsWith(k) && m.length - k.length >= 3 && this.vocab.has(m.slice(0, -k.length))) return [m.slice(0, -k.length), full];
      if (m.startsWith(k) && m.length - k.length >= 3 && this.vocab.has(m.slice(k.length))) return [full, m.slice(k.length)];
    }
    return [m];
  }

  parse(x) {
    const hit = this._parseCache.get(x);
    if (hit) return hit;
    let toks = [];
    const nums = [];
    for (const m of rawParts(x)) {
      if (/^\d+$/.test(m)) nums.push(m);
      else if (this.abbr[m]) toks.push(this.abbr[m]);
      else toks.push(...this.splitGlued(m));
    }
    // single "H" means HONEY only in H/BLONDE (Hera 2026-09-30)
    toks = toks.map((t, i) => (t === 'H' && toks[i + 1] === 'BLONDE' ? 'HONEY' : t));
    const r = { toks, nums };
    this._parseCache.set(x, r);
    return r;
  }

  static numsOk(a, b) {
    const sa = [...a].sort().join(','), sb = [...b].sort().join(',');
    return sa === sb || a.join('') === b.join('');
  }

  static subseq(a, b) {
    let i = 0;
    for (const ch of b) if (i < a.length && ch === a[i]) i++;
    return i === a.length;
  }

  abbrOk(short, long) {
    if (short.length < 2 || short.length >= long.length || short[0] !== long[0]) return false;
    if (long.length <= 3) return false; // codes of ≤3 letters must be identical (FL/FTL, TT/TTN)
    if (long.startsWith(short)) {
      const rem = long.slice(short.length);
      if (rem.length === 1) return short.length >= 4 || 'EY'.includes(rem);
      if (this.vocab.has(rem)) return false; // compound word, e.g. RED + WINE
      for (const w of this.vocab) if (w.length >= 4 && rem.includes(w)) return false;
      return rem.length <= 4;
    }
    if (long.length - short.length > 3) return false; // non-prefix: only small spelling differences
    if (!Matcher.subseq(short, long)) return false;
    return short[short.length - 1] === long[long.length - 1] && short.length / long.length >= 0.5;
  }

  // Minimum number of abbreviations needed to align the two word lists one
  // to one (a word may also equal two glued words on the other side), or null.
  align(A, B) {
    const memo = new Map();
    const go = (i, j) => {
      if (i === A.length && j === B.length) return 0;
      const key = i * 1000 + j;
      if (memo.has(key)) return memo.get(key);
      let best = null;
      for (let i2 = i + 1; i2 <= A.length; i2++) {
        for (let j2 = j + 1; j2 <= B.length; j2++) {
          if (i2 - i > 1 && j2 - j > 1) continue;
          const a = A.slice(i, i2).join(''), b = B.slice(j, j2).join('');
          let cost;
          if (a === b) cost = 0;
          else if (i2 - i === 1 && j2 - j === 1 && (this.abbrOk(a, b) || this.abbrOk(b, a))) cost = 1;
          else continue;
          const r = go(i2, j2);
          if (r !== null && (best === null || r + cost < best)) best = r + cost;
        }
      }
      memo.set(key, best);
      return best;
    };
    return go(0, 0);
  }

  static rawLetters(x) {
    return String(x || '').toUpperCase().replace(/^[#@]+/, '').replace(/[^A-Z]/g, '');
  }

  // code: "#TT/AUT/PINK"; stems: one or more file stems for the same file.
  score(code, stems) {
    const v = this.parse(code);
    let best = null;
    for (const st of [].concat(stems)) {
      const f = this.parse(st);
      if (!f.toks.length && !f.nums.length) continue;
      if (!Matcher.numsOk(v.nums, f.nums)) continue;
      if (v.toks.join('') === f.toks.join('') || Matcher.rawLetters(code) === Matcher.rawLetters(st)) return { cost: 0 };
      const c = this.align(v.toks, f.toks);
      if (c !== null && (best === null || c < best.cost)) best = { cost: c };
    }
    return best;
  }

  // Best files for one code. files: [{ id, stems:[...] }] -> { status, best, others }
  //   status: 'exact' | 'possible' | 'none'
  matchCode(code, files) {
    const scored = [];
    for (const f of files) {
      const s = this.score(code, f.stems);
      if (s) scored.push({ file: f, cost: s.cost });
    }
    const nameOf = x => String(x.file.name || x.file.id);
    scored.sort((a, b) => a.cost - b.cost || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
    if (!scored.length) return { status: 'none', best: null, others: [] };
    const exact = scored.filter(x => x.cost === 0);
    if (exact.length) return { status: 'exact', best: exact[0], others: exact.slice(1) };
    return { status: 'possible', best: scored[0], others: scored.slice(1) };
  }
}

module.exports = { Matcher, DEFAULT_ABBR, codeKey, fileStem };
