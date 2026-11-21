/* Verifies (and builds) the data for the Nakhtim feature. Read-only toward the bot: it only writes
   nakhtim-report.txt in the project root and, when every check passes, data/quran.json and
   data/tafsir-muyassar.json.

   Fail-safe rule: anything that cannot be proven is a FAIL and no data files are written.
   Primary Quran text (alquran.cloud quran-uthmani) is never altered mid-text: it is only trimmed and its 112
   prepended surah Bismillahs are stripped so every ayah matches Hafs numbering (1:1 is kept as Bismillah);
   the surah-introduction block that the Muyassar edition glues onto the opening ayah(s) of each surah is SPLIT OFF (not edited) and stored apart.

   Usage (cmd, from the project folder):
     node scripts/verify-nakhtim-data.js                 text + tafsir (about 1-2 minutes)
     node scripts/verify-nakhtim-data.js --audio         + per-ayah audio, 3 reciters x 6,236 files (several minutes, resumable)
     node scripts/verify-nakhtim-data.js --fullsurah     + full-surah audio from mp3quran.net
     node scripts/verify-nakhtim-data.js --pdf           + 114 Hafs surah PDFs + 30 Ajza' + full Medina Mushaf PDF
     node scripts/verify-nakhtim-data.js --images        + 6,236 high-res ayah Mushaf PNGs (resumable)
     node scripts/verify-nakhtim-data.js --all           everything
   Options: --text-b=fawaz-uthmani (default) | fawaz-nodiacritics (cross-check source)
            --tafsir-b=alquran-cloud (default) | none */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const REPORT_FILE = path.join(ROOT, 'nakhtim-report.txt');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const DO_ALL = has('all');
const DO_AUDIO = DO_ALL || has('audio');
const DO_FULL = DO_ALL || has('fullsurah');
const DO_PDF = DO_ALL || has('pdf');
const DO_IMAGES = DO_ALL || has('images');

/* ---------------- configuration ---------------- */
const FAWAZ_QURAN = [
  'https://raw.githubusercontent.com/fawazahmed0/quran-api/1',
  'https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1'
];
const TAFSIR_BASES = [
  'https://raw.githubusercontent.com/spa5k/tafsir_api/main/tafsir/ar-tafsir-muyassar',
  'https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/ar-tafsir-muyassar'
];
const ALQURAN_CLOUD = process.env.NAKHTIM_ALQURAN_BASE || 'https://api.alquran.cloud/v1';
const EVERYAYAH = process.env.NAKHTIM_EVERYAYAH_BASE || 'https://everyayah.com/data';
const MP3QURAN_API = process.env.NAKHTIM_MP3QURAN_API || 'https://www.mp3quran.net/api/v3';
const PDF_QURAN_PAGE = process.env.NAKHTIM_PDF_PAGE || 'https://www.pdfquran.com/standard1/chapters/';
const AYAH_IMAGES_BASE = process.env.NAKHTIM_IMAGES_BASE || 'https://cdn.islamic.network/quran/images/high-resolution';
const ARCHIVE_AJZA_ID = '01_20200522_20200522';
const ARCHIVE_FULL_MUSHAF_URL = 'https://archive.org/download/MushafMadinaHafsGreen1441/MushafMadinaHafsGreen1441.pdf';

// Folder names on everyayah.com. The script confirms each one exists before the big run.
const RECITERS = [
  { key: 'alafasy', name: 'مشاري العفاسي', folder: 'Alafasy_128kbps', fullSurahName: /العفاسي/ },
  { key: 'ghamdi', name: 'سعد الغامدي', folder: 'Ghamadi_40kbps', fullSurahName: /الغامدي/ },
  { key: 'husary', name: 'محمود خليل الحصري', folder: 'Husary_128kbps', fullSurahName: /الحصري/ }
];
const DISCORD_UPLOAD_LIMIT = 20 * 1024 * 1024; // 20 MiB default per Discord Developer Docs (reference#uploading-files)
const EMBED_LIMIT = 4096;

// Ayah count of each surah (Hafs numbering, Bismillah of Al-Fatiha counted as ayah 1).
const COUNTS = [7,286,200,176,120,165,206,75,129,109,123,111,43,52,99,128,111,110,98,135,112,78,118,64,77,227,93,88,69,60,34,30,73,54,45,83,182,88,75,85,54,53,89,59,37,35,38,29,18,45,60,49,62,55,78,96,29,22,24,13,14,11,11,18,12,12,30,52,52,44,28,28,20,56,40,31,50,40,46,42,29,19,36,25,22,17,19,26,30,20,15,21,11,8,8,19,5,8,8,11,11,8,3,9,5,4,7,3,6,3,5,4,5,6];

/* ---------------- report plumbing ---------------- */
const lines = [];
let failures = 0;
let warnings = 0;
const say = (s = '') => { lines.push(s); console.log(s); };
const ok = (s) => say(`  [OK]   ${s}`);
const warn = (s) => { warnings++; say(`  [WARN] ${s}`); };
const fail = (s) => { failures++; say(`  [FAIL] ${s}`); };
const head = (s) => { say(); say(`== ${s} ==`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad3 = (n) => String(n).padStart(3, '0');

/* ---------------- network ---------------- */
async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) { last = new Error(`HTTP ${res.status}`); await sleep(1500 * (i + 1)); continue; }
      return res;
    } catch (err) { last = err; await sleep(1000 * (i + 1)); }
  }
  throw last;
}
async function getJson(urls) {
  const errs = [];
  for (const url of urls) {
    try {
      const res = await fetchRetry(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) { errs.push(`${url}: ${err.message}`); }
  }
  throw new Error(errs.join(' | '));
}
async function pool(items, limit, worker) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await worker(items[k], k); } };
  await Promise.all(Array.from({ length: limit }, run));
}

