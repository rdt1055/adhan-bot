/* Builds data/sharh.jsonl + data/sharh-index.json from the Jawami' al-Kalim database (jawami.db).
   Runs once on your PC; the bot only ships the small output files, never the 4.6 GB database.

   Sources (commentary_book): 1 = Fath al-Bari (Ibn Hajar) for Bukhari, 2 = Sharh al-Nawawi for Muslim.
   Credit: Jawami' al-Kalim (Offok / Islamweb).

   WHY MATCHING BY TEXT: Jawami's hadith numbers are not our pool's numbers (e.g. our bukhari:5 is
   Jawami's 146_4). So every pairing is proven in two steps and anything unproven is dropped:
     1. text match: the Jawami hadith text must be (almost) the same hadith as our pool record, and
        clearly better than the runner-up;
     2. alignment audit: the sharh must talk about THAT hadith, not about its neighbour (compared
        against the hadith numbered -2..+2 in Jawami). If the audit shows a systematic problem the
        script refuses to write anything.
   The sharh text itself is never rewritten: only a leading volume header is removed, whitespace is
   collapsed, and an over-long sharh is cut at a clause end and marked as an excerpt.

   Usage: node scripts/build-sharh.js "C:\path\jawami.db" [--cap 3500] [--min-len 120]
                                       [--threshold 0.85] [--grades sahih|any] [--out-dir <folder>]

   GRADES: by default only hadiths that Jawami ALSO grades sahih (hadith.hokm = 0) are kept; a
   hadith with another grade, or no grade row at all, is dropped. This is a deliberately cautious
   extra filter on top of "it is in Sahih al-Bukhari / Sahih Muslim". Use --grades any to disable. */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { createPool } = require('../lib/hadith-pool');
const { splitText } = require('../lib/split-text');

/* -------- arguments -------- */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : fallback;
};
const dbPath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const CAP = Number(flag('--cap', 3500));            // max characters of sharh kept per hadith
const MIN_LEN = Number(flag('--min-len', 120));     // shorter sharh (e.g. "see above") are not worth a button
const THRESHOLD = Number(flag('--threshold', 0.85)); // text-match score needed (0..1)
const MARGIN = 0.03;                                // best must beat the runner-up by this much
const GRADES = flag('--grades', 'sahih');            // 'sahih' (default, cautious) or 'any'
const OUT_DIR = flag('--out-dir', path.join(__dirname, '..', 'data'));
const MAX_BAD_ALIGNMENT = 0.15;                     // abort when more than 15% of pairs fail the audit
const DF_LIMIT = 300;                               // words appearing in more hadiths than this are ignored for candidate search

if (!dbPath || !fs.existsSync(dbPath)) {
  console.error('Usage: node scripts/build-sharh.js "C:\\path\\to\\jawami.db"');
  process.exit(1);
}

/* -------- Arabic normalisation (used for MATCHING only, never for stored text) -------- */
const norm = (s) => String(s ?? '')
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/\u0671/g, 'ا').replace(/[أإآ]/g, 'ا')
  .replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[^\u0621-\u064A ]/g, ' ').replace(/\s+/g, ' ').trim();
const wordSet = (s, minLen = 2) => new Set(norm(s).split(' ').filter((w) => w.length >= minLen));
const dice = (a, b) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return (2 * hit) / (a.size + b.size);
};

const COLLECTIONS = {
  1: { key: 'bukhari', source: 'fath' },
  2: { key: 'muslim', source: 'nawawi' }
};

