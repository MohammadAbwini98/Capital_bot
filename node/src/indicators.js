// ==============================================================
// GoldBot — indicators.js
// EMA, ATR, RSI, Bollinger Width, ATR Ratio, EMA Slope — pure functions, no deps.
// ==============================================================

/**
 * Compute full EMA series for an array of values.
 * First (period-1) elements are null (seeding phase).
 * @param {number[]} values
 * @param {number}   period
 * @returns {(number|null)[]}
 */
function computeEMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);

  // Seed with SMA of the first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * Return the most recent EMA value (last non-null element).
 * @param {number[]} values
 * @param {number}   period
 * @returns {number|null}
 */
function ema(values, period) {
  const arr = computeEMA(values, period);
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}

/**
 * Compute True Range for each bar.
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @returns {number[]}
 */
function trueRanges(highs, lows, closes) {
  return highs.map((h, i) => {
    const hl = h - lows[i];
    if (i === 0) return hl;
    return Math.max(hl, Math.abs(h - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  });
}

/**
 * Wilder's Smoothed Moving Average (RMA) — the correct smoothing for ATR.
 * Uses alpha = 1/period (versus EMA's 2/(period+1)), matching TradingView,
 * MT4/5, and most charting platforms.
 *
 * @param {number[]} values
 * @param {number}   period
 * @returns {number|null}
 */
function wilderRMA(values, period) {
  if (values.length < period) return null;
  // Seed with SMA of the first `period` values
  let rma = 0;
  for (let i = 0; i < period; i++) rma += values[i];
  rma /= period;
  // Apply Wilder smoothing for the rest
  for (let i = period; i < values.length; i++) {
    rma = (rma * (period - 1) + values[i]) / period;
  }
  return rma;
}

/**
 * Return the most recent ATR value using Wilder's RMA smoothing.
 * This matches the ATR shown in TradingView / MT4 / MT5.
 *
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number}   period
 * @returns {number|null}
 */
function atr(highs, lows, closes, period) {
  return wilderRMA(trueRanges(highs, lows, closes), period);
}

/**
 * Compute ATR series (same length as input) using Wilder's RMA with SMA seed.
 * Returns nulls for the first (period-1) elements.
 *
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number}   period
 * @returns {(number|null)[]}
 */
function computeATRSeries(highs, lows, closes, period) {
  const tr  = trueRanges(highs, lows, closes);
  const out = new Array(tr.length).fill(null);
  if (tr.length < period) return out;

  let rma = 0;
  for (let i = 0; i < period; i++) rma += tr[i];
  rma /= period;
  out[period - 1] = rma;

  for (let i = period; i < tr.length; i++) {
    rma = (rma * (period - 1) + tr[i]) / period;
    out[i] = rma;
  }
  return out;
}

/**
 * Compute RSI series using Wilder's smoothing (same alpha as wilderRMA).
 * Returns nulls for the first `period` elements (seeding phase).
 *
 * @param {number[]} values
 * @param {number}   period
 * @returns {(number|null)[]}
 */
function computeRSI(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  // Seed: SMA of first `period` up/down moves
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing from period+1 onward
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Return the most recent RSI value.
 * @param {number[]} values
 * @param {number}   period
 * @returns {number|null}
 */
function rsi(values, period = 14) {
  const arr = computeRSI(values, period);
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}

/**
 * Compute SMA series.
 * @param {number[]} values
 * @param {number}   period
 * @returns {(number|null)[]}
 */
function computeSMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

/**
 * Bollinger Band width = 4σ / SMA(period).
 * A wider band signals higher volatility relative to price.
 * Returns null if not enough data.
 *
 * @param {number[]} values
 * @param {number}   period
 * @returns {number|null}
 */
function bollingerWidth(values, period = 20) {
  if (values.length < period) return null;
  const smaArr = computeSMA(values, period);
  const smaVal = smaArr[values.length - 1];
  if (smaVal === null || smaVal === 0) return null;
  const slice   = values.slice(-period);
  const variance = slice.reduce((acc, v) => acc + (v - smaVal) ** 2, 0) / period;
  return (4 * Math.sqrt(variance)) / smaVal;
}

/**
 * ATR ratio = current ATR / SMA(ATR, smaPeriod).
 * Values >= 1 mean at or above average volatility.
 * Returns null if not enough data.
 *
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number}   period      ATR period (default 14)
 * @param {number}   smaPeriod   Lookback for the ATR SMA (default 50)
 * @returns {number|null}
 */
function atrRatio(highs, lows, closes, period = 14, smaPeriod = 50) {
  const series = computeATRSeries(highs, lows, closes, period);
  // Collect the last smaPeriod non-null values
  const recent = [];
  for (let i = series.length - 1; i >= 0 && recent.length < smaPeriod; i--) {
    if (series[i] !== null) recent.unshift(series[i]);
  }
  if (recent.length < smaPeriod) return null;
  const smaAtr = recent.reduce((a, b) => a + b, 0) / smaPeriod;
  const current = series[series.length - 1];
  return (smaAtr !== 0 && current !== null) ? current / smaAtr : null;
}

/**
 * EMA slope over `lookback` bars, normalised by ATR.
 * Positive = rising EMA, negative = falling.
 * Returns null if not enough data.
 *
 * @param {number[]} values
 * @param {number}   emaPeriod
 * @param {number}   lookback    Number of bars to measure slope over
 * @param {number}   atrVal      Current ATR for normalisation
 * @returns {number|null}
 */
function emaSlope(values, emaPeriod, lookback, atrVal) {
  if (!atrVal || atrVal === 0) return null;
  const series = computeEMA(values, emaPeriod);
  if (series.length < lookback + 1) return null;
  const current = series[series.length - 1];
  const prev    = series[series.length - 1 - lookback];
  if (current === null || prev === null) return null;
  return (current - prev) / (lookback * atrVal);
}

/**
 * Highest high of the last N candles in the array.
 * Used with `prevCandles` (i.e. already excludes the current trigger bar).
 * @param {number[]} highs
 * @param {number}   n
 * @returns {number}
 */
function highestHigh(highs, n) {
  return Math.max(...highs.slice(-n));
}

/**
 * Lowest low of the last N candles in the array.
 * @param {number[]} lows
 * @param {number}   n
 * @returns {number}
 */
function lowestLow(lows, n) {
  return Math.min(...lows.slice(-n));
}

module.exports = {
  computeEMA, ema,
  computeATRSeries, atr,
  computeRSI, rsi,
  bollingerWidth,
  atrRatio,
  emaSlope,
  highestHigh, lowestLow,
};
