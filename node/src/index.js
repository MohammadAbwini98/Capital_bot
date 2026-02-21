// ==============================================================
// GoldBot — index.js  (Node.js entry point)
// Starts the bot: authenticate → load history → polling loops.
// ==============================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../..', '.env') });

const api      = require('./api');
const cs       = require('./candleStore');
const state    = require('./state');
const strategy = require('./strategy');
const cfg      = require('./config');
const log      = require('./logger');
const ind      = require('./indicators');
const telegram = require('./telegram');

let shutting = false;
const timers = [];

// ══════════════════════════════════════════════════════════════
// Startup
// ══════════════════════════════════════════════════════════════

async function main() {
  log.separator('═');
  log.info('        GoldBot — XAUUSD Trend-Following Scalp Bot');
  log.separator('═');
  log.info(`Account type    : ${cfg.accountType.toUpperCase()}`);
  log.info(`Instrument      : ${cfg.EPIC}`);
  log.info(`Swing mode      : ${cfg.swingEnabled ? 'ON  (H1 + H4)' : 'OFF (M5 + M15 only)'}`);
  log.info(`Max trades/day  : ${cfg.MAX_TRADES_PER_DAY}`);
  log.info(`Daily loss limit: $${cfg.DAILY_LOSS_LIMIT_USD}`);
  log.info(`Max consec losses: ${cfg.MAX_CONSECUTIVE_LOSSES}`);
  log.info(`Spread max      : ${cfg.SPREAD_MAX}`);
  log.info(`Scalp size      : ${cfg.SCALP_SIZE_UNITS} unit(s)`);
  log.info(`TP targets      : TP1=${cfg.TP1_R}R  TP2=${cfg.TP2_R_SCALP}R (scalp)`);
  log.info(`SL buffer       : ${cfg.SL_BUFFER_ATR} × ATR`);
  log.separator('─');

  // Step 1: authenticate
  log.info('[Main] Authenticating with Capital.com...');
  await api.createSession();

  // Step 2: daily reset with current equity
  let equity = 0;
  try {
    const acct = await api.getAccount();
    equity = acct?.balance?.available ?? 0;
    log.info(`[Main] Account balance: $${equity.toFixed(2)}`);
  } catch (e) {
    log.warn(`[Main] Could not fetch account balance: ${e.message}`);
  }
  state.dailyReset(equity);

  // Telegram startup ping (non-blocking)
  telegram.notifyBotStarted({ epic: cfg.EPIC, accountType: cfg.accountType, equity }).catch(() => {});

  // Step 3: load candle history for all active TFs
  log.info('[Main] Loading candle history...');
  await cs.loadHistory();
  log.info('[Main] Candle history ready.');

  // Step 4: log any open positions already on the platform
  try {
    const platformPos = await api.getPositions();
    if (platformPos.length) {
      log.warn(
        `[Main] ${platformPos.length} position(s) already open on platform — ` +
        'these are NOT tracked by the bot (they will be managed by their own SL/TP).'
      );
    } else {
      log.info('[Main] No existing platform positions found.');
    }
  } catch (e) {
    log.warn(`[Main] Could not check platform positions: ${e.message}`);
  }

  // Step 5: start polling loops
  log.separator('─');
  log.info('[Main] Starting polling loops...');

  // ── Tick loop: position management every 5 s ──
  timers.push(setInterval(async () => {
    if (shutting) return;
    try {
      await strategy.managePositions();
    } catch (e) {
      if (!shutting) log.warn(`[Tick] Error: ${e.message}`);
    }
  }, cfg.TICK_POLL_MS));

  // ── M5 poll: detect candle close every 30 s ──
  timers.push(setInterval(async () => {
    if (shutting) return;
    try {
      const newClose = await cs.update('M5');
      if (newClose) {
        log.info('[Poll] M5 candle closed — running scalp logic...');
        await strategy.onM5Close();
      }
    } catch (e) {
      if (!shutting) log.warn(`[M5 Poll] Error: ${e.message}`);
    }
  }, cfg.M5_POLL_MS));

  // ── M15 poll: keep trend filter current ──
  timers.push(setInterval(async () => {
    if (shutting) return;
    try { await cs.update('M15'); }
    catch (e) { if (!shutting) log.warn(`[M15 Poll] Error: ${e.message}`); }
  }, cfg.M15_POLL_MS));

  // ── Swing polls (only when SWING_ENABLED) ──
  if (cfg.swingEnabled) {
    timers.push(setInterval(async () => {
      if (shutting) return;
      try {
        const newClose = await cs.update('H1');
        if (newClose) {
          log.info('[Poll] H1 candle closed — running swing logic...');
          await strategy.onH1Close();
        }
      } catch (e) {
        if (!shutting) log.warn(`[H1 Poll] Error: ${e.message}`);
      }
    }, cfg.H1_POLL_MS));

    timers.push(setInterval(async () => {
      if (shutting) return;
      try { await cs.update('H4'); }
      catch (e) { if (!shutting) log.warn(`[H4 Poll] Error: ${e.message}`); }
    }, cfg.H4_POLL_MS));
  }

  // ── Status log every 60 s ──
  timers.push(setInterval(() => {
    if (shutting) return;
    logStatus();
  }, 60_000));

  // Schedule UTC midnight daily reset
  scheduleMidnightReset();

  log.separator('─');
  log.info('[Main] GoldBot is running. Press Ctrl+C to stop.');
}

