/* -------- AHADITH FEATURE: optional daily hadith, per-server channel and time --------
   Off by default. A server turns it on with /hadith setup. */
const {
  PermissionFlagsBits, MessageFlags, SlashCommandBuilder, ChannelType, InteractionContextType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const { logTimestamp } = require('./lib/log');
const { getServerConfig, setServerConfig } = require('./lib/config-store');
const { getAlgiersParts, getAlgiersDateDDMMYYYY, algiersWallToUtc } = require('./lib/algiers-time');
const { createDailyJob } = require('./lib/daily-scheduler');
const { createStateStore } = require('./lib/state-store');
const { createPool } = require('./lib/hadith-pool');
const { createSharhStore } = require('./lib/sharh-store');
const { buildHadithEmbeds, buildSharhEmbed, referenceText } = require('./ahadith-embeds');

const DEFAULT_TIME = '09:00';
const CATCHUP_MAX_LATE_MS = 12 * 60 * 60 * 1000; // if the bot was off at posting time, post on startup (up to 12h late)

const pool = createPool();
const sharhStore = createSharhStore(); // empty until scripts/build-sharh.js has been run
const SHARH_PREFIX = 'sharh:';
// Once sharh exists, the daily hadith is only picked among hadiths that have one
const eligibleForDaily = () => (sharhStore.available() ? (id) => sharhStore.has(id) : null);
const store = createStateStore('ahadith-state.json', {
  used: [],                    // hadith ids already used as "hadith of the day" (reset once all are used)
  daily: { date: null, id: null }, // today's pick, shared by every server
  posted: {},                  // guildId -> date (DD-MM-YYYY) of the last successful post
  lastError: {}                // guildId -> { date, message }
});

let client = null;
const jobs = new Map();        // guildId -> daily job
const inFlight = new Set();    // guildIds currently posting
const failedAttempts = new Map(); // `${guildId}:${date}` -> failed attempts so far
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/* -------- SLASH COMMAND -------- */
const slashCommands = [
  new SlashCommandBuilder()
    .setName('hadith')
    .setDescription('الحديث اليومي — ميزة اختيارية لكل سيرفر')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub
      .setName('setup')
      .setDescription('تفعيل الحديث اليومي وتحديد القناة والوقت')
      .addChannelOption((o) => o
        .setName('channel')
        .setDescription('القناة التي سيُنشر فيها الحديث')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true))
      .addStringOption((o) => o
        .setName('time')
        .setDescription('وقت النشر بتوقيت الجزائر بصيغة HH:MM (الافتراضي 09:00)')))
    .addSubcommand((sub) => sub
      .setName('time')
      .setDescription('تغيير وقت النشر اليومي')
      .addStringOption((o) => o
        .setName('time')
        .setDescription('الوقت بتوقيت الجزائر بصيغة HH:MM')
        .setRequired(true)))
    .addSubcommand((sub) => sub.setName('off').setDescription('إيقاف الحديث اليومي في هذا السيرفر'))
    .addSubcommand((sub) => sub.setName('status').setDescription('عرض حالة الحديث اليومي'))
    .addSubcommand((sub) => sub.setName('test').setDescription('إرسال حديث تجريبي في هذه القناة'))
    .toJSON()
];

/* -------- HELPERS -------- */
const pad = (n) => String(n).padStart(2, '0');

// "09:00", "9:00" and Arabic-Indic digits ("٠٩:٠٠") are all accepted
function parseTime(input) {
  const ascii = String(input).trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = /^(\d{1,2}):(\d{2})$/.exec(ascii);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, text: `${pad(hour)}:${pad(minute)}` };
}

function getHadithConfig(guildId) {
  return getServerConfig(guildId).ahadith ?? null;
}
function saveHadithConfig(guildId, config) {
  setServerConfig(guildId, { ahadith: config });
}

