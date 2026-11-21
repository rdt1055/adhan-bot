# Adhan Bot: project state (handoff 3, 21 Nov 2026)

Lives at `docs/PROJECT.md`. The agent reads it at the start of a task and updates the **Status** and **Next steps** sections at the end of every session. Replaces the earlier chat-based handoffs.

## 1. What this is
A Discord bot for small Arabic-speaking communities in Algeria. One Node.js process, one bot account (`adhanbot-main`), run locally on the owner's Windows PC (he uses `cmd`). All user-facing text is Arabic. Time is always Africa/Algiers (UTC+1, no DST). Hosting is unresolved (section 7).

## 2. Features and status
**Adhan (done, in use).** Fetches times from aladhan (lat 36.7538, lon 3.0588, method 19, timezone Africa/Algiers), schedules the five prayers, posts an embed (plain-text fallback without Embed Links), joins active voice channels one after another, plays the prayer mp3, leaves. Commands: `/testadhan /stopadhan /setchannel /ignorechannel /unignorechannel /settings /times /refresh` plus `!` versions. `/times` is an embed with HH:MM:SS countdowns and a refresh button (`times:refresh`). Adhan still uses long `setTimeout` calls, which may fire late after the PC sleeps (believed, untested).

**Ahadith v0 (done, in production in one server, posting 11:00).** Optional per server. One daily hadith (Sahih al-Bukhari / Sahih Muslim, 12,830 in the pool) with the full chain, split over up to 3 messages, footer shows the reference and "الحكم: صحيح". Commands (Manage Server): `/hadith setup channel [time] | time | off | status | test`. One shared pick per Algiers day, no repeats until all used, 30 s tick scheduler, catch-up on startup (up to 12 h late), 3 retries 5 min apart.

**Sharh: ON HOLD by the owner "until further notice".** Code is installed but dormant (needs `data/sharh.jsonl` + `data/sharh-index.json`, which do not exist). Do not touch it. Knowledge kept in case it is resumed: source Jawami' al-Kalim database (4.6 GB, owner's PC only), match by TEXT never by number, 9,224 of 12,830 hadiths matched at score >= 0.85, the alignment audit was never resolved on real data, Jawami "hokm" grades are not a usable verdict.

**Hadith grading (idea, undecided, parked behind Nakhtim).** Only matters if the pool expands beyond Bukhari/Muslim (everything there is sahih by collection). If pursued: compute grades once at build time into a small `data/grades.json` (join pool with a grade source by collection + number, verify text near-identical, else ungraded/drop), show the grader's name, send only sahih/hasan. Open question for the owner: which extra collections and which primary grader. Sources researched but untested: hadithapi.com, fawazahmed0/hadith-api (grades with grader names for Abu Dawud/Tirmidhi/Ibn Majah/Nasa'i), Dorar.net (best, API token requested, no answer).

**Nakhtim (Quran reader): V2 updates BUILT, offline-verified; awaiting private Discord test.** See section 4.

