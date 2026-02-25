// ==============================================================
// GoldBot — strategy.js
// Full implementation of the XAUUSD Trend-Following Pullback
// + BOS strategy as defined in the algorithm spec.
//
// Entry points called by index.js polling loops:
//   onM5Close()            — run on every M5 candle close (scalp)
//   onH1Close()            — run on every H1 candle close (swing)
//   managePositions()      — run on every tick cycle
//   reconcilePositions()   — run periodically to sync with platform
// ==============================================================

const cfg             = require('./config');
const log             = require('./logger');
const ind             = require('./indicators');
const cs              = require('./candleStore');
const state           = require('./state');
const api             = require('./api');
const telegram        = require('./telegram');
const signalsRepo     = require('./repo/signalsRepo');
const tradesRepo      = require('./repo/tradesRepo');
const predictionsRepo = require('./repo/predictionsRepo');
const mlModel         = require('./mlModel');

// ── Array extractors ───────────────────────────────────────────

const closes = c => c.map(b => b.close);
const highs  = c => c.map(b => b.high);
const lows   = c => c.map(b => b.low);
const last   = c => c[c.length - 1];

// ── Reconcile miss-count tracking ──────────────────────────────
// Tracks how many consecutive reconcile cycles each dealId has been
// absent from the platform's /positions list.  Only after MISS_THRESHOLD
// consecutive misses do we confirm via a direct single-position GET.
const _reconcileMissCount = {};

// ── PnL helpers ────────────────────────────────────────────────

/**
 * Directional math PnL — NOT reliable for CFDs (contract-spec dependent).
 * Used only as a last-resort fallback.
 */
function _mathPnl(direction, entry, exitPrice, size) {
  return direction === 'BUY'
    ? (exitPrice - entry) * size
    : (entry - exitPrice) * size;
}

/**
 * Resolve realized PnL with priority order:
 *   1. confirmed.profit  (from deal confirmation)
 *   2. activity history  (authoritative for CFD products)
 *   3. directional math  (last resort — may be wrong for CFDs)
 *
 * @param {object|null} confirmed   Deal confirmation object from closePosition()
 * @param {string}      dealId
 * @param {number}      openedTime  Position open time (epoch ms)
 * @param {string}      direction   'BUY' | 'SELL'
 * @param {number}      entry
 * @param {number}      exitPrice
 * @param {number}      size
 * @returns {Promise<number>}
 */
async function resolvePnlAsync(confirmed, dealId, openedTime, direction, entry, exitPrice, size) {
  if (confirmed && typeof confirmed.profit === 'number') return confirmed.profit;
  const histPnl = await api.recoverPnlFromHistory(dealId, openedTime);
  if (histPnl !== null) return histPnl;
  log.debug(`[PnL] No broker PnL for ${dealId} — falling back to directional math (CFD warning)`);
  return _mathPnl(direction, entry, exitPrice, size);
}

// ══════════════════════════════════════════════════════════════
// Market status check
// ══════════════════════════════════════════════════════════════

/**
 * Returns true only when Capital.com reports the market as TRADEABLE.
 * Any other status (CLOSED, EDITS_ONLY, OFFLINE, SUSPENDED…) blocks
 * new entries AND position management order calls.
 *
 * @returns {Promise<{ tradeable:boolean, bid:number, ask:number, status:string }>}
 */
async function fetchMarket() {
  const { bid, ask, status } = await api.getPrice(cfg.EPIC);
  const tradeable = status === 'TRADEABLE';
  if (!tradeable) {
    log.warn(`[Market] ${cfg.EPIC} is not tradeable — status: ${status}. Skipping entries/closes.`);
  }
  return { tradeable, bid, ask, status };
}

// ══════════════════════════════════════════════════════════════
// F) Trend filters
// ══════════════════════════════════════════════════════════════

function trendFilterM15() {
  const candles = cs.get('M15');
  if (candles.length < cfg.EMA_TREND_PERIOD) {
    log.debug(`[Trend] M15: insufficient bars (${candles.length}/${cfg.EMA_TREND_PERIOD}) → NONE`);
    return 'NONE';
  }

  const ema200 = ind.ema(closes(candles), cfg.EMA_TREND_PERIOD);
  if (ema200 === null) {
    log.debug('[Trend] M15: EMA200 not ready → NONE');
    return 'NONE';
  }

  const close = last(candles).close;
  const trend = close > ema200 ? 'UP' : close < ema200 ? 'DOWN' : 'NONE';
  log.debug(`[Trend] M15: close=${close.toFixed(4)} ema200=${ema200.toFixed(4)} → ${trend}`);
  return trend;
}

function trendFilterH4() {
  const candles = cs.get('H4');
  if (candles.length < cfg.EMA_TREND_PERIOD) {
    log.debug(`[Trend] H4: insufficient bars (${candles.length}/${cfg.EMA_TREND_PERIOD}) → NONE`);
    return 'NONE';
  }

  const ema200 = ind.ema(closes(candles), cfg.EMA_TREND_PERIOD);
  if (ema200 === null) {
    log.debug('[Trend] H4: EMA200 not ready → NONE');
    return 'NONE';
  }

  const close = last(candles).close;
  const trend = close > ema200 ? 'UP' : close < ema200 ? 'DOWN' : 'NONE';
  log.debug(`[Trend] H4: close=${close.toFixed(4)} ema200=${ema200.toFixed(4)} → ${trend}`);
  return trend;
}

// ══════════════════════════════════════════════════════════════
// G) Chop filter
// ══════════════════════════════════════════════════════════════

function chopFilter(tf) {
  const candles = cs.get(tf);
  if (candles.length < cfg.EMA_PULLBACK_PERIOD) {
    log.debug(`[Chop] ${tf}: insufficient bars (${candles.length}/${cfg.EMA_PULLBACK_PERIOD}) → skip`);
    return true;
  }

  const ema20  = ind.ema(closes(candles), cfg.EMA_FAST_PERIOD);
  const ema50  = ind.ema(closes(candles), cfg.EMA_PULLBACK_PERIOD);
  const atrVal = ind.atr(highs(candles), lows(candles), closes(candles), cfg.ATR_PERIOD);

  if (ema20 === null || ema50 === null || atrVal === null) {
    log.debug(`[Chop] ${tf}: indicators not ready → skip`);
    return true;
  }

  const dist    = Math.abs(ema20 - ema50);
  const minDist = cfg.CHOP_EMA_DIST_ATR_MIN * atrVal;
  const isChop  = dist < minDist;

  if (isChop) {
    log.debug(`[Chop] ${tf}: ema20=${ema20.toFixed(4)} ema50=${ema50.toFixed(4)} dist=${dist.toFixed(4)} < min=${minDist.toFixed(4)} → CHOPPY`);
  } else {
    log.debug(`[Chop] ${tf}: ema20=${ema20.toFixed(4)} ema50=${ema50.toFixed(4)} dist=${dist.toFixed(4)} ≥ min=${minDist.toFixed(4)} → trending OK`);
  }
  return isChop;
}

// ══════════════════════════════════════════════════════════════
// H) Setup detection

/**
 * True rejection candle test — replaces simple "close > open" check.
 * BUY:  close in top 40% of range  AND lower wick ≥ 30% of range.
 * SELL: close in bottom 40% of range AND upper wick ≥ 30% of range.
 */
function _isRejectionCandle(bar, direction) {
  const range = bar.high - bar.low;
  if (range === 0) return false;

  if (direction === 'BUY') {
    if (bar.close <= bar.open) return false;
    const closePosition = (bar.close - bar.low) / range;
    const lowerWick     = Math.min(bar.open, bar.close) - bar.low;
    return closePosition >= cfg.REJECTION_CLOSE_PCT &&
           lowerWick / range >= cfg.REJECTION_WICK_PCT;
  } else {
    if (bar.close >= bar.open) return false;
    const closePosition = (bar.high - bar.close) / range;
    const upperWick     = bar.high - Math.max(bar.open, bar.close);
    return closePosition >= cfg.REJECTION_CLOSE_PCT &&
           upperWick / range >= cfg.REJECTION_WICK_PCT;
  }
}
// ══════════════════════════════════════════════════════════════

