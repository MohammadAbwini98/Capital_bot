// ==============================================================
// GoldBot — telegram.js
// Sends trade notifications to a Telegram chat via Bot API.
//
// All functions are fire-and-forget (non-fatal).
// If Telegram is unavailable or misconfigured the bot keeps running.
// ==============================================================

const axios = require('axios');
const cfg   = require('./config');
const log   = require('./logger');

// ── Helpers ───────────────────────────────────────────────────

function isConfigured() {
  return !!(cfg.telegramToken && cfg.telegramChatId);
}

function apiUrl() {
  return `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`;
}

/**
 * Format a Date (or epoch ms) as a human-readable string in cfg.TIMEZONE.
 * Output: "2026-02-25 14:30:00 (Asia/Riyadh)"
 */
function fmtTs(d) {
  const date = (typeof d === 'number') ? new Date(d) : (d instanceof Date ? d : new Date());
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:  cfg.TIMEZONE,
    year:      'numeric',
    month:     '2-digit',
    day:       '2-digit',
    hour:      '2-digit',
    minute:    '2-digit',
    second:    '2-digit',
    hour12:    false,
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value ?? '??';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} (${cfg.TIMEZONE})`;
}

function ts() {
  return fmtTs(new Date());
}

/**
 * Send a plain or HTML-formatted message.
 * Errors are logged as warnings — never thrown.
 * @param {string} text  HTML-formatted Telegram message
 */
async function sendMessage(text) {
  if (!isConfigured()) return;

  try {
    await axios.post(apiUrl(), {
      chat_id:    cfg.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 10_000 });
  } catch (e) {
    log.warn(`[Telegram] Failed to send message: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Notification templates
// ══════════════════════════════════════════════════════════════

/**
 * Fired in placeOrder() immediately after a trade is confirmed.
 *
 * @param {{
 *   mode: string, direction: string, epic: string,
 *   size: number, entry: number,
 *   sl: number, tp1: number, tp2: number,
 *   dealId: string, dealReference: string
 * }} t
 */
async function notifyTradeOpened(t) {
  const arrow  = t.direction === 'BUY' ? '📈' : '📉';
  const emoji  = t.direction === 'BUY' ? '🟢' : '🔴';
  const rValue = Math.abs(t.entry - t.sl).toFixed(4);

  const text = [
    `${emoji} <b>GoldBot — Trade Opened</b>`,
    ``,
    `${arrow} <b>${t.direction}</b>  |  ${t.epic}  |  ${t.mode}`,
    ``,
    `💰 <b>Entry</b>      <code>${t.entry.toFixed(4)}</code>`,
    `🛡 <b>Stop Loss</b>  <code>${t.sl.toFixed(4)}</code>`,
    `🎯 <b>TP1 (50%)</b>  <code>${t.tp1.toFixed(4)}</code>`,
    `🏆 <b>TP2</b>        <code>${t.tp2.toFixed(4)}</code>`,
    `📐 <b>Risk (1R)</b>  <code>${rValue}</code>`,
    `📦 <b>Size</b>       <code>${t.size} unit(s)</code>`,
    ``,
    `🔖 <code>${t.dealId}</code>`,
    `🕐 ${ts()}`,
  ].join('\n');

  await sendMessage(text);
  log.debug(`[Telegram] Trade-open notification sent for dealId=${t.dealId}`);
}

/**
 * Fired when a position hits SL, TP1, or TP2.
 *
 * @param {{
 *   event: 'SL_HIT' | 'TP1_HIT' | 'TP2_HIT',
 *   direction: string, epic: string, mode: string,
 *   entry: number, exitPrice: number, pnl: number,
 *   dealId: string
 * }} t
 */
async function notifyTradeClosed(t) {
  const eventEmoji = { SL_HIT: '❌', TP1_HIT: '✅', TP2_HIT: '🏆', BROKER_CLOSE: '⚠️' };
  const eventLabel = {
    SL_HIT:       'Stop Loss Hit',
    TP1_HIT:      'TP1 Hit (partial close)',
    TP2_HIT:      'TP2 Hit (full close)',
    BROKER_CLOSE: 'Closed by Broker (SL/TP/Margin)',
  };

  const emoji    = eventEmoji[t.event] ?? '⚪';
  const label    = eventLabel[t.event] ?? t.event;
  const exitStr  = t.exitPrice != null ? `<code>${t.exitPrice.toFixed(4)}</code>` : '<i>unknown</i>';
  const pnlStr   = t.pnl      != null ? `<code>${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}</code>` : '<i>unknown</i>';

  const text = [
    `${emoji} <b>GoldBot — ${label}</b>`,
    ``,
    `${t.direction === 'BUY' ? '📈' : '📉'} <b>${t.direction}</b>  |  ${t.epic}  |  ${t.mode}`,
    ``,
    `💰 <b>Entry</b>       <code>${t.entry.toFixed(4)}</code>`,
    `🚪 <b>Exit</b>        ${exitStr}`,
    `💵 <b>P&amp;L</b>         ${pnlStr}`,
    ``,
    `🔖 <code>${t.dealId}</code>`,
    `🕐 ${ts()}`,
  ].join('\n');

  await sendMessage(text);
  log.debug(`[Telegram] Trade-close notification sent for dealId=${t.dealId} event=${t.event}`);
}

