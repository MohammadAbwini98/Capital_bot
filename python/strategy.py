# ==============================================================
# GoldBot — strategy.py
# Full implementation of the XAUUSD Trend-Following Pullback
# + BOS strategy as defined in the algorithm spec.
#
# Entry points called by main.py polling loops:
#   on_m5_close()        — run on every M5 candle close (scalp)
#   on_h1_close()        — run on every H1 candle close (swing)
#   manage_positions()   — run on every tick cycle
# ==============================================================

from __future__ import annotations
import time

import api
import config as cfg
import candle_store as cs
import indicators as ind
import state
from state import Position, Setup
import logger as log


# ── Array helpers ──────────────────────────────────────────

def _closes(candles: list[dict]) -> list[float]: return [c["close"] for c in candles]
def _highs(candles:  list[dict]) -> list[float]: return [c["high"]  for c in candles]
def _lows(candles:   list[dict]) -> list[float]: return [c["low"]   for c in candles]
def _last(candles:   list[dict]) -> dict:        return candles[-1]


# ══════════════════════════════════════════════════════════
# Spread filter
# ══════════════════════════════════════════════════════════

def _spread_ok(bid: float, ask: float) -> bool:
    spread = ask - bid
    if spread > cfg.SPREAD_MAX:
        log.warn(f"[Strategy] Spread too wide: {spread:.4f} (max {cfg.SPREAD_MAX})")
        return False
    return True


# ══════════════════════════════════════════════════════════
# F) Trend filters
# ══════════════════════════════════════════════════════════

def _trend_filter_m15() -> str:
    candles = cs.get("M15")
    if len(candles) < cfg.EMA_TREND_PERIOD:
        return "NONE"
    ema200 = ind.ema(_closes(candles), cfg.EMA_TREND_PERIOD)
    if ema200 is None:
        return "NONE"
    close = _last(candles)["close"]
    if close > ema200: return "UP"
    if close < ema200: return "DOWN"
    return "NONE"


def _trend_filter_h4() -> str:
    candles = cs.get("H4")
    if len(candles) < cfg.EMA_TREND_PERIOD:
        return "NONE"
    ema200 = ind.ema(_closes(candles), cfg.EMA_TREND_PERIOD)
    if ema200 is None:
        return "NONE"
    close = _last(candles)["close"]
    if close > ema200: return "UP"
    if close < ema200: return "DOWN"
    return "NONE"


# ══════════════════════════════════════════════════════════
# G) Chop filter
# ══════════════════════════════════════════════════════════

def _chop_filter(tf: str) -> bool:
    candles = cs.get(tf)
    if len(candles) < cfg.EMA_PULLBACK_PERIOD:
        return True   # insufficient data → skip

    ema20  = ind.ema(_closes(candles), cfg.EMA_FAST_PERIOD)
    ema50  = ind.ema(_closes(candles), cfg.EMA_PULLBACK_PERIOD)
    atr_v  = ind.atr(_highs(candles), _lows(candles), _closes(candles), cfg.ATR_PERIOD)

    if ema20 is None or ema50 is None or atr_v is None:
        return True

    dist     = abs(ema20 - ema50)
    min_dist = cfg.CHOP_EMA_DIST_ATR_MIN * atr_v
    is_chop  = dist < min_dist

    if is_chop:
        log.debug(f"[Chop] {tf}: EMA dist={dist:.4f} < min={min_dist:.4f} → chop")
    return is_chop


# ══════════════════════════════════════════════════════════
# H) Setup detection
# ══════════════════════════════════════════════════════════

def _create_setup(tf: str, trend: str) -> Setup:
    candles = cs.get(tf)
    if len(candles) < cfg.EMA_PULLBACK_PERIOD:
        return Setup()

    ema50 = ind.ema(_closes(candles), cfg.EMA_PULLBACK_PERIOD)
    atr_v = ind.atr(_highs(candles), _lows(candles), _closes(candles), cfg.ATR_PERIOD)
    if ema50 is None or atr_v is None:
        return Setup()

    bar = _last(candles)
    tol = cfg.PULLBACK_ATR_TOL * atr_v

    if trend == "UP" and abs(bar["low"] - ema50) <= tol:
        log.info(f"[Setup] BUY setup on {tf}: low={bar['low']:.4f} ema50={ema50:.4f} tol={tol:.4f}")
        return Setup(active=True, direction="BUY", created_time=bar["time"], pullback_extreme=bar["low"])

    if trend == "DOWN" and abs(bar["high"] - ema50) <= tol:
        log.info(f"[Setup] SELL setup on {tf}: high={bar['high']:.4f} ema50={ema50:.4f} tol={tol:.4f}")
        return Setup(active=True, direction="SELL", created_time=bar["time"], pullback_extreme=bar["high"])

    return Setup()


def _update_setup_extreme(tf: str, setup: Setup) -> None:
    bar = _last(cs.get(tf))
    if setup.direction == "BUY":
        setup.pullback_extreme = min(setup.pullback_extreme, bar["low"])
    else:
        setup.pullback_extreme = max(setup.pullback_extreme, bar["high"])


