// Overall statistics for the Dashboard, grouped the way trading-journal "overall statistics" reports
// usually are (P&L · Scores & totals · Volume · Symbols · Trade duration · Fees), with the handful of
// numbers that matter most pulled out as a headline.
//
// Two inputs, never mixed inside one figure:
//   trades — completed round trips (position_instances that went flat); per-trade figures use
//            `basis` ('schema1' = net of the fees on the trade, 'schema3' = pure trading).
//   series — the daily P&L series in the selected schema (schemaSeries.dailySeries); used only for
//            the per-day / per-week / per-month averages and the best / worst day.
// PropReports' Trade Performance definitions are kept: BAT = winners ÷ (winners + losers),
// W/L = average winner ÷ |average loser|, hold = first execution → going flat.

import { round } from './money.js';
import { tradeResult } from './statistics.js';
import { formatHold } from './tradeStats.js';

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => (xs.length ? sum(xs) / xs.length : null);
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : round(v, 2));
const DAY_MS = 86400000;

/** Monday of the ISO week of a YYYY-MM-DD date. */
function weekKey(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}
function bucketAvg(series, keyFn) {
  const m = new Map();
  for (const p of series) m.set(keyFn(p.date), (m.get(keyFn(p.date)) ?? 0) + p.delta);
  return { avg: r2(avg([...m.values()])), count: m.size, best: m.size ? r2(Math.max(...m.values())) : null, worst: m.size ? r2(Math.min(...m.values())) : null };
}
function maxDrawdown(values) {
  let peak = 0, run = 0, dd = 0;
  for (const v of values) { run += v; peak = Math.max(peak, run); dd = Math.min(dd, run - peak); }
  return r2(dd);
}

/**
 * @param {Array<{symbol:string,direction:string,openedAt:Date,closedAt:Date,realizedPnl:number,feesAllocated:number,quantityTraded:number,avgEntryPrice:number}>} trades
 * @param {'schema1'|'schema3'} basis
 * @param {{date:string,delta:number}[]} [series]
 */
