// Current Positions (spec sections 10, 11, 24, 25): open positions on the LEFT, a square Exposure
// card on the RIGHT, and large Edit / Close buttons on every row.
import { h, clear, money, pct, signed, signClass, loading, errorCard, toast, openModal, segmented, fmtDateTime } from '../lib.js';
import { industriesForSector } from '../engine/taxonomy.js';

export async function render(container, ctx) {
  const { api, state } = ctx;
  clear(container).append(loading('Loading current positions and prices…'));
  let data;
  try {
    data = await api.getPositions();
    const pending = (data.symbolsAwaitingClassification ?? []).filter((s) => !state.classifyTried.has(s));
    if (pending.length) {
      pending.forEach((s) => state.classifyTried.add(s));
      try { await api.classify(pending); data = await api.getPositions(); } catch { /* classification is optional; positions still show */ }
    }
    state.taxonomy ??= { sectors: await api.getSectors(), industries: await api.getIndustries() };
  } catch (e) {
    clear(container).append(errorCard(e.message || 'Current positions could not be loaded.', e), h('button', { class: 'btn primary', onclick: () => render(container, ctx) }, 'Try again'));
    return;
  }

  const { positions, summary } = data;
  const exposureTab = state.exposureTab ?? 'symbol';
  const refresh = () => render(container, ctx);

  const left = h('div', { class: 'card positions-main' },
    h('div', { class: 'row between' },
      h('h2', {}, `Open positions (${positions.length})`),
      h('button', { class: 'btn', onclick: refresh }, '↻ Refresh prices')),
    positions.length === 0
      ? h('div', { class: 'empty' }, 'No open positions. Positions appear here automatically when PropReports shows an open quantity.')
      : h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          ['Symbol', 'Qty', 'Avg entry', 'Price', 'Value', 'Unrealized P&L', 'P&L %', 'Stop loss', 'Current R', 'Risk to stop', 'Sector / Industry']
            .map((t, i) => h('th', { class: i >= 1 && i <= 9 ? 'num' : '' }, t)), h('th', { class: 'sticky-right' }, 'Actions'))),
        h('tbody', {}, positions.map((p) => row(p, ctx, refresh))))));

  const right = h('div', { class: 'card exposure-card' },
    h('h2', {}, 'Exposure'),
    h('div', { class: 'kpi' }, h('div', { class: 'value' }, money(summary.totalExposure, { dollar: true })), h('div', { class: 'sub' }, 'total · priced positions only')),
    h('div', { class: 'row between' }, h('span', {}, 'Long ', h('b', { class: 'pos' }, money(summary.longExposure))), h('span', {}, 'Short ', h('b', { class: 'neg' }, money(summary.shortExposure))), h('span', {}, 'Net ', h('b', {}, money(summary.netExposure)))),
    h('div', { style: 'margin:.6rem 0' }, segmented([['symbol', 'Symbol'], ['sector', 'Sector'], ['industry', 'Industry']], exposureTab, (v) => { state.exposureTab = v; refresh(); })),
    h('div', {}, (exposureTab === 'symbol' ? summary.bySymbol : exposureTab === 'sector' ? summary.bySector : summary.byIndustry).slice(0, 8).map((g) =>
      h('div', { style: 'margin:.35rem 0' }, h('div', { class: 'row between' }, h('span', {}, g.name), h('span', { class: 'muted' }, `${pct(g.pct / 100, 0)} · ${money(g.exposure)}`)), h('div', { class: 'bar' }, h('span', { style: `width:${g.pct}%` }))))),
    h('hr', { style: 'border:0;border-top:1px solid #eee;width:100%' }),
    h('div', { class: 'muted', style: 'font-size:.85rem' },
      h('div', {}, 'Risk to stops: ', h('b', {}, money(summary.totalRiskToStops, { dollar: true })), summary.riskPctOfAccount !== null ? ` (${summary.riskPctOfAccount}% of account)` : ''),
      summary.positionsMissingStop.length ? h('div', { class: 'badge stop-missing', style: 'margin-top:.3rem' }, `Stop not set: ${summary.positionsMissingStop.join(', ')}`) : null,
      summary.positionsWithInvalidStop.length ? h('div', { class: 'badge stop-invalid', style: 'margin-top:.3rem' }, `Invalid stop: ${summary.positionsWithInvalidStop.join(', ')}`) : null,
      summary.unpricedPositions ? h('div', { class: 'notice warn' }, `${summary.unpricedPositions} position(s) have no price and are not counted.`) : null));

  clear(container).append(h('h1', {}, 'Current positions'), h('div', { class: 'positions-layout' }, left, right));
}

