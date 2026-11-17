/* -------- LOGGING -------- */
function logTimestamp(msg) {
  console.log(new Date().toISOString(), msg);
}

module.exports = { logTimestamp };
