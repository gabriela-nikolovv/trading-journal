// Builds one row per trading day: the numbers behind the Calendar, Dashboard
// and Weekly Report (table daily_account_snapshots).
//
// SOURCES (PropReports API v2)
//   positions   → per symbol per day: Realized, Unrealized Delta, and the trade-level
//                 cost columns Comm / Ecn Fee / SEC / TAF / NSCC / Clr / Misc.
//   adjustments → recurring fees (Platform, Market Data, others) and transfers.
//
// DEFINITIONS (spec sections 15 and 35)
//   trading result (Schema 3) = Σ Realized + Σ Unrealized Delta
//   trade costs               = Σ Comm + Ecn + SEC + TAF + NSCC + Clr + Misc
//   Schema 1 (report total)   = trading result − trade costs − market-data − platform − other fees
//   account value             = previous account value + Schema 1 delta + transfers
//   realized net              = Σ Realized − trade costs        (HYPOTHESIS — see README)
//
// Fee adjustments are POSTED on a single day (the 1st, for this account) — they
// land in that day's Schema 1 and account value, which is exactly the −$50.95
// gap seen on 1 Sep 2026 in the real weekly report.
//
// ASSUMPTIONS NOT YET CHECKED AGAINST LIVE DATA: that `Realized` is gross of the
// fee columns (they are separate columns), and that rows are in the account's
// base currency (non-USD rows are flagged, never converted).

import { round } from './money.js';

const FEE_COLUMNS = ['Comm', 'Ecn Fee', 'SEC', 'TAF', 'NSCC', 'Clr', 'Misc'];
const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};

/**
 * @param {Object} o
 * @param {Record<string,string>[]} o.positionRows       parsed `positions` CSV rows
 * @param {Array<{date:string,amount:number,categoryName:string,categoryType:'fee'|'transfer'}>} o.adjustments
 * @param {number} o.startingAccountValue                 account value at the end of the day before the first row
 * @returns {{rows:Array<Object>,warnings:Array<{type:string,message:string}>}}
 */
export function buildDailySnapshots({ positionRows, adjustments, startingAccountValue }) {
  const warnings = [];
  /** @type {Map<string,any>} */
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, { realized: 0, unrealizedDelta: 0, tradeCosts: 0, qty: 0, md: 0, platform: 0, other: 0, transfers: 0 });
    return days.get(d);
  };

  let nonUsd = 0;
  for (const r of positionRows) {
    const d = r['Date'];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) continue;
    const x = day(d);
    x.realized += num(r['Realized']);
    x.unrealizedDelta += num(r['Unrealized Delta']);
    x.tradeCosts += FEE_COLUMNS.reduce((s, c) => s + num(r[c]), 0);
    x.qty += Math.abs(num(r['Qty Traded']));
    if (r['Currency'] && r['Currency'] !== 'USD') nonUsd++;
  }
  if (nonUsd) warnings.push({ type: 'non_usd_positions', message: `${nonUsd} position rows are not in USD; they were included unconverted.` });

  for (const a of adjustments) {
    const x = day(a.date);
    if (a.categoryType === 'transfer') x.transfers += a.amount;
    else {
      const cost = -a.amount; // a debit (negative amount) is a cost
      if (/market\s*data/i.test(a.categoryName)) x.md += cost;
      else if (/platform/i.test(a.categoryName)) x.platform += cost;
      else x.other += cost;
    }
  }

  let accountValue = startingAccountValue;
  const rows = [...days.keys()].sort().map((tradeDate) => {
    const x = days.get(tradeDate);
    const tradingResult = round(x.realized + x.unrealizedDelta, 4);
    const schema1 = round(tradingResult - x.tradeCosts - x.md - x.platform - x.other, 4);
    accountValue = round(accountValue + schema1 + x.transfers, 4);
    return {
      tradeDate,
      schema3Delta: tradingResult,
      schema1Delta: schema1,
      commissions: round(x.tradeCosts, 4),
      marketDataFees: round(x.md, 4),
      platformFees: round(x.platform, 4),
      otherFees: round(x.other, 4),
      transfers: round(x.transfers, 4),
      accountValue,
      realizedNet: round(x.realized - x.tradeCosts, 4),
      quantityTraded: round(x.qty, 6),
    };
  });
  return { rows, warnings };
}

/**
 * The weekly report's "Total Δ" row deliberately leaves out the recurring monthly
 * fees (market data / platform / multisport), which post on the 1st (spec section 26).
 */
export function reportDayDelta(row) {
  return round(row.schema1Delta + row.marketDataFees + row.platformFees + row.otherFees, 2);
}
