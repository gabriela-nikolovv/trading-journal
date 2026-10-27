import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/syncEngine.js';
import { PropReportsError } from '../src/propreportsClient.js';
import { createMemoryStore, fakeClient } from './helpers/memoryStore.js';

const F = (id, dt, side, qty, sym, px) => ({ id, dt, side, qty, sym, px });
const TODAY = '2026-09-10';

const baseFills = [
  F('P1', '2026-08-18 14:00:00.000', 'B', 100, 'AAPL', 200),
  F('P2', '2026-08-19 14:00:00.000', 'B', 50, 'AAPL', 202),
  F('P3', '2026-09-03 15:00:00.000', 'S', 50, 'AAPL', 210),
  F('P4', '2026-09-04 15:00:00.000', 'T', 10, 'XYZ', 20),
];

test('initial sync pulls full history, reconstructs open positions, reports counts', async () => {
  const store = createMemoryStore();
  const r = await runSync({ client: fakeClient({ fills: baseFills }), store, today: TODAY });
  assert.equal(r.ok, true);
  assert.equal(store.state.runs[0].isFullHistory, true);
  assert.equal(r.fillsNew, 4);
  assert.equal(r.openPositions, 2); // AAPL long 100 remaining, XYZ short 10
  const aapl = store.state.instances.find((p) => p.symbol === 'AAPL');
  assert.equal(aapl.openQuantity, 100);
  assert.equal(store.state.account.fillsCursorDate, TODAY);
});

test('re-running the same sync creates NO duplicates (PropReports Id match)', async () => {
  const store = createMemoryStore();
  const client = fakeClient({ fills: baseFills });
  await runSync({ client, store, today: TODAY });
  const r2 = await runSync({ client, store, today: '2026-09-11' });
  assert.equal(store.state.runs[1].isFullHistory, false); // incremental
  assert.equal(r2.fillsNew, 0);
  assert.equal(store.state.fills.filter((f) => !f.superseded).length, 4);
});

test('incremental sync adds only the new fill and updates positions (position closes)', async () => {
  const store = createMemoryStore();
  await runSync({ client: fakeClient({ fills: baseFills }), store, today: TODAY });
  const more = [...baseFills, F('P5', '2026-09-09 15:00:00.000', 'S', 100, 'AAPL', 215)];
  const r = await runSync({ client: fakeClient({ fills: more }), store, today: '2026-09-11' });
  assert.equal(r.fillsNew, 1);
  assert.equal(r.openPositions, 1);
  assert.equal(store.state.instances.find((p) => p.symbol === 'AAPL').status, 'closed');
});

test('replaced record: same trade, new PropReports Id → old superseded, new active, warning raised, no double count', async () => {
  const store = createMemoryStore();
  await runSync({ client: fakeClient({ fills: baseFills }), store, today: TODAY });
  const replaced = baseFills.map((f) => (f.id === 'P3' ? { ...f, id: 'P3-new' } : f));
  const r = await runSync({ client: fakeClient({ fills: replaced }), store, today: '2026-09-11' });
  assert.equal(r.fillsUpdated, 1);
  assert.equal(r.fillsNew, 0);
  assert.ok(r.warnings.some((w) => w.type === 'fill_replaced'));
  const active = store.state.fills.filter((f) => !f.superseded);
  assert.equal(active.length, 4);
  assert.ok(active.some((f) => f.propreportsId === 'P3-new'));
  assert.equal(store.state.instances.find((p) => p.symbol === 'AAPL').openQuantity, 100); // not 50 or 150
});

test('fill removed upstream inside the re-checked window is excluded and warned, never silently kept', async () => {
  const store = createMemoryStore();
  await runSync({ client: fakeClient({ fills: baseFills }), store, today: TODAY });
  const r = await runSync({ client: fakeClient({ fills: baseFills.filter((f) => f.id !== 'P4') }), store, today: '2026-09-11' });
  assert.ok(r.warnings.some((w) => w.type === 'fill_removed_upstream'));
  assert.equal(store.state.instances.find((p) => p.symbol === 'XYZ'), undefined);
});

test('identical fills with NO PropReports Id are both kept (fingerprint occurrence index), and still deduped on re-sync', async () => {
  const store = createMemoryStore();
  const twin = [F('', '2026-09-03 15:00:00.000', 'B', 10, 'ABC', 5), F('', '2026-09-03 15:00:00.000', 'B', 10, 'ABC', 5)];
  const client = fakeClient({ fills: twin });
  const r1 = await runSync({ client, store, today: TODAY });
  assert.equal(r1.fillsNew, 2);
  const r2 = await runSync({ client, store, today: '2026-09-11' });
  assert.equal(r2.fillsNew, 0);
});

