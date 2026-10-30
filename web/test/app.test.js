import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeFakeApi, makePdf, tick, waitFor } from './harness.js';

installDom();
const { startApp, TABS } = await import('../js/app.js');

async function boot(apiOver = {}, { tab = 'dashboard', autoSync = false, before } = {}) {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  location.hash = `#/${tab}`;
  const api = makeFakeApi(apiOver);
  const pdf = makePdf();
  const app = startApp({ api, root: document.getElementById('app'), pdf, autoSync });
  before?.(app.ctx);
  await app.boot();
  await tick(60);
  return { api, pdf, ctx: app.ctx, $: (s) => document.querySelector(s), $$: (s) => [...document.querySelectorAll(s)] };
}
const text = (el) => el?.textContent.replace(/\s+/g, ' ').trim();

test('signed out → real login form that password managers can fill (username/current-password), no sign-up link', async () => {
  const { $ } = await boot({ getSession: async () => null });
  assert.equal($('#email').getAttribute('autocomplete'), 'username');
  assert.equal($('#password').getAttribute('autocomplete'), 'current-password');
  assert.equal($('#password').type, 'password');
  assert.ok(!/sign up|register/i.test(document.body.textContent));
});

test('signed in but no PropReports account yet → first-time setup screen with one connect button (no token field)', async () => {
  const { $ } = await boot({ getAccount: async () => null });
  assert.ok($('#connect-btn'));
  assert.equal(document.querySelectorAll('input').length, 0, 'the token must never be typed into the browser');
  assert.match(text(document.body), /never typed into or sent to this page/);
});

test('shell: six tabs with Weekly Report before Trades; SYNC NOW with the last-sync line under it; no counts, warnings or "null"', async () => {
  const { $, $$ } = await boot();
  assert.deepEqual($$('.tab').map((b) => b.textContent), ['Dashboard', 'Current Positions', 'Calendar', 'Weekly Report', 'Trades', 'Settings']);
  assert.equal($('#sync-now').textContent, 'SYNC NOW');
  assert.match(text($('#sync-status')), /^Synced /);
  assert.equal($('#sync-now').nextElementSibling, $('#sync-status'), 'status sits under the button');
  const bar = text($('#syncbar'));
  assert.ok(!/warning|new ·|updated|null/i.test(bar), bar);
});

test('the Trading Journal logo opens the pink intro page', async () => {
  const { $ } = await boot();
  $('#brand').click();
  await waitFor(() => $('#intro'));
  assert.match(text($('#intro')), /Hi Gabriela/);
  assert.equal(document.querySelectorAll('.tab.active').length, 0);
});

test('the site syncs automatically when opened, and SYNC NOW syncs again', async () => {
  const { api, $ } = await boot({}, { autoSync: true });
  await waitFor(() => api.calls.runSync === 1);
  $('#sync-now').click();
  await waitFor(() => api.calls.runSync === 2);
});

test('failed sync: a friendly message, never a stack trace, and the last good data stays on screen', async () => {
  const { $ } = await boot({ runSync: async () => { throw new Error('PropReports is temporarily unavailable.'); } });
  $('#sync-now').click();
  const toast = await waitFor(() => document.querySelector('.toast.error'));
  assert.match(toast.textContent, /PropReports is temporarily unavailable\. Your previous data is still available\./);
  assert.ok(!/at .*\.js:\d+/.test(document.body.textContent));
  await tick(80);
  assert.ok(document.querySelector('.kpi'), 'dashboard still rendered');
});

test('Dashboard: schema switch changes the numbers and labels; schemas are never mixed', async () => {
  const { $, $$ } = await boot();
  const kpis = () => Object.fromEntries($$('.kpi').map((k) => [text(k.querySelector('.label')), text(k.querySelector('.value'))]));
  assert.equal(kpis()['Account value'], '($646.46)');
  const s1 = kpis()['Total P&L · Schema 1'];
  assert.equal(s1, '($9.39)');                       // 41.56 trading − 50.95 monthly fees
  const sel = $('select[aria-label="P&L schema"]');
  sel.value = 'schema3'; sel.dispatchEvent(new window.Event('change'));
  await tick(80);
  assert.equal(kpis()['Total P&L · Schema 3'], '$41.56'); // pure trading, no fees
  assert.ok(!('Total P&L · Schema 1' in kpis()));
  assert.ok($('svg.chart polyline'), 'chart drawn');
  assert.ok($('svg.chart line[stroke-dasharray]'), 'zero line drawn so negatives are visible');
});