const REQUIRED_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'عرض القناة'],
  [PermissionFlagsBits.SendMessages, 'إرسال الرسائل'],
  [PermissionFlagsBits.EmbedLinks, 'تضمين الروابط']
];

// Arabic names of the permissions the bot is missing in that channel (empty = fine or unknown)
function missingPermissions(channel) {
  const me = channel?.guild?.members?.me;
  const perms = me ? channel.permissionsFor?.(me) : null;
  if (!perms) return [];
  return REQUIRED_PERMISSIONS.filter(([flag]) => !perms.has(flag)).map(([, label]) => label);
}

const unix = (ms) => Math.floor(ms / 1000);

/* -------- PICKING -------- */
// One hadith per Algiers day, the same for every server; never repeats until all have been used
function getDailyPickId(today) {
  const state = store.data;
  if (state.daily.date === today && state.daily.id && pool.has(state.daily.id)) {
    return state.daily.id;
  }

  const { id, reset } = pool.pickRandom(new Set(state.used), eligibleForDaily());
  if (reset) {
    state.used = [];
    logTimestamp('[ahadith] every hadith has been used once, starting a new cycle');
  }
  state.used.push(id);
  state.daily = { date: today, id };
  store.save();
  return id;
}

/* -------- SENDING -------- */
// Sends every part in order. Returns how many messages were sent; throws only if none could be sent.
async function sendHadith(channel, record) {
  const embeds = buildHadithEmbeds(record);
  let sent = 0;

  // the sharh button sits on the last part, when a sharh exists for this hadith
  const sharhRow = sharhStore.has(record.id)
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(SHARH_PREFIX + record.id).setLabel('الشرح').setEmoji('📚').setStyle(ButtonStyle.Secondary))]
    : [];

  for (const [i, embed] of embeds.entries()) {
    try {
      const isLast = i === embeds.length - 1;
      await channel.send({ embeds: [embed], components: isLast ? sharhRow : [] });
      sent++;
    } catch (err) {
      if (sent === 0) throw err;
      logTimestamp(`[ahadith] partial post ${sent}/${embeds.length} in ${channel.id}: ${err.message}`);
      break;
    }
  }
  return sent;
}

async function postDailyHadith(guildId) {
  const config = getHadithConfig(guildId);
  if (!config?.enabled || !config.channelId) return;

  const today = getAlgiersDateDDMMYYYY();
  if (store.data.posted[guildId] === today) return; // already posted today
  if (inFlight.has(guildId)) return;
  inFlight.add(guildId);

  try {
    const record = pool.get(getDailyPickId(today));
    const channel = await client.channels.fetch(config.channelId);

    const missing = missingPermissions(channel);
    if (missing.length > 0) throw new Error(`missing permissions: ${missing.join(', ')}`);

    const sent = await sendHadith(channel, record);
    store.data.posted[guildId] = today;
    delete store.data.lastError[guildId];
    failedAttempts.delete(`${guildId}:${today}`);
    store.save();
    logTimestamp(`[ahadith] posted ${record.id} (${sent} message${sent > 1 ? 's' : ''}) in guild ${guildId}`);
  } catch (err) {
    logTimestamp(`[ahadith] post failed in guild ${guildId}: ${err.message}`);
    store.data.lastError[guildId] = { date: today, message: err.message };
    store.save();

    // transient problem (Discord hiccup, permissions being fixed...): try again a couple of times
    const key = `${guildId}:${today}`;
    const attempts = (failedAttempts.get(key) ?? 0) + 1;
    failedAttempts.set(key, attempts);
    if (attempts < MAX_ATTEMPTS) {
      logTimestamp(`[ahadith] will retry in 5 minutes (attempt ${attempts + 1}/${MAX_ATTEMPTS})`);
      setTimeout(() => postDailyHadith(guildId), RETRY_DELAY_MS).unref?.();
    }
  } finally {
    inFlight.delete(guildId);
  }
}

