import { h, clear, money, pct, signed, signClass, schemaSelect, segmented, SCHEMA_SHORT, loading, errorCard, fmtDate } from '../lib.js';
import { dailySeries, cumulative } from '../engine/schemaSeries.js';
import { computeStatistics } from '../engine/statistics.js';
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
  const root = h('div', {});
  root.append(
    h('div', { class: 'row between' },
      h('h1', {}, 'Dashboard'),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'P&L view:'), schemaSelect(schema, (v) => ctx.setSchema(v)))),
    h('div', { class: 'notice' }, h('b', {}, `${SCHEMA_SHORT[schema]} `), schema === 'schema1' ? 'includes trading result, commissions, market-data, platform and all other fees — what PropReports shows as Total.'
      : schema === 'schema2' ? 'is Schema 1 after the monthly profit share (charged once per month, only when that month is positive).'
      : 'is pure trading performance before every cost and before profit share.'),
    h('div', { class: 'grid cards4' },
      kpi('Account value', money(accountValue, { dollar: true }), st?.account_cash != null ? `PropReports cash ${money(Number(st.account_cash))} · unrealized ${money(Number(st.account_unrealized ?? 0))}` : 'from synced daily results'),
      kpi('Buying power', h('span', { class: 'muted' }, 'n/a'), 'PropReports’ API does not provide buying power'),
      kpi('Open exposure', exposureHolder, h('span', {}, 'open positions: ', openHolder)),
      kpi(`Total P&L · ${SCHEMA_SHORT[schema]}`, signed(totalPnl, { dollar: true }), `${series.length} trading days`),
      kpi(`This month · ${SCHEMA_SHORT[schema]}`, signed(monthPnl, { dollar: true }), thisMonth),
      kpi(`Closed trades P&L`, signed(stats.total, { dollar: true }), `${basis === 'schema3' ? 'Schema 3 (before costs)' : 'Schema 1 (net of costs)'} · ${stats.trades} trades`),
      kpi('Unrealized P&L', st?.account_unrealized != null ? signed(Number(st.account_unrealized), { dollar: true }) : h('span', { class: 'muted' }, '—'), 'as reported by PropReports'),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, 'Performance'),
        segmented([['cumulative', `Cumulative P&L (${SCHEMA_SHORT[schema]})`], ['equity', 'Account value']], metric, (v) => { state.chartMetric = v; render(container, ctx); })),
      chartPoints.length ? lineChart(chartPoints, { format: (v) => Math.round(v).toLocaleString('en-US') }) : h('div', { class: 'empty' }, 'No trading days synced yet — press Sync Now.')),
    h('div', { class: 'card' },
      h('h2', {}, `Trade statistics — ${basis === 'schema3' ? 'Schema 3 (pure trading)' : 'Schema 1 (net of costs)'}`),
      schema === 'schema2' ? h('div', { class: 'notice warn' }, 'Per-trade statistics cannot use Schema 2, because profit share is a monthly lump sum. They are shown on Schema 1 here.') : null,
      statsTable(stats)),
    stats.trades ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(340px,1fr))' },
      breakdown('By day of week', stats.byDayOfWeek), breakdown('By month', stats.byMonth), breakdown('Long vs short', stats.longVsShort),
      breakdown('By sector', stats.bySector), breakdown('By symbol (top 10)', stats.bySymbol.slice(0, 10))) : null,
  );
  clear(container).append(root);
}

function statsTable(s) {
  const rows = [
    ['Completed trades', s.trades], ['Win rate', pct(s.winRate)], ['Loss rate', pct(s.lossRate)],
    ['Average winner', money(s.avgWinner)], ['Average loser', money(s.avgLoser)], ['Largest winner', money(s.largestWinner)], ['Largest loser', money(s.largestLoser)],
    ['Profit factor', s.profitFactor ?? '—'], ['Expectancy / trade', money(s.expectancy)], ['Average R', s.avgR === null ? '— (needs stop losses)' : `${s.avgR}R (${s.tradesWithR} trades)`],
    ['Max consecutive wins', s.maxConsecutiveWins], ['Max consecutive losses', s.maxConsecutiveLosses], ['Average hold time', s.avgHoldLabel ?? '—'],
  ];
  return h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(230px,1fr))' },
    rows.map(([k, v]) => h('div', { class: 'row between', style: 'border-bottom:1px solid #f0f1f4;padding:.3rem 0' }, h('span', { class: 'muted' }, k), h('b', {}, String(v)))));
}

function breakdown(title, rows) {
  return h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, 'Trades'), h('th', { class: 'num' }, 'Win %'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Avg'))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.key), h('td', { class: 'num' }, r.trades), h('td', { class: 'num' }, pct(r.winRate, 0)),
      h('td', { class: `num ${signClass(r.total)}` }, money(r.total)), h('td', { class: `num ${signClass(r.average)}` }, money(r.average))))))));
}