function row(p, ctx, refresh) {
  const stopCell = p.riskStatus === 'not_set' ? h('span', { class: 'badge stop-missing' }, 'STOP NOT SET')
    : p.riskStatus === 'invalid' ? h('span', { class: 'badge stop-invalid', title: p.riskReason ?? '' }, 'INVALID STOP')
      : money(p.stopLoss);
  const r = p.currentR ?? { status: 'unavailable' };
  const rCell = r.status === 'ok' ? h('b', { class: signClass(r.value) }, `${r.value > 0 ? '+' : ''}${r.value}R`)
    : r.status === 'not_set' ? h('span', { class: 'muted' }, 'STOP NOT SET') : r.status === 'invalid' ? h('span', { class: 'neg' }, 'Invalid stop') : h('span', { class: 'muted' }, '—');
  const priceCell = p.priceStatus === 'unavailable'
    ? h('span', { class: 'badge stale', title: p.priceReason }, 'PRICE UNAVAILABLE')
    : h('div', {}, money(p.price), h('div', { class: 'muted', style: 'font-size:.7rem' }, `${p.priceSource} · ${fmtDateTime(p.priceAsOf)}${p.priceSession === 'closed' ? ' · close' : ''}`), p.priceStatus === 'stale' ? h('span', { class: 'badge stale', title: p.priceReason }, 'STALE') : null);
  return h('tr', {},
    h('td', {}, h('b', {}, p.symbol), ' ', h('span', { class: `badge ${p.direction}` }, p.direction.toUpperCase()),
      p.journalClosedAt ? h('div', {}, h('span', { class: 'badge info', title: p.journalCloseNote ?? '' }, 'Journal: close noted — awaiting PropReports')) : null),
    h('td', { class: 'num' }, p.quantity), h('td', { class: 'num' }, money(p.avgEntry)), h('td', { class: 'num' }, priceCell),
    h('td', { class: 'num' }, money(p.marketValue)), h('td', { class: 'num' }, signed(p.unrealizedPnl)), h('td', { class: `num ${signClass(p.pnlPct)}` }, p.pnlPct === null ? '—' : `${p.pnlPct}%`),
    h('td', { class: 'num' }, stopCell), h('td', { class: 'num' }, rCell), h('td', { class: 'num' }, p.riskToStop === null ? '—' : money(p.riskToStop)),
    h('td', {}, p.sector ?? h('span', { class: 'muted' }, 'Unclassified'), p.industry ? h('div', { class: 'muted', style: 'font-size:.75rem' }, p.industry) : null,
      p.classificationSource ? h('span', { class: 'badge info' }, p.classificationSource === 'user' ? 'yours' : 'TradingView') : null),
    h('td', { class: 'sticky-right' }, h('div', { class: 'pos-actions' },
      h('button', { class: 'btn primary big btn-edit', onclick: () => editDialog(p, ctx, refresh) }, 'Edit'),
      h('button', { class: 'btn big btn-close', onclick: () => closeDialog(p, ctx, refresh) }, 'Close'))));
}

