# ==============================================================
# GoldBot — state.py
# Bot runtime state: daily counters, setups, open positions,
# risk gates, and daily reset logic.
# ==============================================================

from __future__ import annotations
from dataclasses import dataclass, field

import config as cfg
import logger as log


# ══════════════════════════════════════════════════════════
# Data structures
# ══════════════════════════════════════════════════════════

@dataclass
class Setup:
    active:           bool  = False
    direction:        str   = ""
    created_time:     int   = 0    # epoch ms of the bar that formed the setup
    pullback_extreme: float = 0.0


@dataclass
class Position:
    mode:            str
    direction:       str
    size:            float
    entry:           float
    sl:              float
    tp1:             float
    tp2:             float
    tp1_done:        bool
    deal_id:         str
    deal_reference:  str
    opened_time:     int   # epoch ms


# ══════════════════════════════════════════════════════════
# Module-level state (singleton)
# ══════════════════════════════════════════════════════════

_day_realized_pnl_usd: float = 0.0
_trades_today:         int   = 0
_consecutive_losses:   int   = 0
_day_start_equity:     float = 0.0

_setup_scalp: Setup = Setup()
_setup_swing: Setup = Setup()

_open_positions: list[Position] = []


# ══════════════════════════════════════════════════════════
# Risk gates
# ══════════════════════════════════════════════════════════

def risk_ok() -> bool:
    if _trades_today >= cfg.MAX_TRADES_PER_DAY:
        log.warn(f"[Risk] Daily trade limit reached ({_trades_today}/{cfg.MAX_TRADES_PER_DAY})")
        return False
    if _day_realized_pnl_usd <= -cfg.DAILY_LOSS_LIMIT_USD:
        log.warn(f"[Risk] Daily loss limit reached (P&L: ${_day_realized_pnl_usd:.2f})")
        return False
    if _consecutive_losses >= cfg.MAX_CONSECUTIVE_LOSSES:
        log.warn(f"[Risk] Max consecutive losses reached ({_consecutive_losses})")
        return False
    return True


# ══════════════════════════════════════════════════════════
# Position tracking
# ══════════════════════════════════════════════════════════

def add_position(pos: Position) -> None:
    global _trades_today
    _open_positions.append(pos)
    _trades_today += 1
    log.info(f"[State] Position added: {pos.mode} {pos.direction} deal_id={pos.deal_id} | trades_today={_trades_today}")


def replace_position(old_deal_id: str, new_pos: Position) -> None:
    """Replace position without incrementing trades_today (used for TP1 reopen)."""
    global _open_positions
    _open_positions = [p for p in _open_positions if p.deal_id != old_deal_id]
    _open_positions.append(new_pos)
    log.info(f"[State] Position replaced: old={old_deal_id} → new={new_pos.deal_id}")


def remove_position(deal_id: str) -> None:
    global _open_positions
    _open_positions = [p for p in _open_positions if p.deal_id != deal_id]


def get_positions() -> list[Position]:
    return list(_open_positions)


# ══════════════════════════════════════════════════════════
# P&L tracking
# ══════════════════════════════════════════════════════════

def update_pnl(pnl_usd: float, is_loss: bool) -> None:
    global _day_realized_pnl_usd, _consecutive_losses
    _day_realized_pnl_usd += pnl_usd
    if is_loss:
        _consecutive_losses += 1
    else:
        _consecutive_losses = 0

    sign = "+" if pnl_usd >= 0 else ""
    log.info(
        f"[State] P&L update: {sign}${pnl_usd:.2f} | "
        f"day_pnl=${_day_realized_pnl_usd:.2f} | "
        f"consec_losses={_consecutive_losses}"
    )


# ══════════════════════════════════════════════════════════
# Setup accessors
# ══════════════════════════════════════════════════════════

def get_setup_scalp() -> Setup:  return _setup_scalp
def set_setup_scalp(s: Setup):
    global _setup_scalp
    _setup_scalp = s

def get_setup_swing() -> Setup:  return _setup_swing
def set_setup_swing(s: Setup):
    global _setup_swing
    _setup_swing = s


# ══════════════════════════════════════════════════════════
# Daily reset
# ══════════════════════════════════════════════════════════

def daily_reset(equity: float = 0.0) -> None:
    global _day_realized_pnl_usd, _trades_today, _consecutive_losses
    global _day_start_equity, _setup_scalp, _setup_swing
    _day_start_equity     = equity
    _day_realized_pnl_usd = 0.0
    _trades_today         = 0
    _consecutive_losses   = 0
    _setup_scalp          = Setup()
    _setup_swing          = Setup()
    log.info(f"[State] Daily reset. Start equity: ${equity:.2f}")


def get_stats() -> dict:
    return {
        "day_pnl":         _day_realized_pnl_usd,
        "trades_today":    _trades_today,
        "consec_losses":   _consecutive_losses,
        "open_count":      len(_open_positions),
    }
