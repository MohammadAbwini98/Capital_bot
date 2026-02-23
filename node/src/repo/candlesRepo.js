// ==============================================================
// GoldBot — repo/candlesRepo.js
// Persist OHLC candle bars to the `candles` table.
// All writes are fire-and-forget: the bot never blocks on DB I/O.
// ==============================================================

const db  = require('../db');
const cfg = require('../config');

/**
 * Batch-insert an array of closed candle bars for one timeframe.
 * Duplicate (epic, tf, ts) rows are silently ignored (ON CONFLICT).
 *
 * @param {string}   tf    'M1' | 'M5' | 'M15' | 'H1' | 'H4'
 * @param {object[]} bars  Array of { time, open, high, low, close, vol }
 */
async function insertCandles(tf, bars) {
  if (!db.isEnabled() || !bars.length) return;

  // Build a multi-row VALUES clause
  const valueClauses = [];
  const params       = [];
  let   idx          = 1;

  for (const b of bars) {
    valueClauses.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    params.push(cfg.EPIC, tf, b.time, b.open, b.high, b.low, b.close, b.vol ?? 0);
  }

  const sql = `
    INSERT INTO candles (epic, tf, ts, open, high, low, close, vol)
    VALUES ${valueClauses.join(',')}
    ON CONFLICT (epic, tf, ts) DO NOTHING
  `;

  // Fire-and-forget: errors are swallowed inside db.query()
  db.query(sql, params);
}

module.exports = { insertCandles };
