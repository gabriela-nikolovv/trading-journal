// One daily series per P&L schema, for the Dashboard chart and period totals.
// Schemas are never mixed: each function reads exactly one column.
//  schema1 → schema1_delta   (report total: trading − every cost)
//  schema3 → schema3_delta   (pure trading)
//  schema2 → schema1 days, with that month's profit-share deducted ONCE, on the month's last day
import { resolvePctForMonth } from './pnlSchemas.js';
import { computeSchema2DailyDeltas } from './calendar.js';
import { round } from './money.js';

/**
 * @param {{date:string,schema1Delta:number,schema3Delta:number}[]} snapshots
 * @param {'schema1'|'schema2'|'schema3'} schema
 * @param {{pct:number,effectiveFrom:string}[]} schedule
 * @returns {{date:string,delta:number}[]}
 */
export function dailySeries(snapshots, schema, schedule = []) {
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  if (schema === 'schema1') return sorted.map((d) => ({ date: d.date, delta: d.schema1Delta }));
  if (schema === 'schema3') return sorted.map((d) => ({ date: d.date, delta: d.schema3Delta }));
  const byMonth = new Map();
  for (const d of sorted) {
    const k = d.date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push({ date: d.date, schema1Delta: d.schema1Delta });
  }
  const out = [];
  for (const [k, days] of byMonth) {
    const { days: adj } = computeSchema2DailyDeltas(days, resolvePctForMonth(schedule, `${k}-01`));
    out.push(...adj.map((d) => ({ date: d.date, delta: d.schema2Delta })));
  }
  return out;
}

/** Running total of a daily series. */
export function cumulative(series) {
  let run = 0;
  return series.map((p) => ({ date: p.date, value: (run = round(run + p.delta, 4)) }));
}