/**
 * Attempts to create a new setup on candle close.
 * Returns { active: true, ... } on success, { active: false } otherwise.
 *
 * Fix #7: Added EMA alignment check (EMA20 must be aligned with trend)
 *         and rejection candle (bar must close in the trend direction).
 */
function createSetup(tf, trend) {
  const candles = cs.get(tf);
  if (candles.length < cfg.EMA_PULLBACK_PERIOD) return { active: false };

  const ema20  = ind.ema(closes(candles), cfg.EMA_FAST_PERIOD);
  const ema50  = ind.ema(closes(candles), cfg.EMA_PULLBACK_PERIOD);
  const atrVal = ind.atr(highs(candles), lows(candles), closes(candles), cfg.ATR_PERIOD);
  if (ema20 === null || ema50 === null || atrVal === null) return { active: false };

  // Trend strength proxy: |EMA20 − EMA50| / ATR
  const spreadATR = Math.abs(ema20 - ema50) / atrVal;

  // Chop check — too flat to trade
  if (spreadATR < cfg.CHOP_EMA_DIST_ATR_MIN) {
    log.debug(`[Setup] ${tf}: spreadATR=${spreadATR.toFixed(3)} < ${cfg.CHOP_EMA_DIST_ATR_MIN} — chop, no setup`);
    return { active: false };
  }

  // Adaptive EMA50 tolerance: widens as trend strengthens, capped at TOL_MAX
  const tolFactor = Math.min(
    cfg.PULLBACK_TOL_MAX,
    cfg.PULLBACK_TOL_BASE + cfg.PULLBACK_TOL_K * Math.max(0, spreadATR - cfg.CHOP_EMA_DIST_ATR_MIN)
  );
  const tol50 = tolFactor * atrVal;
  const tol20 = cfg.FAST_PULLBACK_TOL * atrVal;
  const allowFast = spreadATR >= cfg.FAST_PULLBACK_SPREADATR_MIN;

  const bar = last(candles);

  if (trend === 'UP') {
    if (ema20 <= ema50) {
      log.debug(`[Setup] ${tf}: BUY EMA alignment fail — ema20=${ema20.toFixed(4)} ≤ ema50=${ema50.toFixed(4)}`);
      return { active: false };
    }

    const dist50 = Math.abs(bar.low - ema50);
    const dist20 = Math.abs(bar.low - ema20);
    const touchEma50 = dist50 <= tol50;
    const touchEma20 = allowFast && dist20 <= tol20;

    if (!touchEma50 && !touchEma20) {
      log.debug(
        `[Setup] ${tf}: BUY not formed — low=${bar.low.toFixed(4)} ` +
        `ema50 dist=${dist50.toFixed(4)} tol=${tol50.toFixed(4)} | ` +
        `ema20 dist=${dist20.toFixed(4)} tol=${tol20.toFixed(4)} fastOk=${allowFast}`
      );
      return { active: false };
    }

    if (!_isRejectionCandle(bar, 'BUY')) {
      const range = bar.high - bar.low;
      log.debug(
        `[Setup] ${tf}: BUY rejection fail — ` +
        `closePos=${range ? ((bar.close - bar.low) / range).toFixed(2) : 'n/a'} ` +
        `lowerWick=${range ? ((Math.min(bar.open, bar.close) - bar.low) / range).toFixed(2) : 'n/a'}`
      );
      return { active: false };
    }

    const touchType = touchEma50 ? 'EMA50' : 'EMA20';
    const refEma    = touchEma50 ? ema50   : ema20;
    log.info(
      `[Setup] BUY setup on ${tf}: touch=${touchType} low=${bar.low.toFixed(4)} ` +
      `ref=${refEma.toFixed(4)} spreadATR=${spreadATR.toFixed(3)} tol=${tol50.toFixed(4)}`
    );
    return {
      active: true, direction: 'BUY', createdTime: bar.time,
      pullbackExtreme: bar.low, touchType, touchPrice: bar.low, refEma,
    };
  }

  if (trend === 'DOWN') {
    if (ema20 >= ema50) {
      log.debug(`[Setup] ${tf}: SELL EMA alignment fail — ema20=${ema20.toFixed(4)} ≥ ema50=${ema50.toFixed(4)}`);
      return { active: false };
    }

    const dist50 = Math.abs(bar.high - ema50);
    const dist20 = Math.abs(bar.high - ema20);
    const touchEma50 = dist50 <= tol50;
    const touchEma20 = allowFast && dist20 <= tol20;

    if (!touchEma50 && !touchEma20) {
      log.debug(
        `[Setup] ${tf}: SELL not formed — high=${bar.high.toFixed(4)} ` +
        `ema50 dist=${dist50.toFixed(4)} tol=${tol50.toFixed(4)} | ` +
        `ema20 dist=${dist20.toFixed(4)} tol=${tol20.toFixed(4)} fastOk=${allowFast}`
      );
      return { active: false };
    }

    if (!_isRejectionCandle(bar, 'SELL')) {
      const range = bar.high - bar.low;
      log.debug(
        `[Setup] ${tf}: SELL rejection fail — ` +
        `closePos=${range ? ((bar.high - bar.close) / range).toFixed(2) : 'n/a'} ` +
        `upperWick=${range ? ((bar.high - Math.max(bar.open, bar.close)) / range).toFixed(2) : 'n/a'}`
      );
      return { active: false };
    }

    const touchType = touchEma50 ? 'EMA50' : 'EMA20';
    const refEma    = touchEma50 ? ema50   : ema20;
    log.info(
      `[Setup] SELL setup on ${tf}: touch=${touchType} high=${bar.high.toFixed(4)} ` +
      `ref=${refEma.toFixed(4)} spreadATR=${spreadATR.toFixed(3)} tol=${tol50.toFixed(4)}`
    );
    return {
      active: true, direction: 'SELL', createdTime: bar.time,
      pullbackExtreme: bar.high, touchType, touchPrice: bar.high, refEma,
    };
  }

  return { active: false };
}

/**
 * Update the pullback extreme to track the deepest retracement.
 */
function updateSetupExtreme(tf, setup) {
  const bar = last(cs.get(tf));
  if (setup.direction === 'BUY') {
    const prev = setup.pullbackExtreme;
    setup.pullbackExtreme = Math.min(prev, bar.low);
    if (setup.pullbackExtreme !== prev) {
      log.debug(`[Setup] ${tf}: pullback extreme updated BUY → ${setup.pullbackExtreme.toFixed(4)} (was ${prev.toFixed(4)})`);
    }
  } else {
    const prev = setup.pullbackExtreme;
    setup.pullbackExtreme = Math.max(prev, bar.high);
    if (setup.pullbackExtreme !== prev) {
      log.debug(`[Setup] ${tf}: pullback extreme updated SELL → ${setup.pullbackExtreme.toFixed(4)} (was ${prev.toFixed(4)})`);
    }
  }
}

/**
 * True if more than expiryBars closed bars have appeared since the setup was created.
 */
function setupExpired(tf, setup, expiryBars) {
  const candles   = cs.get(tf);
  const barsSince = candles.filter(c => c.time > setup.createdTime).length;
  const expired   = barsSince > expiryBars;
  if (!expired) {
    log.debug(`[Setup] ${tf}: active ${setup.direction} setup — ${barsSince}/${expiryBars} bars elapsed`);
  }
  return expired;
}

// ══════════════════════════════════════════════════════════════
// I) BOS trigger
// ══════════════════════════════════════════════════════════════

/**
 * Returns true if the most recent closed candle breaks the
 * highest-high / lowest-low of the previous bosLookback candles.
 *
 * Fix #7: Added BOS margin = max(spread, 0.05×ATR) to require a
 *         meaningful close beyond the structure level, not just a tick.
 *
 * @param {string} tf
 * @param {object} setup
 * @param {number} bosLookback
 * @param {number} spread  Current bid-ask spread (passed from caller)
 */
