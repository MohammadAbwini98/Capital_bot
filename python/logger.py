# ==============================================================
# GoldBot — logger.py
# Simple coloured terminal logger.
# ==============================================================

import sys
from datetime import datetime, timezone

_RESET  = "\x1b[0m"
_CYAN   = "\x1b[36m"
_YELLOW = "\x1b[33m"
_RED    = "\x1b[31m"
_GREEN  = "\x1b[32m\x1b[1m"
_GRAY   = "\x1b[90m"


def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + " UTC"


def _emit(color: str, level: str, *args):
    msg = " ".join(str(a) for a in args)
    sys.stdout.write(f"{color}[{_ts()}] [{level:<5}]{_RESET} {msg}\n")
    sys.stdout.flush()


def info(*args):  _emit(_CYAN,   "INFO",  *args)
def warn(*args):  _emit(_YELLOW, "WARN",  *args)
def error(*args): _emit(_RED,    "ERROR", *args)
def trade(*args): _emit(_GREEN,  "TRADE", *args)
def debug(*args): _emit(_GRAY,   "DEBUG", *args)
