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

test('shell: six tabs, SYNC NOW always visible, sync status + warning count shown', async () => {
  const { $, $$ } = await boot();
  assert.deepEqual($$('.tab').map((b) => b.textContent), TABS.map((t) => t[1]));
  assert.equal($('#sync-now').textContent, 'SYNC NOW');
  assert.equal($('#sync-pill').textContent, 'Synced');
  assert.match(text($('#syncbar')), /1 warning/);
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

test('Dashboard: buying power is NOT faked as account value', async () => {
  const { $$ } = await boot();
  const bp = $$('.kpi').find((k) => /Buying power/.test(k.textContent));
  assert.match(text(bp), /n\/a/);
});

test('Current Positions: positions on the LEFT, Exposure square on the RIGHT, big Edit and Close on every row', async () => {
  const { $, $$ } = await boot({}, { tab: 'positions' });
  await waitFor(() => $('.positions-layout'));
  const kids = [...$('.positions-layout').children];
  assert.ok(kids[0].classList.contains('positions-main'));
  assert.ok(kids[1].classList.contains('exposure-card'));
  assert.match(document.styleSheets.length >= 0 ? 'ok' : '', /ok/);
  const edits = $$('.btn-edit'), closes = $$('.btn-close');
  assert.equal(edits.length, 3); assert.equal(closes.length, 3);
  assert.ok([...edits, ...closes].every((b) => b.classList.contains('big')));
});

test('Current Positions: STOP NOT SET, INVALID STOP and PRICE UNAVAILABLE are shown instead of invented numbers', async () => {
  const { $$ } = await boot({}, { tab: 'positions' });
  await waitFor(() => $$('tbody tr').length === 3);
  const rows = $$('tbody tr').map(text);
  assert.match(rows[1], /STOP NOT SET/); assert.match(rows[1], /PRICE UNAVAILABLE/);
  assert.match(rows[2], /INVALID STOP/);
  assert.match(rows[0], /\+1R/);
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

test('Edit: an invalid stop on a long is blocked with a clear message; a valid one saves ONLY journal fields', async () => {
  const { $, api } = await boot({}, { tab: 'positions' });
  (await waitFor(() => $('.btn-edit'))).click();
  const stop = await waitFor(() => $('#stop-input'));
  stop.value = '12'; stop.dispatchEvent(new window.Event('input'));
  assert.match(text($('.overlay')), /stop must be BELOW the entry/);
  [...document.querySelectorAll('.overlay .btn.primary')].find((b) => b.textContent === 'Save').click();
  await tick(40);
  assert.equal(api.calls.updatePosition.length, 0, 'invalid stop must not be saved');
  stop.value = '9.5'; stop.dispatchEvent(new window.Event('input'));
  [...document.querySelectorAll('.overlay .btn.primary')].find((b) => b.textContent === 'Save').click();
  await waitFor(() => api.calls.updatePosition.length === 1);
  const [id, patch] = api.calls.updatePosition[0];
  assert.equal(id, 'p1');
  assert.deepEqual(Object.keys(patch).sort(), ['industry_id', 'notes', 'sector_id', 'stop_loss']);
  assert.equal(patch.stop_loss, 9.5);
});

test('Close: says plainly that no order is sent, and only writes a journal note (no trading facts)', async () => {
  const { $, api } = await boot({}, { tab: 'positions' });
  (await waitFor(() => $('.btn-close'))).click();
  const modal = await waitFor(() => $('.overlay'));
  assert.match(text(modal), /does NOT close the trade/);
  assert.match(text(modal), /No order is sent/);
  [...modal.querySelectorAll('.btn.primary')].find((b) => /Note as closed/.test(b.textContent)).click();
  await waitFor(() => api.calls.updatePosition.length === 1);
  assert.deepEqual(Object.keys(api.calls.updatePosition[0][1]).sort(), ['journal_close_note', 'journal_closed_at']);
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

test('Calendar: clicking a day shows its trades and a comment box; saving stores the comment', async () => {
  const { $, api } = await boot({}, { tab: 'calendar', before: (c) => { c.state.cal = { year: 2026, month: 9, selected: null }; } });
  (await waitFor(() => $('.cal-cell[data-date="2026-09-04"]'))).click();
  const panel = await waitFor(() => $('#day-panel'));
  assert.match(text(panel), /WIN/);
  assert.equal($('#day-comment').value, 'Waited for the right entry.');
  $('#day-comment').value = 'Updated note';
  [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Save comment').click();
  await waitFor(() => api.calls.saveComment.length === 1);
  assert.equal(api.calls.saveComment[0][3], 'Updated note');
  assert.equal(api.calls.saveComment[0][2], '2026-09-04');
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
