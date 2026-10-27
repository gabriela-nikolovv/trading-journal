// Calendar tab (spec section 20): Monday-first weeks, a schema switch that changes every number,
// a weekly total beside each week, and a day panel with the day's trades and a comment box.
import { h, clear, money, signClass, schemaSelect, loading, errorCard, toast, fmtDate, SCHEMA_SHORT } from '../lib.js';
import { buildCalendarMonth, assembleDayDetail } from '../engine/calendar.js';
import { resolvePctForMonth } from '../engine/pnlSchemas.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // never Sunday-first

export async function render(container, ctx) {
  const { api, state } = ctx;
  const now = new Date();
  state.cal ??= { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, selected: null };
  const { year, month } = state.cal;
  const mm = String(month).padStart(2, '0');
  const first = `${year}-${mm}-01`;
  const last = `${year}-${mm}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;

  clear(container).append(loading('Loading calendar…'));
  let snapshots, comments;
  try {
    [snapshots, comments] = await Promise.all([api.getSnapshots(), api.getDailyComments(addMonths(first, -1), addMonths(last, 1))]);
  } catch (e) { clear(container).append(errorCard('The calendar could not be loaded.', e)); return; }

  const schema = state.schema;
  let cal;
  try {
    cal = buildCalendarMonth({ year, month, schema, dailyData: snapshots, comments, profitSharePct: schema === 'schema2' ? resolvePctForMonth(state.schedule, first) : undefined });
  } catch (e) { clear(container).append(errorCard('Schema 2 needs a profit-share percentage. Set it in Settings.', e)); return; }

  const go = (dm) => { const d = new Date(Date.UTC(year, month - 1 + dm, 1)); state.cal = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, selected: null }; render(container, ctx); };

  const grid = h('div', { class: 'cal-grid' }, HEADS.map((d) => h('div', { class: 'cal-head' }, d)), h('div', { class: 'cal-head week' }, 'Week'));
  for (const week of cal.weeks) {
    for (const d of week.days) {
      grid.append(h('div', {
        class: `cal-cell ${d.inCurrentMonth ? '' : 'other'} ${d.delta > 0 ? 'up' : d.delta < 0 ? 'down' : ''} ${state.cal.selected === d.date ? 'selected' : ''}`,
        'data-date': d.date, tabindex: '0', role: 'button',
        onclick: () => { state.cal.selected = d.date; render(container, ctx); },
      }, h('div', { class: 'd' }, h('span', {}, String(Number(d.date.slice(8)))), d.comment ? h('span', { title: d.comment }, '💬') : null),
        h('div', { class: `v ${signClass(d.delta)}` }, d.delta === null ? '' : money(d.delta))));
    }
    grid.append(h('div', { class: `cal-week ${signClass(week.weeklyTotal)}`, title: `Weekly result · ${SCHEMA_SHORT[schema]}` }, week.weeklyTotal === null ? '—' : money(week.weeklyTotal)));
  }

  const root = h('div', {},
    h('div', { class: 'row between' }, h('h1', {}, 'Calendar'),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'P&L view:'), schemaSelect(schema, (v) => ctx.setSchema(v)))),
    h('div', { class: 'card' },
      h('div', { class: 'row between', style: 'margin-bottom:.6rem' },
        h('div', { class: 'row' }, h('button', { class: 'btn', 'aria-label': 'Previous month', onclick: () => go(-1) }, '◀'), h('h2', { style: 'margin:0' }, `${MONTHS[month - 1]} ${year}`), h('button', { class: 'btn', 'aria-label': 'Next month', onclick: () => go(1) }, '▶')),
        h('button', { class: 'btn', onclick: () => { state.cal = null; render(container, ctx); } }, 'Today')),
      schema === 'schema2' ? h('div', { class: 'notice' }, 'Schema 2: the month’s profit share is deducted once, on the last trading day of the month; other days show their pre-share result.') : null,
      grid));
  clear(container).append(root);
  if (state.cal.selected) root.append(await dayPanel(state.cal.selected, ctx, cal, comments, () => render(container, ctx)));
}

async function dayPanel(date, ctx, cal, comments, rerender) {
  const { api, state } = ctx;
  const cell = cal.weeks.flatMap((w) => w.days).find((d) => d.date === date);
  let trades = [];
  try { trades = await api.getTradesTouchingDay(date); } catch (e) { console.error(e); }
  const detail = assembleDayDetail({
    date, schema: state.schema, dailyDelta: cell?.delta ?? null, comment: comments.find((c) => c.date === date)?.comment ?? null,
    trades: trades.map((t) => ({ symbol: t.symbol, direction: t.direction, quantity: t.quantityTraded / (t.status === 'closed' ? 2 : 1), realizedPnl: t.closedAt && t.closedAt.toISOString().slice(0, 10) === date ? t.realizedPnl : null, isClosed: !!t.closedAt && t.closedAt.toISOString().slice(0, 10) === date })),
  });
  const box = h('textarea', { id: 'day-comment', placeholder: 'What happened today? This is suggested automatically when you build the weekly report.' }, detail.comment ?? '');
  return h('div', { class: 'card', id: 'day-panel' },
    h('div', { class: 'row between' }, h('h2', {}, fmtDate(date)), h('div', {}, `${SCHEMA_SHORT[state.schema]}: `, h('b', { class: signClass(detail.dailyDelta) }, detail.dailyDelta === null ? 'no trading data' : money(detail.dailyDelta)))),
    detail.trades.length
      ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Symbol', 'Direction', 'Shares', 'Result (gross)'].map((t, i) => h('th', { class: i > 1 ? 'num' : '' }, t)))),
        h('tbody', {}, detail.trades.map((t) => h('tr', {}, h('td', {}, h('b', {}, t.symbol)), h('td', {}, h('span', { class: `badge ${t.direction}` }, t.direction.toUpperCase()), t.isClosed ? ' closed' : ' opened'),
          h('td', { class: 'num' }, Math.round(t.quantity)), h('td', { class: `num ${signClass(t.realizedPnl)}` }, t.realizedPnl === null ? '—' : money(t.realizedPnl)))))))
      : h('div', { class: 'muted' }, 'No trades opened or closed on this day.'),
    h('label', { class: 'field' }, 'Comment for this day', box),
    h('button', { class: 'btn primary', onclick: async () => {
      try { await api.saveDailyComment(state.account.id, state.userId, date, box.value); toast('Comment saved.'); rerender(); } catch (e) { toast('Could not save the comment.', 'error'); console.error(e); }
    } }, 'Save comment'));
}

function addMonths(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
