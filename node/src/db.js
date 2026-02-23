// ==============================================================
// GoldBot — db.js
// Optional PostgreSQL connection pool.
// All DB operations are no-ops when DB_URL is not set or the
// database is unreachable — the trading bot continues to work.
// ==============================================================

const cfg = require('./config');
const log = require('./logger');

let _pool    = null;
let _enabled = false;

// Lazy-init: only creates the pool when DB_URL is configured
function _getPool() {
  if (_pool) return _pool;
  if (!cfg.DB_URL) return null;

  // pg is an optional dependency — require lazily so the bot starts
  // even when pg is not installed.
  try {
    const { Pool } = require('pg');
    _pool = new Pool({ connectionString: cfg.DB_URL });
    _pool.on('error', (err) => {
      log.warn(`[DB] Pool error: ${err.message}`);
    });
  } catch (e) {
    log.warn(`[DB] pg module not found — install with: npm install pg`);
    _pool = null;
  }
  return _pool;
}

/**
 * Run a parameterised SQL query.
 * Returns the pg Result, or null if DB is disabled/unavailable.
 * Never throws — callers do not need try/catch.
 */
async function query(sql, params = []) {
  const pool = _getPool();
  if (!pool) return null;
  try {
    return await pool.query(sql, params);
  } catch (e) {
    log.debug(`[DB] Query error: ${e.message}`);
    return null;
  }
}

/**
 * Test connection and initialise the pool.
 * Called once at startup from index.js.
 */
async function init() {
  if (!cfg.DB_URL) {
    log.info('[DB] DB_URL not set — ML data logging disabled.');
    return;
  }
  const res = await query('SELECT 1');
  if (res) {
    _enabled = true;
    log.info('[DB] Database connection established. ML data logging active.');
  } else {
    log.warn('[DB] Could not connect to database — ML data logging disabled.');
  }
}

/**
 * Drain and close the pool on shutdown.
 */
async function close() {
  if (_pool) {
    try { await _pool.end(); } catch { /* non-fatal */ }
    _pool    = null;
    _enabled = false;
  }
}

function isEnabled() { return _enabled; }

module.exports = { query, init, close, isEnabled };
