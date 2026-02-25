#!/usr/bin/env python3
"""
label_signals.py — Compute training labels for unlabelled signals.

Two labelling strategies are applied, depending on the signal type:

1. CANDIDATE signals (features contain 'candidate_direction'):
   Label = "TP1 reached before SL within HORIZON_BARS M5 bars"
     +1  : candle high/low reaches candidate_tp1 before candidate_sl
     -1  : candle high/low reaches candidate_sl first (or same bar)
      0  : neither hit within the horizon

2. All other signals (standard future-return label):
   future_return = close[t+H] - close[t₀]   (t₀ = candle at/before signal ts)
   ret_norm      = future_return / ATR14_M5   (uses stored m5_atr when available)
     +1  : ret_norm >=  RET_THRESHOLD
     -1  : ret_norm <= -RET_THRESHOLD
      0  : neutral

Key fixes versus v1:
  • Time alignment: signal is matched to the candle AT OR BEFORE sig.ts
    (not the first candle after, which caused a 1-bar label shift).
  • ATR: uses the stored m5_atr from signals.features so it matches
    the value Node.js computed (no Wilder-vs-ewm mismatch).

Run nightly after trading hours:
  python trainer/label_signals.py

Requirements: set DB_URL in .env (or environment).
"""

import json
import os
import sys
from bisect import bisect_right

import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

# ── Config ────────────────────────────────────────────────────
HORIZON_BARS   = 6        # look N M5 bars ahead for both label types
HORIZON_TF     = 'M5'
RET_THRESHOLD  = 0.5      # |ret_norm| threshold for +1/-1 (strategy 2)
ATR_PERIOD     = 14

# ── Setup ─────────────────────────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
DB_URL = os.environ.get('DB_URL', '')
if not DB_URL:
    sys.exit('DB_URL not set')

engine = create_engine(DB_URL)


def _parse_features(raw) -> dict:
    """Return features as a plain dict regardless of DB storage type."""
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except Exception:  # pylint: disable=broad-exception-caught
        return {}


def _at_or_before(ts_sorted: list, sig_ts: int) -> int | None:
    """
    Return the index of the last timestamp in ts_sorted that is <= sig_ts.
    Returns None when all timestamps are after sig_ts.
    """
    pos = bisect_right(ts_sorted, sig_ts) - 1
    return pos if pos >= 0 else None


def _label_candidate(sig_ts: int, features: dict,
                      candles_df: pd.DataFrame, ts_sorted: list) -> tuple:
    """
    TP1-before-SL label for a BOS candidate signal.
    Returns (label, future_return=None, ret_norm=None).
    """
    direction = features.get('candidate_direction')
    sl        = features.get('candidate_sl')
    tp1       = features.get('candidate_tp1')

    if direction is None or sl is None or tp1 is None:
        return 0, None, None

    sl  = float(sl)
    tp1 = float(tp1)

    base_pos = _at_or_before(ts_sorted, sig_ts)
    if base_pos is None:
        return 0, None, None

    # Scan the next HORIZON_BARS candles
    label = 0
    for i in range(base_pos + 1, min(base_pos + 1 + HORIZON_BARS, len(ts_sorted))):
        ts   = ts_sorted[i]
        high = float(candles_df.at[ts, 'high'])   # type: ignore[arg-type]
        low  = float(candles_df.at[ts, 'low'])    # type: ignore[arg-type]

        if direction == 'BUY':
            sl_hit  = low  <= sl
            tp1_hit = high >= tp1
        else:  # SELL
            sl_hit  = high >= sl
            tp1_hit = low  <= tp1

        if tp1_hit and not sl_hit:
            label = 1
            break
        if sl_hit:
            # Covers both "SL only" and "both on same candle" (conservative)
            label = -1
            break

    return label, None, None


