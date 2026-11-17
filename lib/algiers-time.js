/* -------- ALGIERS TIME HELPERS (never depend on the host timezone) -------- */
const TIMEZONE = 'Africa/Algiers';

function getAlgiersParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    parts[type] = value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function getAlgiersDateDDMMYYYY(date = new Date()) {
  const p = getAlgiersParts(date);
  return `${String(p.day).padStart(2, '0')}-${String(p.month).padStart(2, '0')}-${p.year}`;
}

function formatAlgiersNow(date = new Date()) {
  const p = getAlgiersParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ` +
    `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

function getAlgiersOffsetMinutes(date = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      timeZoneName: 'longOffset'
    }).formatToParts(date).find(p => p.type === 'timeZoneName');

    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part?.value || '');
    if (m) {
      return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    }
  } catch {}

  return 60;
}

function algiersWallToUtc(year, month, day, hour, minute, second = 0, ms = 0) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const offset = getAlgiersOffsetMinutes(new Date(utc));
  utc -= offset * 60000;

  const offset2 = getAlgiersOffsetMinutes(new Date(utc));
  if (offset2 !== offset) {
    utc -= (offset2 - offset) * 60000;
  }

  return utc;
}

function getNextAlgiersMidnightPlusOneMs() {
  const now = Date.now();
  const p = getAlgiersParts(new Date(now));

  let day = p.day + 1;
  let target = algiersWallToUtc(p.year, p.month, day, 0, 1, 0, 0);

  while (target <= now) {
    day += 1;
    target = algiersWallToUtc(p.year, p.month, day, 0, 1, 0, 0);
  }

  return target;
}

function parseAlgiersTime(value) {
  const m = String(value).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) throw new Error(`Invalid prayer time: ${value}`);

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3] ? m[3].toUpperCase() : null;

  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;

  return { hour, minute };
}

module.exports = {
  TIMEZONE,
  getAlgiersParts,
  getAlgiersDateDDMMYYYY,
  formatAlgiersNow,
  algiersWallToUtc,
  getNextAlgiersMidnightPlusOneMs,
  parseAlgiersTime
};