test('Dashboard: no buying power card; KPI cards share one grid; overall stats headline + closed sections; Worst 10 tab', async () => {
  const { $, $$ } = await boot();
  assert.ok(!$$('.kpi').some((k) => /Buying power/.test(k.textContent)));
  assert.equal($$('.cards-kpi > .kpi').length, 6);
  assert.ok(!/Average R|needs stop losses|By sector|Unclassified/.test(text($('#view'))));
  const ov = $('#overall-stats');
  assert.match(text(ov), /Net P&L/); assert.match(text(ov), /BAT/); assert.match(text(ov), /W\/L ratio/);
  assert.deepEqual($$('#overall-stats details summary').map(text), ['P&L', 'Scores & totals', 'Volume', 'Symbols', 'Trade duration', 'Fees']);
  assert.ok($$('#overall-stats details').every((d) => !d.open), 'deeper sections start closed');
  assert.match(text($('#symbol-card')), /WIN/);
  [...$('#symbol-card').querySelectorAll('.segmented button')].find((b) => b.textContent === 'Worst 10').click();
  await waitFor(() => $('#symbol-card tbody') && /LOSS/.test(text($('#symbol-card tbody'))) && !/WIN/.test(text($('#symbol-card tbody'))));
});

test('Current Positions: layout, the agreed columns, small Edit buttons, no Close', async () => {
  const { $, $$ } = await boot({}, { tab: 'positions' });
  await waitFor(() => $('.positions-layout'));
  const kids = [...$('.positions-layout').children];
  assert.ok(kids[0].classList.contains('positions-main'));
  assert.ok(kids[1].classList.contains('exposure-card'));
  assert.deepEqual($$('.positions-table thead th').map(text).filter(Boolean), ['Symbol', 'Qty', 'Entry', 'Price', 'Unrealized P&L', 'Original stop', 'Current stop', 'Current R', 'Risk to stop', 'Days held', 'Sector / Industry']);
  assert.equal($$('.btn-edit').length, 4);
  assert.ok($$('.btn-edit').every((b) => b.classList.contains('small')));
  assert.equal($$('.btn-close').length, 0);
  assert.ok(!/Close/.test($$('.pos-actions').map(text).join(' ')));
  assert.equal(text($$('.positions-table tbody tr')[0].children[9]), '5', 'days held');
});

test('Current Positions: stop NOT SET, a bad ORIGINAL stop and NO PRICE are flagged; a derisked stop is shown as such', async () => {
  const { $$ } = await boot({}, { tab: 'positions' });
  await waitFor(() => $$('.positions-table tbody tr').length >= 4);
  const rows = $$('.positions-table tbody tr').map(text);
  assert.match(rows[1], /NOT SET/); assert.match(rows[1], /NO PRICE/);
  assert.match(rows[2], /Check stop/); assert.match(rows[2], /locked/);
  assert.match(rows[0], /\+1R/);
  assert.match(rows[0], /2 separate entries/);
});

test('Split position: lots are listed under it with their own stops, R and DERISKED badge; lot Edit writes only that lot', async () => {
  const { $, $$, api } = await boot({}, { tab: 'positions' });
  await waitFor(() => $$('.lot-row').length === 2);
  const lots = $$('.lot-row').map(text);
  assert.match(lots[0], /Lot 1/); assert.match(lots[0], /\+50\.00 locked/); assert.match(lots[0], /\+2R/);
  assert.match(lots[1], /Lot 2/);
  $$('.btn-edit-lot')[1].click();
  const cur = await waitFor(() => $('#cur-stop-input'));
  cur.value = '12.5'; cur.dispatchEvent(new window.Event('input'));
  assert.match(text($('.overlay')), /derisked/);
  $('#save-edit').click();
  await waitFor(() => api.calls.updateLot.length === 1);
  assert.deepEqual(api.calls.updateLot[0], ['L2', { original_stop: 11, current_stop: 12.5, notes: null }]);
  assert.equal(api.calls.updatePosition.length, 0);
});

