// Generates a sample Weekly Report PDF from the real Gabriela fixture.
// Run with: npm run generate:sample  (from packages/engine/)
// Output:   packages/engine/out/sample-weekly-report.pdf

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assembleWeeklyReportData } from '../src/weeklyReport.js';
import { renderWeeklyReportPdf } from '../src/weeklyReportPdf.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../test/fixtures/gabriela-2026-08-31-week.json'), 'utf8')
);

const days = fixture.days.map((label, i) => ({
  label,
  date: fixture.dates[i],
  totalDelta: fixture.totalDelta[i],
  accountValue: fixture.accountValue[i],
}));

const report = assembleWeeklyReportData({
  accountName: fixture.accountName,
  accountCode: fixture.accountCode,
  weekStart: fixture.weekStart,
  weekEnd: fixture.weekEnd,
  days,
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
  weeklyComment:
    "Overall recovered from the previous week\u2019s bad streak and was patient enough to wait for the right moment to enter the trades i was watching.",
});

const bytes = await renderWeeklyReportPdf(report);
mkdirSync(join(__dirname, '../out'), { recursive: true });
writeFileSync(join(__dirname, '../out/sample-weekly-report.pdf'), bytes);
console.log('written', bytes.length, 'bytes ->', join(__dirname, '../out/sample-weekly-report.pdf'));
