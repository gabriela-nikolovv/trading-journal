// Trades tab (spec sections 21, 22): filters, paging, and a detail view where one logical trade
// is shown together with the individual fills it was built from.
import { h, clear, money, signed, signClass, loading, errorCard, toast, openModal, fmtDateTime, fmtDate } from '../lib.js';
import { tradeR, tradeResult } from '../engine/statistics.js';
import { formatHold } from '../engine/tradeStats.js';

const PAGE_SIZE = 25;

export async function render(container, ctx) {
  const { api, state } = ctx;
  state.tradeFilters ??= { status: 'closed', page: 0 };
  const f = state.tradeFilters;
  state.taxonomy ??= { sectors: await api.getSectors().catch(() => []), industries: await api.getIndustries().catch(() => []) };

  const input = (key, type = 'text', placeholder = '') => h('input', { type, value: f[key] ?? '', placeholder, onchange: (e) => { f[key] = e.target.value; f.page = 0; render(container, ctx); } });
  const select = (key, opts) => h('select', { onchange: (e) => { f[key] = e.target.value; if (key === 'sectorId') f.industryId = ''; f.page = 0; render(container, ctx); } }, opts.map(([v, l]) => h('option', { value: v, selected: (f[key] ?? '') === v }, l)));
  const industries = state.taxonomy.industries.filter((i) => i.sector_id === f.sectorId);

  const filterBar = h('div', { class: 'card' }, h('div', { class: 'row' },
    h('label', {}, 'From ', input('from', 'date')), h('label', {}, 'To ', input('to', 'date')), h('label', {}, 'Symbol ', input('symbol', 'text', 'AAPL')),
    select('direction', [['', 'Long & short'], ['long', 'Long'], ['short', 'Short']]),
    select('result', [['', 'Winners & losers'], ['win', 'Winners'], ['loss', 'Losers']]),
    select('status', [['closed', 'Closed'], ['open', 'Open'], ['all', 'Open + closed']]),
    select('sectorId', [['', 'All sectors'], ...state.taxonomy.sectors.map((s) => [s.id, s.name])]),
    f.sectorId ? select('industryId', [['', 'All industries in sector'], ...industries.map((i) => [i.id, i.name])]) : null,
    h('button', { class: 'btn', onclick: () => { state.tradeFilters = { status: 'closed', page: 0 }; render(container, ctx); } }, 'Reset')),
    h('div', { class: 'muted', style: 'font-size:.8rem;margin-top:.4rem' }, 'Results shown are Schema 3 (gross) with Schema 1 (net of fees) beside them. Profit share (Schema 2) is monthly and not split per trade.'));

  clear(container).append(h('h1', {}, 'Trades'), filterBar, loading('Loading trades…'));
  let res;
  try { res = await api.getTradesPage({ filters: f, page: f.page, pageSize: PAGE_SIZE }); }
  catch (e) { container.lastChild.replaceWith(errorCard('Trades could not be loaded.', e)); return; }

  const pages = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
  const table = res.rows.length === 0 ? h('div', { class: 'empty card' }, 'No trades match these filters.')
    : h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Symbol', 'Dir', 'Opened', 'Closed', 'Shares', 'Entry', 'Exit', 'Gross (S3)', 'Fees', 'Net (S1)', 'R', 'Sector'].map((t, i) => h('th', { class: i >= 4 && i <= 10 ? 'num' : '' }, t)))),
      h('tbody', {}, res.rows.map((t) => h('tr', { class: 'clickable', onclick: () => detail(t, ctx) },
        h('td', {}, h('b', {}, t.symbol)), h('td', {}, h('span', { class: `badge ${t.direction}` }, t.direction.toUpperCase())),
        h('td', {}, fmtDateTime(t.openedAt)), h('td', {}, t.closedAt ? fmtDateTime(t.closedAt) : h('span', { class: 'badge info' }, 'OPEN')),
        h('td', { class: 'num' }, Math.round(t.status === 'closed' ? t.quantityTraded / 2 : t.openQuantity)), h('td', { class: 'num' }, money(t.avgEntryPrice)), h('td', { class: 'num' }, t.avgExitPrice === null ? '—' : money(t.avgExitPrice)),
        h('td', { class: 'num' }, signed(t.realizedPnl)), h('td', { class: 'num' }, money(t.feesAllocated)), h('td', { class: 'num' }, signed(tradeResult(t, 'schema1'))),
        h('td', { class: 'num' }, rText(tradeR(t, 'schema3'))), h('td', {}, t.sector ?? h('span', { class: 'muted' }, '—')))))));
  const pager = h('div', { class: 'row between' }, h('span', { class: 'muted' }, `${res.total} trades · page ${f.page + 1} of ${pages}`),
    h('div', { class: 'row' }, h('button', { class: 'btn', disabled: f.page === 0, onclick: () => { f.page--; render(container, ctx); } }, '◀ Previous'), h('button', { class: 'btn', disabled: f.page + 1 >= pages, onclick: () => { f.page++; render(container, ctx); } }, 'Next ▶')));
  container.lastChild.replaceWith(h('div', {}, table, pager));
}

