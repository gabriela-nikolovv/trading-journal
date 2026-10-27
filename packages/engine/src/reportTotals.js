// Weekly Report automatic fields (spec section 26): the four values that
// can be derived purely from the Mon–Fri Total Δ row.
//
// IMPORTANT — this "Total Δ" is a report-specific display convention, not a
// fourth P&L schema: on the first trading day of a month it deliberately
// EXCLUDES the recurring monthly fee adjustment (market data / platform /
// etc.) even though that fee is real and does hit Account Value. Schema 1
// elsewhere in the app still includes that fee. See detectMonthBoundaryGap().

import { round, sum } from './money.js';

/** @param {number[]} dailyDeltas */
export function computeWeeklyTotalDelta(dailyDeltas) {
  return sum(dailyDeltas, 4);
}

/** @param {number[]} dailyDeltas */
export function computeAverageDailyDelta(dailyDeltas) {
  return round(sum(dailyDeltas, 4) / dailyDeltas.length, 4);
}

/** @param {number[]} dailyDeltas */
export function computeUpDownDays(dailyDeltas) {
  const up = dailyDeltas.filter((d) => d > 0).length;
  const down = dailyDeltas.filter((d) => d < 0).length;
  return { up, down, flat: dailyDeltas.length - up - down };
}

/**
 * Max drawdown from the cumulative Total Δ curve, starting the "peak" at 0
 * (the state before the week/period began). Peak-to-trough distance,
 * reported as the negative dollar amount PropReports shows.
 * @param {number[]} dailyDeltas
 */
export function computeMaxDrawdown(dailyDeltas) {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0; // most negative (peak - trough) seen
  for (const delta of dailyDeltas) {
    cumulative = round(cumulative + delta, 4);
    if (cumulative > peak) peak = cumulative;
    const drawdown = round(cumulative - peak, 4); // <= 0
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown;
}

/**
 * Reconstructs each day's Account Value from a starting value and the daily
 * deltas — the same "previous value + delta = new value" identity the
 * report relies on. Used to prove/validate a reconciliation, and to reveal
 * days (like the 1st of a month) where a real value doesn't match.
 * @param {number} startingAccountValue  Account value at the END of the day before day 0.
 * @param {number[]} dailyDeltas
 */
export function reconstructAccountValueSeries(startingAccountValue, dailyDeltas) {
  const series = [];
  let running = startingAccountValue;
  for (const delta of dailyDeltas) {
    running = round(running + delta, 4);
    series.push(running);
  }
  return series;
}

/**
 * Compares reconstructed Account Value (from Total Δ alone) against the
 * actual reported Account Value for each day, surfacing any gap. A gap on
 * day N generally means a same-day event affected the account but was
 * deliberately excluded from Total Δ (e.g. the first-of-month fee sweep).
 * @param {number[]} reportedAccountValues
 * @param {number[]} reconstructedAccountValues
 */
export function detectMonthBoundaryGap(reportedAccountValues, reconstructedAccountValues) {
  return reportedAccountValues.map((actual, i) => {
    const expected = reconstructedAccountValues[i];
    const gap = round(actual - expected, 4);
    return { index: i, expected, actual, gap, hasGap: Math.abs(gap) > 0.01 };
  });
}

/**
 * Day-over-day reconciliation using each day's OWN actual Account Value as
 * the baseline for the next day (rather than propagating a single starting
 * balance forward) — so one anomalous day never cascades false gaps into
 * every later day. This is the check that actually surfaces "Tuesday is the
 * 1st of the month" style gaps in a real, possibly-longer, series.
 * Index 0 is never checked (there is no prior actual value to compare against).
 * @param {number[]} actualAccountValues
 * @param {number[]} dailyDeltas
 */
export function computeDayOverDayGaps(actualAccountValues, dailyDeltas) {
  const gaps = [];
  for (let i = 1; i < actualAccountValues.length; i++) {
    const expected = round(actualAccountValues[i - 1] + dailyDeltas[i], 4);
    const actual = actualAccountValues[i];
    const gap = round(actual - expected, 4);
    gaps.push({ index: i, expected, actual, gap, hasGap: Math.abs(gap) > 0.01 });
  }
  return gaps;
}
