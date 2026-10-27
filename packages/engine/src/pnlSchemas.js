// Three P&L schemas (spec section 15) + monthly profit share (section 15/49).
//
// Deliberately takes already-classified daily components rather than raw
// fills/adjustments, so this module stays agnostic about WHICH sync source
// fed it. Two candidate sources for `tradingResult` were identified while
// reading the PropReports API docs:
//   1. Our own fills-based position ledger (realized P&L only) — good for
//      the live "Current Positions" tab, weaker for historical daily P&L
//      because it has no concept of a daily mark-to-market for symbols that
//      stay open across a day boundary.
//   2. PropReports' own `positions` action, which returns per-symbol,
//      per-date "Unrealized Delta" and "Realized" columns — i.e. PropReports
//      already computes the daily mark-to-market for us. This is almost
//      certainly the right source for historical Schema 1/3 daily deltas
//      (Weekly Report, Calendar, Dashboard history), reserving the fills
//      ledger for live open-position state. That wiring happens in the sync
//      engine (next phase) — this module just consumes the end result.
//
// Sign convention: every fee field below is a POSITIVE number representing
// a cost. `transfers` is signed (positive = deposit, negative = withdrawal)
// and never participates in either P&L schema — it's a cash movement, not
// a trading result.

import { round } from './money.js';

/**
 * @typedef {Object} DayComponents
 * @property {number} tradingResult   Realized + unrealized-delta for the day, before any costs.
 * @property {number} commissions
 * @property {number} marketDataFees
 * @property {number} platformFees
 * @property {number} otherFees
 * @property {number} [transfers]     Cash movement only; not part of either schema.
 */

/** Schema 3 — pure trading performance. Excludes every fee and profit share. */
export function computeSchema3Delta(c) {
  return round(c.tradingResult, 4);
}

/** Schema 1 — report total. Everything that contributes to PropReports' "Total". */
export function computeSchema1Delta(c) {
  return round(
    c.tradingResult - c.commissions - c.marketDataFees - c.platformFees - c.otherFees,
    4
  );
}

/**
 * Schema 2 — after profit share — for a SINGLE calendar month.
 * Profit share is charged once, only when the month's Schema 1 total is
 * positive, using whichever percentage was in effect for that month.
 * @param {number} schema1MonthlyTotal
 * @param {number} pct  e.g. 50 for 50%
 */
export function applyMonthlyProfitShare(schema1MonthlyTotal, pct) {
  const qualifies = schema1MonthlyTotal > 0;
  const propFirmShare = qualifies ? round(schema1MonthlyTotal * (pct / 100), 4) : 0;
  const userShare = qualifies
    ? round(schema1MonthlyTotal - propFirmShare, 4)
    : round(schema1MonthlyTotal, 4); // losing/flat month: no share taken, user keeps the full (negative or zero) result
  return { schema1MonthlyTotal: round(schema1MonthlyTotal, 4), qualifies, pctApplied: pct, propFirmShare, userShare };
}

/**
 * Roll up a list of {monthKey, schema1Total} entries into Schema 2 results,
 * looking up the applicable profit-share % per month from a schedule.
 * This is what guards against the "don't apply it repeatedly" failure mode:
 * each month is computed independently, exactly once, from that month's own
 * Schema 1 total — never from a running cumulative balance.
 *
 * @param {{monthKey:string, schema1Total:number}[]} monthlyTotals
 * @param {(monthKey:string) => number} pctForMonth
 */
export function computeSchema2ForMonths(monthlyTotals, pctForMonth) {
  return monthlyTotals.map(({ monthKey, schema1Total }) => ({
    monthKey,
    ...applyMonthlyProfitShare(schema1Total, pctForMonth(monthKey)),
  }));
}

/**
 * Resolve the profit-share % in effect for a given month from a versioned
 * schedule (spec: percentage changes must not rewrite past months).
 * @param {{pct:number, effectiveFrom:string}[]} schedule  Sorted or not; any order.
 * @param {string} monthKey  'YYYY-MM-01'
 */
export function resolvePctForMonth(schedule, monthKey) {
  const monthStart = new Date(monthKey);
  const applicable = schedule
    .filter((s) => new Date(s.effectiveFrom).getTime() <= monthStart.getTime())
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime());
  if (applicable.length === 0) {
    throw new Error(`No profit-share percentage is effective for ${monthKey}`);
  }
  return applicable[0].pct;
}
