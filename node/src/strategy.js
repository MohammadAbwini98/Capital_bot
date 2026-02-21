// ==============================================================
// GoldBot — strategy.js
// Full implementation of the XAUUSD Trend-Following Pullback
// + BOS strategy as defined in the algorithm spec.
//
// Entry points called by index.js polling loops:
//   onM5Close()        — run on every M5 candle close (scalp)
//   onH1Close()        — run on every H1 candle close (swing)
//   managePositions()  — run on every tick cycle
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
// F) Spread filter
// ══════════════════════════════════════════════════════════════

function spreadOK(bid, ask) {
  const spread = ask - bid;
  if (spread > cfg.SPREAD_MAX) {
    log.warn(`[Strategy] Spread too wide: ${spread.toFixed(4)} (max ${cfg.SPREAD_MAX})`);
    return false;
  }
  log.debug(`[Strategy] Spread OK: ${spread.toFixed(4)} (max ${cfg.SPREAD_MAX})`);
  return true;
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
 */
function createSetup(tf, trend) {
  const candles = cs.get(tf);
  if (candles.length < cfg.EMA_PULLBACK_PERIOD) return { active: false };

  const ema50  = ind.ema(closes(candles), cfg.EMA_PULLBACK_PERIOD);
  const atrVal = ind.atr(highs(candles), lows(candles), closes(candles), cfg.ATR_PERIOD);
  if (ema50 === null || atrVal === null) return { active: false };

  const bar = last(candles);
  const tol = cfg.PULLBACK_ATR_TOL * atrVal;

  if (trend === 'UP') {
    const dist = Math.abs(bar.low - ema50);
    if (dist <= tol) {
      log.info(`[Setup] BUY setup on ${tf}: low=${bar.low.toFixed(4)} ema50=${ema50.toFixed(4)} dist=${dist.toFixed(4)} tol=${tol.toFixed(4)}`);
      return { active: true, direction: 'BUY', createdTime: bar.time, pullbackExtreme: bar.low };
    }
    log.debug(`[Setup] ${tf}: BUY setup not formed — low=${bar.low.toFixed(4)} too far from ema50=${ema50.toFixed(4)} (dist=${dist.toFixed(4)} tol=${tol.toFixed(4)})`);
  }

  if (trend === 'DOWN') {
    const dist = Math.abs(bar.high - ema50);
    if (dist <= tol) {
      log.info(`[Setup] SELL setup on ${tf}: high=${bar.high.toFixed(4)} ema50=${ema50.toFixed(4)} dist=${dist.toFixed(4)} tol=${tol.toFixed(4)}`);
      return { active: true, direction: 'SELL', createdTime: bar.time, pullbackExtreme: bar.high };
    }
    log.debug(`[Setup] ${tf}: SELL setup not formed — high=${bar.high.toFixed(4)} too far from ema50=${ema50.toFixed(4)} (dist=${dist.toFixed(4)} tol=${tol.toFixed(4)})`);
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
 */
function triggerBOS(tf, setup, bosLookback) {
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

  if (setup.direction === 'BUY') {
    const level     = ind.highestHigh(highs(prevCandles), bosLookback);
    const triggered = bar.close > level;
    if (triggered) {
      log.info(`[BOS] BUY triggered on ${tf}: close=${bar.close.toFixed(4)} > HH=${level.toFixed(4)}`);
    } else {
      log.debug(`[BOS] ${tf}: BUY not triggered — close=${bar.close.toFixed(4)} vs HH=${level.toFixed(4)} (need +${(level - bar.close).toFixed(4)} more)`);
    }
    return triggered;
  } else {
    const level     = ind.lowestLow(lows(prevCandles), bosLookback);
    const triggered = bar.close < level;
    if (triggered) {
      log.info(`[BOS] SELL triggered on ${tf}: close=${bar.close.toFixed(4)} < LL=${level.toFixed(4)}`);
    } else {
      log.debug(`[BOS] ${tf}: SELL not triggered — close=${bar.close.toFixed(4)} vs LL=${level.toFixed(4)} (need -${(bar.close - level).toFixed(4)} more)`);
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
      try { await api.closePosition(pos.dealId); } catch (e) {
        log.warn(`[Manage] Close failed (may already be closed by platform): ${e.message}`);
      }
      const pnl = pos.direction === 'BUY'
        ? (exitPrice - pos.entry) * pos.size
        : (pos.entry - exitPrice) * pos.size;
      state.updatePnL(pnl, true);
      state.removePosition(pos.dealId);
      telegram.notifyTradeClosed({
        event: 'SL_HIT', direction: pos.direction, epic: cfg.EPIC,
        mode: pos.mode, entry: pos.entry, exitPrice, pnl, dealId: pos.dealId,
      }).catch(() => {});
      continue;
    }

    // ── TP1 hit (50% partial close) ────────────────────────
    if (!pos.tp1Done) {
      const tp1Hit =
        (pos.direction === 'BUY'  && exitPrice >= pos.tp1) ||
        (pos.direction === 'SELL' && exitPrice <= pos.tp1);

      if (tp1Hit) {
        log.trade(`[Manage] TP1 hit — ${pos.direction} dealId=${pos.dealId} exit=${exitPrice.toFixed(4)}`);

        try {
          await api.closePosition(pos.dealId);

          const halfSize      = Math.max(1, Math.floor(pos.size * cfg.PARTIAL_CLOSE_TP1));
          const remainingSize = pos.size - halfSize;

          const pnl1 = pos.direction === 'BUY'
            ? (exitPrice - pos.entry) * halfSize
            : (pos.entry - exitPrice) * halfSize;
          state.updatePnL(pnl1, false);
          telegram.notifyTradeClosed({
            event: 'TP1_HIT', direction: pos.direction, epic: cfg.EPIC,
            mode: pos.mode, entry: pos.entry, exitPrice, pnl: pnl1, dealId: pos.dealId,
          }).catch(() => {});

          if (remainingSize >= 1) {
            const newSL = cfg.MOVE_SL_TO_BREAKEVEN_ON_TP1 ? pos.entry : pos.sl;
            log.debug(`[Manage] Reopening ${remainingSize} unit(s) at breakeven SL=${newSL.toFixed(4)}`);
            const { dealId: newDealId, dealReference: newRef } = await api.createPosition({
              epic:        cfg.EPIC,
              direction:   pos.direction,
              size:        remainingSize,
              stopLevel:   newSL,
              profitLevel: pos.tp2,
            });
            state.replacePosition(pos.dealId, {
              ...pos,
              dealId:       newDealId,
              dealReference: newRef,
              size:         remainingSize,
              entry:        exitPrice,
              sl:           newSL,
              tp1Done:      true,
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
      try { await api.closePosition(pos.dealId); } catch (e) {
        log.warn(`[Manage] TP2 close failed (may already be closed by platform): ${e.message}`);
      }
      const pnl = pos.direction === 'BUY'
        ? (exitPrice - pos.entry) * pos.size
        : (pos.entry - exitPrice) * pos.size;
      state.updatePnL(pnl, false);
      state.removePosition(pos.dealId);
      telegram.notifyTradeClosed({
        event: 'TP2_HIT', direction: pos.direction, epic: cfg.EPIC,
        mode: pos.mode, entry: pos.entry, exitPrice, pnl, dealId: pos.dealId,
      }).catch(() => {});
    }
  }
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

  log.debug(`[M5] Market: bid=${bid.toFixed(4)} ask=${ask.toFixed(4)} spread=${(ask - bid).toFixed(4)}`);

  if (!spreadOK(bid, ask)) return;

  const trend = trendFilterM15();
  if (trend === 'NONE') {
    log.debug('[M5] No M15 trend — resetting scalp setup');
    state.setSetupScalp({ active: false });
    return;
  }

  if (chopFilter('M5')) {
    log.debug('[M5] Chop detected — skipping');
    state.setSetupScalp({ active: false });
    return;
  }

  const setup = state.getSetupScalp();

  if (setup.active) {
    if (setupExpired('M5', setup, cfg.SETUP_EXPIRY_BARS_SCALP)) {
      log.info('[M5] Setup expired — resetting');
      state.setSetupScalp({ active: false });
      return;
    }

    updateSetupExtreme('M5', setup);

    if (triggerBOS('M5', setup, cfg.BOS_LOOKBACK_SCALP)) {
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

  log.debug(`[H1] Market: bid=${bid.toFixed(4)} ask=${ask.toFixed(4)} spread=${(ask - bid).toFixed(4)}`);

  if (!spreadOK(bid, ask)) return;

  const trend = trendFilterH4();
  if (trend === 'NONE') {
    log.debug('[H1] No H4 trend — resetting swing setup');
    state.setSetupSwing({ active: false });
    return;
  }

  if (chopFilter('H1')) {
    log.debug('[H1] Chop detected — skipping');
    state.setSetupSwing({ active: false });
    return;
  }

  const setup = state.getSetupSwing();

  if (setup.active) {
    if (setupExpired('H1', setup, cfg.SETUP_EXPIRY_BARS_SWING)) {
      log.info('[H1] Swing setup expired — resetting');
      state.setSetupSwing({ active: false });
      return;
    }

    updateSetupExtreme('H1', setup);

    if (triggerBOS('H1', setup, cfg.BOS_LOOKBACK_SWING)) {
      await placeOrder('SWING', setup, bid, ask);
      state.setSetupSwing({ active: false });
    }
  } else {
    state.setSetupSwing(createSetup('H1', trend));
  }
}

module.exports = { onM5Close, onH1Close, managePositions };
