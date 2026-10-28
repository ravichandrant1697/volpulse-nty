#!/usr/bin/env node
// VolPulse Nty — main loop.
//   node bot.js            run today's session (laptop or GitHub Actions; the same code)
//   node bot.js --once     one poll, print the decision, exit (quick connectivity check)
//
// Each session:
//   1. load .env + state.json, resolve the futures / option expiry from the instrument master
//   2. on every 3-minute grid point (09:15, 09:18, …): fetch today's futures 1-min candles → VWAP + volume
//      surge → decide → if allowed, buy the ATM option (paper fill at the chain price, or a live market order)
//   3. while a position is open: quote it every 5 s and apply the scalp exits (position.checkExit)
//   4. at the session end (12:35 for a morning GitHub job, 15:35 otherwise): summary + journal to Telegram
require("./env");                     // tiny .env loader (no dotenv dependency)
const CFG = require("./config");
const clock = require("./clock");
const upstox = require("./upstox");
const signal = require("./signal");
const position = require("./position");
const journal = require("./journal");

const ONCE = process.argv.includes("--once");
let contracts = null;                 // { futuresKey, futuresSymbol, expiryDate, lotSize }

async function main() {
  position.load();
  if (!clock.isWeekdayIST() && !process.env.FORCE_RUN) { console.log("weekend — nothing to do"); return; }
  contracts = await upstox.resolveContracts();
  const startMin = clock.minutesIST();
  const endMin = ONCE ? startMin : startMin < clock.hhmmToMin(CFG.SESSION_SPLIT) && process.env.GITHUB_ACTIONS ? clock.hhmmToMin(CFG.SESSION_SPLIT) : clock.hhmmToMin(CFG.DAY_END);
  await journal.notify(`▶ VolPulse Nty ${CFG.MODE.toUpperCase()} · ${clock.todayIST()} · futures ${contracts.futuresSymbol} · options ${contracts.expiryDate} · lot ${contracts.lotSize} · until ${Math.floor(endMin / 60)}:${String(endMin % 60).padStart(2, "0")} IST`);

  if (ONCE) { await poll(); return; }

  let nextPoll = nextGridMs();
  while (clock.minutesIST() < endMin) {
    const now = Date.now();
    if (now >= nextPoll) { await safely("poll", poll); nextPoll = nextGridMs(); }
    if (position.get().open) await safely("exit check", exitCheck);
    await clock.sleep(Math.min(CFG.EXIT_CHECK_MS, Math.max(250, nextPoll - Date.now())));
  }
  // session end: force-close anything still open (only happens on a failed square-off), then report
  if (position.get().open && clock.minutesIST() >= clock.hhmmToMin(CFG.EXIT.squareOffHHMM)) await safely("final square-off", () => exitCheck(true));
  if (clock.minutesIST() >= clock.hhmmToMin(CFG.EXIT.squareOffHHMM)) {
    await journal.notify(`■ Day done · ${journal.daySummary(position.get().closedToday)}`);
    await journal.sendFile(journal.TRADES, `trades ${clock.todayIST()}`);
    await journal.sendFile(journal.POLLS, `polls ${clock.todayIST()}`);
  } else await journal.notify(`■ Session half done · ${journal.daySummary(position.get().closedToday)}`);
}

// next 3-minute grid point after now (grid anchored at 09:15 IST), at :00 seconds
function nextGridMs() {
  const open = clock.todayAtMs(CFG.MARKET_OPEN), step = CFG.POLL_MINUTES * 60000;
  const n = Math.floor((Date.now() - open) / step) + 1;
  return open + Math.max(n, 0) * step;
}

async function safely(label, fn) { try { await fn(); } catch (e) { console.error(`${label} failed:`, e.message); if (/401/.test(e.message)) { await journal.notify(`⛔ ${e.message}`); process.exit(1); } } }

// ---- one poll: inputs → decision → maybe entry ------------------------------------------------------------------
async function poll() {
  const candles = await upstox.intradayCandles(contracts.futuresKey);
  const stats = signal.futuresStats(candles);
  const chain = await upstox.optionChain(contracts.expiryDate);
  const spot = [...chain.values()][0]?.spot ?? null;
  const d = signal.decide(stats);
  const block = d.dir ? position.entryBlock() : null;
  const decision = !d.dir ? "NO SIGNAL" : block ? "BLOCKED" : d.type === "CE" ? "BUY CALL" : "BUY PUT";
  journal.poll({ time: clock.timestampIST(), spot, futClose: stats.lastClose, vwap: stats.vwap?.toFixed(2), surge: stats.surge?.toFixed(2), buckets: stats.buckets, decision, reason: block || d.reason, openPosition: position.get().open?.symbol || "" });
  console.log(`${clock.timestampIST()} spot ${spot} fut ${stats.lastClose} vwap ${stats.vwap?.toFixed(1)} surge ${stats.surge?.toFixed(2) ?? "-"} → ${decision}${block || d.reason ? ` (${block || d.reason})` : ""}`);
  if (decision !== "BUY CALL" && decision !== "BUY PUT") return;

  // entry: ATM option of the signal side, priced from the chain
  const strike = signal.atmStrike(spot), leg = chain.get(strike)?.[d.type];
  if (!leg?.key || !leg.ltp) { console.log(`no chain price for ${strike}${d.type} — skipped`); return; }
  const lots = CFG.ENTRY.lots, qty = lots * contracts.lotSize;
  let fill = leg.ltp, orderId = null;
  if (CFG.MODE === "live") {
    orderId = await upstox.placeOrder({ instrumentKey: leg.key, quantity: qty, side: "BUY" });
    const q = await upstox.ltp([leg.key]); fill = q.get(leg.key) ?? leg.ltp;   // approximate fill = next quote
  }
  const pos = position.open({ instrumentKey: leg.key, symbol: `${strike}${d.type}`, strike, type: d.type, entry: fill, lots, lotSize: contracts.lotSize, spot, reason: d.reason, orderId });
  await journal.notify(`🟢 ${decision} ${pos.symbol} @ ${pos.entry} ×${lots} lot · ${d.reason}\nstop ${pos.stopLevel} · target ${pos.targetLevel} · locks ${pos.rungs.map(r => (pos.entry + r).toFixed(1)).join(" / ")}`);
}

// ---- exit check on the live premium ----------------------------------------------------------------------------
async function exitCheck(force = false) {
  const pos = position.get().open; if (!pos) return;
  const q = await upstox.ltp([pos.instrumentKey]);
  const price = q.get(pos.instrumentKey); if (price == null) return;
  const ex = force ? { reason: "SQUARE_OFF" } : position.checkExit(pos, price);
  position.save();                                    // persist peak / floor so a restart keeps the ladder
  if (!ex) return;
  if (CFG.MODE === "live") await upstox.placeOrder({ instrumentKey: pos.instrumentKey, quantity: pos.qty, side: "SELL" });
  const t = position.close(pos, price, ex.reason);
  journal.trade(t);
  await journal.notify(`${t.net >= 0 ? "✅" : "🔴"} ${ex.reason} ${t.symbol} ${t.entry} → ${t.exit} after ${t.holdMin} min · ${t.net >= 0 ? "+" : "−"}₹${Math.abs(Math.round(t.net))} (gross ${Math.round(t.gross)}, charges ${t.charges})`);
}

main().catch(async e => { console.error(e); await journal.notify(`⛔ VolPulse crashed: ${e.message}`); process.exit(1); });
