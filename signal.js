// The entry signal — pure functions over today's 1-minute futures candles. Nothing here touches the network
// or the clock, so the same code is unit-tested offline and replayed on history.
const CFG = require("./config");
const OPEN_MIN = 9 * 60 + 15; // 09:15 IST — the 5-minute buckets are aligned to the market open

// minutes since 00:00 IST for a candle timestamp (epoch ms)
const istMinute = t => Math.floor(((t + 5.5 * 3600e3) % 86400e3) / 60000);

// From the completed 1-min candles compute:
//   vwap      running volume-weighted average of the typical price (H+L+C)/3 since 09:15
//   lastClose close of the last completed minute (the "price" compared against the VWAP)
//   surge     max(volume of the last two 5-min buckets) ÷ mean(volume of the four before them); null until
//             six buckets exist. The newest bucket may still be filling — that is how the backtest measured it.
function futuresStats(candles) {
  if (!candles.length) return { vwap: null, lastClose: null, surge: null, buckets: 0 };
  let pv = 0, vol = 0; const buckets = new Map();
  for (const c of candles) {
    pv += (c.h + c.l + c.c) / 3 * c.v; vol += c.v;
    const b = OPEN_MIN + Math.floor((istMinute(c.t) - OPEN_MIN) / 5) * 5; // bucket start minute
    buckets.set(b, (buckets.get(b) || 0) + c.v);
  }
  const vols = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  let surge = null;
  if (vols.length >= CFG.ENTRY.minBuckets) {
    const last6 = vols.slice(-6), rest = last6.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
    surge = rest > 0 ? Math.max(last6[4], last6[5]) / rest : null;
  }
  return { vwap: vol ? pv / vol : null, lastClose: candles[candles.length - 1].c, surge, buckets: vols.length };
}

// Decision for one poll. Returns { dir: +1 | -1, type: "CE" | "PE" } to trade, or { dir: 0, reason } to skip.
// dir follows the futures' side of the VWAP; the volume surge is the only confirmation.
function decide(stats) {
  if (stats.vwap == null || stats.lastClose == null) return { dir: 0, reason: "no futures candles yet" };
  const dir = stats.lastClose > stats.vwap ? 1 : stats.lastClose < stats.vwap ? -1 : 0;
  if (!dir) return { dir: 0, reason: "price exactly on VWAP" };
  if (stats.surge == null) return { dir: 0, reason: `volume history ${stats.buckets}/${CFG.ENTRY.minBuckets} buckets` };
  if (stats.surge < CFG.ENTRY.volumeSurgeMin) return { dir: 0, reason: `volume ${stats.surge.toFixed(2)}× < ${CFG.ENTRY.volumeSurgeMin}× (${dir > 0 ? "above" : "below"} VWAP ${stats.vwap.toFixed(1)})` };
  return { dir, type: dir > 0 ? "CE" : "PE", reason: `${dir > 0 ? "above" : "below"} VWAP ${stats.vwap.toFixed(1)}, volume ${stats.surge.toFixed(2)}×` };
}

// ATM strike for the option
const atmStrike = spot => Math.round(spot / CFG.STRIKE_STEP) * CFG.STRIKE_STEP;

module.exports = { futuresStats, decide, atmStrike };
