// Journal (CSV files in ./journal) + Telegram. Two CSVs:
//   polls.csv  — one row per 3-min poll: the inputs and the decision (so a quiet day is still auditable)
//   trades.csv — one row per closed trade: entry, stop, target, exit, reason, gross, charges, net
// Telegram is optional: without TG_BOT_TOKEN / TG_CHAT_ID everything just goes to the console and the files.
const fs = require("fs");
const path = require("path");

const DIR = process.env.JOURNAL_DIR || "journal";
const POLLS = path.join(DIR, "polls.csv"), TRADES = path.join(DIR, "trades.csv");
const POLL_COLS = ["time", "spot", "futClose", "vwap", "surge", "buckets", "decision", "reason", "openPosition"];
const TRADE_COLS = ["id", "openedAt", "exitedAt", "symbol", "type", "strike", "lots", "qty", "spotAtEntry", "entry", "stopLevel", "targetLevel", "exit", "reason", "holdMin", "gross", "charges", "net", "result", "signal", "orderId"];

const csv = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function append(file, cols, row) {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, cols.join(",") + "\n");
  fs.appendFileSync(file, cols.map(c => csv(row[c])).join(",") + "\n");
}
const poll = row => append(POLLS, POLL_COLS, row);
const trade = row => append(TRADES, TRADE_COLS, row);

// ---- Telegram ------------------------------------------------------------------------------------------------
const tg = () => (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID ? { token: process.env.TG_BOT_TOKEN, chat: process.env.TG_CHAT_ID } : null);
async function notify(text) {
  console.log(text);
  const t = tg(); if (!t) return;
  try { await fetch(`https://api.telegram.org/bot${t.token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: t.chat, text }) }); }
  catch (e) { console.error("telegram failed:", e.message); }
}
async function sendFile(file, caption = "") {
  const t = tg(); if (!t || !fs.existsSync(file)) return;
  try {
    const form = new FormData();
    form.append("chat_id", t.chat); form.append("caption", caption);
    form.append("document", new Blob([fs.readFileSync(file)]), path.basename(file));
    await fetch(`https://api.telegram.org/bot${t.token}/sendDocument`, { method: "POST", body: form });
  } catch (e) { console.error("telegram document failed:", e.message); }
}

// End-of-day summary line from closedToday
function daySummary(closed) {
  if (!closed.length) return "No trades today.";
  const net = closed.reduce((a, t) => a + t.net, 0), wins = closed.filter(t => t.net > 0).length;
  return `${closed.length} trade(s), ${wins} win(s), net ${net >= 0 ? "+" : "−"}₹${Math.abs(Math.round(net))}\n` + closed.map(t => `  ${t.openedAt.slice(11, 16)} ${t.symbol} ${t.entry}→${t.exit} ${t.reason} ${t.net >= 0 ? "+" : "−"}₹${Math.abs(Math.round(t.net))}`).join("\n");
}

module.exports = { poll, trade, notify, sendFile, daySummary, POLLS, TRADES, DIR };
