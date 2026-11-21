/* Offline unit & lifecycle tests for Nakhtim (never connects to Discord or reads .env).
   Usage (cmd): node scripts\test-nakhtim.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const adhan = require('../adhan');
const ahadith = require('../ahadith');
const nakhtim = require('../nakhtim');
const { createQuranStore } = require('../lib/quran-store');
const ayahImage = require('../lib/ayah-image');
const embeds = require('../nakhtim-embeds');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (let i = 0; i < body.length; i++) c = CRC_TABLE[(c ^ body[i]) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function makeSynthetic4BitAdam7Png(width, height, inkBox) {
  const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const pixels = new Uint8Array(width * height);
  for (let y = inkBox.y0; y <= inkBox.y1; y++) {
    for (let x = inkBox.x0; x <= inkBox.x1; x++) pixels[y * width + x] = 15;
  }

  const rawRows = [];
  for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil(pw / 2);
    for (let py = 0; py < ph; py++) {
      const row = Buffer.alloc(1 + rowBytes);
      const imgY = y0 + py * dy;
      for (let px = 0; px < pw; px++) {
        const val = pixels[imgY * width + (x0 + px * dx)] & 0x0f;
        const bIdx = 1 + (px >> 1);
        row[bIdx] |= (px & 1) === 0 ? (val << 4) : val;
      }
      rawRows.push(row);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 4; // 4-bit indexed
  ihdr[9] = 3; // indexed color
  ihdr[12] = 1; // Adam7 interlace

  const plte = Buffer.alloc(16 * 3);
  plte[15 * 3] = 0; plte[15 * 3 + 1] = 0; plte[15 * 3 + 2] = 0;
  const trns = Buffer.from([0]);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('tRNS', trns),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rawRows))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function embedLength(embedJson) {
  let len = 0;
  if (embedJson.title) len += embedJson.title.length;
  if (embedJson.description) len += embedJson.description.length;
  if (embedJson.footer?.text) len += embedJson.footer.text.length;
  if (embedJson.author?.name) len += embedJson.author.name.length;
  for (const f of embedJson.fields || []) len += (f.name?.length || 0) + (f.value?.length || 0);
  return len;
}

function makeFakeFetch(sizeMap = {}, streamTooBigUrls = new Set()) {
  const cancelled = [];
  const fn = async (url, opts = {}) => {
    const size = sizeMap[url] ?? 1024;
    const bodyBuf = Buffer.from('FAKE_MEDIA_' + url.slice(-16));
    const headers = new Map([['content-length', streamTooBigUrls.has(url) ? '0' : String(size)]]);
    if (opts.method === 'HEAD') {
      return { ok: true, status: 200, headers, body: { cancel: async () => {} } };
    }
    if (streamTooBigUrls.has(url)) {
      let step = 0;
      return {
        ok: true,
        status: 200,
        headers,
        body: {
          getReader() {
            return {
              async read() {
                if (step++ < 25) return { value: Buffer.alloc(1024 * 1024), done: false };
                return { value: undefined, done: true };
              },
              async cancel() { cancelled.push(url); }
            };
          }
        }
      };
    }
    return {
      ok: true,
      status: 200,
      headers,
      body: { cancel: async () => {} },
      arrayBuffer: async () => bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength)
    };
  };
  fn.cancelled = cancelled;
  return fn;
}

function makeFakeDmChannel() {
  const messages = new Map();
  let seq = 1;
  const channel = {
    id: 'dm-1',
    sent: [],
    liveOrder: [],
    deletedIds: [],
    messages: {
      has(id) { return messages.has(id); },
      async fetch(id) {
        const msg = messages.get(id);
        if (!msg) throw new Error('Unknown Message');
        return msg;
      },
      async delete(id) {
        if (!messages.has(id)) throw new Error('Unknown Message');
        messages.delete(id);
        channel.deletedIds.push(id);
        channel.liveOrder = channel.liveOrder.filter((x) => x !== id);
      }
    },
    async send(payload) {
      const id = `msg-${seq++}`;
      const record = {
        id,
        payload,
        edits: [],
        get embeds() { return record.payload?.embeds || []; },
        async edit(nextPayload) {
          record.payload = { ...record.payload, ...nextPayload };
          record.edits.push(nextPayload);
          return record;
        },
        async delete() {
          await channel.messages.delete(id);
        }
      };
      messages.set(id, record);
      channel.sent.push(record);
      channel.liveOrder.push(id);
      return record;
    }
  };
  return channel;
}

function makeFakeButtonInteraction({ customId, userId = 'u1', guildId = null, dmChannel, message = null, canDm = true }) {
  const calls = { replies: [], updates: [], defers: 0, deferType: null, edits: [], dms: [] };
  const targetMsg = message;
  const user = {
    id: userId,
    async createDM() { return dmChannel; },
    async send(payload) {
      if (!canDm) {
        const err = new Error('Cannot send messages to this user');
        err.code = 50007;
        throw err;
      }
      const msg = await dmChannel.send(payload);
      calls.dms.push(msg);
      return msg;
    }
  };
  return {
    customId,
    user,
    message: targetMsg,
    guild: guildId ? { id: guildId } : null,
    channel: dmChannel ?? null,
    channelId: dmChannel?.id ?? 'ch1',
    replied: false,
    deferred: false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => false,
    async reply(p) { this.replied = true; calls.replies.push(p); return p; },
    async followUp(p) { calls.replies.push(p); return p; },
    async deferUpdate() { this.deferred = true; calls.defers++; calls.deferType = 'update'; },
    async deferReply(p) { this.deferred = true; calls.defers++; calls.deferType = 'reply'; calls.deferFlags = p?.flags; },
    async editReply(p) {
      calls.edits.push(p);
      if (calls.deferType === 'update' && targetMsg?.edit) return targetMsg.edit(p);
      return p;
    },
    async update(p) {
      this.replied = true;
      calls.updates.push(p);
      if (targetMsg?.edit) return targetMsg.edit(p);
      return p;
    },
    _calls: calls
  };
}

function makeFakeSelectInteraction({ customId, values, userId = 'u1', dmChannel, message = null, canDm = true }) {
  const base = makeFakeButtonInteraction({ customId, userId, dmChannel, message, canDm });
  base.values = values;
  base.isButton = () => false;
  base.isStringSelectMenu = () => true;
  return base;
}

async function run() {
  console.log('1. Validating combined slash commands...');
  const allCommands = [
    ...(adhan.slashCommands ?? []),
    ...(ahadith.slashCommands ?? []),
    ...(nakhtim.slashCommands ?? [])
  ];
  const names = allCommands.map((c) => c.name);
  assert.strictEqual(new Set(names).size, names.length, 'Duplicate slash command name found');
  assert(names.includes('nakhtim'), 'nakhtim slash command missing');
  const nakCmd = nakhtim.slashCommands[0];
  assert.strictEqual(nakCmd.name, 'nakhtim');
  assert(Array.isArray(nakCmd.options) && nakCmd.options.length === 3, 'Expected setup/off/status subcommands');
  for (const c of allCommands) {
    assert(typeof c.name === 'string' && /^[\w-]{1,32}$/.test(c.name), `Invalid command name: ${c.name}`);
    assert(typeof c.description === 'string' && c.description.length >= 1 && c.description.length <= 100, `Invalid description: ${c.name}`);
  }
  console.log(`   OK (${allCommands.length} slash commands valid, no duplicates)`);

  console.log('2. Testing lib/ayah-image.js (Adam7 4-bit crop, parchment recolor, LRU cache)...');
  const synth = makeSynthetic4BitAdam7Png(200, 20, { x0: 80, y0: 5, x1: 120, y1: 14 });
  const parchment = ayahImage.renderParchmentAyahPng(synth);
  const decoded = ayahImage.decodeIndexedPng(parchment);
  assert.strictEqual(decoded.width, 560, 'Narrow ayah should pad to MIN_WIDTH=560');
  assert.strictEqual(decoded.height, 10 + 36 * 2, 'Height should tightly wrap glyph + top/bottom padding');
  assert.deepStrictEqual([...decoded.palette.slice(0, 3)], ayahImage.PARCHMENT_BG, 'Palette[0] must be parchment #fbf6ea');
  assert.strictEqual(decoded.trns.length, 0, 'Output parchment PNG must be opaque');
  assert.strictEqual(decoded.pixels[0], 0, 'Corner pixel must be parchment background');
  assert.strictEqual(decoded.pixels[Math.floor(decoded.height / 2) * decoded.width + Math.floor(decoded.width / 2)], 15, 'Center pixel must be dark ink');

  const wideSynth = makeSynthetic4BitAdam7Png(900, 16, { x0: 100, y0: 4, x1: 800, y1: 11 });
  const wideOut = ayahImage.decodeIndexedPng(ayahImage.renderParchmentAyahPng(wideSynth));
  assert.strictEqual(wideOut.width, 701 + 48 * 2, 'Wide glyph should trim blank side margins cleanly');

  let fetchCount = 0;
  const loader = ayahImage.createAyahImageLoader({
    fetchImpl: async (url) => {
      fetchCount++;
      if (url.endsWith('/9_9.png')) return { ok: false, status: 404, body: { cancel: async () => {} } };
      return { ok: true, status: 200, arrayBuffer: async () => synth.buffer.slice(synth.byteOffset, synth.byteOffset + synth.byteLength) };
    }
  });
  const img1 = await loader.getAyahImage(1, 2);
  const img2 = await loader.getAyahImage(1, 2);
  assert(img1 && img1.filename === 'ayah-001-002.png' && Buffer.isBuffer(img1.buffer));
  assert.strictEqual(fetchCount, 1, 'Second request for same ayah must hit LRU cache');
  assert.strictEqual(await loader.getAyahImage(9, 9), null, 'Failed image fetch must return null for text fallback');
  console.log('   OK (Adam7 4-bit PNG cropped, centered, parchment-colored, cached, fallback-safe)');

  console.log('3. Testing quran-store (dormancy, boundaries, 114 surah PDFs, 30 Ajza PDFs, Full Mushaf)...');
  const tmpEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'nakhtim-empty-'));
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'nakhtim-state-'));
  try {
    const dormantStore = createQuranStore(tmpEmpty);
    assert.strictEqual(dormantStore.available(), false);
    assert.strictEqual(dormantStore.pdfsAvailable(), false);
    assert.strictEqual(dormantStore.ajzaAvailable(), false);
    assert.strictEqual(dormantStore.getSurahPdfUrl(1), null);
    assert.strictEqual(dormantStore.getJuzEndingAt(114, 6), null);
    assert.strictEqual(dormantStore.getFullQuranPdf(), null);

    const store = createQuranStore(DATA_DIR);
    assert.strictEqual(store.available(), true);
    assert.strictEqual(store.pdfsAvailable(), true);
    assert.strictEqual(store.ajzaAvailable(), true);
    assert(store.getSurahPdfUrl(1).includes('pdfquran.com/standard1/surah/'));

    assert.strictEqual(store.getAyah(1, 1).text, embeds.BISMILLAH);
    assert(store.getAyah(1, 4).text.includes('\u0670'));
    assert(!store.getAyah(2, 1).text.includes('بسم'));
    assert(!store.getAyah(9, 1).text.includes('بسم'));

    const t245 = store.getTafsir(2, 45);
    const t246 = store.getTafsir(2, 46);
    assert.strictEqual(t245.startAyah, 45);
    assert.strictEqual(t245.endAyah, 46);
    assert.strictEqual(t245.text, t246.text);

    const t811 = store.getTafsir(81, 1);
    const t8114 = store.getTafsir(81, 14);
    assert.strictEqual(t811.startAyah, 1);
    assert.strictEqual(t8114.endAyah, 14);
    assert(!t8114.text.startsWith('تسمية السورة'));

    assert.strictEqual(store.prevPosition(1, 1), null);
    assert.deepStrictEqual(store.prevPosition(2, 1), { s: 1, a: 7, crossedSurah: true });
    assert.deepStrictEqual(store.nextPosition(1, 6), { s: 1, a: 7, crossedSurah: false, wrapped: false, isLastOfSurah: true });
    assert.deepStrictEqual(store.nextPosition(1, 7), { s: 2, a: 1, crossedSurah: true, wrapped: false, isLastOfSurah: false });
    assert.deepStrictEqual(store.nextPosition(114, 6), { s: 1, a: 1, crossedSurah: true, wrapped: true, isLastOfSurah: false });

    const j1 = store.getJuzEndingAt(2, 141);
    const j28 = store.getJuzEndingAt(66, 12);
    const j30 = store.getJuzEndingAt(114, 6);
    assert(j1 && j1.juz === 1 && j1.wholeSurahs.includes(1));
    assert(j28 && j28.juz === 28 && j28.wholeSurahs.includes(58) && j28.wholeSurahs.includes(66));
    assert(j30 && j30.juz === 30 && j30.wholeSurahs.includes(78) && j30.wholeSurahs.includes(114));
    assert.strictEqual(store.getJuzEndingAt(1, 7), null);
    assert(store.getFullQuranPdf()?.url?.includes('MushafMadinaHafsGreen1441.pdf'));
    console.log('   OK (store, boundaries, Ajza, Full Mushaf verified)');

    console.log('4. Checking reciter menu + all 114 intros + 6,236 ayahs + 6,236 tafsirs...');
    const menuJson = embeds.buildReciterMenuRow(embeds.RECITER_SUB_ID).toJSON();
    assert(menuJson.components[0].options.every((o) => o.default !== true), 'Reciter menu must not set default:true');

    const reciter = embeds.getReciter('alafasy');
    let totalAyahs = 0;
    for (let s = 1; s <= 114; s++) {
      const surah = store.getSurah(s);
      const intro = store.getIntro(s);
      assert(intro && intro.length > 0);
      const introPayload = embeds.buildSurahIntroPayload(surah, intro, reciter);
      const introJson = introPayload.embeds[0].toJSON();
      assert(introJson.description.includes('### تسمية السورة'), `Intro ${s} should use ### heading`);
      assert(introJson.description.length <= 4096 && embedLength(introJson) <= 6000);
      const introBtns = introPayload.components.flatMap((r) => r.toJSON().components.map((b) => b.custom_id));
      assert(!introBtns.some((id) => id.includes(':tafsir:') || id.includes(':audio:')));

      for (let a = 1; a <= surah.ayahCount; a++) {
        totalAyahs++;
        const ayahObj = store.getAyah(s, a);
        const textPayload = embeds.buildAyahPayload(ayahObj, reciter, null);
        const ayahJson = textPayload.embeds[0].toJSON();
        assert(ayahJson.description.length <= 4096 && embedLength(ayahJson) <= 6000);
        if (s !== 1 && s !== 9 && a === 1) assert(ayahJson.description.startsWith(embeds.BISMILLAH));
        if (s === 9 && a === 1) assert(!ayahJson.description.includes(embeds.BISMILLAH));
        if (s === 1 && a === 1) assert.strictEqual(ayahJson.description, `### ${embeds.BISMILLAH}`);

        const tafJson = embeds.buildTafsirEmbed(store.getTafsir(s, a)).toJSON();
        assert(tafJson.description.length <= 4096 && embedLength(tafJson) <= 6000);
      }
    }
    const imgPayload = embeds.buildAyahPayload(store.getAyah(2, 1), reciter, { buffer: parchment, filename: 'ayah-002-001.png' });
    assert.strictEqual(imgPayload.files.length, 1);
    assert.strictEqual(imgPayload.embeds[0].toJSON().image.url, 'attachment://ayah-002-001.png');
    assert.strictEqual(imgPayload.embeds[0].toJSON().description, `### ${embeds.BISMILLAH}`);
    assert.strictEqual(totalAyahs, 6236);
    console.log('   OK (no default:true, ### intro headings, image + fallback payloads, 6,236/6,236 valid)');

    console.log('5. Simulating full V2 DM lifecycle (same reciter re-sub, sticky panel, cleanup, Juz collapse, Khatmah)...');
    const serverConfigs = { g1: { nakhtim: { enabled: true, channelId: 'c1' } } };
    const largeAudio2 = embeds.surahAudioUrl(embeds.getReciter('alafasy'), 2);
    const streamAudio3 = embeds.surahAudioUrl(embeds.getReciter('alafasy'), 3);
    const fakeFetch = makeFakeFetch({ [largeAudio2]: 30 * 1024 * 1024 }, new Set([streamAudio3]));

    const feat = nakhtim.createNakhtimFeature({
      dataDir: DATA_DIR,
      stateDir: tmpState,
      getServerConfig: (gid) => serverConfigs[gid] || {},
      setServerConfig: (gid, patch) => { serverConfigs[gid] = { ...(serverConfigs[gid] || {}), ...patch }; },
      fetchImpl: fakeFetch,
      imageLoader: {
        async getAyahImage(s, a) {
          if (s === 1 && a === 3) return null; // force text fallback test on 1:3
          return { buffer: parchment, filename: `ayah-${embeds.pad3(s)}-${embeds.pad3(a)}.png` };
        }
      }
    });

    const dm = makeFakeDmChannel();
    const activePanelId = () => feat._internal.store.data.users.u1?.panelMsgId;

    // Closed DMs
    const closedSel = makeFakeSelectInteraction({ customId: embeds.RECITER_SUB_ID, values: ['alafasy'], dmChannel: dm, canDm: false });
    await feat.onInteraction(closedSel);
    assert(closedSel._calls.edits[0].content.includes('الرسائل الخاصة مغلقة'));
    assert.strictEqual(feat._internal.store.data.users.u1, undefined);

    // Subscribe -> Stop -> Re-subscribe with SAME reciter ('alafasy')
    const sub1 = makeFakeSelectInteraction({ customId: embeds.RECITER_SUB_ID, values: ['alafasy'], dmChannel: dm, canDm: true });
    await feat.onInteraction(sub1);
    const firstPanelId = activePanelId();
    assert.strictEqual(dm.liveOrder[dm.liveOrder.length - 1], firstPanelId);

    const unsubBtn = makeFakeButtonInteraction({ customId: embeds.UNSUB_ID, guildId: 'g1', dmChannel: dm });
    await feat.onInteraction(unsubBtn);
    assert.strictEqual(feat._internal.store.data.users.u1.active, false);

    const subBtn2 = makeFakeButtonInteraction({ customId: embeds.SUB_ID, guildId: 'g1', dmChannel: dm });
    await feat.onInteraction(subBtn2);
    assert(subBtn2._calls.replies[0].content.includes('القارئ السابق: **مشاري العفاسي**'));
    assert(subBtn2._calls.replies[0].components[0].toJSON().components[0].options.every((o) => !o.default));

    const resubSame = makeFakeSelectInteraction({ customId: embeds.RECITER_SUB_ID, values: ['alafasy'], dmChannel: dm, canDm: true });
    await feat.onInteraction(resubSame);
    assert.strictEqual(feat._internal.store.data.users.u1.active, true);
    assert(dm.deletedIds.includes(firstPanelId), 'Old panel should be deleted on fresh subscribe');
    assert.notStrictEqual(activePanelId(), firstPanelId);

    // Start surah 1 -> shows ayah 1:1 with PNG image attached
    let pMsg = await dm.messages.fetch(activePanelId());
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:start:1', dmChannel: dm, message: pMsg }));
    assert.strictEqual(pMsg.payload.files[0].name, 'ayah-001-001.png');

    // Open Tafsir AND Audio on 1:1 -> both sent to DM, reading panel reposted at VERY BOTTOM
    const panelBeforeTemp = activePanelId();
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:tafsir:1:1', dmChannel: dm, message: pMsg }));
    const panelAfterTaf = activePanelId();
    assert.notStrictEqual(panelAfterTaf, panelBeforeTemp);
    assert(dm.deletedIds.includes(panelBeforeTemp), 'Old panel deleted after tafsir repost');
    assert.strictEqual(dm.liveOrder[dm.liveOrder.length - 1], panelAfterTaf, 'Panel must stay at bottom after tafsir');

    pMsg = await dm.messages.fetch(panelAfterTaf);
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:audio:1:1', dmChannel: dm, message: pMsg }));
    const panelAfterAud = activePanelId();
    assert(dm.deletedIds.includes(panelAfterTaf), 'Old panel deleted after audio repost');
    assert.strictEqual(dm.liveOrder[dm.liveOrder.length - 1], panelAfterAud, 'Panel must stay at bottom after audio');
    assert.strictEqual(feat._internal.store.data.users.u1.tempMsgIds.length, 2, 'Tafsir + Audio tracked as temp messages');
    const tempIds = [...feat._internal.store.data.users.u1.tempMsgIds];

    // Next 1:1 -> 1:2: deletes BOTH temp messages (Tafsir + Audio), updates bottom panel
    pMsg = await dm.messages.fetch(panelAfterAud);
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:next:1:1', dmChannel: dm, message: pMsg }));
    for (const tid of tempIds) assert(dm.deletedIds.includes(tid), `Temp msg ${tid} must be deleted on Next`);
    assert.deepStrictEqual(feat._internal.store.data.users.u1.tempMsgIds, []);
    assert.strictEqual(pMsg.payload.files[0].name, 'ayah-001-002.png');

    // Next 1:2 -> 1:3: imageLoader returns null -> clean text fallback without files
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:next:1:2', dmChannel: dm, message: pMsg }));
    assert.strictEqual(pMsg.payload.files.length, 0);
    assert(pMsg.payload.embeds[0].toJSON().description.startsWith('### '));

    // Next 1:6 -> 1:7: sends Surah 1 audio + Surah 1 PDF, reposts panel at bottom
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:next:1:6', dmChannel: dm, message: pMsg }));
    const s1PdfMsgId = feat._internal.store.data.users.u1.surahPdfMsgs['1'];
    assert(s1PdfMsgId, 'Surah 1 PDF msgId must be recorded');
    assert.strictEqual(dm.liveOrder[dm.liveOrder.length - 1], activePanelId(), 'Panel must stay at bottom after surah rewards');

    // Revisit 1:7 does NOT re-send surah rewards
    const sentCountAtS1 = dm.sent.length;
    pMsg = await dm.messages.fetch(activePanelId());
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:prev:1:7', dmChannel: dm, message: pMsg }));
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:next:1:6', dmChannel: dm, message: pMsg }));
    assert.strictEqual(dm.sent.length, sentCountAtS1);

    // Surah 2 large MP3 (>19.5 MiB by Content-Length) link fallback + PDF attach
    pMsg = await dm.messages.fetch(activePanelId());
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:next:2:285', dmChannel: dm, message: pMsg }));
    const s2Audio = dm.sent.find((m) => m.payload.content?.includes(largeAudio2));
    assert(s2Audio && !s2Audio.payload.files);
    assert(feat._internal.store.data.users.u1.surahPdfMsgs['2']);

    // Juz 1 end (2:141 -> 2:142): Juz 1 >20 MiB -> sends link & collapses (deletes) Surah 1 PDF!
    pMsg = await dm.messages.fetch(activePanelId());
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:next:2:141', dmChannel: dm, message: pMsg }));
    assert(dm.deletedIds.includes(s1PdfMsgId), 'Juz 1 completion must collapse Surah 1 PDF');
    assert.strictEqual(feat._internal.store.data.users.u1.surahPdfMsgs['1'], undefined);
    assert(dm.sent.some((m) => m.payload.content?.includes('الجزء 1 كاملاً') && m.payload.content.includes('archive.org')));

    // Juz 28 end (66:12 -> 67:1) collapses wholly contained surah PDFs (e.g. 58) & attaches juz-028-hafs.pdf
    const fakePdf58 = await dm.send({ content: 'surah 58 pdf' });
    feat._internal.store.data.users.u1.surahPdfMsgs['58'] = fakePdf58.id;
    pMsg = await dm.messages.fetch(activePanelId());
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:next:66:12', dmChannel: dm, message: pMsg }));
    assert(dm.deletedIds.includes(fakePdf58.id), 'Juz 28 completion must collapse Surah 58 PDF');
    assert(dm.sent.some((m) => m.payload.files?.[0]?.name === 'juz-028-hafs.pdf'));
    assert.strictEqual(dm.liveOrder[dm.liveOrder.length - 1], activePanelId());

    // Stream byte cap abort test (no Content-Length on Surah 3 audio)
    pMsg = await dm.messages.fetch(activePanelId());
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:next:3:199', dmChannel: dm, message: pMsg }));
    assert(fakeFetch.cancelled.includes(streamAudio3), 'Streaming GET >19.5 MiB must cancel reader early');
    assert(dm.sent.some((m) => m.payload.content?.includes(streamAudio3) && !m.payload.files));

    // Change reciter preserves attachment & edits footer
    pMsg = await dm.messages.fetch(activePanelId());
    const chBtn = makeFakeButtonInteraction({ customId: embeds.CHANGE_RECITER_ID, dmChannel: dm, message: pMsg });
    await feat.onInteraction(chBtn);
    assert(chBtn._calls.replies[0].components[0].toJSON().components[0].options.every((o) => !o.default));
    await feat.onInteraction(makeFakeSelectInteraction({
      customId: `${embeds.RECITER_CHANGE_PREFIX}${pMsg.id}`,
      values: ['husary'],
      dmChannel: dm
    }));
    assert.strictEqual(feat._internal.store.data.users.u1.reciter, 'husary');
    assert(pMsg.payload.embeds[0].toJSON().footer.text.includes('محمود خليل الحصري'));

    // Khatmah wrap (114:6 -> Next): sends Surah 114 audio+PDF (KEPT!), Juz 30 PDF (collapses e.g. 113), Khatmah + Full Mushaf PDF link
    const fakePdf113 = await dm.send({ content: 'surah 113 pdf' });
    feat._internal.store.data.users.u1.surahPdfMsgs['113'] = fakePdf113.id;
    pMsg = await dm.messages.fetch(activePanelId());
    await feat.onInteraction(makeFakeButtonInteraction({ customId: 'nakhtim:next:114:6', dmChannel: dm, message: pMsg }));

    const s114PdfMsg = dm.sent.find((m) => m.payload.files?.[0]?.name === 'surah-114-hafs.pdf');
    assert(s114PdfMsg && !dm.deletedIds.includes(s114PdfMsg.id), 'Surah 114 PDF must be sent AND kept on Khatmah');
    assert(dm.deletedIds.includes(fakePdf113.id), 'Juz 30 must still collapse earlier Juz 30 surahs (e.g. 113)');
    assert(dm.sent.some((m) => m.payload.files?.[0]?.name === 'juz-030-hafs.pdf'));
    const khatmahMsg = dm.sent.find((m) => m.payload.content?.includes('ختمة القرآن الكريم'));
    assert(khatmahMsg && khatmahMsg.payload.content.includes('MushafMadinaHafsGreen1441.pdf'));
    assert.strictEqual(feat._internal.store.data.users.u1.khatmahCount, 1);
    assert.deepStrictEqual(feat._internal.store.data.users.u1.sentSurahs, []);
    assert.deepStrictEqual(feat._internal.store.data.users.u1.sentAjza, []);
    assert.deepStrictEqual(feat._internal.store.data.users.u1.surahPdfMsgs, {});
    assert.strictEqual(feat._internal.store.data.users.u1.surah, 1);
    assert.strictEqual(feat._internal.store.data.users.u1.mode, 'intro');
    assert.strictEqual(dm.liveOrder[dm.liveOrder.length - 1], activePanelId(), 'Panel must stay at bottom after Khatmah');

    // Slash commands: setup, status, off
    const guildChannel = {
      id: 'panel-ch',
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => ({ has: () => true }),
      sent: [],
      async send(p) { this.sent.push(p); return { id: 'panel-msg-1' }; }
    };
    const makeSlash = (sub) => {
      const edits = [];
      return {
        commandName: 'nakhtim',
        guild: { id: 'g2', channels: { fetch: async () => guildChannel } },
        options: { getSubcommand: () => sub, getChannel: () => ({ id: 'panel-ch' }) },
        isButton: () => false,
        isStringSelectMenu: () => false,
        isChatInputCommand: () => true,
        async deferReply() {},
        async editReply(msg) { edits.push(msg); return msg; },
        _edits: edits
      };
    };
    const setupCmd = makeSlash('setup');
    await feat.onInteraction(setupCmd);
    assert(setupCmd._edits[0].includes('تم تفعيل ميزة'));

    const statusCmd = makeSlash('status');
    await feat.onInteraction(statusCmd);
    assert(statusCmd._edits[0].includes('114 سورة') && statusCmd._edits[0].includes('30 جزءاً'));

    const offCmd = makeSlash('off');
    await feat.onInteraction(offCmd);
    assert(offCmd._edits[0].includes('تم إيقاف ميزة نختم'));

    console.log('   OK (full V2 lifecycle + streaming cap + slash commands passed)');
    console.log('\nALL NAKHTIM OFFLINE TESTS PASSED.');
  } finally {
    fs.rmSync(tmpEmpty, { recursive: true, force: true });
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