function editDialog(p, ctx, refresh) {
  const { api, state } = ctx;
  const { sectors, industries } = state.taxonomy;
  const stop = h('input', { type: 'number', step: 'any', min: '0', value: p.stopLoss ?? '', placeholder: 'e.g. 4.85', id: 'stop-input' });
  const sectorSel = h('select', { id: 'sector-select' }, h('option', { value: '' }, '— use TradingView automatic —'), sectors.map((s) => h('option', { value: s.id, selected: s.id === p.sectorId }, s.name)));
  const industrySel = h('select', { id: 'industry-select' });
  const notes = h('textarea', { id: 'notes-input' }, p.notes ?? '');
  const warn = h('div', {});

  // Industry choices depend on the chosen sector (spec section 23): only that sector's industries are ever listed.
  const fillIndustries = () => {
    clear(industrySel);
    const sid = sectorSel.value;
    industrySel.disabled = !sid;
    industrySel.append(h('option', { value: '' }, sid ? '— choose industry —' : 'Choose a sector first'));
    for (const i of industries.filter((x) => x.sector_id === sid)) industrySel.append(h('option', { value: i.id, selected: i.id === p.industryId }, i.name));
  };
  sectorSel.addEventListener('change', () => { p = { ...p, industryId: null }; fillIndustries(); });
  fillIndustries();

  const validate = () => {
    clear(warn);
    const v = stop.value === '' ? null : Number(stop.value);
    if (v === null) { warn.append(h('div', { class: 'badge stop-missing' }, 'STOP NOT SET — Current R and risk will not be calculated')); return true; }
    const bad = p.direction === 'long' ? v >= p.avgEntry : v <= p.avgEntry;
    if (bad) { warn.append(h('div', { class: 'notice error' }, p.direction === 'long' ? `For a long, the stop must be BELOW the entry (${p.avgEntry}).` : `For a short, the stop must be ABOVE the entry (${p.avgEntry}).`)); return false; }
    return true;
  };
  stop.addEventListener('input', validate); validate();

  const save = h('button', { class: 'btn primary big', onclick: async () => {
    if (!validate()) return;
    try {
      await api.updatePosition(p.id, { stop_loss: stop.value === '' ? null : Number(stop.value), sector_id: sectorSel.value || null, industry_id: sectorSel.value ? industrySel.value || null : null, notes: notes.value.trim() || null });
      modal.close(); toast(`${p.symbol} saved.`); refresh();
    } catch (e) { toast('Could not save. Please try again.', 'error'); console.error(e); }
  } }, 'Save');
  const modal = openModal(`Edit ${p.symbol} (${p.direction})`, [
    h('div', { class: 'notice' }, 'These are your journal notes. They never change what PropReports reports, and a sync will never overwrite them.'),
    h('div', { class: 'muted' }, `Entry ${money(p.avgEntry)} · ${p.quantity} shares`),
    h('label', { class: 'field' }, 'Stop loss', stop), warn,
    h('label', { class: 'field' }, 'Sector', sectorSel), h('label', { class: 'field' }, 'Industry', industrySel),
    h('label', { class: 'field' }, 'Notes', notes),
    h('div', { class: 'row', style: 'margin-top:1rem' }, save, h('button', { class: 'btn big', onclick: () => modal.close() }, 'Cancel'))]);
}

function closeDialog(p, ctx, refresh) {
  const { api } = ctx;
  const note = h('textarea', { id: 'close-note' }, p.journalCloseNote ?? '');
  const modal = openModal(`Close ${p.symbol} — journal only`, [
    h('div', { class: 'notice warn' }, h('b', {}, 'This does NOT close the trade. '), 'No order is sent to Hammer Pro or the prop firm. The real position only closes when you close it in your trading platform; the journal then picks it up from PropReports on the next sync.'),
    h('p', {}, 'Use this to leave a note that you intend this position to be closed, or that you already closed it and are waiting for PropReports to show it.'),
    h('label', { class: 'field' }, 'Note (optional)', note),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary big', onclick: async () => {
        try { await api.updatePosition(p.id, { journal_close_note: note.value.trim() || 'marked closed in journal', journal_closed_at: new Date().toISOString() }); modal.close(); toast('Noted in the journal. PropReports still decides when it is really closed.'); refresh(); }
        catch (e) { toast('Could not save. Please try again.', 'error'); console.error(e); } } }, 'Note as closed in journal'),
      p.journalClosedAt ? h('button', { class: 'btn big', onclick: async () => { await api.updatePosition(p.id, { journal_close_note: null, journal_closed_at: null }); modal.close(); refresh(); } }, 'Clear the note') : null,
      h('button', { class: 'btn big', onclick: () => modal.close() }, 'Cancel'))]);
}
