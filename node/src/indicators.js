// ==============================================================
// GoldBot — indicators.js
// EMA, ATR, HighestHigh, LowestLow — pure functions, no deps.
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
 * Return the most recent ATR value.
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number}   period
 * @returns {number|null}
 */
function atr(highs, lows, closes, period) {
  return ema(trueRanges(highs, lows, closes), period);
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

module.exports = { computeEMA, ema, atr, highestHigh, lowestLow };
