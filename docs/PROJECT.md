# Adhan Bot: project state (handoff 3, 21 Nov 2026)

Lives at `docs/PROJECT.md`. The agent reads it at the start of a task and updates the **Status** and **Next steps** sections at the end of every session. Replaces the earlier chat-based handoffs.

## 1. What this is
A Discord bot for small Arabic-speaking communities in Algeria. One Node.js process, one bot account (`adhanbot-main`), run locally on the owner's Windows PC (he uses `cmd`). All user-facing text is Arabic. Time is always Africa/Algiers (UTC+1, no DST). Hosting is unresolved (section 7).

## 2. Features and status
**Adhan (done, in use).** Fetches times from aladhan (lat 36.7538, lon 3.0588, method 19, timezone Africa/Algiers), schedules the five prayers, posts an embed (plain-text fallback without Embed Links), joins active voice channels one after another, plays the prayer mp3, leaves. Commands: `/testadhan /stopadhan /setchannel /ignorechannel /unignorechannel /settings /times /refresh` plus `!` versions. `/times` is an embed with HH:MM:SS countdowns and a refresh button (`times:refresh`). Adhan still uses long `setTimeout` calls, which may fire late after the PC sleeps (believed, untested).

**Ahadith v0 (done, in production in one server, posting 11:00).** Optional per server. One daily hadith (Sahih al-Bukhari / Sahih Muslim, 12,830 in the pool) with the full chain, split over up to 3 messages, footer shows the reference and "الحكم: صحيح". Commands (Manage Server): `/hadith setup channel [time] | time | off | status | test`. One shared pick per Algiers day, no repeats until all used, 30 s tick scheduler, catch-up on startup (up to 12 h late), 3 retries 5 min apart.

**Sharh: ON HOLD by the owner "until further notice".** Code is installed but dormant (needs `data/sharh.jsonl` + `data/sharh-index.json`, which do not exist). Do not touch it. Knowledge kept in case it is resumed: source Jawami' al-Kalim database (4.6 GB, owner's PC only), match by TEXT never by number, 9,224 of 12,830 hadiths matched at score >= 0.85, the alignment audit was never resolved on real data, Jawami "hokm" grades are not a usable verdict.

**Hadith grading (idea, undecided, parked behind Nakhtim).** Only matters if the pool expands beyond Bukhari/Muslim (everything there is sahih by collection). If pursued: compute grades once at build time into a small `data/grades.json` (join pool with a grade source by collection + number, verify text near-identical, else ungraded/drop), show the grader's name, send only sahih/hasan. Open question for the owner: which extra collections and which primary grader. Sources researched but untested: hadithapi.com, fawazahmed0/hadith-api (grades with grader names for Abu Dawud/Tirmidhi/Ibn Majah/Nasa'i), Dorar.net (best, API token requested, no answer).

**Nakhtim (Quran reader): IN PROGRESS, current focus.** See section 4.

## 3. Code layout
- `bot.js`: entry. Creates the client, loads the `features` array, routes interactions/messages, startup.
- `adhan.js`, `adhan-embeds.js`: adhan feature. Its `onInteraction` handles only `times:refresh` and slash commands and returns false otherwise.
- `ahadith.js`, `ahadith-embeds.js`: daily hadith (also holds the dormant sharh button). This is the **reference implementation of an optional per-server feature**; copy its patterns for Nakhtim.
- `lib/`: `algiers-time.js`, `config-store.js` (serverconfig.json), `log.js`, `split-text.js`, `state-store.js` (atomic JSON in `data/`), `daily-scheduler.js` (30 s tick), `hadith-pool.js`, `sharh-store.js`.
- `scripts/`: `build-hadith-pool.js`, `build-sharh.js` and `probe-*.js` (sharh helpers, on hold), `verify-nakhtim-data.js` (new, see 4).
- `serverconfig.json`: per guild `textChannelId`, `ignoredChannels`, `ahadith {enabled, channelId, time}`. `data/ahadith-state.json` is runtime state. `.env` holds `TOKEN_1`: never read it.
- Root also holds the 5 prayer mp3 files, `voicetest.js`, `README.md`, `build-report.txt` (housekeeping: delete).

## 4. Nakhtim: design (agreed with the owner)
**Idea.** A Quran ayah-by-ayah reader. Server owners optionally add a locked "subscribers" channel (dormant in servers that do not set it up, like ahadith). Each subscriber then reads ayah by ayah in their **DMs**.

**Server side.** `/nakhtim setup channel` (Manage Server) posts a locked panel with buttons "اشترك" and "إيقاف". Per-guild settings go in `serverconfig.json` under `nakhtim` (shallow-merge caveat applies).

**Subscribing.** The user presses اشترك, picks a reciter from a select menu, and the bot DMs ayah 1:1. If DMs are closed Discord rejects the message: reply ephemerally asking them to open DMs and retry. Bots cannot bypass this.

**DM panel.** Arabic embed: the ayah (Uthmani Hafs with diacritics), surah name and number, ayah number. Four Arabic buttons: السابقة ◀، التالية ▶، 📖 التفسير، 🔊 استماع. Default (decided by Claude, owner did not object): next/previous **edit the same message**; tafsir and audio arrive as separate messages. Buttons are handled by the normal interaction router so they survive restarts (custom IDs carry everything needed, state is stored).

