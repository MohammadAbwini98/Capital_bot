#!/usr/bin/env python3
"""
train.py — Train a logistic regression model on labelled signals.

Uses a rolling window of the most recent WINDOW_DAYS days.
Binary classification: +1 (up / TP1 hit) vs not +1.

Output:
  models/challenger.json       ← new candidate (NOT current.json directly)
  models/model_<version>.json  ← archive copy

After training, run promote.py to evaluate vs champion and optionally promote:
  python trainer/train.py && python trainer/promote.py

Run schedule (cron or PM2):
  - Training job: every 6 hours
  - Promotion job: immediately after training (chained in cron)

Requires: DB_URL in .env
"""

import os
import sys
import json
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sqlalchemy import create_engine, text

# ── Config ────────────────────────────────────────────────────
WINDOW_DAYS          = 30     # rolling training window
MIN_SAMPLES          = 50     # minimum labelled rows to train
NEW_LABELS_THRESHOLD = 20     # skip if fewer new labels since last train
BUY_THRESHOLD        = 0.60   # p(up) threshold for BUY entries
SELL_THRESHOLD       = 0.40   # p(up) threshold for SELL entries
CV_SPLITS            = 5      # walk-forward folds

# Features used for training.  These keys must match what strategy.js
# writes into signals.features JSONB.
FEATURE_NAMES = [
    # Spread / ATR
    'spread',
    'spread_norm',              # spread / m5_atr
    # M5 price structure
    'm15_ema200_dist_atr',      # (m15_close - m15_ema200) / m5_atr
    'm5_ema20_50_dist_atr',     # (m5_ema20 - m5_ema50) / m5_atr
    'm5_atr',
    'm5_close_ema50_dist',      # m5_close - m5_ema50
    # M5 momentum / volatility
    'm5_rsi14',
    'm5_bb_width',
    'm5_atr_ratio',
    # M15 trend quality
    'm15_trend_strength',       # |m15_close - m15_ema200| / m15_atr
    'm15_ema200_slope',         # normalised EMA200 slope
    # H1 macro
    'h1_ema200_dist_atr',       # (h1_close - h1_ema200) / m5_atr
    'h1_rsi14',
    # M1 micro-confirm
    'm1_ema20_50_dist',         # m1_ema20 - m1_ema50 (0 when no M1 data)
    # Gate flags
    'chop',                     # 1 if chop detected, 0 otherwise
    'setup_active',             # 1 if setup was active
]

# ── Setup ─────────────────────────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
DB_URL = os.environ.get('DB_URL', '')
if not DB_URL:
    sys.exit('DB_URL not set')

MODELS_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')
os.makedirs(MODELS_DIR, exist_ok=True)

engine = create_engine(DB_URL)


def extract_feature(features_json: dict, name: str) -> float:
    """Safely extract a numeric feature value, returning 0 for missing."""
    v = features_json.get(name, 0.0)
    try:
        f = float(v)
        return 0.0 if not np.isfinite(f) else f
    except (TypeError, ValueError):
        return 0.0


def _new_labels_since_last_train(conn) -> int:
    """Count non-neutral labels created after the last training run."""
    row = conn.execute(text("""
        SELECT MAX(finished_at) FROM training_runs WHERE finished_at IS NOT NULL
    """)).fetchone()
    last_train = row[0]

    if last_train is None:
        return 9999  # never trained → always proceed

    count = conn.execute(text("""
        SELECT COUNT(*) FROM labels l
        JOIN signals s ON s.id = l.signal_id
        WHERE l.computed_at > :since AND l.label != 0
    """), {'since': last_train}).fetchone()[0]
    return int(count)


