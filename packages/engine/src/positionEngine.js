// Position reconstruction engine.
//
// Rebuilds "position instances" (one continuous open→closed lifecycle each)
// from a chronological stream of fills for a single (account, symbol) pair.
//
// KEY DESIGN DECISION — signed quantity, not fill "type":
// PropReports tags each fill B / S / T / C (Buy, Sell, Short, Cover). Rather
// than branching on that tag, we reduce every fill to a SIGNED quantity:
//   B, C  -> +quantity   (adds to a long / closes a short)
//   S, T  -> -quantity   (adds to a short / closes a long)
// The whole position then falls out of the running signed quantity, which is
// exactly how the spec's worked examples are defined:
//   BUY 100, BUY 50, SELL 50   -> net +100        -> OPEN LONG 100
//   BUY 100, SELL 100          -> net 0            -> CLOSED
//   SELL 100, BUY 40           -> net -60          -> OPEN SHORT 60
// This also makes reversals fall out naturally instead of needing special
// casing: a fill can close the remaining open quantity AND open a brand new
// instance in the opposite direction in the same step.

import { round } from './money.js';

const EPS = 1e-9;

/**
 * @typedef {Object} NormalizedFill
 * @property {string} id            Stable id (raw_fills.id) — used for tie-breaking and traceability.
 * @property {string} symbol
 * @property {Date}   datetime
 * @property {'B'|'S'|'T'|'C'} side
 * @property {number} quantity      Always positive; sign comes from `side`.
 * @property {number} price
 * @property {number} totalFee      Sum of comm+ecn+sec+taf+nscc+clr+misc for this one fill.
 * @property {number} [multiplier]  Contract/share multiplier. Defaults to 1.
 * @property {string} [currency]
 */

/** @param {NormalizedFill} fill */
export function signedQuantity(fill) {
  const sign = fill.side === 'B' || fill.side === 'C' ? 1 : -1;
  return sign * fill.quantity;
}

function newInstance(fill, openingSignedQty) {
  const direction = openingSignedQty > 0 ? 'long' : 'short';
  const qty = Math.abs(openingSignedQty);
  return {
    symbol: fill.symbol,
    direction,
    status: /** @type {'open'|'closed'} */ ('open'),
    openQuantitySigned: openingSignedQty,
    openQuantity: qty,
    remainingQuantity: qty, // alias for openQuantity, kept for spec-field parity
    originalQuantity: qty,  // size of the very first opening fill
    quantityTraded: qty,    // cumulative quantity ever added while opening/adding
    closedQuantity: 0,
    avgEntryPrice: fill.price,
    avgExitPrice: null,
    realizedPnl: 0,
    feesAllocated: 0,
    currency: fill.currency ?? 'USD',
    multiplier: fill.multiplier ?? 1,
    openedAt: fill.datetime,
    closedAt: null,
    fillLinks: [],
  };
}

function directionSign(instance) {
  return instance.direction === 'long' ? 1 : -1;
}

function addFillLink(instance, fill, quantityApplied, feeApplied) {
  instance.fillLinks.push({
    fillId: fill.id,
    quantityApplied,
    feeApplied: round(feeApplied, 6),
    runningQuantityAfter: instance.openQuantity,
    runningAvgCostAfter: instance.avgEntryPrice,
  });
}

/** Same-direction fill: grows the position. Blends the weighted-average entry price. */
function addToInstance(instance, fill) {
  const addQty = fill.quantity;
  const oldQty = instance.openQuantity;
  instance.avgEntryPrice = round(
    (instance.avgEntryPrice * oldQty + fill.price * addQty) / (oldQty + addQty),
    6
  );
  instance.openQuantity = round(oldQty + addQty, 6);
  instance.openQuantitySigned = directionSign(instance) * instance.openQuantity;
  instance.remainingQuantity = instance.openQuantity;
  instance.quantityTraded = round(instance.quantityTraded + addQty, 6);
  instance.feesAllocated = round(instance.feesAllocated + fill.totalFee, 6);
  addFillLink(instance, fill, addQty, fill.totalFee);
}

/**
 * Opposite-direction fill: closes up to `closingQty` of the position and
 * realizes P&L on that portion. Does not touch avgEntryPrice — a partial
 * close never changes the cost basis of the shares that remain open.
 */
