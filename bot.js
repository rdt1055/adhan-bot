require('dotenv').config();
process.env.FFMPEG_PATH = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, ChannelType, ActivityType, REST, Routes, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType } = require('discord-voip');
const axios = require('axios');
const { buildAdhanEmbed, buildTimesEmbed, buildTimesComponents, TIMES_REFRESH_ID } = require('./embeds');
/* -------- SERVER CONFIG -------- */
const CONFIG_FILE = path.join(__dirname, 'serverconfig.json');
function loadConfigs() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return {};
}
function saveConfigs(configs) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
}
function getServerConfig(guildId) {
  const configs = loadConfigs();
  return configs[guildId] || { textChannelId: null, ignoredChannels: [] };
}
function setServerConfig(guildId, data) {
  const configs = loadConfigs();
  configs[guildId] = { ...getServerConfig(guildId), ...data };
  saveConfigs(configs);
}
/* -------- HIJRI MONTH NAMES -------- */
const HIJRI_MONTHS = [
  'مُحَرَّم', 'صَفَر', 'رَبِيع الأَوَّل', 'رَبِيع الثَّانِي',
  'جُمَادَى الأُولَى', 'جُمَادَى الآخِرَة', 'رَجَب', 'شَعْبَان',
  'رَمَضَان', 'شَوَّال', 'ذُو القَعْدَة', 'ذُو الحِجَّة'
];
function formatHijriDate(hijriDate) {
  const [day, month, year] = hijriDate.split('-');
  const monthName = HIJRI_MONTHS[parseInt(month) - 1];
  return `${day} ${monthName} ${year}`;
}
/* -------- PRAYER NAMES IN ARABIC -------- */
const PRAYER_NAMES_AR = {
  'Fajr': 'الفَجْر',
  'Dhuhr': 'الظُّهْر',
  'Asr': 'العَصْر',
  'Maghrib': 'المَغْرِب',
  'Isha': 'العِشَاء',
  'Test': 'اختبار'
};
/* -------- PRAYER AUDIO FILES -------- */
const PRAYER_AUDIO = {
  'Fajr':    'fajr.mp3',
  'Dhuhr':   'duhr.mp3',
  'Asr':     'asr.mp3',
  'Maghrib': 'maghrib.mp3',
  'Isha':    'ishaa.mp3',
  'Test':    'fajr.mp3'
};

const TIMEZONE = 'Africa/Algiers';

function logTimestamp(msg) {
  console.log(new Date().toISOString(), msg);
}

function getAlgiersParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    parts[type] = value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function getAlgiersDateDDMMYYYY(date = new Date()) {
  const p = getAlgiersParts(date);
  return `${String(p.day).padStart(2, '0')}-${String(p.month).padStart(2, '0')}-${p.year}`;
}

function formatAlgiersNow(date = new Date()) {
  const p = getAlgiersParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ` +
    `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

function getAlgiersOffsetMinutes(date = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      timeZoneName: 'longOffset'
    }).formatToParts(date).find(p => p.type === 'timeZoneName');

    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part?.value || '');
    if (m) {
      return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    }
  } catch {}

  return 60;
}

function algiersWallToUtc(year, month, day, hour, minute, second = 0, ms = 0) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const offset = getAlgiersOffsetMinutes(new Date(utc));
  utc -= offset * 60000;

  const offset2 = getAlgiersOffsetMinutes(new Date(utc));
  if (offset2 !== offset) {
    utc -= (offset2 - offset) * 60000;
  }

  return utc;
}

function getNextAlgiersMidnightPlusOneMs() {
  const now = Date.now();
  const p = getAlgiersParts(new Date(now));

  let day = p.day + 1;
  let target = algiersWallToUtc(p.year, p.month, day, 0, 1, 0, 0);

  while (target <= now) {
    day += 1;
    target = algiersWallToUtc(p.year, p.month, day, 0, 1, 0, 0);
  }

  return target;
}

