#!/usr/bin/env python3
# ==============================================================
# GoldBot — main.py  (Python entry point)
# Starts the bot: authenticate → load history → polling loops.
# ==============================================================

import signal
import sys
import time
import threading
from datetime import datetime, timezone

import api
import candle_store as cs
import state
import strategy
import config as cfg
import logger as log

_shutting_down = False
_threads: list[threading.Thread] = []


# ══════════════════════════════════════════════════════════
# Poll workers (each runs in its own daemon thread)
# ══════════════════════════════════════════════════════════

def _tick_loop() -> None:
    """Position management — runs every TICK_POLL_S seconds."""
    while not _shutting_down:
        try:
            bid, ask = api.get_price(cfg.EPIC)
            strategy.manage_positions(bid, ask)
        except Exception as e:
            if not _shutting_down:
                log.warn(f"[Tick] Error: {e}")
        time.sleep(cfg.TICK_POLL_S)


def _m5_loop() -> None:
    """Detect M5 candle closes and run scalp logic."""
    while not _shutting_down:
        try:
            new_close = cs.update("M5")
            if new_close:
                log.info("[Poll] M5 candle closed — running scalp logic...")
                strategy.on_m5_close()
        except Exception as e:
            if not _shutting_down:
                log.warn(f"[M5 Poll] Error: {e}")
        time.sleep(cfg.M5_POLL_S)


def _m15_loop() -> None:
    """Keep M15 candle store current for trend filter."""
    while not _shutting_down:
        try:
            cs.update("M15")
        except Exception as e:
            if not _shutting_down:
                log.warn(f"[M15 Poll] Error: {e}")
        time.sleep(cfg.M15_POLL_S)


def _h1_loop() -> None:
    """Detect H1 candle closes and run swing logic (only when SWING_ENABLED)."""
    while not _shutting_down:
        try:
            new_close = cs.update("H1")
            if new_close:
                log.info("[Poll] H1 candle closed — running swing logic...")
                strategy.on_h1_close()
        except Exception as e:
            if not _shutting_down:
                log.warn(f"[H1 Poll] Error: {e}")
        time.sleep(cfg.H1_POLL_S)


def _h4_loop() -> None:
    """Keep H4 candle store current for H4 trend filter."""
    while not _shutting_down:
        try:
            cs.update("H4")
        except Exception as e:
            if not _shutting_down:
                log.warn(f"[H4 Poll] Error: {e}")
        time.sleep(cfg.H4_POLL_S)


def _status_loop() -> None:
    """Print a one-line status every 60 seconds."""
    while not _shutting_down:
        time.sleep(60)
        if _shutting_down:
            break
        s = state.get_stats()
        log.info(
            f"[Status] trades={s['trades_today']}/{cfg.MAX_TRADES_PER_DAY} | "
            f"day_pnl=${s['day_pnl']:.2f} | "
            f"positions={s['open_count']} | "
            f"consec_losses={s['consec_losses']}"
        )


# ══════════════════════════════════════════════════════════
# Daily reset scheduler
# ══════════════════════════════════════════════════════════

def _midnight_reset_loop() -> None:
    """Wait until UTC midnight, reset daily counters, repeat."""
    while not _shutting_down:
        now = datetime.now(timezone.utc)
        next_midnight = datetime(
            now.year, now.month, now.day, 0, 0, 0, tzinfo=timezone.utc
        ).replace(day=now.day + 1) if now.day < 28 else \
            datetime(now.year, now.month, now.day + 1 if now.day < 28 else 1,
                     0, 0, 0, tzinfo=timezone.utc)
        # Simpler: just compute seconds until next midnight
        seconds_until = (next_midnight - now).total_seconds()
        log.info(f"[Main] Daily reset scheduled in {int(seconds_until // 60)} min (UTC midnight).")

        # Sleep in small chunks so we can respect _shutting_down
        slept = 0.0
        while slept < seconds_until and not _shutting_down:
            chunk = min(60.0, seconds_until - slept)
            time.sleep(chunk)
            slept += chunk

        if _shutting_down:
            break

        log.info("[Main] UTC midnight — daily reset...")
        try:
            acct = api.get_account()
            equity = acct["balance"]["available"] if acct else 0.0
        except Exception:
            equity = 0.0
        state.daily_reset(equity)


