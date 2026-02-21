// ==============================================================
// GoldBot — logger.js
// Coloured terminal logger + rotating daily file logger.
// Log files are written to ../../logs/goldbot-YYYY-MM-DD.log
// (relative to this file → GoldBot/logs/).
// ==============================================================

const fs   = require('fs');
const path = require('path');

// ── ANSI colour codes (terminal only) ─────────────────────────
const C = {
  reset: '\x1b[0m',
  cyan:  '\x1b[36m',
  yellow:'\x1b[33m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  gray:  '\x1b[90m',
  bold:  '\x1b[1m',
};

// ── Log directory ──────────────────────────────────────────────
// Resolves to GoldBot/logs/ regardless of cwd
const LOGS_DIR = path.resolve(__dirname, '..', '..', 'logs');

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function logFilePath() {
  const date = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  return path.join(LOGS_DIR, `goldbot-${date}.log`);
}

// ── Timestamp ──────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23) + ' UTC';
}

// ── Core emit ──────────────────────────────────────────────────
function emit(color, level, args) {
  const msg       = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const timestamp = ts();
  const padded    = level.padEnd(5);

  // Terminal — coloured
  process.stdout.write(`${color}[${timestamp}] [${padded}]${C.reset} ${msg}\n`);

  // File — plain text (no ANSI escape codes)
  try {
    fs.appendFileSync(logFilePath(), `[${timestamp}] [${padded}] ${msg}\n`);
  } catch {
    // Non-fatal: keep running even if the disk write fails
  }
}

module.exports = {
  info:  (...a) => emit(C.cyan,           'INFO',  a),
  warn:  (...a) => emit(C.yellow,         'WARN',  a),
  error: (...a) => emit(C.red,            'ERROR', a),
  trade: (...a) => emit(C.green + C.bold, 'TRADE', a),
  debug: (...a) => emit(C.gray,           'DEBUG', a),

  /** Write a plain separator line — useful for session start / daily reset. */
  separator: (char = '─', width = 54) => {
    emit(C.gray, 'INFO', [char.repeat(width)]);
  },
};