function parseAlgiersTime(value) {
  const m = String(value).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) throw new Error(`Invalid prayer time: ${value}`);

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3] ? m[3].toUpperCase() : null;

  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;

  return { hour, minute };
}

/* -------- CONFIG -------- */
const TEXT_CHANNEL_ID = "1105074703669919779";
/* -------- ACTIVE PLAYERS TRACKER (for stop command) -------- */
const activePlayers = new Map(); // guildId -> { players[], connections[] }
let adhanRunning = false;
let currentFinish = null;
let initialScheduleRetryTimer = null;
let midnightRefreshTimer = null;

function addActivePlayer(guildId, player, connection) {
  if (!activePlayers.has(guildId)) {
    activePlayers.set(guildId, { players: [], connections: [] });
  }

  const entry = activePlayers.get(guildId);
  entry.players.push(player);
  entry.connections.push(connection);
}

function removeActivePlayer(guildId, player, connection) {
  const entry = activePlayers.get(guildId);
  if (!entry) return;

  entry.players = entry.players.filter(p => p !== player);
  entry.connections = entry.connections.filter(c => c !== connection);

  if (entry.players.length === 0 && entry.connections.length === 0) {
    activePlayers.delete(guildId);
  }
}
const scheduledTimers = []; // track all prayer setTimeout handles
/* -------- SLASH COMMANDS DEFINITION -------- */
const slashCommands = [
  { name: 'testadhan', description: 'تشغيل اختبار للأذان في القنوات الصوتية النشطة' },
  { name: 'stopadhan', description: 'إيقاف الأذان الجاري وإخراج البوت من القناة الصوتية' },
  {
    name: 'setchannel',
    description: 'تعيين قناة إشعارات الصلاة',
    options: [{ name: 'channel_id', description: 'ID القناة النصية', type: 3, required: true }]
  },
  {
    name: 'ignorechannel',
    description: 'تجاهل قناة صوتية — لن يدخلها البوت',
    options: [{ name: 'channel_id', description: 'ID القناة الصوتية', type: 3, required: true }]
  },
  {
    name: 'unignorechannel',
    description: 'إزالة قناة من قائمة التجاهل',
    options: [{ name: 'channel_id', description: 'ID القناة الصوتية', type: 3, required: true }]
  },
  { name: 'settings', description: 'عرض إعدادات البوت في هذا السيرفر' },
  { name: 'times', description: 'عرض مواقيت الصلاة لليوم مع الوقت المتبقي لكل صلاة' },
  { name: 'refresh', description: 'إعادة جلب مواقيت الصلاة وتحديث الجدول فوراً' }
];
/* -------- CREATE BOT -------- */
const mainBot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

