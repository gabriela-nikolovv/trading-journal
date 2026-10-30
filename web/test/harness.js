// Boots the REAL website code (app.js + views + engine) inside jsdom against a fake API.
import { JSDOM } from 'jsdom';
import { renderWeeklyReportPdf } from '../../packages/engine/src/weeklyReportPdf.js';
import { buildDailySnapshots } from '../../packages/engine/src/dailySnapshots.js';
import { TRADINGVIEW_TAXONOMY } from '../../packages/engine/src/taxonomy.js';

export function installDom() {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url: 'https://example.github.io/trading-journal/', pretendToBeVisual: true });
  const w = dom.window;
  for (const k of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Node', 'Event']) Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  globalThis.window = w;
  w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
  globalThis.URL.createObjectURL = () => 'blob:test'; globalThis.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { w.__downloaded = this.getAttribute('download'); };
  w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}

const posRow = (date, d) => ({ Date: date, Symbol: 'ABC', Realized: '0', 'Unrealized Delta': String(d), Comm: '0', 'Ecn Fee': '0', SEC: '0', TAF: '0', NSCC: '0', Clr: '0', Misc: '0', 'Qty Traded': '0', Currency: 'USD' });
export const REAL_WEEK = buildDailySnapshots({
  positionRows: [['2026-08-31', -4.38], ['2026-09-01', -4.21], ['2026-09-02', -0.09], ['2026-09-03', 3.82], ['2026-09-04', 46.42]].map(([d, v]) => posRow(d, v)),
  adjustments: [{ date: '2026-09-01', categoryName: 'Fee: Platform', amount: -25.95, categoryType: 'fee' }, { date: '2026-09-01', categoryName: 'Fee: Market Data', amount: -25, categoryType: 'fee' }],
  startingAccountValue: -637.07,
}).rows.map((r) => ({ ...r, date: r.tradeDate }));

const sectors = Object.keys(TRADINGVIEW_TAXONOMY).map((name, i) => ({ id: `s${i}`, name }));
const industries = Object.entries(TRADINGVIEW_TAXONOMY).flatMap(([sector, v], i) => [...v.confirmed, ...v.recalled].map((name, j) => ({ id: `i${i}-${j}`, name, sector_id: `s${i}` })));

