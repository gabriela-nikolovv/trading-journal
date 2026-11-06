// Regression tests on the user's REAL PropReports numbers, 19 Oct – 4 Nov 2026
// (fixture built from the Totals by Date / Summary by Date / Trades exports, values unrounded as exported).
// Before the fix the app showed e.g. 20 Oct Day Total (0.91) instead of (0.93) and 30 Oct (14.45)
// instead of (14.52): the "ECN Fee" column was read as 'Ecn Fee' and came back as 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDailySnapshots } from '../src/dailySnapshots.js';
import { normalizeFillRow } from '../src/normalize.js';
import { tradeFeeTotal, toNumber } from '../src/csv.js';
import { buildCalendarMonth } from '../src/calendar.js';
import { dailySeries } from '../src/schemaSeries.js';
import { runSync } from '../src/syncEngine.js';
import { createMemoryStore, fakeClient } from './helpers/memoryStore.js';

const F = JSON.parse(fs.readFileSync(new URL('./fixtures/gabriela-2026-10-19-to-11-04.json', import.meta.url), 'utf8'));
const c2 = (x) => Math.round((x + Math.sign(x) * 1e-9) * 100) / 100; // display rounding (cents)

// API-shaped input: `positions` rows (Realized = PropReports Gross, fee columns under PropReports' names)
// and `adjustments` (every "Fee: …" row).
const positionRows = F.days.flatMap((d) => d.symbols.map((s) => ({
  Date: d.date, Symbol: s.symbol, Realized: String(s.gross), 'Unrealized Delta': String(s.unrealizedDelta), 'Qty Traded': String(s.qty), Currency: 'USD', ...s.fees,
})));
const adjustments = F.days.flatMap((d) => d.fees.map((f) => ({ date: d.date, categoryName: f.name, amount: f.amount, categoryType: 'fee' })));
const snap = buildDailySnapshots({ positionRows, adjustments, startingAccountValue: F.startingAccountValue });
const byDate = new Map(snap.rows.map((r) => [r.tradeDate, r]));

test('every symbol, every day: Realized = PropReports Net, Total = PropReports Total Δ (exact, unrounded)', () => {
  for (const d of F.days) for (const s of d.symbols) {
    const x = snap.symbolRows.find((r) => r.tradeDate === d.date && r.symbol === s.symbol);
    assert.equal(x.net, s.net, `${d.date} ${s.symbol} Net`);
    assert.equal(x.unrealizedDelta, s.unrealizedDelta, `${d.date} ${s.symbol} Unrealized Δ`);
    assert.equal(x.totalDelta, s.totalDelta, `${d.date} ${s.symbol} Total Δ`);
  }
});

test('the days reported as wrong now show PropReports’ figures', () => {
  const sym = (date, symbol) => snap.symbolRows.find((r) => r.tradeDate === date && r.symbol === symbol);
  // 20 Oct: ARM Net (5.14), Day Total (0.93)
  assert.equal(c2(sym('2026-10-20', 'ARM').net), -5.14);
  assert.equal(c2(byDate.get('2026-10-20').schema1Delta), -0.93);
  // 30 Oct, per symbol
  assert.deepEqual(['MDLZ', 'AZN', 'DOCS', 'CDNA'].map((s) => [c2(sym('2026-10-30', s).net), c2(sym('2026-10-30', s).totalDelta)]),
    [[-11.18, -11.18], [10.51, 10.51], [-0.58, -8.53], [-5.32, -5.32]]);
  assert.equal(c2(byDate.get('2026-10-30').schema1Delta), -14.52);
  // 29 Oct: the line after Equities + Fees
  assert.equal(c2(byDate.get('2026-10-29').schema1Delta), -7.26);
  // 1 Nov: only the monthly fees
  assert.equal(c2(byDate.get('2026-11-01').schema1Delta), -50.95);
});

test('Total = PropReports Day Total Δ, Pure trading = PropReports Equities Total Δ, account value = End Balance — every day', () => {
  for (const d of F.days) {
    const r = byDate.get(d.date);
    assert.equal(r.schema1Delta, Math.round(d.dayTotal * 10000) / 10000, `${d.date} Total`);
    assert.equal(r.schema3Delta, d.equitiesTotal, `${d.date} Pure trading`);
    assert.equal(r.accountValue, d.endBalance, `${d.date} account value`);
    // Pure trading leaves out exactly the "Fee: …" rows
    assert.equal(Math.round((r.schema3Delta - r.schema1Delta) * 10000) / 10000 + 0, Math.round(-d.fees.reduce((a, f) => a + f.amount, 0) * 10000) / 10000 + 0, `${d.date} Fee rows`);
  }
});

test('period totals match the Summary by Date "Equities" line', () => {
  const sum = (k) => Math.round(snap.rows.reduce((a, r) => a + r[k], 0) * 10000) / 10000;
  assert.equal(sum('schema1Delta'), F.periodTotals.totalDelta);           // (113.91)
  assert.equal(sum('realizedNet'), F.periodTotals.net);                   // 12.43 — the weekly REALIZED NET source
  assert.equal(sum('schema3Delta'), Math.round((F.periodTotals.net + F.periodTotals.unrealizedDelta) * 10000) / 10000);
  assert.equal(snap.rows.at(-1).accountValue, F.periodTotals.endBalance);  // (1,008.43)
});