mainBot.once('ready', async () => {
  console.log(`Bot ready: ${mainBot.user.tag}`);
  mainBot.user.setPresence({
    activities: [{ name: 'prayer times', type: ActivityType.Watching }],
    status: 'online'
  });

  await registerSlashCommands();

  try {
    await schedulePrayerTimes();
  } catch (err) {
    logTimestamp(`Initial prayer schedule failed: ${err.message}`);
    retryInitialSchedule();
  }

  scheduleMidnightRefresh();
});
/* -------- REGISTER SLASH COMMANDS -------- */
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN_1);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(mainBot.user.id), { body: slashCommands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}
/* -------- PLAY ADHAN -------- */
function playAdhan(channel, audioFile) {
  return new Promise((resolve) => {
    let settled = false;
    let cleaned = false;
    let readyReached = false;

    let connection = null;
    let player = null;
    let resource = null;

    let idleTimer = null;
    let lostTimer = null;
    let noPlayingTimer = null;
    let watchdog = null;

    let connectionStateListener = null;
    let playerStateListener = null;
    let playerErrorListener = null;
    let idleListener = null;
    let resourceErrorListener = null;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;

      if (idleTimer) clearTimeout(idleTimer);
      if (lostTimer) clearTimeout(lostTimer);
      if (noPlayingTimer) clearTimeout(noPlayingTimer);
      if (watchdog) clearTimeout(watchdog);

      if (player) {
        if (playerStateListener) player.off('stateChange', playerStateListener);
        if (playerErrorListener) player.off('error', playerErrorListener);
        if (idleListener) player.off(AudioPlayerStatus.Idle, idleListener);

        try {
          player.stop(true);
        } catch {}
      }
      if (connection) {
        if (connectionStateListener) {
          connection.off('stateChange', connectionStateListener);
        }

        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          try {
            connection.destroy();
          } catch {}
        }
      }

      removeActivePlayer(channel.guild.id, player, connection);
    }

    function finish(reason) {
      if (settled) return;
      settled = true;

      logTimestamp(`playAdhan finished in ${channel.name}: ${reason}`);

      if (currentFinish === finish) {
        currentFinish = null;
      }

      cleanup();
      resolve();
    }

    currentFinish = finish;

    async function run() {
      player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause
        }
      });

      playerStateListener = (oldState, newState) => {
        logTimestamp(`Player state: ${oldState.status} -> ${newState.status}`);
      };

      playerErrorListener = (err) => {
        logTimestamp(`Player error: ${err.message}`);
        finish('player error');
      };

      idleListener = () => {
        logTimestamp('Player idle');

        if (settled) return;

        if (!adhanRunning) {
          finish('stopped');
        } else {
          idleTimer = setTimeout(() => finish('idle complete'), 5000);
        }
      };

      player.on('stateChange', playerStateListener);
      player.on('error', playerErrorListener);
      player.on(AudioPlayerStatus.Idle, idleListener);

      let readyConnection = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        if (settled) return;

        const joinStart = Date.now();

        const conn = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false
        });

        connection = conn;
        addActivePlayer(channel.guild.id, player, conn);

        connectionStateListener = (oldState, newState) => {
          logTimestamp(`Voice connection state: ${oldState.status} -> ${newState.status}`);
          if (!readyReached) return;

          if (newState.status === VoiceConnectionStatus.Destroyed) {
          finish('connection destroyed');
          return;
          }
          if (newState.status === VoiceConnectionStatus.Ready) {
          if (lostTimer) { clearTimeout(lostTimer); lostTimer = null; }
          return;
        }
        if (oldState.status === VoiceConnectionStatus.Ready && !lostTimer) {
        lostTimer = setTimeout(() => finish('connection lost'), 30_000);
        }
  };

        conn.on('stateChange', connectionStateListener);
        conn.subscribe(player);

        try {
          await entersState(conn, VoiceConnectionStatus.Ready, 30_000);

          logTimestamp(
            `Voice Ready in ${channel.name} after ${Date.now() - joinStart}ms (attempt ${attempt})`
          );

          readyConnection = conn;
          readyReached = true;

          watchdog = setTimeout(() => finish('watchdog timeout'), 10 * 60 * 1000);
          break;
        } catch {
          logTimestamp(
            `Voice not Ready after 30s in ${channel.name} (attempt ${attempt}). ` +
            `Final state: ${conn.state.status}`
          );

          if (settled) return;

          conn.off('stateChange', connectionStateListener);

          if (conn.state.status !== VoiceConnectionStatus.Destroyed) {
            try {
              conn.destroy();
            } catch {}
          }

          removeActivePlayer(channel.guild.id, player, conn);

          if (attempt === 1) {
            continue;
          }

          finish('voice never ready');
          return;
        }
      }

      if (!readyConnection || settled) return;

      await new Promise(r => setTimeout(r, 1000));
      if (settled) return;

      resource = createAudioResource(path.join(__dirname, audioFile), {
        inputType: StreamType.Arbitrary
      });

      resourceErrorListener = (err) => {
        logTimestamp(`Resource/ffmpeg error: ${err.message}`);
        finish('resource error');
      };

      resource.playStream.on('error', resourceErrorListener);

      player.play(resource);
      logTimestamp(`Player play() called in ${channel.name}`);

      noPlayingTimer = setTimeout(() => {
        if (player.state.status !== AudioPlayerStatus.Playing) {
          finish('no playing state within 10s');
        }
      }, 10_000);
    }

    run().catch((err) => {
      logTimestamp(`playAdhan unexpected error: ${err.message}`);
      finish('unexpected error');
    });
  });
}
/* -------- STOP ADHAN -------- */
function stopAdhan() {
  adhanRunning = false;

  if (currentFinish) {
    currentFinish('stopped');
  }

  for (const { players, connections } of activePlayers.values()) {
    for (const player of players) {
      try {
        player.stop(true);
      } catch {}
    }

    for (const connection of connections) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try {
          connection.destroy();
        } catch {}
      }
    }
  }

  activePlayers.clear();
}
/* -------- FIND ACTIVE VOICE CHANNELS -------- */
function getActiveVoiceChannels(guild) {
  const { ignoredChannels } = getServerConfig(guild.id);

  return guild.channels.cache.filter(channel =>
    channel.type === ChannelType.GuildVoice &&
    channel.id !== guild.afkChannelId &&
    !ignoredChannels.includes(channel.id) &&
    channel.members.filter(m => !m.user.bot).size > 0
  );
}
/* -------- PLAY IN ALL ROOMS -------- */
async function runAdhan(guildId = null, prayer = 'Test') {
  if (adhanRunning) {
    logTimestamp('Adhan already running, skipping new run.');
    return;
  }

  adhanRunning = true;
  activePlayers.clear();

  try {
    const audioFile = PRAYER_AUDIO[prayer] ?? PRAYER_AUDIO['Test'];
    logTimestamp(`Playing audio: ${audioFile}`);

    const guilds = guildId
      ? [mainBot.guilds.cache.get(guildId)].filter(Boolean)
      : [...mainBot.guilds.cache.values()];

    for (const guild of guilds) {
      if (!adhanRunning) break;

      const channels = [...getActiveVoiceChannels(guild).values()];

      for (const channel of channels) {
        if (!adhanRunning) break;

        await playAdhan(channel, audioFile);
      }
    }
  } finally {
    adhanRunning = false;
    activePlayers.clear();
  }
}
/* -------- SEND CHAT MESSAGE -------- */
async function sendPrayerMessage(prayer, hijri, gregorian, guildId = null) {
  try {
    let channelId = TEXT_CHANNEL_ID;
    if (guildId) {
      const { textChannelId } = getServerConfig(guildId);
      if (textChannelId) channelId = textChannelId;
    }
    const channel = await mainBot.channels.fetch(channelId);
    const prayerAr = PRAYER_NAMES_AR[prayer] ?? prayer;

    // Styled embed when the bot may embed links in that channel; plain text otherwise
    const me = channel.guild?.members?.me;
    const canEmbed = me ? (channel.permissionsFor(me)?.has(PermissionFlagsBits.EmbedLinks) ?? true) : true;
    if (canEmbed) {
      const t = getAlgiersParts();
      const timeText = `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
      const hijriText = /^\d+-\d+-\d+$/.test(hijri) ? formatHijriDate(hijri) : 'غير متاح';
      await channel.send({
        embeds: [buildAdhanEmbed({ prayer, prayerAr, timeText, hijriText, gregorian })]
      });
      return;
    }

    await channel.send(
`🕌 **حان وقت صلاة ${prayerAr} — الجزائر العاصمة**
📅 الهجري: ${formatHijriDate(hijri)}
📆 الميلادي: ${gregorian}
🔊 الأذان يُبَث الآن في قنوات الصوت.`
    );
  } catch (err) {
    console.error('Failed to send prayer message:', err.message);
  }
}
/* -------- FETCH PRAYER TIMES -------- */
async function fetchPrayerTimes(date = getAlgiersDateDDMMYYYY()) {
  const url =
    `https://api.aladhan.com/v1/timings/${date}` +
    `?latitude=36.7538&longitude=3.0588&method=19` +
    `&timezonestring=${encodeURIComponent(TIMEZONE)}`;

  let lastErr;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(url);
      return res.data.data;
    } catch (err) {
      lastErr = err;
      logTimestamp(`Prayer times fetch attempt ${attempt}/3 failed: ${err.message}`);

      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  throw lastErr;
}
/* -------- SCHEDULE PRAYERS -------- */
async function schedulePrayerTimes() {
  // Cancel any previously scheduled prayer timers
  while (scheduledTimers.length) clearTimeout(scheduledTimers.pop());

  const data = await fetchPrayerTimes();
  const timings = data.timings;
  const hijri = data.date.hijri.date;
  const gregorian = data.date.gregorian.date;
  const prayers = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
  const now = Date.now();
  const algiers = getAlgiersParts(new Date(now));

  for (const prayer of prayers) {
    const { hour, minute } = parseAlgiersTime(timings[prayer]);
    const targetUtc = algiersWallToUtc(
      algiers.year,
      algiers.month,
      algiers.day,
      hour,
      minute,
      0,
      0
    );
    const delay = targetUtc - now;

    if (delay > 0) {
      logTimestamp(
        `${prayer} scheduled at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ` +
        `Algiers time (in ${Math.round(delay / 60000)} min)`
      );
      const timer = setTimeout(async () => {
        for (const guild of mainBot.guilds.cache.values()) {
          await sendPrayerMessage(prayer, hijri, gregorian, guild.id);
        }
        await runAdhan(null, prayer);
      }, delay);
      scheduledTimers.push(timer);
    } else {
      logTimestamp(`${prayer} already passed, skipping.`);
    }
  }
}
/* -------- MIDNIGHT REFRESH -------- */
function scheduleMidnightRefresh() {
  if (midnightRefreshTimer) return;

  const delay = getNextAlgiersMidnightPlusOneMs() - Date.now();

  midnightRefreshTimer = setTimeout(async () => {
    midnightRefreshTimer = null;

    logTimestamp("Refreshing prayer times for new day...");

    try {
      await schedulePrayerTimes();
      scheduleMidnightRefresh();
    } catch (err) {
      logTimestamp(`Midnight refresh failed: ${err.message}`);
      retryMidnightRefresh();
    }
  }, delay);
}

function retryMidnightRefresh() {
  if (midnightRefreshTimer) return;

  midnightRefreshTimer = setTimeout(async () => {
    midnightRefreshTimer = null;

    logTimestamp("Retrying prayer times refresh...");

    try {
      await schedulePrayerTimes();
      scheduleMidnightRefresh();
    } catch (err) {
      logTimestamp(`Midnight refresh retry failed: ${err.message}`);
      retryMidnightRefresh();
    }
  }, 5 * 60 * 1000);
}

function retryInitialSchedule() {
  if (initialScheduleRetryTimer) return;

  initialScheduleRetryTimer = setTimeout(async () => {
    initialScheduleRetryTimer = null;

    try {
      await schedulePrayerTimes();
    } catch (err) {
      logTimestamp(`Initial prayer schedule retry failed: ${err.message}`);
      retryInitialSchedule();
    }
  }, 5 * 60 * 1000);
}
/* -------- /TIMES CARD (shared by the command and the refresh button) -------- */
async function buildTimesPayload() {
  const data = await fetchPrayerTimes();
  const timings = data.timings;
  const hijri = data.date.hijri.date;
  const gregorian = data.date.gregorian.date;

  const now = Date.now();
  const algiers = getAlgiersParts(new Date(now));

  const prayerList = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"].map(prayer => {
    const { hour, minute } = parseAlgiersTime(timings[prayer]);
    return {
      key: prayer,
      nameAr: PRAYER_NAMES_AR[prayer],
      timeText: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      targetUtc: algiersWallToUtc(algiers.year, algiers.month, algiers.day, hour, minute, 0, 0)
    };
  });

  return {
    embeds: [buildTimesEmbed({
      hijriText: formatHijriDate(hijri),
      gregorian,
      prayers: prayerList,
      nowMs: now
    })],
    components: [buildTimesComponents()]
  };
}