export function computeOverallStats(trades, basis, series = []) {
  const ts = [...trades].filter((t) => t.closedAt).sort((a, b) => a.closedAt - b.closedAt);
  const res = ts.map((t) => tradeResult(t, basis));
  const win = res.filter((x) => x > 0), loss = res.filter((x) => x < 0);
  const n = res.length;
  const grossProfit = sum(win), grossLoss = Math.abs(sum(loss));
  const avgWin = avg(win), avgLoss = avg(loss);

  let cw = 0, cl = 0, mw = 0, ml = 0;
  for (const x of res) { if (x > 0) { cw++; cl = 0; } else if (x < 0) { cl++; cw = 0; } else { cw = 0; cl = 0; } mw = Math.max(mw, cw); ml = Math.max(ml, cl); }

  const holds = ts.map((t) => t.closedAt - t.openedAt);
  const holdOf = (pred) => avg(ts.map((t, i) => [t, i]).filter(([, i]) => pred(res[i])).map(([t]) => t.closedAt - t.openedAt));
  const isIntraday = (t) => t.openedAt.toISOString().slice(0, 10) === t.closedAt.toISOString().slice(0, 10);
  const intraday = ts.map((t, i) => [t, res[i]]).filter(([t]) => isIntraday(t));
  const swing = ts.map((t, i) => [t, res[i]]).filter(([t]) => !isIntraday(t));

  const shares = ts.map((t) => t.quantityTraded / 2); // a round trip trades each share twice
  const sizeOf = (pred) => avg(ts.map((t, i) => [t, i]).filter(([, i]) => pred(res[i])).map(([t]) => t.quantityTraded / 2));
  const notional = ts.map((t) => (t.quantityTraded / 2) * t.avgEntryPrice);

  const bySymbol = new Map();
  ts.forEach((t, i) => { const x = bySymbol.get(t.symbol) ?? { key: t.symbol, trades: 0, wins: 0, total: 0, shares: 0 }; x.trades++; if (res[i] > 0) x.wins++; x.total += res[i]; x.shares += t.quantityTraded / 2; bySymbol.set(t.symbol, x); });
  const symbols = [...bySymbol.values()].map((x) => ({ ...x, total: r2(x.total), average: r2(x.total / x.trades), winRate: x.wins / x.trades }));
  const byTotal = [...symbols].sort((a, b) => b.total - a.total);

  const fees = ts.map((t) => t.feesAllocated);
  const days = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const greenDays = days.filter((d) => d.delta > 0), redDays = days.filter((d) => d.delta < 0);

  const headline = {
    netPnl: r2(sum(res)), trades: n,
    winRate: win.length + loss.length ? win.length / (win.length + loss.length) : null,
    profitFactor: grossLoss > 0 ? r2(grossProfit / grossLoss) : null,
    expectancy: n ? r2(sum(res) / n) : null,
    wlRatio: avgWin !== null && avgLoss ? r2(avgWin / Math.abs(avgLoss)) : null,
    avgHold: holds.length ? formatHold(avg(holds)) : null,
    maxDrawdown: maxDrawdown(res),
  };

  return {
    basis, headline,
    sections: [
      { id: 'pnl', title: 'P&L', groups: [
        { title: 'Totals', rows: [['Net P&L', r2(sum(res)), 'money'], ['Gross profit (winners)', r2(grossProfit), 'money'], ['Gross loss (losers)', r2(-grossLoss), 'money'], ['Largest winner', win.length ? r2(Math.max(...win)) : null, 'money'], ['Largest loser', loss.length ? r2(Math.min(...loss)) : null, 'money'], ['Max drawdown (trade by trade)', headline.maxDrawdown, 'money']] },
        { title: 'Averages by trade', rows: [['Average trade', headline.expectancy, 'money'], ['Average winner', r2(avgWin), 'money'], ['Average loser', r2(avgLoss), 'money']] },
        { title: 'Averages by period', rows: (() => { const d = bucketAvg(days, (x) => x), w = bucketAvg(days, weekKey), m = bucketAvg(days, (x) => x.slice(0, 7)); return [['Per trading day', d.avg, 'money'], ['Per week', w.avg, 'money'], ['Per month', m.avg, 'money'], ['Best week', w.best, 'money'], ['Worst week', w.worst, 'money'], ['Best month', m.best, 'money'], ['Worst month', m.worst, 'money']]; })() },
        { title: 'Winning vs losing days', rows: [['Green days', greenDays.length, 'int'], ['Red days', redDays.length, 'int'], ['Green %', greenDays.length + redDays.length ? greenDays.length / (greenDays.length + redDays.length) : null, 'pct'], ['Average green day', r2(avg(greenDays.map((d) => d.delta))), 'money'], ['Average red day', r2(avg(redDays.map((d) => d.delta))), 'money'], ['Best day', days.length ? r2(Math.max(...days.map((d) => d.delta))) : null, 'money'], ['Worst day', days.length ? r2(Math.min(...days.map((d) => d.delta))) : null, 'money']] },
      ] },
      { id: 'scores', title: 'Scores & totals', groups: [
        { title: 'Trades', rows: [['Completed trades', n, 'int'], ['Winners', win.length, 'int'], ['Losers', loss.length, 'int'], ['Break-even', n - win.length - loss.length, 'int'], ['Long trades', ts.filter((t) => t.direction === 'long').length, 'int'], ['Short trades', ts.filter((t) => t.direction === 'short').length, 'int']] },
        { title: 'Scores', rows: [['BAT (win %)', headline.winRate, 'pct'], ['Loss %', win.length + loss.length ? loss.length / (win.length + loss.length) : null, 'pct'], ['W/L ratio', headline.wlRatio, 'num'], ['Profit factor', headline.profitFactor, 'num'], ['Expectancy per trade', headline.expectancy, 'money']] },
        { title: 'Streaks', rows: [['Most wins in a row', mw, 'int'], ['Most losses in a row', ml, 'int']] },
      ] },
      { id: 'volume', title: 'Volume', groups: [
        { title: 'Shares', rows: [['Shares traded (bought + sold)', r2(sum(ts.map((t) => t.quantityTraded))), 'int'], ['Average position (shares)', r2(avg(shares)), 'int'], ['Average winner size', r2(sizeOf((x) => x > 0)), 'int'], ['Average loser size', r2(sizeOf((x) => x < 0)), 'int'], ['Largest position (shares)', shares.length ? Math.max(...shares) : null, 'int']] },
        { title: 'Value', rows: [['Average position value', r2(avg(notional)), 'money'], ['Largest position value', notional.length ? r2(Math.max(...notional)) : null, 'money']] },
      ] },
      { id: 'symbols', title: 'Symbols', groups: [
        { title: 'Overview', rows: [['Symbols traded', symbols.length, 'int'], ['Best symbol', byTotal[0] ? `${byTotal[0].key} (${byTotal[0].total})` : null, 'text'], ['Worst symbol', byTotal.at(-1) && byTotal.at(-1).total < 0 ? `${byTotal.at(-1).key} (${byTotal.at(-1).total})` : null, 'text'], ['Most traded', symbols.length ? [...symbols].sort((a, b) => b.trades - a.trades)[0].key : null, 'text']] },
      ] },
      { id: 'duration', title: 'Trade duration', groups: [
        { title: 'Average hold', rows: [['All trades', headline.avgHold, 'text'], ['Winners', holdOf((x) => x > 0) === null ? null : formatHold(holdOf((x) => x > 0)), 'text'], ['Losers', holdOf((x) => x < 0) === null ? null : formatHold(holdOf((x) => x < 0)), 'text'], ['Longest', holds.length ? formatHold(Math.max(...holds)) : null, 'text'], ['Shortest', holds.length ? formatHold(Math.min(...holds)) : null, 'text']] },
        { title: 'Intraday vs held overnight', rows: [['Intraday trades', intraday.length, 'int'], ['Intraday P&L', r2(sum(intraday.map(([, x]) => x))), 'money'], ['Overnight / swing trades', swing.length, 'int'], ['Overnight / swing P&L', r2(sum(swing.map(([, x]) => x))), 'money']] },
      ] },
      { id: 'fees', title: 'Fees', groups: [
        { title: 'Trade fees (on completed trades)', rows: [['Total', r2(sum(fees)), 'money'], ['Per trade', r2(avg(fees)), 'money'], ['Per 100 shares', sum(shares) ? r2((sum(fees) / sum(shares)) * 100) : null, 'money'], ['Share of gross profit', grossProfit ? sum(fees) / grossProfit : null, 'pct']] },
      ] },
    ],
    topSymbols: byTotal.slice(0, 10),
    worstSymbols: [...byTotal].reverse().filter((x) => x.total < 0).slice(0, 10),
  };
}
