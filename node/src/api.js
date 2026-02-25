// ==============================================================
// GoldBot — api.js
// Capital.com REST client: session, candles, prices, positions.
//
// Capital.com uses a TWO-STEP deal flow:
//   1. POST/DELETE /positions  → returns only { dealReference }
//   2. GET /confirms/{dealReference} → returns dealStatus + dealId
// Both createPosition() and closePosition() follow this pattern.
// ==============================================================

const axios = require('axios');
const cfg   = require('./config');
const log   = require('./logger');

// ── Live session tokens ────────────────────────────────────────
let _cst          = null;
let _secToken     = null;
let _accountId    = null;   // currentAccountId returned by POST /session
let _refreshTimer = null;

// ── Per-epic decimal precision cache ──────────────────────────
// Populated lazily by getMarketInfo(); used by roundForEpic().
const _epicDecimals = {};

// ── Helpers ───────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function authHeaders() {
  const h = {
    'X-SECURITY-TOKEN': _secToken,
    'CST':              _cst,
    'Content-Type':     'application/json',
  };
  // Capital.com requires X-CAP-ACCOUNT-ID on all authenticated calls;
  // without it the server cannot resolve which account to operate on
  // and returns {"errorCode":"error.null.accountId"}.
  if (_accountId) h['X-CAP-ACCOUNT-ID'] = _accountId;
  return h;
}

function mid({ bid, ask }) {
  return (bid + ask) / 2;
}

function round(v, decimals = 2) {
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}

function parseCapTime(str) {
  if (!str) return 0;
  const s = str.replace(/\//g, '-').replace(' ', 'T');
  return new Date(s.includes('Z') ? s : s + 'Z').getTime();
}

// ── Deal confirmation (two-step flow) ─────────────────────────

/**
 * Poll GET /confirms/{dealReference} until dealStatus resolves.
 * Capital.com's POST/DELETE /positions returns only a dealReference;
 * the actual outcome must be confirmed via this endpoint.
 *
 * @param {string} dealReference
 * @param {number} retries   Maximum polling attempts
 * @param {number} delayMs   Delay between attempts in ms
 * @returns {Promise<object>} Confirmed deal data
 */
async function _confirmDeal(dealReference, retries = 6, delayMs = 500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    await sleep(delayMs);

    const res = await axios.get(
      `${cfg.baseUrl}/api/v1/confirms/${dealReference}`,
      { headers: authHeaders() }
    );

    const data       = res.data;
    const dealStatus = data.dealStatus;

    if (dealStatus === 'ACCEPTED') {
      return data;
    }
    if (dealStatus && dealStatus !== 'ACCEPTED') {
      throw new Error(`Deal ${dealReference} rejected: ${JSON.stringify(data)}`);
    }

    // dealStatus absent — API still processing, retry
    log.debug(`[API] Confirm attempt ${attempt + 1}/${retries} — awaiting dealStatus for ${dealReference}`);
  }

  throw new Error(`Deal confirmation timed out after ${retries} attempts: ${dealReference}`);
}

// ══════════════════════════════════════════════════════════════
// Session
// ══════════════════════════════════════════════════════════════

/**
 * Authenticate and store CST + X-SECURITY-TOKEN.
 * Also schedules automatic session refresh.
 */
