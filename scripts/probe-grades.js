/* Read-only: finds hadiths in OUR pool that Jawami grades hasan / weak / fabricated, and shows why.
   Usage (cmd): node scripts/probe-grades.js "C:\path\jawami.db" > probe-grades.txt 2>&1 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const { createPool } = require('../lib/hadith-pool');

const dbPath = process.argv[2];
if (!dbPath || !fs.existsSync(dbPath)) { console.error('Usage: node scripts/probe-grades.js "C:\\path\\jawami.db"'); process.exit(1); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const pool = createPool();
const LABEL = { 0: 'صحيح', 1: 'حسن', 2: 'ضعيف', 3: 'ضعيف جدا', 4: 'متهم', 5: 'موضوع' };

const norm = (s) => String(s ?? '').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/\u0671/g, 'ا').replace(/[أإآ]/g, 'ا')
  .replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[^\u0621-\u064A ]/g, ' ').replace(/\s+/g, ' ').trim();
const wordSet = (s) => new Set(norm(s).split(' ').filter((w) => w.length >= 2));
const dice = (a, b) => { let h = 0; for (const w of a) if (b.has(w)) h++; return a.size && b.size ? (2 * h) / (a.size + b.size) : 0; };

console.log('loading pool...');
const poolSets = pool.ids().map((id) => { const r = pool.get(id); return { id, rec: r, words: wordSet(r.t) }; });
const getText = db.prepare('SELECT clean_text FROM hadith_text WHERE bhid = ?');

// per-narration reasoning, if the tables exist: sanad rows of that bhid + hokm_text by sanad_id
function reasoning(bhid) {
  const out = [];
  try {
    const sanads = db.prepare('SELECT * FROM sanad WHERE bhid = ? LIMIT 3').all(bhid);
    for (const s of sanads) {
      const ht = (() => { try { return db.prepare('SELECT * FROM hokm_text WHERE id = ?').get(s.sanad_id); } catch { return null; } })();
      const textCol = ht ? Object.keys(ht).find((k) => k !== 'id' && typeof ht[k] === 'string') : null;
      out.push(`   sanad ${s.sanad_id}: hokm=${s.hokm} ${ht && textCol ? '| reasoning: ' + String(ht[textCol]).replace(/\s+/g, ' ').slice(0, 350) : '| (no written reasoning)'}`);
    }
  } catch (err) { out.push('   (sanad lookup skipped: ' + err.message + ')'); }
  return out;
}

for (const [label, prefix] of [['bukhari', '146_*'], ['muslim', '158_*']]) {
  for (const hokm of [1, 2, 3, 4, 5]) {
    const cands = db.prepare('SELECT bhid FROM hadith WHERE bhid GLOB ? AND hokm = ? LIMIT 400').all(prefix, hokm);
    if (!cands.length) continue;
    console.log(`\n=========== ${label} | Jawami grade ${hokm} (${LABEL[hokm]}) | ${cands.length}+ rows ===========`);
    let shown = 0;
    for (const { bhid } of cands) {
      if (shown >= 2) break;
      const jt = getText.get(bhid)?.clean_text;
      if (!jt) continue;
      const jw = wordSet(jt);
      let best = null;
      for (const p of poolSets) {
        if (p.rec.c !== label) continue;
        const sc = dice(jw, p.words);
        if (!best || sc > best.sc) best = { sc, p };
      }
      if (!best || best.sc < 0.85) continue; // keep only ones that really are in our pool
      shown++;
      const r = best.p.rec;
      console.log(`\n* Jawami ${bhid} = OUR POOL ${r.id} | citation number to check on sunnah.com: ${label} ${r.r} | match ${best.sc.toFixed(2)}`);
      console.log('  text: ' + r.t.slice(0, 160));
      for (const line of reasoning(bhid)) console.log(line);
    }
    if (shown === 0) console.log('(none of the first 400 rows matched a hadith in our pool)');
  }
}
