/* -------- SHARH STORE (data/sharh.jsonl + data/sharh-index.json) --------
   Same layout as the hadith pool: one JSON record per line plus byte offsets, read from disk on demand.
   Built by scripts/build-sharh.js. If the files do not exist the feature simply stays off (no throw). */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function createSharhStore(dir = DATA_DIR) {
  const file = path.join(dir, 'sharh.jsonl');
  const indexFile = path.join(dir, 'sharh-index.json');
  let index = null; // Map hadith id -> [byteOffset, byteLength]

  function load() {
    if (index) return index;
    index = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (fs.existsSync(file)) for (const [id, offset, length] of raw.entries) index.set(id, [offset, length]);
    } catch { /* not built yet */ }
    return index;
  }

  const available = () => load().size > 0;
  const has = (id) => load().has(id);
  const size = () => load().size;

  function get(id) {
    const entry = load().get(id);
    if (!entry) return null;
    const [offset, length] = entry;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      return JSON.parse(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }

  return { available, has, size, get };
}

module.exports = { createSharhStore };
