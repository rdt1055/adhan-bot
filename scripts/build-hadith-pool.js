/* Builds data/hadith-pool.jsonl + data/hadith-index.json (Arabic only) for the daily hadith feature.

   Source: the open hadith-api project (Unlicense): Sahih al-Bukhari and Sahih Muslim, the
   diacritized Arabic edition. The English editions are used ONLY to detect entries that are just a
   cross-reference ("the same hadith through another chain"); no English is stored or shown.

   Usage:  node scripts/build-hadith-pool.js
           node scripts/build-hadith-pool.js --from-dir <folder with the 4 downloaded .json files> */
const fs = require('fs');
const path = require('path');
const { splitText, cleanHadithText } = require('../lib/split-text');

const BASES = [
  'https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions',
  'https://raw.githubusercontent.com/fawazahmed0/hadith-api/1/editions'
];
const COLLECTIONS = [
  { key: 'bukhari', arabic: 'ara-bukhari', english: 'eng-bukhari' },
  { key: 'muslim', arabic: 'ara-muslim', english: 'eng-muslim' }
];
const MAX_MESSAGES = 3; // a hadith may span at most this many messages
const OUT_DIR = path.join(__dirname, '..', 'data');

const XREF = /(same chain|another chain|different chain|this chain|similar hadith|same hadith|same effect|same words|same narrat|with a slight|slight variation|in the same way|has been (narrated|reported|transmitted) (through|with|by|on the authority)|the same as|similar to)/i;
const stripMarks = (s) => s.replace(/[\u064B-\u065F\u0670\u0640]/g, '');
const AR_XREF = /(بهذا الاسناد|بنحوه|بمثله|نحوه|مثله|بمعناه)/;

async function loadEdition(name, fromDir) {
  if (fromDir) return JSON.parse(fs.readFileSync(path.join(fromDir, `${name}.json`), 'utf8'));
  let lastErr;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/${name}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) { lastErr = err; }
  }
  throw new Error(`Could not download ${name}: ${lastErr.message}`);
}

// Short entries that only point at another narration ("...so he mentioned the hadith")
const AR_FRAGMENT = /(فذكر الحديث|فذكر نحوه|فذكر مثله|بمثل حديث|بنحو حديث|بمعنى حديث|وساق الحديث|فذكر القصة)/;

function isCrossReference(arabic, english) {
  if (english.length < 70) return true;
  if (arabic.length < 350 && AR_FRAGMENT.test(stripMarks(arabic))) return true;
  if (english.length < 400 && XREF.test(english)) return true;
  if (arabic.length < 500 && AR_XREF.test(stripMarks(arabic)) && english.length < 400) return true;
  return false;
}

async function main() {
  const dirIdx = process.argv.indexOf('--from-dir');
  const fromDir = dirIdx > -1 ? process.argv[dirIdx + 1] : null;

  const records = [];
  for (const col of COLLECTIONS) {
    console.log(`\n== ${col.key} ==`);
    const [ar, en] = await Promise.all([loadEdition(col.arabic, fromDir), loadEdition(col.english, fromDir)]);
    const enByNumber = new Map(en.hadiths.map((h) => [h.hadithnumber, h.text ?? '']));

    const skipped = { fractionalNumber: 0, emptyArabic: 0, noEnglish: 0, crossReference: 0, noCitationNumber: 0, tooLong: 0 };
    let kept = 0;

    for (const h of ar.hadiths) {
      if (!Number.isInteger(h.hadithnumber)) { skipped.fractionalNumber++; continue; }
      const text = cleanHadithText(h.text ?? '');
      if (!text) { skipped.emptyArabic++; continue; }
      const english = (enByNumber.get(h.hadithnumber) ?? '').trim();
      if (!english) { skipped.noEnglish++; continue; }
      if (isCrossReference(text, english)) { skipped.crossReference++; continue; }

      // The number people cite: Bukhari = hadith number; Muslim = Muhammad Fuad Abd al-Baqi number
      // (the file stores it as text, e.g. "8.01" = number 8, first chain of transmission)
      const abdAlBaqi = h.arabicnumber == null ? NaN : parseFloat(h.arabicnumber);
      let ref = null;
      if (Number.isFinite(abdAlBaqi)) {
        ref = col.key === 'bukhari'
          ? (abdAlBaqi === h.hadithnumber ? h.hadithnumber : null)
          : Math.floor(abdAlBaqi);
      }
      if (!ref) { skipped.noCitationNumber++; continue; }

      if (splitText(text).length > MAX_MESSAGES) { skipped.tooLong++; continue; }

      records.push({ id: `${col.key}:${h.hadithnumber}`, c: col.key, n: h.hadithnumber, r: ref, t: text });
      kept++;
    }
    console.log(`in file: ${ar.hadiths.length} | kept: ${kept}`);
    console.log('skipped:', JSON.stringify(skipped));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const lines = [];
  const entries = [];
  let offset = 0;
  for (const rec of records) {
    const line = JSON.stringify(rec) + '\n';
    const length = Buffer.byteLength(line, 'utf8');
    entries.push([rec.id, offset, length - 1]); // -1: the newline is not part of the record
    lines.push(line);
    offset += length;
  }
  fs.writeFileSync(path.join(OUT_DIR, 'hadith-pool.jsonl'), lines.join(''));
  fs.writeFileSync(path.join(OUT_DIR, 'hadith-index.json'), JSON.stringify({
    version: 1,
    built: new Date().toISOString(),
    source: 'fawazahmed0/hadith-api (ara-bukhari, ara-muslim)',
    count: entries.length,
    entries
  }));
  console.log(`\nWrote ${entries.length} hadiths -> data/hadith-pool.jsonl (${(offset / 1048576).toFixed(1)} MB) + data/hadith-index.json`);
}

main().catch((err) => { console.error('Build failed:', err.message); process.exit(1); });
