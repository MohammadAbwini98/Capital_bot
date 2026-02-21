# ==============================================================
# GoldBot — indicators.py
# EMA, ATR, HighestHigh, LowestLow — pure Python, no deps.
# ==============================================================

from __future__ import annotations


def compute_ema(values: list[float], period: int) -> list[float | None]:
    """
    Full EMA series. First (period-1) entries are None (seeding phase).
    """
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out

    k = 2.0 / (period + 1)
    out[period - 1] = sum(values[:period]) / period

    for i in range(period, len(values)):
        out[i] = values[i] * k + out[i - 1] * (1 - k)   # type: ignore[operator]

    return out


def ema(values: list[float], period: int) -> float | None:
    """Return the most recent non-None EMA value."""
    arr = compute_ema(values, period)
    for v in reversed(arr):
        if v is not None:
            return v
    return None


def true_ranges(highs: list[float], lows: list[float], closes: list[float]) -> list[float]:
    tr = []
    for i, (h, l) in enumerate(zip(highs, lows)):
        hl = h - l
        if i == 0:
            tr.append(hl)
        else:
            tr.append(max(hl, abs(h - closes[i - 1]), abs(l - closes[i - 1])))
    return tr


def atr(highs: list[float], lows: list[float], closes: list[float], period: int) -> float | None:
    """Return the most recent ATR value."""
    return ema(true_ranges(highs, lows, closes), period)


def highest_high(highs: list[float], n: int) -> float:
    """Highest high of the last n entries in the list."""
    return max(highs[-n:])


def lowest_low(lows: list[float], n: int) -> float:
    """Lowest low of the last n entries in the list."""
    return min(lows[-n:])
