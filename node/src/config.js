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

  // ── Pullback / chop thresholds ────────────────────────────
  PULLBACK_ATR_TOL:            0.40,   // EMA50 touch zone — spec value
  CHOP_EMA_DIST_ATR_MIN:       0.12,   // min EMA spread to avoid chop
  BIG_CANDLE_ATR_MAX:          1.50,   // skip trigger if range > 1.5× ATR

  // ── Setup quality filters (both already active in code) ───
  REQUIRE_EMA_ALIGNMENT_ON_SETUP: true,  // BUY: EMA20>EMA50; SELL: EMA20<EMA50
  REQUIRE_REJECTION_CANDLE_SETUP: true,  // BUY: bullish bar; SELL: bearish bar

  // ── BOS margin factor (already in code) ───────────────────
  BOS_MARGIN_ATR_FACTOR:       0.05,   // margin = max(spread, 0.05×ATR)

  // ── SL / TP ───────────────────────────────────────────────
  SL_BUFFER_ATR:               0.15,   // buffer beyond pullback extreme
  TP1_R:                       1.0,    // TP1 at 1R
  TP2_R_SCALP:                 2.0,    // TP2 at 2R (scalp)
  TP2_R_SWING:                 3.0,    // TP2 at 3R (swing)
  PARTIAL_CLOSE_TP1:           0.50,   // close 50% at TP1
  MOVE_SL_TO_BREAKEVEN_ON_TP1: false,
  TP1_MIN_DISTANCE_SPREAD_MULT: 2.0,   // skip if |TP1-entry| < 2×spread

  // ── M1 micro-confirmation ─────────────────────────────────
  // Applied just before placing a SCALP entry (after BOS triggers).
  // BUY:  EMA20(M1) > EMA50(M1) AND Close(M1) > EMA20(M1)
  // SELL: EMA20(M1) < EMA50(M1) AND Close(M1) < EMA20(M1)
  MICRO_CONFIRM_ENABLED:  true,
  MICRO_EMA_FAST_PERIOD:  20,
  MICRO_EMA_SLOW_PERIOD:  50,

  // ── Candle store settings ─────────────────────────────────
  HISTORY_BARS:    300,   // bars loaded at startup for H1/H4 (need ≥200 for EMA200)
  INCREMENTAL_BARS: 6,    // bars fetched per incremental update

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
