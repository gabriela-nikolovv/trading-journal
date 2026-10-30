// Splitting one PropReports position into LOTS (separate entries with their own stops).
//
// WHY: PropReports keeps ONE net position per symbol per account — two separate
// buys of the same ticker become a single position with an averaged price. The
// individual ENTRY executions are still in the fills, though, so the journal can
// show them apart: each lot owns a set of entry executions and carries its own
// original stop / current stop.
//
// HOW REMAINING QUANTITY IS WORKED OUT: exits are matched to entries First-In,
// First-Out (the order PropReports itself uses to close shares), so selling part
// of a position first reduces the OLDEST entry. A lot's entry price is the
// average of what is left of its own executions.
//
// A lot is stored as the list of its entries' keys ("datetime|quantity|price"),
// not database ids — a fill re-imported upstream gets a new PropReports Id but
// keeps the same key, so a split survives re-syncs.

import { round } from './money.js';

const iso = (d) => new Date(d).toISOString();
export const entryKey = (f) => `${iso(f.datetime)}|${Number(f.quantity)}|${Number(f.price)}`;

/**
 * Remaining (still open) entry executions of a position, FIFO.
 * @param {Array<{datetime:string|Date, side:'B'|'S'|'T'|'C', quantity:number|string, price:number|string}>} fills
 * @param {'long'|'short'} direction
 * @returns {Array<{key:string, datetime:string, date:string, quantity:number, remaining:number, price:number}>}
 */
export function remainingEntries(fills, direction) {
  const dir = direction === 'long' ? 1 : -1;
  const sorted = [...fills].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  const entries = [];
  for (const f of sorted) {
    const signed = (f.side === 'B' || f.side === 'C' ? 1 : -1) * Math.abs(Number(f.quantity));
    if (Math.sign(signed) === dir) {
      entries.push({ key: entryKey(f), datetime: iso(f.datetime), date: iso(f.datetime).slice(0, 10), quantity: Math.abs(Number(f.quantity)), remaining: Math.abs(Number(f.quantity)), price: Number(f.price) });
    } else {
      let toClose = Math.abs(signed);
      for (const e of entries) {
        if (toClose <= 0) break;
        const take = Math.min(e.remaining, toClose);
        e.remaining = round(e.remaining - take, 6); toClose = round(toClose - take, 6);
      }
    }
  }
  return entries.filter((e) => e.remaining > 0);
}

/**
 * Builds the lots to display. Entries not listed in any saved lot (e.g. shares
 * added after the split) are gathered into one extra lot that uses the
 * position's own stops, so no share is ever hidden.
 * @param {ReturnType<typeof remainingEntries>} entries
 * @param {Array<{id:string,label?:string|null,entryKeys:string[],originalStop:number|null,currentStop:number|null,notes?:string|null}>} savedLots
 * @param {{originalStop:number|null,currentStop:number|null}} positionStops
 */
export function buildLots(entries, savedLots, positionStops) {
  if (!savedLots.length) return [];
  const used = new Set();
  const make = (lot, list, i) => {
    const qty = round(list.reduce((a, e) => a + e.remaining, 0), 6);
    if (!(qty > 0)) return null;
    list.forEach((e) => used.add(e.key));
    return {
      id: lot.id ?? null, label: lot.label || `Lot ${i + 1}`, quantity: qty,
      entry: round(list.reduce((a, e) => a + e.remaining * e.price, 0) / qty, 6),
      openedAt: list.map((e) => e.datetime).sort()[0], entryKeys: list.map((e) => e.key),
      originalStop: lot.originalStop ?? null, currentStop: lot.currentStop ?? null, notes: lot.notes ?? null,
    };
  };
  const lots = savedLots.map((l, i) => make(l, entries.filter((e) => l.entryKeys.includes(e.key)), i)).filter(Boolean);
  const rest = entries.filter((e) => !used.has(e.key));
  if (rest.length) {
    const extra = make({ id: null, label: 'Not in a lot', ...positionStops }, rest, lots.length);
    if (extra) lots.push(extra);
  }
  return lots;
}

/** Default split proposal: one lot per trading day an entry was made on. */
export function proposeSplitByDay(entries) {
  const days = [...new Set(entries.map((e) => e.date))].sort();
  return entries.map((e) => ({ key: e.key, lot: days.indexOf(e.date) }));
}

/**
 * Position-level risk once the position is split: the sum over its lots, so the
 * portfolio summary counts every lot's own stop exactly once.
 * @param {Object} position      enriched position (positionAnalytics.enrichPosition)
 * @param {Object[]} enrichedLots each lot enriched the same way
 */
export function rollUpLots(position, enrichedLots) {
  if (!enrichedLots.length) return position;
  const statuses = enrichedLots.map((l) => l.riskStatus);
  return {
    ...position,
    riskStatus: statuses.includes('invalid') ? 'invalid' : statuses.includes('not_set') ? 'not_set' : 'ok',
    riskToStop: enrichedLots.some((l) => l.riskToStop === null) ? null : round(enrichedLots.reduce((a, l) => a + l.riskToStop, 0), 2),
    derisked: enrichedLots.every((l) => l.derisked),
    lots: enrichedLots,
  };
}
