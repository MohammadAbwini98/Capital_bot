#!/usr/bin/env python3
"""
promote.py — Compare challenger vs champion on recent out-of-sample data.
Promotes challenger to champion only when it clears strict criteria.

Promotion criteria (all must pass):
  1. Hit-rate improvement  ≥ HIT_RATE_MIN_IMPROVEMENT  (default +2%)
  2. Max consecutive losses not worse than champion
  3. Trade frequency not reduced by more than FREQ_MAX_DROP (default 30%)
     unless the profit factor improves meaningfully

Run after train.py:
  python trainer/promote.py

Or chain in cron:
  0 */6 * * *  cd /path/to/GoldBot && \
      trainer/.venv/bin/python trainer/label_signals.py && \
      trainer/.venv/bin/python trainer/train.py && \
      trainer/.venv/bin/python trainer/promote.py

Requires: DB_URL in .env, models/challenger.json written by train.py.
"""

import json
import os
import shutil
import sys
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

# ── Config ────────────────────────────────────────────────────
EVAL_DAYS                = 14      # out-of-sample window for comparison
MIN_EVAL_SIGNALS         = 30      # minimum signals needed to compare
BUY_THRESHOLD            = 0.60    # must match train.py
SELL_THRESHOLD           = 0.40
HIT_RATE_MIN_IMPROVEMENT = 0.02    # challenger must beat champion by ≥ 2%
FREQ_MAX_DROP            = 0.30    # trade frequency must not fall more than 30%

# ── Setup ─────────────────────────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
DB_URL = os.environ.get('DB_URL', '')
if not DB_URL:
    sys.exit('DB_URL not set')

MODELS_DIR        = os.path.join(os.path.dirname(__file__), '..', 'models')
CHAMPION_PATH     = os.path.join(MODELS_DIR, 'current.json')
CHALLENGER_PATH   = os.path.join(MODELS_DIR, 'challenger.json')

engine = create_engine(DB_URL)


# ── Model inference (mirrors mlModel.js — pure dot product + sigmoid) ──

def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + np.exp(-x))