**Progress.** Stored per user (not per server) in `data/` via `state-store.js`. New users start at 1:1. After 114:6 the next ayah wraps to 1:1.

**Reciter.** Chosen at subscription, stored per user. For testing: Alafasy, Saad al-Ghamdi, Husary (the owner is collecting friends' requests to fill a list of 10 after testing).

**Audio.** Per-ayah mp3 from EveryAyah: `https://everyayah.com/data/<folder>/SSSAAA.mp3` (3-digit surah + 3-digit ayah). Folders to verify: `Alafasy_128kbps`, `Ghamadi_40kbps` (only 40 kbps, quality modest), `Husary_128kbps`. When a user reaches the **last ayah of a surah via "next"**, the bot sends the **full-surah** audio once, with no input (not re-sent when going back and forth). Full surahs are not on EveryAyah: candidate source mp3quran.net (API `https://www.mp3quran.net/api/v3/reciters?language=ar`), must be the same reciter. Discord upload limit is assumed ~10 MB (unconfirmed): attach if it fits, otherwise send a link.

**Tafsir.** Al-Muyassar, cached locally. Data facts found on real data: (a) Muyassar comments on **groups of ayahs** (625 groups, 1,196 repeated entries, e.g. 2:45-46 share one text), so the tafsir button should say which ayahs it covers ("تفسير الآيات 45-46"); (b) the entry of the first ayah of every surah has an introduction block ("تسمية السورة / من مقاصد السورة" then the tafsir) which the verification script splits off and stores separately (decision pending: show it or not); (c) longest entry ~1,444 chars, so no splitting needed under the 4096 embed limit.

**Quran text.** Source A: fawazahmed0 `ara-quranuthmanihaf`. Known defect: in ~1,735 ayahs a stray space sits between a diacritic and a lone final alef/ya (e.g. "رَشَدࣰ ا" instead of "رَشَدࣰا", 18:10). The script removes only that space and counts it (the one text edit). **Needs the owner's explicit OK.** Another edition (`ara-quransimple`) has the Bismillah glued to the first ayah of every surah: do not use it.

**Later (v2, not in V1).** 24-hour auto-advance with a stop option; jump-to-surah (needs a paged select menu, 114 > 25 options).

**V1 quality bar.** The owner will not publish to any server until everything is tested carefully; V1 must ship with full tafsir and audio. Mistakes are not acceptable.

### Verification script (`scripts/verify-nakhtim-data.js`, written, not yet run by the owner)
- `node scripts\verify-nakhtim-data.js` checks text + tafsir. `--audio` checks all 6,236 ayah files x 3 reciters (resumable, cache in `data/nakhtim-audio-check.json`). `--fullsurah` checks mp3quran.net. `--all` does everything. It writes `nakhtim-report.txt`; only if every text/tafsir check passes does it write `data/quran.json` (`{surahs:[{n,name,ayahs[]}]}`) and `data/tafsir-muyassar.json` (`{source,intro:{n:text},tafsir:[[...]]}`); on failure it deletes older copies.
- Tested on real GitHub data for source A and the tafsir. Tested **only against a mock server** for: the alquran.cloud cross-check (second Quran copy and second Muyassar copy; response shape assumed), everyayah.com folder names, the mp3quran.net API shape, the 10 MB limit. Failure modes tested with the mock: corrupted ayah, shifted tafsir, missing audio file, incomplete recording.
- The built-in ayah-count table (6,236) was validated against the fawazahmed0 metadata.
- The owner must still: compare the 8 printed samples with a printed mushaf and tafsir book, listen to a few full-surah files to confirm the same reciter as the per-ayah ones, and test in real Discord privately before any server gets the panel.

### Nakhtim build order
1. Run the verification (text/tafsir, then `--audio`, then `--fullsurah`), fix script/source problems, get owner decisions (repair rule, intro display, grouped-tafsir wording, reciter folders, full-surah source, link-or-file).
2. Plan, then build `nakhtim.js` (+ `nakhtim-embeds.js`, `lib/quran-store.js`) and one line in `bot.js`.
3. Owner tests privately (own test server, DMs), then a small real server, only then publish.

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
1. Nakhtim phase 1: data verification (section 4).
2. Nakhtim build and staged testing.
3. Housekeeping: delete `build-report.txt`; rotate the bot token if it was ever shared (a `.env` was uploaded in an earlier chat); `CONVENTIONS.md` is git-ignored and was for Aider (its rules are now in `AGENTS.md`); probe scripts can go only if the owner says sharh is dropped for good.
4. Port adhan scheduling to the tick-based scheduler.
5. Hosting (section 7). Hadith grading (section 2).

## 9. Status (agent: update this at the end of each session)
- 21 Nov 2026: Nakhtim design agreed; `scripts/verify-nakhtim-data.js` written, not yet run by the owner. No Nakhtim bot code exists yet. Adhan and the 11:00 hadith post confirmed working by the owner.
