// Calendar tab engine logic (spec section 20 + the daily-comment addition).
//
// Three concerns, kept separate:
//  1. buildMonthGrid            — pure calendar math: which dates fall in
//     which Monday-start week row, including the leading/trailing days from
//     adjacent months needed to complete the grid.
//  2. computeSchema2DailyDeltas — Schema 2 has no natural PER-DAY value (profit
//     share is a once-a-month lump sum), so this allocates the month's
//     profit-share deduction onto its last day with data, and every other
//     day of that month shows its pre-share (Schema 1) number. Summing the
//     resulting daily values across the month reproduces the monthly Schema
//     2 total exactly — see the worked example in the tests.
//  3. buildCalendarMonth        — combines the grid with daily snapshot data,
//     the selected schema, and daily comments into what the Calendar tab
//     renders: per-day cells plus a weekly total next to each week.
//  4. assembleDayDetail          — the "tap a day" view: that day's trades,
//     its delta in whichever schema is selected, and its comment. This
//     module only formats/aggregates trade summaries it's given — it does
//     NOT re-derive trading facts (that's positionEngine.js's job).

import { round, sum } from './money.js';
import { applyMonthlyProfitShare } from './pnlSchemas.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' from UTC year/month(1-indexed)/day — avoids local-timezone drift entirely. */
function toIso(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function isoToUtcDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysIso(iso, days) {
  const dt = new Date(isoToUtcDate(iso).getTime() + days * MS_PER_DAY);
  return dt.toISOString().slice(0, 10);
}

/** 0 = Monday ... 6 = Sunday (JS's native getUTCDay() is 0 = Sunday). */
function mondayIndexedWeekday(iso) {
  return (isoToUtcDate(iso).getUTCDay() + 6) % 7;
}

const WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** e.g. '2026-09-01' -> 'Tuesday'. Used to bridge Calendar days into the Weekly Report's comment draft. */
export function dayLabelForDate(iso) {
  return WEEKDAY_LABELS[mondayIndexedWeekday(iso)];
}

/**
 * Converts one week's Calendar day-cells (as produced by buildCalendarMonth,
 * each carrying {date, comment}) into the shape buildWeeklyCommentDraft
 * expects — this is the actual connection point for "pre-fill the weekly
 * comment from what I wrote on individual days that week."
 * @param {{date:string, comment:string|null}[]} weekDays
 */
export function weekDaysToCommentInput(weekDays) {
  return weekDays.map((d) => ({ dayLabel: dayLabelForDate(d.date), date: d.date, comment: d.comment ?? undefined }));
}


/**
 * Builds a Monday-start month grid: an array of week-rows, each exactly 7
 * day-cells. Leading/trailing days from the adjacent month are included
 * (marked inCurrentMonth: false) so every week row is always complete —
 * the normal shape for a calendar UI.
 * @param {number} year
 * @param {number} month  1-indexed (1 = January)
 */
export function buildMonthGrid(year, month) {
  const firstOfMonth = toIso(year, month, 1);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastOfMonth = toIso(year, month, daysInMonth);

  const gridStart = addDaysIso(firstOfMonth, -mondayIndexedWeekday(firstOfMonth));
  const trailingNeeded = 6 - mondayIndexedWeekday(lastOfMonth);
  const gridEnd = addDaysIso(lastOfMonth, trailingNeeded);

  const weeks = [];
  let cursor = gridStart;
  while (true) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push({ date: cursor, inCurrentMonth: cursor >= firstOfMonth && cursor <= lastOfMonth });
      cursor = addDaysIso(cursor, 1);
    }
    weeks.push(week);
    if (cursor > gridEnd) break;
  }
  return weeks;
}

/**
 * Allocates one calendar month's profit share onto its last day with data.
 * Every other day keeps its Schema 1 value unchanged. The days array does
 * NOT need to be a full month — only the days that actually have trading
 * data — the deduction lands on whichever of those is latest.
 * @param {{date:string, schema1Delta:number}[]} days
 * @param {number} pct  profit-share percentage in effect for this month
 */
