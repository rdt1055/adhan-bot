/* Read-only check #2: does Jawami's hadith number point at the SAME hadith as ours?
   Compares the words of each hadith (diacritics/spelling normalised) and also measures how big the
   sharh file would be at different excerpt caps.
   Usage: node scripts/probe-numbering.js "C:\path\jawami.db" 2>&1 | Out-File -Encoding utf8 probe-report-2.txt */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const { createPool } = require('../lib/hadith-pool');

const dbPath = process.argv[2];
if (!dbPath || !fs.existsSync(dbPath)) { console.error('File not found: ' + dbPath); process.exit(1); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const pool = createPool();

const norm = (s) => String(s ?? '')
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/\u0671/g, 'ا').replace(/[أإآ]/g, 'ا')
  .replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[^\u0621-\u064A ]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1));

const getText = db.prepare('SELECT clean_text FROM hadith_text WHERE bhid = ?');
const rows = db.prepare('SELECT bhid, hadith_num, commentary_book cb, text FROM commentaries WHERE commentary_book IN (1,2)').all();
const CAPS = [1500, 2500, 4000];

const res = {};
for (const key of ['bukhari', 'muslim']) res[key] = { sharhRows: 0, inPoolByNumber: 0, noJawamiText: 0, strong: 0, partial: 0, weak: 0, bytesFull: 0, bytesCap: CAPS.map(() => 0), weakExamples: [], goodExamples: [] };

for (const r of rows) {
  const key = r.cb === 1 ? 'bukhari' : 'muslim';
  const s = res[key]; s.sharhRows++;
  const rec = pool.has(`${key}:${r.hadith_num}`) ? pool.get(`${key}:${r.hadith_num}`) : null;
  if (!rec) continue;
  s.inPoolByNumber++;
  s.bytesFull += Buffer.byteLength(r.text, 'utf8');
  CAPS.forEach((c, i) => { s.bytesCap[i] += Buffer.byteLength(r.text.slice(0, c), 'utf8'); });

  const jt = getText.get(r.bhid)?.clean_text;
  if (!jt) { s.noJawamiText++; continue; }
  const jw = words(jt), ow = words(rec.t);
  let hit = 0; for (const w of jw) if (ow.has(w)) hit++;
  const overlap = jw.size ? hit / jw.size : 0;
  if (overlap >= 0.8) { s.strong++; if (s.goodExamples.length < 2) s.goodExamples.push(r.bhid); }
  else if (overlap >= 0.5) s.partial++;
  else {
    s.weak++;
    if (s.weakExamples.length < 4) s.weakExamples.push({ bhid: r.bhid, overlap: +overlap.toFixed(2), jawami: norm(jt).slice(0, 110), ours: norm(rec.t).slice(0, 110) });
  }
}

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
for (const [key, s] of Object.entries(res)) {
  console.log(`\n== ${key} ==`);
  console.log(`sharh rows: ${s.sharhRows} | match a hadith in our pool by number: ${s.inPoolByNumber} | no Jawami text found: ${s.noJawamiText}`);
  console.log(`same-hadith check (word overlap): strong(>=80%)=${s.strong} partial(50-80%)=${s.partial} weak(<50%)=${s.weak}`);
  console.log(`sharh size for those rows: full ${mb(s.bytesFull)} | cap ${CAPS.map((c, i) => `${c} chars: ${mb(s.bytesCap[i])}`).join(' | ')}`);
  if (s.weakExamples.length) console.log('weak examples:\n' + JSON.stringify(s.weakExamples, null, 1));
}
const junk = db.prepare("SELECT COUNT(*) n FROM commentaries WHERE commentary_book IN (1,2) AND text LIKE 'المجلد%'").get().n;
console.log(`\nsharh rows starting with a volume header ("المجلد ..."): ${junk}`);

/* Gradings Jawami holds for the two Sahihs (hadith.hokm: 0 sahih, 1 hasan, 2 daif, 3 very daif, 4 accused, 5 fabricated, -1 not graded) */
try {
  console.log('\n== Jawami grading (hadith.hokm) per collection ==');
  for (const [label, prefix] of [['bukhari', '146_*'], ['muslim', '158_*']]) {
    const g = db.prepare('SELECT hokm, COUNT(*) n FROM hadith WHERE bhid GLOB ? GROUP BY hokm ORDER BY hokm').all(prefix);
    console.log(label + ': ' + JSON.stringify(g));
  }
} catch (err) { console.log('grading check skipped: ' + err.message); }
