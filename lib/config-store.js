const path = require('path');
const fs = require('fs');
/* -------- SERVER CONFIG -------- */
const CONFIG_FILE = path.join(__dirname, '..', 'serverconfig.json');
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

module.exports = { loadConfigs, saveConfigs, getServerConfig, setServerConfig };
