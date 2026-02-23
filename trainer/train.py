#!/usr/bin/env python3
"""
train.py — Train a logistic regression model on labelled signals.

Uses a rolling window of the most recent WINDOW_DAYS days.
Binary classification: +1 (up) vs not +1.

Output: writes weights to models/current.json (consumed by mlModel.js).

Run nightly after label_signals.py:
  python trainer/train.py

Requires: DB_URL in .env
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import cross_val_score
from sklearn.metrics import roc_auc_score

# ── Config ────────────────────────────────────────────────────
WINDOW_DAYS    = 30     # rolling training window
MIN_SAMPLES    = 100    # minimum labelled rows to train
BUY_THRESHOLD  = 0.60  # p(up) threshold for BUY entries
SELL_THRESHOLD = 0.40  # p(up) threshold for SELL entries (p(down) >= 0.60)

# Features used for training.  These keys must match what strategy.js
# writes into signals.features JSONB.
FEATURE_NAMES = [
    'spread',
    'spread_norm',          # spread / atr_m5
    'm15_ema200_dist_atr',  # (m15_close - m15_ema200) / atr_m5
    'm5_ema20_50_dist_atr', # (m5_ema20 - m5_ema50) / atr_m5
    'm5_atr',
    'm5_close_ema50_dist',  # m5_close - m5_ema50
    'm1_ema20_50_dist',     # m1_ema20 - m1_ema50 (0 when no M1 data)
    'chop',                 # 1 if chop detected, 0 otherwise
    'setup_active',         # 1 if setup was active
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


def main():
    cutoff_ts = int((datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).timestamp() * 1000)

    with engine.connect() as conn:
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

    print(f'Training on {len(df)} samples (window={WINDOW_DAYS}d)...')
    print(f'  Label distribution: +1={sum(df.label==1)}, -1={sum(df.label==-1)}')

    # Parse JSONB features
    df['features_parsed'] = df['features'].apply(
        lambda x: x if isinstance(x, dict) else json.loads(x)
    )

    X = np.array([
        [extract_feature(row, name) for name in FEATURE_NAMES]
        for row in df['features_parsed']
    ])
    # Binary: predict whether price goes up (+1 class)
    y = (df['label'] == 1).astype(int).values

    # Train logistic regression with L2 regularisation
    pipe = Pipeline([
        ('scaler', StandardScaler()),
        ('lr',     LogisticRegression(C=1.0, max_iter=500, class_weight='balanced')),
    ])

    # 5-fold CV for diagnostics
    cv_auc = cross_val_score(pipe, X, y, cv=5, scoring='roc_auc').mean()
    print(f'  CV ROC-AUC: {cv_auc:.4f}')

    # Final fit on all data
    pipe.fit(X, y)
    lr = pipe.named_steps['lr']
    sc = pipe.named_steps['scaler']

    # Recover original-space weights by dividing by scaler scale
    # w_orig[i] = w_lr[i] / scale[i]
    w_scaled = lr.coef_[0]
    scale     = sc.scale_
    w_orig    = w_scaled / scale
    bias      = float(lr.intercept_[0]) - float(np.dot(w_scaled, sc.mean_ / scale))

    version = datetime.now(timezone.utc).strftime('%Y-%m-%d_%H')
    model = {
        'model_version': version,
        'feature_names': FEATURE_NAMES,
        'bias':          round(float(bias), 6),
        'weights':       {name: round(float(w), 6) for name, w in zip(FEATURE_NAMES, w_orig)},
        'meta': {
            'trained_at':      datetime.now(timezone.utc).isoformat(),
            'n_train':         len(df),
            'cv_roc_auc':      round(cv_auc, 4),
            'buy_threshold':   BUY_THRESHOLD,
            'sell_threshold':  SELL_THRESHOLD,
            'window_days':     WINDOW_DAYS,
        },
    }

    out_path = os.path.join(MODELS_DIR, 'current.json')
    with open(out_path, 'w') as f:
        json.dump(model, f, indent=2)

    print(f'  Model saved → {out_path}')
    print(f'  Version: {version}')

    # Also save a timestamped archive copy
    archive_path = os.path.join(MODELS_DIR, f'model_{version}.json')
    with open(archive_path, 'w') as f:
        json.dump(model, f, indent=2)
    print(f'  Archive → {archive_path}')

    # Register in DB (non-fatal if table doesn't exist yet)
    try:
        with engine.connect() as conn:
            conn.execute(text("""
                INSERT INTO model_registry (model_version, n_train, roc_auc, notes)
                VALUES (:v, :n, :auc, :notes)
                ON CONFLICT (model_version) DO UPDATE
                  SET roc_auc = EXCLUDED.roc_auc, n_train = EXCLUDED.n_train
            """), {
                'v':     version,
                'n':     len(df),
                'auc':   round(cv_auc, 4),
                'notes': f'window={WINDOW_DAYS}d C=1.0',
            })
            conn.commit()
    except Exception as e:
        print(f'  Warning: could not register model in DB: {e}')


if __name__ == '__main__':
    main()