test('Split: separate entries are proposed as separate lots (by entry day) and saved; "Keep as one position" undoes it', async () => {
  const { $, $$, api } = await boot({}, { tab: 'positions' });
  (await waitFor(() => $('.btn-split.hint'))).click();
  await waitFor(() => $$('.lot-select').length === 2);
  assert.deepEqual($$('.lot-select').map((s) => s.value), ['0', '1']);
  $('#save-split').click();
  await waitFor(() => api.calls.saveLots.length === 1);
  const [id, lots] = api.calls.saveLots[0];
  assert.equal(id, 'p1');
  assert.deepEqual(lots.map((l) => [l.label, l.entry_keys.length, l.original_stop, l.current_stop]), [['Lot 1', 1, 9, 9], ['Lot 2', 1, 9, 9]]);
  await waitFor(() => $$('.btn-split').some((b) => b.textContent === 'Lots'));
  $$('.btn-split').find((b) => b.textContent === 'Lots').click();
  (await waitFor(() => $('#merge-lots'))).click();
  await waitFor(() => api.calls.saveLots.length === 2);
  assert.deepEqual(api.calls.saveLots[1], ['p4', []]);
});

test('Edit: choosing a sector lists ONLY that sector’s industries (Health Technology ≠ Software)', async () => {
  const { $, api } = await boot({}, { tab: 'positions' });
  await waitFor(() => $('.btn-edit')).then((b) => b.click());
  const sector = await waitFor(() => $('#sector-select'));
  assert.equal($('#industry-select').disabled, false); // AAA already has a sector
  sector.value = [...sector.options].find((o) => o.textContent === 'Health Technology').value; sector.dispatchEvent(new window.Event('change'));
  const names = [...$('#industry-select').options].map((o) => o.textContent);
  assert.ok(names.includes('Biotechnology'));
  assert.ok(!names.includes('Packaged Software'));
  sector.value = ''; sector.dispatchEvent(new window.Event('change'));
  assert.equal($('#industry-select').disabled, true, 'industry needs a sector first');
});

test('Edit: original stop fills the current stop; the current stop may go ABOVE the entry; only journal fields are saved', async () => {
  const { $, api } = await boot({}, { tab: 'positions' });
  (await waitFor(() => $('.btn-edit'))).click();
  const orig = await waitFor(() => $('#orig-stop-input'));
  const cur = $('#cur-stop-input');
  orig.value = '9.5'; orig.dispatchEvent(new window.Event('input'));
  assert.equal(cur.value, '9.5', 'current stop follows the original until moved');
  cur.value = '10.8'; cur.dispatchEvent(new window.Event('input'));
  assert.match(text($('.overlay')), /derisked/);
  orig.value = '9.4'; orig.dispatchEvent(new window.Event('input'));
  assert.equal(cur.value, '10.8', 'a moved current stop is not overwritten');
  $('#save-edit').click();
  await waitFor(() => api.calls.updatePosition.length === 1);
  const [id, patch] = api.calls.updatePosition[0];
  assert.equal(id, 'p1');
  assert.deepEqual(Object.keys(patch).sort(), ['current_stop', 'industry_id', 'notes', 'sector_id', 'stop_loss']);
  assert.deepEqual([patch.stop_loss, patch.current_stop], [9.4, 10.8]);
});

test('Edit: an ORIGINAL stop on the wrong side of the entry is blocked with an explanation', async () => {
  const { $, api } = await boot({}, { tab: 'positions' });
  (await waitFor(() => $('.btn-edit'))).click();
  const orig = await waitFor(() => $('#orig-stop-input'));
  orig.value = '12'; orig.dispatchEvent(new window.Event('input'));
  assert.match(text($('.overlay')), /must be BELOW the entry/);
  $('#save-edit').click();
  await tick(40);
  assert.equal(api.calls.updatePosition.length, 0);
});