test('calendar weeks and months, each P&L type', () => {
  const daily = snap.rows.map((r) => ({ ...r, date: r.tradeDate }));
  const oct = (schema) => buildCalendarMonth({ year: 2026, month: 10, schema, dailyData: daily, profitSharePct: 50 });
  const week = (cal, monday) => cal.weeks.find((w) => w.days[0].date === monday).weeklyTotal;
  // week Mon 19 – Sun 25 Oct, week Mon 26 Oct – Sun 1 Nov (the Sunday 1 Nov fees are in it)
  assert.equal(c2(week(oct('schema1'), '2026-10-19')), 5.07);
  assert.equal(c2(week(oct('schema1'), '2026-10-26')), -118.98);
  // Pure trading = Σ PropReports Equities Total Δ: 6.16 − 0.8969 + 3.08 − 3.16 + 0.10 | −0.22 + 10.1684 + 22.14 − 7.2022 − 14.5194
  assert.equal(c2(week(oct('schema3'), '2026-10-19')), 5.28);
  assert.equal(c2(week(oct('schema3'), '2026-10-26')), 10.37);
  // October in Total is negative → After Share takes nothing, so it equals Total
  const sumMonth = (schema, m) => c2(dailySeries(daily, schema, [{ pct: 50, effectiveFrom: '2000-01-01' }]).filter((p) => p.date.startsWith(m)).reduce((a, p) => a + p.delta, 0));
  assert.equal(sumMonth('schema2', '2026-10'), sumMonth('schema1', '2026-10'));
  assert.equal(sumMonth('schema1', '2026-11'), -50.95);
  assert.equal(sumMonth('schema3', '2026-11'), 0);
});

test('fills: every fee column counts, whatever its case — a trade’s Net matches the Trades report', () => {
  for (const t of F.trades) assert.equal(Math.round((t.gross - tradeFeeTotal(t.fees)) * 1e8) / 1e8, Math.round(t.net * 1e8) / 1e8, t.symbol);
  const total = F.trades.reduce((a, t) => a + t.gross - tradeFeeTotal(t.fees), 0);
  assert.equal(Math.round(total * 1e6) / 1e6, Math.round(F.tradePerformance.winLossNetRealized * 1e6) / 1e6); // Trade Performance: Net Realized 56.77
  const fill = normalizeFillRow({ 'Date/Time': '2026-10-30 09:23:36', Symbol: 'AZN', 'B/S': 'B', Qty: '5', Price: '184.18', ...F.trades.find((t) => t.symbol === 'AZN').fees }, 'a1');
  assert.equal(fill.ecnFee, 0.012);
  assert.equal(Math.round(fill.totalFee * 1e4) / 1e4, 0.0904); // incl. CAT 0.0004, which the old code ignored
});

test('one number reader: parentheses, commas, plain numbers', () => {
  assert.deepEqual(['(1,008.43)', '-1008.4298', '1,234.5', '', 7.95].map(toNumber), [-1008.43, -1008.4298, 1234.5, 0, 7.95]);
});

test('sync: Cash in parentheses is read, a balance gap on a full download is reported, column names are returned', async () => {
  const store = createMemoryStore();
  const positions = positionRows.filter((r) => r.Date === '2026-10-30');
  const r = await runSync({ client: fakeClient({ positions, accounts: [{ 'Account Id': '348', 'First Traded': '2026-10-30', Cash: '(1,008.43)', Unrealized: '0' }] }), store, today: '2026-11-04' });
  assert.ok(r.ok);
  assert.equal(store.state.snapshots.at(-1).accountValue, -1008.43);
  const gap = r.warnings.find((w) => w.type === 'history_gap');
  assert.ok(gap && gap.message.includes('-993.91'), gap?.message);
  assert.ok(r.diagnostics.columns.positions.includes('ECN Fee'));
});

test('27 Oct: fees are taken from the fills of that day, even when the positions rows book them on another day', () => {
  // The positions rows here carry each stock's fees on the day it CLOSES (opening fees moved there),
  // which gives 0.00 on 27 Oct (Gross 0). The fills are dated by execution, like Totals by Date.
  const zero = Object.fromEntries(Object.keys(F.days[0].symbols[0].fees).map((k) => [k, '0']));
  const fillCosts = new Map(F.days.flatMap((d) => d.symbols.map((s) => [`${d.date}|${s.symbol}`, tradeFeeTotal(s.fees)])));
  const shifted = positionRows.map((r) => (r.Date === '2026-10-27' ? { ...r, ...zero } : r));
  const before = buildDailySnapshots({ positionRows: shifted, adjustments, startingAccountValue: F.startingAccountValue });
  const after = buildDailySnapshots({ positionRows: shifted, adjustments, startingAccountValue: F.startingAccountValue, fillCostsByDateSymbol: fillCosts });
  const net = (snapRes, sym) => c2(snapRes.symbolRows.find((r) => r.tradeDate === '2026-10-27' && r.symbol === sym).net);
  assert.deepEqual([net(before, 'CDNA'), net(before, 'DOCS')], [0, 0]);          // the wrong figures
  assert.deepEqual([net(after, 'CDNA'), net(after, 'DOCS')], [-0.03, -0.08]);    // PropReports Net
  for (const d of F.days) for (const s of d.symbols) {
    assert.equal(after.symbolRows.find((r) => r.tradeDate === d.date && r.symbol === s.symbol).net, s.net, `${d.date} ${s.symbol}`);
  }
  for (const d of F.days) assert.equal(after.rows.find((r) => r.tradeDate === d.date).accountValue, d.endBalance, d.date);
  assert.deepEqual(after.feeSourceDiffs.map((x) => `${x.date} ${x.symbol}`), ['2026-10-27 CDNA', '2026-10-27 DOCS']);
});
