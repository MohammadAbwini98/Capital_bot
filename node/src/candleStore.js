// ==============================================================
// GoldBot — candleStore.js
// Fetches and caches OHLC candles for all active timeframes.
// Always stores only CLOSED candles (current in-progress excluded).
// ==============================================================

const api         = require('./api');
const cfg         = require('./config');
const log         = require('./logger');
const candlesRepo = require('./repo/candlesRepo');

// Resolution names used by Capital.com API
const RESOLUTION = {
  M1:  'MINUTE',
  M5:  'MINUTE_5',
  M15: 'MINUTE_15',
  H1:  'HOUR',
  H4:  'HOUR_4',
};

// Duration of each timeframe in milliseconds
const TF_MS = {
  M1:  60_000,
  M5:  5  * 60_000,
  M15: 15 * 60_000,
  H1:  60 * 60_000,
  H4:  4  * 60 * 60_000,
};

/**
 * Drop the last bar only if it is still forming.
 *
 * Capital.com's /prices endpoint may include the current in-progress
 * bar as the last item.  The snapshotTimeUTC field is the bar time key
 * but its convention (open-time vs close-time) is not guaranteed.
 *
 * This implementation handles both conventions:
 *   • Open-time (bar.time = bar open):  elapsed = now - bar.time
 *                                        forming when elapsed < TF_MS
 *   • Close-time (bar.time = bar close): elapsed = now - bar.time
 *                                        forming when elapsed < 0 (future)
 *                                        → also caught by elapsed < TF_MS
 *
 * A bar is considered "closed" when at least one full TF period has
 * elapsed since its timestamp, i.e. elapsed >= TF_MS[tf].
 *
 * @param {'M1'|'M5'|'M15'|'H1'|'H4'} tf
 * @param {object[]} bars
 * @returns {object[]}
 */
function dropInProgress(tf, bars) {
  if (!bars.length) return bars;
  const last      = bars[bars.length - 1];
  const elapsed   = Date.now() - last.time;
  const inProgress = elapsed < TF_MS[tf];
  return inProgress ? bars.slice(0, -1) : bars;
}

// Per-TF history depth.
// M1: 300 bars (covers EMA50 warmup for micro-confirm).
// M5/M15: 600 bars — 200 for EMA200 warmup + 400 bars of live context.
// H1/H4: cfg.HISTORY_BARS (300) — sufficient for EMA200.
const TF_HISTORY = {
  M1:  300,
  M5:  600,
  M15: 600,
  H1:  cfg.HISTORY_BARS,
  H4:  cfg.HISTORY_BARS,
};

// In-memory candle stores (closed bars only)
const store = { M1: [], M5: [], M15: [], H1: [], H4: [] };

// Timestamp of the most recently processed closed bar per TF
const lastClosedTime = { M1: 0, M5: 0, M15: 0, H1: 0, H4: 0 };

// Active timeframes.
// H1 is always included even in scalp-only mode — used by the H1 macro alignment gate.
// H4 is added only when swing mode is enabled (needed for trendFilterH4).
function activeTFs() {
  return cfg.swingEnabled
    ? ['M1', 'M5', 'M15', 'H1', 'H4']
    : ['M1', 'M5', 'M15', 'H1'];
}

// ── Startup history load ────────────────────────────────────────

/**
 * Fetch full history for all active timeframes at startup.
 * Uses TF_HISTORY[tf] bars to cover the 200-period EMA warmup.
 */
async function loadHistory() {
  for (const tf of activeTFs()) {
    log.info(`[Candles] Loading ${TF_HISTORY[tf]} bars for ${tf}...`);
    await fetchFull(tf, TF_HISTORY[tf]);
    await sleep(250);   // light API throttle
  }
}

async function fetchFull(tf, max) {
  // Fetch max+1 to have enough bars even after dropping the in-progress one
  const bars   = await api.getCandles(cfg.EPIC, RESOLUTION[tf], max + 1);
  const closed = dropInProgress(tf, bars);
  store[tf]    = closed;

  if (closed.length) {
    lastClosedTime[tf] = closed[closed.length - 1].time;
  }
  const latestBar = closed[closed.length - 1];
  const latestISO = new Date(lastClosedTime[tf]).toISOString();
  log.info(
    `[Candles] ${tf}: ${closed.length} closed bars loaded` +
    (latestBar ? ` — last close=${latestBar.close.toFixed(4)} at ${latestISO}` : ` (none)`)
  );
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
  const closed = dropInProgress(tf, bars);
  if (!closed.length) return false;

  const newest      = closed[closed.length - 1];
  const hadNewClose = newest.time > lastClosedTime[tf];

  if (hadNewClose) {
    // Append bars with timestamps newer than the last known closed bar.
    // No Set needed: bars arrive in chronological order and lastClosedTime
    // is the boundary — anything after it is genuinely new.
    const oldLastTime = lastClosedTime[tf];
    const addedBars   = [];
    let   added       = 0;
    for (const bar of closed) {
      if (bar.time > oldLastTime) {
        store[tf].push(bar);
        addedBars.push(bar);
        added++;
      }
    }
    // Persist new closed bars to DB (fire-and-forget, non-blocking)
    candlesRepo.insertCandles(tf, addedBars);

    // Trim to TF_HISTORY[tf] to avoid unbounded growth
    if (store[tf].length > TF_HISTORY[tf]) {
      store[tf] = store[tf].slice(-TF_HISTORY[tf]);
    }
    lastClosedTime[tf] = newest.time;

    const latestISO = new Date(newest.time).toISOString();
    log.info(`[Candles] ${tf}: ${added} new bar(s) — close=${newest.close.toFixed(4)} at ${latestISO} | store=${store[tf].length}`);
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