def _label_future_return(sig_ts: int, features: dict,
                          candles_df: pd.DataFrame, ts_sorted: list) -> tuple:
    """
    Standard future-return label.
    Returns (label, future_return, ret_norm).
    """
    base_pos = _at_or_before(ts_sorted, sig_ts)
    if base_pos is None:
        return 0, None, None

    future_pos = base_pos + HORIZON_BARS
    if future_pos >= len(ts_sorted):
        return 0, None, None   # not enough future bars yet

    base_ts   = ts_sorted[base_pos]
    future_ts = ts_sorted[future_pos]

    base_close   = float(candles_df.at[base_ts,   'close'])  # type: ignore[arg-type]
    future_close = float(candles_df.at[future_ts, 'close'])  # type: ignore[arg-type]

    # Use the ATR that Node.js stored in features (guaranteed to match training)
    base_atr = features.get('m5_atr')
    if not base_atr or base_atr <= 0:
        return 0, None, None   # cannot compute normalised return without ATR

    future_return = future_close - base_close
    ret_norm      = future_return / base_atr

    label = 0
    if ret_norm >= RET_THRESHOLD:
        label = 1
    elif ret_norm <= -RET_THRESHOLD:
        label = -1

    return label, future_return, ret_norm


def main():  # pylint: disable=too-many-locals
    """Label all unlabelled SCALP signals using the appropriate strategy."""
    with engine.connect() as conn:
        signals_df = pd.read_sql(text("""
            SELECT s.id, s.epic, s.ts, s.features, s.action
            FROM signals s
            LEFT JOIN labels l ON l.signal_id = s.id
            WHERE l.signal_id IS NULL
              AND s.mode = 'SCALP'
            ORDER BY s.ts
        """), conn)

        if signals_df.empty:
            print('No unlabelled signals found.')
            return

        print(f'Labelling {len(signals_df)} signals...')

        for epic, grp in signals_df.groupby('epic'):
            min_ts = int(grp['ts'].min()) - ATR_PERIOD * 5 * 60_000  # type: ignore[arg-type]
            # Fetch candles far enough ahead for the last signal's horizon
            max_ts = int(grp['ts'].max()) + (HORIZON_BARS + 2) * 5 * 60_000  # type: ignore[arg-type]

            candles_df = pd.read_sql(text("""
                SELECT ts, open, high, low, close
                FROM candles
                WHERE epic = :epic AND tf = :tf
                  AND ts >= :min_ts AND ts <= :max_ts
                ORDER BY ts
            """), conn, params={'epic': epic, 'tf': HORIZON_TF,
                                'min_ts': min_ts, 'max_ts': max_ts})

            if candles_df.empty:
                print(f'  {epic}: no M5 candles found, skipping')
                continue

            candles_df.set_index('ts', inplace=True)
            ts_sorted = candles_df.index.tolist()   # ascending, sorted

            rows_to_insert = []
            n_cand = 0
            for _, sig in grp.iterrows():
                sig_ts      = int(sig['ts'])  # type: ignore[arg-type]
                features    = _parse_features(sig['features'])
                is_candidate = bool(features.get('candidate_direction'))

                # Choose label strategy based on whether candidate params exist
                if is_candidate:
                    n_cand += 1
                    label, fut_ret, ret_norm = _label_candidate(
                        sig_ts, features, candles_df, ts_sorted)
                else:
                    label, fut_ret, ret_norm = _label_future_return(
                        sig_ts, features, candles_df, ts_sorted)

                rows_to_insert.append({
                    'signal_id':     int(sig['id']),  # type: ignore[arg-type]
                    'horizon_bars':  HORIZON_BARS,
                    'horizon_tf':    HORIZON_TF,
                    'label':         label,
                    'future_return': fut_ret,
                    'ret_norm':      ret_norm,
                })

            if rows_to_insert:
                conn.execute(text("""
                    INSERT INTO labels
                        (signal_id, horizon_bars, horizon_tf, label, future_return, ret_norm)
                    VALUES
                        (:signal_id, :horizon_bars, :horizon_tf, :label, :future_return, :ret_norm)
                    ON CONFLICT (signal_id) DO NOTHING
                """), rows_to_insert)
                conn.commit()

                n_ret = len(rows_to_insert) - n_cand
                print(
                    f'  {epic}: labelled {len(rows_to_insert)} signals '
                    f'(+1={sum(r["label"]==1 for r in rows_to_insert)}, '
                    f'0={sum(r["label"]==0 for r in rows_to_insert)}, '
                    f'-1={sum(r["label"]==-1 for r in rows_to_insert)}) '
                    f'[candidate={n_cand}, return={n_ret}]'
                )


if __name__ == '__main__':
    main()
