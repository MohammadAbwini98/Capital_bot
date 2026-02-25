// ==============================================================
// GoldBot — repo/predictionsRepo.js
// Log one prediction row per model scoring event.
//
// Two rows are written per evaluated signal:
//   shadow=false  champion score (may have acted=true if trade placed)
//   shadow=true   challenger score (acted always false — shadow only)
//
// This table is the primary data source for promote.py's
// champion-vs-challenger comparison.
// ==============================================================

const db  = require('../db');
const log = require('../logger');

/**
 * @param {object} p
 * @param {string|number} p.signalId   signals.id (bigint as string or number)
 * @param {string}        p.modelId    model_version string
 * @param {number}        p.pWin       probability in [0,1]
 * @param {boolean}       p.acted      true when a trade was placed on this score
 * @param {boolean}       [p.shadow]   true for challenger shadow scores
 * @param {number}        p.ts         epoch ms (candle timestamp)
 */
async function insertPrediction({ signalId, modelId, pWin, acted, shadow = false, ts }) {
  if (!db.isEnabled() || !signalId) return;
  try {
    await db.query(
      `INSERT INTO predictions (signal_id, model_id, p_win, acted, shadow, ts)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [signalId, modelId, pWin, acted, shadow, ts]
    );
  } catch (e) {
    log.debug(`[Predictions] Insert failed: ${e.message}`);
  }
}

module.exports = { insertPrediction };