function triggerBOS(tf, setup, bosLookback, spread = 0) {
  const candles = cs.get(tf);
  if (candles.length < bosLookback + 1) return false;

  const atrVal = ind.atr(highs(candles), lows(candles), closes(candles), cfg.ATR_PERIOD);
  if (atrVal === null) return false;

  const bar   = last(candles);
  const range = bar.high - bar.low;
  if (range > cfg.BIG_CANDLE_ATR_MAX * atrVal) {
    log.debug(`[BOS] ${tf}: big candle skipped — range=${range.toFixed(4)} > max=${(cfg.BIG_CANDLE_ATR_MAX * atrVal).toFixed(4)}`);
    return false;
  }

  const prevCandles = candles.slice(0, -1);
  if (prevCandles.length < bosLookback) return false;

  // BOS margin: require close to clear the level by at least max(spread, 5% of ATR)
  const margin = Math.max(spread, 0.05 * atrVal);

  if (setup.direction === 'BUY') {
    const level     = ind.highestHigh(highs(prevCandles), bosLookback);
    const triggered = bar.close > level + margin;
    if (triggered) {
      log.info(`[BOS] BUY triggered on ${tf}: close=${bar.close.toFixed(4)} > HH=${level.toFixed(4)} + margin=${margin.toFixed(4)}`);
    } else {
      log.debug(`[BOS] ${tf}: BUY not triggered — close=${bar.close.toFixed(4)} vs HH+margin=${(level + margin).toFixed(4)} (need +${(level + margin - bar.close).toFixed(4)} more)`);
    }
    return triggered;
  } else {
    const level     = ind.lowestLow(lows(prevCandles), bosLookback);
    const triggered = bar.close < level - margin;
    if (triggered) {
      log.info(`[BOS] SELL triggered on ${tf}: close=${bar.close.toFixed(4)} < LL=${level.toFixed(4)} - margin=${margin.toFixed(4)}`);
    } else {
      log.debug(`[BOS] ${tf}: SELL not triggered — close=${bar.close.toFixed(4)} vs LL-margin=${(level - margin).toFixed(4)} (need -${(bar.close - (level - margin)).toFixed(4)} more)`);
    }
    return triggered;
  }
}

// ══════════════════════════════════════════════════════════════
// I-2) Additional execution quality gates
// ══════════════════════════════════════════════════════════════

/**
 * M5 RSI momentum gate.
 * BUY blocked if RSI < M5_RSI_BUY_MIN; SELL blocked if RSI > M5_RSI_SELL_MAX.
 * Returns true (allow) when not enough data to compute RSI.
 */
function rsiGateM5(direction) {
  const m5 = cs.get('M5');
  const rsiVal = ind.rsi(closes(m5), cfg.RSI_PERIOD);
  if (rsiVal === null) return true;
  if (direction === 'BUY'  && rsiVal < cfg.M5_RSI_BUY_MIN) {
    log.debug(`[RSI] M5 BUY blocked: RSI=${rsiVal.toFixed(1)} < ${cfg.M5_RSI_BUY_MIN}`);
    return false;
  }
  if (direction === 'SELL' && rsiVal > cfg.M5_RSI_SELL_MAX) {
    log.debug(`[RSI] M5 SELL blocked: RSI=${rsiVal.toFixed(1)} > ${cfg.M5_RSI_SELL_MAX}`);
    return false;
  }
  log.debug(`[RSI] M5 RSI=${rsiVal.toFixed(1)} OK for ${direction}`);
  return true;
}

/**
 * M5 ATR ratio volatility gate.
 * Blocks entries when current ATR is well below its recent average (dead market).
 * Returns true (allow) when not enough data.
 */
function atrRatioGateM5() {
  const m5     = cs.get('M5');
  const atrVal = ind.atr(highs(m5), lows(m5), closes(m5), cfg.ATR_PERIOD);
  if (atrVal !== null && atrVal < cfg.ATR_ABS_MIN_M5) {
    log.debug(`[ATR Ratio] M5 blocked: atr=${atrVal.toFixed(4)} < floor=${cfg.ATR_ABS_MIN_M5} — dead market`);
    return false;
  }
  const ratio = ind.atrRatio(highs(m5), lows(m5), closes(m5), cfg.ATR_PERIOD, cfg.ATR_RATIO_SMA_PERIOD);
  if (ratio === null) return true;
  if (ratio < cfg.ATR_RATIO_MIN) {
    log.debug(`[ATR Ratio] M5 blocked: ratio=${ratio.toFixed(3)} < min=${cfg.ATR_RATIO_MIN}`);
    return false;
  }
  log.debug(`[ATR Ratio] M5 atr=${atrVal?.toFixed(4)} ratio=${ratio.toFixed(3)} OK`);
  return true;
}

/**
 * M5 BOS candle body quality gate.
 * Requires the trigger bar's body to be >= BOS_CANDLE_BODY_ATR_MIN × ATR.
 * Filters micro-wick BOS events that rarely follow through.
 * @param {number|null} atrVal  Pre-computed M5 ATR
 */
function bosBodyGateM5(atrVal) {
  if (!atrVal) return true;
  const bar     = last(cs.get('M5'));
  const body    = Math.abs(bar.close - bar.open);
  const minBody = cfg.BOS_CANDLE_BODY_ATR_MIN * atrVal;
  if (body < minBody) {
    log.debug(`[Body] BOS bar body=${body.toFixed(4)} < min=${minBody.toFixed(4)} — skip`);
    return false;
  }
  log.debug(`[Body] BOS bar body=${body.toFixed(4)} >= min=${minBody.toFixed(4)} OK`);
  return true;
}

/**
 * M15 trend strength + slope gate.
 * Requires |close - EMA200| / ATR >= M15_TREND_STRENGTH_MIN
 * and EMA200 slope to agree with the detected trend direction.
 * Returns true (allow) when not enough data.
 */
function m15TrendStrengthGate(trend) {
  const m15 = cs.get('M15');
  if (m15.length < cfg.EMA_TREND_PERIOD) return true;
  const ema200 = ind.ema(closes(m15), cfg.EMA_TREND_PERIOD);
  const atr15  = ind.atr(highs(m15), lows(m15), closes(m15), cfg.M15_ATR_PERIOD);
  if (!ema200 || !atr15) return true;

  const closeLast = last(m15).close;
  const strength  = Math.abs(closeLast - ema200) / atr15;
  if (strength < cfg.M15_TREND_STRENGTH_MIN) {
    log.debug(`[M15 Strength] blocked: strength=${strength.toFixed(2)} < ${cfg.M15_TREND_STRENGTH_MIN}`);
    return false;
  }

  const slope = ind.emaSlope(closes(m15), cfg.EMA_TREND_PERIOD, cfg.M15_EMA200_SLOPE_BARS, atr15);
  if (slope !== null) {
    const slopeOk = (trend === 'UP' && slope > 0) || (trend === 'DOWN' && slope < 0);
    if (!slopeOk) {
      log.debug(`[M15 Slope] counter-trend: slope=${slope.toFixed(4)} for trend=${trend} — blocked`);
      return false;
    }
    log.debug(`[M15 Slope] slope=${slope.toFixed(4)} OK for ${trend}`);
  }

  log.debug(`[M15 Strength] strength=${strength.toFixed(2)} OK`);
  return true;
}

/**
 * H1 macro alignment gate.
 * Scalp BUY only if H1 close > H1 EMA200 and H1 RSI is not overbought.
 * Scalp SELL only if H1 close < H1 EMA200 and H1 RSI is not oversold.
 * Returns true (allow) when H1 data is insufficient.
 */
function h1MacroFilter(direction) {
  const h1 = cs.get('H1');
  if (h1.length < cfg.EMA_TREND_PERIOD) return true;
  const ema200h1 = ind.ema(closes(h1), cfg.EMA_TREND_PERIOD);
  const rsiH1    = ind.rsi(closes(h1), cfg.RSI_PERIOD);
  if (!ema200h1) return true;

  const closeH1 = last(h1).close;
  if (direction === 'BUY'  && closeH1 < ema200h1) {
    log.debug(`[H1 Macro] BUY blocked: H1 close=${closeH1.toFixed(4)} < EMA200=${ema200h1.toFixed(4)}`);
    return false;
  }
  if (direction === 'SELL' && closeH1 > ema200h1) {
    log.debug(`[H1 Macro] SELL blocked: H1 close=${closeH1.toFixed(4)} > EMA200=${ema200h1.toFixed(4)}`);
    return false;
  }
  if (rsiH1 !== null) {
    if (direction === 'BUY'  && rsiH1 > cfg.H1_RSI_OVERBOUGHT) {
      log.debug(`[H1 Macro] BUY blocked: H1 RSI=${rsiH1.toFixed(1)} > ${cfg.H1_RSI_OVERBOUGHT}`);
      return false;
    }
    if (direction === 'SELL' && rsiH1 < cfg.H1_RSI_OVERSOLD) {
      log.debug(`[H1 Macro] SELL blocked: H1 RSI=${rsiH1.toFixed(1)} < ${cfg.H1_RSI_OVERSOLD}`);
      return false;
    }
    log.debug(`[H1 Macro] H1 RSI=${rsiH1.toFixed(1)} OK`);
  }
  log.debug(`[H1 Macro] H1 close=${closeH1.toFixed(4)} EMA200=${ema200h1.toFixed(4)} OK for ${direction}`);
  return true;
}

