// Tests for the October review round: lots, original/current stops, period stats, overall stats, account label.
import test from 'node:test';
import assert from 'node:assert/strict';
import { remainingEntries, buildLots, proposeSplitByDay, rollUpLots, entryKey } from '../src/positionLots.js';
import { enrichPosition, summarizePortfolio } from '../src/positionAnalytics.js';
import { summarizePeriod, aggregateSeries } from '../src/calendar.js';
import { computeOverallStats } from '../src/overallStats.js';
import { parseAccountLabel } from '../src/weeklyReport.js';
import { renderWeeklyReportPdf } from '../src/weeklyReportPdf.js';
import { assembleWeeklyReportData } from '../src/weeklyReport.js';
import { PDFParse } from 'pdf-parse';

const F = (datetime, side, quantity, price) => ({ datetime, side, quantity, price });
const Q = (price) => ({ ok: true, price, asOf: '2026-10-30T20:00:00Z', session: 'closed', source: 'yahoo' });

test('two separate buys of the same ticker are recovered as two entries; a partial sell reduces the OLDEST first (FIFO)', () => {
  const fills = [F('2026-10-01T14:00:00Z', 'B', 100, 10), F('2026-10-08T15:00:00Z', 'B', 50, 12), F('2026-10-09T15:00:00Z', 'S', 30, 13)];
  const e = remainingEntries(fills, 'long');
  assert.deepEqual(e.map((x) => [x.date, x.remaining, x.price]), [['2026-10-01', 70, 10], ['2026-10-08', 50, 12]]);
  assert.deepEqual(proposeSplitByDay(e).map((a) => a.lot), [0, 1]);
});

test('lots: each keeps its own entry and stops; shares added after the split are never hidden', () => {
  const fills = [F('2026-10-01T14:00:00Z', 'B', 100, 10), F('2026-10-08T15:00:00Z', 'B', 50, 12), F('2026-10-20T15:00:00Z', 'B', 10, 14)];
  const e = remainingEntries(fills, 'long');
  const lots = buildLots(e, [
    { id: 'L1', label: 'Lot 1', entryKeys: [entryKey(fills[0])], originalStop: 9, currentStop: 10.5 },
    { id: 'L2', label: 'Lot 2', entryKeys: [entryKey(fills[1])], originalStop: 11, currentStop: 11 },
  ], { originalStop: 9.5, currentStop: null });
  assert.deepEqual(lots.map((l) => [l.label, l.quantity, l.entry, l.originalStop]), [['Lot 1', 100, 10, 9], ['Lot 2', 50, 12, 11], ['Not in a lot', 10, 14, 9.5]]);
  assert.deepEqual(buildLots(e, [], {}), [], 'no saved lots → one position');
});

test('short entries are T fills and covers (C) close them', () => {
  const e = remainingEntries([F('2026-10-01T14:00:00Z', 'T', 100, 20), F('2026-10-02T14:00:00Z', 'C', 40, 18)], 'short');
  assert.deepEqual(e.map((x) => x.remaining), [60]);
});

test('ORIGINAL stop drives R; CURRENT stop may be past the entry (derisked) and is never rejected', () => {
  const p = enrichPosition({ symbol: 'AAA', direction: 'long', openQuantity: 100, avgEntryPrice: 10, originalStop: 9, currentStop: 10.5 }, Q(12));
  assert.deepEqual(p.currentR, { status: 'ok', value: 2 });        // (12−10)/(10−9), from the ORIGINAL stop
  assert.equal(p.riskStatus, 'ok');
  assert.equal(p.derisked, true);
  assert.equal(p.riskToStop, -50);                                  // stopped at 10.50 locks +$50
  assert.equal(p.potentialLossToStop, 150);                         // from 12 back to 10.50
  const s = summarizePortfolio([p]);
  assert.equal(s.totalRiskToStops, 0);
  assert.equal(s.lockedByStops, 50);
  assert.deepEqual(s.derisked, ['AAA']);
});

test('current stop defaults to the original stop until it is moved', () => {
  const p = enrichPosition({ symbol: 'AAA', direction: 'long', openQuantity: 100, avgEntryPrice: 10, originalStop: 9 }, Q(11));
  assert.equal(p.currentStop, 9);
  assert.equal(p.riskToStop, 100);
  assert.equal(p.derisked, false);
});

test('a split position reports risk as the sum of its lots', () => {
  const base = { symbol: 'AAA', direction: 'long', openQuantity: 150, avgEntryPrice: 10.67 };
  const l1 = enrichPosition({ ...base, openQuantity: 100, avgEntryPrice: 10, originalStop: 9, currentStop: 10.5 }, Q(12));
  const l2 = enrichPosition({ ...base, openQuantity: 50, avgEntryPrice: 12, originalStop: 11 }, Q(12));
  const p = rollUpLots(enrichPosition(base, Q(12)), [l1, l2]);
  assert.equal(p.riskToStop, 0);   // −50 locked + 50 at risk
  assert.equal(p.riskStatus, 'ok');
  assert.equal(p.derisked, false);
});