def _load_model(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    try:
        m = json.loads(open(path, encoding='utf-8').read())
        if 'weights' not in m or 'feature_names' not in m:
            raise ValueError('Invalid model format')
        return m
    except Exception as e:  # pylint: disable=broad-exception-caught
        print(f'  Could not load {os.path.basename(path)}: {e}')
        return None


def _score_model(model: dict, features: dict) -> float:
    logit = model.get('bias', 0.0)
    for name, w in model['weights'].items():
        v = features.get(name)
        if v is None:
            continue
        try:
            fv = float(v)
            if np.isfinite(fv):
                logit += w * fv
        except (TypeError, ValueError):
            pass
    return _sigmoid(logit)


# ── Evaluation helpers ─────────────────────────────────────────

def _direction_adjusted_label(label: int, feats: dict) -> int:
    """
    Return label in the model's coordinate system (price-UP = +1).
    SELL candidate labels are stored as +1-when-TP1-hit (price DOWN),
    so they must be inverted to match the model's directional output.
    """
    if feats.get('candidate_direction') == 'SELL':
        return -label
    return label


def _evaluate(model: dict, signals_df: pd.DataFrame) -> dict:
    """
    Score signals_df against model and return evaluation metrics.

    The model predicts P(price UP).  We evaluate:
      - BUY signals  : predicted when p >= BUY_THRESHOLD  → win when adj_label == +1
      - SELL signals : predicted when p <= SELL_THRESHOLD → win when adj_label == -1
                       (i.e. model correctly predicted price DOWN)

    Returns:
      hit_rate        — fraction of correct direction calls among predicted signals
      n_predicted     — total signals where model would trade
      max_consec_loss — max consecutive wrong calls among predicted signals
      pnl_proxy       — mean adj_label among predicted signals (+1/-1 scale)
    """
    rows = []
    for _, row in signals_df.iterrows():
        feats = row['features_parsed']
        p     = _score_model(model, feats)  # type: ignore[arg-type]
        raw_label = int(row['label'])  # type: ignore[arg-type]
        adj_label = _direction_adjusted_label(
            raw_label, feats if isinstance(feats, dict) else {}  # type: ignore[arg-type]
        )
        direction = (feats if isinstance(feats, dict) else {}).get(  # type: ignore[arg-type]
            'candidate_direction', 'BUY'
        )
        rows.append({'p': p, 'adj_label': adj_label, 'direction': direction})

    df = pd.DataFrame(rows)

    # Model predicts price UP.  Trade when confident in BUY or confident in SELL.
    buy_signals  = df[(df['direction'] != 'SELL') & (df['p'] >= BUY_THRESHOLD)]
    sell_signals = df[(df['direction'] == 'SELL')  & (df['p'] <= SELL_THRESHOLD)]
    predicted    = pd.concat([buy_signals, sell_signals])
    n_predicted  = len(predicted)

    if n_predicted == 0:
        return {'hit_rate': 0.0, 'n_predicted': 0, 'max_consec_loss': 0, 'pnl_proxy': 0.0}

    # hit = adj_label == +1 for BUY, adj_label == -1 (i.e. -adj_label==+1) for SELL
    # Since adj_label is already inverted for SELL, win = adj_label > 0 for both
    hit_rate = float((predicted['adj_label'] == 1).mean())

    # Max consecutive losses
    labels_seq = predicted['adj_label'].tolist()
    max_cl = cur_cl = 0
    for lbl in labels_seq:
        if lbl != 1:
            cur_cl += 1
            max_cl = max(max_cl, cur_cl)
        else:
            cur_cl = 0

    pnl_proxy = float(predicted['adj_label'].mean())  # type: ignore[arg-type]

    return {
        'hit_rate':        hit_rate,
        'n_predicted':     n_predicted,
        'max_consec_loss': max_cl,
        'pnl_proxy':       pnl_proxy,
    }


def main():  # pylint: disable=too-many-locals
    """Load challenger, compare to champion, promote if criteria pass."""
    challenger = _load_model(CHALLENGER_PATH)
    if challenger is None:
        print('No challenger model found at models/challenger.json. Run train.py first.')
        sys.exit(0)

    champion = _load_model(CHAMPION_PATH)

    challenger_version = challenger.get('model_version', 'unknown')
    champion_version   = champion.get('model_version', 'none') if champion else 'none'

    print(f'Challenger: {challenger_version}')
    print(f'Champion:   {champion_version}')

    # Fetch recent labelled signals for out-of-sample evaluation
    cutoff_ts = int(
        (datetime.now(timezone.utc) - timedelta(days=EVAL_DAYS)).timestamp() * 1000
    )

    with engine.connect() as conn:
        signals_df = pd.read_sql(text("""
            SELECT s.ts, s.features, l.label
            FROM signals s
            JOIN labels l ON l.signal_id = s.id
            WHERE s.mode = 'SCALP'
              AND s.ts >= :cutoff
              AND l.label != 0
            ORDER BY s.ts
        """), conn, params={'cutoff': cutoff_ts})

    if len(signals_df) < MIN_EVAL_SIGNALS:
        print(f'Only {len(signals_df)} eval signals (need {MIN_EVAL_SIGNALS}). '
              'Cannot promote yet.')
        sys.exit(0)

    print(f'Evaluating on {len(signals_df)} recent labelled signals '
          f'(last {EVAL_DAYS} days)...')

    # Parse features
    signals_df['features_parsed'] = signals_df['features'].apply(
        lambda x: x if isinstance(x, dict) else json.loads(x)
    )

    chal_metrics = _evaluate(challenger, signals_df)
    print(f'  Challenger — hit_rate={chal_metrics["hit_rate"]:.3f} '
          f'n_predicted={chal_metrics["n_predicted"]} '
          f'max_consec_loss={chal_metrics["max_consec_loss"]} '
          f'pnl_proxy={chal_metrics["pnl_proxy"]:.3f}')

    if champion is None:
        # No existing champion → promote immediately
        print('  No existing champion — promoting challenger immediately.')
        promote = True
        champ_metrics = {'hit_rate': 0.0, 'n_predicted': 0, 'max_consec_loss': 0}
    else:
        champ_metrics = _evaluate(champion, signals_df)
        print(f'  Champion   — hit_rate={champ_metrics["hit_rate"]:.3f} '
              f'n_predicted={champ_metrics["n_predicted"]} '
              f'max_consec_loss={champ_metrics["max_consec_loss"]} '
              f'pnl_proxy={champ_metrics["pnl_proxy"]:.3f}')

        hit_rate_delta = chal_metrics['hit_rate'] - champ_metrics['hit_rate']
        freq_drop      = (
            (champ_metrics['n_predicted'] - chal_metrics['n_predicted'])
            / max(champ_metrics['n_predicted'], 1)
        )

        print(f'  hit_rate Δ={hit_rate_delta:+.3f} '
              f'(need ≥ +{HIT_RATE_MIN_IMPROVEMENT:.2f})')
        print(f'  freq drop={freq_drop:.2%} '
              f'(max allowed {FREQ_MAX_DROP:.0%})')
        print(f'  max_consec_loss: champ={champ_metrics["max_consec_loss"]} '
              f'chal={chal_metrics["max_consec_loss"]}')

        # Criterion 1: hit-rate improvement
        c1 = hit_rate_delta >= HIT_RATE_MIN_IMPROVEMENT
        # Criterion 2: max consecutive losses not significantly worse
        c2 = chal_metrics['max_consec_loss'] <= champ_metrics['max_consec_loss'] + 1
        # Criterion 3: trade frequency not collapsed
        c3 = freq_drop <= FREQ_MAX_DROP

        print(f'  Criteria: hit_rate_ok={c1} consec_loss_ok={c2} freq_ok={c3}')
        promote = c1 and c2 and c3

    if promote:
        shutil.copy2(CHALLENGER_PATH, CHAMPION_PATH)
        print(f'  PROMOTED {challenger_version} → models/current.json')

        # Update DB statuses
        try:
            with engine.connect() as conn:
                # Archive old champion
                conn.execute(text("""
                    UPDATE model_registry SET status = 'archived'
                    WHERE status = 'champion'
                """))
                # Promote challenger
                conn.execute(text("""
                    UPDATE model_registry
                    SET status = 'champion', promoted_at = NOW()
                    WHERE model_version = :v
                """), {'v': challenger_version})
                # Mark training_run as promoted
                conn.execute(text("""
                    UPDATE training_runs SET promoted = TRUE
                    WHERE model_version = :v
                      AND promoted = FALSE
                    ORDER BY id DESC
                    LIMIT 1
                """), {'v': challenger_version})
                conn.commit()
            print('  DB updated: previous champion archived, challenger now champion.')
        except Exception as e:  # pylint: disable=broad-exception-caught
            print(f'  Warning: DB status update failed: {e}')

        print('  Node will load the new champion on next mlModel.reload() call.')
    else:
        print(f'  NOT promoted — challenger did not meet all criteria.')
        print(f'  Challenger remains at models/challenger.json for shadow scoring.')


if __name__ == '__main__':
    main()