test('Calendar: weeks start on MONDAY; Sept 2026 grid begins Mon 31 Aug; weekly result beside each week', async () => {
  const { $, $$ } = await boot({}, { tab: 'calendar', before: (c) => { c.state.cal = { year: 2026, month: 9, selected: null }; } });
  await waitFor(() => $('.cal-grid'));
  assert.deepEqual($$('.cal-head').map((e) => e.textContent), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Week']);
  assert.equal($$('.cal-cell')[0].dataset.date, '2026-08-31');
  assert.equal($$('.cal-cell')[1].dataset.date, '2026-09-01');
  assert.match(text($$('.cal-week')[0]), /\(9\.39\)/);     // Schema 1 week: 41.56 − 50.95
});

test('Calendar: switching to Schema 3 changes the weekly result to the pure-trading 41.56 (not forced to one schema)', async () => {
  const { $, $$ } = await boot({}, { tab: 'calendar', before: (c) => { c.state.cal = { year: 2026, month: 9, selected: null }; } });
  const sel = await waitFor(() => $('select[aria-label="P&L schema"]'));
  assert.equal(sel.options.length, 3);
  sel.value = 'schema3'; sel.dispatchEvent(new window.Event('change'));
  await waitFor(() => /41\.56/.test(text($$('.cal-week')[0])));
});

test('Calendar: a day lists positions HELD overnight too, with PropReports’ per-symbol result; one Fees line, then Total Δ', async () => {
  const { $, api } = await boot({}, { tab: 'calendar', before: (c) => { c.state.cal = { year: 2026, month: 9, selected: null }; } });
  (await waitFor(() => $('.cal-cell[data-date="2026-09-04"]'))).click();
  const panel = await waitFor(() => $('#day-panel'));
  await waitFor(() => $('#day-positions'));
  const rows = [...$('#day-positions').querySelectorAll('tbody tr')].map(text);
  assert.ok(rows.some((r) => /HOLD/.test(r) && /Held/.test(r) && /12\.50/.test(r)), rows.join(' | '));
  assert.ok(rows.some((r) => /WIN/.test(r) && /Closed/.test(r) && /21\.18/.test(r)), rows.join(' | '));
  const lines = [...panel.querySelectorAll('table.breakdown tr')].map((tr) => text(tr.firstChild));
  assert.deepEqual(lines, ['Trading result (realized + change in unrealized)', 'Fees', 'Total Δ']);
  assert.ok(!/Trade costs|Fee adjustments/.test(text(panel)));
  assert.equal($('#day-comment').value, 'Waited for the right entry.');
  $('#day-comment').value = 'Updated note';
  [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Save comment').click();
  await waitFor(() => api.calls.saveComment.length === 1);
  assert.equal(api.calls.saveComment[0][3], 'Updated note');
});

test('Calendar: month stats strip (P&L, green/red days, green %, Bats, W/L) and Days / Months / Years switch', async () => {
  const { $, $$ } = await boot({}, { tab: 'calendar', before: (c) => { c.state.cal = { year: 2026, month: 9, selected: null }; } });
  const strip = await waitFor(() => $('#cal-stats'));
  const vals = Object.fromEntries([...strip.querySelectorAll('.stat')].map((s) => [text(s.querySelector('.label')), text(s.querySelector('.value'))]));
  assert.equal(vals['Month P&L · Schema 1'], '($5.01)');   // Sep 1–4: −55.16 −0.09 +3.82 +46.42
  assert.equal(vals['Green days'], '2'); assert.equal(vals['Red days'], '2'); assert.equal(vals['Green %'], '50%');
  assert.equal(vals['Bats'], '50%');
  assert.notEqual(vals['W/L'], '—');
  $$('.segmented button').find((b) => b.textContent === 'Months').click();
  const months = await waitFor(() => $('#months-grid'));
  assert.equal(months.querySelectorAll('.period-tile').length, 12);
  assert.match(text(months.querySelector('[data-month="2026-08"]')), /\(4\.38\)/);
  months.querySelector('[data-month="2026-09"]').click();
  await waitFor(() => $('.cal-grid'));
  $$('.segmented button').find((b) => b.textContent === 'Years').click();
  const years = await waitFor(() => $('#years-grid'));
  assert.match(text(years), /2026/);
});

test('Trades: lists completed trades with gross, fees and net side by side; filter sends the query; row opens detail with executions', async () => {
  const { $, $$, api } = await boot({}, { tab: 'trades' });
  await waitFor(() => $$('tbody tr').length === 2);
  assert.match(text($$('tbody tr')[0]), /WIN/);
  const symbol = $('input[placeholder="AAPL"]'); symbol.value = 'WIN'; symbol.dispatchEvent(new window.Event('change'));
  await waitFor(() => api.calls.lastTradeQuery?.filters.symbol === 'WIN');
  await waitFor(() => $$('tbody tr').length === 1);
  $$('tbody tr')[0].click();
  const modal = await waitFor(() => $('.overlay'));
  assert.match(text(modal), /Schema 3 \(pure trading\)/);
  assert.match(text(modal), /Schema 1 \(after fees\)/);
  assert.match(text(modal), /STOP NOT SET/);
  await waitFor(() => /Underlying executions/.test(text($('.overlay'))) && $('.overlay table'));
});

test('Weekly Report: nothing is generated until you press Generate; the comment step is pre-filled from day comments', async () => {
  const { $, pdf } = await boot({}, { tab: 'weekly', before: (c) => { c.state.week = { weekStart: '2026-08-31' }; } });
  await waitFor(() => $('#generate-btn'));
  assert.equal(pdf.calls.length, 0, 'no PDF before the user asks');
  assert.match(text($('#view')), /Mon 31 Aug 2026 – Fri 04 Sep/);
  $('#generate-btn').click();
  const box = await waitFor(() => $('#weekly-comment'));
  assert.equal(box.value, 'Friday: Waited for the right entry.');
  assert.equal(pdf.calls.length, 0, 'still no PDF while the comment dialog is open');
});

test('Weekly Report: generate → editable fields → live preview → manual edit recomputes totals → explicit Download PDF', async () => {
  const { $, api, pdf } = await boot({}, { tab: 'weekly', before: (c) => { c.state.week = { weekStart: '2026-08-31' }; } });
  (await waitFor(() => $('#generate-btn'))).click();
  (await waitFor(() => $('#weekly-comment'))).value = 'Patient week.';
  $('#comment-ok').click();
  await waitFor(() => $('#d-delta-0'));
  assert.equal($('#d-delta-0').value, '-4.38');
  assert.equal($('#d-av-1').value, '-696.61');                    // includes the Sep 1 fee gap
  assert.equal($('#t-totalDeltaWeeklyPnl').value, '41.56');
  assert.equal($('#t-upDays').value, '2'); assert.equal($('#t-downDays').value, '3');
  await waitFor(() => pdf.calls.length >= 1);
  assert.equal(pdf.calls[0].weeklyComment, 'Patient week.');
  assert.equal(pdf.calls[0].accountCode, 'FPTI000645A404', 'account line shows only the code');
  assert.equal(pdf.calls[0].accountName, 'Gabriela Nikolova', 'name parsed from the PropReports label');
  // manual presentation edit on one day → totals follow the daily row, trading data untouched
  $('#d-delta-4').value = '50'; $('#d-delta-4').dispatchEvent(new window.Event('input'));
  assert.equal($('#t-totalDeltaWeeklyPnl').value, '45.14');
  await waitFor(() => pdf.calls.at(-1).days[4].totalDelta === 50, 3000);
  $('#download-pdf').click();
  await waitFor(() => window.__downloaded);
  assert.match(window.__downloaded, /^Weekly-Report-Gabriela-Nikolova-2026-08-31\.pdf$/);
  await waitFor(() => api.calls.saveWeekly.some((r) => r.status === 'finalized'));
  const finalized = api.calls.saveWeekly.find((r) => r.status === 'finalized');
  assert.equal(finalized.computed_data.days[4].totalDelta, 46.42, 'DATABASE TRUTH is stored separately from the edit');
  assert.equal(finalized.manual_overrides.days[4].totalDelta, 50);
});

test('Weekly Report: the four summary boxes on the page are one equal-width grid', async () => {
  const { $, $$ } = await boot({}, { tab: 'weekly', before: (c) => { c.state.week = { weekStart: '2026-08-31' }; } });
  await waitFor(() => $('.kpi-row'));
  assert.equal($$('.kpi-row > .card.kpi').length, 4);
  assert.ok($$('.kpi-row > .card').every((c) => !c.getAttribute('style')), 'no per-box sizing');
});

test('Settings: no typed-in report name; the account shows the code parsed from PropReports', async () => {
  const { $ } = await boot({}, { tab: 'settings' });
  await waitFor(() => $('#acct-code'));
  assert.equal($('#report-name'), null);
  assert.equal(text($('#acct-code')), 'FPTI000645A404');
});

test('Settings: profit share defaults to the stored 50% and saves a new percentage once, from a chosen month', async () => {
  const { $, api } = await boot({}, { tab: 'settings' });
  const pct = await waitFor(() => $('#pct-input'));
  assert.equal(pct.value, '50');
  pct.value = '40'; $('#pct-from').value = '2026-11-01';
  $('#save-pct').click();
  await waitFor(() => api.calls.saveProfit.length === 1);
  assert.deepEqual(api.calls.saveProfit[0].slice(1), [40, '2026-11-01']);
});

test('errors are friendly: a failing page shows a plain message, not a stack trace', async () => {
  const { $ } = await boot({ getSnapshots: async () => { throw new Error('boom at db.js:12'); } }, { tab: 'dashboard' });
  const err = await waitFor(() => $('.notice.error'));
  assert.match(err.textContent, /could not be loaded/);
  assert.ok(!/db\.js/.test(document.body.textContent));
});