test('period summary: month P&L, green / red days and green %', () => {
  const series = [{ date: '2026-09-01', delta: -55.16 }, { date: '2026-09-02', delta: -0.09 }, { date: '2026-09-03', delta: 3.82 }, { date: '2026-09-04', delta: 46.42 }, { date: '2026-10-01', delta: 5 }];
  assert.deepEqual(summarizePeriod(series, '2026-09-01', '2026-09-30'), { pnl: -5.01, days: 4, greenDays: 2, redDays: 2, greenPct: 0.5 });
  assert.deepEqual(aggregateSeries(series, 'month').map((m) => [m.key, m.pnl]), [['2026-09', -5.01], ['2026-10', 5]]);
  assert.deepEqual(aggregateSeries(series, 'year').map((m) => [m.key, m.pnl, m.greenDays]), [['2026', -0.01, 3]]);
});

test('overall stats: headline + sections, worst 10 lists the biggest losers', () => {
  const T = (symbol, pnl, open, close, qty = 200) => ({ symbol, direction: 'long', openedAt: new Date(open), closedAt: new Date(close), realizedPnl: pnl, feesAllocated: 1, quantityTraded: qty, avgEntryPrice: 5 });
  const trades = [T('AAA', 51, '2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z'), T('BBB', -21, '2026-09-02T14:00:00Z', '2026-09-04T15:00:00Z'), T('CCC', -9, '2026-09-03T14:00:00Z', '2026-09-03T14:30:00Z'), T('AAA', 11, '2026-09-08T14:00:00Z', '2026-09-10T15:00:00Z')];
  const o = computeOverallStats(trades, 'schema1', [{ date: '2026-09-01', delta: 50 }, { date: '2026-09-04', delta: -22 }]);
  assert.equal(o.headline.netPnl, 28);                 // (50 + 10) − (22 + 10)
  assert.equal(o.headline.winRate, 0.5);
  assert.equal(o.headline.wlRatio, 1.88);              // 30 / 16
  assert.equal(o.headline.profitFactor, 1.88);
  assert.deepEqual(o.worstSymbols.map((s) => s.key), ['BBB', 'CCC']);
  assert.equal(o.topSymbols[0].key, 'AAA');
  assert.deepEqual(o.sections.map((s) => s.id), ['pnl', 'scores', 'volume', 'symbols', 'duration', 'fees']);
  const dur = o.sections.find((s) => s.id === 'duration').groups[1].rows;
  assert.equal(dur.find((r) => r[0] === 'Intraday trades')[1], 2);
});

test('PropReports account label → name and account code (no typing the name in Settings)', () => {
  assert.deepEqual(parseAccountLabel('FPTI000645A404 Gabriela Nikolova'), { code: 'FPTI000645A404', name: 'Gabriela Nikolova' });
  assert.deepEqual(parseAccountLabel('Account: FPTI000645A404 Gabriela Nikolova'), { code: 'FPTI000645A404', name: 'Gabriela Nikolova' });
  assert.deepEqual(parseAccountLabel('FPTI000645A404', 'Gabriela Nikolova'), { code: 'FPTI000645A404', name: 'Gabriela Nikolova' });
});

test('PDF: the account line shows ONLY the code; comment and tables carry the agreed text', async () => {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((label, i) => ({ label, date: `2026-09-0${i}`, totalDelta: [-4.38, -4.21, -0.09, 3.82, 46.42][i], accountValue: -600 }));
  const r = assembleWeeklyReportData({ ...parseAccountLabel('FPTI000645A404 Gabriela Nikolova'), accountName: 'Gabriela Nikolova', accountCode: 'FPTI000645A404', weekStart: '2026-08-31', weekEnd: '2026-09-04', days, propReportsNative: { realizedNet: 8.59, quantity: 32, bat: 0.5, wlRatio: 557.22, avgSizeInPosition: 5, avgNetWinner: 23.18, avgNetLoser: -0.04, avgHoldTime: '13d 12:37:38', biggestNetWinner: 23.18, biggestNetLoser: -0.04 }, weeklyComment: 'Patient week.' });
  const bytes = await renderWeeklyReportPdf(r);
  const parser = new PDFParse({ data: Buffer.from(bytes) });
  const text = (await parser.getText()).text;
  assert.match(text, /Account: FPTI000645A404\b/);
  assert.ok(!/Account: FPTI000645A404 Gabriela/.test(text));
  assert.match(text, /Patient week\./);
});
