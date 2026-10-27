// Trade-performance statistics (BAT, W/L, average hold) computed with the
// definitions PropReports publishes for its own "Trade Performance" report.
//
// WHY THIS EXISTS: API v2 (as documented) has actions for accounts, fills,
// groups, positions, adjustments, locates, profiles and uploads — none that
// returns the Trade Performance totals. But the report's definitions are
// public and unambiguous, so we compute them from our own reconstructed
// round-trip trades and keep the result checkable against the report:
//
//  * Completed ("round trip") trade: from the moment a position opens until
//    it goes flat. Counted on the day it goes flat.
//  * BAT  = percentage of winning trades.
//  * W/L  = average net gain of winning trades ÷ average net loss of losing trades.
//  * Avg Hold = total hold time ÷ number of completed trades, where a trade's
//    hold time is first transaction → last transaction.
//  * Wash trade = net result exactly $0.00.
//
// ASSUMPTION (not stated by PropReports): wash trades are left out of BAT's
// denominator. Verify against a real report containing a wash trade.
//
// "Net" = realized P&L minus the fees allocated to that trade.

import { round } from './money.js';

/** @param {number} ms */
export function formatHold(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${d}d ${p(h)}:${p(m)}:${p(s)}`;
}

/** Net result of one completed trade. */
export function netResult(instance) {
  return round(instance.realizedPnl - instance.feesAllocated, 6);
}

/**
 * @param {Array<{status:string, closedAt:Date|null, openedAt:Date, realizedPnl:number, feesAllocated:number}>} instances
 * @param {{fromDate?:string,toDate?:string}} [range]  inclusive YYYY-MM-DD, applied to the day the trade went flat
 */
export function computeTradeStats(instances, range = {}) {
  const completed = instances.filter((i) => {
    if (i.status !== 'closed' || !i.closedAt) return false;
    const day = i.closedAt.toISOString().slice(0, 10);
    if (range.fromDate && day < range.fromDate) return false;
    if (range.toDate && day > range.toDate) return false;
    return true;
  });

  const nets = completed.map(netResult);
  const winners = nets.filter((n) => n > 0);
  const losers = nets.filter((n) => n < 0);
  const washes = nets.length - winners.length - losers.length;

  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const avgWin = avg(winners);
  const avgLoss = avg(losers);
  const decided = winners.length + losers.length;

  const holdMs = completed.map((i) => i.closedAt.getTime() - i.openedAt.getTime());
  const avgHoldMs = avg(holdMs);

  return {
    completedTrades: completed.length,
    wins: winners.length,
    losses: losers.length,
    washes,
    bat: decided ? winners.length / decided : null,
    avgNetWinner: avgWin === null ? null : round(avgWin, 4),
    avgNetLoser: avgLoss === null ? null : round(avgLoss, 4),
    // null (not Infinity / 0) when there is no loser or no winner to divide by.
    wlRatio: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? round(avgWin / Math.abs(avgLoss), 2) : null,
    biggestNetWinner: winners.length ? round(Math.max(...winners), 4) : null,
    biggestNetLoser: losers.length ? round(Math.min(...losers), 4) : null,
    avgHoldMs,
    avgHoldLabel: avgHoldMs === null ? null : formatHold(avgHoldMs),
  };
}