// Removes the program's volume header ("المجلد الأول ") and a leading dash; collapses whitespace
function cleanSharh(raw) {
  return String(raw ?? '')
    .replace(/\\/g, '')
    .replace(/^\s*المجلد\s+\S+(?:\s+عشر)?\s+/, '')
    .replace(/^[\s\-–]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function main() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const pool = createPool();
  const getText = db.prepare('SELECT clean_text FROM hadith_text WHERE bhid = ?');

  /* ---- 1. Jawami side: every sharh row that has a hadith text ---- */
  const rows = db.prepare('SELECT bhid, commentary_book cb, text FROM commentaries WHERE commentary_book IN (1,2)').all();
  const J = []; // { bhid, cb, num, sharh, words }
  const seen = new Map();
  let noText = 0;
  for (const r of rows) {
    const sharh = cleanSharh(r.text);
    const key = `${r.cb}|${r.bhid}`;
    const prev = seen.get(key);
    if (prev !== undefined) { if (sharh.length > J[prev].sharh.length) J[prev].sharh = sharh; continue; }
    const ht = getText.get(r.bhid)?.clean_text;
    if (!ht) { noText++; continue; }
    seen.set(key, J.length);
    J.push({ bhid: r.bhid, cb: r.cb, num: parseInt(r.bhid.split('_')[1], 10), sharh, words: wordSet(ht) });
  }
  console.log(`Jawami sharh rows: ${rows.length} | with a hadith text: ${J.length} | without (skipped): ${noText}`);

  // inverted index per collection: word -> [J indexes]
  const index = { 1: new Map(), 2: new Map() };
  J.forEach((j, i) => {
    for (const w of j.words) {
      const m = index[j.cb];
      if (!m.has(w)) m.set(w, []);
      m.get(w).push(i);
    }
  });
  const counts = new Int32Array(J.length);

  /* ---- 2. text match: our pool record -> Jawami hadith ---- */
  const matched = new Map(); // jIndex -> { id, score }
  const stats = { poolTotal: 0, noCandidate: 0, tooLowScore: 0, ambiguous: 0, matched: 0, lostToBetterPair: 0 };
  const histogram = new Array(11).fill(0); // best-score histogram, bucket = floor(score*10)

  for (const id of pool.ids()) {
    stats.poolTotal++;
    const rec = pool.get(id);
    const cb = rec.c === 'bukhari' ? 1 : 2;
    const ours = wordSet(rec.t);
    const touched = [];
    for (const w of ours) {
      const list = index[cb].get(w);
      if (!list || list.length > DF_LIMIT) continue;
      for (const ji of list) { if (counts[ji]++ === 0) touched.push(ji); }
    }
    if (touched.length === 0) { stats.noCandidate++; continue; }
    touched.sort((a, b) => counts[b] - counts[a]);
    const top = touched.slice(0, 8).map((ji) => ({ ji, score: dice(ours, J[ji].words) })).sort((a, b) => b.score - a.score);
    for (const ji of touched) counts[ji] = 0;

    const best = top[0];
    const second = top[1];
    histogram[Math.min(10, Math.floor(best.score * 10))]++;
    if (best.score < THRESHOLD) { stats.tooLowScore++; continue; }
    if (second && best.score - second.score < MARGIN) { stats.ambiguous++; continue; }

    const prev = matched.get(best.ji);
    if (prev) { // two pool records picked the same Jawami hadith: keep only the clearly better one
      if (best.score > prev.score + MARGIN) { matched.set(best.ji, { id, score: best.score }); }
      else if (Math.abs(best.score - prev.score) <= MARGIN) { matched.delete(best.ji); stats.ambiguous++; }
      stats.lostToBetterPair++;
      continue;
    }
    matched.set(best.ji, { id, score: best.score });
  }
  stats.matched = matched.size;
  console.log('\n== text matching ==');
  console.log(JSON.stringify(stats));
  console.log('best-score histogram (0.0-0.1 ... 1.0):', histogram.join(' '));

  /* ---- 3. alignment audit: does the sharh talk about THIS hadith, not a neighbour? ---- */
  const headWords = (s) => wordSet(s.slice(0, 1200), 3);
  const overlap = (S, H) => {
    if (!S.size) return 0;
    let hit = 0;
    for (const w of S) if (H.has(w)) hit++;
    return hit / S.size;
  };
  const audit = { checked: 0, ok: 0, neighbourBetter: 0, unverifiable: 0 };
  const winningOffset = {};
  const kept = [];
  for (const [ji, m] of matched) {
    const j = J[ji];
    const S = headWords(j.sharh);
    if (j.sharh.length < MIN_LEN) continue; // too short to be worth showing; also not auditable
    audit.checked++;
    const bookId = j.bhid.split('_')[0];
    const own = overlap(S, j.words);
    let bestOffset = 0, bestScore = own;
    for (const off of [-2, -1, 1, 2]) {
      const nt = getText.get(`${bookId}_${j.num + off}`)?.clean_text;
      if (!nt) continue;
      const sc = overlap(S, wordSet(nt));
      if (sc > bestScore + 0.03) { bestScore = sc; bestOffset = off; }
    }
    winningOffset[bestOffset] = (winningOffset[bestOffset] ?? 0) + 1;
    if (bestOffset !== 0) { audit.neighbourBetter++; continue; }
    if (own < 0.08) { audit.unverifiable++; continue; }
    audit.ok++;
    kept.push({ ji, id: m.id, score: m.score });
  }
  console.log('\n== alignment audit ==');
  console.log(JSON.stringify(audit));
  console.log('which Jawami number the sharh text fits best (0 = same number):', JSON.stringify(winningOffset));
  if (audit.checked === 0 || audit.neighbourBetter / audit.checked > MAX_BAD_ALIGNMENT) {
    console.error('\nABORTED: the sharh numbering does not line up with the hadith numbering in enough cases.');
    console.error('Nothing was written. Send this whole output to Claude so the mapping can be fixed.');
    process.exit(2);
  }

  /* ---- 3b. grade filter (Jawami hadith.hokm: 0 sahih, 1 hasan, 2 daif, 3 very daif, 4 accused, 5 fabricated) ---- */
  let finalKept = kept;
  if (GRADES === 'sahih') {
    // GLOB, not LIKE: in LIKE the underscore is a wildcard and would also pull in other books (1461_..., 1583_...)
    const gradeRows = db.prepare("SELECT bhid, hokm FROM hadith WHERE bhid GLOB '146_*' OR bhid GLOB '158_*'").all();
    const worst = new Map(); // bhid -> highest (worst) grade number among its rows; -1 = not graded
    for (const g of gradeRows) worst.set(g.bhid, Math.max(worst.get(g.bhid) ?? -1, g.hokm));
    const byGrade = {};
    finalKept = kept.filter((k) => {
      const g = worst.has(J[k.ji].bhid) ? worst.get(J[k.ji].bhid) : 'no-grade-row';
      byGrade[g] = (byGrade[g] ?? 0) + 1;
      return g === 0;
    });
    console.log('\n== Jawami grade of the hadiths we matched (only grade 0 = sahih is kept) ==');
    console.log(JSON.stringify(byGrade), `-> kept ${finalKept.length} of ${kept.length}`);
    if (finalKept.length === 0) { console.error('\nABORTED: no hadith would be left after the grade filter. Nothing was written.'); process.exit(3); }
  } else {
    console.log('\n(grade filter off: --grades any)');
  }

  /* ---- 4. write ---- */
  fs.mkdirSync(OUT_DIR, { recursive: true });
  finalKept.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const lines = [];
  const entries = [];
  const perCollection = { bukhari: 0, muslim: 0 };
  let offset = 0, truncated = 0;
  for (const k of finalKept) {
    const j = J[k.ji];
    const col = COLLECTIONS[j.cb];
    let text = j.sharh;
    let tr = false;
    if (text.length > CAP) { text = splitText(text, CAP)[0]; tr = true; truncated++; }
    const rec = { id: k.id, b: col.source, s: text, o: j.sharh.length, tr };
    const line = JSON.stringify(rec) + '\n';
    const length = Buffer.byteLength(line, 'utf8');
    entries.push([k.id, offset, length - 1]);
    lines.push(line);
    offset += length;
    perCollection[col.key]++;
  }
  const poolFile = path.join(OUT_DIR, 'sharh.jsonl');
  const indexFile = path.join(OUT_DIR, 'sharh-index.json');
  fs.writeFileSync(poolFile + '.tmp', lines.join(''));
  fs.writeFileSync(indexFile + '.tmp', JSON.stringify({
    version: 1, built: new Date().toISOString(),
    source: "Jawami' al-Kalim (Offok / Islamweb): Fath al-Bari, Sharh al-Nawawi ala Muslim",
    cap: CAP, count: entries.length, entries
  }));
  fs.renameSync(poolFile + '.tmp', poolFile);
  fs.renameSync(indexFile + '.tmp', indexFile);

  console.log(`\nWROTE ${entries.length} sharh (bukhari ${perCollection.bukhari}, muslim ${perCollection.muslim}) | ` +
    `${truncated} cut to ${CAP} chars | ${(offset / 1048576).toFixed(1)} MB -> ${path.relative(process.cwd(), poolFile)}`);

  console.log('\n== 8 spot checks: read these yourself ==');
  const step = Math.max(1, Math.floor(finalKept.length / 8));
  for (let i = 0; i < finalKept.length && i < step * 8; i += step) {
    const k = finalKept[i];
    console.log(`\n${k.id}  (match ${k.score.toFixed(2)})\n  hadith: ${pool.get(k.id).t.slice(0, 110)}\n  sharh : ${J[k.ji].sharh.slice(0, 140)}`);
  }
}

main();