function closePortion(instance, fill, closingQty, feeForThisPortion) {
  const pnl = round(
    (fill.price - instance.avgEntryPrice) * closingQty * instance.multiplier * directionSign(instance),
    6
  );
  instance.realizedPnl = round(instance.realizedPnl + pnl, 6);
  instance.avgExitPrice = round(
    ((instance.avgExitPrice ?? 0) * instance.closedQuantity + fill.price * closingQty) /
      (instance.closedQuantity + closingQty),
    6
  );
  instance.closedQuantity = round(instance.closedQuantity + closingQty, 6);
  instance.openQuantity = round(instance.openQuantity - closingQty, 6);
  instance.openQuantitySigned = directionSign(instance) * instance.openQuantity;
  instance.remainingQuantity = instance.openQuantity;
  instance.feesAllocated = round(instance.feesAllocated + feeForThisPortion, 6);
  addFillLink(instance, fill, -closingQty, feeForThisPortion);
}

/**
 * Reconstruct all position instances for ONE (account, symbol) pair.
 * @param {NormalizedFill[]} fills  Fills for a single symbol; any order.
 * @returns {ReturnType<typeof newInstance>[]}
 */
export function reconstructPositions(fills) {
  const sorted = [...fills].sort((a, b) => {
    const dt = a.datetime.getTime() - b.datetime.getTime();
    if (dt !== 0) return dt;
    return String(a.id).localeCompare(String(b.id)); // stable tiebreak for same-timestamp fills
  });

  /** @type {ReturnType<typeof newInstance>[]} */
  const instances = [];
  /** @type {ReturnType<typeof newInstance>|null} */
  let current = null;

  for (const fill of sorted) {
    const qtySigned = signedQuantity(fill);

    if (!current) {
      current = newInstance(fill, qtySigned);
      addFillLink(current, fill, fill.quantity, fill.totalFee);
      current.feesAllocated = round(fill.totalFee, 6);
      instances.push(current);
      continue;
    }

    const sameDirection = Math.sign(qtySigned) === Math.sign(current.openQuantitySigned);

    if (sameDirection) {
      addToInstance(current, fill);
      continue;
    }

    // Opposite direction: reduces (and possibly reverses) the open position.
    const closingQty = Math.min(Math.abs(qtySigned), current.openQuantity);
    const leftoverQty = round(Math.abs(qtySigned) - closingQty, 6);
    const feeShareForClose = leftoverQty > EPS
      ? round(fill.totalFee * (closingQty / fill.quantity), 6)
      : fill.totalFee;

    closePortion(current, fill, closingQty, feeShareForClose);

    if (current.openQuantity <= EPS) {
      current.status = 'closed';
      current.closedAt = fill.datetime;
      current.openQuantity = 0;
      current.remainingQuantity = 0;
      current.openQuantitySigned = 0;

      if (leftoverQty > EPS) {
        // Reversal: the same fill closes the old instance AND opens a new
        // one in the opposite direction. New instance starts completely
        // fresh — user metadata (stop loss/sector/notes) is NOT carried over,
        // matching the spec's "this is a new/current position" rule.
        const flippedSignedQty = (current.direction === 'long' ? -1 : 1) * leftoverQty;
        current = newInstance(fill, flippedSignedQty);
        const feeForOpen = round(fill.totalFee - feeShareForClose, 6);
        current.feesAllocated = feeForOpen;
        addFillLink(current, fill, leftoverQty, feeForOpen);
        instances.push(current);
      } else {
        current = null; // fully flat; next fill (if any) starts a new instance
      }
    }
  }

  return instances;
}

/**
 * Group raw fills by symbol and reconstruct each symbol's position history.
 * @param {NormalizedFill[]} fills  All fills for one account, any symbols mixed together.
 * @returns {Record<string, ReturnType<typeof newInstance>[]>}
 */
export function reconstructAllPositions(fills) {
  /** @type {Record<string, NormalizedFill[]>} */
  const bySymbol = {};
  for (const fill of fills) {
    (bySymbol[fill.symbol] ??= []).push(fill);
  }
  /** @type {Record<string, ReturnType<typeof newInstance>[]>} */
  const result = {};
  for (const [symbol, symbolFills] of Object.entries(bySymbol)) {
    result[symbol] = reconstructPositions(symbolFills);
  }
  return result;
}

/**
 * Live valuation of an open instance — deliberately separate from the ledger
 * itself, since it depends on a current market price the engine doesn't own.
 * @param {{direction:'long'|'short', avgEntryPrice:number, openQuantity:number, currentPrice:number, multiplier?:number}} p
 */
export function computeUnrealizedPnl({ direction, avgEntryPrice, openQuantity, currentPrice, multiplier = 1 }) {
  const sign = direction === 'long' ? 1 : -1;
  return round((currentPrice - avgEntryPrice) * openQuantity * multiplier * sign, 6);
}
