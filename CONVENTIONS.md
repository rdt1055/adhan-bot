# Adhan bot rules
- Node.js CommonJS, discord.js + discord-voip. No new dependencies.
- All prayer logic uses Africa/Algiers time via Intl helpers. Never host-local Date methods.
- Never change Arabic text, command names, prayer audio mappings, or the serverconfig.json format.
- Voice playback: NoSubscriberBehavior.Pause, one idempotent cleanup(), the promise must always settle, destroy a connection only if its state is not already 'destroyed'.
- Never read or print .env.