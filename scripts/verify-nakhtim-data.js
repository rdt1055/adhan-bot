/* Verifies (and builds) the data for the Nakhtim feature. Read-only toward the bot: it only writes
   nakhtim-report.txt in the project root and, when every check passes, data/quran.json and
   data/tafsir-muyassar.json.

   Fail-safe rule: anything that cannot be proven is a FAIL and no data files are written.
   The Quran / tafsir text is never altered (only trimmed at its ends); the surah-introduction block that
   the Muyassar edition glues onto the first ayah of each surah is SPLIT OFF (not edited) and stored apart.

   Usage (cmd, from the project folder):
     node scripts/verify-nakhtim-data.js                 text + tafsir (about 1-2 minutes)
     node scripts/verify-nakhtim-data.js --audio         + per-ayah audio, 3 reciters x 6,236 files (several minutes, resumable)
     node scripts/verify-nakhtim-data.js --fullsurah     + full-surah audio from mp3quran.net
     node scripts/verify-nakhtim-data.js --all           everything
   Options: --text-b=alquran-cloud (default) | fawaz-nodiacritics (NOT independent, only a fallback)
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

// Folder names on everyayah.com. The script confirms each one exists before the big run.
const RECITERS = [
  { key: 'alafasy', name: 'مشاري العفاسي', folder: 'Alafasy_128kbps', fullSurahName: /العفاسي/ },
  { key: 'ghamdi', name: 'سعد الغامدي', folder: 'Ghamadi_40kbps', fullSurahName: /الغامدي/ },
  { key: 'husary', name: 'محمود خليل الحصري', folder: 'Husary_128kbps', fullSurahName: /الحصري/ }
];
const DISCORD_UPLOAD_LIMIT = 10 * 1024 * 1024; // assumed bot upload limit; confirm before relying on it
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
const norm = (s) => s.normalize('NFC').replace(MARKS, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ک/g, 'ك').replace(/\s+/g, ' ').trim();
const loose = (s) => norm(s).replace(/[ءؤئا]/g, '').replace(/ة/g, 'ه').replace(/ي/g, '');
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
  const info = await getJson(FAWAZ_QURAN.map((b) => `${b}/info.json`));
  const names = info.chapters.map((c) => c.arabicname);
  const infoCounts = info.chapters.map((c) => c.verses.length);
  if (names.length === 114 && names.every((n) => n && n.trim())) ok('surah names: 114 present'); else fail('surah names missing');
  if (infoCounts.every((n, i) => n === COUNTS[i])) ok('ayah counts in the metadata file match the built-in table (6,236 total)'); else fail('ayah counts differ between metadata and built-in table');
  if (COUNTS.reduce((a, b) => a + b, 0) !== 6236) fail('built-in count table does not sum to 6236');

  // Source A: Uthmani Hafs with diacritics (this is what the bot will display)
  const a = await getJson(FAWAZ_QURAN.map((b) => `${b}/editions/ara-quranuthmanihaf.json`));
  const A = new Map();
  let repairedA = 0;
  for (const v of a.quran) { const r = repairGap(v.text); if (r.changed) repairedA++; A.set(key(v.chapter, v.verse), r.text); }
  say(`  info: repaired the stray space after a diacritic before a lone alef/ya in ${repairedA} ayahs of source A (the only edit made to the text)`);
  const residual = [...A.entries()].filter(([, t]) => LONE_LETTER.test(t)).map(([k]) => k);
  if (residual.length) fail(`source A still has a lone alef/ya word after the repair in ${residual.length} ayahs (e.g. ${residual.slice(0, 5).join(', ')})`); else ok('source A: no stray lone-letter words remain after the repair');
  if (a.quran.length === 6236 && A.size === 6236) ok('source A (fawazahmed0 ara-quranuthmanihaf): 6,236 ayahs'); else fail(`source A has ${a.quran.length} entries / ${A.size} unique`);

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
  const mode = val('text-b', 'alquran-cloud');
  const B = new Map();
  let stripped = 0;
  try {
    if (mode === 'alquran-cloud') {
      const j = await getJson([`${ALQURAN_CLOUD}/quran/quran-uthmani`]);
      const list = j?.data?.surahs;
      if (!Array.isArray(list)) throw new Error('unexpected response shape (no data.surahs)');
      for (const su of list) for (const ay of su.ayahs) {
        let t = ay.text;
        if (ay.numberInSurah === 1 && su.number !== 1 && su.number !== 9) { const t2 = stripLeadingBasmala(t); if (t2 !== t) { stripped++; t = t2; } }
        B.set(key(su.number, ay.numberInSurah), t);
      }
    } else if (mode === 'fawaz-nodiacritics') {
      warn('source B is ara-quranuthmanihaf1 from the SAME project as A: this only catches transcription slips, it is NOT an independent source');
      const b = await getJson(FAWAZ_QURAN.map((x) => `${x}/editions/ara-quranuthmanihaf1.json`));
      for (const v of b.quran) B.set(key(v.chapter, v.verse), v.text);
    } else throw new Error(`unknown --text-b=${mode}`);
  } catch (err) {
    fail(`source B (${mode}) could not be loaded: ${err.message}. The text cannot be cross-checked, so it is NOT approved.`);
    return { surahs, names, textOk: false };
  }
  if (B.size === 6236) ok(`source B (${mode}): 6,236 ayahs${stripped ? `; removed a glued Bismillah from ${stripped} first ayahs (expected 112)` : ''}`); else fail(`source B has ${B.size} ayahs, expected 6236`);
  if (mode === 'alquran-cloud' && stripped !== 112) warn(`expected 112 glued Bismillahs in source B, found ${stripped}; check the mismatch list below`);

  const hard = [];
  const soft = [];
  for (let s = 1; s <= 114; s++) for (let n = 1; n <= COUNTS[s - 1]; n++) {
    const ta = A.get(key(s, n)) ?? '';
    const tb = B.get(key(s, n));
    if (tb === undefined) { hard.push({ s, n, ta, tb: '(missing)' }); continue; }
    if (norm(ta) === norm(tb)) continue;
    if (loose(ta) === loose(tb)) soft.push({ s, n, ta, tb }); else hard.push({ s, n, ta, tb });
  }
  if (!hard.length) ok(`A and B agree on all ayahs after removing diacritics${soft.length ? ` (${soft.length} differ only in hamza/alef spelling: see list)` : ''}`);
  else fail(`${hard.length} ayahs differ between A and B beyond spelling: see list below`);
  if (soft.length) warn(`${soft.length} ayahs differ only in hamza/alef/ya spelling (review them)`);
  const dump = (label, arr) => { if (arr.length) { say(`  ${label}:`); for (const m of arr.slice(0, 40)) say(`    ${m.s}:${m.n}\n      A: ${m.ta}\n      B: ${m.tb}`); if (arr.length > 40) say(`    ... and ${arr.length - 40} more`); } };
  dump('DIFFERENT TEXT', hard);
  dump('SPELLING-ONLY DIFFERENCES', soft);
  return { surahs, names, textOk: !bad && !hard.length && B.size === 6236 };
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
  const tafsir = []; // tafsir[s-1][n-1] = text
  const intro = {};  // intro[s] = surah introduction block that the edition glues onto ayah 1
  const problems = [];
  const fetched = new Array(115);
  await pool(Array.from({ length: 114 }, (_, i) => i + 1), 6, async (s) => {
    try { fetched[s] = await getJson(TAFSIR_BASES.map((b) => `${b}/${s}.json`)); } catch (err) { fetched[s] = { error: err.message }; }
  });
  let introCount = 0, glued = 0, empty = 0, dup = 0, tooLong = 0, short = [], withCr = 0, withTag = 0, maxLen = 0;
  for (let s = 1; s <= 114; s++) {
    const f = fetched[s];
    if (!Array.isArray(f)) { problems.push(`surah ${s}: download failed (${f?.error ?? 'bad response'})`); tafsir.push([]); continue; }
    if (f.length !== COUNTS[s - 1]) problems.push(`surah ${s}: ${f.length} tafsir entries, expected ${COUNTS[s - 1]}`);
    const row = [];
    for (let n = 1; n <= COUNTS[s - 1]; n++) {
      const e = f[n - 1];
      if (!e || e.surah !== s || e.ayah !== n || typeof e.text !== 'string') { problems.push(`${s}:${n}: entry missing or mislabeled (${e ? `${e.surah}:${e.ayah}` : 'none'})`); row.push(''); continue; }
      let text = e.text.trim();
      if (n === 1 && /^تسمية السورة/.test(text)) {
        const r = splitIntro(text);
        if (r.error) { glued++; problems.push(`${s}:1: surah-introduction block cannot be split safely (${r.error})`); }
        else { intro[s] = r.intro; text = r.tafsir; introCount++; }
      }
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
  if (introCount !== 114 && !glued) say(`  info: the other ${114 - introCount} surahs have no introduction block`);
  say(`  info: longest tafsir entry is ${maxLen} characters; ${tooLong} exceed the ${EMBED_LIMIT} embed limit and would need splitting`);
  say(`  info: ${dup} ayahs share an identical tafsir with the previous ayah: Muyassar comments on groups of ayahs (e.g. 2:45-46), so the same text is repeated for each ayah of the group`);
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
  return { tafsir, intro, tafsirOk: !problems.length && !empty && alignOk };
}

/* ---------------- spot samples ---------------- */
function samples(quran, tafsir, intro) {
  head('Samples to compare with a trusted mushaf and tafsir book');
  const picks = [[1, 1], [1, 7], [2, 255], [2, 282], [9, 1], [18, 10], [112, 1], [114, 6]];
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
async function headSize(url) {
  let res = await fetchRetry(url, { method: 'HEAD' });
  if (res.status === 405 || res.status === 501) res = await fetchRetry(url, { headers: { Range: 'bytes=0-0' } });
  const len = Number((res.headers.get('content-range') || '').split('/')[1] || res.headers.get('content-length') || 0);
  return { status: res.status, bytes: len, type: res.headers.get('content-type') || '' };
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
    if (probe.status !== 200) { fail(`${r.name}: folder "${r.folder}" does not serve 001001.mp3 (${probe.err ?? `HTTP ${probe.status}`}). Fix the folder name at the top of the script.`); continue; }
    const results = cache[r.folder] || (cache[r.folder] = {});
    const todo = [];
    for (let s = 1; s <= 114; s++) for (let n = 1; n <= COUNTS[s - 1]; n++) if (!results[`${pad3(s)}${pad3(n)}`]) todo.push([s, n]);
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
    // failures are retried on the next run instead of being remembered as good
    for (const id of Object.keys(results)) if (results[id].status !== 200) { /* keep for the report below */ }
    fs.mkdirSync(DATA, { recursive: true });
    const good = {};
    for (const [id, v] of Object.entries(results)) if (v.status === 200) good[id] = v;
    const missing = [], tiny = [], odd = [];
    for (let s = 1; s <= 114; s++) for (let n = 1; n <= COUNTS[s - 1]; n++) {
      const id = `${pad3(s)}${pad3(n)}`;
      const v = results[id];
      if (!v || v.status !== 200) missing.push(`${s}:${n} (${v ? `HTTP ${v.status} ${v.type}`.trim() : 'not checked'})`);
      else { if (v.bytes < 8000) tiny.push(`${s}:${n} (${v.bytes} bytes)`); if (!/audio|mpeg|octet/i.test(v.type)) odd.push(`${s}:${n} (${v.type})`); }
    }
    cache[r.folder] = good; // only verified files are remembered
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    if (!missing.length) ok(`${r.name}: all 6,236 files exist`); else { fail(`${r.name}: ${missing.length} files missing`); for (const m of missing.slice(0, 30)) say(`    ${m}`); }
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
      if (Number(m.surah_total) < 114 || tested >= 4) continue;
      tested++;
      const server = m.server.endsWith('/') ? m.server : `${m.server}/`;
      const sizes = new Array(115).fill(0);
      const bad = [];
      await pool(Array.from({ length: 114 }, (_, i) => i + 1), 6, async (s) => {
        try { const h = await headSize(`${server}${pad3(s)}.mp3`); if (h.status === 200 && h.bytes > 50000) sizes[s] = h.bytes; else bad.push(`${s} (HTTP ${h.status})`); } catch (err) { bad.push(`${s} (${err.message})`); }
      });
      const over = sizes.map((b, s) => ({ b, s })).filter((x) => x.b > DISCORD_UPLOAD_LIMIT).length;
      const total = sizes.reduce((a, b) => a + b, 0);
      if (!bad.length) { anyComplete = true; ok(`${r.name} / "${m.name}": all 114 surahs exist (${(total / 1048576).toFixed(0)} MB total). ${114 - over} fit under the upload limit, ${over} need a link instead of an attachment`); }
      else warn(`${r.name} / "${m.name}": ${bad.length} surahs failed: ${bad.slice(0, 10).join(', ')}`);
    }
    if (!anyComplete) fail(`${r.name}: no complete 114-surah recording found on mp3quran.net`);
  }
  say('  note: the owner must listen to a few full-surah files and confirm each is the same reciter as the per-ayah recordings.');
}

/* ---------------- main ---------------- */
(async () => {
  say(`Nakhtim data verification  |  ${new Date().toISOString()}  |  node ${process.version}`);
  const quran = await checkText().catch((e) => { fail(`text check crashed: ${e.message}`); return null; });
  const taf = quran ? await checkTafsir(quran).catch((e) => { fail(`tafsir check crashed: ${e.message}`); return null; }) : null;
  if (quran && taf) samples(quran, taf.tafsir, taf.intro);
  if (DO_AUDIO) await checkAudio().catch((e) => fail(`audio check crashed: ${e.message}`));
  if (DO_FULL) await checkFullSurah().catch((e) => fail(`full-surah check crashed: ${e.message}`));

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
  say(`  ${failures} failure(s), ${warnings} warning(s). ${failures ? 'NOT approved: do not publish.' : 'All run checks passed. Still read the samples and warnings yourself.'}`);
  if (!DO_AUDIO) say('  (audio not checked in this run: use --audio)');
  if (!DO_FULL) say('  (full-surah audio not checked in this run: use --fullsurah)');
  fs.writeFileSync(REPORT_FILE, lines.join('\n') + '\n');
  console.log(`\nReport saved to ${REPORT_FILE}`);
  process.exit(failures ? 1 : 0);
})();