test('failed sync (PropReports down) writes nothing, keeps last good data, marks status failed with a friendly message', async () => {
  const store = createMemoryStore();
  await runSync({ client: fakeClient({ fills: baseFills }), store, today: TODAY });
  const before = JSON.stringify(store.state.fills) + JSON.stringify(store.state.instances);
  const r = await runSync({
    client: fakeClient({ fail: new PropReportsError('PropReports is temporarily unavailable.', { kind: 'server', status: 503 }) }),
    store, today: '2026-09-11', token: 'tok',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Your previous data is still available/);
  assert.equal(store.state.status, 'failed');
  assert.equal(JSON.stringify(store.state.fills) + JSON.stringify(store.state.instances), before);
  assert.equal(store.state.account.fillsCursorDate, TODAY); // cursor not advanced
});

test('unexpected CSV shape fails loudly with a clear message instead of importing zeros', async () => {
  const store = createMemoryStore();
  const client = { fetchFills: async () => [{ Foo: '1', Bar: '2' }], fetchAdjustments: async () => [] };
  const r = await runSync({ client, store, today: TODAY });
  assert.equal(r.ok, false);
  assert.match(r.error, /format the journal does not recognise/);
  assert.equal(store.state.fills.length, 0);
});

test('Platform and Market Data adjustments are ingested as FEES; unknown categories are flagged, not trusted silently', async () => {
  const store = createMemoryStore();
  const adjustments = [
    { date: '2026-09-01', cat: 'Fee: Platform', amount: -25.95, id: 'A1' },
    { date: '2026-09-01', cat: 'Fee: Market Data', amount: -25, id: 'A2' },
    { date: '2026-09-02', cat: 'Mystery Charge', amount: -1, id: 'A3' },
  ];
  const r = await runSync({ client: fakeClient({ fills: baseFills, adjustments }), store, today: TODAY });
  const byCat = Object.fromEntries(store.state.adjustments.map((a) => [a.categoryName, a]));
  assert.equal(byCat['Fee: Platform'].categoryType, 'fee');
  assert.equal(byCat['Fee: Market Data'].categoryType, 'fee');
  const total = store.state.adjustments.filter((a) => a.categoryKnown).reduce((s, a) => s + a.amount, 0);
  assert.ok(Math.abs(total - -50.95) < 1e-9); // the real Sep 1 gap
  assert.ok(r.warnings.some((w) => w.type === 'unknown_adjustment_category' && /Mystery/.test(w.message)));
});

test('first sync on an empty database asks PropReports for "First Traded" so ALL history is fetched, not just the last month', async () => {
  const store = createMemoryStore({ firstTradedDate: null });
  const asked = [];
  const inner = fakeClient({ fills: baseFills });
  const client = {
    ...inner,
    listAccounts: async () => [{ 'Account Id': '348', 'First Traded': '2026-08-18' }],
    fetchFills: async (a, s, e) => { asked.push(s); return inner.fetchFills(a, s, e); },
  };
  const r = await runSync({ client, store, today: TODAY });
  assert.equal(asked[0], '2026-08-18');
  assert.equal(r.fillsNew, 4);
});

test('"Fee: Platform", "Fee: Market Data", "Fee: Multisport" and transfers are recognised with NO configuration and NO warning; a truly unknown category warns once', async () => {
  const store = createMemoryStore({ categories: new Map() }); // nothing configured at all
  const adjustments = [
    { date: '2026-09-01', cat: 'Fee: Platform', amount: -25.95, id: 'A1' },
    { date: '2026-09-01', cat: 'Fee: Market Data', amount: -25, id: 'A2' },
    { date: '2026-09-01', cat: 'Fee: Multisport', amount: -5, id: 'A3' },
    { date: '2026-09-02', cat: 'Wire Transfer', amount: 100, id: 'A4' },
    { date: '2026-09-03', cat: 'Mystery', amount: -1, id: 'A5' },
    { date: '2026-09-04', cat: 'Mystery', amount: -1, id: 'A6' },
  ];
  const r = await runSync({ client: fakeClient({ fills: [], adjustments }), store, today: TODAY });
  const types = Object.fromEntries(store.state.adjustments.map((a) => [a.id, a.categoryType]));
  assert.equal(r.warnings.filter((w) => w.type === 'unknown_adjustment_category').length, 1);
  assert.ok(store.state.adjustments.filter((a) => a.categoryName.startsWith('Fee:')).every((a) => a.categoryType === 'fee' && a.categoryKnown));
  assert.equal(store.state.adjustments.find((a) => a.categoryName === 'Wire Transfer').categoryType, 'transfer');
});