/* Refresh button: rebuilds the card in place. One edit per click; clicks on the
   same card closer than REFRESH_COOLDOWN_MS are acknowledged but ignored. */
const REFRESH_COOLDOWN_MS = 3000;
const lastRefreshByMessage = new Map(); // message id -> timestamp of last rebuild

async function handleTimesRefresh(interaction) {
  try {
    await interaction.deferUpdate();

    const messageId = interaction.message.id;
    const last = lastRefreshByMessage.get(messageId) ?? 0;
    if (Date.now() - last < REFRESH_COOLDOWN_MS) return;

    if (lastRefreshByMessage.size > 200) lastRefreshByMessage.clear();
    lastRefreshByMessage.set(messageId, Date.now());

    await interaction.editReply(await buildTimesPayload());
  } catch (err) {
    logTimestamp(`Times refresh failed: ${err.message}`);
    try {
      await interaction.followUp({
        content: '❌ تعذّر تحديث المواقيت. حاول مرة أخرى.',
        flags: MessageFlags.Ephemeral
      });
    } catch {}
  }
}
/* -------- SHARED COMMAND HANDLER -------- */
async function handleCommand(commandName, options, reply, guildId, guild) {
  if (commandName === 'testadhan') {
    try {
      let hijri = 'N/A', gregorian = 'N/A';
      try {
        const data = await fetchPrayerTimes();
        hijri = data.date.hijri.date;
        gregorian = data.date.gregorian.date;
      } catch {}
      await reply('🔊 جارٍ تشغيل الاختبار — إرسال الرسالة والانضمام إلى قنوات الصوت...');
      await sendPrayerMessage('Test', hijri, gregorian, guildId);
      await runAdhan(guildId, 'Test');
      await reply('✅ اكتمل الاختبار.');
    } catch (err) {
      await reply('❌ فشل الاختبار: ' + err.message);
    }
    return;
  }
  if (commandName === 'stopadhan') {
    stopAdhan();
    await reply('🛑 تم إيقاف الأذان وإخراج البوت من القنوات الصوتية.');
    return;
  }
  if (commandName === 'setchannel') {
    const channelId = options.channel_id;
    const target = guild.channels.cache.get(channelId);
    if (!target) {
      await reply('❌ لم يتم العثور على القناة. تأكد من صحة الـ ID.');
      return;
    }
    setServerConfig(guildId, { textChannelId: channelId });
    await reply(`✅ سيتم إرسال إشعارات الصلاة إلى <#${channelId}> الآن.`);
    return;
  }
  if (commandName === 'ignorechannel') {
    const channelId = options.channel_id;
    const config = getServerConfig(guildId);
    if (config.ignoredChannels.includes(channelId)) {
      await reply('⚠️ هذه القناة مُتجاهَلة بالفعل.');
      return;
    }
    config.ignoredChannels.push(channelId);
    setServerConfig(guildId, { ignoredChannels: config.ignoredChannels });
    await reply(`✅ لن يدخل البوت إلى القناة \`${channelId}\` بعد الآن.`);
    return;
  }
  if (commandName === 'unignorechannel') {
    const channelId = options.channel_id;
    const config = getServerConfig(guildId);
    const updated = config.ignoredChannels.filter(id => id !== channelId);
    if (updated.length === config.ignoredChannels.length) {
      await reply('⚠️ هذه القناة ليست في قائمة التجاهل.');
      return;
    }
    setServerConfig(guildId, { ignoredChannels: updated });
    await reply(`✅ تمت إزالة القناة \`${channelId}\` من قائمة التجاهل.`);
    return;
  }
  if (commandName === 'refresh') {
    try {
      await reply('🔄 جارٍ إعادة جلب مواقيت الصلاة...');
      await schedulePrayerTimes();
      await reply('✅ تم تحديث مواقيت الصلاة بنجاح.');
    } catch (err) {
      await reply('❌ فشل التحديث: ' + err.message);
    }
    return;
  }

  if (commandName === 'times') {
    try {
      await reply(await buildTimesPayload());
    } catch (err) {
      await reply('❌ تعذّر جلب مواقيت الصلاة: ' + err.message);
    }
    return;
  }

  if (commandName === 'settings') {
    const config = getServerConfig(guildId);
    const textCh = config.textChannelId ? `<#${config.textChannelId}>` : `الافتراضي (\`${TEXT_CHANNEL_ID}\`)`;
    const ignored = config.ignoredChannels.length > 0
      ? config.ignoredChannels.map(id => `\`${id}\``).join(', ')
      : 'لا يوجد';
    await reply(`⚙️ **إعدادات هذا السيرفر:**\n📢 قناة الإشعارات: ${textCh}\n🔇 القنوات المتجاهلة: ${ignored}`);
    return;
  }
}
/* -------- SLASH COMMAND HANDLER -------- */
mainBot.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId === TIMES_REFRESH_ID) {
    await handleTimesRefresh(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const options = {};
  for (const opt of interaction.options.data) {
    options[opt.name] = opt.value;
  }
  await interaction.deferReply();
  await handleCommand(
    interaction.commandName,
    options,
    (msg) => interaction.editReply(msg),
    interaction.guild.id,
    interaction.guild
  );
});
/* -------- PREFIX COMMAND HANDLER (! commands still work) -------- */
mainBot.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  const content = message.content.trim();
  const lower = content.toLowerCase();
  const args = content.split(/\s+/);
  let commandName = null;
  const options = {};
  if (lower === '!testadhan') commandName = 'testadhan';
  else if (lower === '!stopadhan') commandName = 'stopadhan';
  else if (lower === '!settings') commandName = 'settings';
  else if (lower === '!times') commandName = 'times';
  else if (lower === '!refresh') commandName = 'refresh';
  else if (lower.startsWith('!setchannel')) {
    commandName = 'setchannel';
    options.channel_id = args[1];
    if (!options.channel_id) { await message.reply('❌ الاستخدام: `!setchannel <channel_id>`'); return; }
  }
  else if (lower.startsWith('!ignorechannel')) {
    commandName = 'ignorechannel';
    options.channel_id = args[1];
    if (!options.channel_id) { await message.reply('❌ الاستخدام: `!ignorechannel <channel_id>`'); return; }
  }
  else if (lower.startsWith('!unignorechannel')) {
    commandName = 'unignorechannel';
    options.channel_id = args[1];
    if (!options.channel_id) { await message.reply('❌ الاستخدام: `!unignorechannel <channel_id>`'); return; }
  }
  if (!commandName) return;
  await handleCommand(
    commandName,
    options,
    (msg) => message.reply(msg),
    message.guild.id,
    message.guild
  );
});
/* -------- GLOBAL ERROR HANDLERS -------- */
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message ?? err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.message ?? err);
});
/* -------- START -------- */
sodium.ready.then(() => {
  logTimestamp(
    `Startup time — Algiers: ${formatAlgiersNow()} | Host UTC: ${new Date().toISOString()}`
  );

  const ffmpegPath = process.env.FFMPEG_PATH;
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    console.error('FFmpeg path is missing or does not exist.');
  } else {
    console.log(`FFmpeg path OK: ${ffmpegPath}`);
  }

  for (const file of new Set(Object.values(PRAYER_AUDIO))) {
    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) {
      console.error(`Missing prayer audio file: ${file}`);
    } else {
      console.log(`Prayer audio file OK: ${file}`);
    }
  }

  console.log('Sodium ready, logging in bot...');
  mainBot.login(process.env.TOKEN_1);
});