// ══════════════════════════════════════════════════════════════
// J) SL/TP computation
// ══════════════════════════════════════════════════════════════

function computeSLTP(tf, mode, setup, entryPrice) {
  const candles = cs.get(tf);
  const atrVal  = ind.atr(highs(candles), lows(candles), closes(candles), cfg.ATR_PERIOD);
  const buffer  = cfg.SL_BUFFER_ATR * atrVal;

  let sl, tp1, tp2;

  if (mode === 'SCALP') {
    // ATR-based fixed targets — stable across volatility regimes
    if (setup.direction === 'BUY') {
      sl  = setup.pullbackExtreme - buffer;
      tp1 = entryPrice + cfg.SCALP_TP1_ATR * atrVal;
      tp2 = entryPrice + cfg.SCALP_TP2_ATR * atrVal;
    } else {
      sl  = setup.pullbackExtreme + buffer;
      tp1 = entryPrice - cfg.SCALP_TP1_ATR * atrVal;
      tp2 = entryPrice - cfg.SCALP_TP2_ATR * atrVal;
    }
  } else {
    // Swing: R-multiple targets
    if (setup.direction === 'BUY') {
      sl  = setup.pullbackExtreme - buffer;
      const R = entryPrice - sl;
      tp1 = entryPrice + cfg.TP1_R       * R;
      tp2 = entryPrice + cfg.TP2_R_SWING * R;
    } else {
      sl  = setup.pullbackExtreme + buffer;
      const R = sl - entryPrice;
      tp1 = entryPrice - cfg.TP1_R       * R;
      tp2 = entryPrice - cfg.TP2_R_SWING * R;
    }
  }

  log.debug(
    `[SLTP] ${tf} ${mode} ${setup.direction}: extreme=${setup.pullbackExtreme.toFixed(4)} ` +
    `buf=${buffer.toFixed(4)} atr=${atrVal.toFixed(4)} | ` +
    `sl=${sl.toFixed(4)} tp1=${tp1.toFixed(4)} tp2=${tp2.toFixed(4)}`
  );

  return { sl, tp1, tp2 };
}

// ══════════════════════════════════════════════════════════════
// K) Order placement
// ══════════════════════════════════════════════════════════════

