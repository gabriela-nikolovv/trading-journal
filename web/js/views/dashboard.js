import { h, clear, money, pct, signed, signClass, schemaSelect, segmented, SCHEMA_SHORT, loading, errorCard, fmtDate } from '../lib.js';
import { dailySeries, cumulative } from '../engine/schemaSeries.js';
import { computeStatistics } from '../engine/statistics.js';
import { computeOverallStats } from '../engine/overallStats.js';
import { lineChart } from './charts.js';

const kpi = (label, valueNode, sub) => h('div', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, valueNode), sub ? h('div', { class: 'sub' }, sub) : null);

export async function render(container, ctx) {
  const { api, state } = ctx;
  clear(container).append(loading('Loading dashboard…'));
  let snapshots, trades, status;
  try {
    [snapshots, trades, status] = await Promise.all([api.getSnapshots(), api.getClosedTrades(), api.getSyncStatus(state.account.id)]);
  } catch (e) { clear(container).append(errorCard('The dashboard could not be loaded. Your data is safe — try again in a moment.', e)); return; }

  const schema = state.schema;
  const metric = state.chartMetric ?? 'cumulative';
  const series = dailySeries(snapshots, schema, state.schedule);
  const cum = cumulative(series);
  const totalPnl = cum.at(-1)?.value ?? 0;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthPnl = series.filter((p) => p.date.startsWith(thisMonth)).reduce((a, p) => a + p.delta, 0);

  // Trade statistics need a per-trade result, which Schema 2 (monthly lump sum) cannot give.
  const basis = schema === 'schema3' ? 'schema3' : 'schema1';
  const stats = computeStatistics(trades, basis);
  const overall = computeOverallStats(trades, basis, series);
  const accountValue = snapshots.at(-1)?.accountValue ?? null;
  const chartPoints = metric === 'cumulative'
    ? cum.map((p) => ({ label: fmtDate(p.date), value: p.value }))
    : snapshots.map((s) => ({ label: fmtDate(s.date), value: s.accountValue }));

  const exposureHolder = h('span', {}, '…');
  const openHolder = h('span', {}, '…');
  api.getPositions().then((r) => {
    clear(exposureHolder).append(money(r.summary.totalExposure, { dollar: true }));
    clear(openHolder).append(String(r.positions.length));
  }).catch(() => { clear(exposureHolder).append('Unavailable'); api.countOpenPositions().then((n) => clear(openHolder).append(String(n))).catch(() => {}); });

  const st = status.state;
  const basisLabel = basis === 'schema3' ? 'Schema 3 (pure trading)' : 'Schema 1 (net of fees)';
  const root = h('div', {});
  root.append(
    h('div', { class: 'row between' },
      h('h1', {}, 'Dashboard'),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'P&L view:'), schemaSelect(schema, (v) => ctx.setSchema(v)))),
    h('div', { class: 'notice' }, h('b', {}, `${SCHEMA_SHORT[schema]} `), schema === 'schema1' ? 'is PropReports’ Total Δ: trading result minus every fee (trade fees, market data, platform …), each counted once.'
      : schema === 'schema2' ? 'is Schema 1 after the monthly profit share (charged once per month, only when that month is positive).'
      : 'is pure trading performance before every cost and before profit share.'),
    h('div', { class: 'grid cards-kpi' },
      kpi('Account value', money(accountValue, { dollar: true }), st?.account_cash != null ? `PropReports cash ${money(Number(st.account_cash))} · unrealized ${money(Number(st.account_unrealized ?? 0))}` : 'from synced daily results'),
      kpi('Open exposure', exposureHolder, h('span', {}, 'open positions: ', openHolder)),
      kpi(`Total P&L · ${SCHEMA_SHORT[schema]}`, signed(totalPnl, { dollar: true }), `${series.length} trading days`),
      kpi(`This month · ${SCHEMA_SHORT[schema]}`, signed(monthPnl, { dollar: true }), thisMonth),
      kpi('Closed trades P&L', signed(stats.total, { dollar: true }), `${basis === 'schema3' ? 'Schema 3 (before costs)' : 'Schema 1 (net of costs)'} · ${stats.trades} trades`),
      kpi('Unrealized P&L', st?.account_unrealized != null ? signed(Number(st.account_unrealized), { dollar: true }) : h('span', { class: 'muted' }, '—'), 'as reported by PropReports'),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, 'Performance'),
        segmented([['cumulative', `Cumulative P&L (${SCHEMA_SHORT[schema]})`], ['equity', 'Account value']], metric, (v) => { state.chartMetric = v; render(container, ctx); })),
      chartPoints.length ? lineChart(chartPoints, { format: (v) => Math.round(v).toLocaleString('en-US') }) : h('div', { class: 'empty' }, 'No trading days synced yet — press Sync Now.')),
    overallCard(overall, basisLabel, schema, snapshots),
    stats.trades ? h('div', { class: 'grid breakdowns' },
      symbolCard(overall, state, () => render(container, ctx)),
      breakdown('By day of week', stats.byDayOfWeek), breakdown('By month', stats.byMonth), breakdown('Long vs short', stats.longVsShort)) : null,
  );
  clear(container).append(root);
}

// ---------- overall statistics: headline on top, sections to open ----------
function fmt(v, kind) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return h('span', { class: 'muted' }, '—');
  if (kind === 'money') return h('span', { class: signClass(v) }, money(v));
  if (kind === 'pct') return pct(v, 1);
  if (kind === 'int') return Math.round(v).toLocaleString('en-US');
  if (kind === 'num') return v.toFixed(2);
  return String(v);
}

function overallCard(o, basisLabel, schema, snapshots) {
  const H = o.headline;
  const head = (label, value, sub) => h('div', { class: 'headline-stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
  // Account-level fees (from PropReports' daily data) sit next to the per-trade fees.
  const feeSection = o.sections.find((s) => s.id === 'fees');
  const tradeFees = snapshots.reduce((a, s) => a + s.commissions, 0);
  const recurring = snapshots.reduce((a, s) => a + s.marketDataFees + s.platformFees + s.otherFees, 0);
  const sections = o.sections.map((s) => (s === feeSection ? { ...s, groups: [...s.groups, { title: 'All fees on the account (PropReports daily data)', rows: [['Trade fees', -tradeFees, 'money'], ['Monthly fees (market data, platform, other)', -recurring, 'money'], ['Total fees', -(tradeFees + recurring), 'money']] }] } : s));

  return h('div', { class: 'card', id: 'overall-stats' },
    h('div', { class: 'row between' }, h('h2', {}, 'Overall statistics'), h('span', { class: 'muted' }, `per trade: ${basisLabel}`)),
    schema === 'schema2' ? h('div', { class: 'notice warn' }, 'Per-trade statistics cannot use Schema 2, because profit share is a monthly lump sum. They are shown on Schema 1 here.') : null,
    o.headline.trades === 0 ? h('div', { class: 'empty' }, 'No completed trades yet.') : [
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
