import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonthGrid,
  computeSchema2DailyDeltas,
  buildCalendarMonth,
  assembleDayDetail,
  weekDaysToCommentInput,
} from '../src/calendar.js';

describe('buildMonthGrid — Monday-start weeks (spec section 20/43: never Sunday)', () => {
  test('September 2026 (a real month from the fixture): first week starts Monday Aug 31', () => {
    // Independently confirms what the user told us directly: "Tuesday is 1st
    // September" — so the week containing Sep 1 must start on Monday Aug 31.
    const grid = buildMonthGrid(2026, 9);
    assert.equal(grid[0][0].date, '2026-08-31');
    assert.equal(grid[0][1].date, '2026-09-01');
    assert.equal(grid[0][0].inCurrentMonth, false); // Aug 31 shown, but not part of September
    assert.equal(grid[0][1].inCurrentMonth, true);
  });

  test('every week row has exactly 7 days, Monday first and Sunday last', () => {
    const grid = buildMonthGrid(2026, 9);
    for (const week of grid) {
      assert.equal(week.length, 7);
      const weekdayOf = (iso) => (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7;
      assert.equal(weekdayOf(week[0].date), 0); // Monday
      assert.equal(weekdayOf(week[6].date), 6); // Sunday
    }
  });

  test('the grid fully covers every day of the month with no gaps or duplicates, for a range of months', () => {
    for (const [year, month] of [[2026, 1], [2026, 2], [2026, 9], [2026, 12], [2027, 6]]) {
      const grid = buildMonthGrid(year, month);
      const allDates = grid.flat().map((c) => c.date);
      assert.equal(new Set(allDates).size, allDates.length, `no duplicate dates in ${year}-${month}`);
      const inMonthDates = grid.flat().filter((c) => c.inCurrentMonth).map((c) => c.date);
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      assert.equal(inMonthDates.length, daysInMonth, `${year}-${month} should mark exactly ${daysInMonth} in-month days`);
    }
  });
});

describe('computeSchema2DailyDeltas — profit share allocated once, on the month\'s last day with data', () => {
  test('a $1000 qualifying month: only the last day carries the deduction', () => {
    const days = [
      { date: '2026-01-05', schema1Delta: 400 },
      { date: '2026-01-15', schema1Delta: 300 },
      { date: '2026-01-30', schema1Delta: 300 },
    ];
    const { days: result, shareResult } = computeSchema2DailyDeltas(days, 50);
    assert.equal(shareResult.propFirmShare, 500);
    assert.equal(result.find((d) => d.date === '2026-01-05').schema2Delta, 400);
    assert.equal(result.find((d) => d.date === '2026-01-15').schema2Delta, 300);
    assert.equal(result.find((d) => d.date === '2026-01-30').schema2Delta, -200); // 300 - 500
    // Summed across the month, Schema 2 reproduces the monthly user share exactly.
    const total = result.reduce((a, d) => a + d.schema2Delta, 0);
    assert.equal(Math.round(total * 100) / 100, 500);
  });

  test('a losing month takes no share — every day equals its Schema 1 value unchanged', () => {
    const days = [
      { date: '2026-02-03', schema1Delta: -100 },
      { date: '2026-02-27', schema1Delta: -50 },
    ];
    const { days: result, shareResult } = computeSchema2DailyDeltas(days, 50);
    assert.equal(shareResult.qualifies, false);
    assert.equal(result.find((d) => d.date === '2026-02-27').schema2Delta, -50);
  });
});

describe('buildCalendarMonth — real Gabriela week embedded in the September 2026 grid', () => {
  // schema1Delta mirrors the report's real "Total Δ"; schema3Delta is offset
  // so the tests can prove the schema switch actually changes which field is read.
  const dailyData = [
    { date: '2026-08-31', schema1Delta: -4.38, schema3Delta: -4.00 },
    { date: '2026-09-01', schema1Delta: -4.21, schema3Delta: 46.74 }, // pure trading, before the month's fee sweep
    { date: '2026-09-02', schema1Delta: -0.09, schema3Delta: -0.09 },
    { date: '2026-09-03', schema1Delta: 3.82, schema3Delta: 3.82 },
    { date: '2026-09-04', schema1Delta: 46.42, schema3Delta: 46.42 },
  ];

  test('Schema 1 weekly total for the Aug31-Sep4 week matches the real report exactly ($41.56)', () => {
    const month = buildCalendarMonth({ year: 2026, month: 9, schema: 'schema1', dailyData });
    assert.equal(month.weeks[0].weeklyTotal, 41.56);
  });

  test('switching to Schema 3 reads schema3Delta instead, changing the weekly total', () => {
    const month = buildCalendarMonth({ year: 2026, month: 9, schema: 'schema3', dailyData });
    assert.notEqual(month.weeks[0].weeklyTotal, 41.56);
    const day = month.weeks[0].days.find((d) => d.date === '2026-09-01');
    assert.equal(day.delta, 46.74);
  });

  test('a day with no snapshot (weekend) has hasTrades:false, a null delta, and is excluded from the weekly total', () => {
    const month = buildCalendarMonth({ year: 2026, month: 9, schema: 'schema1', dailyData });
    const saturday = month.weeks[0].days.find((d) => d.date === '2026-09-05');
    assert.equal(saturday.hasTrades, false);
    assert.equal(saturday.delta, null);
  });

  test('a daily comment attaches to its own day only', () => {
    const month = buildCalendarMonth({
      year: 2026, month: 9, schema: 'schema1', dailyData,
      comments: [{ date: '2026-09-01', comment: 'Good breakout on TSLA' }],
    });
    const tue = month.weeks[0].days.find((d) => d.date === '2026-09-01');
    const wed = month.weeks[0].days.find((d) => d.date === '2026-09-02');
    assert.equal(tue.comment, 'Good breakout on TSLA');
    assert.equal(wed.comment, null);
  });

  test('Schema 2 view requires a profit-share percentage, rather than silently defaulting one', () => {
    assert.throws(() => buildCalendarMonth({ year: 2026, month: 9, schema: 'schema2', dailyData }));
  });

  test('Schema 2 view applies the monthly deduction on the last day with data in that month', () => {
    const month = buildCalendarMonth({ year: 2026, month: 9, schema: 'schema2', dailyData, profitSharePct: 50 });
    // Only Sep 1-4 count toward September's total (Aug 31 belongs to August).
    const septemberTotal = -4.21 - 0.09 + 3.82 + 46.42; // 45.94
    const expectedShare = septemberTotal > 0 ? septemberTotal * 0.5 : 0;
    const sep4 = month.weeks[0].days.find((d) => d.date === '2026-09-04');
    assert.ok(Math.abs(sep4.delta - (46.42 - expectedShare)) < 0.001);
  });
});

describe('assembleDayDetail — formats trade summaries it is given (does not derive them)', () => {
  test('groups trades, dedupes symbolsTraded, and passes through realized P&L and close status', () => {
    const detail = assembleDayDetail({
      date: '2026-09-04',
      schema: 'schema1',
      dailyDelta: 46.42,
      comment: 'Great follow-through day',
      trades: [
        { symbol: 'TSLA', direction: 'long', quantity: 50, realizedPnl: 46.46, isClosed: true },
        { symbol: 'TSLA', direction: 'long', quantity: 10 },
      ],
    });
    assert.deepEqual(detail.symbolsTraded, ['TSLA']);
    assert.equal(detail.trades.length, 2);
    assert.equal(detail.trades[0].isClosed, true);
    assert.equal(detail.trades[1].isClosed, false);
    assert.equal(detail.comment, 'Great follow-through day');
  });

  test('a day with no trades still assembles cleanly (e.g. to show just a comment)', () => {
    const detail = assembleDayDetail({ date: '2026-09-06', schema: 'schema1', dailyDelta: null, comment: 'No-trade day' });
    assert.deepEqual(detail.symbolsTraded, []);
    assert.deepEqual(detail.trades, []);
  });
});

describe('Calendar -> Weekly Report integration: daily comments become the suggested weekly draft', () => {
  test('a week with some daily comments produces the exact draft buildWeeklyCommentDraft would show at report time', async () => {
    const { buildWeeklyCommentDraft } = await import('../src/weeklyReport.js');
    const dailyData = [
      { date: '2026-08-31', schema1Delta: -4.38, schema3Delta: -4.38 },
      { date: '2026-09-01', schema1Delta: -4.21, schema3Delta: -4.21 },
      { date: '2026-09-02', schema1Delta: -0.09, schema3Delta: -0.09 },
      { date: '2026-09-03', schema1Delta: 3.82, schema3Delta: 3.82 },
      { date: '2026-09-04', schema1Delta: 46.42, schema3Delta: 46.42 },
    ];
    const comments = [
      { date: '2026-09-01', comment: 'Stayed patient, no forced trades.' },
      { date: '2026-09-04', comment: 'Great follow-through on the breakout.' },
    ];
    const month = buildCalendarMonth({ year: 2026, month: 9, schema: 'schema1', dailyData, comments });
    const weekOne = month.weeks[0].days.slice(0, 5); // Mon-Fri only, matching the report's 5-day structure

    const draft = buildWeeklyCommentDraft(weekDaysToCommentInput(weekOne));
    assert.equal(
      draft,
      'Tuesday: Stayed patient, no forced trades.\nFriday: Great follow-through on the breakout.'
    );
  });
});