/* ---------------- text helpers (comparison only, never applied to stored text) ---------------- */
const MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640\u08D3-\u08FF]/g;
const INVIS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const norm = (s) => s.normalize('NFC').replace(INVIS, '').replace(MARKS, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ک/g, 'ك').replace(/\s+/g, ' ').trim();
const loose = (s) => norm(s).replace(/ؤ/g, 'و').replace(/[ءئا]/g, '').replace(/ة/g, 'ه').replace(/ي/g, '');
const BISM = 'بسم الله الرحمن الرحيم';
function stripLeadingBasmala(raw) {
  const w = raw.trim().split(/\s+/);
  if (w.length > 4 && norm(w.slice(0, 4).join(' ')) === BISM) return w.slice(4).join(' ');
  return raw;
}
// The fawazahmed0 Hafs edition puts a stray space between a diacritic and a lone alef / ya at the end of a word
// (e.g. "رَشَدࣰ ا" instead of "رَشَدࣰا"). This is the ONLY edit applied to the stored text, and every use is counted.
const TANWEEN_GAP = /([\u064B-\u065F\u0670\u08D3-\u08FF])[ \t]+([اىي])(?=[\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]*(?:\s|$))/g;
const LONE_LETTER = /(^|\s)[اىي][\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]*(?=\s|$)/;
function repairGap(t) { const r = t.replace(TANWEEN_GAP, '$1$2'); return { text: r, changed: r !== t }; }
const tokens = (s) => new Set(norm(s).split(' ').filter((t) => t.length > 2));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
const key = (s, a) => `${s}:${a}`;

/* ---------------- 1. Quran text ---------------- */
async function checkText() {
  head('1. Quran text');
  const failsBefore = failures;
  if (COUNTS.reduce((a, b) => a + b, 0) !== 6236) fail('built-in count table does not sum to 6236');

  // Source A: Uthmani Hafs with diacritics (alquran.cloud quran-uthmani — this is what the bot will display)
  const j = await getJson([`${ALQURAN_CLOUD}/quran/quran-uthmani`]);
  const list = j?.data?.surahs;
  if (!Array.isArray(list) || list.length !== 114) {
    fail(`source A (alquran-cloud quran-uthmani): unexpected response shape (${Array.isArray(list) ? list.length : 'not array'} surahs)`);
    return { surahs: [], names: [], textOk: false };
  }
  const names = list.map((su) => (su.name || '').trim());
  if (names.length === 114 && names.every(Boolean)) ok('surah names: 114 present'); else fail('surah names missing');
  if (list.every((su, i) => su.number === i + 1 && Array.isArray(su.ayahs) && su.ayahs.length === COUNTS[i])) ok('ayah counts in source A match the built-in table (6,236 total)');
  else fail('ayah counts differ between source A and built-in table');

  const A = new Map();
  const juzMap = new Map();
  let stripped = 0, invisA = 0, prevJuz = 0, juzBad = false;
  for (const su of list) {
    const firstJ = su.ayahs[0]?.juz;
    const lastJ = su.ayahs[su.ayahs.length - 1]?.juz;
    for (const ay of su.ayahs) {
      let t = typeof ay.text === 'string' ? ay.text.trim() : '';
      if (ay.numberInSurah === 1 && su.number !== 1 && su.number !== 9) {
        const t2 = stripLeadingBasmala(t);
        if (t2 !== t) { stripped++; t = t2.trim(); }
      }
      if (/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(t)) invisA++;
      A.set(key(su.number, ay.numberInSurah), t);

      const jNum = ay.juz;
      if (!Number.isInteger(jNum) || jNum < 1 || jNum > 30 || (prevJuz && jNum !== prevJuz && jNum !== prevJuz + 1)) juzBad = true;
      prevJuz = jNum;
      if (!juzMap.has(jNum)) juzMap.set(jNum, { juz: jNum, start: [su.number, ay.numberInSurah], end: [su.number, ay.numberInSurah], wholeSurahs: [] });
      juzMap.get(jNum).end = [su.number, ay.numberInSurah];
    }
    if (firstJ && firstJ === lastJ && juzMap.has(firstJ)) juzMap.get(firstJ).wholeSurahs.push(su.number);
  }
  const juzBounds = Array.from({ length: 30 }, (_, i) => juzMap.get(i + 1)).filter(Boolean);
  if (juzBounds.length === 30 && !juzBad && juzBounds[0].start[0] === 1 && juzBounds[29].end[0] === 114 && juzBounds[29].end[1] === 6) {
    ok('30 Ajza\' boundaries computed continuously from 1:1 to 114:6');
  } else {
    fail(`unexpected Juz boundaries (found ${juzBounds.length}, gap=${juzBad})`);
  }
  if (stripped === 112) ok('source A (alquran-cloud quran-uthmani): stripped 112 prepended surah Bismillahs (1:1 kept)');
  else fail(`source A: expected to strip 112 prepended surah Bismillahs, stripped ${stripped}`);
  say(`  info: ${invisA} ayahs in source A contain invisible direction marks after trimming (no mid-text edits needed)`);
  const residual = [...A.entries()].filter(([, t]) => LONE_LETTER.test(t)).map(([k]) => k);
  if (residual.length) fail(`source A has a lone alef/ya word in ${residual.length} ayahs (e.g. ${residual.slice(0, 5).join(', ')})`); else ok('source A: no stray lone-letter words');
  if (A.size === 6236) ok('source A (alquran-cloud quran-uthmani): 6,236 ayahs'); else fail(`source A has ${A.size} unique ayahs, expected 6236`);

  const surahs = [];
  let bad = 0;
  for (let s = 1; s <= 114; s++) {
    const ayahs = [];
    for (let n = 1; n <= COUNTS[s - 1]; n++) {
      const t = A.get(key(s, n));
      if (typeof t !== 'string' || !t.trim()) { fail(`source A: ${s}:${n} is missing or empty`); bad++; ayahs.push(''); continue; }
      ayahs.push(t.trim());
    }
    if (A.size && [...A.keys()].some((k) => k.startsWith(`${s}:`) && Number(k.split(':')[1]) > COUNTS[s - 1])) { fail(`source A: surah ${s} has extra ayahs`); bad++; }
    // the glued-Bismillah bug: first ayah of a surah (other than 1 and 9) must not start with the Bismillah
    if (s !== 1 && s !== 9 && ayahs[0] && norm(ayahs[0]).startsWith(BISM)) { fail(`source A: Bismillah glued onto ${s}:1`); bad++; }
  }
  if (!bad) ok('source A: every surah has the exact ayah count, no empty ayah, no glued Bismillah');
  for (let s = 1; s <= 114; s++) surahs.push({ n: s, name: names[s - 1], ayahs: Array.from({ length: COUNTS[s - 1] }, (_, i) => (A.get(key(s, i + 1)) ?? '').trim()) });

  // Source B: independent comparison copy
  const mode = val('text-b', 'fawaz-uthmani');
  const B = new Map();
  try {
    if (mode === 'fawaz-uthmani') {
      const info = await getJson(FAWAZ_QURAN.map((b) => `${b}/info.json`));
      const infoCounts = info.chapters.map((c) => c.verses.length);
      if (infoCounts.every((n, i) => n === COUNTS[i])) ok('source B metadata ayah counts match the built-in table (6,236 total)');
      else fail('ayah counts differ between source B metadata and built-in table');
      const b = await getJson(FAWAZ_QURAN.map((x) => `${x}/editions/ara-quranuthmanihaf.json`));
      let repairedB = 0;
      for (const v of b.quran) {
        const r = repairGap(v.text);
        if (r.changed) repairedB++;
        B.set(key(v.chapter, v.verse), r.text);
      }
      say(`  info: applied spacing repair in memory only to ${repairedB} ayahs of source B for cross-checking`);
    } else if (mode === 'fawaz-nodiacritics') {
      warn('source B is ara-quranuthmanihaf1 (nodiacritics) for cross-check comparison');
      const b = await getJson(FAWAZ_QURAN.map((x) => `${x}/editions/ara-quranuthmanihaf1.json`));
      for (const v of b.quran) B.set(key(v.chapter, v.verse), v.text);
    } else throw new Error(`unknown --text-b=${mode}`);
  } catch (err) {
    fail(`source B (${mode}) could not be loaded: ${err.message}. The text cannot be cross-checked, so it is NOT approved.`);
    return { surahs, names, textOk: false };
  }
  if (B.size === 6236) ok(`source B (${mode}): 6,236 ayahs`); else fail(`source B has ${B.size} ayahs, expected 6236`);

  const hard = [];
  const spacing = [];
  const soft = [];
  for (let s = 1; s <= 114; s++) for (let n = 1; n <= COUNTS[s - 1]; n++) {
    const ta = A.get(key(s, n)) ?? '';
    const tb = B.get(key(s, n));
    if (tb === undefined) { hard.push({ s, n, ta, tb: '(missing)' }); continue; }
    if (norm(ta) === norm(tb)) continue;
    if (norm(ta).replace(/\s+/g, '') === norm(tb).replace(/\s+/g, '')) { spacing.push({ s, n, ta, tb }); continue; }
    if (loose(ta) === loose(tb)) soft.push({ s, n, ta, tb }); else hard.push({ s, n, ta, tb });
  }
  if (!hard.length) ok(`A and B agree on all ayahs after removing diacritics${spacing.length || soft.length ? ` (${spacing.length} spacing-only, ${soft.length} hamza/alef/ya spelling-only: see lists)` : ''}`);
  else fail(`${hard.length} ayahs differ between A and B beyond spelling: see list below`);
  if (spacing.length) warn(`${spacing.length} ayahs have identical letters and differ only in word-joining spaces between editions (review them)`);
  if (soft.length) warn(`${soft.length} ayahs differ only in hamza/alef/ya spelling (review them)`);
  const dump = (label, arr) => { if (arr.length) { say(`  ${label}:`); for (const m of arr.slice(0, 40)) say(`    ${m.s}:${m.n}\n      A: ${m.ta}\n      B: ${m.tb}`); if (arr.length > 40) say(`    ... and ${arr.length - 40} more`); } };
  dump('DIFFERENT TEXT', hard);
  dump('SPACING-ONLY DIFFERENCES', spacing);
  dump('SPELLING-ONLY DIFFERENCES', soft);
  return { surahs, names, juzBounds, textOk: failures === failsBefore };
}