/* -------- SCHEDULING -------- */
function disarmGuild(guildId) {
  jobs.get(guildId)?.stop();
  jobs.delete(guildId);
}

function armGuild(guildId) {
  disarmGuild(guildId);
  const config = getHadithConfig(guildId);
  if (!config?.enabled) return;
  const time = parseTime(config.time);
  if (!time) return;

  const job = createDailyJob({
    name: `ahadith:${guildId}`,
    hour: time.hour,
    minute: time.minute,
    task: () => postDailyHadith(guildId)
  });
  job.start();
  jobs.set(guildId, job);
}

// Bot was off at posting time: post now if it is still the same day and not too late
function catchUp(guildId) {
  const config = getHadithConfig(guildId);
  const time = config?.enabled ? parseTime(config.time) : null;
  if (!time) return;

  const now = Date.now();
  const p = getAlgiersParts(new Date(now));
  const scheduled = algiersWallToUtc(p.year, p.month, p.day, time.hour, time.minute, 0, 0);
  if (now >= scheduled && now - scheduled <= CATCHUP_MAX_LATE_MS) {
    postDailyHadith(guildId);
  }
}

/* -------- COMMAND HANDLERS (each returns the reply text) -------- */
const NOT_ENABLED = '⚠️ الحديث اليومي غير مفعّل في هذا السيرفر. فعّله أولاً بالأمر `/hadith setup`.';
const INVALID_TIME = '❌ صيغة الوقت غير صحيحة. اكتب الوقت بصيغة `HH:MM` بتوقيت الجزائر، مثل `09:00`.';

const handlers = {
  async setup(interaction) {
    const guildId = interaction.guild.id;
    const picked = interaction.options.getChannel('channel', true);
    const previous = getHadithConfig(guildId);

    const time = parseTime(interaction.options.getString('time') ?? previous?.time ?? DEFAULT_TIME);
    if (!time) return INVALID_TIME;

    saveHadithConfig(guildId, { enabled: true, channelId: picked.id, time: time.text });
    armGuild(guildId);

    const channel = await interaction.guild.channels.fetch(picked.id).catch(() => null);
    const missing = missingPermissions(channel);

    let reply =
      '✅ تم تفعيل الحديث اليومي.\n' +
      `📢 القناة: <#${picked.id}>\n` +
      `🕘 الوقت: **${time.text}** بتوقيت الجزائر\n` +
      `⏭️ أقرب نشر: <t:${unix(jobs.get(guildId).nextRun)}:R>`;
    if (missing.length > 0) {
      reply += `\n\n⚠️ ينقص البوت في هذه القناة: ${missing.join('، ')}. امنحه هذه الصلاحيات حتى ينجح النشر.`;
    }
    reply += '\n\n💡 لجعل القناة للبوت فقط، امنع @everyone من «إرسال الرسائل» في إعدادات القناة.';
    return reply;
  },

  async time(interaction) {
    const guildId = interaction.guild.id;
    const config = getHadithConfig(guildId);
    if (!config?.enabled) return NOT_ENABLED;

    const time = parseTime(interaction.options.getString('time', true));
    if (!time) return INVALID_TIME;

    saveHadithConfig(guildId, { ...config, time: time.text });
    armGuild(guildId);
    return `✅ تم تغيير وقت الحديث اليومي إلى **${time.text}** بتوقيت الجزائر.\n` +
      `⏭️ أقرب نشر: <t:${unix(jobs.get(guildId).nextRun)}:R>`;
  },

  async off(interaction) {
    const guildId = interaction.guild.id;
    const config = getHadithConfig(guildId);
    if (!config?.enabled) return '⚠️ الحديث اليومي غير مفعّل أصلاً في هذا السيرفر.';

    saveHadithConfig(guildId, { ...config, enabled: false });
    disarmGuild(guildId);
    return '🛑 تم إيقاف الحديث اليومي. يمكنك إعادة تفعيله في أي وقت بالأمر `/hadith setup`.';
  },

  async status(interaction) {
    const guildId = interaction.guild.id;
    const config = getHadithConfig(guildId);
    if (!config?.enabled) return NOT_ENABLED;

    const channel = await interaction.guild.channels.fetch(config.channelId).catch(() => null);
    const missing = missingPermissions(channel);
    const lastPosted = store.data.posted[guildId];
    const lastError = store.data.lastError[guildId];
    const next = jobs.get(guildId)?.nextRun;

    let reply =
      '📖 **الحديث اليومي — الحالة**\n' +
      '🟢 الحالة: مفعّل\n' +
      `📢 القناة: ${channel ? `<#${config.channelId}>` : '❌ القناة غير موجودة'}\n` +
      `🕘 الوقت: **${config.time}** بتوقيت الجزائر\n` +
      (next ? `⏭️ أقرب نشر: <t:${unix(next)}:R>\n` : '') +
      `📅 آخر نشر ناجح: ${lastPosted ?? 'لم يُنشر بعد'}\n` +
      (sharhStore.available() ? `📚 الشرح: متوفر (${sharhStore.size()} حديث)` : '📚 الشرح: غير مفعّل (لم تُبنَ قاعدة الشرح)');
    if (missing.length > 0) reply += `\n⚠️ ينقص البوت: ${missing.join('، ')}`;
    if (lastError) reply += `\n❌ آخر خطأ (${lastError.date}): ${lastError.message}`;
    return reply;
  },

  async test(interaction) {
    const channel = interaction.channel;
    const missing = missingPermissions(channel);
    if (missing.length > 0) return `❌ ينقص البوت في هذه القناة: ${missing.join('، ')}`;

    const record = pool.get(pool.pickRandom(new Set(), eligibleForDaily()).id);
    const sent = await sendHadith(channel, record);
    return `✅ أُرسل حديث تجريبي في هذه القناة (${sent} ${sent > 1 ? 'رسائل' : 'رسالة'}) — ${referenceText(record)}`;
  }
};

