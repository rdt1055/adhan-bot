/* -------- EMBED BUILDERS (adhan announcement + /times) -------- */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const TIMES_REFRESH_ID = 'times:refresh';

// Right-to-left mark: keeps digit-only lines right-aligned inside the Arabic cards
const RLM = '\u200F';

// Per-prayer look: sunrise blue -> gold -> amber -> sunset red -> night navy
const PRAYER_STYLE = {
  Fajr:    { emoji: '🌅', color: 0x5b6ee1 },
  Dhuhr:   { emoji: '☀️', color: 0xf2c14e },
  Asr:     { emoji: '🌤️', color: 0xe9965a },
  Maghrib: { emoji: '🌇', color: 0xd2555e },
  Isha:    { emoji: '🌙', color: 0x2e3a87 },
  Test:    { emoji: '🔊', color: 0x57606f }
};
const DEFAULT_STYLE = { emoji: '🕌', color: 0x2f8f6b };

function styleFor(prayerKey) {
  return PRAYER_STYLE[prayerKey] ?? DEFAULT_STYLE;
}

// Milliseconds -> "HH:MM:SS" (exact at the moment the card is built)
function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

/* Adhan announcement posted to the text channel */
function buildAdhanEmbed({ prayer, prayerAr, timeText, hijriText, gregorian }) {
  const style = styleFor(prayer);

  return new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`${style.emoji}  حان وقت صلاة ${prayerAr}`)
    .setDescription('🔊 الأذان يُبَث الآن في قنوات الصوت.')
    .addFields(
      { name: '🕰️ التوقيت', value: `**${timeText}**`, inline: true },
      { name: '📅 الهجري', value: hijriText, inline: true },
      { name: '📆 الميلادي', value: gregorian, inline: true }
    )
    .setFooter({ text: 'الجزائر العاصمة' });
}

/* /times card. prayers = [{ key, nameAr, timeText, targetUtc }] in day order.
   Countdowns are exact HH:MM:SS as of nowMs; the refresh button rebuilds the card. */
function buildTimesEmbed({ hijriText, gregorian, prayers, nowMs }) {
  const next = prayers.find(p => p.targetUtc > nowMs) ?? null;
  const style = next ? styleFor(next.key) : DEFAULT_STYLE;

  const nextLine = next
    ? `⏭️ **الصلاة القادمة:** ${next.nameAr} — \`${formatCountdown(next.targetUtc - nowMs)}\``
    : '✅ انتهت صلوات اليوم.';

  const fields = prayers.map(p => {
    const passed = p.targetUtc <= nowMs;
    const isNext = next !== null && p.key === next.key;
    const secondLine = passed ? '✅' : `\`${formatCountdown(p.targetUtc - nowMs)}\``;
    return {
      name: `${styleFor(p.key).emoji} ${p.nameAr}${isNext ? ' ✨' : ''}`,
      value: `${RLM}**${p.timeText}**\n${RLM}${secondLine}`,
      inline: true
    };
  });

  return new EmbedBuilder()
    .setColor(style.color)
    .setTitle('🗓️ مواقيت الصلاة — الجزائر العاصمة')
    .setDescription(`📅 ${hijriText}  •  📆 ${gregorian}\n\n${nextLine}`)
    .addFields(fields)
    .setFooter({ text: 'الأوقات بتوقيت الجزائر' })
    .setTimestamp(new Date(nowMs));
}

/* The refresh button shown under the /times card */
function buildTimesComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TIMES_REFRESH_ID)
      .setLabel('تحديث')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}

module.exports = { buildAdhanEmbed, buildTimesEmbed, buildTimesComponents, TIMES_REFRESH_ID };
