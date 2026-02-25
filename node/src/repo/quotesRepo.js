// ==============================================================
// GoldBot — repo/quotesRepo.js
// Persist bid/ask tick snapshots to the `quotes` table.
// Designed for batch inserts: the caller accumulates rows in a
// buffer and calls insertQuotesBatch() once per minute to avoid
// per-tick DB round-trips.
// ==============================================================

const db  = require('../db');
const cfg = require('../config');

/**
 * Batch-insert an array of tick snapshots for one epic.
 * Duplicate (epic, ts) rows are silently ignored (ON CONFLICT).
 *
 * @param {string}   epic
 * @param {Array<{ ts:number, bid:number, ask:number, spread:number, status:string }>} rows
 */
async function insertQuotesBatch(epic, rows) {
  if (!db.isEnabled() || !rows.length) return;

  const valueClauses = [];
  const params       = [];
  let   idx          = 1;

  for (const r of rows) {
    valueClauses.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    params.push(epic ?? cfg.EPIC, r.ts, r.bid, r.ask, r.spread, r.status ?? null);
  }

  const sql = `
    INSERT INTO quotes (epic, ts, bid, ask, spread, status)
    VALUES ${valueClauses.join(',')}
    ON CONFLICT (epic, ts) DO NOTHING
  `;

  // Fire-and-forget: errors are swallowed inside db.query()
  db.query(sql, params);
}

module.exports = { insertQuotesBatch };