async function placeOrder(mode, setup, bid, ask) {
  const tf    = mode === 'SCALP' ? 'M5' : 'H1';
  const size  = mode === 'SCALP' ? cfg.SCALP_SIZE_UNITS : cfg.SWING_SIZE_UNITS;
  const entry = setup.direction === 'BUY' ? ask : bid;

  const { sl, tp1, tp2 } = computeSLTP(tf, mode, setup, entry);

  // Fix #7: ATR/spread sanity — TP1 must be meaningful relative to the spread
  const spread   = ask - bid;
  const tp1Dist  = Math.abs(tp1 - entry);
  if (tp1Dist < 2 * spread) {
    log.warn(
      `[Order] TP1 distance too small (${tp1Dist.toFixed(4)} < 2×spread ${(2 * spread).toFixed(4)}) — trade skipped`
    );
    return;
  }

  log.trade(
    `[Order] ${mode} ${setup.direction} | size=${size} | entry=${entry.toFixed(4)} ` +
    `| SL=${sl.toFixed(4)} TP1=${tp1.toFixed(4)} TP2=${tp2.toFixed(4)}`
  );

  // Platform manages SL and TP2; we watch TP1 ourselves
  const { dealId, dealReference } = await api.createPosition({
    epic:        cfg.EPIC,
    direction:   setup.direction,
    size,
    stopLevel:   sl,
    profitLevel: tp2,
  });

  const openedTime = Date.now();
  state.addPosition({
    mode,
    direction:    setup.direction,
    size,
    entry,
    sl,
    tp1,
    tp2,
    tp1Done:      false,
    dealId,
    dealReference,
    openedTime,
  });

  tradesRepo.insertTrade({
    dealId,
    epic:      cfg.EPIC,
    openedTs:  openedTime,
    direction: setup.direction,
    size,
    entry,
    sl,
    tp2,
    mode,
  }).catch(() => {});

  log.trade(`[Order] Placed ✓ dealId=${dealId} ref=${dealReference}`);

  // Fire Telegram notification (non-blocking, non-fatal)
  telegram.notifyTradeOpened({
    mode,
    direction: setup.direction,
    epic:      cfg.EPIC,
    size,
    entry,
    sl,
    tp1,
    tp2,
    dealId,
    dealReference,
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
// L) Position management (runs on every tick)
// ══════════════════════════════════════════════════════════════

async function managePositions() {
  const positions = state.getPositions();
  if (!positions.length) return;

  // Fetch price + market status in one call
  let bid, ask, tradeable;
  try {
    ({ bid, ask, tradeable } = await fetchMarket());
  } catch (e) {
    log.warn(`[Manage] getPrice failed: ${e.message}`);
    return;
  }

  // When the market is closed the platform handles its own SL/TP natively.
  // We skip our API close/reopen calls — they would be rejected anyway.
  if (!tradeable) return;

  for (const pos of [...positions]) {
    const exitPrice = pos.direction === 'BUY' ? bid : ask;

    log.debug(
      `[Manage] ${pos.direction} pos dealId=${pos.dealId} | ` +
      `current=${exitPrice.toFixed(4)} entry=${pos.entry.toFixed(4)} | ` +
      `SL=${pos.sl.toFixed(4)} TP1=${pos.tp1.toFixed(4)}${pos.tp1Done ? '(done)' : ''} TP2=${pos.tp2.toFixed(4)}`
    );

    // ── SL hit ─────────────────────────────────────────────
    const slHit =
      (pos.direction === 'BUY'  && exitPrice <= pos.sl) ||
      (pos.direction === 'SELL' && exitPrice >= pos.sl);

    if (slHit) {
      log.trade(`[Manage] SL hit — ${pos.direction} dealId=${pos.dealId} exit=${exitPrice.toFixed(4)}`);
      let confirmed;
      try { confirmed = await api.closePosition(pos.dealId); } catch (e) {
        log.warn(`[Manage] Close failed (may already be closed by platform): ${e.message}`);
      }
      // Fix #2: use broker-reported profit when available
      // Fix #3: mark as loss only when PnL is actually negative
      const pnl = await resolvePnlAsync(confirmed, pos.dealId, pos.openedTime, pos.direction, pos.entry, exitPrice, pos.size);
      state.updatePnL(pnl, pnl < 0);
      state.removePosition(pos.dealId);
      tradesRepo.closeTrade({ dealId: pos.dealId, closedTs: Date.now(), exit: exitPrice, realizedPnl: pnl, closeReason: 'SL_HIT' }).catch(() => {});
      telegram.notifyTradeClosed({
        event: 'SL_HIT', direction: pos.direction, epic: cfg.EPIC,
        mode: pos.mode, entry: pos.entry, exitPrice, pnl, dealId: pos.dealId,
      }).catch(() => {});
      continue;
    }

    // ── TP1 hit ────────────────────────────────────────────
    if (!pos.tp1Done) {
      const tp1Hit =
        (pos.direction === 'BUY'  && exitPrice >= pos.tp1) ||
        (pos.direction === 'SELL' && exitPrice <= pos.tp1);

      if (tp1Hit) {
        log.trade(`[Manage] TP1 hit — ${pos.direction} dealId=${pos.dealId} exit=${exitPrice.toFixed(4)}`);

        // Fix #1: when size=1 (or closeSize rounds to 0) skip partial close,
        // just mark tp1Done and optionally move SL to breakeven.
        const closeSize = Math.floor(pos.size * cfg.PARTIAL_CLOSE_TP1);

        if (closeSize < 1) {
          const newSL = cfg.MOVE_SL_TO_BREAKEVEN_ON_TP1 ? pos.entry : pos.sl;
          log.trade(
            `[Manage] TP1 hit (size=${pos.size} — no partial) — marking tp1Done` +
            (cfg.MOVE_SL_TO_BREAKEVEN_ON_TP1 ? ', moving SL to breakeven' : '')
          );
          if (cfg.MOVE_SL_TO_BREAKEVEN_ON_TP1) {
            try {
              await api.updatePosition(pos.dealId, { stopLevel: newSL });
              log.debug(`[Manage] SL updated to breakeven: ${newSL.toFixed(4)}`);
            } catch (e) {
              log.warn(`[Manage] SL BE update failed: ${e.message}`);
            }
          }
          state.replacePosition(pos.dealId, { ...pos, tp1Done: true, sl: newSL });
          telegram.notifyTradeClosed({
            event: 'TP1_HIT', direction: pos.direction, epic: cfg.EPIC,
            mode: pos.mode, entry: pos.entry, exitPrice, pnl: 0, dealId: pos.dealId,
          }).catch(() => {});
          continue;
        }

        // Size >= 2: partial close + reopen remainder
        try {
          const confirmed    = await api.closePosition(pos.dealId);
          const remainingSize = pos.size - closeSize;

          // Fix #2: prefer broker profit, scaled to closed portion
          const pnl1 = await resolvePnlAsync(confirmed, pos.dealId, pos.openedTime, pos.direction, pos.entry, exitPrice, closeSize);
          // Fix #3: partial close at TP1 is rarely a loss, but use actual sign
          state.updatePnL(pnl1, pnl1 < 0);
          tradesRepo.closeTrade({ dealId: pos.dealId, closedTs: Date.now(), exit: exitPrice, realizedPnl: pnl1, closeReason: 'TP1_HIT' }).catch(() => {});
          telegram.notifyTradeClosed({
            event: 'TP1_HIT', direction: pos.direction, epic: cfg.EPIC,
            mode: pos.mode, entry: pos.entry, exitPrice, pnl: pnl1, dealId: pos.dealId,
          }).catch(() => {});

          if (remainingSize >= 1) {
            const newSL = cfg.MOVE_SL_TO_BREAKEVEN_ON_TP1 ? pos.entry : pos.sl;
            log.debug(`[Manage] Reopening ${remainingSize} unit(s) | SL=${newSL.toFixed(4)}`);
            const { dealId: newDealId, dealReference: newRef } = await api.createPosition({
              epic:        cfg.EPIC,
              direction:   pos.direction,
              size:        remainingSize,
              stopLevel:   newSL,
              profitLevel: pos.tp2,
            });
            const reopenedTime = Date.now();
            state.replacePosition(pos.dealId, {
              ...pos,
              dealId:        newDealId,
              dealReference: newRef,
              size:          remainingSize,
              entry:         exitPrice,
              sl:            newSL,
              tp1Done:       true,
              openedTime:    reopenedTime,
            });
            tradesRepo.insertTrade({
              dealId:    newDealId,
              epic:      cfg.EPIC,
              openedTs:  reopenedTime,
              direction: pos.direction,
              size:      remainingSize,
              entry:     exitPrice,
              sl:        newSL,
              tp2:       pos.tp2,
              mode:      pos.mode,
            }).catch(() => {});
            log.trade(`[Manage] Remaining ${remainingSize} unit(s) reopened → dealId=${newDealId}`);
          } else {
            state.removePosition(pos.dealId);
          }
        } catch (e) {
          log.error(`[Manage] TP1 partial close failed: ${e.message}`);
          pos.tp1Done = true;
        }
        continue;
      }
    }

    // ── TP2 hit ────────────────────────────────────────────
    const tp2Hit =
      (pos.direction === 'BUY'  && exitPrice >= pos.tp2) ||
      (pos.direction === 'SELL' && exitPrice <= pos.tp2);

    if (tp2Hit) {
      log.trade(`[Manage] TP2 hit — ${pos.direction} dealId=${pos.dealId} exit=${exitPrice.toFixed(4)}`);
      let confirmed;
      try { confirmed = await api.closePosition(pos.dealId); } catch (e) {
        log.warn(`[Manage] TP2 close failed (may already be closed by platform): ${e.message}`);
      }
      // Fix #2: prefer broker profit; Fix #3: use actual sign
      const pnl = await resolvePnlAsync(confirmed, pos.dealId, pos.openedTime, pos.direction, pos.entry, exitPrice, pos.size);
      state.updatePnL(pnl, pnl < 0);
      state.removePosition(pos.dealId);
      tradesRepo.closeTrade({ dealId: pos.dealId, closedTs: Date.now(), exit: exitPrice, realizedPnl: pnl, closeReason: 'TP2_HIT' }).catch(() => {});
      telegram.notifyTradeClosed({
        event: 'TP2_HIT', direction: pos.direction, epic: cfg.EPIC,
        mode: pos.mode, entry: pos.entry, exitPrice, pnl, dealId: pos.dealId,
      }).catch(() => {});
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Platform reconciliation
// ══════════════════════════════════════════════════════════════

/**
 * Cross-check bot-tracked positions against the platform.
 *
 * Safety rules (Bug #4 fix):
 *  - A single miss from /positions does NOT remove the local position.
 *    Capital.com can have transient API inconsistencies.
 *  - After MISS_THRESHOLD consecutive misses, verify via GET /positions/{dealId}.
 *  - Only a confirmed 404 from the single-position endpoint triggers removal.
 *
 * PnL recovery (Bug #5 fix):
 *  - On confirmed closure, query /history/activity to recover realized PnL
 *    and update day_pnl / consecutive_losses counters correctly.
 *
 * Call this every ~60 s from index.js.
 */
async function reconcilePositions() {
  const botPositions = state.getPositions();

  // Clean up miss counters for positions no longer tracked
  for (const id of Object.keys(_reconcileMissCount)) {
    if (!botPositions.find(p => p.dealId === id)) {
      delete _reconcileMissCount[id];
    }
  }

  if (!botPositions.length) return;

  let platformPositions;
  try {
    platformPositions = await api.getPositions();
  } catch (e) {
    log.warn(`[Reconcile] Failed to fetch platform positions: ${e.message}`);
    return;
  }

  // Capital.com wraps each entry as { position: { dealId, ... }, market: {...} }
  const platformIds = new Set(
    platformPositions.map(p => p.position?.dealId).filter(Boolean)
  );

  const MISS_THRESHOLD = 3;

  for (const pos of [...botPositions]) {
    if (platformIds.has(pos.dealId)) {
      // Position is present — reset any pending miss counter
      delete _reconcileMissCount[pos.dealId];
      continue;
    }

    // Position absent from list — increment miss counter
    _reconcileMissCount[pos.dealId] = (_reconcileMissCount[pos.dealId] || 0) + 1;
    const misses = _reconcileMissCount[pos.dealId];

    if (misses < MISS_THRESHOLD) {
      log.warn(
        `[Reconcile] dealId=${pos.dealId} not in /positions list ` +
        `(miss ${misses}/${MISS_THRESHOLD}) — waiting for confirmation...`
      );
      continue;
    }

    // MISS_THRESHOLD reached — verify via direct single-position GET
    let stillOpen;
    try {
      stillOpen = await api.getPosition(pos.dealId);
    } catch (e) {
      log.warn(`[Reconcile] Could not verify ${pos.dealId}: ${e.message}`);
      continue;
    }

    if (stillOpen) {
      log.warn(
        `[Reconcile] dealId=${pos.dealId} absent from list but found via direct GET — ` +
        `resetting miss counter (transient API inconsistency)`
      );
      _reconcileMissCount[pos.dealId] = 0;
      continue;
    }

    // Confirmed closed — try to recover realized PnL from history (Bug #5)
    log.warn(
      `[Reconcile] dealId=${pos.dealId} confirmed not on platform — ` +
      `broker-closed (SL/TP/margin). Recovering PnL...`
    );
    delete _reconcileMissCount[pos.dealId];

    let pnl = null;
    try {
      const activities = await api.getDayActivity(pos.openedTime);
      // Find the POSITION close event matching this dealId
      const closeEvent = activities.find(a =>
        a.dealId === pos.dealId &&
        (a.type?.toLowerCase()   === 'position') &&
        (a.status?.toLowerCase() === 'closed')
      );
      if (closeEvent) {
        // Capital.com returns profit in details.profit (float, account currency)
        pnl = closeEvent.details?.profit ?? closeEvent.profit ?? null;
        log.debug(`[Reconcile] History PnL for ${pos.dealId}: ${pnl}`);
      } else {
        log.debug(`[Reconcile] No close event found in history for ${pos.dealId}`);
      }
    } catch (e) {
      log.debug(`[Reconcile] History fetch failed for ${pos.dealId}: ${e.message}`);
    }

    if (pnl !== null) {
      state.updatePnL(pnl, pnl < 0);
    }

    state.removePosition(pos.dealId);
    tradesRepo.closeTrade({ dealId: pos.dealId, closedTs: Date.now(), exit: null, realizedPnl: pnl, closeReason: 'BROKER_CLOSE' }).catch(() => {});
    telegram.notifyTradeClosed({
      event:      'BROKER_CLOSE',
      direction:  pos.direction,
      epic:       cfg.EPIC,
      mode:       pos.mode,
      entry:      pos.entry,
      exitPrice:  null,
      pnl,
      dealId:     pos.dealId,
    }).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════
// Startup sync
// ══════════════════════════════════════════════════════════════

/**
 * Adopt any positions already open on the platform at startup.
 * Reconstructs TP1 from entry/SL using the deterministic formula
 * so TP1 management works correctly after a restart (Bug #6 fix).
 *
 * If SL is missing, TP management is disabled for that position to
 * prevent null-comparison false-triggers.
 */
async function syncExistingPositions() {
  let platformPositions;
  try {
    platformPositions = await api.getPositions();
  } catch (e) {
    log.warn(`[Sync] Could not fetch platform positions: ${e.message}`);
    return;
  }

  if (!platformPositions.length) {
    log.info('[Sync] No existing platform positions to adopt.');
    return;
  }

  let adopted = 0;
  for (const p of platformPositions) {
    const pos  = p.position;
    const entry = pos.level;
    const sl    = pos.stopLevel ?? null;
    const tp2   = pos.limitLevel ?? null;
    const dir   = pos.direction;  // 'BUY' or 'SELL'

    if (!entry || !sl) {
      // Without entry + SL we cannot compute R — disable TP logic safely
      log.warn(
        `[Sync] Skipping dealId=${pos.dealId} — missing entry(${entry}) or sl(${sl}). ` +
        `Position will be managed by platform SL/TP only.`
      );
      continue;
    }

    const R   = Math.abs(entry - sl);
    const tp1 = dir === 'BUY'
      ? entry + cfg.TP1_R * R
      : entry - cfg.TP1_R * R;

    // If platform TP2 is absent, compute a synthetic one from the scalp R
    const tp2Final = tp2 ?? (
      dir === 'BUY'
        ? entry + cfg.TP2_R_SCALP * R
        : entry - cfg.TP2_R_SCALP * R
    );

    state.adoptPosition({
      mode:          'UNKNOWN',
      direction:     dir,
      size:          pos.size,
      entry,
      sl,
      tp1,
      tp2:           tp2Final,
      tp1Done:       false,
      dealId:        pos.dealId,
      dealReference: pos.dealReference ?? '',
      openedTime:    Date.now(),
    });

    log.info(
      `[Sync] Adopted ${dir} dealId=${pos.dealId} | ` +
      `entry=${entry.toFixed(4)} sl=${sl.toFixed(4)} ` +
      `tp1=${tp1.toFixed(4)} tp2=${tp2Final.toFixed(4)}`
    );
    adopted++;
  }

  if (adopted) log.info(`[Sync] Adopted ${adopted} existing platform position(s).`);
}

// ══════════════════════════════════════════════════════════════
// M) Main loop handlers
// ══════════════════════════════════════════════════════════════

/**
 * Called on every M5 candle close — runs the SCALP branch.
 *
 * Signal logging: a row is written to the `signals` table on every call
 * (regardless of which gate fires) via a try/finally block.
 * ML gate: after BOS + M1 micro-confirm, score features against the
 * loaded JSON model and block the entry if confidence is too low.
 */
async function onM5Close() {
  // Mutable signal context — populated as we proceed through gates.
  // The finally block always flushes it to the DB.
  const sig = {
    epic:         cfg.EPIC,
    ts:           last(cs.get('M5'))?.time ?? Date.now(),   // candle timestamp, not wall clock
    mode:         'SCALP',
    action:       'HOLD',
    reasons:      { riskOK: false },
    features:     {},
    modelScore:   null,
    modelVersion: null,
  };

  try {
    if (!state.riskOK()) { sig.action = 'SKIP_RISK'; return; }
    sig.reasons.riskOK = true;

    let bid, ask, tradeable;
    try { ({ bid, ask, tradeable } = await fetchMarket()); }
    catch (e) { log.error(`[M5] getPrice failed: ${e.message}`); sig.action = 'SKIP_MARKET_ERR'; return; }

    if (!tradeable) { sig.action = 'SKIP_MARKET_CLOSED'; return; }

    // Pre-compute all gates so we can log a single summary line
    const spread   = ask - bid;
    const spreadOk = spread <= cfg.SPREAD_MAX;   // crude check used for log below
    const trend    = trendFilterM15();
    const isChop   = chopFilter('M5');
    const setup    = state.getSetupScalp();

    log.info(
      `[M5] spread=${spreadOk ? 'OK' : 'WIDE'}(${spread.toFixed(3)}) ` +
      `trend=${trend} chop=${isChop} ` +
      `setup=${setup.active ? setup.direction : 'none'}`
    );

    // Build feature snapshot for ML training dataset
    const m5  = cs.get('M5');
    const m15 = cs.get('M15');
    const m1  = cs.get('M1');
    const h1  = cs.get('H1');

    const m5_ema20   = m5.length  >= cfg.EMA_FAST_PERIOD      ? ind.ema(closes(m5),  cfg.EMA_FAST_PERIOD)      : null;
    const m5_ema50   = m5.length  >= cfg.EMA_PULLBACK_PERIOD   ? ind.ema(closes(m5),  cfg.EMA_PULLBACK_PERIOD)  : null;
    const m5_atr     = m5.length  >= cfg.ATR_PERIOD            ? ind.atr(highs(m5),   lows(m5),   closes(m5),   cfg.ATR_PERIOD) : null;
    const m5_rsi14   = ind.rsi(closes(m5), cfg.RSI_PERIOD);
    const m5_bb_width = ind.bollingerWidth(closes(m5), 20);
    const m5_atr_ratio = ind.atrRatio(highs(m5), lows(m5), closes(m5), cfg.ATR_PERIOD, cfg.ATR_RATIO_SMA_PERIOD);

    const m15_ema200  = m15.length >= cfg.EMA_TREND_PERIOD     ? ind.ema(closes(m15), cfg.EMA_TREND_PERIOD)     : null;
    const m15_atr     = m15.length >= cfg.M15_ATR_PERIOD       ? ind.atr(highs(m15),  lows(m15),  closes(m15),  cfg.M15_ATR_PERIOD) : null;
    const m15_ema200_slope = m15_atr
      ? ind.emaSlope(closes(m15), cfg.EMA_TREND_PERIOD, cfg.M15_EMA200_SLOPE_BARS, m15_atr)
      : null;

    const m1_ema20   = m1.length  >= cfg.MICRO_EMA_FAST_PERIOD ? ind.ema(closes(m1),  cfg.MICRO_EMA_FAST_PERIOD) : null;
    const m1_ema50   = m1.length  >= cfg.MICRO_EMA_SLOW_PERIOD ? ind.ema(closes(m1),  cfg.MICRO_EMA_SLOW_PERIOD) : null;

    const h1_ema200  = h1.length  >= cfg.EMA_TREND_PERIOD      ? ind.ema(closes(h1),  cfg.EMA_TREND_PERIOD)     : null;
    const h1_rsi14   = ind.rsi(closes(h1), cfg.RSI_PERIOD);

    const m5_close  = m5.length  ? last(m5).close  : null;
    const m15_close = m15.length ? last(m15).close : null;
    const h1_close  = h1.length  ? last(h1).close  : null;

    sig.features = {
      spread,
      bid,
      ask,
      spread_norm:           m5_atr ? spread / m5_atr : null,
      // M5 price structure
      m5_close,
      m5_ema20,
      m5_ema50,
      m5_atr,
      m5_ema20_50_dist_atr:  (m5_ema20 != null && m5_ema50 != null && m5_atr)
                               ? (m5_ema20 - m5_ema50) / m5_atr : null,
      m5_close_ema50_dist:   (m5_close != null && m5_ema50 != null)
                               ? m5_close - m5_ema50 : null,
      // M5 momentum / volatility
      m5_rsi14,
      m5_bb_width,
      m5_atr_ratio,
      // M15 trend
      m15_close,
      m15_ema200,
      m15_atr,
      m15_ema200_dist_atr:   (m15_close != null && m15_ema200 != null && m5_atr)
                               ? (m15_close - m15_ema200) / m5_atr : null,
      m15_trend_strength:    (m15_close != null && m15_ema200 != null && m15_atr)
                               ? Math.abs(m15_close - m15_ema200) / m15_atr : null,
      m15_ema200_slope,
      // H1 macro
      h1_close,
      h1_ema200,
      h1_rsi14,
      h1_ema200_dist_atr:    (h1_close != null && h1_ema200 != null && m5_atr)
                               ? (h1_close - h1_ema200) / m5_atr : null,
      // M1 micro-confirm
      m1_ema20,
      m1_ema50,
      m1_ema20_50_dist:      (m1_ema20 != null && m1_ema50 != null)
                               ? m1_ema20 - m1_ema50 : null,
      // Gate flags
      chop:                  isChop ? 1 : 0,
      setup_active:          setup.active ? 1 : 0,
    };

    sig.reasons = {
      ...sig.reasons,
      spreadOk,
      trend,
      isChop,
      setupActive:      setup.active,
      setupDirection:   setup.active ? setup.direction : null,
    };

    // Dynamic spread gate: max(SPREAD_MIN_GOLD, SPREAD_ATR_FACTOR × ATR), hard-capped by SPREAD_MAX
    const dynamicSpreadMax = m5_atr
      ? Math.min(cfg.SPREAD_MAX, Math.max(cfg.SPREAD_MIN_GOLD, cfg.SPREAD_ATR_FACTOR * m5_atr))
      : cfg.SPREAD_MAX;
    if (spread > dynamicSpreadMax) {
      log.warn(
        `[Strategy] Spread too wide: ${spread.toFixed(4)} > ${dynamicSpreadMax.toFixed(4)} ` +
        `(max(${cfg.SPREAD_MIN_GOLD}, ${cfg.SPREAD_ATR_FACTOR}×ATR))`
      );
      sig.action = 'SKIP_SPREAD'; return;
    }

    if (trend === 'NONE') {
      state.setSetupScalp({ active: false });
      sig.action = 'SKIP_TREND'; return;
    }

    if (isChop) {
      state.setSetupScalp({ active: false });
      sig.action = 'SKIP_CHOP'; return;
    }

    if (setup.active) {
      const expectedTrend = setup.direction === 'BUY' ? 'UP' : 'DOWN';
      if (trend !== expectedTrend) {
        log.info(`[M5] Trend changed to ${trend} — invalidating ${setup.direction} scalp setup`);
        state.setSetupScalp({ active: false });
        sig.action = 'SKIP_TREND_FLIP'; return;
      }

      // Structural invalidation: EMA alignment break or price failed through EMA50
      if (m5_ema20 !== null && m5_ema50 !== null) {
        const alignmentOk = setup.direction === 'BUY' ? m5_ema20 > m5_ema50 : m5_ema20 < m5_ema50;
        if (!alignmentOk) {
          log.info(`[M5] EMA alignment broken — invalidating ${setup.direction} setup`);
          state.setSetupScalp({ active: false });
          sig.action = 'SKIP_EMA_ALIGNMENT'; return;
        }
      }
      if (m5_close !== null && m5_ema50 !== null && m5_atr !== null) {
        const threshold = cfg.SETUP_INVALIDATION_ATR * m5_atr;
        const meanBreak = setup.direction === 'BUY'
          ? m5_close < m5_ema50 - threshold
          : m5_close > m5_ema50 + threshold;
        if (meanBreak) {
          log.info(`[M5] Price broke through mean — invalidating ${setup.direction} setup`);
          state.setSetupScalp({ active: false });
          sig.action = 'SKIP_MEAN_BREAK'; return;
        }
      }

      if (setupExpired('M5', setup, cfg.SETUP_EXPIRY_BARS_SCALP)) {
        log.info('[M5] Setup expired — resetting');
        state.setSetupScalp({ active: false });
        sig.action = 'SKIP_EXPIRED'; return;
      }

      updateSetupExtreme('M5', setup);

      // H1 macro alignment + M15 trend strength/slope — re-checked each bar
      const h1MacroOk = h1MacroFilter(setup.direction);
      sig.reasons.h1MacroOk = h1MacroOk;
      if (!h1MacroOk) {
        log.info(`[M5] H1 macro gate BLOCKED ${setup.direction}`);
        state.setSetupScalp({ active: false });
        sig.action = `${setup.direction}_SKIP_H1_MACRO`; return;
      }

      const m15StrengthOk = m15TrendStrengthGate(trend);
      sig.reasons.m15StrengthOk = m15StrengthOk;
      if (!m15StrengthOk) {
        log.info(`[M5] M15 strength/slope gate BLOCKED`);
        state.setSetupScalp({ active: false });
        sig.action = `${setup.direction}_SKIP_M15_STRENGTH`; return;
      }

      const bosOk = triggerBOS('M5', setup, cfg.BOS_LOOKBACK_SCALP, spread);
      sig.reasons.bosTriggered = bosOk;
      // Default: setup active but BOS not yet triggered → watching
      sig.action = setup.direction === 'BUY' ? 'BUY_WATCHING' : 'SELL_WATCHING';

      if (bosOk) {
        // BOS fired — upgrade to CANDIDATE and notify Telegram
        sig.action = setup.direction === 'BUY' ? 'BUY_CANDIDATE' : 'SELL_CANDIDATE';
        telegram.notifySetupCandidate({
          direction:       setup.direction,
          epic:            cfg.EPIC,
          trend,
          spread,
          spreadOk,
          pullbackExtreme: setup.pullbackExtreme ?? null,
          bosTriggered:    true,
          features:        sig.features,
        });

        // Set candidate features immediately on BOS trigger so that the
        // challenger fallback notification fires even if a post-BOS gate blocks.
        const candEntry = setup.direction === 'BUY' ? ask : bid;
        const { sl: candSL, tp1: candTP1, tp2: candTP2 } = computeSLTP('M5', 'SCALP', setup, candEntry);
        sig.features.candidate_direction = setup.direction;
        sig.features.candidate_entry     = candEntry;
        sig.features.candidate_sl        = candSL;
        sig.features.candidate_tp1       = candTP1;
        sig.features.candidate_tp2       = candTP2;
        sig.features.candidate_spread    = spread;

        // M5 execution quality gates (BOS-trigger-specific)
        const rsiOk = rsiGateM5(setup.direction);
        sig.reasons.rsiOk = rsiOk;
        if (!rsiOk) {
          log.info(`[M5] RSI gate BLOCKED ${setup.direction}`);
          state.setSetupScalp({ active: false });
          sig.action = `${setup.direction}_SKIP_RSI`; return;
        }

        const atrRatioOk = atrRatioGateM5();
        sig.reasons.atrRatioOk = atrRatioOk;
        if (!atrRatioOk) {
          log.info(`[M5] ATR ratio gate BLOCKED — dead market`);
          state.setSetupScalp({ active: false });
          sig.action = `${setup.direction}_SKIP_ATR_RATIO`; return;
        }

        const bodyOk = bosBodyGateM5(m5_atr);
        sig.reasons.bodyOk = bodyOk;
        if (!bodyOk) {
          log.info(`[M5] BOS candle body gate BLOCKED ${setup.direction}`);
          state.setSetupScalp({ active: false });
          sig.action = `${setup.direction}_SKIP_BODY`; return;
        }

        const m1ok = microConfirmM1(setup.direction);
        sig.reasons.microConfirmOk = m1ok;
        if (!m1ok) {
          log.info(`[M5] M1 micro-confirm FAIL for ${setup.direction} — entry blocked`);
          state.setSetupScalp({ active: false });
          sig.action = `${setup.direction}_SKIP_M1`; return;
        }

        // ML confidence gate (no-op when no model is loaded)
        const ml = mlModel.score(sig.features);
        if (ml) {
          sig.modelScore   = ml.score;
          sig.modelVersion = ml.version;
          sig.reasons.mlScore = ml.score;

          const mlBlocked =
            (setup.direction === 'BUY'  && ml.score < cfg.ML_BUY_THRESHOLD) ||
            (setup.direction === 'SELL' && ml.score > cfg.ML_SELL_THRESHOLD);

          // Notify Telegram with every ML decision (pass or block)
          telegram.notifyPrediction({
            direction: setup.direction,
            epic:      cfg.EPIC,
            score:     ml.score,
            version:   ml.version,
            mlBlocked,
            candEntry: candEntry,
            candSL:    candSL,
            candTP1:   candTP1,
            candTP2:   candTP2,
            sigTs:     sig.ts,
            signal:    { features: sig.features, reasons: sig.reasons, action: sig.action },
          }).catch(() => {});

          if (mlBlocked) {
            log.info(
              `[M5] ML gate BLOCKED ${setup.direction}: score=${ml.score.toFixed(3)} ` +
              `(need ${setup.direction === 'BUY' ? '>=' + cfg.ML_BUY_THRESHOLD : '<=' + cfg.ML_SELL_THRESHOLD})`
            );
            state.setSetupScalp({ active: false });
            sig.action = `${setup.direction}_SKIP_ML`; return;
          }
          log.debug(`[M5] ML gate PASS ${setup.direction}: score=${ml.score.toFixed(3)} v=${ml.version}`);
        }

        sig.action = `${setup.direction}_EXEC`;
        await placeOrder('SCALP', setup, bid, ask);
        state.setSetupScalp({ active: false });
      }
    } else {
      state.setSetupScalp(createSetup('M5', trend));
      sig.action = 'SETUP_FORMING';
    }

  } finally {
    // Persist signal row and log predictions (champion + challenger shadow)
    const signalId = await signalsRepo.insertSignal(sig).catch(() => null);

    if (signalId) {
      // Champion prediction (only when the ML gate was actually evaluated)
      if (sig.modelScore !== null && sig.modelVersion) {
        predictionsRepo.insertPrediction({
          signalId,
          modelId: sig.modelVersion,
          pWin:    sig.modelScore,
          acted:   sig.action.endsWith('_EXEC'),
          shadow:  false,
          ts:      sig.ts,
        }).catch(() => {});
      }

      // Challenger shadow score (logged every bar — never blocks trades)
      const shadow = mlModel.scoreChallenger(sig.features);
      if (shadow) {
        predictionsRepo.insertPrediction({
          signalId,
          modelId: shadow.version,
          pWin:    shadow.score,
          acted:   false,
          shadow:  true,
          ts:      sig.ts,
        }).catch(() => {});

        // No champion model loaded, but challenger scored a BOS candidate:
        // notify Telegram so the user still sees every ML prediction.
        if (sig.modelScore === null && sig.features.candidate_direction) {
          telegram.notifyPrediction({
            direction: sig.features.candidate_direction,
            epic:      cfg.EPIC,
            score:     shadow.score,
            version:   shadow.version + ' (challenger)',
            mlBlocked: false,   // challenger never blocks trades
            candEntry: sig.features.candidate_entry ?? null,
            candSL:    sig.features.candidate_sl    ?? null,
            candTP1:   sig.features.candidate_tp1   ?? null,
            candTP2:   sig.features.candidate_tp2   ?? null,
            sigTs:     sig.ts,
            signal:    { features: sig.features, reasons: sig.reasons, action: sig.action },
          }).catch(() => {});
        }
      }
    }
  }
}

/**
 * Called on every H1 candle close — runs the SWING branch.
 */
async function onH1Close() {
  if (!cfg.swingEnabled) return;
  if (!state.riskOK()) return;

  let bid, ask, tradeable;
  try { ({ bid, ask, tradeable } = await fetchMarket()); }
  catch (e) { log.error(`[H1] getPrice failed: ${e.message}`); return; }

  if (!tradeable) return;

  // Pre-compute all gates so we can log a single summary line
  const spread   = ask - bid;
  const spreadOk = spread <= cfg.SPREAD_MAX;
  const trend    = trendFilterH4();
  const isChop   = chopFilter('H1');
  const setup    = state.getSetupSwing();

  log.info(
    `[H1] spread=${spreadOk ? 'OK' : 'WIDE'}(${spread.toFixed(3)}) ` +
    `trend=${trend} chop=${isChop} ` +
    `setup=${setup.active ? setup.direction : 'none'}`
  );

  if (!spreadOk) {
    log.warn(`[Strategy] Spread too wide: ${spread.toFixed(4)} (max ${cfg.SPREAD_MAX})`);
    return;
  }

  if (trend === 'NONE') {
    state.setSetupSwing({ active: false });
    return;
  }

  if (isChop) {
    state.setSetupSwing({ active: false });
    return;
  }

  if (setup.active) {
    // Fix #4: cancel setup if the trend has flipped since setup was created
    const expectedTrend = setup.direction === 'BUY' ? 'UP' : 'DOWN';
    if (trend !== expectedTrend) {
      log.info(`[H1] Trend changed to ${trend} — invalidating ${setup.direction} swing setup`);
      state.setSetupSwing({ active: false });
      return;
    }

    if (setupExpired('H1', setup, cfg.SETUP_EXPIRY_BARS_SWING)) {
      log.info('[H1] Swing setup expired — resetting');
      state.setSetupSwing({ active: false });
      return;
    }

    updateSetupExtreme('H1', setup);

    // Pass spread so BOS margin check uses live spread (Fix #7)
    if (triggerBOS('H1', setup, cfg.BOS_LOOKBACK_SWING, ask - bid)) {
      await placeOrder('SWING', setup, bid, ask);
      state.setSetupSwing({ active: false });
    }
  } else {
    state.setSetupSwing(createSetup('H1', trend));
  }
}

// ══════════════════════════════════════════════════════════════
// M1 micro-confirmation
// ══════════════════════════════════════════════════════════════

/**
 * M1 EMA micro-confirmation gate applied just before a SCALP entry.
 *
 * BUY:  EMA20(M1) > EMA50(M1)  AND  close(M1) > EMA20(M1)
 * SELL: EMA20(M1) < EMA50(M1)  AND  close(M1) < EMA20(M1)
 *
 * Returns true if the gate passes (or if MICRO_CONFIRM_ENABLED is false).
 * Returns false (blocking entry) if the M1 structure disagrees.
 */
function microConfirmM1(direction) {
  if (!cfg.MICRO_CONFIRM_ENABLED) return true;

  const candles = cs.get('M1');
  if (candles.length < cfg.MICRO_EMA_SLOW_PERIOD) {
    log.debug(`[M1] Insufficient bars for micro-confirm (${candles.length}/${cfg.MICRO_EMA_SLOW_PERIOD}) — blocking`);
    return false;
  }

  const ema20 = ind.ema(closes(candles), cfg.MICRO_EMA_FAST_PERIOD);
  const ema50 = ind.ema(closes(candles), cfg.MICRO_EMA_SLOW_PERIOD);
  if (ema20 === null || ema50 === null) return false;

  const close = last(candles).close;

  if (direction === 'BUY') {
    const ok = ema20 > ema50 && close > ema20;
    log.debug(
      `[M1] Micro-confirm BUY: ema20=${ema20.toFixed(4)} ema50=${ema50.toFixed(4)} ` +
      `close=${close.toFixed(4)} → ${ok ? 'PASS' : 'FAIL'}`
    );
    return ok;
  } else {
    const ok = ema20 < ema50 && close < ema20;
    log.debug(
      `[M1] Micro-confirm SELL: ema20=${ema20.toFixed(4)} ema50=${ema50.toFixed(4)} ` +
      `close=${close.toFixed(4)} → ${ok ? 'PASS' : 'FAIL'}`
    );
    return ok;
  }
}

module.exports = {
  onM5Close,
  onH1Close,
  managePositions,
  reconcilePositions,
  syncExistingPositions,
};
