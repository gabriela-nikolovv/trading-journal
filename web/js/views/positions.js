// Current Positions (spec sections 10, 11, 24): open positions on the LEFT, a square Exposure card on the RIGHT.
//
// Stops: every position (and every lot of a split position) has an ORIGINAL stop — the one the trade was
// planned and executed with; R multiples use it — and a CURRENT stop, which may sit past the entry once the
// trade is derisked. Typing the original stop fills the current one automatically; both stay editable.
//
// Split: PropReports keeps one net position per ticker, so two separate buys of the same symbol arrive as one
// averaged position. Split rebuilds the separate entries from the executions and lets each carry its own stops.
import { h, clear, money, pct, signed, signClass, loading, errorCard, toast, openModal, segmented, fmtDateTime, fmtDate } from '../lib.js';
import { proposeSplitByDay } from '../engine/positionLots.js';

const DAY_MS = 86400000;
export const daysHeld = (openedAt, now = Date.now()) => (openedAt ? Math.max(0, Math.floor((now - new Date(openedAt).getTime()) / DAY_MS)) : null);

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
  const HEADS = ['Symbol', 'Qty', 'Entry', 'Price', 'Unrealized P&L', 'Original stop', 'Current stop', 'Current R', 'Risk to stop', 'Days held', 'Sector / Industry'];

  const left = h('div', { class: 'card positions-main' },
    h('div', { class: 'row between' },
      h('h2', {}, `Open positions (${positions.length})`),
      h('button', { class: 'btn', onclick: refresh }, '↻ Refresh prices')),
    positions.length === 0
      ? h('div', { class: 'empty' }, 'No open positions. Positions appear here automatically when PropReports shows an open quantity.')
      : h('div', { class: 'table-wrap' }, h('table', { class: 'positions-table' },
        h('thead', {}, h('tr', {}, HEADS.map((t, i) => h('th', { class: i >= 1 && i <= 9 ? 'num' : '' }, t)), h('th', {}, ''))),
        h('tbody', {}, positions.flatMap((p) => rows(p, ctx, refresh))))));

  const groups = exposureTab === 'symbol' ? summary.bySymbol : exposureTab === 'sector' ? summary.bySector : summary.byIndustry;
  const right = h('div', { class: 'card exposure-card' },
    h('h2', {}, 'Exposure'),
    h('div', { class: 'kpi' }, h('div', { class: 'value' }, money(summary.totalExposure, { dollar: true })), h('div', { class: 'sub' }, 'total · priced positions only')),
    h('div', { class: 'row between' }, h('span', {}, 'Long ', h('b', { class: 'pos' }, money(summary.longExposure))), h('span', {}, 'Short ', h('b', { class: 'neg' }, money(summary.shortExposure))), h('span', {}, 'Net ', h('b', {}, money(summary.netExposure)))),
    h('div', { style: 'margin:.6rem 0' }, segmented([['symbol', 'Symbol'], ['sector', 'Sector'], ['industry', 'Industry']], exposureTab, (v) => { state.exposureTab = v; refresh(); })),
    h('div', {}, groups.slice(0, 8).map((g) =>
      h('div', { style: 'margin:.35rem 0' }, h('div', { class: 'row between' }, h('span', {}, g.name), h('span', { class: 'muted' }, `${pct(g.pct / 100, 0)} · ${money(g.exposure)}`)), h('div', { class: 'bar' }, h('span', { style: `width:${g.pct}%` }))))),
    h('hr', { style: 'border:0;border-top:1px solid #eee;width:100%' }),
    h('div', { class: 'muted', style: 'font-size:.85rem' },
      h('div', {}, 'Open risk to current stops: ', h('b', {}, money(summary.totalRiskToStops, { dollar: true })), summary.riskPctOfAccount !== null ? ` (${summary.riskPctOfAccount}% of account)` : ''),
      summary.lockedByStops ? h('div', {}, 'Profit locked by stops: ', h('b', { class: 'pos' }, money(summary.lockedByStops, { dollar: true }))) : null,
      summary.positionsMissingStop.length ? h('div', { class: 'badge stop-missing', style: 'margin-top:.3rem' }, `Stop not set: ${summary.positionsMissingStop.join(', ')}`) : null,
      summary.positionsWithInvalidStop.length ? h('div', { class: 'badge stop-invalid', style: 'margin-top:.3rem' }, `Check original stop: ${summary.positionsWithInvalidStop.join(', ')}`) : null,
      summary.unpricedPositions ? h('div', { class: 'notice warn' }, `${summary.unpricedPositions} position(s) have no price and are not counted.`) : null));

  clear(container).append(h('h1', {}, 'Current positions'), h('div', { class: 'positions-layout' }, left, right));
}

