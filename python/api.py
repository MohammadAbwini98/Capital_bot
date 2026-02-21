# ==============================================================
# GoldBot — api.py
# Capital.com REST client: session, candles, prices, positions.
# ==============================================================

from __future__ import annotations
import threading
import time
from datetime import datetime, timezone

import requests

import config as cfg
import logger as log

# ── Session state ─────────────────────────────────────────
_cst:       str | None = None
_sec_token: str | None = None
_session    = requests.Session()
_refresh_timer: threading.Timer | None = None


# ══════════════════════════════════════════════════════════
# Session
# ══════════════════════════════════════════════════════════

def create_session() -> None:
    global _cst, _sec_token, _refresh_timer

    # Cancel any existing refresh timer
    if _refresh_timer:
        _refresh_timer.cancel()

    res = _session.post(
        f"{cfg.BASE_URL}/api/v1/session",
        json={"identifier": cfg.EMAIL, "password": cfg.PASSWORD, "encryptedPassword": False},
        headers={"X-CAP-API-KEY": cfg.API_KEY, "Content-Type": "application/json"},
        timeout=15,
    )
    res.raise_for_status()

    _cst       = res.headers["CST"]
    _sec_token = res.headers["X-SECURITY-TOKEN"]

    data = res.json()
    acct = data.get("accountInfo", {})
    log.info(f"[API] Session created — account: {acct.get('preferred', '?')} | type: {cfg.ACCOUNT_TYPE.upper()}")

    # Schedule refresh
    _refresh_timer = threading.Timer(cfg.SESSION_REFRESH_S, _auto_refresh)
    _refresh_timer.daemon = True
    _refresh_timer.start()


def _auto_refresh() -> None:
    try:
        create_session()
        log.info("[API] Session refreshed.")
    except Exception as e:
        log.error(f"[API] Session refresh failed: {e}")


def destroy_session() -> None:
    global _cst, _sec_token, _refresh_timer
    if _refresh_timer:
        _refresh_timer.cancel()
    if not _cst:
        return
    try:
        _session.delete(f"{cfg.BASE_URL}/api/v1/session", headers=_auth_headers(), timeout=10)
    except Exception:
        pass
    _cst = _sec_token = None
    log.info("[API] Session destroyed.")


def _auth_headers() -> dict:
    return {
        "X-SECURITY-TOKEN": _sec_token,
        "CST":              _cst,
        "Content-Type":     "application/json",
    }


# ══════════════════════════════════════════════════════════
# Market data
# ══════════════════════════════════════════════════════════

def get_candles(epic: str, resolution: str, max_bars: int = 200) -> list[dict]:
    """
    Fetch OHLC candles.
    resolution: 'MINUTE_5' | 'MINUTE_15' | 'HOUR' | 'HOUR_4'
    Returns list of { time, open, high, low, close, vol }.
    """
    res = _session.get(
        f"{cfg.BASE_URL}/api/v1/prices/{epic}",
        params={"resolution": resolution, "max": max_bars},
        headers=_auth_headers(),
        timeout=15,
    )
    res.raise_for_status()

    return [
        {
            "time":  _parse_cap_time(p.get("snapshotTimeUTC") or p.get("snapshotTime", "")),
            "open":  _mid(p["openPrice"]),
            "high":  _mid(p["highPrice"]),
            "low":   _mid(p["lowPrice"]),
            "close": _mid(p["closePrice"]),
            "vol":   p.get("lastTradedVolume", 0),
        }
        for p in res.json().get("prices", [])
    ]


def get_price(epic: str) -> tuple[float, float]:
    """Return (bid, ask) for an epic."""
    res = _session.get(
        f"{cfg.BASE_URL}/api/v1/markets/{epic}",
        headers=_auth_headers(),
        timeout=10,
    )
    res.raise_for_status()
    snap = res.json()["snapshot"]
    return snap["bid"], snap["offer"]


# ══════════════════════════════════════════════════════════
# Account
# ══════════════════════════════════════════════════════════

def get_account() -> dict | None:
    res = _session.get(
        f"{cfg.BASE_URL}/api/v1/accounts",
        headers=_auth_headers(),
        timeout=10,
    )
    res.raise_for_status()
    accounts = res.json().get("accounts", [])
    return accounts[0] if accounts else None


# ══════════════════════════════════════════════════════════
# Positions
# ══════════════════════════════════════════════════════════

def get_positions() -> list[dict]:
    res = _session.get(
        f"{cfg.BASE_URL}/api/v1/positions",
        headers=_auth_headers(),
        timeout=10,
    )
    res.raise_for_status()
    return res.json().get("positions", [])


