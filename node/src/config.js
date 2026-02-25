// ==============================================================
// GoldBot — config.js
// All algorithm constants + environment-sourced credentials.
// Both Node.js and Python implementations share the same .env
// at the project root (two levels up from this file).
// ==============================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../..', '.env') });

// Resolved once so every property can reference it
const _accountType = (process.env.ACCOUNT_TYPE || 'live').trim().toLowerCase();

const cfg = {
  // ── API credentials ───────────────────────────────────────
  apiKey:       process.env.CAPITAL_API_KEY  || '',
  email:        process.env.CAPITAL_EMAIL    || '',
  password:     process.env.CAPITAL_PASSWORD || '',
  accountType:  _accountType,
  swingEnabled:  process.env.SWING_ENABLED === 'true',

  // ── API base URL ──────────────────────────────────────────
  // demo.capital.com registrations → demo-api-capital.backend-capital.com
  // live capital.com registrations (incl. demo sub-accounts) → api-capital.backend-capital.com
  baseUrl: _accountType === 'demo'
    ? 'https://demo-api-capital.backend-capital.com'
    : 'https://api-capital.backend-capital.com',

  // ── Target account ID (optional) ──────────────────────────
  // Leave blank to use the current preferred account.
  // Set to your demo account ID when ACCOUNT_TYPE=demo.
  // Example: CAPITAL_ACCOUNT_ID=310891246381248798
  accountId: process.env.CAPITAL_ACCOUNT_ID || '',

  // ── Instrument ────────────────────────────────────────────
  // Set INSTRUMENT in .env — use Capital.com epic names:
  // GOLD, SILVER, BTCUSD, ETHUSD, OIL_CRUDE, EURUSD, US500 …
  EPIC: process.env.INSTRUMENT || 'GOLD',

  // ── Risk gates ────────────────────────────────────────────
  MAX_TRADES_PER_DAY:          3,
  DAILY_LOSS_LIMIT_USD:        10.00,
  MAX_CONSECUTIVE_LOSSES:      3,

  // ── Position sizing ───────────────────────────────────────
  SCALP_SIZE_UNITS:            1,
  SWING_SIZE_UNITS:            1,

  // ── Spread filter ─────────────────────────────────────────
  // Max allowed spread in price units — tune per instrument:
  //   GOLD      → 0.60    (typical ~0.30)
  //   SILVER    → 0.05    (typical ~0.02)
  //   ETHUSD    → 3.00    (typical ~1.50)
  //   BTCUSD    → 30.00   (typical ~15)
  //   OIL_CRUDE → 0.05
  //   EURUSD    → 0.0003
  SPREAD_MAX: parseFloat(process.env.SPREAD_MAX) || 0.60,

  // ── Indicator periods ─────────────────────────────────────
  EMA_TREND_PERIOD:            200,    // M15 (scalp) / H4 (swing)
  EMA_FAST_PERIOD:             20,     // on entry TF
  EMA_PULLBACK_PERIOD:         50,     // on entry TF
  ATR_PERIOD:                  14,     // on entry TF

  // ── BOS lookback ──────────────────────────────────────────
  BOS_LOOKBACK_SCALP:          8,      // previous bars on M5
  BOS_LOOKBACK_SWING:          10,     // previous bars on H1

  // ── Setup expiry ──────────────────────────────────────────
  SETUP_EXPIRY_BARS_SCALP:     6,      // 6 × M5 = 30 minutes
  SETUP_EXPIRY_BARS_SWING:     12,     // 12 × H1 = 12 hours

  // ── Adaptive pullback / chop thresholds ──────────────────
  // Tolerance for EMA50 touch grows with trend strength (spreadATR).
  // When trend is strong enough, also allow EMA20 fast-pullback entries.
  PULLBACK_TOL_BASE:           0.40,   // baseline ATR tolerance for EMA50 touch
  PULLBACK_TOL_MAX:            0.70,   // maximum tolerance (caps widening)
  PULLBACK_TOL_K:              1.20,   // how fast tolerance grows with spreadATR
  FAST_PULLBACK_SPREADATR_MIN: 0.25,   // min spreadATR to enable EMA20 fast mode
  FAST_PULLBACK_TOL:           0.35,   // ATR tolerance for EMA20 touch (tighter)
  CHOP_EMA_DIST_ATR_MIN:       0.12,   // spreadATR floor — below this: no setups
  BIG_CANDLE_ATR_MAX:          1.50,   // skip trigger if range > 1.5× ATR

  // ── Rejection candle quality ──────────────────────────────
  // BUY:  close in top 40% of range  + lower wick ≥ 30% of range
  // SELL: close in bottom 40% of range + upper wick ≥ 30% of range
  REJECTION_CLOSE_PCT:         0.60,   // close position threshold (top/bottom 40%)
  REJECTION_WICK_PCT:          0.30,   // minimum directional wick as fraction of range

  // ── BOS margin factor (already in code) ───────────────────
  BOS_MARGIN_ATR_FACTOR:       0.05,   // margin = max(spread, 0.05×ATR)

  // ── Setup invalidation ────────────────────────────────────
  SETUP_INVALIDATION_ATR:      0.15,   // kill setup if price breaks EMA50 by this×ATR

  // ── SL / TP ───────────────────────────────────────────────
  SL_BUFFER_ATR:               0.10,   // buffer beyond pullback extreme (was 0.15)
  // Scalp: fixed ATR multiples — stable across volatility regimes
  SCALP_TP1_ATR:               0.80,   // TP1 = entry ± 0.8×ATR
  SCALP_TP2_ATR:               1.60,   // TP2 = entry ± 1.6×ATR
  // Swing: R-multiple targets (unchanged)
  TP1_R:                       1.0,    // TP1 at 1R
  TP2_R_SWING:                 3.0,    // TP2 at 3R (swing)
  PARTIAL_CLOSE_TP1:           0.50,   // close 50% at TP1
  MOVE_SL_TO_BREAKEVEN_ON_TP1: false,
  TP1_MIN_DISTANCE_SPREAD_MULT: 2.0,   // skip if |TP1-entry| < 2×spread

  // ── Volatility floor (Gold-specific) ─────────────────────
  ATR_ABS_MIN_M5:              1.50,   // absolute minimum M5 ATR14 for Gold

  // ── Dynamic spread limit ──────────────────────────────────
  SPREAD_ATR_FACTOR:           0.10,   // dynamic max = max(SPREAD_MIN_GOLD, factor×ATR)
  SPREAD_MIN_GOLD:             0.25,   // minimum spread threshold for dynamic check

  // ── M1 micro-confirmation ─────────────────────────────────
  // Applied just before placing a SCALP entry (after BOS triggers).
  // BUY:  EMA20(M1) > EMA50(M1) AND Close(M1) > EMA20(M1)
  // SELL: EMA20(M1) < EMA50(M1) AND Close(M1) < EMA20(M1)
  MICRO_CONFIRM_ENABLED:  true,
  MICRO_EMA_FAST_PERIOD:  20,
  MICRO_EMA_SLOW_PERIOD:  50,

  // ── M5 momentum gate (RSI) ────────────────────────────────
  // Applied after BOS is detected. Avoids entering exhausted momentum.
  RSI_PERIOD:           14,
  M5_RSI_BUY_MIN:       52,    // BUY only if M5 RSI14 >= 52
  M5_RSI_SELL_MAX:      48,    // SELL only if M5 RSI14 <= 48

  // ── M5 volatility regime gate (ATR ratio) ─────────────────
  // Avoids entries in dead/compressed markets.
  ATR_RATIO_SMA_PERIOD: 50,    // compare current ATR to SMA(ATR, 50)
  ATR_RATIO_MIN:        0.80,  // require ATR ratio >= 0.80

  // ── M5 breakout quality gate (candle body) ────────────────
  // BOS trigger bar body must be >= 30% of ATR (filters micro-wick BOS).
  BOS_CANDLE_BODY_ATR_MIN: 0.30,

  // ── M15 trend quality gates ───────────────────────────────
  M15_TREND_STRENGTH_MIN:  0.80,  // |close - EMA200| / ATR14_M15 >= 0.80
  M15_EMA200_SLOPE_BARS:   10,    // bars over which to measure EMA200 slope
  M15_ATR_PERIOD:          14,    // ATR period for M15-level calculations

  // ── H1 macro alignment filter ─────────────────────────────
  // Scalp BUY only when H1 close > H1 EMA200; RSI not overbought/oversold.
  H1_RSI_OVERBOUGHT:    68,  // BUY blocked if H1 RSI14 > 68
  H1_RSI_OVERSOLD:      32,  // SELL blocked if H1 RSI14 < 32

  // ── Candle store settings ─────────────────────────────────
  HISTORY_BARS:    300,   // bars loaded at startup for H1/H4 (need ≥200 for EMA200)
  INCREMENTAL_BARS: 6,    // bars fetched per incremental update

  // ── Quote storage ─────────────────────────────────────────
  QUOTE_FLUSH_MS:  60_000,  // flush buffered bid/ask ticks to DB every 60 s

  // ── Poll intervals (ms) ───────────────────────────────────
  TICK_POLL_MS: 5_000,    // position management / bid-ask check
  M1_POLL_MS:   15_000,   // M1 candle update (for micro-confirm)
  M5_POLL_MS:   30_000,   // M5 candle close detection
  M15_POLL_MS:  60_000,   // M15 trend update
  H1_POLL_MS:   5 * 60_000,   // H1 candle close (swing)
  H4_POLL_MS:   20 * 60_000,  // H4 trend update (swing)

  // ── Session auto-refresh ──────────────────────────────────
  SESSION_REFRESH_MS: 540_000,   // 9 minutes

  // ── Telegram notifications ────────────────────────────────
  // Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in .env.
  // Leave blank to disable notifications silently.
  telegramToken:  process.env.TELEGRAM_TOKEN   || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // ── Timezone for Telegram message timestamps ──────────────
  // Use any IANA timezone name, e.g. 'Asia/Riyadh' (UTC+3),
  // 'Europe/London', 'America/New_York', etc.
  // Set TIMEZONE in .env to override.
  TIMEZONE: process.env.TIMEZONE || 'Asia/Riyadh',

  // ── Database (optional — ML data logging) ─────────────────
  // Set DB_URL in .env to enable signal/candle/trade persistence.
  // Leave blank to run without a database (trading is unaffected).
  // Example: DB_URL=postgresql://user:pass@localhost:5432/goldbot
  DB_URL: process.env.DB_URL || '',

  // ── ML confidence filter ──────────────────────────────────
  // Applied after BOS + M1 micro-confirm.  No-op until models/current.json exists.
  // BUY  entry: require p(up) >= ML_BUY_THRESHOLD
  // SELL entry: require p(up) <= ML_SELL_THRESHOLD  (= p(down) >= 1 - threshold)
  ML_BUY_THRESHOLD:  parseFloat(process.env.ML_BUY_THRESHOLD)  || 0.60,
  ML_SELL_THRESHOLD: parseFloat(process.env.ML_SELL_THRESHOLD) || 0.40,
};

module.exports = cfg;