/**
 * Fired once when the bot starts successfully.
 */
async function notifyBotStarted({ epic, accountType, equity }) {
  const text = [
    `🤖 <b>GoldBot Started</b>`,
    ``,
    `📊 Instrument : <b>${epic}</b>`,
    `🏦 Account    : <b>${accountType.toUpperCase()}</b>`,
    `💼 Balance    : <b>$${equity.toFixed(2)}</b>`,
    `🕐 ${ts()}`,
  ].join('\n');

  await sendMessage(text);
  log.debug('[Telegram] Bot-started notification sent');
}

/**
 * Fired when a setup candidate (BUY_CANDIDATE / SELL_CANDIDATE) is detected.
 *
 * @param {{
 *   direction: 'BUY' | 'SELL',
 *   epic: string,
 *   trend: string,
 *   spread: number,
 *   spreadOk: boolean,
 *   pullbackExtreme: number | null,
 *   bosTriggered: boolean,
 *   features: object,
 * }} c
 */
async function notifySetupCandidate(c) {
  const arrow      = c.direction === 'BUY' ? '📈' : '📉';
  const dirEmoji   = c.direction === 'BUY' ? '🟢' : '🔴';
  const trendEmoji = c.trend === 'UP'  ? '⬆️' : c.trend === 'DOWN' ? '⬇️' : '➡️';
  const spreadIcon = c.spreadOk ? '✅' : '❌';
  const bosIcon    = c.bosTriggered ? '✅ Triggered' : '⏳ Waiting';

  const f    = c.features ?? {};
  const fmt  = (v, d = 4) => (v != null ? v.toFixed(d) : '—');
  const fmtN = (v, d = 2) => (v != null ? (v >= 0 ? '+' : '') + v.toFixed(d) : '—');

  const text = [
    `${dirEmoji} <b>GoldBot — Setup Candidate</b>`,
    ``,
    `${arrow} <b>${c.direction}</b>  |  ${c.epic}  |  SCALP`,
    ``,
    `📊 <b>Market</b>`,
    `  Trend   : ${trendEmoji} <b>${c.trend}</b>`,
    `  Spread  : <code>${fmt(c.spread)}</code>  ${spreadIcon}`,
    `  Price   : Bid <code>${fmt(f.bid)}</code>  Ask <code>${fmt(f.ask)}</code>`,
    ``,
    `⚙️ <b>Setup</b>`,
    `  Pullback extreme : <code>${fmt(c.pullbackExtreme)}</code>`,
    `  BOS              : ${bosIcon}`,
    ``,
    `📉 <b>Indicators (M5)</b>`,
    `  Close  : <code>${fmt(f.m5_close)}</code>`,
    `  EMA20  : <code>${fmt(f.m5_ema20)}</code>`,
    `  EMA50  : <code>${fmt(f.m5_ema50)}</code>`,
    `  ATR    : <code>${fmt(f.m5_atr)}</code>`,
    `  vs EMA50 : <code>${fmtN(f.m5_close_ema50_dist)}</code>`,
    ``,
    `📐 <b>M15 Trend</b>`,
    `  EMA200          : <code>${fmt(f.m15_ema200)}</code>`,
    `  Dist / ATR      : <code>${fmtN(f.m15_ema200_dist_atr)}</code>x`,
    `🕐 ${ts()}`,
  ].join('\n');

  await sendMessage(text);
  log.debug(`[Telegram] Setup-candidate notification sent (${c.direction})`);
}

/**
 * Fired after the ML gate is evaluated for a SCALP candidate.
 * Sent regardless of whether the gate passed or blocked, so the user
 * sees every ML decision in real time.
 *
 * @param {{
 *   direction: 'BUY' | 'SELL',
 *   epic: string,
 *   score: number,       0–1 probability of price going up
 *   version: string,     model version tag
 *   mlBlocked: boolean,
 *   candEntry: number,
 *   candSL: number,
 *   candTP1: number,
 *   candTP2: number,
 *   sigTs: number,       epoch ms of the M5 candle that triggered
 * }} p
 */
