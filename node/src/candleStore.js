// ==============================================================
// GoldBot — candleStore.js
// Fetches and caches OHLC candles for all active timeframes.
// Always stores only CLOSED candles (current in-progress excluded).
// ==============================================================

const api = require('./api');
const cfg = require('./config');
const log = require('./logger');

// Resolution names used by Capital.com API
const RESOLUTION = {
  M5:  'MINUTE_5',
  M15: 'MINUTE_15',
  H1:  'HOUR',
  H4:  'HOUR_4',
};

// In-memory candle stores (closed bars only)
const store = { M5: [], M15: [], H1: [], H4: [] };

// Timestamp of the most recently processed closed bar per TF
const lastClosedTime = { M5: 0, M15: 0, H1: 0, H4: 0 };

// Active timeframes (H1/H4 added only when swing mode is on)
function activeTFs() {
  return cfg.swingEnabled ? ['M5', 'M15', 'H1', 'H4'] : ['M5', 'M15'];
}

// ── Startup history load ────────────────────────────────────────

/**
 * Fetch full history for all active timeframes at startup.
 * Uses cfg.HISTORY_BARS (≥300) to cover the 200-period EMA warmup.
 */
async function loadHistory() {
  for (const tf of activeTFs()) {
    log.info(`[Candles] Loading ${cfg.HISTORY_BARS} bars for ${tf}...`);
    await fetchFull(tf, cfg.HISTORY_BARS);
    await sleep(250);   // light API throttle
  }
}

async function fetchFull(tf, max) {
  // Fetch max+1 so we can drop the current in-progress bar
  const bars   = await api.getCandles(cfg.EPIC, RESOLUTION[tf], max + 1);
  const closed = bars.slice(0, -1);
  store[tf]    = closed;

  if (closed.length) {
    lastClosedTime[tf] = closed[closed.length - 1].time;
  }
  const latestISO = new Date(lastClosedTime[tf]).toISOString();
  log.info(`[Candles] ${tf}: ${closed.length} closed bars loaded (latest: ${latestISO})`);
}

// ── Incremental update ──────────────────────────────────────────

/**
 * Fetch the last few bars and append any newly closed ones.
 * Returns true if at least one new candle has closed since last call.
 *
 * @param {'M5'|'M15'|'H1'|'H4'} tf
 * @returns {Promise<boolean>}
 */
async function update(tf) {
  const bars   = await api.getCandles(cfg.EPIC, RESOLUTION[tf], cfg.INCREMENTAL_BARS + 1);
  const closed = bars.slice(0, -1);   // drop in-progress
  if (!closed.length) return false;

  const newest      = closed[closed.length - 1];
  const hadNewClose = newest.time > lastClosedTime[tf];

  if (hadNewClose) {
    // Append bars with timestamps newer than the last known closed bar.
    // No Set needed: bars arrive in chronological order and lastClosedTime
    // is the boundary — anything after it is genuinely new.
    const oldLastTime = lastClosedTime[tf];
    let added = 0;
    for (const bar of closed) {
      if (bar.time > oldLastTime) {
        store[tf].push(bar);
        added++;
      }
    }

    // Trim to HISTORY_BARS to avoid unbounded growth
    if (store[tf].length > cfg.HISTORY_BARS) {
      store[tf] = store[tf].slice(-cfg.HISTORY_BARS);
    }
    lastClosedTime[tf] = newest.time;

    const latestISO = new Date(newest.time).toISOString();
    log.debug(`[Candles] ${tf}: ${added} new bar(s) — latest closed at ${latestISO} | store=${store[tf].length} bars`);
  } else {
    log.debug(`[Candles] ${tf}: no new bar yet (last closed: ${new Date(lastClosedTime[tf]).toISOString()})`);
  }

  return hadNewClose;
}

// ── Accessors ───────────────────────────────────────────────────

/**
 * Get the closed-candle array for a timeframe.
 * @param {'M5'|'M15'|'H1'|'H4'} tf
 * @returns {{ time:number, open:number, high:number, low:number, close:number, vol:number }[]}
 */
function get(tf) {
  return store[tf];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { loadHistory, update, get };
