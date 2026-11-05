// Calendar tab (spec section 20): Monday-first weeks, a schema switch that changes every number,
// a weekly total beside each week, a stats strip for the period, Days / Months / Years views, and a day
// panel listing EVERY position that was open that day — opened, closed, or held overnight — with its result.
import { h, clear, money, pct, signClass, schemaSelect, segmented, loading, errorCard, toast, fmtDate, SCHEMA_SHORT } from '../lib.js';
import { buildCalendarMonth, summarizePeriod, aggregateSeries } from '../engine/calendar.js';
import { resolvePctForMonth } from '../engine/pnlSchemas.js';
import { dailySeries } from '../engine/schemaSeries.js';
import { computeTradeStats } from '../engine/tradeStats.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // never Sunday-first
const pad = (n) => String(n).padStart(2, '0');
const lastDayOf = (y, m) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

export async function render(container, ctx) {
  const { api, state } = ctx;
  const now = new Date();
  state.cal ??= { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, selected: null };
  state.cal.view ??= 'days';
  // After Share is taken once a month, so it has no day-by-day calendar.
  if (state.schema === 'schema2' && state.cal.view === 'days') state.cal.view = 'months';
  const { year, month, view } = state.cal;

  clear(container).append(loading('Loading calendar…'));
  let snapshots, trades;
  try { [snapshots, trades] = await Promise.all([api.getSnapshots(), api.getClosedTrades()]); }
  catch (e) { clear(container).append(errorCard('The calendar could not be loaded.', e)); return; }

  const schema = state.schema;
  const series = dailySeries(snapshots, schema, state.schedule);
  const rerender = () => render(container, ctx);
  const setView = (v) => { state.cal = { ...state.cal, view: v, selected: null }; rerender(); };

  // Period shown by the stats strip and the nav arrows.
  const period = view === 'days' ? { from: `${year}-${pad(month)}-01`, to: lastDayOf(year, month), title: `${MONTHS[month - 1]} ${year}`, unit: 'Month' }
    : view === 'months' ? { from: `${year}-01-01`, to: `${year}-12-31`, title: String(year), unit: 'Year' }
      : { from: '0000-01-01', to: '9999-12-31', title: 'All years', unit: 'All-time' };
  const go = (step) => {
    if (view === 'days') { const d = new Date(Date.UTC(year, month - 1 + step, 1)); state.cal = { ...state.cal, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, selected: null }; }
    else if (view === 'months') state.cal = { ...state.cal, year: year + step, selected: null };
    rerender();
  };

  const root = h('div', {},
    h('div', { class: 'row between' }, h('h1', {}, 'Calendar'),
      h('div', { class: 'row' }, segmented(schema === 'schema2' ? [['months', 'Months'], ['years', 'Years']] : [['days', 'Days'], ['months', 'Months'], ['years', 'Years']], view, setView),
        schemaSelect(schema, (v) => ctx.setSchema(v)))),
    statsStrip(period, series, trades, schema));

  const card = h('div', { class: 'card' },
    h('div', { class: 'row between', style: 'margin-bottom:.6rem' },
      h('div', { class: 'row' },
        view !== 'years' ? h('button', { class: 'btn', 'aria-label': 'Previous', onclick: () => go(-1) }, '◀') : null,
        h('h2', { style: 'margin:0' }, period.title),
        view !== 'years' ? h('button', { class: 'btn', 'aria-label': 'Next', onclick: () => go(1) }, '▶') : null),
      view !== 'years' ? h('button', { class: 'btn', onclick: () => { state.cal = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, view, selected: null }; rerender(); } }, 'Today') : null));
  root.append(card);

  if (view === 'months') card.append(monthsGrid(year, series, (m) => { state.cal = { year, month: m, view: 'days', selected: null }; rerender(); }));
  else if (view === 'years') card.append(yearsGrid(series, (y) => { state.cal = { year: y, month: 1, view: 'months', selected: null }; rerender(); }));
  else {
    let comments = [], cal;
    try { comments = await api.getDailyComments(addMonths(period.from, -1), addMonths(period.to, 1)); } catch (e) { console.error(e); }
    try {
      cal = buildCalendarMonth({ year, month, schema, dailyData: snapshots, comments, profitSharePct: schema === 'schema2' ? resolvePctForMonth(state.schedule, period.from) : undefined });
    } catch (e) { clear(container).append(errorCard('A profit-share percentage is needed. Set it in Settings.', e)); return; }
    card.append(dayGrid(cal, state, schema, (d) => { state.cal.selected = d; rerender(); }));
    clear(container).append(root);
    if (state.cal.selected) root.append(await dayPanel(state.cal.selected, ctx, cal, comments, snapshots, rerender));
    return;
  }
  clear(container).append(root);
}