/* ---------------- 2. Al-Muyassar tafsir ---------------- */
// The first ayah of every surah carries: heading "تسمية السورة", bullets, heading "من مقاصد السورة", bullets,
// then "[التفسير]" and the real tafsir (the marker is missing in surah 5). Split only when the structure matches exactly.
function splitIntro(text) {
  const P = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (P[0] !== 'تسمية السورة') return { intro: null, tafsir: text };
  let i = 1;
  const bullet = (x) => x.startsWith('•');
  while (i < P.length && bullet(P[i])) i++;
  if (i === 1 || P[i] !== 'من مقاصد السورة') return { error: 'unexpected structure after the first heading' };
  const j0 = i + 1; i = j0;
  while (i < P.length && bullet(P[i])) i++;
  if (i === j0) return { error: 'no bullets under the second heading' };
  const intro = P.slice(0, i).join('\n\n');
  let rest = P.slice(i);
  if (rest[0] === '[التفسير]') rest = rest.slice(1);
  else if (rest.length !== 1) return { error: 'no [التفسير] marker and more than one trailing paragraph' };
  if (!rest.length || rest.some(bullet) || rest.some((x) => /^(تسمية السورة|من مقاصد السورة|\[التفسير\])$/.test(x))) return { error: 'tafsir part is empty or malformed' };
  return { intro, tafsir: rest.join('\n\n') };
}