def _setup_expired(tf: str, setup: Setup, expiry_bars: int) -> bool:
    candles   = cs.get(tf)
    bars_since = sum(1 for c in candles if c["time"] > setup.created_time)
    return bars_since > expiry_bars


# ══════════════════════════════════════════════════════════
# I) BOS trigger
# ══════════════════════════════════════════════════════════

def _trigger_bos(tf: str, setup: Setup, bos_lookback: int) -> bool:
    candles = cs.get(tf)
    if len(candles) < bos_lookback + 1:
        return False

    atr_v = ind.atr(_highs(candles), _lows(candles), _closes(candles), cfg.ATR_PERIOD)
    if atr_v is None:
        return False

    bar   = _last(candles)
    rng   = bar["high"] - bar["low"]
    if rng > cfg.BIG_CANDLE_ATR_MAX * atr_v:
        log.debug(f"[BOS] Big candle on {tf}: range={rng:.4f} > max={(cfg.BIG_CANDLE_ATR_MAX * atr_v):.4f}")
        return False

    # BOS level is from all candles BEFORE the trigger bar
    prev = candles[:-1]
    if len(prev) < bos_lookback:
        return False

    if setup.direction == "BUY":
        level     = ind.highest_high(_highs(prev), bos_lookback)
        triggered = bar["close"] > level
        if triggered:
            log.info(f"[BOS] BUY triggered on {tf}: close={bar['close']:.4f} > HH={level:.4f}")
        return triggered
    else:
        level     = ind.lowest_low(_lows(prev), bos_lookback)
        triggered = bar["close"] < level
        if triggered:
            log.info(f"[BOS] SELL triggered on {tf}: close={bar['close']:.4f} < LL={level:.4f}")
        return triggered


# ══════════════════════════════════════════════════════════
# J) SL/TP computation
# ══════════════════════════════════════════════════════════

def _compute_sltp(tf: str, setup: Setup, entry: float, tp2_r: float) -> tuple[float, float, float]:
    candles = cs.get(tf)
    atr_v   = ind.atr(_highs(candles), _lows(candles), _closes(candles), cfg.ATR_PERIOD)
    buffer  = cfg.SL_BUFFER_ATR * atr_v  # type: ignore[operator]

    if setup.direction == "BUY":
        sl  = setup.pullback_extreme - buffer
        R   = entry - sl
        tp1 = entry + cfg.TP1_R * R
        tp2 = entry + tp2_r     * R
    else:
        sl  = setup.pullback_extreme + buffer
        R   = sl - entry
        tp1 = entry - cfg.TP1_R * R
        tp2 = entry - tp2_r     * R

    return sl, tp1, tp2


# ══════════════════════════════════════════════════════════
# K) Order placement
# ══════════════════════════════════════════════════════════

def _place_order(mode: str, setup: Setup, bid: float, ask: float) -> None:
    tf     = "M5" if mode == "SCALP" else "H1"
    tp2_r  = cfg.TP2_R_SCALP if mode == "SCALP" else cfg.TP2_R_SWING
    size   = cfg.SCALP_SIZE_UNITS if mode == "SCALP" else cfg.SWING_SIZE_UNITS
    entry  = ask if setup.direction == "BUY" else bid

    sl, tp1, tp2 = _compute_sltp(tf, setup, entry, tp2_r)

    log.trade(
        f"[Order] {mode} {setup.direction} | size={size} | entry={entry:.4f} "
        f"| SL={sl:.4f} TP1={tp1:.4f} TP2={tp2:.4f}"
    )

    result = api.create_position(
        epic=cfg.EPIC,
        direction=setup.direction,
        size=size,
        stop_level=sl,
        profit_level=tp2,   # platform manages TP2; we watch TP1
    )

    pos = Position(
        mode=mode, direction=setup.direction,
        size=size, entry=entry,
        sl=sl, tp1=tp1, tp2=tp2, tp1_done=False,
        deal_id=result["deal_id"],
        deal_reference=result["deal_reference"],
        opened_time=int(time.time() * 1000),
    )
    state.add_position(pos)
    log.trade(f"[Order] Placed ✓ deal_id={result['deal_id']} ref={result['deal_reference']}")


# ══════════════════════════════════════════════════════════
# L) Position management
# ══════════════════════════════════════════════════════════

