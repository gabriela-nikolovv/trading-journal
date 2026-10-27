// Turns stored data (daily snapshots, completed trades, daily comments) into the input of the
// Weekly Report (spec sections 26-28, 30). Nothing here is typed in by the user except the comment.
//
//  - Day "Total Δ" row  = Schema 1 for that day MINUS the recurring monthly fees (market data,
//    platform, multisport/other) — they post on the 1st and the report deliberately leaves them out.
//  - Day "Account value" = the stored closing account value, carried forward on days with no data.
//  - Weekly P&L, average daily Δ, up/down days and max drawdown are derived by assembleWeeklyReportData
//    from those five daily numbers, exactly like the template's formulas.
//  - BAT, W/L, avg net winner/loser, biggest winner/loser, avg hold = completed trades that went flat this week.
//  - Realized Net and Quantity = sums of the daily snapshot columns.

import { reportDayDelta } from './dailySnapshots.js';
import { computeTradeStats } from './tradeStats.js';
import { dayLabelForDate } from './calendar.js';
import { round } from './money.js';

/** Monday (ISO date) of the week containing `iso`. */
export function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10);
}
export const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/**
 * @param {Object} o
 * @param {string} o.weekStart  Monday ISO date
 * @param {Array<Object>} o.snapshots   all stored snapshot rows {date, schema1Delta, marketDataFees, platformFees, otherFees, accountValue, realizedNet, quantityTraded}
 * @param {Array<Object>} o.closedTrades  {closedAt:Date, openedAt:Date, realizedPnl, feesAllocated, quantityTraded}
 * @param {{date:string,comment:string}[]} o.dailyComments
 */
export function buildWeekInput({ weekStart, snapshots, closedTrades, dailyComments }) {
  const dates = [0, 1, 2, 3, 4].map((i) => addDays(weekStart, i));
  const weekEnd = dates[4];
  const byDate = new Map(snapshots.map((s) => [s.date, s]));
  const before = snapshots.filter((s) => s.date < weekStart).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  let carried = before ? before.accountValue : 0;

  const days = dates.map((date) => {
    const s = byDate.get(date);
    if (s) carried = s.accountValue;
    return { label: dayLabelForDate(date), date, totalDelta: s ? reportDayDelta(s) : 0, accountValue: carried };
  });

  const weekSnaps = dates.map((d) => byDate.get(d)).filter(Boolean);
  const stats = computeTradeStats(
    closedTrades.map((t) => ({ ...t, status: 'closed' })),
    { fromDate: weekStart, toDate: weekEnd }
  );
  const inWeek = closedTrades.filter((t) => {
    const d = t.closedAt.toISOString().slice(0, 10);
    return d >= weekStart && d <= weekEnd;
  });

  const propReportsNative = {
    realizedNet: round(weekSnaps.reduce((a, s) => a + s.realizedNet, 0), 2),
    quantity: round(weekSnaps.reduce((a, s) => a + s.quantityTraded, 0), 0),
    bat: stats.bat,
    wlRatio: stats.wlRatio,
    // Average size of a completed trade = shares opened (a round trip trades each share twice).
    avgSizeInPosition: inWeek.length ? Math.round(inWeek.reduce((a, t) => a + t.quantityTraded / 2, 0) / inWeek.length) : null,
    avgNetWinner: stats.avgNetWinner,
    avgNetLoser: stats.avgNetLoser,
    avgHoldTime: stats.avgHoldLabel ?? '',
    biggestNetWinner: stats.biggestNetWinner,
    biggestNetLoser: stats.biggestNetLoser,
  };

  const commentDays = dates.map((date) => ({
    dayLabel: dayLabelForDate(date), date, comment: dailyComments.find((c) => c.date === date)?.comment ?? '',
  }));
  return { weekStart, weekEnd, days, propReportsNative, commentDays };
}
