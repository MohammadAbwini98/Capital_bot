// ==============================================================
// GoldBot — config.js
// All algorithm constants + environment-sourced credentials.
// Both Node.js and Python implementations share the same .env
// at the project root (two levels up from this file).
// ==============================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../..', '.env') });

const cfg = {
  // ── API credentials ───────────────────────────────────────
  apiKey:       process.env.CAPITAL_API_KEY  || '',
  email:        process.env.CAPITAL_EMAIL    || '',
  password:     process.env.CAPITAL_PASSWORD || '',
  accountType:  (process.env.ACCOUNT_TYPE   || 'demo').trim().toLowerCase(),
  swingEnabled:  process.env.SWING_ENABLED === 'true',

  // ── API base URL ──────────────────────────────────────────
  // Capital.com's demo accounts created within a live profile are
  // accessed via the live API endpoint + account switching.
  // The demo-api endpoint is only for demo.capital.com-only registrations.
  baseUrl: 'https://api-capital.backend-capital.com',

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
  PULLBACK_ATR_TOL:            0.60,   // EMA50 touch zone (widened from 0.40 for ETHUSD)
  CHOP_EMA_DIST_ATR_MIN:       0.12,   // min EMA spread to avoid chop
  BIG_CANDLE_ATR_MAX:          1.50,   // skip trigger if range > 1.5× ATR

  // ── SL / TP ───────────────────────────────────────────────
  SL_BUFFER_ATR:               0.15,   // buffer beyond pullback extreme
  TP1_R:                       1.0,    // TP1 at 1R
  TP2_R_SCALP:                 2.0,    // TP2 at 2R (scalp)
  TP2_R_SWING:                 3.0,    // TP2 at 3R (swing)
  PARTIAL_CLOSE_TP1:           0.50,   // close 50% at TP1
  MOVE_SL_TO_BREAKEVEN_ON_TP1: false,

  // ── Candle store settings ─────────────────────────────────
  HISTORY_BARS:    300,   // bars loaded at startup (need ≥200 for EMA200)
  INCREMENTAL_BARS: 6,    // bars fetched per incremental update

  // ── Poll intervals (ms) ───────────────────────────────────
  TICK_POLL_MS: 5_000,    // position management / bid-ask check
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
};

module.exports = cfg;