// ---------- stats strip ----------
function statsStrip(period, series, trades, schema) {
  const t = computeTradeStats(trades.map((x) => ({ ...x, status: 'closed' })), { fromDate: period.from, toDate: period.to });
  const box = (label, value, cls = '') => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value));
  // After Share only exists per month, so it counts green / red MONTHS.
  const byMonth = schema === 'schema2';
  const s = byMonth
    ? (() => { const ms = aggregateSeries(series.filter((d) => d.date >= period.from && d.date <= period.to), 'month'); const g = ms.filter((m) => m.pnl > 0).length, r = ms.filter((m) => m.pnl < 0).length; return { pnl: Math.round(ms.reduce((a, m) => a + m.pnl, 0) * 100) / 100, greenDays: g, redDays: r, greenPct: g + r ? g / (g + r) : null }; })()
    : summarizePeriod(series, period.from, period.to);
  const unit = byMonth ? 'months' : 'days';
  return h('div', { class: 'stat-strip card', id: 'cal-stats' },
    box(`${period.unit} P&L · ${SCHEMA_SHORT[schema]}`, money(s.pnl, { dollar: true }), signClass(s.pnl)),
    box(`Green ${unit}`, String(s.greenDays), s.greenDays ? 'pos' : ''),
    box(`Red ${unit}`, String(s.redDays), s.redDays ? 'neg' : ''),
    box('Green %', s.greenPct === null ? '—' : pct(s.greenPct, 0)),
    box('Bats', t.bat === null ? '—' : pct(t.bat, 0)),
    box('W/L', t.wlRatio === null ? '—' : t.wlRatio.toFixed(2)));
}

// ---------- days ----------
function dayGrid(cal, state, schema, onPick) {
  const grid = h('div', { class: 'cal-grid' }, HEADS.map((d) => h('div', { class: 'cal-head' }, d)), h('div', { class: 'cal-head week' }, 'Week'));
  for (const week of cal.weeks) {
    for (const d of week.days) {
      grid.append(h('div', {
        class: `cal-cell ${d.inCurrentMonth ? '' : 'other'} ${d.delta > 0 ? 'up' : d.delta < 0 ? 'down' : ''} ${state.cal.selected === d.date ? 'selected' : ''}`,
        'data-date': d.date, tabindex: '0', role: 'button', onclick: () => onPick(d.date),
      }, h('div', { class: 'd' }, h('span', {}, String(Number(d.date.slice(8)))), d.comment ? h('span', { title: d.comment }, '💬') : null),
        h('div', { class: `v ${signClass(d.delta)}` }, d.delta === null ? '' : money(d.delta))));
    }
    grid.append(h('div', { class: `cal-week ${signClass(week.weeklyTotal)}`, title: `Weekly result · ${SCHEMA_SHORT[schema]}` }, week.weeklyTotal === null ? '—' : money(week.weeklyTotal)));
  }
  return grid;
}