def manage_positions(bid: float, ask: float) -> None:
    positions = state.get_positions()
    if not positions:
        return

    for pos in positions:
        exit_price = bid if pos.direction == "BUY" else ask

        # ── SL hit ─────────────────────────────────────
        sl_hit = (
            (pos.direction == "BUY"  and exit_price <= pos.sl) or
            (pos.direction == "SELL" and exit_price >= pos.sl)
        )
        if sl_hit:
            log.trade(f"[Manage] SL hit — {pos.direction} deal_id={pos.deal_id} exit={exit_price:.4f}")
            try:
                api.close_position(pos.deal_id)
            except Exception as e:
                log.warn(f"[Manage] Close failed (may already be closed): {e}")
            pnl = (exit_price - pos.entry if pos.direction == "BUY" else pos.entry - exit_price) * pos.size
            state.update_pnl(pnl, is_loss=True)
            state.remove_position(pos.deal_id)
            continue

        # ── TP1 hit (50% partial close) ────────────────
        if not pos.tp1_done:
            tp1_hit = (
                (pos.direction == "BUY"  and exit_price >= pos.tp1) or
                (pos.direction == "SELL" and exit_price <= pos.tp1)
            )
            if tp1_hit:
                log.trade(f"[Manage] TP1 hit — {pos.direction} deal_id={pos.deal_id} exit={exit_price:.4f}")
                try:
                    api.close_position(pos.deal_id)
                    half_size      = max(1, int(pos.size * cfg.PARTIAL_CLOSE_TP1))
                    remaining_size = pos.size - half_size

                    pnl1 = (exit_price - pos.entry if pos.direction == "BUY" else pos.entry - exit_price) * half_size
                    state.update_pnl(pnl1, is_loss=False)

                    if remaining_size >= 1:
                        new_sl = pos.entry if cfg.MOVE_SL_TO_BREAKEVEN_ON_TP1 else pos.sl
                        r2 = api.create_position(
                            epic=cfg.EPIC, direction=pos.direction,
                            size=remaining_size,
                            stop_level=new_sl, profit_level=pos.tp2,
                        )
                        new_pos = Position(
                            mode=pos.mode, direction=pos.direction,
                            size=remaining_size, entry=exit_price,
                            sl=new_sl, tp1=pos.tp1, tp2=pos.tp2, tp1_done=True,
                            deal_id=r2["deal_id"],
                            deal_reference=r2["deal_reference"],
                            opened_time=int(time.time() * 1000),
                        )
                        state.replace_position(pos.deal_id, new_pos)
                        log.trade(f"[Manage] Remaining {remaining_size} unit(s) reopened → deal_id={r2['deal_id']}")
                    else:
                        state.remove_position(pos.deal_id)
                except Exception as e:
                    log.error(f"[Manage] TP1 partial close failed: {e}")
                    pos.tp1_done = True
                continue

        # ── TP2 hit ────────────────────────────────────
        tp2_hit = (
            (pos.direction == "BUY"  and exit_price >= pos.tp2) or
            (pos.direction == "SELL" and exit_price <= pos.tp2)
        )
        if tp2_hit:
            log.trade(f"[Manage] TP2 hit — {pos.direction} deal_id={pos.deal_id} exit={exit_price:.4f}")
            try:
                api.close_position(pos.deal_id)
            except Exception as e:
                log.warn(f"[Manage] TP2 close failed (may already be closed): {e}")
            pnl = (exit_price - pos.entry if pos.direction == "BUY" else pos.entry - exit_price) * pos.size
            state.update_pnl(pnl, is_loss=False)
            state.remove_position(pos.deal_id)


# ══════════════════════════════════════════════════════════
# M) Main loop handlers
# ══════════════════════════════════════════════════════════

def on_m5_close() -> None:
    if not state.risk_ok():
        return

    try:
        bid, ask = api.get_price(cfg.EPIC)
    except Exception as e:
        log.error(f"[M5] get_price failed: {e}")
        return

    if not _spread_ok(bid, ask):
        return

    trend = _trend_filter_m15()
    if trend == "NONE":
        log.debug("[M5] No M15 trend — resetting scalp setup")
        state.set_setup_scalp(Setup())
        return

    if _chop_filter("M5"):
        state.set_setup_scalp(Setup())
        return

    setup = state.get_setup_scalp()

    if setup.active:
        if _setup_expired("M5", setup, cfg.SETUP_EXPIRY_BARS_SCALP):
            log.info("[M5] Setup expired — resetting")
            state.set_setup_scalp(Setup())
            return

        _update_setup_extreme("M5", setup)

        if _trigger_bos("M5", setup, cfg.BOS_LOOKBACK_SCALP):
            _place_order("SCALP", setup, bid, ask)
            state.set_setup_scalp(Setup())
    else:
        state.set_setup_scalp(_create_setup("M5", trend))


def on_h1_close() -> None:
    if not cfg.SWING_ENABLED:
        return
    if not state.risk_ok():
        return

    try:
        bid, ask = api.get_price(cfg.EPIC)
    except Exception as e:
        log.error(f"[H1] get_price failed: {e}")
        return

    if not _spread_ok(bid, ask):
        return

    trend = _trend_filter_h4()
    if trend == "NONE":
        log.debug("[H1] No H4 trend — resetting swing setup")
        state.set_setup_swing(Setup())
        return

    if _chop_filter("H1"):
        state.set_setup_swing(Setup())
        return

    setup = state.get_setup_swing()

    if setup.active:
        if _setup_expired("H1", setup, cfg.SETUP_EXPIRY_BARS_SWING):
            log.info("[H1] Swing setup expired — resetting")
            state.set_setup_swing(Setup())
            return

        _update_setup_extreme("H1", setup)

        if _trigger_bos("H1", setup, cfg.BOS_LOOKBACK_SWING):
            _place_order("SWING", setup, bid, ask)
            state.set_setup_swing(Setup())
    else:
        state.set_setup_swing(_create_setup("H1", trend))