# ══════════════════════════════════════════════════════════
# Graceful shutdown
# ══════════════════════════════════════════════════════════

def _shutdown(sig_name: str = "SIGNAL") -> None:
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True
    log.warn(f"[Main] Shutting down ({sig_name})...")
    try:
        api.destroy_session()
    except Exception:
        pass
    log.info("[Main] GoldBot stopped. Goodbye!")


def _signal_handler(signum, _frame):
    _shutdown("SIGINT" if signum == signal.SIGINT else "SIGTERM")
    sys.exit(0)


signal.signal(signal.SIGINT,  _signal_handler)
signal.signal(signal.SIGTERM, _signal_handler)


# ══════════════════════════════════════════════════════════
# Main entry point
# ══════════════════════════════════════════════════════════

def main() -> None:
    log.info("══════════════════════════════════════════════════════")
    log.info("       GoldBot — XAUUSD Trend-Following Scalp Bot     ")
    log.info("══════════════════════════════════════════════════════")
    log.info(f"Account type    : {cfg.ACCOUNT_TYPE.upper()}")
    log.info(f"Instrument      : {cfg.EPIC}")
    log.info(f"Swing mode      : {'ON  (H1 + H4)' if cfg.SWING_ENABLED else 'OFF (M5 + M15 only)'}")
    log.info(f"Max trades/day  : {cfg.MAX_TRADES_PER_DAY}")
    log.info(f"Daily loss limit: ${cfg.DAILY_LOSS_LIMIT_USD:.2f}")
    log.info(f"Max consec losses: {cfg.MAX_CONSECUTIVE_LOSSES}")
    log.info("──────────────────────────────────────────────────────")

    # Step 1: authenticate
    log.info("[Main] Authenticating with Capital.com...")
    api.create_session()

    # Step 2: daily reset with current equity
    equity = 0.0
    try:
        acct   = api.get_account()
        equity = acct["balance"]["available"] if acct else 0.0
    except Exception as e:
        log.warn(f"[Main] Could not fetch account balance: {e}")
    state.daily_reset(equity)

    # Step 3: load candle history
    log.info("[Main] Loading candle history...")
    cs.load_history()
    log.info("[Main] Candle history ready.")

    # Step 4: report platform positions
    try:
        platform_pos = api.get_positions()
        if platform_pos:
            log.warn(
                f"[Main] {len(platform_pos)} position(s) already open on platform — "
                "these are NOT tracked by the bot (managed by their own SL/TP)."
            )
    except Exception as e:
        log.warn(f"[Main] Could not check platform positions: {e}")

    # Step 5: start polling threads
    log.info("[Main] Starting polling threads...")

    loop_defs = [
        ("tick",    _tick_loop),
        ("m5",      _m5_loop),
        ("m15",     _m15_loop),
        ("status",  _status_loop),
        ("daily",   _midnight_reset_loop),
    ]
    if cfg.SWING_ENABLED:
        loop_defs += [("h1", _h1_loop), ("h4", _h4_loop)]

    for name, target in loop_defs:
        t = threading.Thread(target=target, name=name, daemon=True)
        t.start()
        _threads.append(t)

    log.info("[Main] GoldBot is running. Press Ctrl+C to stop.")

    # Keep the main thread alive
    while not _shutting_down:
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        _shutdown("KeyboardInterrupt")
    except Exception as e:
        log.error(f"[Main] Fatal: {e}")
        _shutdown("FATAL")
        sys.exit(1)
