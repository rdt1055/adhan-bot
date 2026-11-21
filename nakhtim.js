/* -------- NAKHTIM FEATURE: optional per-server Quran ayah-by-ayah reader in DMs --------
   Off by default. A server turns it on with /nakhtim setup. */
const path = require('path');
const {
  PermissionFlagsBits,
  MessageFlags,
  SlashCommandBuilder,
  ChannelType,
  InteractionContextType,
  AttachmentBuilder
} = require('discord.js');
const { logTimestamp } = require('./lib/log');
const { getServerConfig, setServerConfig } = require('./lib/config-store');
const { formatAlgiersNow } = require('./lib/algiers-time');
const { createStateStore } = require('./lib/state-store');
const { createQuranStore } = require('./lib/quran-store');
const { createAyahImageLoader } = require('./lib/ayah-image');
const {
  PREFIX,
  SUB_ID,
  UNSUB_ID,
  RECITER_SUB_ID,
  RECITER_CHANGE_PREFIX,
  CHANGE_RECITER_ID,
  DEFAULT_RECITER,
  pad3,
  getReciter,
  ayahAudioUrl,
  surahAudioUrl,
  buildChannelPanelPayload,
  buildReciterMenuRow,
  buildSurahIntroPayload,
  buildAyahPayload,
  buildTafsirEmbed
} = require('./nakhtim-embeds');

const MAX_UPLOAD_BYTES = Math.floor(19.5 * 1024 * 1024); // headroom under Discord's 20 MiB default limit
const DATA_DIR = path.join(__dirname, 'data');

const REQUIRED_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'عرض القناة'],
  [PermissionFlagsBits.SendMessages, 'إرسال الرسائل'],
  [PermissionFlagsBits.EmbedLinks, 'تضمين الروابط']
];

const slashCommands = [
  new SlashCommandBuilder()
    .setName('nakhtim')
    .setDescription('نختم — قراءة القرآن الكريم آيةً بآية في الرسائل الخاصة')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub
      .setName('setup')
      .setDescription('تفعيل ميزة نختم ونشر لوحة الاشتراك في قناة محددة')
      .addChannelOption((o) => o
        .setName('channel')
        .setDescription('القناة التي ستُنشر فيها لوحة الاشتراك')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)))
    .addSubcommand((sub) => sub.setName('off').setDescription('إيقاف لوحة نختم في هذا السيرفر'))
    .addSubcommand((sub) => sub.setName('status').setDescription('عرض حالة ميزة نختم'))
    .toJSON()
];

function missingPermissions(channel) {
  const me = channel?.guild?.members?.me;
  const perms = me ? channel.permissionsFor?.(me) : null;
  if (!perms) return [];
  return REQUIRED_PERMISSIONS.filter(([flag]) => !perms.has(flag)).map(([, label]) => label);
}

