// Builds one row per trading day: the numbers behind the Calendar, Dashboard
// and Weekly Report (table daily_account_snapshots), plus one row per symbol
// per day (table daily_symbol_pnl) so a day can show every position that moved
// it — including positions held overnight that were neither opened nor closed.
//
// SOURCES (PropReports API v2)
//   positions   → per symbol per day: Realized, Unrealized Delta, and (when the
//                 firm exposes them) the trade-fee columns Comm / Ecn Fee / SEC / ...
//   adjustments → cash credits/debits that are not tied to one execution:
//                 recurring fees (Platform, Market Data, Multisport), any other
//                 fee-type adjustment, and transfers.
//
// DEFINITIONS — PropReports' own (Totals by Date / Summary by Date reports):
//   Gross        = Σ Realized                      (the API's "Realized" column is the Gross)
//   Net          = Gross − the trade fees of that symbol (Comm, ECN Fee, SEC, CLR, CAT, TAF, NSCC, NFA, ORF, MISC, ACC)
//   Total Δ      = Net + Unrealized Δ              (per symbol; summed = the "Equities" line)
//   Day Total Δ  = Equities Total Δ + Adj Fees     (Adj Fees = the "Fee: …" adjustment rows)
// In this app:
//   Pure trading (schema3Delta) = Equities Total Δ  (the "Fee: …" rows left out, nothing else)
//   Total        (schema1Delta) = Day Total Δ       (= PropReports Total Δ)
//   Account value               = previous account value + Total Δ + transfers
//
// Each symbol's trade fees come from ONE place: the FILLS of that symbol on that day (every fee column,
// dated by execution — exactly how Totals by Date books them) whenever the sync passes the fills.
// Only without fills: PropReports' Net on the positions row, else its fee columns. (The positions
// rows can carry an opening trade's fees on a different day — e.g. 27 Oct 2026, Gross 0 but
// Net (0.03) / (0.08) in Totals by Date — so they are not trusted when the fills are there.)
// Fee adjustments are never trade fees in PropReports — they are their own rows (Daily Interest,
// Misc, Market Data, Platform …) — so they are always added once. The earlier "dedupe" mode
// (max of the two per day) could drop a real charge and is gone.
//
// Fee adjustments are POSTED on a single day (the 1st, for this account) — they
// land in that day's Total Δ and account value; the Weekly Report adds the
// RECURRING ones back (spec section 26), which is the −$50.95 gap on 1 Sep 2026.

import { round } from './money.js';
import { toNumber, readColumn, hasTradeFeeColumns, tradeFeeTotal } from './csv.js';

const RECURRING = /market\s*data|platform|multi\s*sport|subscription|software|data\s*fee|monthly|desk\s*fee|seat/i;
const num = toNumber;

/** True for the monthly charges the weekly report leaves out of its Total Δ row. */
export const isRecurringFee = (categoryName) => RECURRING.test(String(categoryName ?? ''));

/** The trade fees carried by one `positions` row, or null when the row carries no fee information. */
function rowTradeFees(r) {
  const net = readColumn(r, ['Net']);
  if (net !== undefined) return num(r['Realized']) - num(net);
  return hasTradeFeeColumns(r) ? tradeFeeTotal(r) : null;
}

/**
 * @param {Object} o
 * @param {Record<string,string>[]} o.positionRows       parsed `positions` CSV rows
 * @param {Array<{date:string,amount:number,categoryName:string,categoryType:'fee'|'transfer'}>} o.adjustments
 * @param {Map<string,number>} [o.fillCostsByDate]          per-day Σ of the fee columns of the FILLS
 * @param {Map<string,number>} [o.fillCostsByDateSymbol]    same, keyed `${date}|${symbol}`
 * @param {number} o.startingAccountValue                 account value at the end of the day before the first row
 */
