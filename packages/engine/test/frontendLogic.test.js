import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStatistics, tradeR } from '../src/statistics.js';
import { dailySeries, cumulative } from '../src/schemaSeries.js';
import { buildWeekInput, mondayOf } from '../src/weekBuilder.js';
import { assembleWeeklyReportData, buildWeeklyCommentDraft } from '../src/weeklyReport.js';
import { formatPercent, formatSignedParenPair, formatSignedParen } from '../src/format.js';
import { renderWeeklyReportPdf } from '../src/weeklyReportPdf.js';
import { buildDailySnapshots } from '../src/dailySnapshots.js';

const T = (sym, dir, pnl, fees, open, close, extra = {}) => ({ symbol: sym, direction: dir, realizedPnl: pnl, feesAllocated: fees, quantityTraded: 200, avgEntryPrice: 10, openedAt: new Date(open), closedAt: new Date(close), ...extra });

test('statistics: win rate counts TRADES; profit factor, expectancy, streaks, schema basis', () => {
  const trades = [
    T('A', 'long', 100, 5, '2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z'),
    T('B', 'long', -40, 5, '2026-09-02T14:00:00Z', '2026-09-02T15:00:00Z'),
    T('C', 'short', 60, 5, '2026-09-03T14:00:00Z', '2026-09-03T15:00:00Z'),
    T('D', 'short', 20, 5, '2026-09-04T14:00:00Z', '2026-09-04T15:00:00Z'),
    T('E', 'long', -10, 5, '2026-09-07T14:00:00Z', '2026-09-07T15:00:00Z'),
  ];
  const g = computeStatistics(trades, 'schema3');
  assert.equal(g.trades, 5);
  assert.equal(g.winRate, 0.6);
  assert.equal(g.avgWinner, 60);
  assert.equal(g.avgLoser, -25);
  assert.equal(g.profitFactor, 3.6);        // 180 / 50
  assert.equal(g.expectancy, 26);           // 130 / 5
  assert.equal(g.maxConsecutiveWins, 2);
  assert.equal(g.maxConsecutiveLosses, 1);
  assert.equal(g.largestWinner, 100);
  const n = computeStatistics(trades, 'schema1');   // net of fees: every result is 5 lower
  assert.equal(n.total, 105);
  assert.equal(n.largestWinner, 95);
  assert.deepEqual(n.longVsShort.map((x) => x.key).sort(), ['long', 'short']);
  assert.deepEqual(g.byDayOfWeek.map((x) => x.key), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
});

test('statistics: no losers → profit factor is null (not Infinity); empty set is all-null, never zeros', () => {
  const s = computeStatistics([T('A', 'long', 10, 0, '2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z')], 'schema3');
  assert.equal(s.profitFactor, null);
  const e = computeStatistics([], 'schema3');
  assert.deepEqual([e.trades, e.winRate, e.expectancy, e.avgWinner], [0, null, null, null]);
});

test('statistics: date range applies to the day each trade closed; R only for valid stops', () => {
  const t = [T('A', 'long', 100, 0, '2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z', { stopLoss: 9 }), T('B', 'long', 50, 0, '2026-09-10T14:00:00Z', '2026-09-10T15:00:00Z', { stopLoss: 11 })];
  assert.equal(computeStatistics(t, 'schema3', { fromDate: '2026-09-05' }).trades, 1);
  assert.equal(tradeR(t[0], 'schema3'), 1);       // risk = 100 sh × $1 = 100 → 100/100
  assert.equal(tradeR(t[1], 'schema3'), null);    // stop above entry on a long = invalid → no fake R
});

test('daily series: each schema reads only its own column; Schema 2 deducts the monthly share ONCE', () => {
  const snaps = [
    { date: '2026-09-01', schema1Delta: 600, schema3Delta: 700 },
    { date: '2026-09-02', schema1Delta: 400, schema3Delta: 450 },
    { date: '2026-10-01', schema1Delta: -100, schema3Delta: -50 },
  ];
  const sched = [{ pct: 50, effectiveFrom: '2000-01-01' }];
  assert.deepEqual(dailySeries(snaps, 'schema3').map((d) => d.delta), [700, 450, -50]);
  const s2 = dailySeries(snaps, 'schema2', sched);
  assert.deepEqual(s2.map((d) => d.delta), [600, -100, -100]);   // Sept total 1000 → −500 on its last day; Oct loss untouched
  assert.equal(cumulative(s2).at(-1).value, 400);                // 500 (Sept after share) − 100
});

// ---- the user's real week, end to end through the same functions the Weekly Report tab uses ----
const posRow = (date, d) => ({ Date: date, Symbol: 'ABC', Realized: '0', 'Unrealized Delta': String(d), Comm: '0', 'Ecn Fee': '0', SEC: '0', TAF: '0', NSCC: '0', Clr: '0', Misc: '0', 'Qty Traded': '0', Currency: 'USD' });
function realWeekSnapshots() {
  const { rows } = buildDailySnapshots({
    positionRows: [['2026-08-31', -4.38], ['2026-09-01', -4.21], ['2026-09-02', -0.09], ['2026-09-03', 3.82], ['2026-09-04', 46.42]].map(([d, v]) => posRow(d, v)),
    adjustments: [{ date: '2026-09-01', categoryName: 'Fee: Platform', amount: -25.95, categoryType: 'fee' }, { date: '2026-09-01', categoryName: 'Fee: Market Data', amount: -25, categoryType: 'fee' }],
    startingAccountValue: -637.07,
  });
  return rows.map((r) => ({ ...r, date: r.tradeDate }));
}

test('Weekly Report data for the real week: daily Total Δ, account value incl. the Sep-1 fee gap, and all four automatic totals', () => {
  assert.equal(mondayOf('2026-09-02'), '2026-08-31');
  assert.equal(mondayOf('2026-08-31'), '2026-08-31');
  assert.equal(mondayOf('2026-09-06'), '2026-08-31'); // Sunday belongs to the week that started Monday
  const closed = [
    { symbol: 'WIN', direction: 'long', realizedPnl: 23.18, feesAllocated: 0, quantityTraded: 20, avgEntryPrice: 5, openedAt: new Date('2026-08-18T14:00:00Z'), closedAt: new Date('2026-09-04T19:00:00Z') },
    { symbol: 'LOSS', direction: 'long', realizedPnl: -0.0416, feesAllocated: 0, quantityTraded: 4, avgEntryPrice: 5, openedAt: new Date('2026-09-03T14:00:00Z'), closedAt: new Date('2026-09-03T14:05:00Z') },
  ];
  const w = buildWeekInput({ weekStart: '2026-08-31', snapshots: realWeekSnapshots(), closedTrades: closed, dailyComments: [{ date: '2026-09-04', comment: 'Waited for the setup.' }] });
  assert.deepEqual(w.days.map((d) => d.totalDelta), [-4.38, -4.21, -0.09, 3.82, 46.42]);
  assert.deepEqual(w.days.map((d) => d.accountValue), [-641.45, -696.61, -696.7, -692.88, -646.46]);
  const r = assembleWeeklyReportData({ accountName: 'Gabriela Nikolova', accountCode: 'FPTI000645A404', ...w, weeklyComment: buildWeeklyCommentDraft(w.commentDays) });
  assert.equal(r.totals.totalDeltaWeeklyPnl, 41.56);
  assert.equal(formatSignedParen(r.totals.averageDailyDelta), '8.31');
  assert.deepEqual([r.totals.upDays, r.totals.downDays], [2, 3]);
  assert.equal(formatSignedParen(r.totals.maxDrawdown), '(8.68)');
  assert.equal(r.propReportsNative.bat, 0.5);
  assert.equal(r.propReportsNative.avgNetWinner, 23.18);
  assert.equal(r.propReportsNative.avgHoldTime.startsWith('8d'), true);
  assert.equal(r.weeklyComment, 'Friday: Waited for the setup.');
});

test('a weekday with no data shows Δ 0 and the carried account value (holiday week)', () => {
  const w = buildWeekInput({ weekStart: '2026-08-31', snapshots: realWeekSnapshots().filter((s) => s.date !== '2026-09-02'), closedTrades: [], dailyComments: [] });
  assert.equal(w.days[2].totalDelta, 0);
  assert.equal(w.days[2].accountValue, -696.61);
});

test('a quiet week: stats that cannot be computed come out BLANK in the report, not 0 / NaN', () => {
  const w = buildWeekInput({ weekStart: '2026-08-31', snapshots: realWeekSnapshots(), closedTrades: [], dailyComments: [] });
  assert.equal(w.propReportsNative.bat, null);
  assert.equal(formatPercent(null), '');
  assert.equal(formatSignedParenPair(null, null), '');
  assert.equal(formatSignedParen(undefined), '');
});

test('PDF still renders with blank stats and a long multi-line comment', async () => {
  const w = buildWeekInput({ weekStart: '2026-08-31', snapshots: realWeekSnapshots(), closedTrades: [], dailyComments: [] });
  const bytes = await renderWeeklyReportPdf(assembleWeeklyReportData({ accountName: 'Gabriela Nikolova', accountCode: 'FPTI000645A404', ...w, weeklyComment: 'Line one.\nLine two with more words '.repeat(6) }));
  assert.ok(bytes.length > 3000);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
});
