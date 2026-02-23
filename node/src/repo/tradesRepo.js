// ==============================================================
// GoldBot — repo/tradesRepo.js
// Persist trade open / close events to the `trades` table.
// ==============================================================

const db = require('../db');

/**
 * Insert a newly opened trade.
 * @param {object} t
 * @param {string}  t.dealId
 * @param {string}  t.epic
 * @param {number}  t.openedTs     Timestamp (ms)
 * @param {string}  t.direction    'BUY' | 'SELL'
 * @param {number}  t.size
 * @param {number}  t.entry
 * @param {number}  t.sl
 * @param {number}  t.tp2
 * @param {string}  t.mode         'SCALP' | 'SWING'
 */
async function insertTrade({ dealId, epic, openedTs, direction, size, entry, sl, tp2, mode }) {
  if (!db.isEnabled()) return;

  const sql = `
    INSERT INTO trades (deal_id, epic, opened_ts, direction, size, entry, sl, tp2, mode, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')
    ON CONFLICT (deal_id) DO NOTHING
  `;
  db.query(sql, [dealId, epic, openedTs, direction, size, entry, sl, tp2, mode]);
}

/**
 * Mark a trade as closed.
 * @param {object} c
 * @param {string}  c.dealId
 * @param {number}  c.closedTs     Timestamp (ms)
 * @param {number=} c.exit         Exit price (null for broker-close)
 * @param {number=} c.realizedPnl  Realised P&L in account currency
 * @param {string=} c.closeReason  'SL_HIT' | 'TP1_HIT' | 'TP2_HIT' | 'BROKER_CLOSE'
 */
async function closeTrade({ dealId, closedTs, exit = null, realizedPnl = null, closeReason = null }) {
  if (!db.isEnabled()) return;

  const sql = `
    UPDATE trades
    SET closed_ts = $2, exit = $3, realized_pnl = $4, close_reason = $5, status = 'CLOSED'
    WHERE deal_id = $1
  `;
  db.query(sql, [dealId, closedTs, exit, realizedPnl, closeReason]);
}

module.exports = { insertTrade, closeTrade };