// ---------- table rows ----------
function stopText(v, unit) {
  if (v === null || v === undefined) return h('span', { class: 'badge stop-missing', title: 'Stop not set' }, 'NOT SET');
  return money(v);
}
function rCell(r, unit) {
  r ??= { status: 'unavailable' };
  if (r.status === 'ok') return h('b', { class: signClass(r.value) }, `${r.value > 0 ? '+' : ''}${r.value}R`);
  if (r.status === 'not_set') return h('span', { class: 'muted' }, '—');
  if (r.status === 'invalid') return h('span', { class: 'neg', title: unit.riskReason ?? '' }, 'Check stop');
  return h('span', { class: 'muted' }, '—');
}
function riskCell(u) {
  if (u.riskToStop === null || u.riskToStop === undefined) return h('span', { class: 'muted' }, '—');
  if (u.riskToStop <= 0) return h('span', { class: 'badge derisked', title: 'The current stop is at or past the entry: being stopped out from here closes at break-even or better.' }, u.riskToStop < 0 ? `+${money(-u.riskToStop)} locked` : 'B/E');
  return money(u.riskToStop);
}
// A split position: money still at risk across its lots (each lot's own row shows its detail).
function splitRiskCell(lots) {
  if (lots.some((l) => l.riskToStop === null || l.riskToStop === undefined)) return h('span', { class: 'muted' }, '—');
  const atRisk = lots.reduce((a, l) => a + Math.max(0, l.riskToStop), 0);
  return atRisk > 0 ? money(atRisk) : h('span', { class: 'badge derisked' }, 'derisked');
}
function priceCell(p) {
  if (p.priceStatus === 'unavailable') return h('span', { class: 'badge stale', title: p.priceReason }, 'NO PRICE');
  return h('div', { title: `${p.priceSource} · ${fmtDateTime(p.priceAsOf)}${p.priceSession === 'closed' ? ' · close' : ''}` }, money(p.price), p.priceStatus === 'stale' ? h('span', { class: 'badge stale', title: p.priceReason }, 'STALE') : null);
}

