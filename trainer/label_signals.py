#!/usr/bin/env python3
"""
label_signals.py — Compute training labels for unlabelled signals.

For each signal without a label, we look up the M5 candle
HORIZON_BARS bars after the signal timestamp and compute:
  future_return = close[t + HORIZON_BARS] - close[t]
  ret_norm      = future_return / ATR14_M5[t]
  label         = +1 if ret_norm >=  RET_THRESHOLD
                  -1 if ret_norm <= -RET_THRESHOLD
                   0 otherwise (neutral)

Run nightly after trading hours:
  python trainer/label_signals.py

Requirements: set DB_URL in .env (or environment).
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

# ── Config ────────────────────────────────────────────────────
HORIZON_BARS   = 6        # 6 × M5 = 30 min
HORIZON_TF     = "M5"
RET_THRESHOLD  = 0.5      # ret_norm threshold for +1/-1 labels
ATR_PERIOD     = 14

# ── Setup ─────────────────────────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
DB_URL = os.environ.get('DB_URL', '')
if not DB_URL:
    sys.exit('DB_URL not set')

engine = create_engine(DB_URL)


def compute_atr(df_candles: pd.DataFrame, period: int = ATR_PERIOD) -> pd.Series:
    """Wilder ATR on a candle DataFrame with columns high, low, close."""
    hl  = df_candles['high'] - df_candles['low']
    hcp = (df_candles['high'] - df_candles['close'].shift(1)).abs()
    lcp = (df_candles['low']  - df_candles['close'].shift(1)).abs()
    tr  = pd.concat([hl, hcp, lcp], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False).mean()


def main():
    with engine.connect() as conn:
        # Load all unlabelled SCALP signals
        signals_df = pd.read_sql(text("""
            SELECT s.id, s.epic, s.ts, s.features
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

        # Group by epic so we only load candles once per epic
        for epic, grp in signals_df.groupby('epic'):
            # Load M5 candles for this epic (only what we need)
            min_ts = int(grp['ts'].min()) - ATR_PERIOD * 5 * 60_000
            candles_df = pd.read_sql(text("""
                SELECT ts, open, high, low, close
                FROM candles
                WHERE epic = :epic AND tf = :tf AND ts >= :min_ts
                ORDER BY ts
            """), conn, params={'epic': epic, 'tf': HORIZON_TF, 'min_ts': min_ts})

            if candles_df.empty:
                print(f'  {epic}: no M5 candles found, skipping')
                continue

            candles_df.set_index('ts', inplace=True)
            ts_sorted = candles_df.index.tolist()
            atr_series = compute_atr(candles_df)

            rows_to_insert = []
            for _, sig in grp.iterrows():
                sig_ts = int(sig['ts'])

                # Find the candle at or just after signal time
                try:
                    base_pos = next(i for i, t in enumerate(ts_sorted) if t >= sig_ts)
                except StopIteration:
                    continue  # signal is after last candle

                future_pos = base_pos + HORIZON_BARS
                if future_pos >= len(ts_sorted):
                    continue  # not enough future bars yet

                base_ts   = ts_sorted[base_pos]
                future_ts = ts_sorted[future_pos]

                base_close   = candles_df.loc[base_ts,   'close']
                future_close = candles_df.loc[future_ts, 'close']
                base_atr     = atr_series.loc[base_ts]

                future_return = float(future_close - base_close)
                ret_norm      = float(future_return / base_atr) if base_atr > 0 else 0.0

                label = 0
                if ret_norm >= RET_THRESHOLD:
                    label = 1
                elif ret_norm <= -RET_THRESHOLD:
                    label = -1

                rows_to_insert.append({
                    'signal_id':     int(sig['id']),
                    'horizon_bars':  HORIZON_BARS,
                    'horizon_tf':    HORIZON_TF,
                    'label':         label,
                    'future_return': future_return,
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
                print(f'  {epic}: labelled {len(rows_to_insert)} signals '
                      f'(+1={sum(r["label"]==1 for r in rows_to_insert)}, '
                      f'0={sum(r["label"]==0 for r in rows_to_insert)}, '
                      f'-1={sum(r["label"]==-1 for r in rows_to_insert)})')


if __name__ == '__main__':
    main()
