// ==============================================================
// GoldBot — state.js
// Bot runtime state: daily counters, setups, open positions,
// risk gates, and daily reset logic.
// ==============================================================

const cfg = require('./config');
const log = require('./logger');

// ── Daily counters ─────────────────────────────────────────
let dayRealizedPnlUsd = 0;
let tradesToday       = 0;
let consecutiveLosses = 0;
let dayStartEquity    = 0;

// ── Setup state ────────────────────────────────────────────
/** @type {{ active:boolean, direction?:string, createdTime?:number, pullbackExtreme?:number }} */
let setupScalp = { active: false };
/** @type {{ active:boolean, direction?:string, createdTime?:number, pullbackExtreme?:number }} */
let setupSwing = { active: false };

// ── Open positions (bot-tracked, complementing platform) ──
/**
 * @typedef {{ mode:string, direction:string, size:number,
 *             entry:number, sl:number, tp1:number, tp2:number,
 *             tp1Done:boolean, dealId:string,
 *             dealReference:string, openedTime:number }} Position
 * @type {Position[]}
 */
let openPositions = [];

// ══════════════════════════════════════════════════════════
// Risk gates
// ══════════════════════════════════════════════════════════

function riskOK() {
  if (tradesToday >= cfg.MAX_TRADES_PER_DAY) {
    log.warn(`[Risk] Daily trade limit reached (${tradesToday}/${cfg.MAX_TRADES_PER_DAY})`);
    return false;
  }
  if (dayRealizedPnlUsd <= -cfg.DAILY_LOSS_LIMIT_USD) {
    log.warn(`[Risk] Daily loss limit reached (P&L: $${dayRealizedPnlUsd.toFixed(2)})`);
    return false;
  }
  if (consecutiveLosses >= cfg.MAX_CONSECUTIVE_LOSSES) {
    log.warn(`[Risk] Max consecutive losses reached (${consecutiveLosses})`);
    return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════
// Position tracking
// ══════════════════════════════════════════════════════════

/**
 * Add a new position and increment tradesToday.
 * @param {Position} pos
 */
function addPosition(pos) {
  openPositions.push(pos);
  tradesToday += 1;
  log.info(`[State] Position added: ${pos.mode} ${pos.direction} dealId=${pos.dealId} | trades_today=${tradesToday}`);
}

/**
 * Adopt an existing platform position discovered at startup.
 * Does NOT increment tradesToday (the trade was already counted/not ours).
 * @param {Position} pos
 */
function adoptPosition(pos) {
  openPositions.push(pos);
  log.info(`[State] Position adopted from platform: ${pos.mode} ${pos.direction} dealId=${pos.dealId}`);
}

/**
 * Add a replacement position (TP1 partial-close reopen).
 * Does NOT increment tradesToday.
 */
function replacePosition(oldDealId, newPos) {
  openPositions = openPositions.filter(p => p.dealId !== oldDealId);
  openPositions.push(newPos);
  log.info(`[State] Position replaced: old=${oldDealId} → new=${newPos.dealId}`);
}

function removePosition(dealId) {
  openPositions = openPositions.filter(p => p.dealId !== dealId);
}

function getPositions() {
  return openPositions;
}

// ══════════════════════════════════════════════════════════
// P&L tracking
// ══════════════════════════════════════════════════════════

/**
 * Update day P&L and consecutive-loss counter after a close.
 * @param {number}  pnlUsd  Realised profit/loss in USD
 * @param {boolean} isLoss
 */
function updatePnL(pnlUsd, isLoss) {
  dayRealizedPnlUsd += pnlUsd;
  if (isLoss) {
    consecutiveLosses += 1;
  } else {
    consecutiveLosses = 0;
  }
  log.info(
    `[State] P&L update: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} | ` +
    `day_pnl=$${dayRealizedPnlUsd.toFixed(2)} | consec_losses=${consecutiveLosses}`
  );
}

// ══════════════════════════════════════════════════════════
// Setup accessors
// ══════════════════════════════════════════════════════════

function getSetupScalp()   { return setupScalp; }
function setSetupScalp(s)  { setupScalp = s; }
function getSetupSwing()   { return setupSwing; }
function setSetupSwing(s)  { setupSwing = s; }

// ══════════════════════════════════════════════════════════
// Daily reset
// ══════════════════════════════════════════════════════════

/**
 * Reset all day-scoped counters and setups.
 * Called at UTC midnight and on startup.
 * @param {number} equity  Available account balance at reset time
 */
function dailyReset(equity = 0) {
  dayStartEquity    = equity;
  dayRealizedPnlUsd = 0;
  tradesToday       = 0;
  consecutiveLosses = 0;
  setupScalp        = { active: false };
  setupSwing        = { active: false };
  log.info(`[State] Daily reset. Start equity: $${dayStartEquity.toFixed(2)}`);
}

/**
 * Summary snapshot for status logging.
 */
function getStats() {
  return {
    dayRealizedPnlUsd,
    tradesToday,
    consecutiveLosses,
    openCount: openPositions.length,
  };
}

module.exports = {
  riskOK,
  addPosition, adoptPosition, replacePosition, removePosition, getPositions,
  updatePnL,
  getSetupScalp, setSetupScalp,
  getSetupSwing, setSetupSwing,
  dailyReset,
  getStats,
};
