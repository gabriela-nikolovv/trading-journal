// Current R/R (spec section 14) — NOT conventional entry->target R:R.
// The current market price stands in for the "reward" point:
//   LONG:  R = (current - entry) / (entry - stop)
//   SHORT: R = (entry - current) / (stop - entry)
// A long requires stop < entry; a short requires stop > entry. If the stop
// is missing or violates that relationship, we refuse to invent a number.

import { round } from './money.js';

/**
 * @param {{direction:'long'|'short', entry:number, stop:number|null|undefined, current:number}} p
 * @returns {{status:'ok', value:number} | {status:'not_set'} | {status:'invalid', reason:string}}
 */
export function computeCurrentR({ direction, entry, stop, current }) {
  if (stop === null || stop === undefined || Number.isNaN(stop)) {
    return { status: 'not_set' };
  }

  if (direction === 'long') {
    if (!(stop < entry)) {
      return { status: 'invalid', reason: 'Stop Loss must be below Entry for a LONG position.' };
    }
    return { status: 'ok', value: round((current - entry) / (entry - stop), 4) };
  }

  if (direction === 'short') {
    if (!(stop > entry)) {
      return { status: 'invalid', reason: 'Stop Loss must be above Entry for a SHORT position.' };
    }
    return { status: 'ok', value: round((entry - current) / (stop - entry), 4) };
  }

  throw new Error(`Unknown direction: ${direction}`);
}
