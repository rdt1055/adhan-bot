/* -------- MUSHAF AYAH IMAGE RENDERER (zero-dependency pure-Node PNG cropper + parchment recolorer) --------
   Fetches high-resolution Uthmani calligraphy PNGs, trims excessive side margins,
   centers the ayah on warm parchment (#fbf6ea with #1a1a1a ink) so every diacritic and waqf mark
   is crisp and readable in both Discord Dark Mode and Light Mode. */
const zlib = require('zlib');

const AYAH_IMAGE_BASE = process.env.NAKHTIM_IMAGES_BASE || 'https://cdn.islamic.network/quran/images/high-resolution';
const PARCHMENT_BG = [251, 246, 234]; // #fbf6ea
const PARCHMENT_FG = [26, 26, 26];    // #1a1a1a
const PAD_X = 48;
const PAD_Y = 36;
const MIN_WIDTH = 560;

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterPass(raw, offset, passW, passH, bitDepth) {
  const rowBytes = Math.ceil((passW * bitDepth) / 8);
  const pixels = new Uint8Array(passW * passH);
  const ppb = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  let prevRow = null;

  for (let y = 0; y < passH; y++) {
    const filter = raw[offset++];
    const curRow = new Uint8Array(rowBytes);

    for (let x = 0; x < rowBytes; x++) {
      const a = x >= 1 ? curRow[x - 1] : 0;
      const b = prevRow ? prevRow[x] : 0;
      const c = (prevRow && x >= 1) ? prevRow[x - 1] : 0;
      const val = raw[offset++];

      if (filter === 0) curRow[x] = val;
      else if (filter === 1) curRow[x] = (val + a) & 0xff;
      else if (filter === 2) curRow[x] = (val + b) & 0xff;
      else if (filter === 3) curRow[x] = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) curRow[x] = (val + paethPredictor(a, b, c)) & 0xff;
      else throw new Error(`Unsupported PNG filter ${filter}`);
    }

    const rowOffset = y * passW;
    if (bitDepth === 8) {
      pixels.set(curRow.subarray(0, passW), rowOffset);
    } else {
      for (let x = 0; x < passW; x++) {
        const byteVal = curRow[Math.floor(x / ppb)];
        const shift = 8 - bitDepth * ((x % ppb) + 1);
        pixels[rowOffset + x] = (byteVal >> shift) & mask;
      }
    }
    prevRow = curRow;
  }

  return { pixels, nextOffset: offset };
}

function decodeIndexedPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null;
  let trns = Buffer.alloc(0);
  const idatParts = [];

  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (colorType !== 3 || !palette || ![1, 2, 4, 8].includes(bitDepth) || (interlace !== 0 && interlace !== 1)) {
    throw new Error(`Unsupported PNG format (colorType=${colorType}, bitDepth=${bitDepth}, interlace=${interlace})`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const pixels = new Uint8Array(width * height);

  if (interlace === 0) {
    const { pixels: flat } = unfilterPass(raw, 0, width, height, bitDepth);
    pixels.set(flat);
  } else {
    let offset = 0;
    for (const [sx, sy, dx, dy] of ADAM7) {
      if (width <= sx || height <= sy) continue;
      const passW = Math.ceil((width - sx) / dx);
      const passH = Math.ceil((height - sy) / dy);
      if (passW <= 0 || passH <= 0) continue;

      const pass = unfilterPass(raw, offset, passW, passH, bitDepth);
      offset = pass.nextOffset;
      for (let py = 0; py < passH; py++) {
        const dstRow = (sy + py * dy) * width;
        const srcRow = py * passW;
        for (let px = 0; px < passW; px++) {
          pixels[dstRow + sx + px * dx] = pass.pixels[srcRow + px];
        }
      }
    }
  }

  return { width, height, palette, trns, pixels };
}

function encodeIndexedPng(width, height, palette, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit indexed
  ihdr[9] = 3; // palette
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter None
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(raw, y * stride + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIG,
    makeChunk('IHDR', ihdr),
    makeChunk('PLTE', palette),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function renderParchmentAyahPng(rawPngBuf) {
  const { width, height, palette, trns, pixels } = decodeIndexedPng(rawPngBuf);
  const numColors = Math.floor(palette.length / 3);
  const inkAlpha = new Float32Array(numColors);
  const recolored = Buffer.alloc(Math.min(numColors + 1, 256) * 3);
  let bgIndex = -1;

  for (let i = 0; i < numColors; i++) {
    const r = palette[i * 3];
    const g = palette[i * 3 + 1];
    const b = palette[i * 3 + 2];
    const alpha = (i < trns.length ? trns[i] : 255) / 255;
    const gray = (r + g + b) / (3 * 255);
    const t = Math.max(0, Math.min(1, (1 - gray) * alpha));
    inkAlpha[i] = t;

    if (t < 0.01 && bgIndex === -1) bgIndex = i;
    recolored[i * 3] = Math.round(PARCHMENT_BG[0] + (PARCHMENT_FG[0] - PARCHMENT_BG[0]) * t);
    recolored[i * 3 + 1] = Math.round(PARCHMENT_BG[1] + (PARCHMENT_FG[1] - PARCHMENT_BG[1]) * t);
    recolored[i * 3 + 2] = Math.round(PARCHMENT_BG[2] + (PARCHMENT_FG[2] - PARCHMENT_BG[2]) * t);
  }

  let outPalette = recolored.subarray(0, numColors * 3);
  if (bgIndex === -1) {
    bgIndex = numColors < 256 ? numColors : 0;
    if (numColors < 256) {
      recolored[bgIndex * 3] = PARCHMENT_BG[0];
      recolored[bgIndex * 3 + 1] = PARCHMENT_BG[1];
      recolored[bgIndex * 3 + 2] = PARCHMENT_BG[2];
      outPalette = recolored;
    }
  }

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (inkAlpha[pixels[row + x]] > 0.02) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return rawPngBuf;

  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  const outW = Math.max(contentW + PAD_X * 2, MIN_WIDTH);
  const outH = contentH + PAD_Y * 2;
  const destX = Math.floor((outW - contentW) / 2);
  const destY = PAD_Y;

  const outPixels = new Uint8Array(outW * outH);
  outPixels.fill(bgIndex);
  for (let y = 0; y < contentH; y++) {
    const srcStart = (minY + y) * width + minX;
    const dstStart = (destY + y) * outW + destX;
    for (let x = 0; x < contentW; x++) {
      const idx = pixels[srcStart + x];
      if (inkAlpha[idx] > 0.005) outPixels[dstStart + x] = idx;
    }
  }

  return encodeIndexedPng(outW, outH, outPalette, outPixels);
}

const pad3 = (n) => String(n).padStart(3, '0');

function ayahImageUrl(s, a) {
  return `${AYAH_IMAGE_BASE}/${s}_${a}.png`;
}

function createAyahImageLoader({ fetchImpl = global.fetch, maxCache = 120 } = {}) {
  const cache = new Map(); // `${s}:${a}` -> Buffer

  async function getAyahImage(s, a) {
    const key = `${s}:${a}`;
    const filename = `ayah-${pad3(s)}-${pad3(a)}.png`;

    if (cache.has(key)) {
      const cached = cache.get(key);
      cache.delete(key);
      cache.set(key, cached);
      return { buffer: cached, filename };
    }

    try {
      const res = await fetchImpl(ayahImageUrl(s, a), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        await res.body?.cancel?.().catch(() => {});
        return null;
      }
      const rawBuf = Buffer.from(await res.arrayBuffer());
      const outBuf = renderParchmentAyahPng(rawBuf);
      if (cache.size >= maxCache) cache.delete(cache.keys().next().value);
      cache.set(key, outBuf);
      return { buffer: outBuf, filename };
    } catch {
      return null;
    }
  }

  return { getAyahImage };
}

module.exports = {
  AYAH_IMAGE_BASE,
  PARCHMENT_BG,
  PARCHMENT_FG,
  ayahImageUrl,
  decodeIndexedPng,
  renderParchmentAyahPng,
  createAyahImageLoader
};