function rows(p, ctx, refresh) {
  const split = p.lots?.length > 0;
  const entryDays = new Set((p.entries ?? []).map((e) => e.date)).size;
  const sectorCell = h('td', { class: 'sector-cell', title: [p.sector, p.industry].filter(Boolean).join(' · ') }, p.sector ?? h('span', { class: 'muted' }, '—'), p.industry ? h('div', { class: 'muted', style: 'font-size:.75rem' }, p.industry) : null);
  const actions = h('td', { class: 'actions-cell' }, h('div', { class: 'pos-actions' },
    h('button', { class: 'btn small btn-edit', title: split ? 'Edit sector, industry and notes (stops are per lot)' : 'Edit stops, sector, industry and notes', onclick: () => editDialog({ position: p, unit: split ? null : p }, ctx, refresh) }, 'Edit'),
    (p.entries?.length ?? 0) > 1 || split
      ? h('button', { class: `btn small btn-split ${!split && entryDays > 1 ? 'hint' : ''}`, title: 'Show separate entries of this ticker as separate positions, each with its own stops', onclick: () => splitDialog(p, ctx, refresh) }, split ? 'Lots' : 'Split')
      : null));
  const main = h('tr', { class: split ? 'has-lots' : '' },
    h('td', {}, h('b', {}, p.symbol), ' ', h('span', { class: `badge ${p.direction}` }, p.direction.toUpperCase()),
      split ? h('div', { class: 'muted small-note' }, `${p.lots.length} lots`) : entryDays > 1 ? h('div', { class: 'muted small-note', title: 'Bought on different days — Split to give each entry its own stops' }, `${entryDays} separate entries`) : null),
    h('td', { class: 'num' }, p.quantity), h('td', { class: 'num' }, money(p.avgEntry)), h('td', { class: 'num' }, priceCell(p)),
    h('td', { class: 'num' }, signed(p.unrealizedPnl)),
    h('td', { class: 'num' }, split ? h('span', { class: 'muted' }, 'per lot') : stopText(p.originalStop)),
    h('td', { class: 'num' }, split ? h('span', { class: 'muted' }, 'per lot') : stopText(p.currentStop)),
    h('td', { class: 'num' }, split ? h('span', { class: 'muted' }, 'per lot') : rCell(p.currentR, p)),
    h('td', { class: 'num' }, split ? splitRiskCell(p.lots) : riskCell(p)),
    h('td', { class: 'num' }, daysHeld(p.openedAt) ?? '—'),
    sectorCell, actions);
  if (!split) return [main];
  return [main, ...p.lots.map((l) => h('tr', { class: 'lot-row' },
    h('td', {}, h('span', { class: 'lot-tag' }, l.label), h('div', { class: 'muted small-note lot-since' }, `since ${fmtDate(l.openedAt)}`)),
    h('td', { class: 'num' }, l.quantity), h('td', { class: 'num' }, money(l.avgEntry)), h('td', {}),
    h('td', { class: 'num' }, signed(l.unrealizedPnl)),
    h('td', { class: 'num' }, stopText(l.originalStop)), h('td', { class: 'num' }, stopText(l.currentStop)),
    h('td', { class: 'num' }, rCell(l.currentR, l)), h('td', { class: 'num' }, riskCell(l)),
    h('td', { class: 'num' }, daysHeld(l.openedAt) ?? '—'), h('td', {}),
    h('td', { class: 'actions-cell' }, h('div', { class: 'pos-actions' }, h('button', { class: 'btn small btn-edit-lot', onclick: () => editDialog({ position: p, unit: l, lot: l }, ctx, refresh) }, 'Edit')))))];
}

