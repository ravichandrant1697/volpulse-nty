# VolPulse Nty

A small NIFTY option scalper with one rule and no dependencies.

**Rule.** Every 3 minutes: if NIFTY futures trade **above** their running VWAP and the futures volume in the last
5-minute bar is **≥ 3×** the recent average, buy the ATM weekly **call**; **below** VWAP with the same surge, buy the
ATM **put**. Exits: −10 % stop, +30 % target, profit-lock ladder (8 / 10 / 12.5 % and +10 pts) with a 5 % trail
after +8 %, 45-minute time stop, 15:20 square-off. 1 lot, max 3 trades a day, 30-minute cooldown.

**Why this rule.** It is the only entry that survived a walk-forward test over 4.8 years of NIFTY 1-minute data and
then a replay on real option prices (Oct 2024 → Jun 2025, 41 weekly expiries): 375 trades, 70 % win, profit factor
3.45, net +₹2.15 lakh at 1 lot, every month positive, max drawdown −₹9k. Every other idea tested (OI bias, day-extreme
breakouts, pivot bounces, published level tables) lost. The backtest and trade list are in
`../analysis-scripts/opt-vwapvol-final.md` and `vwapvol-trades-1lot-2lot.csv`.

Paper trading by default. Expect live results to be worse than the backtest (fills, gaps, token outages); treat
the first 40–60 live paper trades as the real test.

## Files

| File | Purpose |
|---|---|
| `config.js` | every parameter, commented |
| `bot.js` | main loop: 3-min polls, 5-s exit checks, session end |
| `signal.js` | VWAP, volume surge, decision (pure functions) |
| `position.js` | exit ladder, state.json persistence, daily limits |
| `upstox.js` | the only broker code: instruments, candles, option chain, LTP, orders |
| `journal.js` | `journal/polls.csv`, `journal/trades.csv`, Telegram |
| `clock.js`, `env.js` | IST helpers, tiny .env loader |
| `test/smoke.js` | offline test of signal + exits |
| `.github/workflows/trade.yml` | GitHub Actions schedule (two half-day jobs) |

## Run on a laptop

```bash
# Node 18 or newer
cp .env.example .env         # paste today's UPSTOX_TOKEN (and Telegram keys if you want alerts)
node test/smoke.js           # offline check — should print "smoke: N ok, 0 failed"
node bot.js --once           # one poll against the live API: prints spot, VWAP, surge, decision
node bot.js                  # the session; stops by itself at 15:35 IST
```

`state.json` keeps the open position and today's trades, so you can stop and restart the bot during the day.
`journal/` keeps the CSVs. Both are git-ignored.

## Run on GitHub Actions

1. Create a **private** repository and push these files.
2. Settings → Secrets → Actions: `UPSTOX_TOKEN` (and optionally `TG_BOT_TOKEN`, `TG_CHAT_ID`).
3. The workflow runs 09:10–12:35 and 12:30–15:35 IST on weekdays. State and journal pass between the two jobs
   through the Actions cache; the afternoon job posts the day's summary and CSVs to Telegram and keeps them as a
   build artifact.
4. **Refresh `UPSTOX_TOKEN` every morning** — Upstox tokens expire daily. A 401 stops the session with a Telegram alert.
5. Holidays: GitHub does not know NSE holidays; the bot finds no candles and idles.

## Going live (later)

Only after the paper journal matches the backtest (≥ 60 % win, profit factor ≥ 2 over 40+ trades):
set `MODE=live` **and** `LIVE_TRADING=yes`. Orders are market orders, intraday product. Nothing else changes.
