/* -------- QURAN & TAFSIR STORE (data/quran.json, data/tafsir-muyassar.json, optional data/surah-pdfs.json) --------
   Loads verified local Nakhtim datasets lazily into memory. Stays dormant when missing. */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function createQuranStore(dir = DATA_DIR) {
  const quranFile = path.join(dir, 'quran.json');
  const tafsirFile = path.join(dir, 'tafsir-muyassar.json');
  const pdfFile = path.join(dir, 'surah-pdfs.json');
  const juzPdfFile = path.join(dir, 'juz-pdfs.json');

  let state = null; // { surahs, intro, tafsir, tafsirSource, pdfUrls, juzData }

  function readOptionalPdfUrls() {
    try {
      const raw = JSON.parse(fs.readFileSync(pdfFile, 'utf8'));
      if (Array.isArray(raw?.urls) && raw.urls.length === 114 && raw.urls.every((u) => typeof u === 'string' && u)) {
        return raw.urls;
      }
    } catch {}
    return null;
  }

  function readOptionalJuzData() {
    try {
      const raw = JSON.parse(fs.readFileSync(juzPdfFile, 'utf8'));
      if (Array.isArray(raw?.ajza) && raw.ajza.length === 30 && raw?.fullQuran?.url) {
        return raw;
      }
    } catch {}
    return null;
  }

  function load() {
    if (state) return state;
    if (!fs.existsSync(quranFile) || !fs.existsSync(tafsirFile)) {
      const err = new Error('Nakhtim data not found. Build it with: node scripts/verify-nakhtim-data.js');
      err.code = 'DATA_MISSING';
      throw err;
    }

    const q = JSON.parse(fs.readFileSync(quranFile, 'utf8'));
    const t = JSON.parse(fs.readFileSync(tafsirFile, 'utf8'));
    if (!Array.isArray(q?.surahs) || q.surahs.length !== 114 || !Array.isArray(t?.tafsir) || t.tafsir.length !== 114) {
      const err = new Error('Nakhtim data is invalid or incomplete.');
      err.code = 'DATA_INVALID';
      throw err;
    }

    state = {
      surahs: q.surahs,
      intro: t.intro || {},
      tafsir: t.tafsir,
      tafsirSource: t.source || 'التفسير الميسر',
      pdfUrls: readOptionalPdfUrls(),
      juzData: readOptionalJuzData()
    };
    return state;
  }

  function available() {
    try { load(); return true; } catch { return false; }
  }

  function pdfsAvailable() {
    try { return Boolean(load().pdfUrls); } catch { return false; }
  }

  function ajzaAvailable() {
    try { return Boolean(load().juzData?.ajza?.length === 30); } catch { return false; }
  }

  function isValidSurah(s) {
    return Number.isInteger(s) && s >= 1 && s <= 114;
  }

  function getSurah(s) {
    const data = load();
    if (!isValidSurah(s)) return null;
    const surah = data.surahs[s - 1];
    if (!surah) return null;
    return { n: s, name: surah.name, ayahCount: surah.ayahs.length };
  }

  function getAyah(s, a) {
    const data = load();
    if (!isValidSurah(s)) return null;
    const surah = data.surahs[s - 1];
    if (!surah || !Number.isInteger(a) || a < 1 || a > surah.ayahs.length) return null;
    return {
      s,
      a,
      surahName: surah.name,
      ayahCount: surah.ayahs.length,
      text: surah.ayahs[a - 1]
    };
  }

  function getIntro(s) {
    const data = load();
    if (!isValidSurah(s)) return null;
    return data.intro[String(s)] || null;
  }

  function getTafsir(s, a) {
    const data = load();
    if (!isValidSurah(s)) return null;
    const surah = data.surahs[s - 1];
    const row = data.tafsir[s - 1];
    if (!surah || !Array.isArray(row) || !Number.isInteger(a) || a < 1 || a > row.length) return null;

    const text = row[a - 1];
    if (!text) return null;

    let startAyah = a;
    let endAyah = a;
    while (startAyah > 1 && row[startAyah - 2] === text) startAyah--;
    while (endAyah < row.length && row[endAyah] === text) endAyah++;

    return {
      s,
      a,
      surahName: surah.name,
      text,
      startAyah,
      endAyah,
      source: data.tafsirSource
    };
  }

  function getSurahPdfUrl(s) {
    if (!isValidSurah(s)) return null;
    try { return load().pdfUrls?.[s - 1] ?? null; } catch { return null; }
  }

  function getJuzEndingAt(s, a) {
    try {
      const ajza = load().juzData?.ajza;
      if (!Array.isArray(ajza)) return null;
      return ajza.find((j) => j.end?.[0] === s && j.end?.[1] === a) ?? null;
    } catch {
      return null;
    }
  }

  function getFullQuranPdf() {
    try { return load().juzData?.fullQuran ?? null; } catch { return null; }
  }

  function nextPosition(s, a) {
    const surah = getSurah(s);
    if (!surah || !Number.isInteger(a) || a < 1 || a > surah.ayahCount) return null;

    if (a < surah.ayahCount) {
      return { s, a: a + 1, crossedSurah: false, wrapped: false, isLastOfSurah: (a + 1) === surah.ayahCount };
    }
    if (s < 114) {
      return { s: s + 1, a: 1, crossedSurah: true, wrapped: false, isLastOfSurah: false };
    }
    return { s: 1, a: 1, crossedSurah: true, wrapped: true, isLastOfSurah: false };
  }

  function prevPosition(s, a) {
    const data = load();
    const surah = getSurah(s);
    if (!surah || !Number.isInteger(a) || a < 1 || a > surah.ayahCount) return null;
    if (s === 1 && a === 1) return null;

    if (a > 1) return { s, a: a - 1, crossedSurah: false };
    return { s: s - 1, a: data.surahs[s - 2].ayahs.length, crossedSurah: true };
  }

  return {
    available,
    pdfsAvailable,
    ajzaAvailable,
    load,
    getSurah,
    getAyah,
    getIntro,
    getTafsir,
    getSurahPdfUrl,
    getJuzEndingAt,
    getFullQuranPdf,
    nextPosition,
    prevPosition
  };
}

module.exports = { createQuranStore };
