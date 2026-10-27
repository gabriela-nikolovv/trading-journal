// Plain-JS money helpers.
//
// NOTE FOR LATER: this engine intentionally has zero dependencies so it can
// run unmodified in Node (tests, this sandbox) or a Deno Edge Function. When
// this is wired into the real Supabase backend, swap `round()`'s internals
// for a proper decimal library (e.g. decimal.js) if fills with more exotic
// fee precision start showing rounding drift in the reconciliation checks.

/**
 * Round to a fixed number of decimals, correcting for classic binary
 * floating point artifacts (0.1 + 0.2 !== 0.3).
 * @param {number} value
 * @param {number} [decimals=6]
 */
export function round(value, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Sum an array of numbers, rounding only the final result.
 * @param {number[]} values
 * @param {number} [decimals=6]
 */
export function sum(values, decimals = 6) {
  return round(values.reduce((a, b) => a + b, 0), decimals);
}

/** True if two money-ish values are equal within a cent (default) tolerance. */
export function nearlyEqual(a, b, tolerance = 0.01) {
  return Math.abs(a - b) <= tolerance;
}