async function createSession() {
  let res;
  try {
    res = await axios.post(
      `${cfg.baseUrl}/api/v1/session`,
      { identifier: cfg.email, password: cfg.password, encryptedPassword: false },
      { headers: { 'X-CAP-API-KEY': cfg.apiKey, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const body = err.response?.data;
    const hint = cfg.accountType === 'demo'
      ? ' (to use demo mode: open Capital.com app → account switcher → Add account → Demo)'
      : '';
    throw new Error(
      `Authentication failed [${err.response?.status}]${hint}: ` +
      (body ? JSON.stringify(body) : err.message)
    );
  }

  _cst       = res.headers['cst'];
  _secToken  = res.headers['x-security-token'];
  _accountId = res.data.currentAccountId ?? null;

  // Log all available accounts so the user can identify their demo account ID
  const accounts = res.data.accounts || [];
  if (accounts.length > 1) {
    log.debug('[API] Available accounts:');
    for (const a of accounts) {
      log.debug(`[API]   id=${a.accountId}  name=${a.accountName}  preferred=${a.preferred}  balance=${a.balance?.available}`);
    }
  }

  // Switch to the configured account (e.g. a demo account) if it differs.
  // Correct endpoint: PUT /api/v1/session with { accountId } in the body.
  // (NOT /session/account/{id} — that returns 404.)
  if (cfg.accountId && cfg.accountId !== _accountId) {
    try {
      log.info(`[API] Switching account: ${_accountId} → ${cfg.accountId}...`);
      const switchRes = await axios.put(
        `${cfg.baseUrl}/api/v1/session`,
        { accountId: cfg.accountId },
        { headers: authHeaders() }
      );
      // Capital.com issues new tokens after an account switch
      if (switchRes.headers['cst'])              _cst       = switchRes.headers['cst'];
      if (switchRes.headers['x-security-token']) _secToken  = switchRes.headers['x-security-token'];
      _accountId = cfg.accountId;
      log.info(`[API] Account switched to: ${_accountId}`);
    } catch (e) {
      log.warn(`[API] Account switch failed (will use default): ${e.message}`);
    }
  }

  log.info(
    `[API] Session ready — accountId=${_accountId ?? 'none'} | type: ${cfg.accountType.toUpperCase()}`
  );

  // Auto-refresh before expiry (Capital.com tokens expire after ~10 min)
  clearInterval(_refreshTimer);
  _refreshTimer = setInterval(async () => {
    try {
      await createSession();
      log.info('[API] Session refreshed.');
    } catch (e) {
      log.error(`[API] Session refresh failed: ${e.message}`);
    }
  }, cfg.SESSION_REFRESH_MS);
}

/**
 * Logout and stop the refresh timer.
 */
async function destroySession() {
  clearInterval(_refreshTimer);
  if (!_cst) return;
  try {
    await axios.delete(`${cfg.baseUrl}/api/v1/session`, { headers: authHeaders() });
  } catch { /* non-fatal */ }
  _cst = _secToken = _accountId = null;
  log.info('[API] Session destroyed.');
}

// ══════════════════════════════════════════════════════════════
// Market data
// ══════════════════════════════════════════════════════════════

/**
 * Fetch OHLC candles.
 * @param {string} epic        e.g. 'XAUUSD'
 * @param {string} resolution  'MINUTE_5' | 'MINUTE_15' | 'HOUR' | 'HOUR_4'
 * @param {number} max         Number of bars (including current in-progress bar)
 * @returns {{ time:number, open:number, high:number, low:number, close:number, vol:number }[]}
 */
async function getCandles(epic, resolution, max = 200) {
  const res = await axios.get(
    `${cfg.baseUrl}/api/v1/prices/${epic}`,
    { params: { resolution, max }, headers: authHeaders() }
  );

  return (res.data.prices || []).map(p => ({
    time:  parseCapTime(p.snapshotTimeUTC || p.snapshotTime),
    open:  mid(p.openPrice),
    high:  mid(p.highPrice),
    low:   mid(p.lowPrice),
    close: mid(p.closePrice),
    vol:   p.lastTradedVolume || 0,
  })).sort((a, b) => a.time - b.time);
}

/**
 * Fetch current bid/ask and market status for an epic.
 * Also caches the instrument's decimal precision for use in roundForEpic().
 * @returns {{ bid:number, ask:number, status:string }}
 *   status: 'TRADEABLE' | 'CLOSED' | 'EDITS_ONLY' | 'OFFLINE' | 'SUSPENDED' | ...
 */
async function getPrice(epic) {
  const res = await axios.get(
    `${cfg.baseUrl}/api/v1/markets/${epic}`,
    { headers: authHeaders() }
  );
  const s = res.data.snapshot;

  // Cache decimal precision from instrument info if available
  if (!(epic in _epicDecimals)) {
    const factor = res.data.instrument?.decimalPlacesFactor;
    if (factor && factor > 0) {
      // decimalPlacesFactor = 10^n  →  n = log10(factor)
      _epicDecimals[epic] = Math.round(Math.log10(factor));
    } else {
      // Default: 2 decimal places (safe for most CFDs)
      _epicDecimals[epic] = 2;
    }
    log.debug(`[API] ${epic} precision: ${_epicDecimals[epic]} dp (factor=${factor})`);
  }

  return { bid: s.bid, ask: s.offer, status: s.marketStatus ?? 'UNKNOWN' };
}

/**
 * Round a price to the correct number of decimal places for this epic.
 * Falls back to 2 dp if the cache has not been populated yet.
 * @param {number} v
 * @param {string} epic
 * @returns {number}
 */
function roundForEpic(v, epic) {
  const dp = _epicDecimals[epic] ?? 2;
  return round(v, dp);
}

/**
 * Recover realized PnL from activity history for a closed position.
 * Returns null when no matching close event is found or the fetch fails.
 *
 * @param {string} dealId
 * @param {number} openedTimeMs  Position open time (epoch ms) — used as `from` filter
 * @returns {Promise<number|null>}
 */
async function recoverPnlFromHistory(dealId, openedTimeMs) {
  try {
    const activities = await getDayActivity(openedTimeMs);
    const closeEvent = activities.find(a =>
      a.dealId === dealId &&
      (a.type?.toLowerCase()   === 'position') &&
      (a.status?.toLowerCase() === 'closed')
    );
    if (closeEvent) {
      const pnl = closeEvent.details?.profit ?? closeEvent.profit ?? null;
      log.debug(`[API] History PnL for ${dealId}: ${pnl}`);
      return typeof pnl === 'number' ? pnl : null;
    }
  } catch (e) {
    log.debug(`[API] recoverPnlFromHistory failed for ${dealId}: ${e.message}`);
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// Account
// ══════════════════════════════════════════════════════════════

/**
 * Fetch the currently active account details.
 * Returns the account whose accountId matches the active session account,
 * falling back to the first account in the list if no match is found.
 * @returns {{ accountId:string, balance: { available:number } } | null}
 */
async function getAccount() {
  const res = await axios.get(
    `${cfg.baseUrl}/api/v1/accounts`,
    { headers: authHeaders() }
  );
  const accounts = res.data.accounts || [];
  // Return the account matching the active session accountId (Bug #2 fix)
  return accounts.find(a => a.accountId === _accountId) ?? accounts[0] ?? null;
}

// ══════════════════════════════════════════════════════════════
// Positions
// ══════════════════════════════════════════════════════════════

/**
 * Fetch all open positions from the platform.
 */
async function getPositions() {
  const res = await axios.get(
    `${cfg.baseUrl}/api/v1/positions`,
    { headers: authHeaders() }
  );
  return res.data.positions || [];
}

/**
 * Place a market order with SL and TP.
 *
 * Capital.com two-step flow:
 *   1. POST /positions → { dealReference }   (pending)
 *   2. GET  /confirms/{dealReference} → { dealStatus, dealId, ... }
 *
 * @param {object} p
 * @param {string}          p.epic
 * @param {'BUY'|'SELL'}    p.direction
 * @param {number}          p.size
 * @param {number}          p.stopLevel     Absolute SL price
 * @param {number}          p.profitLevel   Absolute TP price
 * @returns {{ dealId:string, dealReference:string }}
 */
async function createPosition({ epic, direction, size, stopLevel, profitLevel }) {
  const body = {
    epic,
    direction,
    size,
    guaranteedStop: false,
    stopLevel:   roundForEpic(stopLevel, epic),
    profitLevel: roundForEpic(profitLevel, epic),
  };

  log.trade(`[API] createPosition → ${direction} ${size} ${epic} | SL=${body.stopLevel} TP=${body.profitLevel}`);

  const res = await axios.post(
    `${cfg.baseUrl}/api/v1/positions`,
    body,
    { headers: authHeaders() }
  );

  const dealReference = res.data.dealReference;
  if (!dealReference) {
    throw new Error(`No dealReference in createPosition response: ${JSON.stringify(res.data)}`);
  }

  log.debug(`[API] createPosition — dealReference=${dealReference} — awaiting confirmation...`);
  const confirmed = await _confirmDeal(dealReference);

  // dealId may be at the top level or inside affectedDeals[0]
  let dealId = confirmed.dealId;
  if (!dealId) {
    const affected = confirmed.affectedDeals || [];
    if (affected.length) dealId = affected[0].dealId;
  }
  if (!dealId) {
    throw new Error(`No dealId in confirmation: ${JSON.stringify(confirmed)}`);
  }

  const affectedStatuses = (confirmed.affectedDeals || []).map(d => d.status).join(',');
  log.info(
    `[API] Deal confirmed: dealId=${dealId} status=${confirmed.dealStatus}` +
    (affectedStatuses ? ` affectedDeals=[${affectedStatuses}]` : '')
  );
  return { dealId, dealReference };
}

/**
 * Close a position in full.
 *
 * Capital.com two-step flow:
 *   1. DELETE /positions/{dealId} → { dealReference }  (pending)
 *   2. GET    /confirms/{dealReference} → { dealStatus, ... }
 *
 * @param {string} dealId
 */
async function closePosition(dealId) {
  log.trade(`[API] closePosition → dealId=${dealId}`);

  const res = await axios.delete(
    `${cfg.baseUrl}/api/v1/positions/${dealId}`,
    { headers: authHeaders() }
  );

  const dealReference = res.data.dealReference;
  if (!dealReference) {
    throw new Error(`No dealReference in closePosition response: ${JSON.stringify(res.data)}`);
  }

  log.debug(`[API] closePosition — dealReference=${dealReference} — awaiting confirmation...`);
  const confirmed = await _confirmDeal(dealReference);
  log.info(`[API] Close confirmed: dealId=${dealId} status=${confirmed.dealStatus}`);
  return confirmed;
}

/**
 * Update a position's SL and/or TP.
 * @param {string} dealId
 * @param {{ stopLevel?:number, profitLevel?:number }} updates
 */
async function updatePosition(dealId, { stopLevel, profitLevel, epic = cfg.EPIC } = {}) {
  const body = {};
  if (stopLevel   !== undefined) body.stopLevel   = roundForEpic(stopLevel,   epic);
  if (profitLevel !== undefined) body.profitLevel = roundForEpic(profitLevel, epic);

  const res = await axios.put(
    `${cfg.baseUrl}/api/v1/positions/${dealId}`,
    body,
    { headers: authHeaders() }
  );
  return res.data;
}

/**
 * Fetch a single open position by dealId.
 * Returns the position object, or null if it no longer exists (404).
 * Used by reconcilePositions() to confirm a position is truly closed.
 */
async function getPosition(dealId) {
  try {
    const res = await axios.get(
      `${cfg.baseUrl}/api/v1/positions/${dealId}`,
      { headers: authHeaders() }
    );
    return res.data ?? null;
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

/**
 * Fetch account activity history from a given timestamp.
 * Used to recover realized PnL for broker-closed positions.
 *
 * Capital.com endpoint: GET /api/v1/history/activity
 * @param {number} fromMs  Start timestamp in milliseconds
 * @returns {Promise<object[]>} Array of activity records
 */
async function getDayActivity(fromMs) {
  const from = new Date(fromMs).toISOString().replace(/\.\d{3}Z$/, '');
  const res = await axios.get(
    `${cfg.baseUrl}/api/v1/history/activity`,
    { params: { from, detailed: true }, headers: authHeaders() }
  );
  return res.data.activities || [];
}

module.exports = {
  createSession,
  destroySession,
  getCandles,
  getPrice,
  getAccount,
  getPositions,
  getPosition,
  getDayActivity,
  recoverPnlFromHistory,
  createPosition,
  closePosition,
  updatePosition,
};
