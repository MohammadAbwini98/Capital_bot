// ==============================================================
// GoldBot — mlModel.js
// Logistic regression inference against a JSON model file.
// No Python needed at runtime — pure Node.js dot product + sigmoid.
//
// Model JSON format (exported by trainer/export_model.py):
// {
//   "model_version": "2026-02-24_01",
//   "feature_names": ["spread_norm", "m15_ema200_dist_atr", ...],
//   "bias":    -0.12,
//   "weights": { "spread_norm": 0.8, "m15_ema200_dist_atr": -0.3, ... }
// }
//
// score() returns p(up) in [0, 1].
//  - BUY  entry: require p >= ML_BUY_THRESHOLD  (default 0.60)
//  - SELL entry: require p <= ML_SELL_THRESHOLD  (default 0.40)
// ==============================================================

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const MODEL_PATH = path.resolve(__dirname, '../../models/current.json');

let _model = null;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function _load() {
  if (!fs.existsSync(MODEL_PATH)) {
    log.debug('[ML] No model file at models/current.json — confidence filter inactive.');
    return null;
  }
  try {
    const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    if (!m.weights || !m.feature_names) throw new Error('Invalid model format');
    log.info(
      `[ML] Model loaded: version=${m.model_version} ` +
      `features=${m.feature_names.length} bias=${m.bias?.toFixed(4)}`
    );
    return m;
  } catch (e) {
    log.warn(`[ML] Failed to load model: ${e.message}`);
    return null;
  }
}

/** Force-reload the model from disk (e.g., after nightly retrain). */
function reload() {
  _model = _load();
}

/**
 * Score a feature snapshot against the loaded model.
 *
 * @param {object} features  Plain object whose keys map to model.feature_names
 * @returns {{ score: number, version: string } | null}
 *   null when no model is loaded (caller should allow the trade).
 */
function score(features) {
  if (!_model) return null;

  let logit = _model.bias ?? 0;
  for (const [name, w] of Object.entries(_model.weights)) {
    const v = features[name];
    if (v !== undefined && v !== null && isFinite(v)) {
      logit += w * v;
    }
  }

  return {
    score:   sigmoid(logit),
    version: _model.model_version ?? 'unknown',
  };
}

// Load at module import time
reload();

module.exports = { reload, score };
