// VolPulse Nty — every tunable number lives here. Nothing else in the project hard-codes a rule value.
// Rule in one line: at each 3-minute poll, if NIFTY futures trade on one side of their running VWAP AND the
// futures volume just surged ≥ 3× its recent average, buy the ATM weekly option on that side; exit on the
// scalp ladder below. Evidence: analysis-scripts/opt-vwapvol-final.md (real option prices, Oct-2024 → Jun-2025,
// 375 trades, 70 % win, profit factor 3.45, every month positive, max drawdown −₹9k at 1 lot).
module.exports = {
  // ---- instruments -------------------------------------------------------------------------------------
  UNDERLYING_KEY: "NSE_INDEX|Nifty 50", // index spot (for the ATM strike)
  STRIKE_STEP: 50,                      // NIFTY strikes are 50 apart
  INSTRUMENTS_URL: "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz",

  // ---- timing (all IST) ----------------------------------------------------------------------------------
  POLL_MINUTES: 3,          // signal grid: 09:15, 09:18, … (the backtest grid)
  EXIT_CHECK_MS: 5000,      // while a position is open, re-quote it every 5 s
  MARKET_OPEN: "09:15",
  MARKET_CLOSE: "15:30",
  SESSION_SPLIT: "12:35",   // GitHub jobs are capped at 6 h → two half-day runs; a run started before this
                            // ends here, a run started after it ends at DAY_END (local runs ignore the split)
  DAY_END: "15:35",

  // ---- entry ---------------------------------------------------------------------------------------------
  ENTRY: {
    volumeSurgeMin: 3,      // surge = max(volume of the last two 5-min futures bars) ÷ mean(previous four)
    minBuckets: 6,          // need six 5-min bars (from 09:45) before the surge is defined — NO ceiling: the
                            // bigger the surge the better the trade (≥ 6× won 78 % in the backtest)
    startHHMM: "09:30",     // no entries before (the first surge readings are unreliable anyway)
    endHHMM: "15:10",       // no entries after (a scalp needs room before the 15:20 square-off)
    maxTradesPerDay: 3,
    cooldownMin: 30,        // after any exit, wait this long before the next entry
    lots: 1,                // start with 1; the backtest's drawdown doubles with 2
    expiryMinDays: 1,       // trade the nearest weekly expiry that is at least this many days away
                            // (= on expiry day, use next week's; expiry-day trades were fine in the backtest
                            // but DTE-0 premiums move too fast for 5-second exits)
  },

  // ---- exit (scalp ladder, all relative to the entry premium) ----------------------------------------------
  EXIT: {
    stopPct: 0.10,                 // −10 % → STOP
    targetPct: 0.30,               // +30 % → TARGET
    lockPcts: [0.08, 0.10, 0.125], // profit-lock rungs: once the premium has traded above a rung, a pullback to
    lockPoints: 10,                //   it exits (PROFIT_LOCK); an absolute 10-pt rung is merged into the ladder
    trailArmPct: 0.08,             // trailing floor arms after +8 % …
    trailPct: 0.05,                // … and sits 5 % of entry below the peak; floor = max(rung, trail), only rises
    timeStopMin: 45,               // nothing armed after 45 min → TIME_STOP (the 16–45 min holds lose)
    squareOffHHMM: "15:20",        // everything flat by here
  },

  // ---- money ---------------------------------------------------------------------------------------------
  COST_PER_LOT: 65,         // estimated round-trip charges per lot (brokerage + STT + fees), deducted in the journal

  // ---- mode ----------------------------------------------------------------------------------------------
  // "paper" journals fills at the quoted price. "live" places real orders through Upstox — it also needs
  // LIVE_TRADING=yes in the environment as a second lock, see upstox.placeOrder.
  MODE: process.env.MODE || "paper",
};
