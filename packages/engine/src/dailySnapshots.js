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
// DEFINITIONS — PropReports' own (Summary by Date report):
//   Gross        = Σ Realized
//   Net          = Gross − all direct trade fees
//   Total Δ      = Net + Adj Fees + Unrealized Δ
// In this app:
//   Trading result (Schema 3) = Gross + Unrealized Δ             (before every cost)
//   Fees                      = ONE figure: every cost the day carried, counted once
//   Total Δ (Schema 1)        = Trading result − Fees            (= PropReports Total Δ)
//   Account value             = previous account value + Total Δ + transfers
//
// THE DOUBLE-COUNT FIX
// Some firms post the day's trade fees (commission, ECN, clearing …) as fee
// adjustments while the executions/positions ALSO carry them in their fee
// columns. Adding both counts the same money twice — which is what the
// Calendar showed as "Trade costs" + "Fee adjustments". So fees are now built as:
//   recurring fees      = adjustments named Market Data / Platform / Multisport /
//                         Subscription … (the monthly charges posted on the 1st)
//   trade fees          = the day's direct trade fees, taken from whichever
//                         source has them, never from both:
//     mode 'dedupe'   → max(fee columns, non-recurring fee adjustments) per day
//     mode 'separate' → fee columns + non-recurring fee adjustments
// mode 'auto' (default) decides with PropReports' own balance: it rebuilds the
// account value both ways and keeps the one that lands on the Cash + Unrealized
// PropReports reports. With no reported balance to check against it uses
// 'dedupe', because adding a duplicated fee is the error that was observed.
//
// Fee adjustments are POSTED on a single day (the 1st, for this account) — they
// land in that day's Total Δ and account value; the Weekly Report adds the
// RECURRING ones back (spec section 26), which is the −$50.95 gap on 1 Sep 2026.

import { round } from './money.js';

const FEE_COLUMNS = ['Comm', 'Ecn Fee', 'SEC', 'TAF', 'NSCC', 'Clr', 'Misc', 'ORF', 'CAT', 'FTT', 'Acc', 'NFA', 'Access'];
const RECURRING = /market\s*data|platform|multi\s*sport|subscription|software|data\s*fee|monthly|desk\s*fee|seat/i;
const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};

/** True for the monthly charges the weekly report leaves out of its Total Δ row. */
export const isRecurringFee = (categoryName) => RECURRING.test(String(categoryName ?? ''));

/**
 * @param {Object} o
 * @param {Record<string,string>[]} o.positionRows       parsed `positions` CSV rows
 * @param {Array<{date:string,amount:number,categoryName:string,categoryType:'fee'|'transfer'}>} o.adjustments
 * @param {Map<string,number>} [o.fillCostsByDate]          per-day Σ of the fee columns of the FILLS
 * @param {Map<string,number>} [o.fillCostsByDateSymbol]    same, keyed `${date}|${symbol}`
 * @param {number} o.startingAccountValue                 account value at the end of the day before the first row
 * @param {number|null} [o.reportedAccountValue]          PropReports Cash + Unrealized now (accounts action)
 * @param {'auto'|'dedupe'|'separate'} [o.feeMode]
 */
export function buildDailySnapshots({
  positionRows, adjustments, startingAccountValue, fillCostsByDate = null, fillCostsByDateSymbol = null,
  reportedAccountValue = null, feeMode = 'auto',
}) {
  const warnings = [];
  /** @type {Map<string,any>} */
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, { realized: 0, unrealizedDelta: 0, columnCosts: 0, adjTradeFees: 0, qty: 0, md: 0, platform: 0, recurringOther: 0, transfers: 0 });
    return days.get(d);
  };
  const symbols = new Map(); // `${date}|${symbol}` → per-symbol row

  const haveFeeColumns = positionRows.length > 0 && FEE_COLUMNS.some((c) => c in positionRows[0]);
  let nonUsd = 0;
  for (const r of positionRows) {
    const d = r['Date'];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) continue;
    const x = day(d);
    const realized = num(r['Realized']);
    const uDelta = num(r['Unrealized Delta']);
    const cost = FEE_COLUMNS.reduce((s, c) => s + num(r[c]), 0);
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

  if (!haveFeeColumns && positionRows.length > 0 && fillCostsByDate) {
    // Positions without fee columns: the fills carry the day's direct trade fees.
    for (const [d, cost] of fillCostsByDate) if (days.has(d)) days.get(d).columnCosts = cost;
    if (fillCostsByDateSymbol) for (const [k, cost] of fillCostsByDateSymbol) if (symbols.has(k)) symbols.get(k).tradeCosts = cost;
  }

  for (const a of adjustments) {
    const x = day(a.date);
    if (a.categoryType === 'transfer') { x.transfers += a.amount; continue; }
    const cost = -a.amount; // a debit (negative amount) is a cost
    if (/market\s*data/i.test(a.categoryName)) x.md += cost;
    else if (/platform/i.test(a.categoryName)) x.platform += cost;
    else if (isRecurringFee(a.categoryName)) x.recurringOther += cost;
    else x.adjTradeFees += cost;
  }

  const tradeFees = (x, mode) => (mode === 'separate' ? x.columnCosts + x.adjTradeFees : Math.max(x.columnCosts, x.adjTradeFees));
  const build = (mode) => {
    let accountValue = startingAccountValue;
    return [...days.keys()].sort().map((tradeDate) => {
      const x = days.get(tradeDate);
      const tradingResult = round(x.realized + x.unrealizedDelta, 4);
      const tf = tradeFees(x, mode);
      const fees = tf + x.md + x.platform + x.recurringOther;
      const totalDelta = round(tradingResult - fees, 4);
      accountValue = round(accountValue + totalDelta + x.transfers, 4);
      return {
        tradeDate,
        schema3Delta: tradingResult,
        schema1Delta: totalDelta,
        commissions: round(tf, 4),            // direct trade fees, counted once
        marketDataFees: round(x.md, 4),
        platformFees: round(x.platform, 4),
        otherFees: round(x.recurringOther, 4), // other RECURRING monthly fees (e.g. Multisport)
        transfers: round(x.transfers, 4),
        accountValue,
        realizedNet: round(x.realized - tf, 4),
        quantityTraded: round(x.qty, 6),
      };
    });
  };

  // Only matters when both sources carry fees on the same day.
  const overlapDays = [...days.values()].filter((x) => x.columnCosts > 0 && x.adjTradeFees > 0).length;
  let mode = feeMode;
  if (mode === 'auto') {
    mode = 'dedupe';
    if (overlapDays && reportedAccountValue !== null && Number.isFinite(reportedAccountValue)) {
      const endA = build('dedupe').at(-1)?.accountValue ?? startingAccountValue;
      const endB = build('separate').at(-1)?.accountValue ?? startingAccountValue;
      mode = Math.abs(endB - reportedAccountValue) + 0.005 < Math.abs(endA - reportedAccountValue) ? 'separate' : 'dedupe';
    }
  }

  return {
    rows: build(mode),
    symbolRows: [...symbols.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.symbol.localeCompare(b.symbol)).map((s) => ({
      ...s, realized: round(s.realized, 4), unrealizedDelta: round(s.unrealizedDelta, 4), tradeCosts: round(s.tradeCosts, 4),
      dayResult: round(s.realized + s.unrealizedDelta, 4), quantityTraded: round(s.quantityTraded, 6),
    })),
    feeMode: mode,
    overlapDays,
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
