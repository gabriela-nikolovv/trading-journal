// Current-position analytics (spec sections 10, 13, 14, 24, 38): value,
// unrealized P&L, Current R, risk to stop, and exposure rollups.
//
// A position without a valid price or stop yields explicit status fields
// ('unavailable' / 'not_set' / 'invalid') and null numbers — never a guess.

import { round } from './money.js';
import { computeCurrentR } from './currentR.js';

/**
 * Two stops (spec 14, revised):
 *   ORIGINAL stop — the stop the trade was planned and executed with. R multiples are measured
 *                   against it, so it must sit on the losing side of the entry.
 *   CURRENT stop  — where the stop is now. It may be moved past the entry (a long's stop above
 *                   the entry): the position is then DERISKED and being stopped out locks a profit.
 * `stopLoss` is accepted as the original stop for older callers.
 * @param {{symbol:string,direction:'long'|'short',openQuantity:number,avgEntryPrice:number,multiplier?:number,stopLoss?:number|null,originalStop?:number|null,currentStop?:number|null,sectorName?:string|null,industryName?:string|null}} position
 * @param {import('./marketData.js').Quote|undefined} quote
 */
export function enrichPosition(position, quote) {
  const mult = position.multiplier ?? 1;
  const qty = position.openQuantity;
  const sign = position.direction === 'long' ? 1 : -1;
  const entry = position.avgEntryPrice;
  const costBasis = entry * qty * mult;
  const originalStop = position.originalStop ?? position.stopLoss ?? null;

  // ---- original stop: validity decides whether R can be calculated ----
  const stopCheck = computeCurrentR({ direction: position.direction, entry, stop: originalStop, current: entry });
  const initialRisk = stopCheck.status === 'ok' ? round(qty * mult * Math.abs(entry - originalStop), 2) : null;
  // ---- current stop: defaults to the original one while it has not been moved ----
  const currentStop = position.currentStop ?? (stopCheck.status === 'ok' ? originalStop : null);
  // Money lost if stopped out at the current stop, measured from the entry. ≤ 0 means derisked.
  const riskToStop = currentStop === null ? null : round(sign * (entry - currentStop) * qty * mult, 2);
  const derisked = currentStop !== null && sign * (currentStop - entry) >= 0;

  const base = {
    symbol: position.symbol, direction: position.direction, quantity: qty, avgEntry: entry,
    stopLoss: originalStop, originalStop, currentStop, initialRisk, derisked,
    sector: position.sectorName ?? null, industry: position.industryName ?? null,
  };
  const risk = {
    riskStatus: originalStop === null && currentStop === null ? 'not_set' : stopCheck.status === 'invalid' ? 'invalid' : stopCheck.status === 'ok' ? 'ok' : 'not_set',
    riskReason: stopCheck.status === 'invalid' ? stopCheck.reason : null,
    riskToStop,
  };

  if (!quote || !quote.ok) {
    return { ...base, ...risk, priceStatus: 'unavailable', priceReason: quote?.reason ?? 'No price requested.',
             price: null, marketValue: null, exposure: null, unrealizedPnl: null, pnlPct: null,
             currentR: originalStop === null ? { status: 'not_set' } : { status: 'unavailable' }, potentialLossToStop: null };
  }

  const price = quote.price;
  const unrealized = sign * (price - entry) * qty * mult;
  const r = computeCurrentR({ direction: position.direction, entry, stop: originalStop, current: price });
  return {
    ...base, ...risk,
    priceStatus: quote.stale ? 'stale' : 'ok', priceReason: quote.staleReason ?? null,
    price, priceAsOf: quote.asOf, priceSession: quote.session, priceSource: quote.source,
    marketValue: round(price * qty * mult, 2),            // signed notional of the holding (spec 13)
    exposure: round(Math.abs(price * qty * mult), 2),
    unrealizedPnl: round(unrealized, 2),
    pnlPct: costBasis ? round((unrealized / costBasis) * 100, 2) : null,
    currentR: r,                                          // measured against the ORIGINAL stop
    // From the current price down to the CURRENT stop (positive = would be given back).
    potentialLossToStop: currentStop === null ? null : round(sign * (price - currentStop) * qty * mult, 2),
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

  // Open risk counts only money still at risk; a derisked position adds nothing (its locked profit is shown apart).
  const withRisk = positions.filter((p) => p.riskToStop !== null && p.riskStatus !== 'invalid');
  const totalRisk = sum(withRisk.map((p) => Math.max(0, p.riskToStop)));
  const locked = sum(withRisk.map((p) => Math.max(0, -p.riskToStop)));

  return {
    totalExposure: gross, longExposure: longX, shortExposure: shortX, netExposure: round(longX - shortX, 2),
    bySymbol: group((p) => p.symbol),
    bySector: group((p) => p.sector ?? 'Unclassified'),
    byIndustry: group((p) => p.industry ?? 'Unclassified'),
    unpricedPositions: positions.length - priced.length,
    unrealizedPnl: sum(priced.map((p) => p.unrealizedPnl)),
    totalRiskToStops: totalRisk,
    lockedByStops: locked,
    derisked: positions.filter((p) => p.derisked).map((p) => p.symbol),
    positionsMissingStop: positions.filter((p) => p.riskStatus === 'not_set').map((p) => p.symbol),
    positionsWithInvalidStop: positions.filter((p) => p.riskStatus === 'invalid').map((p) => p.symbol),
    // Prop accounts can have negative equity; a percentage of a non-positive number is meaningless.
    riskPctOfAccount: accountValue && accountValue > 0 ? round((totalRisk / accountValue) * 100, 2) : null,
  };
}