export function computeSchema2DailyDeltas(days, pct) {
  if (days.length === 0) return { days: [], shareResult: null };
  const monthlyTotal = sum(days.map((d) => d.schema1Delta), 4);
  const shareResult = applyMonthlyProfitShare(monthlyTotal, pct);
  const lastDate = days.reduce((max, d) => (d.date > max ? d.date : max), days[0].date);

  const resultDays = days.map((d) => ({
    date: d.date,
    schema2Delta:
      d.date === lastDate ? round(d.schema1Delta - shareResult.propFirmShare, 4) : d.schema1Delta,
  }));
  return { days: resultDays, shareResult };
}

/**
 * Assembles the Calendar tab's view of one month for the currently
 * selected P&L schema.
 * @param {Object} args
 * @param {number} args.year
 * @param {number} args.month              1-indexed
 * @param {'schema1'|'schema2'|'schema3'} args.schema
 * @param {{date:string, schema1Delta:number, schema3Delta:number}[]} args.dailyData  from daily_account_snapshots
 * @param {{date:string, comment:string}[]} [args.comments]  from daily_comments
 * @param {number} [args.profitSharePct]   required only when schema === 'schema2'
 */
export function buildCalendarMonth({ year, month, schema, dailyData, comments = [], profitSharePct }) {
  const grid = buildMonthGrid(year, month);
  const dataByDate = new Map(dailyData.map((d) => [d.date, d]));
  const commentByDate = new Map(comments.map((c) => [c.date, c.comment]));

  let deltaByDate;
  if (schema === 'schema2') {
    if (profitSharePct === undefined) {
      throw new Error('profitSharePct is required to compute Schema 2 calendar deltas');
    }
    const monthDays = dailyData
      .filter((d) => d.date.slice(0, 7) === toIso(year, month, 1).slice(0, 7))
      .map((d) => ({ date: d.date, schema1Delta: d.schema1Delta }));
    const { days } = computeSchema2DailyDeltas(monthDays, profitSharePct);
    deltaByDate = new Map(days.map((d) => [d.date, d.schema2Delta]));
  } else {
    const key = schema === 'schema1' ? 'schema1Delta' : 'schema3Delta';
    deltaByDate = new Map(dailyData.map((d) => [d.date, d[key]]));
  }

  const weeks = grid.map((weekDates) => {
    const days = weekDates.map((cell) => {
      const delta = deltaByDate.has(cell.date) ? deltaByDate.get(cell.date) : null;
      return {
        date: cell.date,
        inCurrentMonth: cell.inCurrentMonth,
        hasTrades: dataByDate.has(cell.date),
        delta,
        comment: commentByDate.get(cell.date) ?? null,
      };
    });
    const tradedDeltas = days.filter((d) => d.delta !== null).map((d) => d.delta);
    const weeklyTotal = tradedDeltas.length > 0 ? sum(tradedDeltas, 4) : null;
    return { days, weeklyTotal };
  });

  return { year, month, schema, weeks };
}

/**
 * The "tap a day" detail view. Consumes trade summaries already assembled
 * elsewhere (from position_fills/position_instances joined on this date) —
 * this function formats and groups them, it does not derive them.
 * @param {Object} args
 * @param {string} args.date
 * @param {'schema1'|'schema2'|'schema3'} args.schema
 * @param {number|null} args.dailyDelta
 * @param {{symbol:string, direction:'long'|'short', quantity:number, realizedPnl?:number, isClosed?:boolean}[]} [args.trades]
 * @param {string|null} [args.comment]
 */
export function assembleDayDetail({ date, schema, dailyDelta, trades = [], comment = null }) {
  return {
    date,
    schema,
    dailyDelta,
    comment,
    symbolsTraded: [...new Set(trades.map((t) => t.symbol))],
    trades: trades.map((t) => ({
      symbol: t.symbol,
      direction: t.direction,
      quantity: t.quantity,
      realizedPnl: t.realizedPnl ?? null,
      isClosed: Boolean(t.isClosed),
    })),
  };
}
