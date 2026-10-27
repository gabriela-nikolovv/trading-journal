import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTradeStats, formatHold } from '../src/tradeStats.js';

const trade = (pnl, fees, open, close) => ({ status: 'closed', realizedPnl: pnl, feesAllocated: fees, openedAt: new Date(open), closedAt: new Date(close) });

test('hold-time label matches the report style (13d 12:37:38)', () => {
  assert.equal(formatHold(((13 * 24 + 12) * 3600 + 37 * 60 + 38) * 1000), '13d 12:37:38');
});

test('BAT, W/L, biggest winner/loser follow PropReports definitions (shape of the real week: 1 winner, 1 loser → BAT 50%)', () => {
  // Synthetic trades chosen to mirror the real report's published figures (23.18 / (0.04), W/L 557.22).
  // This checks the formulas; the REAL check needs the actual fills from the API.
  const s = computeTradeStats([
    trade(23.5, 0.32, '2026-08-18T14:00:00Z', '2026-09-04T20:00:00Z'),
    trade(-0.0416, 0, '2026-09-03T14:00:00Z', '2026-09-03T14:05:00Z'),
  ]);
  assert.equal(s.completedTrades, 2);
  assert.equal(s.bat, 0.5);
  assert.equal(s.avgNetWinner, 23.18);
  assert.equal(s.wlRatio, 557.21); // 23.18 / 0.0416
  assert.equal(s.biggestNetWinner, 23.18);
  assert.equal(s.biggestNetLoser, -0.0416);
});

test('a trade is counted on the day it goes flat; open trades and out-of-range trades are excluded', () => {
  const t = [trade(10, 0, '2026-08-01T10:00:00Z', '2026-09-01T10:00:00Z'), { ...trade(5, 0, '2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z'), status: 'open', closedAt: null }];
  assert.equal(computeTradeStats(t, { fromDate: '2026-08-31', toDate: '2026-09-04' }).completedTrades, 1);
  assert.equal(computeTradeStats(t, { fromDate: '2026-09-02', toDate: '2026-09-04' }).completedTrades, 0);
});

test('wash trades (exactly $0 net) are excluded from BAT; no losers → W/L is null, never Infinity', () => {
  const s = computeTradeStats([trade(5, 0, '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'), trade(2, 2, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z')]);
  assert.equal(s.washes, 1);
  assert.equal(s.bat, 1);
  assert.equal(s.wlRatio, null);
});
