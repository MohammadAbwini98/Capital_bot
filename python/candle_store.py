# ==============================================================
# GoldBot — candle_store.py
# Fetches and caches OHLC candles for all active timeframes.
# Stores only CLOSED candles (current in-progress bar excluded).
# ==============================================================

from __future__ import annotations
import time

import api
import config as cfg
import logger as log

RESOLUTION = {
    "M5":  "MINUTE_5",
    "M15": "MINUTE_15",
    "H1":  "HOUR",
    "H4":  "HOUR_4",
}

# In-memory candle stores (closed bars only)
_store: dict[str, list[dict]] = {"M5": [], "M15": [], "H1": [], "H4": []}

# Most recently processed closed bar timestamp (epoch ms) per TF
_last_closed_time: dict[str, int] = {"M5": 0, "M15": 0, "H1": 0, "H4": 0}


def _active_tfs() -> list[str]:
    return ["M5", "M15", "H1", "H4"] if cfg.SWING_ENABLED else ["M5", "M15"]


# ══════════════════════════════════════════════════════════
# Startup history load
# ══════════════════════════════════════════════════════════

def load_history() -> None:
    """Fetch full candle history at startup for all active timeframes."""
    for tf in _active_tfs():
        log.info(f"[Candles] Loading {cfg.HISTORY_BARS} bars for {tf}...")
        _fetch_full(tf, cfg.HISTORY_BARS)
        time.sleep(0.25)   # light API throttle


def _fetch_full(tf: str, max_bars: int) -> None:
    # Fetch max+1 bars so we can drop the in-progress one
    bars   = api.get_candles(cfg.EPIC, RESOLUTION[tf], max_bars + 1)
    closed = bars[:-1]   # drop last (in-progress)

    _store[tf] = closed
    if closed:
        _last_closed_time[tf] = closed[-1]["time"]

    from datetime import datetime, timezone
    latest_str = (
        datetime.fromtimestamp(_last_closed_time[tf] / 1000, tz=timezone.utc).isoformat()
        if _last_closed_time[tf] else "n/a"
    )
    log.info(f"[Candles] {tf}: {len(closed)} closed bars loaded (latest: {latest_str})")


# ══════════════════════════════════════════════════════════
# Incremental update
# ══════════════════════════════════════════════════════════

def update(tf: str) -> bool:
    """
    Fetch recent bars and merge new closed ones.
    Returns True if at least one new candle has closed.
    """
    bars   = api.get_candles(cfg.EPIC, RESOLUTION[tf], cfg.INCREMENTAL_BARS + 1)
    closed = bars[:-1]   # drop in-progress

    if not closed:
        return False

    newest        = closed[-1]
    had_new_close = newest["time"] > _last_closed_time[tf]

    if had_new_close:
        known_times = {c["time"] for c in _store[tf]}
        for bar in closed:
            if bar["time"] not in known_times:
                _store[tf].append(bar)
                known_times.add(bar["time"])

        # Trim to HISTORY_BARS
        if len(_store[tf]) > cfg.HISTORY_BARS:
            _store[tf] = _store[tf][-cfg.HISTORY_BARS:]

        _last_closed_time[tf] = newest["time"]

    return had_new_close


# ══════════════════════════════════════════════════════════
# Accessors
# ══════════════════════════════════════════════════════════

def get(tf: str) -> list[dict]:
    """Return the closed-candle list for a timeframe."""
    return _store[tf]