const rText = (r) => (r === null ? h('span', { class: 'muted' }, '—') : h('b', { class: signClass(r) }, `${r > 0 ? '+' : ''}${r}R`));

async function detail(t, ctx) {
  const closed = t.status === 'closed';
  const fillsBox = h('div', {}, loading('Loading fills…'));
  const notes = h('textarea', { id: 'trade-notes' }, t.notes ?? '');
  const modal = openModal(`${t.symbol} — ${t.direction} ${closed ? 'trade' : 'position (open)'}`, [
    h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))' },
      kv('Entry (avg)', money(t.avgEntryPrice)), kv('Exit (avg)', t.avgExitPrice === null ? '—' : money(t.avgExitPrice)),
      kv('Quantity', Math.round(closed ? t.quantityTraded / 2 : t.openQuantity)), kv('Entry time', fmtDateTime(t.openedAt)), kv('Exit time', t.closedAt ? fmtDateTime(t.closedAt) : '—'),
      kv('Duration', t.closedAt ? formatHold(t.closedAt - t.openedAt) : '—'),
      kv('Realized P&L — Schema 3 (pure trading)', signed(t.realizedPnl)), kv('Fees on this trade', money(t.feesAllocated)), kv('Total — Schema 1 (after fees)', signed(tradeResult(t, 'schema1'))),
      kv('Profit share (Schema 2)', h('span', { class: 'muted' }, 'monthly — see Calendar / Dashboard')),
      kv('Stop loss', t.stopLoss === null ? h('span', { class: 'badge stop-missing' }, 'STOP NOT SET') : money(t.stopLoss)), kv('R (realized ÷ initial risk)', rText(tradeR(t, 'schema3'))),
      kv('Sector', t.sector ?? '—'), kv('Industry', t.industry ?? '—')),
    h('label', { class: 'field' }, 'Notes', notes),
    h('button', { class: 'btn primary', onclick: async () => { try { await ctx.api.updatePosition(t.id, { notes: notes.value.trim() || null }); toast('Notes saved.'); } catch (e) { toast('Could not save notes.', 'error'); console.error(e); } } }, 'Save notes'),
    h('h3', { style: 'margin-top:1rem' }, 'Underlying executions'), fillsBox]);
  try {
    const fills = await ctx.api.getTradeFills(t.id);
    clear(fillsBox).append(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Time', 'Side', 'Qty', 'Price'].map((x, i) => h('th', { class: i > 1 ? 'num' : '' }, x)))),
      h('tbody', {}, fills.map((f) => h('tr', {}, h('td', {}, fmtDateTime(f.datetime)), h('td', {}, f.side), h('td', { class: 'num' }, f.quantity), h('td', { class: 'num' }, money(Number(f.price)))))))));
  } catch (e) { clear(fillsBox).append(errorCard('The executions could not be loaded.', e)); }
  return modal;
}
const kv = (k, v) => h('div', {}, h('div', { class: 'muted', style: 'font-size:.75rem;text-transform:uppercase' }, k), h('div', { style: 'font-weight:700' }, v));
