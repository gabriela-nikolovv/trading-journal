import { h, clear, money, pct, signed, signClass, schemaSelect, segmented, SCHEMA_SHORT, loading, errorCard } from '../lib.js';
import { dailySeries, cumulative } from '../engine/schemaSeries.js';
import { computeStatistics } from '../engine/statistics.js';
import { computeOverallStats } from '../engine/overallStats.js';
import { timeChart } from './charts.js';

const kpi = (label, valueNode, sub) => h('div', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, valueNode), sub ? h('div', { class: 'sub' }, sub) : null);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const ms = (d) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => iso(ms(d) + n * DAY);
const addMonths = (d, n) => { const x = new Date(ms(d)); x.setUTCMonth(x.getUTCMonth() + n); return iso(x.getTime()); };
const mondayOf = (d) => addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));
const fmtShort = (d) => new Date(ms(d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

export const CHART_RANGES = [['week', 'This week'], ['month', 'This month'], ['6m', '6 months'], ['1y', '1 year'], ['all', 'All time']];
export const STATS_PERIODS = [['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['all', 'All time']];

/** Window [from, to] for a range key, ending today (or covering all data). */
export function rangeWindow(key, today, firstDate) {
  if (key === 'week') { const m = mondayOf(today); return { from: m, to: addDays(m, 6) }; }
  if (key === 'month') { const f = `${today.slice(0, 7)}-01`; return { from: f, to: addDays(addMonths(f, 1), -1) }; }
  if (key === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
  if (key === '6m') return { from: addDays(addMonths(today, -6), 1), to: today };
  if (key === '1y') return { from: addDays(addMonths(today, -12), 1), to: today };
  return { from: firstDate ?? today, to: today };
}

export async function render(container, ctx) {
  const { api, state } = ctx;
  clear(container).append(loading('Loading dashboard…'));
  let snapshots, trades, status;
  try {
    [snapshots, trades, status] = await Promise.all([api.getSnapshots(), api.getClosedTrades(), api.getSyncStatus(state.account.id)]);
  } catch (e) { clear(container).append(errorCard('The dashboard could not be loaded. Your data is safe — try again in a moment.', e)); return; }

  const schema = state.schema;
  const name = SCHEMA_SHORT[schema];
  const today = new Date().toISOString().slice(0, 10);
  const series = dailySeries(snapshots, schema, state.schedule);
  const totalPnl = cumulative(series).at(-1)?.value ?? 0;
  const thisMonth = today.slice(0, 7);
  const monthPnl = series.filter((p) => p.date.startsWith(thisMonth)).reduce((a, p) => a + p.delta, 0);

  // Per-trade numbers need a per-trade result; After Share is monthly, so trades use Total then.
  const basis = schema === 'schema3' ? 'schema3' : 'schema1';
  const allStats = computeStatistics(trades, basis);
  const st = status.state;
  // PropReports' own Cash + Unrealized is the account value; the stored daily chain is the fallback.
  const reported = st?.account_cash != null ? Number(st.account_cash) + Number(st.account_unrealized ?? 0) : null;
  const accountValue = reported ?? snapshots.at(-1)?.accountValue ?? null;

  const root = h('div', {});
  root.append(
    h('div', { class: 'row between' },
      h('h1', {}, 'Dashboard'),
      h('div', { class: 'row' }, schemaSelect(schema, (v) => ctx.setSchema(v)))),
    h('div', { class: 'grid cards-kpi' },
      kpi('Account value', money(accountValue, { dollar: true }), reported !== null ? `cash ${money(Number(st.account_cash))} · unrealized ${money(Number(st.account_unrealized ?? 0))}` : null),
      kpi(`${name} P&L · all time`, signed(totalPnl, { dollar: true }), `${series.length} trading days`),
      kpi(`${name} · this month`, signed(monthPnl, { dollar: true }), null),
      kpi('Closed trades P&L', signed(allStats.total, { dollar: true }), `${allStats.trades} trades`),
      kpi('Unrealized P&L', st?.account_unrealized != null ? signed(Number(st.account_unrealized), { dollar: true }) : h('span', { class: 'muted' }, '—'), null),
    ),
    chartCard(series, state, today),
    statsBlock(trades, series, basis, snapshots, state, today, () => render(container, ctx)),
  );
  clear(container).append(root);
}

// ---------- performance chart: range buttons + drag to move through time ----------
function chartCard(series, state, today) {
  const first = series[0]?.date ?? today;
  state.chartRange ??= 'month';
  state.chartWindow ??= rangeWindow(state.chartRange, today, first);
  const holder = h('div', { class: 'chart-holder', id: 'perf-chart' });
  const label = h('div', { class: 'chart-window', id: 'chart-window' });
  const card = h('div', { class: 'card' });

  const draw = () => {
    const { from, to } = state.chartWindow;
    const pts = cumulative(series.filter((p) => p.date >= from && p.date <= to));
    const pnl = pts.at(-1)?.value ?? 0;
    clear(label).append(`${fmtShort(from)} – ${fmtShort(to)} · `, h('b', { class: signClass(pnl) }, money(pnl, { dollar: true })));
    clear(holder).append(timeChart(pts.map((p) => ({ date: p.date, value: p.value })), { from, to, format: (v) => Math.round(v).toLocaleString('en-US') }));
    if (!series.length) holder.append(h('div', { class: 'empty' }, 'No trading days synced yet — press Sync Now.'));
  };

  // Hold the mouse (or finger) on the chart and move it: the window slides through time.
  let drag = null;
  holder.addEventListener('pointerdown', (e) => {
    if (state.chartRange === 'all') return;
    drag = { x: e.clientX, from: state.chartWindow.from, to: state.chartWindow.to, w: holder.getBoundingClientRect().width || 900 };
    holder.setPointerCapture?.(e.pointerId); holder.classList.add('dragging');
  });
  holder.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const span = (ms(drag.to) - ms(drag.from)) / DAY + 1;
    let shift = Math.round(((drag.x - e.clientX) / (drag.w * 0.92)) * span);
    const latest = series.at(-1)?.date > today ? series.at(-1).date : today;
    shift = Math.min(shift, Math.max(0, (ms(latest) - ms(drag.to)) / DAY));            // not into the future
    shift = Math.max(shift, (ms(first) - ms(drag.from)) / DAY);                       // not before the first day
    const next = { from: addDays(drag.from, shift), to: addDays(drag.to, shift) };
    if (next.from !== state.chartWindow.from) { state.chartWindow = next; requestAnimationFrame(draw); }
  });
  const end = () => { drag = null; holder.classList.remove('dragging'); };
  holder.addEventListener('pointerup', end); holder.addEventListener('pointercancel', end);

  const ranges = segmented(CHART_RANGES, state.chartRange, (v) => {
    state.chartRange = v; state.chartWindow = rangeWindow(v, today, first);
    ranges.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', CHART_RANGES[i][0] === v));
    draw();
  });
  card.append(h('div', { class: 'row between' }, h('h2', {}, 'Performance'), ranges), label, holder,
    h('div', { class: 'muted small-note' }, 'Hold and drag the chart to move through time.'));
  draw();
  return card;
}

// ---------- statistics with a period choice ----------
function statsBlock(trades, series, basis, snapshots, state, today, rerender) {
  state.statsPeriod ??= 'all';
  const { from, to } = rangeWindow(state.statsPeriod, today, '0000-01-01');
  const inT = trades.filter((t) => { const d = t.closedAt.toISOString().slice(0, 10); return d >= from && d <= to; });
  const inS = series.filter((p) => p.date >= from && p.date <= to);
  const inSnaps = snapshots.filter((s) => s.date >= from && s.date <= to);
  const stats = computeStatistics(inT, basis);
  const overall = computeOverallStats(inT, basis, inS);
  const picker = segmented(STATS_PERIODS, state.statsPeriod, (v) => { state.statsPeriod = v; rerender(); });
  return h('div', {},
    overallCard(overall, inSnaps, picker),
    stats.trades ? h('div', { class: 'grid breakdowns' },
      symbolCard(overall, state, rerender),
      breakdown('By day of week', stats.byDayOfWeek), breakdown('By month', stats.byMonth), breakdown('Long vs short', stats.longVsShort)) : null);
}

function fmt(v, kind) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return h('span', { class: 'muted' }, '—');
  if (kind === 'money') return h('span', { class: signClass(v) }, money(v));
  if (kind === 'pct') return pct(v, 1);
  if (kind === 'int') return Math.round(v).toLocaleString('en-US');
  if (kind === 'num') return v.toFixed(2);
  return String(v);
}

function overallCard(o, snapshots, picker) {
  const H = o.headline;
  const head = (label, value, sub) => h('div', { class: 'headline-stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
  const feeSection = o.sections.find((s) => s.id === 'fees');
  const tradeFees = snapshots.reduce((a, s) => a + s.commissions, 0);
  const recurring = snapshots.reduce((a, s) => a + s.marketDataFees + s.platformFees + s.otherFees, 0);
  const sections = o.sections.map((s) => (s === feeSection ? { ...s, groups: [...s.groups, { title: 'All fees on the account', rows: [['Trade fees', -tradeFees, 'money'], ['Monthly fees (market data, platform, other)', -recurring, 'money'], ['Total fees', -(tradeFees + recurring), 'money']] }] } : s));

  return h('div', { class: 'card', id: 'overall-stats' },
    h('div', { class: 'row between' }, h('h2', {}, 'Overall statistics'), picker),
    H.trades === 0 ? h('div', { class: 'empty' }, 'No completed trades in this period.') : [
      h('div', { class: 'headline-grid' },
        head('Net P&L', fmt(H.netPnl, 'money'), `${H.trades} trades`),
        head('BAT (win %)', fmt(H.winRate, 'pct')),
        head('W/L ratio', fmt(H.wlRatio, 'num'), 'avg winner ÷ avg loser'),
        head('Profit factor', fmt(H.profitFactor, 'num')),
        head('Expectancy', fmt(H.expectancy, 'money'), 'per trade'),
        head('Avg hold', fmt(H.avgHold, 'text')),
        head('Max drawdown', fmt(H.maxDrawdown, 'money'), 'trade by trade')),
      h('div', { class: 'stat-sections' }, sections.map((s) => h('details', { class: 'stat-section', 'data-section': s.id },
        h('summary', {}, s.title),
        h('div', { class: 'stat-groups' }, s.groups.map((g) => h('div', { class: 'stat-group' }, h('h4', {}, g.title),
          g.rows.map(([k, v, kind]) => h('div', { class: 'stat-row' }, h('span', { class: 'muted' }, k), h('b', {}, fmt(v, kind)))))))))),
    ]);
}

function symbolCard(o, state, rerender) {
  const tab = state.symbolTab ?? 'top';
  const rows = tab === 'top' ? o.topSymbols : o.worstSymbols;
  return h('div', { class: 'card', id: 'symbol-card' },
    h('div', { class: 'row between' }, h('h3', {}, 'By symbol'), segmented([['top', 'Top 10'], ['worst', 'Worst 10']], tab, (v) => { state.symbolTab = v; rerender(); })),
    rows.length ? table(rows) : h('div', { class: 'empty' }, tab === 'worst' ? 'No losing symbols.' : 'No winning symbols yet.'));
}

function table(rows) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, 'Trades'), h('th', { class: 'num' }, 'Win %'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Avg'))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.key), h('td', { class: 'num' }, r.trades), h('td', { class: 'num' }, pct(r.winRate, 0)),
      h('td', { class: `num ${signClass(r.total)}` }, money(r.total)), h('td', { class: `num ${signClass(r.average)}` }, money(r.average)))))));
}

function breakdown(title, rows) {
  return h('div', { class: 'card' }, h('h3', {}, title), table(rows));
}