def main():  # pylint: disable=too-many-locals
    """Train logistic regression on labelled signals and export challenger JSON."""
    started_at = datetime.now(timezone.utc)
    cutoff_ts = int(
        (started_at - timedelta(days=WINDOW_DAYS)).timestamp() * 1000
    )

    with engine.connect() as conn:
        new_count = _new_labels_since_last_train(conn)
        if new_count < NEW_LABELS_THRESHOLD:
            print(f'Only {new_count} new labels since last train '
                  f'(need {NEW_LABELS_THRESHOLD}). Skipping.')
            sys.exit(0)

        df = pd.read_sql(text("""
            SELECT s.ts, s.features, l.label
            FROM signals s
            JOIN labels l ON l.signal_id = s.id
            WHERE s.mode = 'SCALP'
              AND s.ts >= :cutoff_ts
              AND l.label != 0
            ORDER BY s.ts
        """), conn, params={'cutoff_ts': cutoff_ts})

    if len(df) < MIN_SAMPLES:
        print(f'Only {len(df)} labelled samples — need at least {MIN_SAMPLES}. Skipping.')
        sys.exit(0)

    train_start_ts = int(df['ts'].min())  # type: ignore[arg-type]
    train_end_ts   = int(df['ts'].max())  # type: ignore[arg-type]

    print(f'Training on {len(df)} samples (window={WINDOW_DAYS}d)...')
    print(f'  Label distribution: +1={sum(df.label==1)}, -1={sum(df.label==-1)}')

    # Parse JSONB features
    df['features_parsed'] = df['features'].apply(
        lambda x: x if isinstance(x, dict) else json.loads(x)
    )

    # Normalize labels to a directional target: y=1 means "price went UP" was the
    # correct outcome.  For BUY candidates label=+1 already means price UP.
    # For SELL candidates label=+1 means price DOWN (profitable SELL), which must
    # be flipped to label=-1 before training so the model always predicts price UP.
    def _direction_adjusted_label(row) -> int:
        feats = row['features_parsed']
        direction = feats.get('candidate_direction') if isinstance(feats, dict) else None
        lbl = int(row['label'])  # type: ignore[arg-type]
        if direction == 'SELL':
            return -lbl   # invert: profitable SELL (price DOWN) → -1
        return lbl

    df['label_adj'] = df.apply(_direction_adjusted_label, axis=1)
    n_sell = int((df['features_parsed'].apply(  # type: ignore[arg-type]
        lambda f: (f if isinstance(f, dict) else {}).get('candidate_direction') == 'SELL'
    )).sum())
    print(f'  Direction breakdown: SELL candidates={n_sell}, BUY/other={len(df)-n_sell}')
    print(f'  Adjusted label dist: +1={sum(df.label_adj==1)}, -1={sum(df.label_adj==-1)}')

    x_train = np.array([
        [extract_feature(row, name) for name in FEATURE_NAMES]
        for row in df['features_parsed']
    ])
    y = np.asarray((df['label_adj'] == 1).astype(int))

    # Walk-forward (time-series) CV — avoids lookahead leakage
    tscv = TimeSeriesSplit(n_splits=CV_SPLITS)
    aucs      = []
    hit_rates = []
    for train_idx, val_idx in tscv.split(x_train):
        if len(set(y[val_idx])) < 2:
            continue
        fold_pipe = Pipeline([
            ('scaler', StandardScaler()),
            ('lr',     LogisticRegression(C=1.0, max_iter=500, class_weight='balanced')),
        ])
        fold_pipe.fit(x_train[train_idx], y[train_idx])
        prob = fold_pipe.predict_proba(x_train[val_idx])[:, 1]
        aucs.append(float(roc_auc_score(y[val_idx], prob)))
        pred_positive = prob >= BUY_THRESHOLD
        if pred_positive.any():
            hit_rates.append(float(y[val_idx][pred_positive].mean()))

    cv_auc      = float(np.mean(aucs))      if aucs      else float('nan')
    cv_hit_rate = float(np.mean(hit_rates)) if hit_rates else float('nan')
    n_val       = len(aucs)
    print(f'  Walk-forward CV ROC-AUC ({n_val}/{CV_SPLITS} folds): {cv_auc:.4f}')
    print(f'  Walk-forward CV hit-rate: {cv_hit_rate:.4f}')

    # Final fit on all data
    pipe = Pipeline([
        ('scaler', StandardScaler()),
        ('lr',     LogisticRegression(C=1.0, max_iter=500, class_weight='balanced')),
    ])
    pipe.fit(x_train, y)
    lr = pipe.named_steps['lr']
    sc = pipe.named_steps['scaler']

    # Recover original-space weights: w_orig[i] = w_lr[i] / scale[i]
    w_scaled = lr.coef_[0]
    scale     = sc.scale_
    w_orig    = w_scaled / scale
    bias      = float(lr.intercept_[0]) - float(np.dot(w_scaled, sc.mean_ / scale))

    version = started_at.strftime('%Y-%m-%d_%H')
    model = {
        'model_version': version,
        'feature_names': FEATURE_NAMES,
        'bias':          round(float(bias), 6),
        'weights':       {name: round(float(w), 6) for name, w in zip(FEATURE_NAMES, w_orig)},
        'meta': {
            'trained_at':      started_at.isoformat(),
            'n_train':         len(df),
            'cv_roc_auc':      round(cv_auc, 4),
            'cv_hit_rate':     round(cv_hit_rate, 4),
            'cv_folds':        n_val,
            'buy_threshold':   BUY_THRESHOLD,
            'sell_threshold':  SELL_THRESHOLD,
            'window_days':     WINDOW_DAYS,
        },
    }

    # Write challenger — promote.py decides whether to copy to current.json
    challenger_path = os.path.join(MODELS_DIR, 'challenger.json')
    with open(challenger_path, 'w', encoding='utf-8') as f:
        json.dump(model, f, indent=2)
    print(f'  Challenger saved → {challenger_path}')

    archive_path = os.path.join(MODELS_DIR, f'model_{version}.json')
    with open(archive_path, 'w', encoding='utf-8') as f:
        json.dump(model, f, indent=2)
    print(f'  Archive → {archive_path}')
    print(f'  Version: {version}')

    finished_at = datetime.now(timezone.utc)

    # Persist to DB (non-fatal)
    try:
        with engine.connect() as conn:
            conn.execute(text("""
                INSERT INTO model_registry
                    (model_version, n_train, roc_auc, notes, status)
                VALUES (:v, :n, :auc, :notes, 'challenger')
                ON CONFLICT (model_version) DO UPDATE
                  SET roc_auc = EXCLUDED.roc_auc,
                      n_train = EXCLUDED.n_train,
                      status  = 'challenger'
            """), {
                'v':     version,
                'n':     len(df),
                'auc':   round(float(cv_auc), 4),
                'notes': f'window={WINDOW_DAYS}d C=1.0 walk-forward-cv',
            })
            conn.execute(text("""
                INSERT INTO training_runs
                    (model_version, started_at, finished_at,
                     n_train, n_val,
                     train_start_ts, train_end_ts,
                     cv_roc_auc, val_hit_rate,
                     promoted, notes)
                VALUES
                    (:v, :start, :finish,
                     :n_train, :n_val,
                     :ts_start, :ts_end,
                     :auc, :hit_rate,
                     FALSE, :notes)
            """), {
                'v':        version,
                'start':    started_at,
                'finish':   finished_at,
                'n_train':  len(df),
                'n_val':    n_val,
                'ts_start': train_start_ts,
                'ts_end':   train_end_ts,
                'auc':      round(float(cv_auc), 4),
                'hit_rate': round(float(cv_hit_rate), 4),
                'notes':    f'window={WINDOW_DAYS}d C=1.0 walk-forward-cv',
            })
            conn.commit()
            print('  Registered as challenger in DB (model_registry + training_runs).')
    except Exception as e:  # pylint: disable=broad-exception-caught
        print(f'  Warning: could not register in DB: {e}')

    print('  Next: run promote.py to compare vs champion.')


if __name__ == '__main__':
    main()