// ---------- months / years ----------
function tile(label, x, onClick, attrs = {}) {
  return h('button', { class: `period-tile ${x ? (x.pnl > 0 ? 'up' : x.pnl < 0 ? 'down' : '') : 'empty-tile'}`, onclick: onClick, ...attrs },
    h('div', { class: 'pt-label' }, label),
    h('div', { class: `pt-value ${x ? signClass(x.pnl) : ''}` }, x ? money(x.pnl) : '—'),
    h('div', { class: 'pt-sub' }, x ? `${x.greenDays} green · ${x.redDays} red` : 'no data'));
}
function monthsGrid(year, series, onPick) {
  const byMonth = new Map(aggregateSeries(series.filter((d) => d.date.startsWith(`${year}-`)), 'month').map((x) => [x.key, x]));
  return h('div', { class: 'period-grid', id: 'months-grid' }, MONTHS.map((name, i) => tile(name, byMonth.get(`${year}-${pad(i + 1)}`), () => onPick(i + 1), { 'data-month': `${year}-${pad(i + 1)}` })));
}
function yearsGrid(series, onPick) {
  const years = aggregateSeries(series, 'year');
  if (!years.length) return h('div', { class: 'empty' }, 'No trading days synced yet.');
  return h('div', { class: 'period-grid', id: 'years-grid' }, years.map((x) => tile(x.key, x, () => onPick(Number(x.key)), { 'data-year': x.key })));
}

