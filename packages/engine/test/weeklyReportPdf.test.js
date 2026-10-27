import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { assembleWeeklyReportData } from '../src/weeklyReport.js';
import { renderWeeklyReportPdf } from '../src/weeklyReportPdf.js';

// pdf-parse v2 ships CJS internals under an ESM package wrapper that doesn't
// synthesize a clean `default` export — createRequire sidesteps the mismatch.
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

async function extractText(bytes) {
  const parser = new PDFParse({ data: Buffer.from(bytes) });
  const info = await parser.getInfo();
  const { text } = await parser.getText();
  await parser.destroy();
  return { text, numpages: info.total };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/gabriela-2026-08-31-week.json'), 'utf8'));

function buildReport(overrides = {}) {
  const days = fixture.days.map((label, i) => ({
    label,
    date: fixture.dates[i],
    totalDelta: fixture.totalDelta[i],
    accountValue: fixture.accountValue[i],
  }));
  return assembleWeeklyReportData({
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
      overrides.weeklyComment ??
      'Overall recovered from the previous week\u2019s bad streak and was patient enough to wait for the right moment to enter the trades i was watching.',
  });
}

describe('renderWeeklyReportPdf — round-trip against the real fixture', () => {
  test('produces a single-page PDF containing every real figure from the report', async () => {
    const bytes = await renderWeeklyReportPdf(buildReport());
    assert.ok(bytes.length > 1000, 'PDF should be a non-trivial size');

    const { text, numpages } = await extractText(bytes);
    assert.equal(numpages, 1);

    for (const expected of [
      'Gabriela Nikolova',
      'FPTI000645A404',
      'Weekly Trading Report',
      'TOTAL Δ (Weekly P&L)',
      '41.56',
      '8.59',
      '557.22',
      '13d 12:37:38',
      'PERFORMANCE',
      'COMMENT',
      'recovered from the previous',
    ]) {
      assert.ok(text.includes(expected), `expected PDF text to include "${expected}"`);
    }
  });

  test('negative daily deltas render with parentheses, not a bare minus sign', async () => {
    const bytes = await renderWeeklyReportPdf(buildReport());
    const { text } = await extractText(bytes);
    assert.ok(text.includes('(4.38)'));
    assert.ok(!text.includes('-4.38'));
  });

  test('a long weekly comment wraps onto multiple lines without throwing', async () => {
    const longComment = 'This week was volatile. '.repeat(20).trim();
    const bytes = await renderWeeklyReportPdf(buildReport({ weeklyComment: longComment }));
    const { text } = await extractText(bytes);
    assert.ok(text.includes('This week was volatile.'));
  });

  test('an empty weekly comment renders cleanly (no placeholder text fabricated)', async () => {
    const bytes = await renderWeeklyReportPdf(buildReport({ weeklyComment: '' }));
    const { text } = await extractText(bytes);
    assert.ok(text.includes('COMMENT'));
  });
});
