import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailySnapshots, reportDayDelta } from '../src/dailySnapshots.js';
import { runSync } from '../src/syncEngine.js';
import { createMemoryStore, fakeClient } from './helpers/memoryStore.js';

// The REAL week from the user's report. Per-day trading result chosen so that
// Total Δ (before the monthly fees) matches the report exactly:  -4.38 -4.21 -0.09 3.82 46.42
const week = [
  ['2026-08-31', -4.38], ['2026-09-01', -4.21], ['2026-09-02', -0.09], ['2026-09-03', 3.82], ['2026-09-04', 46.42],
];
const pos = (date, delta) => ({ Date: date, Symbol: 'ABC', Realized: '0', 'Unrealized Delta': String(delta), Comm: '0', 'Ecn Fee': '0', SEC: '0', TAF: '0', NSCC: '0', Clr: '0', Misc: '0', 'Qty Traded': '0', Currency: 'USD' });
const adj = (date, cat, amount, type = 'fee') => ({ date, categoryName: cat, amount, categoryType: type });

test('reproduces the real week: daily Total Δ row, and the account-value row INCLUDING the −50.95 first-of-month fee gap', () => {
  const { rows } = buildDailySnapshots({
    positionRows: week.map(([d, v]) => pos(d, v)),
    adjustments: [adj('2026-09-01', 'Fee: Platform', -25.95), adj('2026-09-01', 'Fee: Market Data', -25)],
    startingAccountValue: -637.07, // so Monday closes at the report's -641.45
  });
  assert.deepEqual(rows.map((r) => r.accountValue), [-641.45, -696.61, -696.7, -692.88, -646.46]);
  // Report "Total Δ" row leaves the month-start fees out; Schema 1 / account value keep them.
  assert.deepEqual(rows.map(reportDayDelta), [-4.38, -4.21, -0.09, 3.82, 46.42]);
  assert.equal(rows[1].schema1Delta, -55.16);
  assert.equal(rows[1].platformFees, 25.95);
  assert.equal(rows[1].marketDataFees, 25);
});

test('Schema 3 excludes every cost; Schema 1 includes trade costs and all fee adjustments (spec test 1000 / 800)', () => {
  const { rows } = buildDailySnapshots({
    positionRows: [{ ...pos('2026-09-01', 0), Realized: '1000', Comm: '100' }],
    adjustments: [adj('2026-09-01', 'Fee: Market Data', -50), adj('2026-09-01', 'Fee: Platform', -50)],
    startingAccountValue: 0,
  });
  assert.equal(rows[0].schema3Delta, 1000);
  assert.equal(rows[0].schema1Delta, 800); // 1000 − 100 − 50 − 50
  assert.equal(rows[0].realizedNet, 900);
});

test('transfers move account value but are NOT P&L in either schema', () => {
  const { rows } = buildDailySnapshots({ positionRows: [pos('2026-09-01', 10)], adjustments: [adj('2026-09-01', 'Transfer', 500, 'transfer')], startingAccountValue: 0 });
  assert.equal(rows[0].schema1Delta, 10);
  assert.equal(rows[0].accountValue, 510);
});

test('a fee posted on a day with no trading still gets its own day row', () => {
  const { rows } = buildDailySnapshots({ positionRows: [], adjustments: [adj('2026-10-01', 'Fee: Multisport', -9)], startingAccountValue: 100 });
  assert.deepEqual([rows.length, rows[0].otherFees, rows[0].accountValue], [1, 9, 91]);
});

test('non-USD rows are flagged, never silently converted', () => {
  const { warnings } = buildDailySnapshots({ positionRows: [{ ...pos('2026-09-01', 1), Currency: 'EUR' }], adjustments: [], startingAccountValue: 0 });
  assert.equal(warnings[0].type, 'non_usd_positions');
});

test('sync engine stores snapshots, chains account value across syncs, and warns when it disagrees with PropReports Cash+Unrealized', async () => {
  const store = createMemoryStore();
  const positions = [pos('2026-09-03', 10), pos('2026-09-04', 5)];
  const ok = { 'Account Id': '348', 'First Traded': '2026-08-18', Cash: '12', Unrealized: '3' };
  const r1 = await runSync({ client: fakeClient({ positions, accounts: [ok] }), store, today: '2026-09-10' });
  assert.equal(r1.snapshotDays, 2);
  assert.equal(store.state.snapshots.at(-1).accountValue, 15);
  assert.ok(!r1.warnings.some((w) => w.type === 'account_value_mismatch'));
  // later day arrives: value chains from the stored previous day
  const r2 = await runSync({ client: fakeClient({ positions: [...positions, pos('2026-09-09', 1)], accounts: [{ ...ok, Cash: '13', Unrealized: '3' }] }), store, today: '2026-09-11' });
  assert.equal(store.state.snapshots.at(-1).accountValue, 16);
  assert.ok(!r2.warnings.some((w) => w.type === 'account_value_mismatch'));
  // PropReports says something different → loud warning, not silent
  const r3 = await runSync({ client: fakeClient({ positions, accounts: [{ ...ok, Cash: '999' }] }), store, today: '2026-09-12' });
  assert.ok(r3.warnings.some((w) => w.type === 'account_value_mismatch'));
});
