// IST clock helpers. The bot runs on GitHub (UTC) and on a laptop (any zone) — every time decision goes
// through these so both behave identically.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function nowIST() { return new Date(Date.now() + IST_OFFSET_MS); }            // a Date whose UTC fields read as IST
const pad = n => String(n).padStart(2, "0");
function todayIST() { const d = nowIST(); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function timestampIST() { const d = nowIST(); return `${todayIST()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
function minutesIST() { const d = nowIST(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }      // minutes since 00:00 IST
function hhmmToMin(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
function isWeekdayIST() { const wd = nowIST().getUTCDay(); return wd >= 1 && wd <= 5; }
// IST → epoch ms for "today HH:MM" (used to align the poll grid)
function todayAtMs(hhmm) { const d = nowIST(); const [h, m] = hhmm.split(":").map(Number); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) - IST_OFFSET_MS; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { nowIST, todayIST, timestampIST, minutesIST, hhmmToMin, isWeekdayIST, todayAtMs, sleep };