def _confirm_deal(deal_reference: str, retries: int = 6, delay: float = 0.5) -> dict:
    """
    Poll GET /confirms/{dealReference} until dealStatus resolves.
    Capital.com uses a two-step flow: the initial POST/DELETE returns only a
    dealReference; the actual outcome must be fetched from the confirms endpoint.
    Raises RuntimeError if rejected or if all retries are exhausted.
    """
    for attempt in range(retries):
        time.sleep(delay)
        res = _session.get(
            f"{cfg.BASE_URL}/api/v1/confirms/{deal_reference}",
            headers=_auth_headers(),
            timeout=10,
        )
        res.raise_for_status()
        data = res.json()

        deal_status = data.get("dealStatus")
        if deal_status == "ACCEPTED":
            return data
        if deal_status is not None and deal_status != "ACCEPTED":
            raise RuntimeError(f"Deal {deal_reference} rejected: {data}")
        # dealStatus absent or blank — API still processing, retry
        log.debug(f"[API] Confirm attempt {attempt + 1}/{retries} — awaiting dealStatus for {deal_reference}")

    raise RuntimeError(f"Deal confirmation timed out after {retries} attempts: {deal_reference}")


def create_position(
    epic: str,
    direction: str,
    size: float,
    stop_level: float,
    profit_level: float,
) -> dict:
    """
    Place a market order with SL and TP.
    Capital.com requires a two-step flow:
      1. POST /positions  → returns dealReference (pending)
      2. GET /confirms/{dealReference} → returns dealStatus + dealId
    Returns { deal_id, deal_reference }.
    """
    body = {
        "epic":           epic,
        "direction":      direction,
        "size":           size,
        "guaranteedStop": False,
        "stopLevel":      round(stop_level, 2),
        "profitLevel":    round(profit_level, 2),
    }
    log.trade(f"[API] createPosition → {direction} {size} {epic} | SL={body['stopLevel']} TP={body['profitLevel']}")

    res = _session.post(
        f"{cfg.BASE_URL}/api/v1/positions",
        json=body,
        headers=_auth_headers(),
        timeout=15,
    )
    res.raise_for_status()
    data = res.json()

    deal_reference = data.get("dealReference")
    if not deal_reference:
        raise RuntimeError(f"No dealReference in createPosition response: {data}")

    confirmed = _confirm_deal(deal_reference)

    # dealId may sit at the top level or inside affectedDeals[0]
    deal_id = confirmed.get("dealId")
    if not deal_id:
        affected = confirmed.get("affectedDeals") or []
        if affected:
            deal_id = affected[0].get("dealId")
    if not deal_id:
        raise RuntimeError(f"No dealId in confirmation: {confirmed}")

    log.info(f"[API] Deal confirmed: dealId={deal_id} status=ACCEPTED")
    return {"deal_id": deal_id, "deal_reference": deal_reference}


def close_position(deal_id: str) -> dict:
    """
    Close a position in full.
    Capital.com DELETE /positions/{dealId} returns a dealReference (not a final
    status). Outcome is confirmed via GET /confirms/{dealReference}.
    """
    log.trade(f"[API] closePosition → dealId={deal_id}")
    res = _session.delete(
        f"{cfg.BASE_URL}/api/v1/positions/{deal_id}",
        headers=_auth_headers(),
        timeout=15,
    )
    res.raise_for_status()
    data = res.json()

    deal_reference = data.get("dealReference")
    if not deal_reference:
        raise RuntimeError(f"No dealReference in closePosition response: {data}")

    confirmed = _confirm_deal(deal_reference)
    log.info(f"[API] Close confirmed: dealId={deal_id} status=ACCEPTED")
    return confirmed


def update_position(
    deal_id: str,
    stop_level: float | None = None,
    profit_level: float | None = None,
) -> dict:
    body = {}
    if stop_level   is not None: body["stopLevel"]   = round(stop_level, 2)
    if profit_level is not None: body["profitLevel"] = round(profit_level, 2)

    res = _session.put(
        f"{cfg.BASE_URL}/api/v1/positions/{deal_id}",
        json=body,
        headers=_auth_headers(),
        timeout=15,
    )
    res.raise_for_status()
    return res.json()


# ══════════════════════════════════════════════════════════
# Utilities
# ══════════════════════════════════════════════════════════

def _mid(price_obj: dict) -> float:
    return (price_obj["bid"] + price_obj["ask"]) / 2


def _parse_cap_time(s: str) -> int:
    """Parse Capital.com 'YYYY/MM/DD HH:MM:SS' → epoch ms."""
    if not s:
        return 0
    s = s.replace("/", "-").replace(" ", "T")
    if not s.endswith("Z"):
        s += "Z"
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0
