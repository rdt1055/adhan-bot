require('dotenv').config();
process.env.FFMPEG_PATH = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, ChannelType, ActivityType, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType, getVoiceConnection } = require('discord-voip');
const axios = require('axios');
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
/* -------- CONFIG -------- */
const TEXT_CHANNEL_ID = "1105074703669919779";
const IGNORED_CHANNELS = ["JOIN_HERE_CHANNEL_ID"];
const TOKENS = [
  process.env.TOKEN_1,
  process.env.TOKEN_2,
  process.env.TOKEN_3
];
/* -------- ACTIVE PLAYERS TRACKER (for stop command) -------- */
const activePlayers = new Map(); // guildId -> { player, connections[] }
let adhanRunning = false;
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
  { name: 'settings', description: 'عرض إعدادات البوت في هذا السيرفر' }
];
/* -------- CREATE BOTS -------- */
const bots = TOKENS.map((token, index) => {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      ...(index === 0 ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : [])
    ]
  });
  client.once('ready', () => {
    console.log(`Bot ready: ${client.user.tag}`);
    client.user.setPresence({
      activities: [{ name: 'prayer times', type: ActivityType.Watching }],
      status: 'online'
    });
  });
  return client;
});
const mainBot = bots[0];
/* -------- REGISTER SLASH COMMANDS -------- */
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKENS[0]);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(mainBot.user.id), { body: slashCommands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}
/* -------- PLAY ADHAN -------- */
async function playAdhan(bot, channel, audioFile) {
  console.log(`${bot.user?.tag} joining ${channel.name}`);
  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    connection.on('stateChange', (oldState, newState) => {
      console.log(`Voice connection: ${oldState.status} -> ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Signalling &&
          oldState.status === VoiceConnectionStatus.Connecting) {
        console.log('Connection looping — attempting rejoin...');
        connection.rejoinAttempts = 0;
        connection.rejoin();
      }
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      console.log(`Connection ready in ${channel.name}`);
    } catch {
      console.log(`Connection never reached Ready. Final state: ${connection.state.status}`);
      await new Promise(r => setTimeout(r, 7000));
    }
    if (!adhanRunning) {
      connection.destroy();
      return;
    }
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });
    const resource = createAudioResource(path.join(__dirname, audioFile), {
      inputType: StreamType.Arbitrary
    });
    // Track this player and connection for stop command
    if (!activePlayers.has(channel.guild.id)) {
      activePlayers.set(channel.guild.id, { players: [], connections: [] });
    }
    activePlayers.get(channel.guild.id).players.push(player);
    activePlayers.get(channel.guild.id).connections.push(connection);
    connection.subscribe(player);
    player.play(resource);
    console.log(`Player state after play(): ${player.state.status}`);
    player.on('stateChange', (o, n) => console.log(`Player: ${o.status} -> ${n.status}`));
    return new Promise((resolve, reject) => {
      player.on(AudioPlayerStatus.Idle, () => {
        console.log(`Adhan finished in ${channel.name}`);
        connection.destroy();
        resolve();
      });
      player.on('error', (err) => {
        console.error(`Player error:`, err.message);
        connection.destroy();
        reject(err);
      });
    });
  } catch (err) {
    console.error(`Failed to join ${channel.name}:`, err.message);
  }
}
/* -------- STOP ADHAN -------- */
function stopAdhan() {
  adhanRunning = false;
  for (const [guildId, { players, connections }] of activePlayers.entries()) {
    for (const player of players) {
      try { player.stop(true); } catch {}
    }
    for (const connection of connections) {
      try { connection.destroy(); } catch {}
    }
  }
  activePlayers.clear();
}
/* -------- FIND ACTIVE VOICE CHANNELS -------- */
function getActiveVoiceChannels(guild) {
  const { ignoredChannels } = getServerConfig(guild.id);
  const allIgnored = [...IGNORED_CHANNELS, ...ignoredChannels];
  return guild.channels.cache.filter(channel =>
    channel.type === ChannelType.GuildVoice &&
    channel.id !== guild.afkChannelId &&
    !allIgnored.includes(channel.id) &&
    channel.members.filter(m => !m.user.bot).size > 0
  );
}
/* -------- PLAY IN ALL ROOMS -------- */
async function runAdhan(guildId = null, prayer = 'Test') {
  adhanRunning = true;
  activePlayers.clear();
  const audioFile = PRAYER_AUDIO[prayer] ?? PRAYER_AUDIO['Test'];
  console.log(`Playing audio: ${audioFile}`);
  const guilds = guildId
    ? [mainBot.guilds.cache.get(guildId)].filter(Boolean)
    : [...mainBot.guilds.cache.values()];
  for (const guild of guilds) {
    const channels = [...getActiveVoiceChannels(guild).values()];
    for (let i = 0; i < channels.length; i++) {
      const bot = bots[i % bots.length];
      const channel = channels[i];
      await playAdhan(bot, channel, audioFile);
    }
  }
  adhanRunning = false;
  activePlayers.clear();
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
async function fetchPrayerTimes() {
  const res = await axios.get(
    "https://api.aladhan.com/v1/timingsByCity?city=Algiers&country=Algeria&method=3"
  );
  return res.data.data;
}
/* -------- SCHEDULE PRAYERS -------- */
async function schedulePrayerTimes() {
  const data = await fetchPrayerTimes();
  const timings = data.timings;
  const hijri = data.date.hijri.date;
  const gregorian = data.date.gregorian.date;
  const prayers = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
  for (const prayer of prayers) {
    const [h, m] = timings[prayer].split(":");
    
    const nowUtc = new Date();
    const algiersOffset = 60; // UTC+1 in minutes
    const nowAlgiers = new Date(nowUtc.getTime() + algiersOffset * 60000);

    // Build prayer time in UTC by subtracting the offset back
    const prayerTimeAlgiers = new Date(nowAlgiers);
    prayerTimeAlgiers.setHours(Number(h));
    prayerTimeAlgiers.setMinutes(Number(m));
    prayerTimeAlgiers.setSeconds(0);
    prayerTimeAlgiers.setMilliseconds(0);

    const prayerTimeUtc = new Date(prayerTimeAlgiers.getTime() - algiersOffset * 60000);
    const delay = prayerTimeUtc - nowUtc;

    if (delay > 0) {
      console.log(`${prayer} scheduled at ${h}:${m} Algiers time (in ${Math.round(delay / 60000)} min)`);
      setTimeout(async () => {
        for (const guild of mainBot.guilds.cache.values()) {
          await sendPrayerMessage(prayer, hijri, gregorian, guild.id);
        }
        await runAdhan(null, prayer);
      }, delay);
    } else {
      console.log(`${prayer} already passed, skipping.`);
    }
  }
}
/* -------- MIDNIGHT REFRESH -------- */
function scheduleMidnightRefresh() {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  const delay = midnight - now;
  setTimeout(async () => {
    console.log("Refreshing prayer times for new day...");
    await schedulePrayerTimes();
    scheduleMidnightRefresh();
  }, delay);
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
  console.log('Sodium ready, logging in bots...');
  bots.forEach((bot, i) => bot.login(TOKENS[i]));
  mainBot.once("ready", async () => {
    console.log(`Main bot ready: ${mainBot.user.tag}`);
    await registerSlashCommands();
    await schedulePrayerTimes();
    scheduleMidnightRefresh();
  });
});