// ---------- day panel ----------
async function dayPanel(date, ctx, cal, comments, snapshots, rerender) {
  const { api, state } = ctx;
  const cell = cal.weeks.flatMap((w) => w.days).find((d) => d.date === date);
  let positions = [], symbolDays = [];
  try { [positions, symbolDays] = await Promise.all([api.getPositionsOnDay(date), api.getSymbolDays(date, date)]); } catch (e) { console.error(e); }

  // One line per symbol: everything that was open that day plus anything PropReports reports a result for.
  const day = (d) => (d ? d.toISOString().slice(0, 10) : null);
  const bySymbol = new Map();
  for (const p of positions) {
    const opened = day(p.openedAt) === date, closed = day(p.closedAt) === date;
    const status = opened && closed ? 'Opened & closed' : opened ? 'Opened' : closed ? 'Closed' : 'Held';
    const prev = bySymbol.get(p.symbol);
    bySymbol.set(p.symbol, { symbol: p.symbol, direction: p.direction, status: prev ? `${prev.status} · ${status}` : status, realizedIfClosed: closed ? (prev?.realizedIfClosed ?? 0) + p.realizedPnl - (p.feesAllocated ?? 0) : prev?.realizedIfClosed ?? null });
  }
  for (const s of symbolDays) {
    const x = bySymbol.get(s.symbol) ?? { symbol: s.symbol, direction: null, status: s.quantityTraded ? 'Traded' : 'Held' };
    bySymbol.set(s.symbol, { ...x, pr: s });
  }
  // Each stock's day, exactly as PropReports' Totals by Date shows it: Realized = Net (its trade fees
  // already taken off), Unrealized Δ, Total = Total Δ (Net + Unrealized Δ). Same in Total and Pure
  // trading. The "Fee: …" rows (daily interest, market data, platform, misc) are not booked to a stock:
  // in Total they are the "Other (fees)" line, in Pure trading they are left out.
  const list = [...bySymbol.values()].map((x) => {
    const realized = x.pr ? x.pr.realized - x.pr.tradeCosts : x.realizedIfClosed;
    const unreal = x.pr ? x.pr.unrealizedDelta : null;
    const total = realized === null && unreal === null ? null : (realized ?? 0) + (unreal ?? 0);
    return { ...x, realized, unreal, result: total, traded: x.pr?.quantityTraded ?? null };
  }).sort((a, b) => Math.abs(b.result ?? 0) - Math.abs(a.result ?? 0));
  const dayValue = cell?.delta ?? null;
  // Unrounded sums: rounding each row first left a phantom 0.01 "Other" on 30 Oct.
  const stocksSum = list.reduce((a, x) => a + (x.result ?? 0), 0);
  const rest = dayValue === null ? 0 : Math.round((dayValue - stocksSum) * 100) / 100;

  const snap = snapshots.find((x) => x.date === date);
  const breakdown = snap?.transfers ? h('div', { class: 'table-wrap' }, h('table', { class: 'breakdown' }, h('tbody', {},
    h('tr', {}, h('td', {}, 'Deposits / withdrawals (not P&L)'), h('td', { class: `num ${signClass(snap.transfers)}` }, money(snap.transfers)))))) : null;

  const comment = comments.find((c) => c.date === date)?.comment ?? '';
  const box = h('textarea', { id: 'day-comment', placeholder: 'What happened today? This is suggested automatically when you build the weekly report.' }, comment);
  const STATUS_CLASS = { Opened: 'info', Closed: 'closed', Held: 'held', 'Opened & closed': 'closed', Traded: 'info' };
  return h('div', { class: 'card', id: 'day-panel' },
    h('div', { class: 'row between' }, h('h2', {}, fmtDate(date)), h('div', {}, `${SCHEMA_SHORT[state.schema]}: `, h('b', { class: signClass(cell?.delta) }, cell?.delta === null || cell?.delta === undefined ? 'no trading data' : money(cell.delta)))),
    list.length || Math.abs(rest) >= 0.01
      ? h('div', { class: 'table-wrap' }, h('table', { id: 'day-positions' },
        h('thead', {}, h('tr', {}, ['Symbol', 'Direction', 'That day', 'Shares traded', 'Realized', 'Unrealized Δ', SCHEMA_SHORT[state.schema]].map((t, i) => h('th', { class: i > 2 ? 'num' : '' }, t)))),
        h('tbody', {}, list.map((t) => h('tr', {},
          h('td', {}, h('b', {}, t.symbol)),
          h('td', {}, t.direction ? h('span', { class: `badge ${t.direction}` }, t.direction.toUpperCase()) : '—'),
          h('td', {}, h('span', { class: `badge ${STATUS_CLASS[t.status] ?? 'info'}` }, t.status)),
          h('td', { class: 'num' }, !t.traded ? '—' : Math.round(t.traded)),
          h('td', { class: `num ${signClass(t.realized)}` }, t.realized === null ? '—' : money(t.realized)),
          h('td', { class: `num ${signClass(t.unreal)}` }, t.unreal === null ? '—' : money(t.unreal)),
          h('td', { class: `num ${signClass(t.result)}` }, h('b', {}, t.result === null ? '—' : money(t.result))))),
          Math.abs(rest) >= 0.01 ? h('tr', { class: 'day-rest' }, h('td', { colspan: 6 }, 'Other (fees)'), h('td', { class: `num ${signClass(rest)}` }, money(rest))) : null,
          dayValue !== null ? h('tr', { class: 'day-sum' }, h('td', { colspan: 6 }, h('b', {}, `Day ${SCHEMA_SHORT[state.schema]}`)), h('td', { class: `num ${signClass(dayValue)}` }, h('b', {}, money(dayValue)))) : null)))
      : h('div', { class: 'muted' }, 'No positions were open on this day.'),
    h('div', { class: 'muted', style: 'font-size:.78rem;margin:.3rem 0 .6rem' }, '“Held” = carried overnight with no trade that day; its result is the change in its unrealized P&L.'),
    breakdown,
    h('label', { class: 'field' }, 'Comment for this day', box),
    h('button', { class: 'btn primary', onclick: async () => {
      try { await api.saveDailyComment(state.account.id, state.userId, date, box.value); toast('Comment saved.'); rerender(); } catch (e) { toast('Could not save the comment.', 'error'); console.error(e); }
    } }, 'Save comment'));
}

function addMonths(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
