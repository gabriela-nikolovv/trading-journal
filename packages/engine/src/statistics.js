// Trade statistics for the Dashboard / Trades / Symbol analytics (spec sections 36, 37).
//
// Everything here is computed from COMPLETED round-trip trades (position_instances that went
// flat) — never from individual fills, so "win rate" means share of trades, not of executions.
//
// BASIS: 'schema1' → each trade's result is net of the fees allocated to it;
//        'schema3' → pure trading result, before any cost.
// There is deliberately no 'schema2' basis: profit share is a once-a-month lump sum, so it has
// no meaning for a single trade.
//
// DEFINITIONS
//   win rate      = winners ÷ (winners + losers + break-even)
//   profit factor = gross profit of winners ÷ gross loss of losers (null if there are no losers)
//   expectancy    = average result per trade = total ÷ number of trades
//   avg R         = mean of (result ÷ initial risk) over trades whose stop was recorded and valid,
//                   initial risk = entry quantity × |avg entry − stop|, entry quantity = traded ÷ 2

import { round } from './money.js';
import { formatHold } from './tradeStats.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * @typedef {Object} ClosedTrade
 * @property {string} symbol
 * @property {'long'|'short'} direction
 * @property {Date} openedAt
 * @property {Date} closedAt
 * @property {number} realizedPnl
 * @property {number} feesAllocated
 * @property {number} quantityTraded
 * @property {number} avgEntryPrice
 * @property {number|null} [stopLoss]
 * @property {string|null} [sector]
 * @property {string|null} [industry]
 */

export function tradeResult(t, basis) {
  return basis === 'schema1' ? round(t.realizedPnl - t.feesAllocated, 6) : round(t.realizedPnl, 6);
}

/** Realized R for one trade, or null when no valid stop was recorded. */
export function tradeR(t, basis) {
  if (t.stopLoss === null || t.stopLoss === undefined) return null;
  const valid = t.direction === 'long' ? t.stopLoss < t.avgEntryPrice : t.stopLoss > t.avgEntryPrice;
  const entryQty = t.quantityTraded / 2;
  const risk = entryQty * Math.abs(t.avgEntryPrice - t.stopLoss);
  if (!valid || !(risk > 0)) return null;
  return round(tradeResult(t, basis) / risk, 3);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const total = (xs) => xs.reduce((a, b) => a + b, 0);

function group(trades, basis, keyFn) {
  const m = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(tradeResult(t, basis));
  }
  return [...m.entries()].map(([key, xs]) => ({
    key, trades: xs.length, wins: xs.filter((x) => x > 0).length, losses: xs.filter((x) => x < 0).length,
    winRate: xs.length ? xs.filter((x) => x > 0).length / xs.length : null,
    total: round(total(xs), 2), average: round(total(xs) / xs.length, 2), best: round(Math.max(...xs), 2), worst: round(Math.min(...xs), 2),
  }));
}

/**
 * @param {ClosedTrade[]} trades
 * @param {'schema1'|'schema3'} basis
 * @param {{fromDate?:string,toDate?:string}} [range]  applied to the day each trade closed (YYYY-MM-DD)
 */
export function computeStatistics(trades, basis, range = {}) {
  const inRange = trades.filter((t) => {
    const d = t.closedAt.toISOString().slice(0, 10);
    return (!range.fromDate || d >= range.fromDate) && (!range.toDate || d <= range.toDate);
  }).sort((a, b) => a.closedAt - b.closedAt);

  const res = inRange.map((t) => tradeResult(t, basis));
  const winners = res.filter((x) => x > 0);
  const losers = res.filter((x) => x < 0);
  const n = res.length;

  // consecutive streaks in closing order
  let curW = 0, curL = 0, maxW = 0, maxL = 0;
  for (const x of res) {
    if (x > 0) { curW++; curL = 0; } else if (x < 0) { curL++; curW = 0; } else { curW = 0; curL = 0; }
    maxW = Math.max(maxW, curW); maxL = Math.max(maxL, curL);
  }

  const rs = inRange.map((t) => tradeR(t, basis)).filter((r) => r !== null);
  const holdMs = inRange.map((t) => t.closedAt - t.openedAt);
  const grossProfit = total(winners);
  const grossLoss = Math.abs(total(losers));

  return {
    basis,
    trades: n,
    wins: winners.length,
    losses: losers.length,
    breakEven: n - winners.length - losers.length,
    winRate: n ? winners.length / n : null,
    lossRate: n ? losers.length / n : null,
    total: round(total(res), 2),
    avgWinner: winners.length ? round(mean(winners), 2) : null,
    avgLoser: losers.length ? round(mean(losers), 2) : null,
    largestWinner: winners.length ? round(Math.max(...winners), 2) : null,
    largestLoser: losers.length ? round(Math.min(...losers), 2) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : null,
    expectancy: n ? round(total(res) / n, 2) : null,
    avgR: rs.length ? round(mean(rs), 2) : null,
    tradesWithR: rs.length,
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
    avgHoldLabel: n ? formatHold(mean(holdMs)) : null,
    byDayOfWeek: group(inRange, basis, (t) => DOW[t.closedAt.getUTCDay()]).sort((a, b) => DOW.indexOf(a.key) - DOW.indexOf(b.key)),
    byMonth: group(inRange, basis, (t) => t.closedAt.toISOString().slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    bySymbol: group(inRange, basis, (t) => t.symbol).sort((a, b) => b.total - a.total),
    bySector: group(inRange, basis, (t) => t.sector ?? 'Unclassified').sort((a, b) => b.total - a.total),
    byIndustry: group(inRange, basis, (t) => t.industry ?? 'Unclassified').sort((a, b) => b.total - a.total),
    longVsShort: group(inRange, basis, (t) => t.direction),
  };
}
