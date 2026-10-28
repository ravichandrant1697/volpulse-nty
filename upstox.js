// Upstox REST access — the only file that talks to the broker. No SDK, no npm packages: Node's built-in fetch.
// Token: UPSTOX_TOKEN (daily access token). Every call retries once on a network error and backs off on 429.
const zlib = require("zlib");
const { todayIST } = require("./clock");
const CFG = require("./config");

const V2 = "https://api.upstox.com/v2", V3 = "https://api.upstox.com/v3";
const token = () => { const t = process.env.UPSTOX_TOKEN; if (!t) throw new Error("UPSTOX_TOKEN is not set (.env locally, repository secret on GitHub)"); return t; };

async function api(url, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try { res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token()}`, Accept: "application/json", ...(opts.headers || {}) } }); }
    catch (e) { if (attempt >= 3) throw e; await new Promise(r => setTimeout(r, 1500 * attempt)); continue; }
    if (res.status === 429 && attempt < 4) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Upstox 401 — the access token is invalid or expired (they expire daily)");
    if (!res.ok || body.status === "error") throw new Error(`Upstox ${res.status}: ${JSON.stringify(body.errors || body).slice(0, 200)}`);
    return body.data;
  }
}

// ---- instruments: near-month NIFTY future + the weekly option expiry to trade ------------------------------
// Downloads the NSE master (gzipped JSON, ~15 MB) once per run and picks:
//   futuresKey  — NIFTY FUT with the nearest expiry on/after today (rolls to next month on expiry day)
//   expiryDate  — nearest NIFTY option expiry at least ENTRY.expiryMinDays away
//   lotSize     — from the master, so a lot-size change at NSE needs no code change
async function resolveContracts() {
  const res = await fetch(CFG.INSTRUMENTS_URL);
  if (!res.ok) throw new Error(`instruments download failed: ${res.status}`);
  const rows = JSON.parse(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8"));
  const today = todayIST();
  const toDate = ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10); // expiry ms (IST midnight) → YYYY-MM-DD
  const nifty = rows.filter(r => r.segment === "NSE_FO" && r.underlying_key === CFG.UNDERLYING_KEY);
  const futs = nifty.filter(r => r.instrument_type === "FUT").map(r => ({ ...r, exp: toDate(r.expiry) })).filter(r => r.exp >= today).sort((a, b) => a.exp.localeCompare(b.exp));
  if (!futs.length) throw new Error("no NIFTY futures found in the instrument master");
  const minExp = new Date(Date.now() + CFG.ENTRY.expiryMinDays * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 10);
  const expiries = [...new Set(nifty.filter(r => r.instrument_type === "CE" || r.instrument_type === "PE").map(r => toDate(r.expiry)))].filter(e => e >= minExp).sort();
  if (!expiries.length) throw new Error("no NIFTY option expiry found");
  return { futuresKey: futs[0].instrument_key, futuresSymbol: futs[0].trading_symbol || futs[0].name, expiryDate: expiries[0], lotSize: futs[0].lot_size || 65 };
}

// ---- today's 1-minute candles for one instrument (ascending, completed minutes only) ----------------------
// v3 intraday endpoint; the response lists newest first and includes the still-forming minute, which we drop.
async function intradayCandles(instrumentKey) {
  let data;
  try { data = await api(`${V3}/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/1`); }
  catch { data = await api(`${V2}/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/1minute`); }
  const now = Date.now();
  return (data?.candles || [])
    .map(c => ({ t: Date.parse(c[0]), o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] || 0 }))
    .filter(c => Number.isFinite(c.t) && c.t + 60000 <= now) // only candles whose minute has fully closed
    .sort((a, b) => a.t - b.t);
}

// ---- option chain for the expiry: strike → { CE: {key, ltp}, PE: {key, ltp} } ---------------------------------
async function optionChain(expiryDate) {
  const data = await api(`${V2}/option/chain?instrument_key=${encodeURIComponent(CFG.UNDERLYING_KEY)}&expiry_date=${expiryDate}`);
  const chain = new Map();
  for (const r of data || []) chain.set(r.strike_price, { CE: { key: r.call_options?.instrument_key, ltp: r.call_options?.market_data?.ltp }, PE: { key: r.put_options?.instrument_key, ltp: r.put_options?.market_data?.ltp }, spot: r.underlying_spot_price });
  return chain;
}

// ---- last traded prices for a list of instrument keys → Map(key → ltp) ---------------------------------------
// The LTP response is keyed by "EXCHANGE:SYMBOL", so we map back through the instrument_token field.
async function ltp(keys) {
  const data = await api(`${V2}/market-quote/ltp?instrument_key=${encodeURIComponent(keys.join(","))}`);
  const out = new Map();
  for (const q of Object.values(data || {})) if (q.instrument_token) out.set(q.instrument_token, q.last_price);
  return out;
}

// ---- live orders (only in MODE=live AND LIVE_TRADING=yes) -------------------------------------------------------
// Market order, intraday product, one call per leg. Returns the order id. Paper mode never reaches this.
async function placeOrder({ instrumentKey, quantity, side }) {
  if (CFG.MODE !== "live" || process.env.LIVE_TRADING !== "yes") throw new Error("placeOrder called outside live mode — refusing");
  const body = { quantity, product: "I", validity: "DAY", price: 0, instrument_token: instrumentKey, order_type: "MARKET", transaction_type: side, disclosed_quantity: 0, trigger_price: 0, is_amo: false };
  const data = await api(`${V2}/order/place`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return data?.order_id;
}

module.exports = { resolveContracts, intradayCandles, optionChain, ltp, placeOrder };
