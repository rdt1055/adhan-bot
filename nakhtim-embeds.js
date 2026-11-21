/* -------- NAKHTIM EMBEDS & COMPONENTS: channel panel, surah intro, DM ayah card, tafsir -------- */
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder, escapeMarkdown
} = require('discord.js');

const COLOR = 0x1f8b4c;
const BISMILLAH = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';

const PREFIX = 'nakhtim:';
const SUB_ID = 'nakhtim:sub';
const UNSUB_ID = 'nakhtim:unsub';
const RECITER_SUB_ID = 'nakhtim:reciter:sub';
const RECITER_CHANGE_PREFIX = 'nakhtim:reciter:change:';
const CHANGE_RECITER_ID = 'nakhtim:changereciter';

const RECITERS = [
  {
    key: 'alafasy',
    name: 'مشاري العفاسي',
    everyAyahFolder: 'Alafasy_128kbps',
    fullSurahServer: 'https://cdn.mp3quran.net/audio/mishary-alafasy/r1/',
    qualityNote: 'حفص عن عاصم — مرتل'
  },
  {
    key: 'ghamdi',
    name: 'سعد الغامدي',
    everyAyahFolder: 'Ghamadi_40kbps',
    fullSurahServer: 'https://cdn.mp3quran.net/audio/saad-ghamdi/r1/',
    qualityNote: 'حفص عن عاصم — مرتل'
  },
  {
    key: 'husary',
    name: 'محمود خليل الحصري',
    everyAyahFolder: 'Husary_128kbps',
    fullSurahServer: 'https://cdn.mp3quran.net/audio/mahmoud-husary/r1/',
    qualityNote: 'حفص عن عاصم — مرتل'
  }
];
const DEFAULT_RECITER = 'alafasy';

const pad3 = (n) => String(n).padStart(3, '0');

function getReciter(key) {
  return RECITERS.find((r) => r.key === key) ?? RECITERS[0];
}

function ayahAudioUrl(reciter, s, a) {
  return `https://everyayah.com/data/${reciter.everyAyahFolder}/${pad3(s)}${pad3(a)}.mp3`;
}

function surahAudioUrl(reciter, s) {
  return `${reciter.fullSurahServer}${pad3(s)}.mp3`;
}

function buildChannelPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('📖 نختم — قراءة القرآن الكريم آيةً بآية')
    .setDescription(
      'اقرأ القرآن الكريم في رسائلك الخاصة آيةً بآية بالرسم العثماني (برواية حفص عن عاصم)، مع:\n' +
      '• 📖 **التفسير الميسر** لكل آية (مع تبيان الآيات المترابطة ومقدمة كل سورة)\n' +
      '• 🔊 **تلاوة صوتية** لكل آية بصوت القارئ الذي تختاره\n' +
      '• 🎧 **السورة كاملة صوتياً** و **نسخة PDF من المصحف** عند إتمام كل سورة\n' +
      '• 🎙️ إمكانية **تغيير القارئ** في أي وقت\n\n' +
      'اضغط **«اشترك»** للبدء أو استئناف قراءتك من حيث توقفت، أو **«إيقاف»** لإيقاف الاشتراك مؤقتاً مع حفظ التقدم.'
    )
    .setFooter({ text: 'الرسم العثماني (حفص عن عاصم) • التفسير الميسر' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(SUB_ID).setLabel('اشترك').setEmoji('📖').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(UNSUB_ID).setLabel('إيقاف').setEmoji('🛑').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

function buildReciterMenuRow(customId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('اختر القارئ...')
    .addOptions(
      RECITERS.map((r) => ({
        label: r.name,
        description: r.qualityNote,
        value: r.key
      }))
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildSurahIntroPayload(surah, introText, reciter) {
  const ayahWord = surah.ayahCount >= 3 && surah.ayahCount <= 10 ? 'آيات' : 'آية';
  let desc = `## 📖 ${surah.name}\n**السورة رقم ${surah.n} • ${surah.ayahCount} ${ayahWord}**`;
  if (introText) {
    const formattedIntro = escapeMarkdown(introText)
      .replace(/^(تسمية السورة|من مقاصد السورة)$/gm, '### $1');
    desc += `\n\n${formattedIntro}`;
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setDescription(desc)
    .setFooter({ text: `التفسير الميسر • القارئ: ${reciter.name} • اضغط «التالية» لبدء السورة` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}previntro:${surah.n}`)
      .setLabel('السابقة ◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(surah.n === 1),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}start:${surah.n}`)
      .setLabel('التالية ▶')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CHANGE_RECITER_ID)
      .setLabel('تغيير القارئ')
      .setEmoji('🎙️')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row], files: [] };
}

function buildAyahPayload(ayahObj, reciter, imageInfo = null) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`📖 ${ayahObj.surahName} — الآية ${ayahObj.a} / ${ayahObj.ayahCount}`)
    .setFooter({ text: `القرآن الكريم (حفص عن عاصم) • سورة ${ayahObj.s} • القارئ: ${reciter.name}` });

  const files = [];
  if (imageInfo?.buffer && imageInfo?.filename) {
    if (ayahObj.a === 1 && ayahObj.s !== 1 && ayahObj.s !== 9) {
      embed.setDescription(`### ${BISMILLAH}`);
    }
    embed.setImage(`attachment://${imageInfo.filename}`);
    files.push(new AttachmentBuilder(imageInfo.buffer, { name: imageInfo.filename }));
  } else {
    const body = escapeMarkdown(ayahObj.text);
    const desc = (ayahObj.a === 1 && ayahObj.s !== 1 && ayahObj.s !== 9)
      ? `${BISMILLAH}\n\n### ${body}`
      : `### ${body}`;
    embed.setDescription(desc);
  }

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}prev:${ayahObj.s}:${ayahObj.a}`)
      .setLabel('السابقة ◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(ayahObj.s === 1 && ayahObj.a === 1),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}next:${ayahObj.s}:${ayahObj.a}`)
      .setLabel('التالية ▶')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}tafsir:${ayahObj.s}:${ayahObj.a}`)
      .setLabel('التفسير')
      .setEmoji('📖')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}audio:${ayahObj.s}:${ayahObj.a}`)
      .setLabel('استماع')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary)
  );

  const settingsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CHANGE_RECITER_ID)
      .setLabel('تغيير القارئ')
      .setEmoji('🎙️')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [navRow, settingsRow], files };
}

function buildTafsirEmbed(tafsirObj) {
  const title = tafsirObj.startAyah === tafsirObj.endAyah
    ? `📖 تفسير الآية ${tafsirObj.a} — ${tafsirObj.surahName}`
    : `📖 تفسير الآيات ${tafsirObj.startAyah}–${tafsirObj.endAyah} — ${tafsirObj.surahName}`;

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .setDescription(escapeMarkdown(tafsirObj.text))
    .setFooter({ text: `المصدر: ${tafsirObj.source}` });
}

module.exports = {
  COLOR,
  BISMILLAH,
  PREFIX,
  SUB_ID,
  UNSUB_ID,
  RECITER_SUB_ID,
  RECITER_CHANGE_PREFIX,
  CHANGE_RECITER_ID,
  RECITERS,
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
};
