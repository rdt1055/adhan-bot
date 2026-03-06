require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once('ready', async () => {
  console.log('Ready:', client.user.tag);
  const channel = await client.channels.fetch('1105074703669919780');
  console.log('Channel:', channel.name);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });
  connection.on('stateChange', (o, n) => console.log(`${o.status} -> ${n.status}`));
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    console.log('CONNECTED SUCCESSFULLY');
    const player = createAudioPlayer();
    const resource = createAudioResource('./adhan.mp3');
    connection.subscribe(player);
    player.play(resource);
    player.on('stateChange', (o, n) => console.log(`Player: ${o.status} -> ${n.status}`));
  } catch {
    console.log('FAILED TO CONNECT. Final state:', connection.state.status);
  }
});

client.login(process.env.TOKEN_1);