// Formatting conventions, reverse-engineered pixel-by-pixel from the actual
// supplied template (rasterized + color-sampled, not guessed):
//
//   - Daily "Total Δ" row:      signed-parens, NO "$", red if <0 / green if >0
//   - Daily "Account value" row: signed-parens, NO "$", always neutral (never red)
//   - "TOTAL Δ (Weekly P&L)" and "REALIZED NET" cards: "$" PREFIX + red/green
//   - Every other numeric card (Max Drawdown, Average Daily Δ, Avg/Biggest
//     Net Winner/Loser, W/L Ratio): signed-parens, NO "$", ALWAYS neutral —
//     even Max Drawdown, which is always negative, is never shown in red.
//   - Integers (Quantity, Avg Size In Position, Up/Down Days): plain, no decimals.
//   - BAT: percentage, 2 decimals.
//   - Avg Hold Time: a raw duration string, passed through as-is.
//
// Getting this exactly right matters more than it looks — it's the
// difference between a report that visually IS the template and one that
// merely resembles it.

import { round } from './money.js';

// A value that could not be computed (null / NaN) renders BLANK — never a made-up 0 (spec section 28).
const missing = (v) => v === null || v === undefined || Number.isNaN(v);

/** "4.38" -> "(4.38)", "-4.38" -> "(4.38)", "3.82" -> "3.82". No "$", ever. */
export function formatSignedParen(value, decimals = 2) {
  if (missing(value)) return '';
  const v = round(value, decimals);
  const abs = Math.abs(v).toFixed(decimals);
  return v < 0 ? `(${abs})` : abs;
}

/** Only for the two headline cards: "$41.56" / "($41.56)". */
export function formatDollarSigned(value, decimals = 2) {
  if (missing(value)) return '';
  const v = round(value, decimals);
  const abs = Math.abs(v).toFixed(decimals);
  return v < 0 ? `($${abs})` : `$${abs}`;
}

/** 0.5 -> "50.00%" (fraction in, percent string out). */
export function formatPercent(fraction, decimals = 2) {
  if (missing(fraction)) return '';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** Plain integer, no sign games — Quantity, Avg Size In Position. */
export function formatInteger(value) {
  if (missing(value)) return '';
  return String(Math.round(value));
}

/** "23.18 / (0.04)" — the Avg/Biggest Net Winner-Loser pairs. */
export function formatSignedParenPair(a, b, decimals = 2) {
  if (missing(a) || missing(b)) return '';
  return `${formatSignedParen(a, decimals)} / ${formatSignedParen(b, decimals)}`;
}

/** "2 / 3" — Up/Down Days. */
export function formatCountPair(a, b) {
  if (missing(a) || missing(b)) return '';
  return `${formatInteger(a)} / ${formatInteger(b)}`;
}

/** true if a value should render in the template's green, false for red, null for neutral. */
export function signColor(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}
