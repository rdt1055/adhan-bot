/* Read-only probe of the Jawami' al-Kalim SQLite file (jawami.db). Changes nothing.
   Answers: how many Bukhari/Muslim hadiths have a sharh, how long it is, and whether the numbering
   matches our hadith pool.   Usage: node scripts/probe-sharh.js path/to/jawami.db > probe-report.txt */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { createPool } = require('../lib/hadith-pool');

const dbPath = process.argv[2];
if (!dbPath || !fs.existsSync(dbPath)) { console.error('Usage: node scripts/probe-sharh.js path/to/jawami.db'); process.exit(1); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const strip = (s) => String(s ?? '').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[^\u0621-\u064A ]/g, ' ').replace(/\s+/g, ' ').trim();
const all = (sql, ...p) => db.prepare(sql).all(...p);

console.log('== commentaries columns ==');
const cols = all('PRAGMA table_info(commentaries)');
console.log(cols.map((c) => `${c.name} (${c.type})`).join(', '));
console.log('\n== rows per commentary_book ==');
console.log(JSON.stringify(all('SELECT commentary_book, COUNT(*) n FROM commentaries GROUP BY commentary_book')));

const textCol = cols.map((c) => c.name).filter((n) => !/^(id|bhid|commentary_book)$/i.test(n))
  .map((n) => ({ n, avg: all(`SELECT AVG(LENGTH(${n})) a FROM commentaries`)[0].a ?? 0 })).sort((a, b) => b.avg - a.avg)[0];
console.log(`\nlikely text column: ${textCol?.n} (avg ${Math.round(textCol?.avg)} chars)`);

console.log('\n== books named Bukhari / Muslim ==');
const books = all("SELECT book_id, name FROM books WHERE name LIKE '%صحيح البخاري%' OR name LIKE '%صحيح مسلم%'");
console.log(JSON.stringify(books));

console.log('\n== length distribution of sharh text (chars) per commentary_book ==');
for (const b of all('SELECT DISTINCT commentary_book b FROM commentaries')) {
  const lens = all(`SELECT LENGTH(${textCol.n}) l FROM commentaries WHERE commentary_book=? ORDER BY l`, b.b).map((r) => r.l);
  const q = (p) => lens[Math.floor((lens.length - 1) * p)];
  console.log(`book ${b.b}: n=${lens.length} min=${q(0)} p25=${q(.25)} median=${q(.5)} p75=${q(.75)} p95=${q(.95)} max=${q(1)}`);
}

console.log('\n== numbering check against our pool (text match, diacritics ignored) ==');
const pool = createPool();
const rows = all('SELECT bhid, commentary_book FROM commentaries WHERE commentary_book IN (1,2)');
const stats = { 1: { total: 0, inPool: 0, textMatch: 0, miss: [] }, 2: { total: 0, inPool: 0, textMatch: 0, miss: [] } };
const getText = db.prepare('SELECT clean_text FROM hadith_text WHERE bhid = ?');
const fuzzyKey = (s) => strip(s).split(' ').slice(-8).join(' '); // tail of the hadith = the matn end, safest anchor
for (const { bhid, commentary_book: cb } of rows) {
  const s = stats[cb]; s.total++;
  const [bookId, num] = bhid.split('_');
  const id = `${cb === 1 ? 'bukhari' : 'muslim'}:${num}`;
  if (!pool.has(id)) continue;
  s.inPool++;
  const jt = getText.get(bhid)?.clean_text;
  const ours = pool.get(id)?.t;
  if (jt && ours && strip(ours).includes(fuzzyKey(jt)) ) s.textMatch++;
  else if (s.miss.length < 5) s.miss.push({ bhid, id });
}
console.log(JSON.stringify(stats, null, 1));
console.log('(Muslim numbering may differ: if textMatch is low for book 2, we map by text instead of by number.)');

console.log('\n== 3 sample sharh (first 400 chars) ==');
for (const r of all(`SELECT bhid, commentary_book, ${textCol.n} t FROM commentaries WHERE commentary_book IN (1,2) LIMIT 3`)) {
  console.log(`--- ${r.bhid} (book ${r.commentary_book})\n${String(r.t).slice(0, 400)}`);
}