async function checkTafsir(quran) {
  head('2. Tafsir al-Muyassar');
  const failsBefore = failures;
  const tafsir = []; // tafsir[s-1][n-1] = text
  const intro = {};  // intro[s] = surah introduction block that the edition glues onto ayah 1
  const problems = [];
  const fetched = new Array(115);
  await pool(Array.from({ length: 114 }, (_, i) => i + 1), 6, async (s) => {
    try { fetched[s] = await getJson(TAFSIR_BASES.map((b) => `${b}/${s}.json`)); } catch (err) { fetched[s] = { error: err.message }; }
  });
  let introCount = 0, introOnLater = 0, glued = 0, empty = 0, dup = 0, tooLong = 0, short = [], strayMarker = [], withCr = 0, withTag = 0, maxLen = 0;
  for (let s = 1; s <= 114; s++) {
    const f = fetched[s];
    if (!Array.isArray(f)) { problems.push(`surah ${s}: download failed (${f?.error ?? 'bad response'})`); tafsir.push([]); continue; }
    if (f.length !== COUNTS[s - 1]) problems.push(`surah ${s}: ${f.length} tafsir entries, expected ${COUNTS[s - 1]}`);
    const row = [];
    for (let n = 1; n <= COUNTS[s - 1]; n++) {
      const e = f[n - 1];
      if (!e || e.surah !== s || e.ayah !== n || typeof e.text !== 'string') { problems.push(`${s}:${n}: entry missing or mislabeled (${e ? `${e.surah}:${e.ayah}` : 'none'})`); row.push(''); continue; }
      let text = e.text.trim();
      if (/^تسمية السورة/.test(text)) {
        const r = splitIntro(text);
        if (r.error) { glued++; problems.push(`${s}:${n}: surah-introduction block cannot be split safely (${r.error})`); }
        else if (n === 1) { intro[s] = r.intro; text = r.tafsir; introCount++; }
        else if (intro[s] && r.intro === intro[s]) { text = r.tafsir; introOnLater++; }
        else { glued++; problems.push(`${s}:${n}: surah-introduction block on ayah > 1 does not match ayah 1`); }
      }
      if (text.includes('تسمية السورة') || text.includes('من مقاصد السورة')) {
        glued++; problems.push(`${s}:${n}: leftover surah-introduction heading in tafsir`);
      }
      if (text.includes('[التفسير]')) strayMarker.push(`${s}:${n}`);
      if (!text) { empty++; problems.push(`${s}:${n}: empty tafsir`); }
      if (text && text.length < 12) short.push(`${s}:${n} (${text.length} chars)`);
      if (row.length && row[row.length - 1] && text === row[row.length - 1]) dup++;
      if (text.length > EMBED_LIMIT) tooLong++;
      if (text.length > maxLen) maxLen = text.length;
      if (text.includes('\r')) withCr++;
      if (/<\/?[a-z][^>]*>/i.test(text)) withTag++;
      row.push(text);
    }
    tafsir.push(row);
  }
  if (!problems.length && !empty) ok('114 surahs downloaded; every ayah has its own non-empty tafsir entry, numbering 1..n matches the ayah counts');
  else { fail(`${problems.length} structural problems with the tafsir data`); for (const p of problems.slice(0, 40)) say(`    ${p}`); if (problems.length > 40) say(`    ... and ${problems.length - 40} more`); }
  say(`  info: ${introCount} surahs carry an introduction block on ayah 1; it was split off and stored apart (not part of the ayah tafsir)`);
  if (introOnLater) say(`  info: also split off the identical repeated introduction block from ${introOnLater} later ayahs belonging to opening groups`);
  if (introCount !== 114 && !glued) say(`  info: the other ${114 - introCount} surahs have no introduction block`);
  say(`  info: longest tafsir entry is ${maxLen} characters; ${tooLong} exceed the ${EMBED_LIMIT} embed limit and would need splitting`);
  say(`  info: ${dup} ayahs share an identical tafsir with the previous ayah: Muyassar comments on groups of ayahs (e.g. 2:45-46), so the same text is repeated for each ayah of the group`);
  if (strayMarker.length) warn(`${strayMarker.length} entries contain a stray "[التفسير]" marker inside the tafsir text (review): ${strayMarker.join(', ')}`);
  if (short.length) warn(`very short tafsir entries (review): ${short.slice(0, 25).join(', ')}${short.length > 25 ? ' ...' : ''}`);
  if (withCr) warn(`${withCr} entries contain carriage returns`);
  if (withTag) warn(`${withTag} entries contain HTML-like tags`);

  // alignment check against a second Muyassar copy
  let alignOk = true;
  if (val('tafsir-b', 'alquran-cloud') === 'none') warn('alignment cross-check skipped (--tafsir-b=none)');
  else {
    try {
      const j = await getJson([`${ALQURAN_CLOUD}/quran/ar.muyassar`]);
      const list = j?.data?.surahs;
      if (!Array.isArray(list)) throw new Error('unexpected response shape (no data.surahs)');
      const low = [];
      let sum = 0, cnt = 0, under20 = 0;
      for (const su of list) for (const ay of su.ayahs) {
        const mine = tafsir[su.number - 1]?.[ay.numberInSurah - 1];
        if (!mine) continue;
        const sim = jaccard(tokens(mine), tokens(ay.text));
        sum += sim; cnt++;
        if (sim < 0.2) under20++;
        if (sim < 0.35) low.push({ s: su.number, n: ay.numberInSurah, sim });
      }
      say(`  info: compared ${cnt} entries with a second Muyassar copy (alquran.cloud): average word overlap ${(sum / cnt).toFixed(2)}, ${under20} under 0.20`);
      if (cnt < 6000) { fail(`only ${cnt} entries could be compared`); alignOk = false; }
      else if (under20 / cnt > 0.03) { fail(`${under20} entries (${((under20 / cnt) * 100).toFixed(1)}%) barely overlap their counterpart: the tafsir may be shifted against the ayahs`); alignOk = false; }
      else ok('tafsir is aligned with the second copy (word overlap is high across the Quran)');
      low.sort((x, y) => x.sim - y.sim);
      if (low.length) { say('  lowest-overlap entries (read these yourself):'); for (const l of low.slice(0, 20)) say(`    ${l.s}:${l.n}  overlap ${l.sim.toFixed(2)}`); }
    } catch (err) {
      fail(`alignment cross-check could not run: ${err.message}. Without it the tafsir is NOT approved.`);
      alignOk = false;
    }
  }
  return { tafsir, intro, tafsirOk: failures === failsBefore };
}

/* ---------------- spot samples ---------------- */
function samples(quran, tafsir, intro) {
  head('Samples to compare with a trusted mushaf and tafsir book');
  const picks = [[1, 1], [1, 4], [1, 7], [2, 255], [2, 282], [9, 1], [18, 10], [112, 1], [114, 6]];
  for (const [s, n] of picks) {
    const t = quran.surahs[s - 1]?.ayahs[n - 1];
    say(`${s}:${n}  (${quran.surahs[s - 1]?.name})`);
    say(`  ayah:   ${t}`);
    const tf = tafsir[s - 1]?.[n - 1] ?? '';
    say(`  tafsir: ${tf.slice(0, 220)}${tf.length > 220 ? ' ...' : ''}`);
  }
  if (intro[112]) say(`\nSurah 112 introduction block (split off from 112:1):\n  ${intro[112].replace(/\n+/g, ' | ')}`);
}