async function notifyPrediction(p) {
  const arrow    = p.direction === 'BUY' ? '📈' : '📉';
  const dirEmoji = p.direction === 'BUY' ? '🟢' : '🔴';
  const gateIcon = p.mlBlocked ? '🚫 BLOCKED' : '✅ PASSED';

  const score = p.score ?? 0;
  let scoreLabel;
  if      (score >= 0.80) scoreLabel = 'Very High';
  else if (score >= 0.65) scoreLabel = 'High';
  else if (score >= 0.55) scoreLabel = 'Moderate';
  else if (score >= 0.45) scoreLabel = 'Low';
  else                    scoreLabel = 'Very Low';

  const threshold = p.direction === 'BUY'
    ? `≥ ${(cfg.ML_BUY_THRESHOLD  * 100).toFixed(0)}% (BUY)`
    : `≤ ${(cfg.ML_SELL_THRESHOLD * 100).toFixed(0)}% (SELL)`;

  const fmt = (v, d = 2) => (v != null ? v.toFixed(d) : '—');
  const rValue = p.candEntry != null && p.candSL != null
    ? Math.abs(p.candEntry - p.candSL).toFixed(2)
    : '—';

  const sigTimeStr = p.sigTs ? fmtTs(p.sigTs) : '—';

  // ── Signal detail helpers ──────────────────────────────────
  const f  = p.signal?.features ?? {};
  const r  = p.signal?.reasons  ?? {};
  const ok = (v) => v === true ? '✅' : v === false ? '❌' : '—';

  const trendEmoji = r.trend === 'UP' ? '⬆️' : r.trend === 'DOWN' ? '⬇️' : '➡️';

  const slopeVal = f.m15_ema200_slope;
  const slopeStr = slopeVal != null
    ? (slopeVal >= 0 ? '+' : '') + slopeVal.toFixed(4)
    : '—';

  const text = [
    `${dirEmoji} <b>GoldBot — Prediction Signal</b>`,
    ``,
    `${arrow} <b>${p.direction}</b>  |  ${p.epic}  |  SCALP`,
    ``,
    `🤖 <b>ML Gate</b>   ${gateIcon}`,
    `   Score     : <code>${(score * 100).toFixed(1)}%</code>  — ${scoreLabel} confidence`,
    `   Threshold : <code>${threshold}</code>`,
    `   Model     : <code>${p.version ?? '—'}</code>`,
    ``,
    `📊 <b>Signal</b>`,
    `   Action : <code>${p.signal?.action ?? '—'}</code>`,
    `   Trend  : ${trendEmoji} ${r.trend ?? '—'}    Spread : <code>${fmt(f.spread, 4)}</code>`,
    ``,
    `📉 <b>Indicators (M5)</b>`,
    `   Close : <code>${fmt(f.m5_close,  4)}</code>    ATR14 : <code>${fmt(f.m5_atr, 4)}</code>`,
    `   EMA20 : <code>${fmt(f.m5_ema20,  4)}</code>    RSI14 : <code>${fmt(f.m5_rsi14, 1)}</code>`,
    `   EMA50 : <code>${fmt(f.m5_ema50,  4)}</code>`,
    ``,
    `📐 <b>M15 Context</b>`,
    `   Trend str  : <code>${fmt(f.m15_trend_strength, 2)}×</code>    EMA slope : <code>${slopeStr}</code>`,
    ``,
    `🏛 <b>H1 Macro</b>`,
    `   Close : <code>${fmt(f.h1_close, 4)}</code>    RSI14 : <code>${fmt(f.h1_rsi14, 1)}</code>`,
    ``,
    `🚦 <b>Gates</b>`,
    `   H1 Macro ${ok(r.h1MacroOk)}  M15 Str ${ok(r.m15StrengthOk)}  RSI ${ok(r.rsiOk)}`,
    `   ATR Vol ${ok(r.atrRatioOk)}  Body ${ok(r.bodyOk)}  M1 Micro ${ok(r.microConfirmOk)}`,
    ``,
    `💰 <b>Trade Levels</b>`,
    `   Entry : <code>${fmt(p.candEntry, 4)}</code>`,
    `   SL    : <code>${fmt(p.candSL,    4)}</code>  (risk ${rValue})`,
    `   TP1   : <code>${fmt(p.candTP1,   4)}</code>`,
    `   TP2   : <code>${fmt(p.candTP2,   4)}</code>`,
    ``,
    `🕐 Signal : ${sigTimeStr}`,
    `🕐 Now    : ${ts()}`,
  ].join('\n');

  await sendMessage(text);
  log.debug(`[Telegram] Prediction notification sent (${p.direction} ${p.mlBlocked ? 'BLOCKED' : 'PASSED'})`);
}

/**
 * Fired when the bot shuts down (SIGINT / SIGTERM / error).
 */
async function notifyBotStopped(reason) {
  const text = [
    `🛑 <b>GoldBot Stopped</b>`,
    ``,
    `Reason : <code>${reason}</code>`,
    `🕐 ${ts()}`,
  ].join('\n');

  await sendMessage(text);
  log.debug('[Telegram] Bot-stopped notification sent');
}

module.exports = {
  sendMessage,
  notifyTradeOpened,
  notifyTradeClosed,
  notifyBotStarted,
  notifyBotStopped,
  notifySetupCandidate,
  notifyPrediction,
};
