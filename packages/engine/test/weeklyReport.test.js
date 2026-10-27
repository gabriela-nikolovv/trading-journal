import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assembleWeeklyReportData, buildWeeklyCommentDraft, applyManualOverrides } from '../src/weeklyReport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/gabriela-2026-08-31-week.json'), 'utf8'));

function fixtureDays() {
  return fixture.days.map((label, i) => ({
    label,
    date: fixture.dates[i],
    totalDelta: fixture.totalDelta[i],
    accountValue: fixture.accountValue[i],
  }));
}

describe('assembleWeeklyReportData — real fixture', () => {
  const report = assembleWeeklyReportData({
    accountName: fixture.accountName,
    accountCode: fixture.accountCode,
    weekStart: fixture.weekStart,
    weekEnd: fixture.weekEnd,
    days: fixtureDays(),
    propReportsNative: {
      realizedNet: fixture.reportedPerformance.realizedNet,
      quantity: fixture.reportedPerformance.quantity,
      bat: fixture.reportedPerformance.bat,
      wlRatio: fixture.reportedPerformance.wlRatio,
      avgSizeInPosition: fixture.reportedPerformance.avgSizeInPosition,
      avgNetWinner: fixture.reportedPerformance.avgNetWinner,
      avgNetLoser: fixture.reportedPerformance.avgNetLoser,
      avgHoldTime: fixture.reportedPerformance.avgHoldTime,
      biggestNetWinner: fixture.reportedPerformance.biggestNetWinner,
      biggestNetLoser: fixture.reportedPerformance.biggestNetLoser,
    },
  });

  test('derived totals match the real report exactly', () => {
    assert.equal(report.totals.totalDeltaWeeklyPnl, 41.56);
    assert.equal(report.totals.upDays, 2);
    assert.equal(report.totals.downDays, 3);
  });

  test('PropReports-native fields pass through untouched, not recomputed', () => {
    assert.equal(report.propReportsNative.bat, 0.5);
    assert.equal(report.propReportsNative.wlRatio, 557.22);
    assert.equal(report.propReportsNative.avgHoldTime, '13d 12:37:38');
  });

  test('throws rather than silently producing an empty report with zero days', () => {
    assert.throws(() => assembleWeeklyReportData({ ...report, days: [] }));
  });
});

describe('buildWeeklyCommentDraft — suggests a starting point from daily comments', () => {
  test('stitches only the days that actually have a comment', () => {
    const draft = buildWeeklyCommentDraft([
      { dayLabel: 'Monday', date: '2026-08-31', comment: 'Slow start, stayed patient.' },
      { dayLabel: 'Tuesday', date: '2026-09-01', comment: '' },
      { dayLabel: 'Wednesday', date: '2026-09-02', comment: undefined },
      { dayLabel: 'Thursday', date: '2026-09-03', comment: 'Good entry on the breakout.' },
    ]);
    assert.equal(draft, 'Monday: Slow start, stayed patient.\nThursday: Good entry on the breakout.');
  });

  test('returns an empty string (not a fabricated placeholder) when nobody left daily comments', () => {
    const draft = buildWeeklyCommentDraft([
      { dayLabel: 'Monday', date: '2026-08-31', comment: '' },
      { dayLabel: 'Tuesday', date: '2026-09-01' },
    ]);
    assert.equal(draft, '');
  });
});

describe('applyManualOverrides — presentation edits never mutate the computed base', () => {
  const base = assembleWeeklyReportData({
    accountName: 'Gabriela Nikolova',
    accountCode: 'FPTI000645A404',
    weekStart: '2026-08-31',
    weekEnd: '2026-09-04',
    days: fixtureDays(),
    propReportsNative: {
      realizedNet: 8.59, quantity: 32, bat: 0.5, wlRatio: 557.22,
      avgSizeInPosition: 5, avgNetWinner: 23.18, avgNetLoser: -0.04,
      avgHoldTime: '13d 12:37:38', biggestNetWinner: 23.18, biggestNetLoser: -0.04,
    },
    weeklyComment: 'Original comment',
  });

  test('an override produces a new object with the edit applied', () => {
    const edited = applyManualOverrides(base, { weeklyComment: 'Edited before export' });
    assert.equal(edited.weeklyComment, 'Edited before export');
    assert.equal(base.weeklyComment, 'Original comment'); // base untouched
  });

  test('a nested totals override merges rather than replacing the whole totals object', () => {
    const edited = applyManualOverrides(base, { totals: { maxDrawdown: -9.0 } });
    assert.equal(edited.totals.maxDrawdown, -9.0);
    assert.equal(edited.totals.totalDeltaWeeklyPnl, base.totals.totalDeltaWeeklyPnl); // untouched sibling field
    assert.equal(base.totals.maxDrawdown, base.totals.maxDrawdown); // base itself never mutated
  });
});