function createNakhtimFeature(deps = {}) {
  const dataDir = deps.dataDir ?? DATA_DIR;
  const stateDir = deps.stateDir ?? dataDir;
  const fetchFn = deps.fetchImpl ?? global.fetch;
  const getCfg = deps.getServerConfig ?? getServerConfig;
  const setCfg = deps.setServerConfig ?? setServerConfig;
  const imageLoader = deps.imageLoader !== undefined
    ? deps.imageLoader
    : createAyahImageLoader({ fetchImpl: fetchFn });

  const quranStore = createQuranStore(dataDir);
  const store = createStateStore('nakhtim-state.json', { users: {} }, stateDir);
  const audioInFlight = new Set(); // `${userId}:${s}:${a}`
  const userQueues = new Map(); // per-user serialization for DM message ordering

  function runUserTask(userId, fn) {
    const prev = userQueues.get(userId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const cleanup = next.finally(() => {
      if (userQueues.get(userId) === cleanup) userQueues.delete(userId);
    });
    userQueues.set(userId, cleanup);
    return next;
  }

  function getNakhtimConfig(guildId) {
    return getCfg(guildId).nakhtim ?? null;
  }

  function saveNakhtimConfig(guildId, config) {
    setCfg(guildId, { nakhtim: config });
  }

  function ensureUser(userId) {
    const users = store.data.users || (store.data.users = {});
    if (!users[userId]) {
      users[userId] = {
        active: true,
        surah: 1,
        ayah: 1,
        mode: 'intro',
        reciter: DEFAULT_RECITER,
        sentSurahs: [],
        sentAjza: [],
        panelMsgId: null,
        tempMsgIds: [],
        surahPdfMsgs: {},
        khatmahCount: 0,
        updatedAt: formatAlgiersNow()
      };
    }
    const u = users[userId];
    if (!Array.isArray(u.sentSurahs)) u.sentSurahs = [];
    if (!Array.isArray(u.sentAjza)) u.sentAjza = [];
    if (!Array.isArray(u.tempMsgIds)) u.tempMsgIds = [];
    if (!u.surahPdfMsgs || typeof u.surahPdfMsgs !== 'object') u.surahPdfMsgs = {};
    if (u.panelMsgId === undefined) u.panelMsgId = null;
    if (u.mode !== 'intro' && u.mode !== 'ayah') u.mode = 'ayah';
    return u;
  }

  async function buildUserPanelPayload(user) {
    const reciter = getReciter(user.reciter);
    if (user.mode === 'intro') {
      const surah = quranStore.getSurah(user.surah) ?? quranStore.getSurah(1);
      return buildSurahIntroPayload(surah, quranStore.getIntro(surah.n), reciter);
    }
    const ayahObj = quranStore.getAyah(user.surah, user.ayah) ?? quranStore.getAyah(1, 1);
    const imageInfo = imageLoader ? await imageLoader.getAyahImage(ayahObj.s, ayahObj.a) : null;
    return buildAyahPayload(ayahObj, reciter, imageInfo);
  }

  async function resolveDmChannel(interaction) {
    if (interaction.channel) return interaction.channel;
    if (interaction.channelId && interaction.client?.channels?.fetch) {
      const ch = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
      if (ch) return ch;
    }
    return interaction.user.createDM();
  }

  async function deleteDmMessages(dmChannel, ids) {
    if (!dmChannel?.messages) return;
    const unique = [...new Set((ids || []).filter(Boolean))];
    await Promise.allSettled(unique.map(async (id) => {
      if (typeof dmChannel.messages.delete === 'function') {
        await dmChannel.messages.delete(id);
      } else if (typeof dmChannel.messages.fetch === 'function') {
        const m = await dmChannel.messages.fetch(id);
        await m?.delete?.();
      }
    }));
  }

  async function clearTempMessages(dmChannel, user) {
    if (!user.tempMsgIds?.length) return;
    const toDelete = [...user.tempMsgIds];
    user.tempMsgIds = [];
    await deleteDmMessages(dmChannel, toDelete);
  }

  async function repostPanelAtBottom(dmChannel, user, oldPanelId = null) {
    const prevIds = [user.panelMsgId, oldPanelId].filter(Boolean);
    const payload = await buildUserPanelPayload(user);
    const newMsg = await dmChannel.send(payload);
    user.panelMsgId = newMsg.id;
    user.updatedAt = formatAlgiersNow();
    store.save();

    const toDelete = prevIds.filter((id) => id !== newMsg.id);
    if (toDelete.length) await deleteDmMessages(dmChannel, toDelete);
    return newMsg;
  }

  async function fetchWithSizeCheck(url, maxBytes, timeoutMs) {
    try {
      const head = await fetchFn(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      const headLen = Number(head.headers?.get?.('content-length') || 0);
      await head.body?.cancel?.().catch(() => {});
      if (head.ok && headLen > maxBytes) return { tooLarge: true, bytes: headLen };
    } catch {}

    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const getLen = Number(res.headers?.get?.('content-length') || 0);
    if (getLen > maxBytes) {
      await res.body?.cancel?.().catch(() => {});
      return { tooLarge: true, bytes: getLen };
    }

    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.length;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            return { tooLarge: true, bytes: total };
          }
          chunks.push(Buffer.from(value));
        }
      } catch (err) {
        await reader.cancel().catch(() => {});
        throw err;
      }
      const buffer = Buffer.concat(chunks, total);
      return { tooLarge: false, buffer, bytes: buffer.length };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) return { tooLarge: true, bytes: buffer.length };
    return { tooLarge: false, buffer, bytes: buffer.length };
  }

  async function sendAttachmentOrLink(sendFn, { url, filename, caption, timeoutMs }) {
    try {
      const file = await fetchWithSizeCheck(url, MAX_UPLOAD_BYTES, timeoutMs);
      if (!file.tooLarge) {
        try {
          const msg = await sendFn({
            content: caption,
            files: [new AttachmentBuilder(file.buffer, { name: filename })]
          });
          return { status: 'attached', msg };
        } catch (err) {
          logTimestamp(`[nakhtim] upload failed for ${filename}, falling back to link: ${err.message}`);
        }
      }
    } catch (err) {
      logTimestamp(`[nakhtim] fetch failed for ${url}, falling back to link: ${err.message}`);
    }

    const msg = await sendFn({ content: `${caption}\n🔗 ${url}` });
    return { status: 'link', msg };
  }

  async function sendEndOfSurahRewards(dmChannel, user, s, reciter) {
    const surah = quranStore.getSurah(s);
    if (!surah) return;

    try {
      await sendAttachmentOrLink((payload) => dmChannel.send(payload), {
        url: surahAudioUrl(reciter, s),
        filename: `surah-${pad3(s)}-${reciter.key}.mp3`,
        caption: `🎧 **${surah.name} كاملة** — بصوت ${reciter.name}`,
        timeoutMs: 45000
      });
    } catch (err) {
      logTimestamp(`[nakhtim] end-of-surah audio failed for surah ${s}: ${err.message}`);
    }

    const pdfUrl = quranStore.getSurahPdfUrl(s);
    if (!pdfUrl) return;

    try {
      const pdfRes = await sendAttachmentOrLink((payload) => dmChannel.send(payload), {
        url: pdfUrl,
        filename: `surah-${pad3(s)}-hafs.pdf`,
        caption: `📄 **مصحف ${surah.name}** (مصحف المدينة النبوية — حفص عن عاصم — PDF)`,
        timeoutMs: 45000
      });
      if (pdfRes?.msg?.id) user.surahPdfMsgs[String(s)] = pdfRes.msg.id;
    } catch (err) {
      logTimestamp(`[nakhtim] end-of-surah PDF failed for surah ${s}: ${err.message}`);
    }
  }

  async function sendJuzRewards(dmChannel, user, juzDone) {
    if (!juzDone?.url) return false;
    if (user.sentAjza.includes(juzDone.juz)) return false;
    user.sentAjza.push(juzDone.juz);

    // Collapse wholly-contained surah PDFs into the Juz PDF (keep Surah 114 PDF on Khatmah)
    const toDelete = [];
    for (const ws of juzDone.wholeSurahs || []) {
      if (ws === 114) continue;
      const msgId = user.surahPdfMsgs[String(ws)];
      if (msgId) {
        toDelete.push(msgId);
        delete user.surahPdfMsgs[String(ws)];
      }
    }
    if (toDelete.length) await deleteDmMessages(dmChannel, toDelete);

    const caption = `📚 **الجزء ${juzDone.juz} كاملاً** (مصحف المدينة النبوية — حفص عن عاصم — PDF)`;
    try {
      if (Number(juzDone.bytes || 0) > MAX_UPLOAD_BYTES) {
        await dmChannel.send({ content: `${caption}\n🔗 ${juzDone.url}` });
        return true;
      }
      await sendAttachmentOrLink((payload) => dmChannel.send(payload), {
        url: juzDone.url,
        filename: `juz-${pad3(juzDone.juz)}-hafs.pdf`,
        caption,
        timeoutMs: 60000
      });
      return true;
    } catch (err) {
      logTimestamp(`[nakhtim] Juz ${juzDone.juz} PDF failed: ${err.message}`);
      return false;
    }
  }

  /* -------- SLASH COMMAND HANDLERS -------- */
  const NOT_ENABLED = '⚠️ ميزة نختم غير مفعّلة حالياً في هذا السيرفر. فعّلها أولاً بالأمر `/nakhtim setup`.';

  const commandHandlers = {
    async setup(interaction) {
      if (!quranStore.available()) {
        return '❌ بيانات القرآن والتفسير غير موجودة على الجهاز الذي يشغّل البوت. شغّل: `node scripts/verify-nakhtim-data.js`';
      }
      const guildId = interaction.guild.id;
      const picked = interaction.options.getChannel('channel', true);
      const channel = await interaction.guild.channels.fetch(picked.id).catch(() => null);
      if (!channel) return '❌ تعذّر الوصول إلى القناة المحددة.';

      const missing = missingPermissions(channel);
      if (missing.length > 0) {
        return `❌ ينقص البوت في <#${picked.id}>: ${missing.join('، ')}. امنحه هذه الصلاحيات ثم أعد المحاولة.`;
      }

      const panelMsg = await channel.send(buildChannelPanelPayload());
      saveNakhtimConfig(guildId, { enabled: true, channelId: picked.id, panelMessageId: panelMsg.id });

      return (
        '✅ تم تفعيل ميزة **نختم** ونشر لوحة الاشتراك.\n' +
        `📢 القناة: <#${picked.id}>\n` +
        '💡 لجعل القناة مغلقة على لوحة الاشتراك فقط، امنع `@everyone` من «إرسال الرسائل» في إعدادات القناة.'
      );
    },

    async off(interaction) {
      const guildId = interaction.guild.id;
      const config = getNakhtimConfig(guildId);
      if (!config?.enabled) return '⚠️ ميزة نختم غير مفعّلة أصلاً في هذا السيرفر.';

      saveNakhtimConfig(guildId, { ...config, enabled: false });
      return '🛑 تم إيقاف ميزة نختم في هذا السيرفر (تقدّم المشتركين في رسائلهم الخاصة محفوظ).';
    },

    async status(interaction) {
      const guildId = interaction.guild.id;
      const config = getNakhtimConfig(guildId);
      if (!config?.enabled) return NOT_ENABLED;

      const channel = await interaction.guild.channels.fetch(config.channelId).catch(() => null);
      const missing = missingPermissions(channel);
      const users = Object.values(store.data.users || {});
      const activeCount = users.filter((u) => u?.active).length;

      let reply =
        '📖 **نختم — الحالة**\n' +
        '🟢 الحالة: مفعّل\n' +
        `📢 القناة: ${channel ? `<#${config.channelId}>` : '❌ القناة غير موجودة'}\n` +
        `📚 بيانات القرآن والتفسير: ${quranStore.available() ? 'متوفرة ✅' : 'غير موجودة ❌'}\n` +
        `📄 ملفات PDF للسور: ${quranStore.pdfsAvailable() ? 'متوفرة (114 سورة) ✅' : 'غير مفعّلة'}\n` +
        `📚 ملفات PDF للأجزاء: ${quranStore.ajzaAvailable() ? 'متوفرة (30 جزءاً) ✅' : 'غير مفعّلة'}\n` +
        `👥 المشتركون النشطون: ${activeCount}`;
      if (missing.length > 0) reply += `\n⚠️ ينقص البوت في القناة: ${missing.join('، ')}`;
      return reply;
    }
  };

  /* -------- COMPONENT HANDLERS -------- */
  async function handleSubscribeButton(interaction) {
    if (interaction.guild && !getNakhtimConfig(interaction.guild.id)?.enabled) {
      await interaction.reply({
        content: '⚠️ ميزة نختم متوقفة حالياً في هذا السيرفر.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const existing = store.data.users?.[interaction.user.id];
    const surah = existing ? quranStore.getSurah(existing.surah) : null;
    const progressLine = existing && surah
      ? (existing.mode === 'intro'
        ? `📌 تقدمك المحفوظ: مقدمة **${surah.name}**\n`
        : `📌 تقدمك المحفوظ: **${surah.name} — الآية ${existing.ayah}**\n`)
      : '';
    const reciterLine = existing?.reciter
      ? `🎙️ القارئ السابق: **${getReciter(existing.reciter).name}**\n`
      : '';

    await interaction.reply({
      content: `${progressLine}${reciterLine}🎙️ اختر القارئ لبدء القراءة في رسائلك الخاصة:`,
      components: [buildReciterMenuRow(RECITER_SUB_ID)],
      flags: MessageFlags.Ephemeral
    });
  }

  async function handleUnsubscribeButton(interaction) {
    const user = store.data.users?.[interaction.user.id];
    if (!user?.active) {
      await interaction.reply({
        content: '⚠️ لست مشتركاً حالياً في نختم.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    user.active = false;
    user.updatedAt = formatAlgiersNow();
    store.save();

    await interaction.reply({
      content: '🛑 تم إيقاف اشتراكك في نختم. تقدمك محفوظ ويمكنك استئنافه في أي وقت بالضغط على «اشترك».',
      flags: MessageFlags.Ephemeral
    });
  }

  async function handleSubscribeReciterSelect(interaction) {
    await interaction.deferUpdate();
    const picked = getReciter(interaction.values[0]);

    await runUserTask(interaction.user.id, async () => {
      const existing = store.data.users?.[interaction.user.id];
      const nextUser = existing
        ? {
          ...existing,
          active: true,
          reciter: picked.key,
          sentSurahs: Array.isArray(existing.sentSurahs) ? existing.sentSurahs : [],
          sentAjza: Array.isArray(existing.sentAjza) ? existing.sentAjza : [],
          panelMsgId: existing.panelMsgId ?? null,
          tempMsgIds: Array.isArray(existing.tempMsgIds) ? existing.tempMsgIds : [],
          surahPdfMsgs: (existing.surahPdfMsgs && typeof existing.surahPdfMsgs === 'object') ? existing.surahPdfMsgs : {},
          mode: existing.mode === 'intro' ? 'intro' : 'ayah',
          updatedAt: formatAlgiersNow()
        }
        : {
          active: true,
          surah: 1,
          ayah: 1,
          mode: 'intro',
          reciter: picked.key,
          sentSurahs: [],
          sentAjza: [],
          panelMsgId: null,
          tempMsgIds: [],
          surahPdfMsgs: {},
          khatmahCount: 0,
          updatedAt: formatAlgiersNow()
        };

      const payload = await buildUserPanelPayload(nextUser);
      let sentPanel;
      try {
        sentPanel = await interaction.user.send(payload);
      } catch (err) {
        if (err.code === 50007) {
          await interaction.editReply({
            content:
              '❌ تعذّر إرسال رسالة خاصة إليك لأن الرسائل الخاصة مغلقة.\n' +
              'افتح الرسائل الخاصة لأعضاء السيرفر من إعدادات الخصوصية، ثم اضغط **«اشترك»** مرة أخرى.',
            components: []
          });
          return;
        }
        throw err;
      }

      const oldIds = [existing?.panelMsgId, ...(existing?.tempMsgIds || [])].filter((id) => id && id !== sentPanel.id);
      if (oldIds.length) {
        const dm = sentPanel.channel ?? await interaction.user.createDM().catch(() => null);
        await deleteDmMessages(dm, oldIds);
      }

      nextUser.panelMsgId = sentPanel.id;
      nextUser.tempMsgIds = [];
      if (!store.data.users) store.data.users = {};
      store.data.users[interaction.user.id] = nextUser;
      store.save();

      await interaction.editReply({
        content: `✅ تم الاشتراك بنجاح! القارئ المختار: **${picked.name}**.\n📩 أُرسلت لوحة القراءة إلى رسائلك الخاصة.`,
        components: []
      });
    });
  }

  async function handleChangeReciterButton(interaction) {
    const user = ensureUser(interaction.user.id);
    const current = getReciter(user.reciter);
    const panelId = interaction.message?.id || user.panelMsgId || '';
    await interaction.reply({
      content: `🎙️ القارئ الحالي: **${current.name}**\nاختر القارئ الجديد:`,
      components: [buildReciterMenuRow(`${RECITER_CHANGE_PREFIX}${panelId}`)],
      flags: MessageFlags.Ephemeral
    });
  }

  async function handleChangeReciterSelect(interaction) {
    await interaction.deferUpdate();
    const panelMsgId = interaction.customId.slice(RECITER_CHANGE_PREFIX.length);
    const picked = getReciter(interaction.values[0]);

    await runUserTask(interaction.user.id, async () => {
      const user = ensureUser(interaction.user.id);
      user.reciter = picked.key;
      user.updatedAt = formatAlgiersNow();
      store.save();

      await interaction.editReply({
        content: `✅ تم تغيير القارئ إلى **${picked.name}**.`,
        components: []
      });

      const targetId = user.panelMsgId || panelMsgId;
      if (!targetId) return;
      try {
        const dm = await resolveDmChannel(interaction);
        const panelMsg = await dm.messages.fetch(targetId);
        await panelMsg.edit(await buildUserPanelPayload(user));
      } catch {}
    });
  }

  async function handleStartSurah(interaction, s) {
    if (!quranStore.getAyah(s, 1)) return;
    await interaction.deferUpdate();
    const dm = await resolveDmChannel(interaction);

    await runUserTask(interaction.user.id, async () => {
      const user = ensureUser(interaction.user.id);
      await clearTempMessages(dm, user);
      user.active = true;
      user.surah = s;
      user.ayah = 1;
      user.mode = 'ayah';
      user.panelMsgId = interaction.message?.id ?? user.panelMsgId;
      user.updatedAt = formatAlgiersNow();
      store.save();

      await interaction.editReply(await buildUserPanelPayload(user));
    });
  }

  async function handlePrevIntro(interaction, s) {
    if (s <= 1) return;
    const prevSurah = quranStore.getSurah(s - 1);
    const ayahObj = prevSurah ? quranStore.getAyah(prevSurah.n, prevSurah.ayahCount) : null;
    if (!ayahObj) return;
    await interaction.deferUpdate();
    const dm = await resolveDmChannel(interaction);

    await runUserTask(interaction.user.id, async () => {
      const user = ensureUser(interaction.user.id);
      await clearTempMessages(dm, user);
      user.active = true;
      user.surah = ayahObj.s;
      user.ayah = ayahObj.a;
      user.mode = 'ayah';
      user.panelMsgId = interaction.message?.id ?? user.panelMsgId;
      user.updatedAt = formatAlgiersNow();
      store.save();

      await interaction.editReply(await buildUserPanelPayload(user));
    });
  }

  async function handlePrevAyah(interaction, s, a) {
    const prev = quranStore.prevPosition(s, a);
    if (!prev || !quranStore.getAyah(prev.s, prev.a)) return;
    await interaction.deferUpdate();
    const dm = await resolveDmChannel(interaction);

    await runUserTask(interaction.user.id, async () => {
      const user = ensureUser(interaction.user.id);
      await clearTempMessages(dm, user);
      user.active = true;
      user.surah = prev.s;
      user.ayah = prev.a;
      user.mode = 'ayah';
      user.panelMsgId = interaction.message?.id ?? user.panelMsgId;
      user.updatedAt = formatAlgiersNow();
      store.save();

      await interaction.editReply(await buildUserPanelPayload(user));
    });
  }

  async function handleNextAyah(interaction, s, a) {
    const next = quranStore.nextPosition(s, a);
    if (!next) return;
    await interaction.deferUpdate();
    const dm = await resolveDmChannel(interaction);

    await runUserTask(interaction.user.id, async () => {
      const user = ensureUser(interaction.user.id);
      const reciter = getReciter(user.reciter);
      const oldPanelId = interaction.message?.id ?? user.panelMsgId;
      await clearTempMessages(dm, user);

      const juzDone = quranStore.getJuzEndingAt(s, a);
      user.active = true;
      user.updatedAt = formatAlgiersNow();

      if (!next.crossedSurah) {
        const shouldSendSurah = next.isLastOfSurah && !user.sentSurahs.includes(s);
        if (shouldSendSurah) user.sentSurahs.push(s);
        user.surah = next.s;
        user.ayah = next.a;
        user.mode = 'ayah';
        user.panelMsgId = oldPanelId;
        store.save();

        await interaction.editReply(await buildUserPanelPayload(user));

        let postedBelow = false;
        if (shouldSendSurah) {
          await sendEndOfSurahRewards(dm, user, s, reciter);
          postedBelow = true;
        }
        if (juzDone) {
          const jSent = await sendJuzRewards(dm, user, juzDone);
          if (jSent) postedBelow = true;
        }
        if (postedBelow) await repostPanelAtBottom(dm, user, oldPanelId);
        else store.save();
        return;
      }

      const needSurahRewards = !user.sentSurahs.includes(s);
      if (needSurahRewards) user.sentSurahs.push(s);

      user.surah = next.s;
      user.ayah = 1;
      user.mode = 'intro';
      user.panelMsgId = oldPanelId;
      store.save();

      await interaction.editReply(await buildUserPanelPayload(user));

      let postedBelow = false;
      if (needSurahRewards) {
        await sendEndOfSurahRewards(dm, user, s, reciter);
        postedBelow = true;
      }
      if (juzDone) {
        const jSent = await sendJuzRewards(dm, user, juzDone);
        if (jSent) postedBelow = true;
      }
      if (next.wrapped) {
        user.khatmahCount = (user.khatmahCount || 0) + 1;
        user.sentSurahs = [];
        user.sentAjza = [];
        user.surahPdfMsgs = {};
        const fullPdf = quranStore.getFullQuranPdf();
        const fullLine = fullPdf?.url
          ? `\n\n📖 **${fullPdf.label || 'مصحف المدينة النبوية كاملاً (حفص عن عاصم)'}** (PDF):\n🔗 ${fullPdf.url}`
          : '';
        await dm.send({
          content:
            `🎉 ما شاء الله! أتممت ختمة القرآن الكريم (الختمة رقم ${user.khatmahCount}). تقبّل الله منك!\n` +
            'يمكنك البدء بختمة جديدة من سورة الفاتحة بالضغط على «التالية».' +
            fullLine
        });
        postedBelow = true;
      }

      if (postedBelow) await repostPanelAtBottom(dm, user, oldPanelId);
      else store.save();
    });
  }

  async function handleTafsirButton(interaction, s, a) {
    const tafsir = quranStore.getTafsir(s, a);
    if (!tafsir) {
      await interaction.reply({ content: '⚠️ لا يتوفر تفسير لهذه الآية.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    const dm = await resolveDmChannel(interaction);

    await runUserTask(interaction.user.id, async () => {
      const user = ensureUser(interaction.user.id);
      const tafMsg = await dm.send({ embeds: [buildTafsirEmbed(tafsir)] });
      if (tafMsg?.id) user.tempMsgIds.push(tafMsg.id);
      await repostPanelAtBottom(dm, user, interaction.message?.id);
    });
  }

  async function handleAudioButton(interaction, s, a) {
    const ayahObj = quranStore.getAyah(s, a);
    if (!ayahObj) return;

    const lockKey = `${interaction.user.id}:${s}:${a}`;
    if (audioInFlight.has(lockKey)) {
      await interaction.reply({ content: '⏳ جارٍ إرسال التلاوة، انتظر لحظة...', flags: MessageFlags.Ephemeral });
      return;
    }

    audioInFlight.add(lockKey);
    try {
      await interaction.deferUpdate();
      const dm = await resolveDmChannel(interaction);
      await runUserTask(interaction.user.id, async () => {
        const user = ensureUser(interaction.user.id);
        const reciter = getReciter(user.reciter);
        const sent = await sendAttachmentOrLink((payload) => dm.send(payload), {
          url: ayahAudioUrl(reciter, s, a),
          filename: `ayah-${pad3(s)}-${pad3(a)}-${reciter.key}.mp3`,
          caption: `🔊 **${ayahObj.surahName} — الآية ${a}** (${reciter.name})`,
          timeoutMs: 20000
        });
        if (sent?.msg?.id) user.tempMsgIds.push(sent.msg.id);
        await repostPanelAtBottom(dm, user, interaction.message?.id);
      });
    } finally {
      audioInFlight.delete(lockKey);
    }
  }

  async function routeComponentInteraction(interaction) {
    const id = interaction.customId;

    if (interaction.isButton()) {
      if (id === SUB_ID) return handleSubscribeButton(interaction);
      if (id === UNSUB_ID) return handleUnsubscribeButton(interaction);
      if (id === CHANGE_RECITER_ID) return handleChangeReciterButton(interaction);

      const parts = id.slice(PREFIX.length).split(':');
      const action = parts[0];
      const s = Number(parts[1]);
      const a = Number(parts[2]);

      if (action === 'start') return handleStartSurah(interaction, s);
      if (action === 'previntro') return handlePrevIntro(interaction, s);
      if (action === 'prev') return handlePrevAyah(interaction, s, a);
      if (action === 'next') return handleNextAyah(interaction, s, a);
      if (action === 'tafsir') return handleTafsirButton(interaction, s, a);
      if (action === 'audio') return handleAudioButton(interaction, s, a);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (id === RECITER_SUB_ID) return handleSubscribeReciterSelect(interaction);
      if (id.startsWith(RECITER_CHANGE_PREFIX)) return handleChangeReciterSelect(interaction);
    }
  }

  /* -------- FEATURE INTERFACE (used by bot.js) -------- */
  async function prepare() {
    if (!quranStore.available()) {
      console.log('[nakhtim] data/quran.json or data/tafsir-muyassar.json missing (feature dormant until built).');
      return;
    }
    const pdfMsg = quranStore.pdfsAvailable() ? '114 surah PDFs OK' : 'no surah PDFs (optional)';
    const ajzaMsg = quranStore.ajzaAvailable() ? '30 Ajza PDFs OK' : 'no Ajza PDFs (optional)';
    console.log(`[nakhtim] Quran + Al-Muyassar data OK (${pdfMsg}, ${ajzaMsg}).`);
  }

  async function onReady() {
    // Nakhtim acts on demand (slash commands + DM/panel buttons); no startup jobs needed.
  }

  async function onInteraction(interaction) {
    if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith(PREFIX)) {
      if (!quranStore.available()) {
        await interaction.reply({
          content: '⚠️ بيانات القرآن غير متوفرة حالياً على الجهاز المشغّل للبوت.',
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
        return true;
      }
      try {
        await routeComponentInteraction(interaction);
      } catch (err) {
        logTimestamp(`[nakhtim] component interaction failed (${interaction.customId}): ${err.message}`);
        const msg = { content: '❌ حدث خطأ غير متوقع، حاول مرة أخرى.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
        else await interaction.reply(msg).catch(() => {});
      }
      return true;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== 'nakhtim') return false;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild) {
      await interaction.editReply('❌ هذا الأمر يعمل داخل السيرفرات فقط.');
      return true;
    }

    try {
      const handler = commandHandlers[interaction.options.getSubcommand()];
      if (!handler) {
        await interaction.editReply('❌ أمر فرعي غير معروف.');
        return true;
      }
      await interaction.editReply(await handler(interaction));
    } catch (err) {
      logTimestamp(`[nakhtim] command failed: ${err.message}`);
      await interaction.editReply('❌ حدث خطأ: ' + err.message);
    }
    return true;
  }

  return {
    name: 'nakhtim',
    slashCommands,
    prepare,
    onReady,
    onInteraction,
    _internal: { quranStore, store, imageLoader }
  };
}

const nakhtimFeature = createNakhtimFeature();
module.exports = nakhtimFeature;
module.exports.createNakhtimFeature = createNakhtimFeature;
