/* -------- AHADITH EMBEDS: the daily hadith, split over several messages when long -------- */
const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { splitText, cleanHadithText } = require('./lib/split-text');

const COLOR = 0xc9a227;

/* Text size. Discord has no font-size option; header markdown is the closest thing.
   Try each value with /hadith test and keep the one that reads best:
   'normal' (as before) | 'large' (###) | 'larger' (##) | 'largest' (#)
   If you ever see the literal characters ### in a post, set this back to 'normal'. */
const TEXT_SIZE = 'large';
const SIZE_PREFIX = { normal: '', large: '### ', larger: '## ', largest: '# ' };
const COLLECTION_NAMES = { bukhari: 'صحيح البخاري', muslim: 'صحيح مسلم' };

// Every hadith in the pool comes from Sahih al-Bukhari or Sahih Muslim, whose contents the
// scholars agree are sahih, so the ruling shown is by collection.
const HOKM_TEXT = 'الحكم: صحيح';

function referenceText(record) {
  const book = COLLECTION_NAMES[record.c] ?? record.c;
  return `${book} — حديث رقم ${record.r} • ${HOKM_TEXT}`;
}

/* One embed per message. Every part carries the full text exactly as in the book (including the
   chain of narrators); the reference sits in the footer of the last part. */
function buildHadithEmbeds(record) {
  const chunks = splitText(cleanHadithText(record.t));
  const total = chunks.length;

  return chunks.map((chunk, i) => {
    const isLast = i === total - 1;
    return new EmbedBuilder()
      .setColor(COLOR)
      .setTitle(total > 1 ? `📖 حديث اليوم (${i + 1}/${total})` : '📖 حديث اليوم')
      .setDescription(SIZE_PREFIX[TEXT_SIZE] + escapeMarkdown(chunk)) // escape: verse separators like * must show as text, not italics
      .setFooter({ text: isLast ? referenceText(record) : 'يتبع في الرسالة التالية ⬇️' });
  });
}

/* -------- SHARH (shown only on request, in a private reply) -------- */
const SHARH_SOURCES = {
  fath: 'فتح الباري بشرح صحيح البخاري — ابن حجر العسقلاني',
  nawawi: 'شرح النووي على صحيح مسلم — الإمام النووي'
};
const SHARH_CREDIT = 'جوامع الكلم (أفق / إسلام ويب)';
const EMBED_TEXT_MAX = 4000; // embed description limit is 4096

// Escaping can add characters, so shorten at a clause end until the escaped text fits
function fitEscaped(raw) {
  let limit = raw.length;
  let chunk = raw;
  while (escapeMarkdown(chunk).length > EMBED_TEXT_MAX && limit > 200) {
    limit = Math.floor(limit * 0.9);
    chunk = splitText(raw, limit)[0];
  }
  return escapeMarkdown(chunk);
}

function buildSharhEmbed(sharh, hadith) {
  const source = SHARH_SOURCES[sharh.b] ?? sharh.b;
  const footer = [source, SHARH_CREDIT];
  if (sharh.tr) footer.push('مقتطف من الشرح');
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`📚 شرح الحديث — ${referenceText(hadith)}`)
    .setDescription(fitEscaped(sharh.s))
    .setFooter({ text: footer.join(' • ') });
}

module.exports = { buildHadithEmbeds, buildSharhEmbed, referenceText };
