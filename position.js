// Position lifecycle: exit levels, the exit check, and the day state that survives a restart.
// state.json holds: date, open (0 or 1 position), closedToday[], lastExitMs. On GitHub the file is carried
// between the morning and afternoon jobs by actions/cache; locally it just sits in the project folder.
const fs = require("fs");
const CFG = require("./config");
const { todayIST, timestampIST, minutesIST, hhmmToMin } = require("./clock");

const STATE_FILE = process.env.STATE_FILE || "state.json";
let state = fresh();
function fresh() { return { date: todayIST(), open: null, closedToday: [], lastExitMs: 0 }; }

function load() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); if (s.date === todayIST()) state = s; } catch { /* no file / corrupt → fresh day */ }
  return state;
}
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function get() { if (state.date !== todayIST()) state = fresh(); return state; }

// Why a new entry is not allowed right now, or null when it is.
function entryBlock() {
  const s = get(), now = minutesIST();
  if (s.open) return "position already open";
  if (now < hhmmToMin(CFG.ENTRY.startHHMM) || now > hhmmToMin(CFG.ENTRY.endHHMM)) return `outside entry window ${CFG.ENTRY.startHHMM}–${CFG.ENTRY.endHHMM}`;
  if (s.closedToday.length >= CFG.ENTRY.maxTradesPerDay) return `max ${CFG.ENTRY.maxTradesPerDay} trades today`;
  const sinceExit = (Date.now() - (s.lastExitMs || 0)) / 60000;
  if (s.lastExitMs && sinceExit < CFG.ENTRY.cooldownMin) return `cooldown ${Math.ceil(CFG.ENTRY.cooldownMin - sinceExit)} min left`;
  return null;
}

// Build the position from the fill. All exit levels are premium distances from the entry.
function open({ instrumentKey, symbol, strike, type, entry, lots, lotSize, spot, reason, orderId }) {
  const e = entry;
  const rungs = [...new Set([...CFG.EXIT.lockPcts.map(p => +(p * e).toFixed(2)), CFG.EXIT.lockPoints])].sort((a, b) => a - b);
  const pos = {
    id: Date.now(), openedAt: timestampIST(), openedAtMs: Date.now(),
    instrumentKey, symbol, strike, type, side: "BUY", lots, lotSize, qty: lots * lotSize, spotAtEntry: spot, signal: reason, orderId: orderId || null,
    entry: e, stopLevel: +(e * (1 - CFG.EXIT.stopPct)).toFixed(2), targetLevel: +(e * (1 + CFG.EXIT.targetPct)).toFixed(2),
    rungs,                        // profit-lock ladder (premium distances)
    peak: 0, floor: null,         // peak move so far; armed floor (rung or trail), only ever rises
  };
  get().open = pos; save();
  return pos;
}

// Exit check on the latest premium. Mutates pos.peak / pos.floor. Returns { reason } or null.
// `now` is injectable (tests / replays); the bot passes nothing and gets the real clock.
function checkExit(pos, ltp, now = { ms: Date.now(), min: minutesIST() }) {
  const move = ltp - pos.entry, e = pos.entry;
  if (ltp <= pos.stopLevel) return { reason: "STOP" };
  if (ltp >= pos.targetLevel) return { reason: "TARGET" };
  if (move > pos.peak) pos.peak = move;
  for (const r of pos.rungs) if (move > r && (pos.floor == null || r > pos.floor)) pos.floor = r;      // rung armed
  if (pos.peak > CFG.EXIT.trailArmPct * e) { const trail = pos.peak - CFG.EXIT.trailPct * e; if (pos.floor == null || trail > pos.floor) pos.floor = trail; } // trail armed
  if (pos.floor != null && move <= pos.floor) return { reason: "PROFIT_LOCK" };
  if (pos.floor == null && (now.ms - pos.openedAtMs) / 60000 >= CFG.EXIT.timeStopMin) return { reason: "TIME_STOP" };
  if (now.min >= hhmmToMin(CFG.EXIT.squareOffHHMM)) return { reason: "SQUARE_OFF" };
  return null;
}

// Close: compute the net result (gross − charges) and move the position to closedToday.
function close(pos, exitPrice, reason) {
  const gross = (exitPrice - pos.entry) * pos.qty, charges = CFG.COST_PER_LOT * pos.lots, net = gross - charges;
  const trade = { ...pos, exit: exitPrice, exitedAt: timestampIST(), reason, holdMin: Math.round((Date.now() - pos.openedAtMs) / 60000), gross: +gross.toFixed(2), charges, net: +net.toFixed(2), result: net >= 0 ? "WIN" : "LOSS" };
  const s = get(); s.open = null; s.closedToday.push(trade); s.lastExitMs = Date.now(); save();
  return trade;
}

module.exports = { load, save, get, entryBlock, open, checkExit, close, STATE_FILE };
