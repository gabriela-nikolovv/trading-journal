// Runs the REAL sync engine three times against an in-memory store and dumps
// the exact jsonb batch it would send to apply_sync_batch(), so the SQL test
// exercises genuine engine output rather than hand-written JSON.
import { writeFileSync, mkdirSync } from 'node:fs';
import { runSync } from '../../packages/engine/src/syncEngine.js';
import { createMemoryStore, fakeClient } from '../../packages/engine/test/helpers/memoryStore.js';

const F = (id, dt, side, qty, sym, px) => ({ id, dt, side, qty, sym, px });
const base = [
  F('P1', '2026-08-18 14:00:00.000', 'B', 100, 'AAPL', 200),
  F('P2', '2026-08-19 14:00:00.000', 'B', 50, 'AAPL', 202),
  F('P3', '2026-09-03 15:00:00.000', 'S', 50, 'AAPL', 210),
  F('P4', '2026-09-04 15:00:00.000', 'T', 10, 'XYZ', 20),
];
const adj = [{ date: '2026-09-01', cat: 'Fee: Platform', amount: -25.95, id: 'A1' }, { date: '2026-09-01', cat: 'Fee: Market Data', amount: -25, id: 'A2' }];
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const pos = (date, d) => ({ Date: date, Symbol: 'AAPL', Realized: '0', 'Unrealized Delta': String(d), Comm: '0', 'Ecn Fee': '0', SEC: '0', TAF: '0', NSCC: '0', Clr: '0', Misc: '0', 'Qty Traded': '0', Currency: 'USD' });
const positions = [pos('2026-09-03', 10), pos('2026-09-04', 5)];
const accounts = [{ 'Account Id': '348', 'First Traded': '2026-08-18', Cash: '-40.95', Unrealized: '0' }]; // 10 + 5 − 50.95 fees
const store = createMemoryStore();
const batches = [];
const orig = store.commit.bind(store);
store.commit = async (b) => { batches.push(JSON.parse(JSON.stringify(b))); return orig(b); };

await runSync({ client: fakeClient({ fills: base, adjustments: adj, positions, accounts }), store, today: '2026-09-10' });
// sync 2: AAPL grows by 20 (same position, Stop Loss must survive) AND P3 is replaced upstream
const s2 = [...base.map((f) => (f.id === 'P3' ? { ...f, id: 'P3-new' } : f)), F('P5', '2026-09-09 15:00:00.000', 'B', 20, 'AAPL', 205)];
await runSync({ client: fakeClient({ fills: s2, adjustments: adj, positions, accounts }), store, today: '2026-09-11' });
// sync 3: AAPL fully closed
const s3 = [...s2, F('P6', '2026-09-11 15:00:00.000', 'S', 120, 'AAPL', 220)];
await runSync({ client: fakeClient({ fills: s3, adjustments: adj, positions, accounts }), store, today: '2026-09-12' });

batches.forEach((b, i) => writeFileSync(new URL(`./out/batch${i + 1}.json`, import.meta.url), JSON.stringify(b)));
console.log('batches written:', batches.length);