/* ---------------- 3. per-ayah audio ---------------- */
const isOkStatus = (st) => st === 200 || st === 206;
async function headSize(url) {
  let res = await fetchRetry(url, { method: 'HEAD' });
  if (res.status === 405 || res.status === 501) {
    await res.body?.cancel?.().catch(() => {});
    res = await fetchRetry(url, { headers: { Range: 'bytes=0-0' } });
  }
  const len = Number((res.headers.get('content-range') || '').split('/')[1] || res.headers.get('content-length') || 0);
  const type = res.headers.get('content-type') || '';
  await res.body?.cancel?.().catch(() => {});
  return { status: res.status, bytes: len, type };
}
async function checkAudio() {
  head('3. Per-ayah audio (everyayah.com)');
  const cacheFile = path.join(DATA, 'nakhtim-audio-check.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  try {
    const txt = await (await fetchRetry(`${EVERYAYAH}/recitations.js`)).text();
    const folders = [...new Set(txt.match(/"subfolder"\s*:\s*"[^"]+"/g) || [])].map((x) => x.split('"')[3]);
    const wanted = folders.filter((f) => /alafasy|ghamad|ghamdi|husary/i.test(f));
    if (wanted.length) say(`  info: matching folders listed by everyayah.com: ${wanted.join(', ')}`);
  } catch (err) { say(`  info: could not read the reciter list (${err.message}); probing folders directly`); }

  for (const r of RECITERS) {
    const probe = await headSize(`${EVERYAYAH}/${r.folder}/001001.mp3`).catch((e) => ({ status: 0, err: e.message }));
    if (!isOkStatus(probe.status)) { fail(`${r.name}: folder "${r.folder}" does not serve 001001.mp3 (${probe.err ?? `HTTP ${probe.status}`}). Fix the folder name at the top of the script.`); continue; }
    const results = cache[r.folder] || (cache[r.folder] = {});
    const todo = [];
    for (let s = 1; s <= 114; s++) for (let n = 1; n <= COUNTS[s - 1]; n++) if (!isOkStatus(results[`${pad3(s)}${pad3(n)}`]?.status)) todo.push([s, n]);
    say(`  ${r.name} (${r.folder}): ${6236 - todo.length} already verified, ${todo.length} to check`);
    let done = 0;
    await pool(todo, 8, async ([s, n]) => {
      const id = `${pad3(s)}${pad3(n)}`;
      try {
        const h = await headSize(`${EVERYAYAH}/${r.folder}/${id}.mp3`);
        results[id] = { status: h.status, bytes: h.bytes, type: h.type };
      } catch (err) { results[id] = { status: 0, bytes: 0, type: err.message }; }
      if (++done % 500 === 0) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); process.stdout.write(`    ${done}/${todo.length}\r`); }
    });
    fs.mkdirSync(DATA, { recursive: true });
    const good = {};
    for (const [id, v] of Object.entries(results)) if (isOkStatus(v.status)) good[id] = v;
    const missing = [], tiny = [], odd = [];
    for (let s = 1; s <= 114; s++) for (let n = 1; n <= COUNTS[s - 1]; n++) {
      const id = `${pad3(s)}${pad3(n)}`;
      const v = results[id];
      if (!v || !isOkStatus(v.status)) missing.push(`${s}:${n} (${v ? `HTTP ${v.status} ${v.type}`.trim() : 'not checked'})`);
      else { if (v.bytes < 8000) tiny.push(`${s}:${n} (${v.bytes} bytes)`); if (!/audio|mpeg|octet/i.test(v.type)) odd.push(`${s}:${n} (${v.type})`); }
    }
    cache[r.folder] = good; // only verified files are remembered
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    if (!missing.length) ok(`${r.name}: all 6,236 files exist`); else { fail(`${r.name}: ${missing.length} files missing`); for (const m of missing.slice(0, 30)) say(`    ${m}`); }
    let maxBytes = 0, maxId = '';
    for (const [id, v] of Object.entries(good)) if (v.bytes > maxBytes) { maxBytes = v.bytes; maxId = id; }
    if (maxId) say(`  info: ${r.name}: largest ayah ${maxId} (${(maxBytes / 1024).toFixed(0)} KB); samples: ${EVERYAYAH}/${r.folder}/001001.mp3 , ${EVERYAYAH}/${r.folder}/112001.mp3`);
    if (tiny.length) warn(`${r.name}: ${tiny.length} suspiciously small files: ${tiny.slice(0, 15).join(', ')}`);
    if (odd.length) warn(`${r.name}: ${odd.length} files with a non-audio content type: ${odd.slice(0, 10).join(', ')}`);

    // sample: really an mp3? (ID3 tag or MPEG frame sync)
    let checked = 0, notMp3 = [];
    const all = Object.keys(good);
    for (let i = 0; i < all.length; i += 97) {
      const id = all[i];
      let b;
      try {
        const res = await fetchRetry(`${EVERYAYAH}/${r.folder}/${id}.mp3`, { headers: { Range: 'bytes=0-3' } });
        b = Buffer.from(await res.arrayBuffer());
      } catch { continue; }
      checked++;
      const isId3 = b.length >= 3 && b.toString('latin1', 0, 3) === 'ID3';
      const isFrame = b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
      if (!isId3 && !isFrame) notMp3.push(id);
    }
    if (notMp3.length) fail(`${r.name}: ${notMp3.length} of ${checked} sampled files do not look like MP3 (${notMp3.slice(0, 8).join(', ')})`); else if (checked) ok(`${r.name}: ${checked} sampled files start like real MP3 data`);
  }
}