## 3. Code layout
- `bot.js`: entry. Creates the client, loads the `features` array (`adhan`, `ahadith`, `nakhtim`), routes interactions/messages, startup.
- `adhan.js`, `adhan-embeds.js`: adhan feature. Its `onInteraction` handles only `times:refresh` and slash commands and returns false otherwise.
- `ahadith.js`, `ahadith-embeds.js`: daily hadith (also holds the dormant sharh button). This is the **reference implementation of an optional per-server feature**; copy its patterns for Nakhtim.
- `nakhtim.js`, `nakhtim-embeds.js`: Nakhtim DM Quran reader (`/nakhtim setup|off|status`, panel subscribe/unsubscribe, reciter select, surah intro cards, parchment ayah PNGs + text fallback, sticky bottom panel, temp tafsir/audio auto-cleanup, grouped tafsir, per-ayah/full-surah audio, Medina Mushaf surah & Ajza' PDFs with Juz collapse, Khatmah Full Quran PDF link).
- `lib/`: `algiers-time.js`, `config-store.js` (serverconfig.json), `log.js`, `split-text.js`, `state-store.js` (atomic JSON in `data/`), `daily-scheduler.js` (30 s tick), `hadith-pool.js`, `quran-store.js`, `ayah-image.js`, `sharh-store.js`.
- `scripts/`: `build-hadith-pool.js`, `build-sharh.js` and `probe-*.js` (sharh/hadith helpers, on hold), `verify-nakhtim-data.js`, `test-nakhtim.js`.
- `serverconfig.json`: per guild `textChannelId`, `ignoredChannels`, `ahadith {enabled, channelId, time}`, `nakhtim {enabled, channelId, panelMessageId}`. `data/ahadith-state.json` and `data/nakhtim-state.json` are runtime state. `.env` holds `TOKEN_1`: never read it.
- Root also holds the 5 prayer mp3 files, `voicetest.js`, `README.md`, `build-report.txt` (housekeeping: delete).

## 4. Nakhtim: design (agreed with the owner)
**Idea.** A Quran ayah-by-ayah reader. Server owners optionally add a locked "subscribers" channel (dormant in servers that do not set it up, like ahadith). Each subscriber then reads ayah by ayah in their **DMs**.

**Server side.** `/nakhtim setup channel` (Manage Server) posts a locked panel with buttons "اشترك" and "إيقاف"; `/nakhtim off` and `/nakhtim status` manage it. Per-guild settings go in `serverconfig.json` under `nakhtim` (shallow-merge caveat applies).

**Subscribing.** The user presses اشترك, picks a reciter from a select menu (no `default: true` option so returning users can re-select their previous reciter after stopping; previous/current reciter shown in the prompt text), and the bot DMs Surah 1's intro card (or resumes saved position for returning users, cleaning up any stale panel/temp messages). If DMs are closed (`50007`), Discord rejects the message: reply ephemerally asking them to open DMs and retry. Bots cannot bypass this. Users can change reciter anytime via the `🎙️ تغيير القارئ` button on their DM panel.

**DM panel.**
- **Surah intro card** (shown when entering a surah via Subscribe or Next from the previous surah): medium-large surah heading (`## 📖 <name>`), surah number & ayah count, and the `تسمية السورة / من مقاصد السورة` intro block (`### ` headings for desktop readability) from `tafsir-muyassar.json`. Buttons: `السابقة ◀` (disabled on Surah 1, else jumps to last ayah of previous surah), `التالية ▶` (starts ayah `s:1`), `🎙️ تغيير القارئ`. No Tafsir or Audio buttons here.
- **Ayah card:** Arabic embed displaying the ayah as a trimmed, centered Medina Mushaf parchment calligraphy PNG (`#fbf6ea` background, `#1a1a1a` ink via `lib/ayah-image.js`, readable in both Discord Dark and Light mode; falls back to verified `quran-uthmani` text if the CDN fetch fails). `بِسْمِ ٱللَّهِ...` is shown (`### `) on `s:1` for surahs other than 1 and 9 (`1:1` is already Bismillah in the image; `9:1` has none). Buttons: Row 1 `السابقة ◀`، `التالية ▶`، `📖 التفسير`، `🔊 استماع`; Row 2 `🎙️ تغيير القارئ`.
- **Sticky bottom panel & temp cleanup:** Next/Prev edit the panel in place when no new messages were sent below; whenever tafsir, per-ayah audio, surah rewards, Juz PDF, or Khatmah celebration is posted, the bot reposts the reading panel at the very bottom (`repostPanelAtBottom`) and deletes the older panel. Navigating (`التالية ▶`, `السابقة ◀`, Start, PrevIntro) automatically deletes the previous ayah's temporary tafsir/audio messages (`tempMsgIds`) while keeping permanent audio/PDF/Khatmah messages. Buttons carry coordinates in custom IDs so they survive restarts.

**Progress.** Stored per user (not per server) in `data/nakhtim-state.json` via `state-store.js` (`surah`, `ayah`, `mode`, `reciter`, `sentSurahs`, `sentAjza`, `panelMsgId`, `tempMsgIds`, `surahPdfMsgs`, `khatmahCount`). New users start at Surah 1 intro -> `1:1`. After `114:6`, Next keeps Surah 114 PDF, sends Juz 30 PDF (collapsing Surahs 78..113), sends the Khatmah celebration message + Full Medina Mushaf PDF link, resets `sentSurahs`/`sentAjza`/`surahPdfMsgs`, and wraps to Surah 1 intro.

**Reciter.** Chosen at subscription and changeable anytime. Testing list (expandable to 10 after testing): `alafasy` (Alafasy), `ghamdi` (Saad al-Ghamdi), `husary` (Husary).

**Audio & Medina Mushaf PDFs.**
- Per-ayah mp3 from EveryAyah: `Alafasy_128kbps`, `Ghamadi_40kbps`, `Husary_128kbps` (all 6,236 x 3 verified).
- Ayah calligraphy PNGs from `cdn.islamic.network/quran/images/high-resolution/<s>_<a>.png` (all 6,236 verified with valid PNG signature & IHDR dimensions; largest raw `2_282` = 118 KB; recolored & LRU-cached in `lib/ayah-image.js`).
- When a user completes a surah (`sentSurahs` 1x guard, not re-sent on revisit):
  1. **Full-surah audio** from mp3quran.net (`حفص عن عاصم - مرتل` `r1` for all 3 reciters, owner-confirmed voice match): attached when `<= 19.5 MiB` (official Discord default limit is **20 MiB**, enforced with a streaming byte cap), otherwise sent as a clickable MP3 link (Alafasy 88/114, Ghamdi 102/114, Husary 74/114 fit under 20 MiB).
  2. **Full-surah Medina Mushaf PDF** from `pdfquran.com/standard1` (`data/surah-pdfs.json`, 114/114 verified `%PDF-`; includes Surah name, Juz/Hizb, and page headers on every page; Surah 2 Al-Baqarah = 12.06 MiB <= 20 MiB so all 114 fit; degrades silently if missing).
- When a user completes a **Juz** (`sentAjza` 1x guard, `data/juz-pdfs.json` from `archive.org/01_20200522_20200522`): deletes wholly-contained individual surah PDFs from `surahPdfMsgs` (except Surah 114 on Khatmah) and sends the Juz Medina Mushaf PDF (29/30 fit under 20 MiB; Juz 1 is link-only).
- On **Khatmah** (`114:6` -> Next): links the Full Medina Mushaf PDF (`archive.org/download/MushafMadinaHafsGreen1441/MushafMadinaHafsGreen1441.pdf`, 62.00 MiB, verified `%PDF-`).

**Tafsir.** Al-Muyassar cached in `data/tafsir-muyassar.json`. Covers **groups of ayahs** (1,196 repeated entries; e.g., 2:45-46 show title `تفسير الآيات 45–46` every time pressed), intro blocks split off from both ayah 1 (114) and repeated opening-group ayahs (135), longest entry 1,444 chars (< 4,096 embed limit). Stray `[التفسير]` in `5:60` left untouched by owner decision.

**Quran text.** Primary source (used for fallback & metadata): `alquran.cloud` `quran-uthmani` (Tanzil Uthmani Hafs with dagger alefs, maddah, and waqf marks; 112 prepended surah Bismillahs stripped cleanly, 0 mid-text edits; also provides continuous 30 Ajza' boundaries), cross-checked against `fawazahmed0` `ara-quranuthmanihaf` (0 hard diffs).

**Later (v2, not in V1).** 24-hour auto-advance with a stop option; jump-to-surah (needs a paged select menu, 114 > 25 options).

**V1 quality bar.** The owner will not publish to any server until everything is tested carefully; V1 must ship with full tafsir and audio. Mistakes are not acceptable.

### Verification script (`scripts/verify-nakhtim-data.js`, verified on live data)
- `node scripts\verify-nakhtim-data.js` (text + tafsir + 30 Ajza' boundaries), `--audio` (EveryAyah 6,236 x 3), `--fullsurah` (mp3quran.net), `--pdf` (`pdfquran.com/standard1` 114 Medina Mushaf PDFs + Archive.org 30 Ajza' & Full Mushaf), `--images` (6,236 ayah PNG headers + 8 full end-to-end `IEND` checks), `--all` (everything).
- Writes `nakhtim-report.txt` and, on passing checks, `data/quran.json`, `data/tafsir-muyassar.json`, `data/surah-pdfs.json`, `data/juz-pdfs.json`, `data/nakhtim-audio-check.json`, and `data/nakhtim-image-check.json`.
- Offline code + data + lifecycle test suite: `node scripts\test-nakhtim.js` (all 5 stages pass without connecting to Discord).

## 5. Decisions (do not relitigate without a reason)
- One process, modular features. A second text-only process reusing feature files is possible later (text needs no UDP).
- Hadith data: open hadith-api (Unlicense), Bukhari + Muslim only, diacritized Arabic edition. Hadith text is never altered except whitespace collapse, stray backslash removal, Markdown escaping. Splitting only at clause punctuation or spaces.
- A grade belongs to one specific narration; match by collection + number first, then near-identical text; always show who graded; only sahih/hasan are sent.
- Older commands stay open to everyone (small friend servers); new hadith/Nakhtim admin commands require Manage Server.
- The owner prefers: discuss trade-offs and see defaults stated as decisions before building; then complete tested files.

## 6. Facts learned the hard way
- discord-voip: `connection.destroy()` throws if already destroyed. `AudioResource` is not an EventEmitter (use `resource.playStream`). With `NoSubscriberBehavior.Play` the file is consumed before Ready (silent playback, early leave).
- Voice needs outbound UDP. Wispbyte reproduced the original symptom (joins, silent, never leaves); same code works on the owner's PC. bot-hosting.net voice untested. Text-only features do not need UDP.
- Slash command registration is one bulk PUT: one invalid command blocks all updates.
- Embed limits: description 4096, 6000 total per message. Hadith chunks are 3800 characters.
- hadith-api: Muslim `arabicnumber` is a string like '8.01'; Bukhari has 26 fractional duplicate numbers; Arabic text starts with the chain. Pool record fields: `id` (`bukhari:5`, `muslim:93`), `c`, `n`, `r` (citation number; Muslim by Abd al-Baqi), `t`.
- `serverconfig.json` writes are a shallow merge.
- `node:sqlite` is available on his Node 22 (experimental warning, fine).

## 7. Hosting (parked, "later")
The owner wants 24/7 uptime and has had trouble finding a free host that allows voice (UDP). Two options discussed, neither started:
1. **Old Android phone running Termux** at home (install Termux from F-Droid, not Play Store). Home Wi-Fi allows outbound UDP, so voice should work, no coordination needed. To check: `ffmpeg-static` likely fails on Android, so install `pkg install ffmpeg` and point the bot at it (check how discord-voip locates ffmpeg); Node version and Africa/Algiers timezone support; disable battery optimization for Termux, `termux-wake-lock`, Termux:Boot to auto-start, keep it plugged in (battery swelling risk), use Wi-Fi not mobile data. Not tested. iPhone is not viable.
2. **Friends' PCs as a failover network** (the owner's idea): everyone runs the same bot at startup (portable `node.exe` + `.bat` in the Startup folder), but only **one logs in at a time** via leader election with a lease in a free shared store with atomic set-if-not-exists + expiry (e.g. Upstash Redis): winner calls `client.login()`, renews every ~10 s, on a failed renewal it must `client.destroy()` immediately; others retry every ~10 s; failover ~30-40 s. Needs: shared state in the store instead of local JSON, adhan catch-up for the failover gap, auto-update on startup, and the **token risk** (anything on a friend's PC can read it): fetch the token from the store only after winning the lease, be ready to rotate. If PCs are on ~50% independently, 4 friends give ~94%, but real uptime clusters in the evenings.
The phone is the recommended first step; the network can be a later backup.

## 8. Next steps
1. Owner tests Nakhtim V2 privately in Discord (re-selecting same reciter after `إيقاف`, intro headings on desktop & mobile, parchment ayah PNGs in Dark & Light mode, sticky bottom panel + temp tafsir/audio cleanup, Medina Mushaf `standard1` surah PDFs, Juz collapse & Khatmah Full Quran PDF link, audio playback, restart persistence), then expands reciters from 3 to 10 when ready.
2. Housekeeping: delete `build-report.txt`; rotate the bot token if it was ever shared (a `.env` was uploaded in an earlier chat); `CONVENTIONS.md` is git-ignored and was for Aider (its rules are now in `AGENTS.md`); probe scripts can go only if the owner says sharh is dropped for good.
3. Port adhan scheduling to the tick-based scheduler.
4. Hosting (section 7). Hadith grading (section 2). Nakhtim V2 later items (24h auto-advance, jump-to-surah).

## 9. Status (agent: update this at the end of each session)
- 21 Nov 2026: Nakhtim V2 updates verified and offline-tested with 0 failures:
  - Switched Surah PDFs to Medina Mushaf `pdfquran.com/standard1` (114/114 `%PDF-`, Al-Baqarah 12.06 MiB <= 20 MiB) + 30 Archive.org Ajza' PDFs (29/30 <= 20 MiB, Juz 1 link-only) + Full Medina Mushaf PDF (`MushafMadinaHafsGreen1441.pdf`, 62.00 MiB) via `--pdf` (`data/surah-pdfs.json`, `data/juz-pdfs.json`).
  - Verified all 6,236 high-res ayah PNG headers + 8 full end-to-end `IEND` downloads via `--images` (`data/nakhtim-image-check.json`, largest raw `2_282` = 118 KB); built `lib/ayah-image.js` parchment (`#fbf6ea`/`#1a1a1a`) cropper/LRU cache.
  - Updated `nakhtim-embeds.js`, `lib/quran-store.js`, `nakhtim.js`, and `scripts/test-nakhtim.js` (no `default: true` reciter lock, `### ` intro headings, sticky bottom panel + temp message auto-cleanup, Juz surah PDF collapse except Surah 114, Khatmah Full Mushaf link, reciter change re-sending panel payload with cached PNG). All 7 JS files passed `node --check` and all 5 stages in `node scripts\test-nakhtim.js` passed. Pending owner's live private Discord V2 test.
