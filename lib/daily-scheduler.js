/* -------- "EVERY DAY AT HH:MM ALGIERS TIME" JOBS --------
   Uses a 30-second check instead of one long setTimeout, so a PC that sleeps or a clock that
   jumps can't push the job hours late: the first check after waking runs it. */
const { getAlgiersParts, algiersWallToUtc } = require('./algiers-time');
const { logTimestamp } = require('./log');

const TICK_MS = 30_000;

// Next HH:MM (Algiers) strictly after the given instant, as a UTC timestamp in ms
function nextRunAfter(hour, minute, afterMs = Date.now()) {
  const p = getAlgiersParts(new Date(afterMs));
  let target = algiersWallToUtc(p.year, p.month, p.day, hour, minute, 0, 0);
  if (target <= afterMs) {
    target = algiersWallToUtc(p.year, p.month, p.day + 1, hour, minute, 0, 0);
  }
  return target;
}

function createDailyJob({ name, hour, minute, task }) {
  let timer = null;
  let running = false;
  let nextRun = nextRunAfter(hour, minute);

  function tick() {
    if (running || Date.now() < nextRun) return;

    running = true;
    nextRun = nextRunAfter(hour, minute); // re-arm first: a slow or failing task can't re-trigger itself

    Promise.resolve()
      .then(task)
      .catch((err) => logTimestamp(`[${name}] scheduled task failed: ${err.message}`))
      .finally(() => { running = false; });
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    get nextRun() { return nextRun; }
  };
}

module.exports = { createDailyJob, nextRunAfter };