// ══════════════════════════════════════════════════════════════
// Status log
// ══════════════════════════════════════════════════════════════

function logStatus() {
  const s      = state.getStats();
  const scalp  = state.getSetupScalp();
  const swing  = state.getSetupSwing();

  // Core counters line
  log.info(
    `[Status] trades=${s.tradesToday}/${cfg.MAX_TRADES_PER_DAY} | ` +
    `day_pnl=$${s.dayRealizedPnlUsd.toFixed(2)} | ` +
    `positions=${s.openCount} | consec_losses=${s.consecutiveLosses}`
  );

  // Setup state line
  const scalpDesc = scalp.active
    ? `${scalp.direction} (extreme=${scalp.pullbackExtreme?.toFixed(4)})`
    : 'none';
  const swingDesc = swing.active
    ? `${swing.direction} (extreme=${swing.pullbackExtreme?.toFixed(4)})`
    : 'none';

  log.info(`[Status] setup_scalp=${scalpDesc} | setup_swing=${swingDesc}`);

  // Open positions detail
  const positions = state.getPositions();
  if (positions.length) {
    for (const pos of positions) {
      const age = Math.round((Date.now() - pos.openedTime) / 60_000);
      log.info(
        `[Status] → ${pos.mode} ${pos.direction} dealId=${pos.dealId} | ` +
        `entry=${pos.entry.toFixed(4)} sl=${pos.sl.toFixed(4)} tp1=${pos.tp1.toFixed(4)} tp2=${pos.tp2.toFixed(4)} | ` +
        `tp1Done=${pos.tp1Done} | open ${age}m ago`
      );
    }
  }

  // Indicator snapshot from M15 (trend) and M5 (setup TF)
  try {
    const m15 = cs.get('M15');
    const m5  = cs.get('M5');
    if (m15.length >= cfg.EMA_TREND_PERIOD && m5.length >= cfg.EMA_PULLBACK_PERIOD) {
      const closes15 = m15.map(c => c.close);
      const closes5  = m5.map(c => c.close);
      const highs5   = m5.map(c => c.high);
      const lows5    = m5.map(c => c.low);

      const ema200m15 = ind.ema(closes15, cfg.EMA_TREND_PERIOD);
      const ema50m5   = ind.ema(closes5,  cfg.EMA_PULLBACK_PERIOD);
      const atrM5     = ind.atr(highs5, lows5, closes5, cfg.ATR_PERIOD);

      const m15close  = m15[m15.length - 1].close;
      const trend     = m15close > ema200m15 ? 'UP' : m15close < ema200m15 ? 'DOWN' : 'NONE';

      log.info(
        `[Status] M15 close=${m15close.toFixed(4)} ema200=${ema200m15?.toFixed(4)} trend=${trend} | ` +
        `M5 ema50=${ema50m5?.toFixed(4)} atr=${atrM5?.toFixed(4)}`
      );
    }
  } catch { /* non-fatal — don't crash the status loop */ }
}

// ══════════════════════════════════════════════════════════════
// Daily reset scheduler
// ══════════════════════════════════════════════════════════════

function scheduleMidnightReset() {
  const now             = new Date();
  const nextMidnightUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
  const msUntilMidnight = nextMidnightUTC - now;

  setTimeout(async () => {
    if (shutting) return;
    log.separator('─');
    log.info('[Main] UTC midnight — daily reset...');
    let eq = 0;
    try {
      const acct = await api.getAccount();
      eq = acct?.balance?.available ?? 0;
      log.info(`[Main] Account balance at reset: $${eq.toFixed(2)}`);
    } catch { /* non-fatal */ }
    state.dailyReset(eq);
    scheduleMidnightReset();   // reschedule for the next day
  }, msUntilMidnight);

  log.info(`[Main] Daily reset scheduled in ${Math.round(msUntilMidnight / 60_000)} min (UTC midnight).`);
}

// ══════════════════════════════════════════════════════════════
// Graceful shutdown
// ══════════════════════════════════════════════════════════════

async function gracefulShutdown(signal) {
  if (shutting) return;
  shutting = true;
  log.separator('─');
  log.warn(`[Main] Shutting down (${signal})...`);
  timers.forEach(t => clearInterval(t));
  await telegram.notifyBotStopped(signal).catch(() => {});
  await api.destroySession();
  log.info('[Main] GoldBot stopped. Goodbye!');
  log.separator('═');
}

process.on('SIGINT',  async () => { await gracefulShutdown('SIGINT');  process.exit(0); });
process.on('SIGTERM', async () => { await gracefulShutdown('SIGTERM'); process.exit(0); });

process.on('uncaughtException', async (e) => {
  log.error(`[Main] Uncaught exception: ${e.message}\n${e.stack}`);
  await gracefulShutdown('UNCAUGHT_EXCEPTION');
  process.exit(1);
});

process.on('unhandledRejection', async (r) => {
  log.error(`[Main] Unhandled rejection: ${r}`);
  await gracefulShutdown('UNHANDLED_REJECTION');
  process.exit(1);
});

main().catch(async (e) => {
  log.error(`[Main] Fatal startup error: ${e.message}\n${e.stack}`);
  await gracefulShutdown('STARTUP_FATAL');
  process.exit(1);
});