// ---------- edit ----------
/** unit = the thing whose stops are edited (the position, or one lot); null when only classification/notes are edited. */
function editDialog({ position: p, unit, lot = null }, ctx, refresh) {
  const { api, state } = ctx;
  const { sectors, industries } = state.taxonomy;
  const entry = unit?.avgEntry ?? p.avgEntry;
  const isLong = p.direction === 'long';
  const warn = h('div', {});
  let orig = null, cur = null, lastOrig = unit?.originalStop ?? null;

  if (unit) {
    orig = h('input', { type: 'number', step: 'any', min: '0', value: unit.originalStop ?? '', placeholder: 'the stop you entered with', id: 'orig-stop-input' });
    cur = h('input', { type: 'number', step: 'any', min: '0', value: unit.currentStop ?? '', placeholder: 'where the stop is now', id: 'cur-stop-input' });
    // Typing the original stop fills the current one, until the current stop has been moved on its own.
    orig.addEventListener('input', () => {
      if (cur.value === '' || (lastOrig !== null && Number(cur.value) === lastOrig)) cur.value = orig.value;
      lastOrig = orig.value === '' ? null : Number(orig.value);
      validate();
    });
    cur.addEventListener('input', () => validate());
  }
  const validate = () => {
    if (!unit) return true;
    clear(warn);
    const o = orig.value === '' ? null : Number(orig.value);
    const c = cur.value === '' ? null : Number(cur.value);
    let ok = true;
    if (o === null) warn.append(h('div', { class: 'badge stop-missing' }, 'Original stop not set — R cannot be calculated'));
    else if (isLong ? o >= entry : o <= entry) {
      warn.append(h('div', { class: 'notice error' }, `The ORIGINAL stop is the stop you entered the trade with, so for a ${p.direction} it must be ${isLong ? 'BELOW' : 'ABOVE'} the entry (${entry}). A stop moved past the entry goes in "Current stop".`));
      ok = false;
    }
    if (c !== null && (isLong ? c >= entry : c <= entry)) warn.append(h('div', { class: 'notice' }, `Current stop is past the entry — this ${lot ? 'lot' : 'position'} counts as derisked; being stopped out closes ${c === entry ? 'at break-even' : 'with a profit'}.`));
    return ok;
  };

  let sectorSel = null, industrySel = null, notes = null;
  if (!lot) {
    sectorSel = h('select', { id: 'sector-select' }, h('option', { value: '' }, '— use TradingView automatic —'), sectors.map((s) => h('option', { value: s.id, selected: s.id === p.sectorId }, s.name)));
    industrySel = h('select', { id: 'industry-select' });
    notes = h('textarea', { id: 'notes-input' }, p.notes ?? '');
    // Industry choices depend on the chosen sector (spec section 23): only that sector's industries are ever listed.
    let keepIndustry = p.industryId;
    const fillIndustries = () => {
      clear(industrySel);
      const sid = sectorSel.value;
      industrySel.disabled = !sid;
      industrySel.append(h('option', { value: '' }, sid ? '— choose industry —' : 'Choose a sector first'));
      for (const i of industries.filter((x) => x.sector_id === sid)) industrySel.append(h('option', { value: i.id, selected: i.id === keepIndustry }, i.name));
    };
    sectorSel.addEventListener('change', () => { keepIndustry = null; fillIndustries(); });
    fillIndustries();
  } else {
    notes = h('textarea', { id: 'notes-input' }, lot.notes ?? '');
  }
  validate();

  const num = (inp) => (inp.value === '' ? null : Number(inp.value));
  const save = h('button', { class: 'btn primary big', id: 'save-edit', onclick: async () => {
    if (!validate()) return;
    try {
      if (lot && lot.lotId) await api.updateLot(lot.lotId, { original_stop: num(orig), current_stop: num(cur), notes: notes.value.trim() || null });
      else {
        const patch = {};
        if (unit) Object.assign(patch, { stop_loss: num(orig), current_stop: num(cur) });
        if (!lot) Object.assign(patch, { sector_id: sectorSel.value || null, industry_id: sectorSel.value ? industrySel.value || null : null, notes: notes.value.trim() || null });
        await api.updatePosition(p.id, patch);
      }
      modal.close(); toast(`${p.symbol} saved.`); refresh();
    } catch (e) { toast('Could not save. Please try again.', 'error'); console.error(e); }
  } }, 'Save');

  const title = lot ? `${p.symbol} · ${lot.label}` : `Edit ${p.symbol} (${p.direction})`;
  const modal = openModal(title, [
    h('div', { class: 'muted' }, `Entry ${money(entry)} · ${unit?.quantity ?? p.quantity} shares`),
    unit ? h('div', { class: 'stop-pair' },
      h('label', { class: 'field' }, 'Original stop', h('span', { class: 'hint-text' }, 'planned at entry — used for R'), orig),
      h('label', { class: 'field' }, 'Current stop', h('span', { class: 'hint-text' }, 'where it is now — can be past the entry'), cur)) : h('div', { class: 'notice' }, 'This position is split into lots — set the stops on each lot row.'),
    warn,
    sectorSel ? h('label', { class: 'field' }, 'Sector', sectorSel) : null, industrySel ? h('label', { class: 'field' }, 'Industry', industrySel) : null,
    h('label', { class: 'field' }, 'Notes', notes),
    h('div', { class: 'row', style: 'margin-top:1rem' }, save, h('button', { class: 'btn big', onclick: () => modal.close() }, 'Cancel'))]);
}

