require('dotenv').config();
process.env.FFMPEG_PATH = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');
const path = require('path');
const { Client, GatewayIntentBits, ChannelType, ActivityType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType } = require('discord-voip');
const axios = require('axios');
/* -------- CONFIG -------- */
const TEXT_CHANNEL_ID = "1105074703669919779";
const IGNORED_CHANNELS = [
  "JOIN_HERE_CHANNEL_ID" 
];
const TOKENS = [
  process.env.TOKEN_1,
  process.env.TOKEN_2,
  process.env.TOKEN_3
];
/* -------- CREATE BOTS -------- */
const bots = TOKENS.map((token, index) => {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      // Only the main bot needs message sending
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
/* -------- PLAY ADHAN -------- */
async function playAdhan(bot, channel) {
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

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });

    const resource = createAudioResource(path.join(__dirname, 'adhan.mp3'), {
      inputType: StreamType.Arbitrary
    });

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
/* -------- FIND ACTIVE VOICE CHANNELS -------- */
function getActiveVoiceChannels(guild) {
  return guild.channels.cache.filter(channel =>
    channel.type === ChannelType.GuildVoice &&
    channel.id !== guild.afkChannelId &&
    !IGNORED_CHANNELS.includes(channel.id) &&
    channel.members.filter(m => !m.user.bot).size > 0
  );
}
/* -------- PLAY IN ALL ROOMS -------- */
async function runAdhan() {
  const guilds = mainBot.guilds.cache;
  for (const guild of guilds.values()) {
    const channels = [...getActiveVoiceChannels(guild).values()];
    for (let i = 0; i < channels.length; i++) {
      const bot = bots[i % bots.length];
      const channel = channels[i];
      await playAdhan(bot, channel);
    }
  }
}
/* -------- SEND CHAT MESSAGE -------- */
async function sendPrayerMessage(prayer, hijri, gregorian) {
  try {
    const channel = await mainBot.channels.fetch(TEXT_CHANNEL_ID);
    await channel.send(
`🕌 **${prayer} Prayer Time – Algiers**
Hijri: ${hijri}
Gregorian: ${gregorian}
Adhan is now playing in active voice channels.`
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
    const now = new Date();
    const prayerTime = new Date();
    prayerTime.setHours(Number(h));
    prayerTime.setMinutes(Number(m));
    prayerTime.setSeconds(0);
    prayerTime.setMilliseconds(0);
    const delay = prayerTime - now;
    if (delay > 0) {
      console.log(`${prayer} scheduled at ${h}:${m} (in ${Math.round(delay / 60000)} min)`);
      setTimeout(async () => {
        await sendPrayerMessage(prayer, hijri, gregorian);
        await runAdhan();
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
/* -------- TEST COMMAND -------- */
mainBot.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() !== '!testadhan') return;
  console.log(`!testadhan triggered by ${message.author.tag}`);
  try {
    let hijri = 'N/A', gregorian = 'N/A';
    try {
      const data = await fetchPrayerTimes();
      hijri = data.date.hijri.date;
      gregorian = data.date.gregorian.date;
    } catch (err) {
      console.error('Could not fetch dates for test message:', err.message);
    }
    await message.reply('🔊 Running adhan test — sending message and joining active voice channels...');
    await sendPrayerMessage('Test', hijri, gregorian);
    await runAdhan();
    await message.reply('✅ Test complete.');
  } catch (err) {
    console.error('Test command error:', err.message);
    try { await message.reply('❌ Test failed: ' + err.message); } catch {}
  }
});

/* -------- GLOBAL ERROR HANDLERS (prevent crashes) -------- */
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
    await schedulePrayerTimes();
    scheduleMidnightRefresh();
  });
});