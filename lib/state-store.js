/* -------- SMALL JSON STATE FILES (data/<name>.json) --------
   Separate from serverconfig.json: this is data the bot changes by itself (progress, history).
   Writes go to a temp file first and are then renamed, so a crash can't leave a half-written file. */
const fs = require('fs');
const path = require('path');
const { logTimestamp } = require('./log');

const DATA_DIR = path.join(__dirname, '..', 'data');

function createStateStore(fileName, defaults, dir = DATA_DIR) {
  const file = path.join(dir, fileName);
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      cache = { ...structuredClone(defaults), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // unreadable/corrupt file: keep it for inspection and start fresh
        try {
          fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
          logTimestamp(`State file ${fileName} was unreadable (${err.message}); moved aside and reset.`);
        } catch {}
      }
      cache = structuredClone(defaults);
    }
    return cache;
  }

  function save() {
    load();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    get data() { return load(); },
    save
  };
}

module.exports = { createStateStore };
