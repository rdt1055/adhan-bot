require('dotenv').config();
const { Client, GatewayIntentBits, ActivityType, REST, Routes } = require('discord.js');
const { logTimestamp } = require('./lib/log');
const { formatAlgiersNow } = require('./lib/algiers-time');

/* -------- FEATURES --------
   A feature exports: name, slashCommands, and optionally
   prepare(), onReady(client), onInteraction(interaction), onMessage(message).
   onInteraction / onMessage return true when they handled the event. */
const features = [
  require('./adhan'),
  require('./ahadith'),
  require('./nakhtim')
];

/* -------- CREATE BOT -------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* -------- REGISTER SLASH COMMANDS -------- */
async function registerSlashCommands() {
  const slashCommands = features.flatMap(f => f.slashCommands ?? []);
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN_1);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}

/* -------- READY -------- */
client.once('ready', async () => {
  console.log(`Bot ready: ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: 'prayer times', type: ActivityType.Watching }],
    status: 'online'
  });

  await registerSlashCommands();

  for (const feature of features) {
    try {
      await feature.onReady?.(client);
    } catch (err) {
      logTimestamp(`[${feature.name}] onReady failed: ${err.message}`);
    }
  }
});

/* -------- EVENT ROUTING (first feature that handles the event wins) -------- */
client.on('interactionCreate', async (interaction) => {
  for (const feature of features) {
    try {
      if (await feature.onInteraction?.(interaction)) return;
    } catch (err) {
      logTimestamp(`[${feature.name}] interaction failed: ${err.message}`);
      return;
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  for (const feature of features) {
    try {
      if (await feature.onMessage?.(message)) return;
    } catch (err) {
      logTimestamp(`[${feature.name}] message handler failed: ${err.message}`);
      return;
    }
  }
});

/* -------- GLOBAL ERROR HANDLERS -------- */
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message ?? err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.message ?? err);
});

/* -------- START -------- */
(async () => {
  logTimestamp(
    `Startup time — Algiers: ${formatAlgiersNow()} | Host UTC: ${new Date().toISOString()}`
  );

  for (const feature of features) {
    try {
      await feature.prepare?.();
    } catch (err) {
      console.error(`[${feature.name}] prepare failed:`, err.message);
    }
  }

  console.log('Features prepared, logging in bot...');
  client.login(process.env.TOKEN_1);
})();
