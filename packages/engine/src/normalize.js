// Maps PropReports CSV rows (already parsed into header-keyed objects) into
// the shapes the rest of the engine understands. Every lookup goes through
// readOptional() so a missing optional column never throws — it just comes
// back undefined/0, per spec section 5.

import { toNumber, readOptional } from './csv.js';

/**
 * @param {Record<string,string>} row  One row from the `fills` CSV.
 * @param {string|number} propAccountId  Our internal prop_accounts.id.
 */
export function normalizeFillRow(row, propAccountId) {
  const comm = toNumber(row['Comm']);
  const ecn = toNumber(row['Ecn Fee']);
  const sec = toNumber(row['SEC']);
  const taf = toNumber(row['TAF']);
  const nscc = toNumber(row['NSCC']);
  const clr = toNumber(row['Clr']);
  const misc = toNumber(row['Misc']);

  return {
    propAccountId,
    propreportsId: readOptional(row, ['PropReports Id', 'propReportsId']) ?? null,
    fillId: readOptional(row, ['Fill Id', 'fillId']) ?? null,
    orderId: readOptional(row, ['Order Id', 'orderId']) ?? null,
    datetimeIso: row['Date/Time'],
    tradeDate: row['Trade Date'] || (row['Date/Time'] || '').slice(0, 10),
    symbol: row['Symbol'],
    side: normalizeSide(row['Buy/Sell'] ?? row['B/S']),
    quantity: Math.abs(toNumber(row['Quantity'] ?? row['Qty'])),
    price: toNumber(row['Price']),
    route: row['Route'] || null,
    status: row['Status'] || null,
    comm,
    ecnFee: ecn,
    secFee: sec,
    tafFee: taf,
    nsccFee: nscc,
    clrFee: clr,
    miscFee: misc,
    // Total fee is the sum of every fee/rebate column — a negative value
    // here means the fill was a net credit (e.g. an ECN rebate).
    totalFee: comm + ecn + sec + taf + nscc + clr + misc,
    currency: readOptional(row, ['Currency']) ?? 'USD',
    multiplier: Number(readOptional(row, ['Multiplier']) ?? 1),
    raw: row,
  };
}

/** Normalizes the various spellings/values PropReports uses for fill side. */
function normalizeSide(raw) {
  const v = (raw || '').trim().toUpperCase();
  if (v === 'B' || v === 'BUY') return 'B';
  if (v === 'S' || v === 'SELL') return 'S';
  if (v === 'T' || v === 'SHORT') return 'T';
  if (v === 'C' || v === 'COVER') return 'C';
  throw new Error(`Unrecognized fill side: "${raw}"`);
}

/**
 * @param {Record<string,string>} row  One row from the `adjustments` CSV.
 * @param {string|number} propAccountId
 */
export function normalizeAdjustmentRow(row, propAccountId) {
  return {
    propAccountId,
    propreportsId: readOptional(row, ['PropReports Id', 'propReportsId']) ?? null,
    date: row['Date'] || row['Trade Date'],
    categoryName: row['Category'] || row['Description'] || 'Uncategorized',
    amount: toNumber(row['Amount']),
    description: row['Description'] || null,
    raw: row,
  };
}

/**
 * Classifies an adjustment's category as 'fee' or 'transfer'. Known
 * categories (from adjustment_categories, configured in Settings) always
 * win. Unknown categories get a best-effort keyword guess AND are flagged
 * `isKnown: false` so the sync engine can raise a reconciliation warning
 * instead of silently trusting the guess — this is exactly the failure mode
 * that made the previous implementation miss Platform fees.
 * @param {string} categoryName
 * @param {Map<string,'fee'|'transfer'>} knownCategories  name -> type, from adjustment_categories
 */
export function classifyAdjustmentCategory(categoryName, knownCategories) {
  const known = knownCategories.get(categoryName);
  if (known) return { type: known, isKnown: true };

  const lower = categoryName.toLowerCase();
  const transferKeywords = ['transfer', 'deposit', 'withdrawal', 'wire'];
  if (transferKeywords.some((k) => lower.includes(k))) return { type: 'transfer', isKnown: true };

  // PropReports names recurring charges "Fee: Platform", "Fee: Market Data", ... (spec section 35).
  // Recognising these by pattern means they count toward Schema 1 with no setup and no warning.
  if (/^fee\b|market\s*data|platform|multisport|data\s*fee|subscription/.test(lower)) return { type: 'fee', isKnown: true };

  // Anything else is still treated as a cost (conservative) but flagged so it gets looked at.
  return { type: 'fee', isKnown: false };
}
