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

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
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
  const eventEmoji = { SL_HIT: '❌', TP1_HIT: '✅', TP2_HIT: '🏆' };
  const eventLabel = { SL_HIT: 'Stop Loss Hit', TP1_HIT: 'TP1 Hit (partial close)', TP2_HIT: 'TP2 Hit (full close)' };

  const emoji = eventEmoji[t.event] ?? '⚪';
  const label = eventLabel[t.event] ?? t.event;
  const pnlSign = t.pnl >= 0 ? '+' : '';

  const text = [
    `${emoji} <b>GoldBot — ${label}</b>`,
    ``,
    `${t.direction === 'BUY' ? '📈' : '📉'} <b>${t.direction}</b>  |  ${t.epic}  |  ${t.mode}`,
    ``,
    `💰 <b>Entry</b>       <code>${t.entry.toFixed(4)}</code>`,
    `🚪 <b>Exit</b>        <code>${t.exitPrice.toFixed(4)}</code>`,
    `💵 <b>P&amp;L</b>         <code>${pnlSign}$${t.pnl.toFixed(2)}</code>`,
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
};
