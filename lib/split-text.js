/* -------- SPLIT LONG TEXT INTO MESSAGE-SIZED CHUNKS --------
   Never changes the words: it only decides where to break, preferring the end of a
   clause (، . ؟ ! : ؛) in the last part of the allowed length, otherwise a space. */
const DEFAULT_LIMIT = 3800;   // embed description max is 4096; stay well below it
const LOOKBACK = 600;         // how far back from the limit we search for a clause end

function splitText(text, limit = DEFAULT_LIMIT) {
  let rest = String(text).trim();
  if (rest.length <= limit) return rest ? [rest] : [];

  const chunks = [];
  while (rest.length > limit) {
    const windowStart = Math.max(0, limit - LOOKBACK);
    const windowText = rest.slice(windowStart, limit);

    let cut = -1;
    const clauseEnds = [...windowText.matchAll(/[،.؟!:؛]\s/g)];
    if (clauseEnds.length > 0) {
      cut = windowStart + clauseEnds[clauseEnds.length - 1].index + 1;
    } else {
      cut = rest.lastIndexOf(' ', limit);
    }
    if (cut <= 0) cut = limit; // a single unbroken run longer than the limit (should not happen)

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/* Data clean-up applied before splitting: collapse whitespace, drop stray backslashes
   (a glitch in the source data, e.g. \" before a quote mark). */
function cleanHadithText(text) {
  return String(text).replace(/\\/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = { splitText, cleanHadithText, DEFAULT_LIMIT };
