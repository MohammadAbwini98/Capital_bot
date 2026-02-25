// ==============================================================
// GoldBot — mlModel.js
// Logistic regression inference against JSON model files.
// No Python needed at runtime — pure Node.js dot product + sigmoid.
//
// Model JSON format (exported by trainer/train.py):
// {
//   "model_version": "2026-02-24_01",
//   "feature_names": ["spread_norm", "m15_ema200_dist_atr", ...],
//   "bias":    -0.12,
//   "weights": { "spread_norm": 0.8, "m15_ema200_dist_atr": -0.3, ... }
// }
//
// score()            → champion model  (acts on trades)
// scoreChallenger()  → challenger model (shadow — never acts)
//
// Champion/Challenger files:
//   models/current.json    — active champion (promoted by promote.py)
//   models/challenger.json — latest trained candidate (written by train.py)
// ==============================================================

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const CHAMPION_PATH   = path.resolve(__dirname, '../../models/current.json');
const CHALLENGER_PATH = path.resolve(__dirname, '../../models/challenger.json');

let _champion   = null;
let _challenger = null;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function _loadFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!m.weights || !m.feature_names) throw new Error('Invalid model format');
    return m;
  } catch (e) {
    log.warn(`[ML] Failed to load ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

function _scoreModel(model, features) {
  if (!model) return null;

  let logit = model.bias ?? 0;
  for (const [name, w] of Object.entries(model.weights)) {
    const v = features[name];
    if (v !== undefined && v !== null && isFinite(v)) {
      logit += w * v;
    }
  }

  return {
    score:   sigmoid(logit),
    version: model.model_version ?? 'unknown',
  };
}

/** Force-reload both champion and challenger from disk. */
function reload() {
  _champion = _loadFile(CHAMPION_PATH);
  if (_champion) {
    log.info(
      `[ML] Champion loaded: version=${_champion.model_version} ` +
      `features=${_champion.feature_names.length} bias=${_champion.bias?.toFixed(4)}`
    );
  } else {
    log.debug('[ML] No champion at models/current.json — confidence filter inactive.');
  }

  _challenger = _loadFile(CHALLENGER_PATH);
  if (_challenger) {
    log.info(
      `[ML] Challenger loaded (shadow): version=${_challenger.model_version} ` +
      `features=${_challenger.feature_names.length}`
    );
  }
}

/**
 * Score features against the champion model.
 * Returns null when no champion is loaded (caller allows the trade).
 */
function score(features) {
  return _scoreModel(_champion, features);
}

/**
 * Score features against the challenger model (shadow mode).
 * Result is logged/stored but NEVER used to block or allow trades.
 * Returns null when no challenger is loaded.
 */
function scoreChallenger(features) {
  return _scoreModel(_challenger, features);
}

// Load at module import time
reload();

module.exports = { reload, score, scoreChallenger };
