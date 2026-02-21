# ==============================================================
# GoldBot — config.py
# All algorithm constants + environment-sourced credentials.
# Reads the shared .env two levels up (GoldBot/.env).
# ==============================================================

import os
from pathlib import Path
from dotenv import load_dotenv

# Load shared .env from project root (GoldBot/.env)
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_env_path)

# ── API credentials ───────────────────────────────────────
API_KEY      = os.getenv("CAPITAL_API_KEY", "")
EMAIL        = os.getenv("CAPITAL_EMAIL", "")
PASSWORD     = os.getenv("CAPITAL_PASSWORD", "")
ACCOUNT_TYPE = os.getenv("ACCOUNT_TYPE", "demo").lower()
SWING_ENABLED = os.getenv("SWING_ENABLED", "false").lower() == "true"

# ── Derived base URL ──────────────────────────────────────
BASE_URL = (
    "https://api-capital.backend-capital.com"
    if ACCOUNT_TYPE == "live"
    else "https://demo-api-capital.backend-capital.com"
)

# ── Instrument ────────────────────────────────────────────
EPIC = "XAUUSD"

# ── Risk gates ────────────────────────────────────────────
MAX_TRADES_PER_DAY     = 3
DAILY_LOSS_LIMIT_USD   = 10.00
MAX_CONSECUTIVE_LOSSES = 3

# ── Position sizing ───────────────────────────────────────
SCALP_SIZE_UNITS = 1
SWING_SIZE_UNITS = 1

# ── Spread filter ─────────────────────────────────────────
SPREAD_MAX = 0.60   # price units (XAUUSD)

# ── Indicator periods ─────────────────────────────────────
EMA_TREND_PERIOD    = 200   # M15 (scalp) / H4 (swing)
EMA_FAST_PERIOD     = 20    # on entry TF
EMA_PULLBACK_PERIOD = 50    # on entry TF
ATR_PERIOD          = 14    # on entry TF

# ── BOS lookback ──────────────────────────────────────────
BOS_LOOKBACK_SCALP = 8    # previous bars on M5
BOS_LOOKBACK_SWING = 10   # previous bars on H1

# ── Setup expiry ──────────────────────────────────────────
SETUP_EXPIRY_BARS_SCALP = 6    # 6 × M5 = 30 minutes
SETUP_EXPIRY_BARS_SWING = 12   # 12 × H1 = 12 hours

# ── Pullback / chop thresholds ────────────────────────────
PULLBACK_ATR_TOL       = 0.40   # EMA50 touch zone
CHOP_EMA_DIST_ATR_MIN  = 0.12   # min EMA spread to avoid chop
BIG_CANDLE_ATR_MAX     = 1.50   # skip trigger if candle range > 1.5× ATR

# ── SL / TP ───────────────────────────────────────────────
SL_BUFFER_ATR               = 0.15
TP1_R                       = 1.0
TP2_R_SCALP                 = 2.0
TP2_R_SWING                 = 3.0
PARTIAL_CLOSE_TP1           = 0.50
MOVE_SL_TO_BREAKEVEN_ON_TP1 = False

# ── Candle store settings ─────────────────────────────────
HISTORY_BARS     = 300   # bars loaded at startup
INCREMENTAL_BARS = 6     # bars fetched per update

# ── Poll intervals (seconds) ──────────────────────────────
TICK_POLL_S = 5
M5_POLL_S   = 30
M15_POLL_S  = 60
H1_POLL_S   = 5 * 60
H4_POLL_S   = 20 * 60

# ── Session auto-refresh ──────────────────────────────────
SESSION_REFRESH_S = 540   # 9 minutes
