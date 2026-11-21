/* -------- HADITH POOL (data/hadith-pool.jsonl + data/hadith-index.json) --------
   One JSON record per line, plus a small index of byte offsets. A hadith is read straight from
   disk when needed, so the whole ~20 MB file is never loaded into memory. */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function createPool(dir = DATA_DIR) {
  const poolFile = path.join(dir, 'hadith-pool.jsonl');
  const indexFile = path.join(dir, 'hadith-index.json');
  let index = null; // Map id -> [byteOffset, byteLength]

  function load() {
    if (index) return;
    if (!fs.existsSync(poolFile) || !fs.existsSync(indexFile)) {
      const err = new Error('Hadith pool not found. Build it with: node scripts/build-hadith-pool.js');
      err.code = 'POOL_MISSING';
      throw err;
    }
    const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index = new Map(raw.entries.map(([id, offset, length]) => [id, [offset, length]]));
  }

  function size() { load(); return index.size; }
  function has(id) { load(); return index.has(id); }
  function ids() { load(); return [...index.keys()]; }

  function get(id) {
    load();
    const entry = index.get(id);
    if (!entry) return null;
    const [offset, length] = entry;
    const fd = fs.openSync(poolFile, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      return JSON.parse(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }

  // Random id that is not in `used` (and, when given, accepted by `eligible(id)`).
  // When everything eligible has been used, starts over (reset = true).
  function pickRandom(used = new Set(), eligible = null) {
    load();
    let all = [...index.keys()];
    if (eligible) {
      const filtered = all.filter(eligible);
      if (filtered.length > 0) all = filtered; // nothing eligible at all: fall back to the whole pool
    }
    let candidates = all.filter((id) => !used.has(id));
    let reset = false;
    if (candidates.length === 0) { candidates = all; reset = true; }
    return { id: candidates[Math.floor(Math.random() * candidates.length)], reset };
  }

  return { size, has, ids, get, pickRandom };
}

module.exports = { createPool };
