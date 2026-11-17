# 🕌 Algiers Adhan Discord Bot

A lightweight Discord bot that automatically fetches daily prayer times for **Algiers, Algeria** (`Africa/Algiers`), sends prayer notifications in text channels, and broadcasts the Adhan across active voice channels.

## ✨ Features
* **Automated Daily Scheduling:** Fetches accurate Algiers prayer times via the Aladhan API and refreshes automatically at `00:01` Algiers time.
* **Smart Voice Broadcast:** Joins active voice channels (skipping AFK and ignored channels) and plays the corresponding prayer audio (`fajr.mp3`, `duhr.mp3`, `asr.mp3`, `maghrib.mp3`, `ishaa.mp3`).
* **Built-in Reliability:** Includes connection retries, playback watchdogs, and automatic API fallback retries.
* **Per-Server Configuration:** Customize notification channels and ignored voice channels per server via `serverconfig.json`.

## 🛠️ Commands
Supports both **Slash Commands** (`/`) and **Prefix Commands** (`!`).

| Command | Description |
| :--- | :--- |
| `/times` | Display today's prayer times and remaining time until each prayer. |
| `/testadhan` | Send a test notification and play a test Adhan in active voice channels. |
| `/stopadhan` | Stop the currently playing Adhan and disconnect from voice channels. |
| `/setchannel <channel_id>` | Set the text channel for prayer notifications. |
| `/ignorechannel <channel_id>` | Prevent the bot from joining a specific voice channel. |
| `/unignorechannel <channel_id>` | Remove a voice channel from the ignore list. |
| `/settings` | View the current notification and ignored channel settings for the server. |
| `/refresh` | Manually re-fetch today's prayer times and reschedule timers. |

## 🚀 Setup
1. Install dependencies:
   ```bash
   npm install