/* ---------------- 4. full-surah audio ---------------- */
async function checkFullSurah() {
  head('4. Full-surah audio (mp3quran.net)');
  let j;
  try { j = await getJson([`${MP3QURAN_API}/reciters?language=ar`]); } catch (err) { fail(`mp3quran.net API unreachable: ${err.message}`); return; }
  if (!Array.isArray(j?.reciters)) { fail('mp3quran.net API: unexpected response shape (no reciters array)'); return; }
  for (const r of RECITERS) {
    const cands = j.reciters.filter((x) => r.fullSurahName.test(x.name || ''));
    if (!cands.length) { fail(`${r.name}: not found on mp3quran.net`); continue; }
    let anyComplete = false;
    say(`  ${r.name}: ${cands.length} reciter entr${cands.length === 1 ? 'y' : 'ies'} match`);
    let tested = 0;
    for (const c of cands) for (const m of c.moshaf || []) {
      say(`    candidate: reciter "${c.name}" | recording "${m.name}" | ${m.surah_total} surahs | ${m.server}`);
      if (Number(m.surah_total) < 114) continue;
      tested++;
      const server = m.server.endsWith('/') ? m.server : `${m.server}/`;
      const sizes = new Array(115).fill(0);
      const bad = [];
      await pool(Array.from({ length: 114 }, (_, i) => i + 1), 6, async (s) => {
        try {
          const h = await headSize(`${server}${pad3(s)}.mp3`);
          if (isOkStatus(h.status) && h.bytes > 50000) sizes[s] = h.bytes;
          else bad.push(isOkStatus(h.status) ? `${s} (small: ${h.bytes} bytes)` : `${s} (HTTP ${h.status})`);
        } catch (err) { bad.push(`${s} (${err.message})`); }
      });
      const over20 = sizes.slice(1).filter((b) => b > DISCORD_UPLOAD_LIMIT).length;
      const over10 = sizes.slice(1).filter((b) => b > 10 * 1024 * 1024).length;
      let maxB = 0, maxS = 0;
      for (let s = 1; s <= 114; s++) if (sizes[s] > maxB) { maxB = sizes[s]; maxS = s; }
      const total = sizes.reduce((a, b) => a + b, 0);
      if (!bad.length) {
        anyComplete = true;
        ok(`${r.name} / "${c.name}" / "${m.name}": all 114 surahs exist (${(total / 1048576).toFixed(0)} MiB total, largest surah ${maxS}: ${(maxB / 1048576).toFixed(1)} MiB). ${114 - over20}/114 fit under 20 MiB (${over20} need a link); ${114 - over10}/114 fit under 10 MiB; samples: ${server}001.mp3 , ${server}112.mp3`);
      } else warn(`${r.name} / "${c.name}" / "${m.name}": ${bad.length} surahs failed: ${bad.slice(0, 10).join(', ')}`);
    }
    if (!anyComplete) fail(`${r.name}: no complete 114-surah recording found on mp3quran.net`);
  }
  say('  note: the owner must listen to a few full-surah files and confirm each is the same reciter as the per-ayah recordings.');
}

/* ---------------- 5. surah PDFs, 30 Ajza' & Full Medina Mushaf PDF ---------------- */
async function streamPdfPrefix(url) {
  const res = await fetchRetry(url);
  const type = res.headers.get('content-type') || '';
  if (!isOkStatus(res.status)) return { status: res.status, type, magic: '' };
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    try {
      while (got < 5) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        chunks.push(Buffer.from(value));
        got += value.length;
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return { status: res.status, type, magic: Buffer.concat(chunks).subarray(0, 5).toString('latin1') };
  }
  const b = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type, magic: b.subarray(0, 5).toString('latin1') };
}

