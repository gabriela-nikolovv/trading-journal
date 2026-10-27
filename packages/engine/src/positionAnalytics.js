// Current-position analytics (spec sections 10, 13, 14, 24, 38): value,
// unrealized P&L, Current R, risk to stop, and exposure rollups.
//
// A position without a valid price or stop yields explicit status fields
// ('unavailable' / 'not_set' / 'invalid') and null numbers — never a guess.

import { round } from './money.js';
import { computeCurrentR } from './currentR.js';

/**
 * @param {{symbol:string,direction:'long'|'short',openQuantity:number,avgEntryPrice:number,multiplier?:number,stopLoss?:number|null,sectorName?:string|null,industryName?:string|null}} position
 * @param {import('./marketData.js').Quote|undefined} quote
 */
export function enrichPosition(position, quote) {
  const mult = position.multiplier ?? 1;
  const qty = position.openQuantity;
  const sign = position.direction === 'long' ? 1 : -1;
  const costBasis = position.avgEntryPrice * qty * mult;

  const base = {
    symbol: position.symbol, direction: position.direction, quantity: qty, avgEntry: position.avgEntryPrice,
    stopLoss: position.stopLoss ?? null, sector: position.sectorName ?? null, industry: position.industryName ?? null,
  };

  // ---- risk to stop (needs only the stop, not a price) ----
  const stopCheck = computeCurrentR({ direction: position.direction, entry: position.avgEntryPrice, stop: position.stopLoss, current: position.avgEntryPrice });
  const risk = stopCheck.status === 'ok'
    ? { riskStatus: 'ok', riskToStop: round(qty * mult * Math.abs(position.avgEntryPrice - position.stopLoss), 2) }
    : { riskStatus: stopCheck.status, riskToStop: null, riskReason: stopCheck.reason ?? null };

  if (!quote || !quote.ok) {
    return { ...base, ...risk, priceStatus: 'unavailable', priceReason: quote?.reason ?? 'No price requested.',
             price: null, marketValue: null, exposure: null, unrealizedPnl: null, pnlPct: null, currentR: { status: 'unavailable' } };
  }

  const price = quote.price;
  const unrealized = sign * (price - position.avgEntryPrice) * qty * mult;
  const r = computeCurrentR({ direction: position.direction, entry: position.avgEntryPrice, stop: position.stopLoss, current: price });
  return {
    ...base, ...risk,
    priceStatus: quote.stale ? 'stale' : 'ok', priceReason: quote.staleReason ?? null,
    price, priceAsOf: quote.asOf, priceSession: quote.session, priceSource: quote.source,
    marketValue: round(price * qty * mult, 2),            // signed notional of the holding (spec 13)
    exposure: round(Math.abs(price * qty * mult), 2),
    unrealizedPnl: round(unrealized, 2),
    pnlPct: costBasis ? round((unrealized / costBasis) * 100, 2) : null,
    currentR: r,                                          // {status:'ok',value} | not_set | invalid
    // Monetary distance from current price to the stop (positive = loss if stopped from here).
    potentialLossToStop: risk.riskStatus === 'ok' ? round(sign * (price - position.stopLoss) * qty * mult, 2) : null,
  };
}

/**
 * @param {ReturnType<typeof enrichPosition>[]} positions
 * @param {{accountValue?:number|null}} [opts]
 */
export function summarizePortfolio(positions, { accountValue = null } = {}) {
  const priced = positions.filter((p) => p.exposure !== null);
  const sum = (xs) => round(xs.reduce((a, b) => a + b, 0), 2);
  const gross = sum(priced.map((p) => p.exposure));
  const longX = sum(priced.filter((p) => p.direction === 'long').map((p) => p.exposure));
  const shortX = sum(priced.filter((p) => p.direction === 'short').map((p) => p.exposure));

  const group = (keyFn) => {
    const m = new Map();
    for (const p of priced) m.set(keyFn(p), (m.get(keyFn(p)) ?? 0) + p.exposure);
    return [...m.entries()].map(([name, v]) => ({ name, exposure: round(v, 2), pct: gross ? round((v / gross) * 100, 1) : 0 }))
      .sort((a, b) => b.exposure - a.exposure);
  };

  const withRisk = positions.filter((p) => p.riskStatus === 'ok');
  const totalRisk = sum(withRisk.map((p) => p.riskToStop));

  return {
    totalExposure: gross, longExposure: longX, shortExposure: shortX, netExposure: round(longX - shortX, 2),
    bySymbol: group((p) => p.symbol),
    bySector: group((p) => p.sector ?? 'Unclassified'),
    byIndustry: group((p) => p.industry ?? 'Unclassified'),
    unpricedPositions: positions.length - priced.length,
    unrealizedPnl: sum(priced.map((p) => p.unrealizedPnl)),
    totalRiskToStops: totalRisk,
    positionsMissingStop: positions.filter((p) => p.riskStatus === 'not_set').map((p) => p.symbol),
    positionsWithInvalidStop: positions.filter((p) => p.riskStatus === 'invalid').map((p) => p.symbol),
    // Prop accounts can have negative equity; a percentage of a non-positive number is meaningless.
    riskPctOfAccount: accountValue && accountValue > 0 ? round((totalRisk / accountValue) * 100, 2) : null,
  };
}