// ---------- split ----------
function splitDialog(p, ctx, refresh) {
  const { api, state } = ctx;
  const entries = p.entries ?? [];
  const existing = p.lots ?? [];
  // Start from the saved split, else one lot per entry day (or one per execution when all were the same day).
  let assign;
  if (existing.length) assign = entries.map((e) => ({ key: e.key, lot: Math.max(0, existing.findIndex((l) => l.entryKeys?.includes(e.key))) }));
  else {
    assign = proposeSplitByDay(entries);
    if (new Set(assign.map((a) => a.lot)).size < 2) assign = entries.map((e, i) => ({ key: e.key, lot: Math.min(i, 1) }));
  }
  let lotCount = Math.max(2, ...assign.map((a) => a.lot + 1));
  const body = h('div', {});
  const draw = () => {
    clear(body).append(
      h('div', { class: 'row', style: 'margin:.5rem 0' }, h('span', {}, 'Number of lots'),
        h('select', { id: 'lot-count', onchange: (e) => { lotCount = Number(e.target.value); assign.forEach((a) => { if (a.lot >= lotCount) a.lot = lotCount - 1; }); draw(); } },
          [2, 3, 4, 5, 6].filter((n) => n <= Math.max(2, entries.length)).map((n) => h('option', { value: n, selected: n === lotCount }, String(n))))),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Entry time', 'Shares still open', 'Price', 'Lot'].map((t, i) => h('th', { class: i === 1 || i === 2 ? 'num' : '' }, t)))),
        h('tbody', {}, entries.map((e, i) => h('tr', {},
          h('td', {}, fmtDateTime(e.datetime)), h('td', { class: 'num' }, e.remaining === e.quantity ? e.remaining : `${e.remaining} of ${e.quantity}`), h('td', { class: 'num' }, money(e.price)),
          h('td', {}, h('select', { class: 'lot-select', 'data-key': e.key, onchange: (ev) => { assign[i].lot = Number(ev.target.value); } },
            Array.from({ length: lotCount }, (_, n) => h('option', { value: n, selected: assign[i].lot === n }, `Lot ${n + 1}`))))))))));
  };
  draw();

  const save = h('button', { class: 'btn primary big', id: 'save-split', onclick: async () => {
    const lots = Array.from({ length: lotCount }, (_, n) => assign.filter((a) => a.lot === n).map((a) => a.key)).filter((keys) => keys.length);
    if (lots.length < 2) { toast('Put the entries into at least two lots, or use “Keep as one position”.', 'error'); return; }
    // Each new lot keeps the stops of the saved lot (or the position) its first entry came from.
    const stopsFor = (keys) => existing.find((l) => keys.some((k) => l.entryKeys?.includes(k))) ?? { originalStop: p.originalStop, currentStop: p.currentStop };
    try {
      await api.saveLots(p.id, state.userId, lots.map((keys, n) => { const s = stopsFor(keys); return { label: `Lot ${n + 1}`, entry_keys: keys, original_stop: s.originalStop ?? null, current_stop: s.currentStop ?? null }; }));
      modal.close(); toast(`${p.symbol} split into ${lots.length} lots.`); refresh();
    } catch (e) { toast('Could not save the split.', 'error'); console.error(e); }
  } }, 'Save split');
  const merge = existing.length ? h('button', { class: 'btn big', id: 'merge-lots', onclick: async () => {
    try { await api.saveLots(p.id, state.userId, []); modal.close(); toast(`${p.symbol} is one position again.`); refresh(); } catch (e) { toast('Could not save.', 'error'); console.error(e); }
  } }, 'Keep as one position') : null;

  const modal = openModal(`Split ${p.symbol} into lots`, [
    h('p', { class: 'muted' }, 'PropReports reports one position per ticker, so separate buys of the same symbol are averaged together. Every entry execution that is still open is listed here — group them into lots and each lot gets its own original and current stop. Shares sold are taken from the oldest entry first (FIFO), the way PropReports closes them.'),
    body,
    h('div', { class: 'row', style: 'margin-top:1rem' }, save, merge, h('button', { class: 'btn big', onclick: () => modal.close() }, 'Cancel'))]);
}
