// ==============================================================
// GoldBot — repo/signalsRepo.js
// Persist one decision-point row per M5/H1 candle close to the
// `signals` table.  This is the primary training dataset.
// ==============================================================

const db  = require('../db');
const log = require('../logger');

/**
 * Insert one signal row.
 * Returns the new row's `id` (bigint as string), or null on failure.
 *
 * @param {object} sig
 * @param {string}  sig.epic
 * @param {number}  sig.ts             Decision timestamp (ms)
 * @param {string}  sig.mode           'SCALP' | 'SWING'
 * @param {string}  sig.action         e.g. 'HOLD', 'BUY_EXEC', 'SKIP_RISK'
 * @param {object}  sig.reasons        Gate outputs (booleans + labels)
 * @param {object}  sig.features       Indicator snapshot (numbers)
 * @param {string=} sig.modelVersion   Null when no model loaded
 * @param {number=} sig.modelScore     p(up) from model, null if no model
 * @returns {Promise<string|null>}
 */
async function insertSignal({ epic, ts, mode, action, reasons, features, modelVersion = null, modelScore = null }) {
  if (!db.isEnabled()) return null;

  const sql = `
    INSERT INTO signals (epic, ts, mode, action, reasons, features, model_version, model_score)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `;
  const res = await db.query(sql, [
    epic, ts, mode, action,
    JSON.stringify(reasons),
    JSON.stringify(features),
    modelVersion,
    modelScore,
  ]);

  return res?.rows?.[0]?.id?.toString() ?? null;
}

module.exports = { insertSignal };
