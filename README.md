# 🕌 Adhan Bot

A Discord bot that automatically announces Islamic prayer times for Algiers, Algeria. At each prayer time, the bot sends a notification to a designated text channel and joins active voice channels to play a short prayer announcement audio.

---

## Features

- **Automatic prayer scheduling** — fetches daily prayer times from the Aladhan API and schedules all 5 prayers automatically
- **Per-prayer audio** — plays a unique audio file for each prayer (Fajr, Dhuhr, Asr, Maghrib, Isha)
- **Multi-room support** — uses up to 3 bots simultaneously to cover multiple active voice channels at once
- **Smart joining** — only joins voice channels that have at least one real user in them, skips empty and AFK channels
- **Arabic notifications** — sends prayer time announcements in Arabic with Hijri and Gregorian dates
- **Per-server configuration** — each server can set its own notification channel and ignored voice channels independently
- **Midnight refresh** — automatically fetches new prayer times at midnight every day
- **Crash protection** — global error handlers prevent the bot from going down on network hiccups

---

## Commands

All commands work as both slash commands (`/`) and prefix commands (`!`).

| Command | Description |
|---|---|
| `/testadhan` | Runs a full test — sends the prayer message and joins active voice channels |
| `/stopadhan` | Immediately stops the current adhan and disconnects from all voice channels |
| `/setchannel <channel_id>` | Sets the text channel where prayer notifications will be sent |
| `/ignorechannel <channel_id>` | Adds a voice channel to the ignore list — the bot will never join it |
| `/unignorechannel <channel_id>` | Removes a voice channel from the ignore list |
| `/settings` | Shows the current configuration for this server |
| `/times` | Shows the current hijri and gregorian date along with a list of prayer times for the day |

---

## Audio Files

Place these files in the same directory as `bot.js`:

| File | Prayer |
|---|---|
| `fajr.mp3` | الفجر |
| `duhr.mp3` | الظهر |
| `asr.mp3` | العصر |
| `maghrib.mp3` | المغرب |
| `ishaa.mp3` | العشاء |

---

## Setup

### Requirements
- Node.js v22+
- A Discord application with 3 bot tokens

### Installation

```bash
git clone https://github.com/yourusername/adhanbot
cd adhanbot
npm install
```

### Environment Variables

Create a `.env` file in the root directory:

```
TOKEN_1=your_main_bot_token
TOKEN_2=your_second_bot_token
TOKEN_3=your_third_bot_token
```

### Running

```bash
node bot.js
```

---

## Dependencies

- [discord.js](https://discord.js.org/) — Discord API wrapper
- [discord-voip](https://github.com/discordjs/discord-voip) — Voice connection handling with DAVE protocol support
- [@snazzah/davey](https://github.com/Snazzah/davey) — Discord E2E voice encryption
- [axios](https://axios-http.com/) — HTTP requests to the Aladhan API
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) — Audio transcoding
- [dotenv](https://github.com/motdotla/dotenv) — Environment variable loading

---

## Notes

- Prayer times are fetched from [Aladhan API](https://aladhan.com/prayer-times-api) using calculation method 3 (Muslim World League)
- Server configurations are saved locally in `serverconfig.json`
- The bot is currently configured for **Algiers, Algeria** — city can be changed in `bot.js`