export function buildDailySnapshots({
  positionRows, adjustments, startingAccountValue, fillCostsByDate = null, fillCostsByDateSymbol = null,
}) {
  const warnings = [];
  /** @type {Map<string,any>} */
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, { realized: 0, unrealizedDelta: 0, columnCosts: 0, adjOther: 0, qty: 0, md: 0, platform: 0, recurringOther: 0, transfers: 0 });
    return days.get(d);
  };
  const symbols = new Map(); // `${date}|${symbol}` → per-symbol row

  const haveFeeColumns = positionRows.some((r) => rowTradeFees(r) !== null);
  let nonUsd = 0;
  for (const r of positionRows) {
    const d = r['Date'];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) continue;
    const x = day(d);
    const realized = num(r['Realized']);
    const uDelta = num(r['Unrealized Delta']);
    const cost = rowTradeFees(r) ?? 0;
    const qty = Math.abs(num(r['Qty Traded']));
    x.realized += realized; x.unrealizedDelta += uDelta; x.columnCosts += cost; x.qty += qty;
    if (r['Currency'] && r['Currency'] !== 'USD') nonUsd++;

    const sym = String(r['Symbol'] ?? '').trim().toUpperCase();
    if (sym) {
      const k = `${d}|${sym}`;
      const s = symbols.get(k) ?? { tradeDate: d, symbol: sym, realized: 0, unrealizedDelta: 0, tradeCosts: 0, quantityTraded: 0, endQuantity: null };
      s.realized += realized; s.unrealizedDelta += uDelta; s.tradeCosts += cost; s.quantityTraded += qty;
      const endQty = r['Position'] ?? r['End Qty'] ?? r['EOD Qty'];
      if (endQty !== undefined && endQty !== '') s.endQuantity = num(endQty);
      symbols.set(k, s);
    }
  }
  if (nonUsd) warnings.push({ type: 'non_usd_positions', message: `${nonUsd} position rows are not in USD; they were included unconverted.` });

  const feeSourceDiffs = []; // debug: where the positions row's fees disagree with the fills
  if (fillCostsByDateSymbol) {
    // Per day: a day with fills takes every stock's fees from its fills (a stock without fills that day
    // had no executions → 0); a day without any fill keeps the positions rows' fees.
    const fillDays = new Set([...fillCostsByDateSymbol.keys()].map((k) => k.split('|')[0]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
    for (const s of symbols.values()) if (fillDays.has(s.tradeDate)) { s.positionsFee = s.tradeCosts; s.tradeCosts = 0; }
    for (const d of fillDays) if (days.has(d)) days.get(d).columnCosts = 0;
    for (const [k, cost] of fillCostsByDateSymbol) {
      const [d, sym] = k.split('|');
      if (!fillDays.has(d)) continue;
      if (!symbols.has(k) && Math.abs(cost) < 0.00005) continue; // nothing to book
      if (!symbols.has(k)) symbols.set(k, { tradeDate: d, symbol: sym, realized: 0, unrealizedDelta: 0, tradeCosts: 0, quantityTraded: 0, endQuantity: null, positionsFee: null });
      symbols.get(k).tradeCosts = cost;
      day(d).columnCosts += cost;
    }
    for (const s of symbols.values()) {
      if (haveFeeColumns && s.positionsFee !== undefined && s.positionsFee !== null && Math.abs(s.positionsFee - s.tradeCosts) >= 0.005) {
        feeSourceDiffs.push({ date: s.tradeDate, symbol: s.symbol, positionsFee: round(s.positionsFee, 4), fillsFee: round(s.tradeCosts, 4) });
      }
      delete s.positionsFee;
    }
  }

  for (const a of adjustments) {
    const x = day(a.date);
    if (a.categoryType === 'transfer') { x.transfers += a.amount; continue; }
    const cost = -a.amount; // a debit (negative amount) is a cost
    if (/market\s*data/i.test(a.categoryName)) x.md += cost;
    else if (/platform/i.test(a.categoryName)) x.platform += cost;
    else if (isRecurringFee(a.categoryName)) x.recurringOther += cost;
    else x.adjOther += cost; // e.g. Fee: Daily Interest, Fee: Misc
  }

  let accountValue = startingAccountValue;
  const rows = [...days.keys()].sort().map((tradeDate) => {
    const x = days.get(tradeDate);
    const net = x.realized - x.columnCosts;
    const equitiesTotal = round(net + x.unrealizedDelta, 4);           // Pure trading
    const adjFees = x.md + x.platform + x.recurringOther + x.adjOther;  // the "Fee: …" rows
    const totalDelta = round(equitiesTotal - adjFees, 4);               // Total
    accountValue = round(accountValue + totalDelta + x.transfers, 4);
    return {
      tradeDate,
      schema3Delta: equitiesTotal,
      schema1Delta: totalDelta,
      commissions: round(x.columnCosts + x.adjOther, 4), // trade fees + non-monthly fee adjustments
      marketDataFees: round(x.md, 4),
      platformFees: round(x.platform, 4),
      otherFees: round(x.recurringOther, 4), // other RECURRING monthly fees (e.g. Multisport)
      transfers: round(x.transfers, 4),
      accountValue,
      realizedNet: round(net, 4),             // PropReports "Net" (trade fees only, no Fee: rows)
      quantityTraded: round(x.qty, 6),
    };
  });

  return {
    rows,
    symbolRows: [...symbols.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.symbol.localeCompare(b.symbol)).map((s) => ({
      ...s, realized: round(s.realized, 4), unrealizedDelta: round(s.unrealizedDelta, 4), tradeCosts: round(s.tradeCosts, 4),
      net: round(s.realized - s.tradeCosts, 4),
      totalDelta: round(s.realized - s.tradeCosts + s.unrealizedDelta, 4),
      dayResult: round(s.realized + s.unrealizedDelta, 4), quantityTraded: round(s.quantityTraded, 6),
    })),
    feeMode: 'separate',
    feeSourceDiffs,
    warnings,
  };
}

/** Everything that left the account on a day, as ONE number (trade fees + recurring fees). */
export const totalFees = (row) => round(row.commissions + row.marketDataFees + row.platformFees + row.otherFees, 4);

/**
 * The weekly report's "Total Δ" row deliberately leaves out the RECURRING monthly
 * fees (market data / platform / multisport), which post on the 1st (spec section 26).
 * Trade fees stay in — they are part of the day's result.
 */
export function reportDayDelta(row) {
  return round(row.schema1Delta + row.marketDataFees + row.platformFees + row.otherFees, 2);
}