async function checkPdfs(juzBounds) {
  head('5. Surah PDFs (pdfquran.com standard1) + 30 Ajza\' & Full Medina Mushaf (archive.org)');
  const failsBefore = failures;
  let html;
  try {
    const res = await fetchRetry(PDF_QURAN_PAGE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    fail(`pdfquran.com standard1 index unreachable: ${err.message}`);
    return null;
  }

  const slugs = [];
  const seen = new Set();
  for (const m of html.matchAll(/href=["'](?:https?:\/\/(?:www\.)?pdfquran\.com)?(\/standard1\/surah\/([^/"'#?]+)\/?)["']/gi)) {
    const slug = m[2];
    if (!seen.has(slug)) { seen.add(slug); slugs.push(slug); }
  }
  const anchors = [[0, 'al-fatihah'], [1, 'al-baqarah'], [8, 'at-tawbah'], [17, 'al-kahf'], [111, 'al-ikhlas'], [113, 'an-nas']];
  const anchorsOk = slugs.length === 114 && anchors.every(([idx, expected]) => slugs[idx]?.toLowerCase() === expected);
  if (!anchorsOk) {
    fail(`expected 114 ordered standard1 surah slugs, found ${slugs.length} (sample: ${slugs[0]}, ${slugs[1]}, ${slugs[113]})`);
    return null;
  }
  ok('found all 114 ordered Medina Mushaf surah slugs on pdfquran.com/standard1');

  const surahUrls = slugs.map((slug) => new URL(`/standard1/surah/${slug}/download/pdf/`, PDF_QURAN_PAGE).href);
  const bad = [];
  await pool(surahUrls.map((url, idx) => ({ num: idx + 1, url })), 4, async ({ num, url }) => {
    try {
      const p = await streamPdfPrefix(url);
      if (!isOkStatus(p.status) || !/pdf/i.test(p.type) || p.magic !== '%PDF-') {
        bad.push(`${num} (HTTP ${p.status}, ${p.type || 'no-type'}, magic=${JSON.stringify(p.magic)})`);
      }
    } catch (err) { bad.push(`${num} (${err.message})`); }
  });
  if (!bad.length) ok('all 114 surah PDFs return application/pdf and start with valid %PDF- header');
  else fail(`${bad.length} surah PDFs failed: ${bad.slice(0, 15).join(', ')}`);

  try {
    const res = await fetchRetry(surahUrls[1]);
    const buf = Buffer.from(await res.arrayBuffer());
    const mb = (buf.length / 1048576).toFixed(2);
    if (isOkStatus(res.status) && buf.subarray(0, 5).toString('latin1') === '%PDF-' && buf.length > 500000 && buf.length <= DISCORD_UPLOAD_LIMIT) {
      ok(`largest surah PDF (2 Al-Baqarah) fits Discord 20 MiB limit (${mb} MiB, valid %PDF-)`);
    } else {
      fail(`largest surah PDF (2 Al-Baqarah) failed size/header check (HTTP ${res.status}, ${mb} MiB)`);
    }
  } catch (err) {
    fail(`largest surah PDF (2 Al-Baqarah) download failed: ${err.message}`);
  }

  // 30 Ajza' Medina Mushaf PDFs (archive.org)
  let ajza = [];
  try {
    const meta = await getJson([`https://archive.org/metadata/${ARCHIVE_AJZA_ID}`]);
    const files = (meta?.files || [])
      .filter((f) => /\.pdf$/i.test(f.name) && !/_text\.pdf$/i.test(f.name))
      .map((f) => ({ juz: Number((/^(\d{1,2})\b/.exec(f.name) || [])[1]), name: f.name, bytes: Number(f.size || 0) }))
      .filter((f) => f.juz >= 1 && f.juz <= 30)
      .sort((a, b) => a.juz - b.juz);
    if (files.length !== 30 || files.some((f, i) => f.juz !== i + 1)) {
      fail(`expected 30 numbered Ajza' PDFs in archive.org/${ARCHIVE_AJZA_ID}, found ${files.length}`);
    } else {
      ok(`found all 30 Ajza' PDFs in archive.org/${ARCHIVE_AJZA_ID}`);
      const badAjza = [];
      const juzUrls = files.map((f) => ({ ...f, url: `https://archive.org/download/${ARCHIVE_AJZA_ID}/${encodeURIComponent(f.name)}` }));
      await pool(juzUrls, 6, async (item) => {
        try {
          const h = await headSize(item.url);
          if (!isOkStatus(h.status) || h.bytes < 500000) badAjza.push(`Juz ${item.juz} (HTTP ${h.status}, ${h.bytes}B)`);
          else item.bytes = h.bytes;
        } catch (err) { badAjza.push(`Juz ${item.juz} (${err.message})`); }
      });
      if (!badAjza.length) ok('all 30 Ajza\' PDFs reachable and >500 KB');
      else fail(`Ajza' PDF failures: ${badAjza.join(', ')}`);

      const sampleAjza = [1, 2, 15, 28, 29, 30];
      const badJuzMagic = [];
      for (const j of sampleAjza) {
        try {
          const res = await fetchRetry(juzUrls[j - 1].url, { headers: { Range: 'bytes=0-4' } });
          const b = Buffer.from(await res.arrayBuffer());
          if (!isOkStatus(res.status) || b.toString('latin1', 0, 5) !== '%PDF-') badJuzMagic.push(j);
        } catch { badJuzMagic.push(j); }
      }
      if (!badJuzMagic.length) ok(`${sampleAjza.length} sampled Ajza' PDFs start with valid %PDF- header`);
      else fail(`Ajza' PDFs without %PDF- header: ${badJuzMagic.join(', ')}`);

      const overJuz = juzUrls.filter((x) => x.bytes > DISCORD_UPLOAD_LIMIT).length;
      say(`  info: Ajza' PDFs ${30 - overJuz}/30 fit under 20 MiB (${overJuz} link-only: Juz ${juzUrls.filter((x) => x.bytes > DISCORD_UPLOAD_LIMIT).map((x) => x.juz).join(', ') || 'none'})`);
      ajza = juzUrls.map((x) => {
        const b = juzBounds?.[x.juz - 1] || {};
        return { juz: x.juz, start: b.start, end: b.end, wholeSurahs: b.wholeSurahs || [], url: x.url, bytes: x.bytes };
      });
    }
  } catch (err) {
    fail(`archive.org Ajza' metadata check failed: ${err.message}`);
  }

  // Full Medina Mushaf PDF (archive.org Green 1441)
  let fullBytes = 0;
  try {
    const h = await headSize(ARCHIVE_FULL_MUSHAF_URL);
    const res = await fetchRetry(ARCHIVE_FULL_MUSHAF_URL, { headers: { Range: 'bytes=0-4' } });
    const b = Buffer.from(await res.arrayBuffer());
    if (isOkStatus(h.status) && h.bytes > 10 * 1024 * 1024 && isOkStatus(res.status) && b.toString('latin1', 0, 5) === '%PDF-') {
      fullBytes = h.bytes;
      ok(`Full Medina Mushaf PDF verified (${(fullBytes / 1048576).toFixed(2)} MiB, valid %PDF-): ${ARCHIVE_FULL_MUSHAF_URL}`);
    } else {
      fail(`Full Medina Mushaf PDF invalid (HTTP ${h.status}, ${h.bytes}B)`);
    }
  } catch (err) {
    fail(`Full Medina Mushaf PDF unreachable: ${err.message}`);
  }

  return {
    urls: surahUrls,
    juzData: {
      source: 'مصحف المدينة النبوية (حفص عن عاصم — طبعة مجمع الملك فهد)',
      fullQuran: {
        url: ARCHIVE_FULL_MUSHAF_URL,
        bytes: fullBytes,
        label: 'مصحف المدينة النبوية كاملاً (حفص عن عاصم — طبعة 1441هـ)'
      },
      ajza
    },
    pdfOk: failures === failsBefore && ajza.length === 30 && fullBytes > 0
  };
}

/* ---------------- 6. high-resolution ayah Mushaf images ---------------- */
async function probePngHeader(url) {
  const res = await fetchRetry(url, { headers: { Range: 'bytes=0-28' } });
  const type = res.headers.get('content-type') || '';
  if (!isOkStatus(res.status)) {
    await res.body?.cancel?.().catch(() => {});
    return { status: res.status, bytes: 0, type, w: 0, h: 0 };
  }
  const b = Buffer.from(await res.arrayBuffer());
  const bytes = Number((res.headers.get('content-range') || '').split('/')[1] || res.headers.get('content-length') || b.length);
  const isPng = b.length >= 24 && b.toString('hex', 0, 8) === '89504e470d0a1a0a';
  const w = isPng ? b.readUInt32BE(16) : 0;
  const h = isPng ? b.readUInt32BE(20) : 0;
  return { status: res.status, bytes, type, w, h };
}

async function checkImages() {
  head('6. High-resolution ayah Mushaf images (cdn.islamic.network)');
  const cacheFile = path.join(DATA, 'nakhtim-image-check.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

  const probe = await probePngHeader(`${AYAH_IMAGES_BASE}/1_1.png`).catch((e) => ({ status: 0, err: e.message }));
  if (!isOkStatus(probe.status) || !probe.w || !probe.h) {
    fail(`ayah image CDN unreachable or invalid for 1_1.png (${probe.err ?? `HTTP ${probe.status}, ${probe.w}x${probe.h}`})`);
    return;
  }

  const todo = [];
  for (let s = 1; s <= 114; s++) for (let n = 1; n <= COUNTS[s - 1]; n++) {
    const id = `${s}_${n}`;
    const v = cache[id];
    if (!v || !isOkStatus(v.status) || v.bytes < 500 || !v.w || !v.h) todo.push([s, n]);
  }
  say(`  ${6236 - todo.length} already verified, ${todo.length} to check`);
  let done = 0;
  await pool(todo, 16, async ([s, n]) => {
    const id = `${s}_${n}`;
    try {
      cache[id] = await probePngHeader(`${AYAH_IMAGES_BASE}/${id}.png`);
    } catch (err) {
      cache[id] = { status: 0, bytes: 0, type: err.message, w: 0, h: 0 };
    }
    if (++done % 500 === 0) {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
      process.stdout.write(`    ${done}/${todo.length}\r`);
    }
  });

  const good = {};
  const missing = [], badType = [];
  let maxBytes = 0, maxId = '';
  for (let s = 1; s <= 114; s++) for (let n = 1; n <= COUNTS[s - 1]; n++) {
    const id = `${s}_${n}`;
    const v = cache[id];
    if (!v || !isOkStatus(v.status) || v.bytes < 500 || !v.w || !v.h) {
      missing.push(`${s}:${n} (${v ? `HTTP ${v.status} ${v.bytes}B ${v.w}x${v.h}` : 'none'})`);
    } else {
      good[id] = v;
      if (v.bytes > maxBytes) { maxBytes = v.bytes; maxId = id; }
      if (!/png/i.test(v.type)) badType.push(`${s}:${n} (${v.type})`);
    }
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(good));

  if (!missing.length) ok('all 6,236 high-resolution ayah PNGs verified (>500 B, valid PNG signature & IHDR)');
  else { fail(`${missing.length} ayah PNGs missing or invalid`); for (const m of missing.slice(0, 30)) say(`    ${m}`); }
  if (badType.length) warn(`${badType.length} ayah images had unexpected content-type: ${badType.slice(0, 10).join(', ')}`);
  if (maxId) say(`  info: largest raw ayah PNG ${maxId} (${(maxBytes / 1024).toFixed(0)} KB, ${good[maxId].w}x${good[maxId].h})`);

  // full download + IEND footer check on 8 representative ayahs
  const fullSamples = ['1_1', '1_4', '2_255', '2_282', '9_1', '18_10', '112_1', '114_6'];
  const badFull = [];
  for (const id of fullSamples) {
    try {
      const res = await fetchRetry(`${AYAH_IMAGES_BASE}/${id}.png`);
      const b = Buffer.from(await res.arrayBuffer());
      const okPng = isOkStatus(res.status) && b.length > 500 &&
        b.toString('hex', 0, 8) === '89504e470d0a1a0a' &&
        b.subarray(-12).toString('hex') === '0000000049454e44ae426082';
      if (!okPng) badFull.push(id);
    } catch { badFull.push(id); }
  }
  if (!badFull.length) ok(`${fullSamples.length} full ayah PNG downloads verified end-to-end (valid PNG IHDR + IEND)`);
  else fail(`${badFull.length} full ayah PNG downloads failed IEND check (${badFull.join(', ')})`);
}

/* ---------------- main ---------------- */
(async () => {
  say(`Nakhtim data verification  |  ${new Date().toISOString()}  |  node ${process.version}`);
  const quran = await checkText().catch((e) => { fail(`text check crashed: ${e.message}`); return null; });
  const taf = quran ? await checkTafsir(quran).catch((e) => { fail(`tafsir check crashed: ${e.message}`); return null; }) : null;
  if (quran && taf) samples(quran, taf.tafsir, taf.intro);
  if (DO_AUDIO) await checkAudio().catch((e) => fail(`audio check crashed: ${e.message}`));
  if (DO_FULL) await checkFullSurah().catch((e) => fail(`full-surah check crashed: ${e.message}`));
  const pdf = DO_PDF ? await checkPdfs(quran?.juzBounds).catch((e) => { fail(`PDF check crashed: ${e.message}`); return null; }) : null;
  if (DO_IMAGES) await checkImages().catch((e) => fail(`images check crashed: ${e.message}`));

  head('Result');
  const dataOk = quran?.textOk && taf?.tafsirOk;
  if (dataOk) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'quran.json'), JSON.stringify({ surahs: quran.surahs }));
    fs.writeFileSync(path.join(DATA, 'tafsir-muyassar.json'), JSON.stringify({ source: 'التفسير الميسر', intro: taf.intro, tafsir: taf.tafsir }));
    say('  Wrote data/quran.json and data/tafsir-muyassar.json');
  } else {
    // never leave data from an earlier passing run next to a failing report
    for (const f of ['quran.json', 'tafsir-muyassar.json']) { try { fs.unlinkSync(path.join(DATA, f)); } catch {} }
    say('  Text/tafsir data NOT written (and any older copy removed): at least one check failed.');
  }
  if (DO_PDF) {
    if (pdf?.pdfOk) {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(path.join(DATA, 'surah-pdfs.json'), JSON.stringify({ source: 'مصحف المدينة النبوية (حفص عن عاصم — pdfquran.com/standard1)', urls: pdf.urls }));
      fs.writeFileSync(path.join(DATA, 'juz-pdfs.json'), JSON.stringify(pdf.juzData));
      say('  Wrote data/surah-pdfs.json and data/juz-pdfs.json');
    } else {
      for (const f of ['surah-pdfs.json', 'juz-pdfs.json']) { try { fs.unlinkSync(path.join(DATA, f)); } catch {} }
      say('  PDF data NOT written (and any older copy removed): PDF check failed.');
    }
  }
  say(`  ${failures} failure(s), ${warnings} warning(s). ${failures ? 'NOT approved: do not publish.' : 'All run checks passed. Still read the samples and warnings yourself.'}`);
  if (!DO_AUDIO) say('  (audio not checked in this run: use --audio)');
  if (!DO_FULL) say('  (full-surah audio not checked in this run: use --fullsurah)');
  if (!DO_PDF) say('  (PDFs not checked in this run: use --pdf)');
  if (!DO_IMAGES) say('  (ayah images not checked in this run: use --images)');
  fs.writeFileSync(REPORT_FILE, lines.join('\n') + '\n');
  console.log(`\nReport saved to ${REPORT_FILE}`);
  process.exit(failures ? 1 : 0);
})();