/* -------- FEATURE INTERFACE (used by bot.js) -------- */
async function onReady(readyClient) {
  client = readyClient;
  for (const guildId of client.guilds.cache.keys()) {
    armGuild(guildId);
    catchUp(guildId);
  }
}

// "📚 الشرح" button: a private (ephemeral) reply, so the channel stays clean
async function handleSharhButton(interaction) {
  const id = interaction.customId.slice(SHARH_PREFIX.length);
  const sharh = sharhStore.get(id);
  const hadith = sharh ? pool.get(id) : null;
  if (!sharh || !hadith) {
    await interaction.reply({ content: '⚠️ لا يتوفر شرح لهذا الحديث.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ embeds: [buildSharhEmbed(sharh, hadith)], flags: MessageFlags.Ephemeral });
}

async function onInteraction(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith(SHARH_PREFIX)) {
    try {
      await handleSharhButton(interaction);
    } catch (err) {
      logTimestamp(`[ahadith] sharh button failed: ${err.message}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ تعذّر عرض الشرح.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    return true;
  }
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'hadith') return false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) {
    await interaction.editReply('❌ هذا الأمر يعمل داخل السيرفرات فقط.');
    return true;
  }

  try {
    const handler = handlers[interaction.options.getSubcommand()];
    if (!handler) {
      await interaction.editReply('❌ أمر فرعي غير معروف.');
      return true;
    }
    await interaction.editReply(await handler(interaction));
  } catch (err) {
    logTimestamp(`[ahadith] command failed: ${err.message}`);
    await interaction.editReply(
      err.code === 'POOL_MISSING'
        ? '❌ قاعدة الأحاديث غير موجودة على الجهاز الذي يشغّل البوت. شغّل: `node scripts/build-hadith-pool.js`'
        : '❌ حدث خطأ: ' + err.message
    );
  }
  return true;
}

module.exports = { name: 'ahadith', slashCommands, onReady, onInteraction };
