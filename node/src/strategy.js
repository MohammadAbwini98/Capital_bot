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

const cfg      = require('./config');
const log      = require('./logger');
const ind      = require('./indicators');
const cs       = require('./candleStore');
const state    = require('./state');
const api      = require('./api');
const telegram = require('./telegram');

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

// ── PnL helper: prefer broker-reported profit, fall back to math ──

function resolvePnl(confirmed, direction, entry, exitPrice, size) {
  if (confirmed && typeof confirmed.profit === 'number') {
    return confirmed.profit;
  }
  return direction === 'BUY'
    ? (exitPrice - entry) * size
    : (entry - exitPrice) * size;
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

  const bar = last(candles);
  const tol = cfg.PULLBACK_ATR_TOL * atrVal;

  if (trend === 'UP') {
    // EMA alignment: EMA20 must be above EMA50 to confirm uptrend structure
    if (ema20 <= ema50) {
      log.debug(`[Setup] ${tf}: BUY EMA alignment fail — ema20=${ema20.toFixed(4)} ≤ ema50=${ema50.toFixed(4)}`);
      return { active: false };
    }
    // Proximity to EMA50
    const dist = Math.abs(bar.low - ema50);
    if (dist > tol) {
      log.debug(`[Setup] ${tf}: BUY not formed — low=${bar.low.toFixed(4)} too far from ema50=${ema50.toFixed(4)} (dist=${dist.toFixed(4)} tol=${tol.toFixed(4)})`);
      return { active: false };
    }
    // Rejection candle: must close bullish (price rejected the EMA50 and closed back up)
    if (bar.close <= bar.open) {
      log.debug(`[Setup] ${tf}: BUY no rejection candle — bar bearish (close=${bar.close.toFixed(4)} open=${bar.open.toFixed(4)})`);
      return { active: false };
    }
    log.info(`[Setup] BUY setup on ${tf}: low=${bar.low.toFixed(4)} ema50=${ema50.toFixed(4)} dist=${dist.toFixed(4)} tol=${tol.toFixed(4)}`);
    return { active: true, direction: 'BUY', createdTime: bar.time, pullbackExtreme: bar.low };
  }

  if (trend === 'DOWN') {
    // EMA alignment: EMA20 must be below EMA50 to confirm downtrend structure
    if (ema20 >= ema50) {
      log.debug(`[Setup] ${tf}: SELL EMA alignment fail — ema20=${ema20.toFixed(4)} ≥ ema50=${ema50.toFixed(4)}`);
      return { active: false };
    }
    // Proximity to EMA50
    const dist = Math.abs(bar.high - ema50);
    if (dist > tol) {
      log.debug(`[Setup] ${tf}: SELL not formed — high=${bar.high.toFixed(4)} too far from ema50=${ema50.toFixed(4)} (dist=${dist.toFixed(4)} tol=${tol.toFixed(4)})`);
      return { active: false };
    }
    // Rejection candle: must close bearish (price rejected the EMA50 and closed back down)
    if (bar.close >= bar.open) {
      log.debug(`[Setup] ${tf}: SELL no rejection candle — bar bullish (close=${bar.close.toFixed(4)} open=${bar.open.toFixed(4)})`);
      return { active: false };
    }
    log.info(`[Setup] SELL setup on ${tf}: high=${bar.high.toFixed(4)} ema50=${ema50.toFixed(4)} dist=${dist.toFixed(4)} tol=${tol.toFixed(4)}`);
    return { active: true, direction: 'SELL', createdTime: bar.time, pullbackExtreme: bar.high };
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
// J) SL/TP computation
// ══════════════════════════════════════════════════════════════

function computeSLTP(tf, setup, entryPrice, tp2R) {
  const candles = cs.get(tf);
  const atrVal  = ind.atr(highs(candles), lows(candles), closes(candles), cfg.ATR_PERIOD);
  const buffer  = cfg.SL_BUFFER_ATR * atrVal;

  let sl, tp1, tp2;

  if (setup.direction === 'BUY') {
    sl  = setup.pullbackExtreme - buffer;
    const R = entryPrice - sl;
    tp1 = entryPrice + cfg.TP1_R * R;
    tp2 = entryPrice + tp2R      * R;
  } else {
    sl  = setup.pullbackExtreme + buffer;
    const R = sl - entryPrice;
    tp1 = entryPrice - cfg.TP1_R * R;
    tp2 = entryPrice - tp2R      * R;
  }

  log.debug(
    `[SLTP] ${tf} ${setup.direction}: extreme=${setup.pullbackExtreme.toFixed(4)} ` +
    `buf=${buffer.toFixed(4)} atr=${atrVal.toFixed(4)} | ` +
    `R=${Math.abs(entryPrice - sl).toFixed(4)} sl=${sl.toFixed(4)} tp1=${tp1.toFixed(4)} tp2=${tp2.toFixed(4)}`
  );

  return { sl, tp1, tp2 };
}

// ══════════════════════════════════════════════════════════════
// K) Order placement
// ══════════════════════════════════════════════════════════════

async function placeOrder(mode, setup, bid, ask) {
  const tf    = mode === 'SCALP' ? 'M5' : 'H1';
  const tp2R  = mode === 'SCALP' ? cfg.TP2_R_SCALP : cfg.TP2_R_SWING;
  const size  = mode === 'SCALP' ? cfg.SCALP_SIZE_UNITS : cfg.SWING_SIZE_UNITS;
  const entry = setup.direction === 'BUY' ? ask : bid;

  const { sl, tp1, tp2 } = computeSLTP(tf, setup, entry, tp2R);

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
    openedTime:   Date.now(),
  });

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
      const pnl = resolvePnl(confirmed, pos.direction, pos.entry, exitPrice, pos.size);
      state.updatePnL(pnl, pnl < 0);
      state.removePosition(pos.dealId);
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
          const pnl1 = resolvePnl(confirmed, pos.direction, pos.entry, exitPrice, closeSize);
          // Fix #3: partial close at TP1 is rarely a loss, but use actual sign
          state.updatePnL(pnl1, pnl1 < 0);
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
            state.replacePosition(pos.dealId, {
              ...pos,
              dealId:        newDealId,
              dealReference: newRef,
              size:          remainingSize,
              entry:         exitPrice,
              sl:            newSL,
              tp1Done:       true,
            });
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
      const pnl = resolvePnl(confirmed, pos.direction, pos.entry, exitPrice, pos.size);
      state.updatePnL(pnl, pnl < 0);
      state.removePosition(pos.dealId);
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
 */
async function onM5Close() {
  if (!state.riskOK()) return;

  let bid, ask, tradeable;
  try { ({ bid, ask, tradeable } = await fetchMarket()); }
  catch (e) { log.error(`[M5] getPrice failed: ${e.message}`); return; }

  if (!tradeable) return;

  // Pre-compute all gates so we can log a single summary line
  const spread   = ask - bid;
  const spreadOk = spread <= cfg.SPREAD_MAX;
  const trend    = trendFilterM15();
  const isChop   = chopFilter('M5');
  const setup    = state.getSetupScalp();

  log.info(
    `[M5] spread=${spreadOk ? 'OK' : 'WIDE'}(${spread.toFixed(3)}) ` +
    `trend=${trend} chop=${isChop} ` +
    `setup=${setup.active ? setup.direction : 'none'}`
  );

  if (!spreadOk) {
    log.warn(`[Strategy] Spread too wide: ${spread.toFixed(4)} (max ${cfg.SPREAD_MAX})`);
    return;
  }

  if (trend === 'NONE') {
    state.setSetupScalp({ active: false });
    return;
  }

  if (isChop) {
    state.setSetupScalp({ active: false });
    return;
  }

  if (setup.active) {
    // Fix #4: cancel setup if the trend has flipped since setup was created
    const expectedTrend = setup.direction === 'BUY' ? 'UP' : 'DOWN';
    if (trend !== expectedTrend) {
      log.info(`[M5] Trend changed to ${trend} — invalidating ${setup.direction} scalp setup`);
      state.setSetupScalp({ active: false });
      return;
    }

    if (setupExpired('M5', setup, cfg.SETUP_EXPIRY_BARS_SCALP)) {
      log.info('[M5] Setup expired — resetting');
      state.setSetupScalp({ active: false });
      return;
    }

    updateSetupExtreme('M5', setup);

    // Pass spread so BOS margin check uses live spread (Fix #7)
    if (triggerBOS('M5', setup, cfg.BOS_LOOKBACK_SCALP, ask - bid)) {
      // M1 micro-confirmation: require M1 EMA structure to agree with direction
      if (!microConfirmM1(setup.direction)) {
        log.info(`[M5] M1 micro-confirm FAIL for ${setup.direction} — entry blocked`);
        state.setSetupScalp({ active: false });
        return;
      }
      await placeOrder('SCALP', setup, bid, ask);
      state.setSetupScalp({ active: false });
    }
  } else {
    state.setSetupScalp(createSetup('M5', trend));
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