export function makeFakeApi(over = {}) {
  const calls = { updatePosition: [], updateLot: [], saveLots: [], saveComment: [], saveWeekly: [], saveProfit: [], runSync: 0, getPositions: 0 };
  const T = (o) => ({ id: o.id, symbol: o.symbol, direction: o.direction ?? 'long', status: 'closed', openQuantity: 0, quantityTraded: 40, avgEntryPrice: 5, avgExitPrice: 5.5, realizedPnl: o.pnl, feesAllocated: 0.1, openedAt: new Date(o.open), closedAt: new Date(o.close), stopLoss: null, notes: null, sector: 'Health Technology', industry: 'Biotechnology', sectorId: 's11', industryId: 'i11-2', multiplier: 1 });
  const closed = [T({ id: 't1', symbol: 'WIN', pnl: 23.18, open: '2026-08-18T14:00:00Z', close: '2026-09-04T19:00:00Z' }), T({ id: 't2', symbol: 'LOSS', pnl: -0.0416, open: '2026-09-03T14:00:00Z', close: '2026-09-03T14:05:00Z' })];
  const api = {
    calls,
    getSession: async () => ({ user: { id: 'u1' } }), signIn: async () => {}, signOut: async () => {}, onAuthChange: () => {},
    getAccount: async () => ({ id: 'a1', propreports_account_id: 348, propreports_account_name: 'FPTI000645A404', account_code: 'FPTI000645A404 Gabriela Nikolova', prop_firm: 'Alaric', platform: 'Hammer Pro' }),
    getSyncStatus: async () => ({ state: { status: 'idle', last_success_at: '2026-09-04T20:00:00Z', account_cash: -646.46, account_unrealized: 0 }, lastRun: { status: 'success', fills_new: 3, fills_updated: 0, fills_fetched: 3, adjustments_fetched: 2, adjustments_new: 2, positions_detected: 2, warnings: [{ type: 'x', message: 'Test warning' }] } }),
    setupAccount: async () => ({ propAccountId: 'a1' }),
    runSync: async () => { calls.runSync++; return { ok: true, fillsNew: 1, fillsUpdated: 0, openPositions: 2 }; },
    getSnapshots: async () => REAL_WEEK, getClosedTrades: async () => closed,
    getTradesPage: async (q) => { calls.lastTradeQuery = q; return { rows: closed.filter((t) => !q.filters.symbol || t.symbol.includes(q.filters.symbol.toUpperCase())), total: closed.length }; },
    getPositionsOnDay: async (d) => [...closed.filter((t) => t.openedAt.toISOString().slice(0, 10) <= d && t.closedAt.toISOString().slice(0, 10) >= d),
      { id: 'o1', symbol: 'HOLD', direction: 'long', status: 'open', openedAt: new Date('2026-08-20T14:00:00Z'), closedAt: null, realizedPnl: 0, quantityTraded: 100, openQuantity: 100 }],
    getSymbolDays: async (from) => (from === '2026-09-04' ? [{ date: from, symbol: 'HOLD', realized: 0, unrealizedDelta: 12.5, tradeCosts: 0, quantityTraded: 0 }, { date: from, symbol: 'WIN', realized: 23.18, unrealizedDelta: -2, tradeCosts: 0.1, quantityTraded: 20 }] : []),
    getTradeFills: async () => [{ datetime: '2026-09-04T19:00:00', side: 'S', quantity: 20, price: '5.5' }],
    countOpenPositions: async () => 3,
    getPositions: async () => { calls.getPositions++; return {
      ok: true, symbolsAwaitingClassification: [],
      positions: [
        { id: 'p1', symbol: 'AAA', direction: 'long', quantity: 100, avgEntry: 10, price: 11, priceStatus: 'ok', priceSource: 'yahoo', priceAsOf: '2026-09-04T20:00:00Z', priceSession: 'closed', marketValue: 1100, exposure: 1100, unrealizedPnl: 100, pnlPct: 10, stopLoss: 9, originalStop: 9, currentStop: 9, riskStatus: 'ok', riskToStop: 100, currentR: { status: 'ok', value: 1 }, sector: 'Health Technology', industry: 'Biotechnology', sectorId: 's11', industryId: null, classificationSource: 'tradingview', notes: null, openedAt: new Date(Date.now() - 5 * 86400000).toISOString(), lots: [],
          entries: [{ key: '2026-10-01T14:00:00.000Z|60|10', datetime: '2026-10-01T14:00:00.000Z', date: '2026-10-01', quantity: 60, remaining: 60, price: 10 }, { key: '2026-10-08T14:00:00.000Z|40|10', datetime: '2026-10-08T14:00:00.000Z', date: '2026-10-08', quantity: 40, remaining: 40, price: 10 }] },
        { id: 'p2', symbol: 'BBB', direction: 'short', quantity: 50, avgEntry: 20, price: null, priceStatus: 'unavailable', priceReason: 'Unable to retrieve current price for BBB.', stopLoss: null, originalStop: null, currentStop: null, riskStatus: 'not_set', riskToStop: null, currentR: { status: 'not_set' }, marketValue: null, unrealizedPnl: null, pnlPct: null, sector: null, industry: null, classificationSource: null, notes: null, openedAt: '2026-10-29T14:00:00Z', lots: [], entries: [{ key: '2026-10-29T14:00:00.000Z|50|20', datetime: '2026-10-29T14:00:00.000Z', date: '2026-10-29', quantity: 50, remaining: 50, price: 20 }] },
        { id: 'p3', symbol: 'CCC', direction: 'long', quantity: 10, avgEntry: 10, price: 12, priceStatus: 'ok', priceSource: 'yahoo', priceAsOf: '2026-09-04T20:00:00Z', priceSession: 'closed', marketValue: 120, exposure: 120, unrealizedPnl: 20, pnlPct: 20, stopLoss: 11, originalStop: 11, currentStop: 11.5, derisked: true, riskStatus: 'invalid', riskReason: 'Stop Loss must be below Entry for a LONG position.', riskToStop: -15, currentR: { status: 'invalid' }, sector: null, industry: null, classificationSource: null, notes: null, openedAt: '2026-10-20T14:00:00Z', lots: [], entries: [{ key: '2026-10-20T14:00:00.000Z|10|10', datetime: '2026-10-20T14:00:00.000Z', date: '2026-10-20', quantity: 10, remaining: 10, price: 10 }] },
        { id: 'p4', symbol: 'DDD', direction: 'long', quantity: 150, avgEntry: 10.67, price: 12, priceStatus: 'ok', priceSource: 'yahoo', priceAsOf: '2026-09-04T20:00:00Z', priceSession: 'closed', marketValue: 1800, exposure: 1800, unrealizedPnl: 200, riskStatus: 'ok', riskToStop: 0, currentR: { status: 'ok', value: 1 }, sector: null, industry: null, classificationSource: null, notes: null, openedAt: '2026-10-01T14:00:00Z',
          entries: [{ key: '2026-10-01T14:00:00.000Z|100|10', datetime: '2026-10-01T14:00:00.000Z', date: '2026-10-01', quantity: 100, remaining: 100, price: 10 }, { key: '2026-10-08T14:00:00.000Z|50|12', datetime: '2026-10-08T14:00:00.000Z', date: '2026-10-08', quantity: 50, remaining: 50, price: 12 }],
          lots: [
            { lotId: 'L1', label: 'Lot 1', quantity: 100, avgEntry: 10, unrealizedPnl: 200, originalStop: 9, currentStop: 10.5, derisked: true, riskStatus: 'ok', riskToStop: -50, currentR: { status: 'ok', value: 2 }, openedAt: '2026-10-01T14:00:00.000Z', entryKeys: ['2026-10-01T14:00:00.000Z|100|10'] },
            { lotId: 'L2', label: 'Lot 2', quantity: 50, avgEntry: 12, unrealizedPnl: 0, originalStop: 11, currentStop: 11, riskStatus: 'ok', riskToStop: 50, currentR: { status: 'ok', value: 0 }, openedAt: '2026-10-08T14:00:00.000Z', entryKeys: ['2026-10-08T14:00:00.000Z|50|12'] }] },
      ],
      summary: { totalExposure: 1220, longExposure: 1220, shortExposure: 0, netExposure: 1220, bySymbol: [{ name: 'AAA', exposure: 1100, pct: 90.2 }], bySector: [{ name: 'Health Technology', exposure: 1100, pct: 90.2 }], byIndustry: [], unpricedPositions: 1, positionsMissingStop: ['BBB'], positionsWithInvalidStop: ['CCC'], totalRiskToStops: 150, lockedByStops: 65, riskPctOfAccount: null },
    }; },
    classify: async () => ({ classifications: { AAPL: { status: 'ok', sector: 'Electronic Technology', industry: 'Telecommunications Equipment' } } }),
    getQuotes: async () => ({ quotes: { AAPL: { ok: true, price: 210, session: 'closed', asOf: '2026-09-04T20:00:00Z' } } }),
    updatePosition: async (id, patch) => { calls.updatePosition.push([id, patch]); },
    updateLot: async (id, patch) => { calls.updateLot.push([id, patch]); },
    saveLots: async (id, userId, lots) => { calls.saveLots.push([id, lots]); },
    getSectors: async () => sectors, getIndustries: async () => industries,
    getDailyComments: async () => [{ date: '2026-09-04', comment: 'Waited for the right entry.' }],
    saveDailyComment: async (...a) => { calls.saveComment.push(a); },
    getProfitShareSchedule: async () => [{ pct: 50, effectiveFrom: '2000-01-01' }],
    saveProfitShare: async (...a) => { calls.saveProfit.push(a); },
    getWeeklyReport: async () => null, saveWeeklyReport: async (r) => { calls.saveWeekly.push(r); },
    getSettings: async () => null, saveSettings: async () => {},
    ...over,
  };
  return api;
}

export function makePdf() {
  const calls = [];
  return { calls, render: async (report) => { calls.push(report); return renderWeeklyReportPdf(report); } };
}
export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
export const waitFor = async (fn, ms = 2500) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timed out'); await tick(15); } };
