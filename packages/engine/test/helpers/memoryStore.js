// In-memory Store + fake PropReports client used by the sync tests.
// commit() is all-or-nothing, mirroring the single Postgres transaction.
let seq = 0;
export function createMemoryStore({ firstTradedDate = '2026-08-01', categories = new Map([['Fee: Platform', 'fee'], ['Fee: Market Data', 'fee'], ['Transfer', 'transfer']]) } = {}) {
  const s = {
    account: { id: 'acct-1', propreportsAccountId: 348, firstTradedDate, fillsCursorDate: null, adjustmentsCursorDate: null },
    fills: [], adjustments: [], instances: [], runs: [], status: 'idle', lastError: null, lastWarnings: [], commits: 0,
  };
  const inRange = (r, from, to) => r.date >= from && r.date <= to && !r.superseded;
  return {
    state: s,
    async getAccount() { return { ...s.account }; },
    async beginRun(info) { s.status = 'running'; const id = globalThis.crypto.randomUUID(); s.runs.push({ id, ...info }); return id; },
    async getActiveFills(from, to) { return s.fills.filter((f) => inRange({ date: f.tradeDate, superseded: f.superseded }, from, to)); },
    async getActiveAdjustments(from, to) { return s.adjustments.filter((a) => inRange({ date: a.date, superseded: a.superseded }, from, to)); },
    async getAdjustmentCategories() { return categories; },
    async getAccountValueBefore(date) { const prior = (s.snapshots ?? []).filter((r) => r.tradeDate < date).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)); return prior.length ? prior.at(-1).accountValue : 0; },
    async getAllActiveFills() { return s.fills.filter((f) => !f.superseded); },
    async commit(b) {
      const snapshot = JSON.stringify([s.fills, s.adjustments]);
      try {
        for (const r of b.fills.removed) s.fills.find((f) => f.id === r.id).superseded = true;
        for (const r of b.fills.replacements) s.fills.find((f) => f.id === r.supersedeId).superseded = true;
        for (const x of [...b.fills.inserts, ...b.fills.replacements]) {
          s.fills.push({ ...x.record, id: x.id, fingerprint: x.fingerprint, superseded: false,
            datetime: new Date(x.record.datetimeIso.replace(' ', 'T') + 'Z') });
        }
        for (const r of b.adjustments.removed) s.adjustments.find((f) => f.id === r.id).superseded = true;
        for (const r of b.adjustments.replacements) s.adjustments.find((f) => f.id === r.supersedeId).superseded = true;
        for (const x of [...b.adjustments.inserts, ...b.adjustments.replacements]) {
          s.adjustments.push({ ...x.record, id: `adj-${++seq}`, fingerprint: x.fingerprint, superseded: false });
        }
        s.instances = b.instances;
        const kept = (s.snapshots ?? []).filter((r) => !b.snapshots.some((n) => n.tradeDate === r.tradeDate));
        s.snapshots = [...kept, ...b.snapshots].sort((a, b2) => a.tradeDate.localeCompare(b2.tradeDate));
        const keptSym = (s.symbolDays ?? []).filter((r) => !(b.symbolDays ?? []).some((n) => n.tradeDate === r.tradeDate));
        s.symbolDays = [...keptSym, ...(b.symbolDays ?? [])];
        s.accountInfo = b.accountInfo;
        s.account.fillsCursorDate = b.cursorDate;
        s.account.adjustmentsCursorDate = b.cursorDate;
        s.status = 'idle'; s.lastError = null; s.lastWarnings = b.warnings; s.commits++;
      } catch (e) {
        const [f, a] = JSON.parse(snapshot); s.fills = f; s.adjustments = a; throw e;
      }
    },
    async failRun(_id, error) { s.status = 'failed'; s.lastError = error.message; },
  };
}

export const FILL_HEADER = 'Date/Time,Account,B/S,Qty,Symbol,Price,Route,Comm,Ecn Fee,SEC,TAF,NSCC,Clr,Misc,Trade Date,Order Id,Status,PropReports Id,Fill Id,Currency,Multiplier';
export function fillCsv(rows) {
  return [FILL_HEADER, ...rows.map((r) => `${r.dt},ACC,${r.side},${r.qty},${r.sym},${r.px},NSDQ,${r.fee ?? 0},0,0,0,0,0,0,${r.dt.slice(0, 10)},O1,,${r.id ?? ''},F${r.id ?? ''},USD,1`)].join('\n') + '\nPage 1/1';
}
export const ADJ_HEADER = 'Date,Category,Amount,Description,PropReports Id';

/** Fake client returning canned CSV-parsed rows; `fillsByWindow` may be a function for scenarios. */
export function fakeClient({ fills = [], adjustments = [], positions = [], accounts = null, fail = null } = {}) {
  const { parseCsv } = awaitableParse;
  return {
    async fetchFills(_a, start, end) {
      if (fail) throw fail;
      return parseCsv(fillCsv(fills.filter((f) => f.dt.slice(0, 10) >= start && f.dt.slice(0, 10) <= end)).replace(/\nPage 1\/1$/, ''));
    },
    async fetchPositions(_a, start, end) { return positions.filter((p) => p.Date >= start && p.Date <= end); },
    ...(accounts ? { listAccounts: async () => accounts } : {}),
    async fetchAdjustments(_a, start, end) {
      return parseCsv([ADJ_HEADER, ...adjustments.filter((a) => a.date >= start && a.date <= end).map((a) => `${a.date},${a.cat},${a.amount},,${a.id ?? ''}`)].join('\n'));
    },
  };
}
import { parseCsv } from '../../src/csv.js';
const awaitableParse = { parseCsv };
