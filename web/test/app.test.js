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

test('shell: five tabs (no Trades); SYNC NOW with the last-sync line under it; no counts, warnings or "null"', async () => {
  const { $, $$ } = await boot();
  assert.deepEqual($$('.tab').map((b) => b.textContent), ['Dashboard', 'Current Positions', 'Calendar', 'Weekly Report', 'Settings']);
  assert.equal($('#sync-now').textContent, 'SYNC NOW');
  assert.match(text($('#sync-status')), /^Synced /);
  assert.equal($('#sync-now').nextElementSibling, $('#sync-status'), 'status sits under the button');
  const bar = text($('#syncbar'));
  assert.ok(!/warning|new ·|updated|null/i.test(bar), bar);
});

test('the Trading Journal logo opens the Rules page: cards in a row, Add rule at the top, Edit/Delete only after a tap', async () => {
  const { $, $$ } = await boot();
  $('#brand').click();
  await waitFor(() => $$('#rules .rule-card').length === 2);
  assert.equal(text($('#intro h1')), 'Rules');
  assert.ok(!/Hi Gabriela|today’s session/.test(text($('#intro'))));
  assert.equal($('#add-rule').closest('.rules-head') !== null, true, 'Add rule sits in the header, next to the title');
  assert.ok($('#add-rule').classList.contains('primary'));
  assert.equal($('.rule-num'), null, 'no numbers');
  assert.equal($$('#rules .rule-actions').length, 0, 'no buttons until a rule is tapped');
  $$('#rules .rule-card')[1].click();
  await waitFor(() => $$('#rules .rule-actions').length === 1);
  assert.match(text($$('#rules .rule-card')[1]), /Edit.*Delete/);
  $$('#rules .rule-card')[1].querySelector('.rule-text').click();
  await waitFor(() => $$('#rules .rule-actions').length === 0);
  assert.deepEqual($$('#rules .rule-text').map(text), ['Max 3 trades a day.', 'Never move a stop further away.']);
  assert.equal($('.intro-art'), null, 'no image / pink panel');
  assert.equal(document.querySelectorAll('.tab.active').length, 0);
});

test('rules: add, edit, move and delete (with a confirm step)', async () => {
  const { $, $$, api } = await boot({}, { tab: 'home' });
  await waitFor(() => $$('#rules .rule-card').length === 2);
  const btn = (card, label) => [...card.querySelectorAll('button')].find((b) => b.textContent === label);
  const tap = (i) => $$('#rules .rule-card')[i].click();
  // add
  $('#add-rule').click();
  const box = await waitFor(() => $('#rules .rule-input'));
  box.value = 'No trading in the first 5 minutes.';
  btn(box.closest('li'), 'Save').click();
  await waitFor(() => $$('#rules .rule-text').length === 3);
  assert.deepEqual(api.calls.rules.at(-1), ['add', 'u1', 'No trading in the first 5 minutes.', 2]);
  // edit
  tap(0);
  btn($$('#rules .rule-card')[0], 'Edit').click();
  const edit = await waitFor(() => $('#rules .rule-input'));
  assert.equal(edit.value, 'Max 3 trades a day.');
  edit.value = 'Max 2 trades a day.';
  btn(edit.closest('li'), 'Save').click();
  await waitFor(() => text($$('#rules .rule-text')[0]) === 'Max 2 trades a day.');
  assert.deepEqual(api.calls.rules.at(-1), ['update', 'r1', 'Max 2 trades a day.']);
  // move later
  tap(0);
  $$('#rules .rule-card')[0].querySelector('[aria-label="Move down"]').click();
  await waitFor(() => text($$('#rules .rule-text')[1]) === 'Max 2 trades a day.');
  assert.equal(api.calls.rules.at(-1)[0], 'reorder');
  // delete asks first
  tap(0);
  btn($$('#rules .rule-card')[0], 'Delete').click();
  assert.match(text($$('#rules .rule-card')[0]), /Delete this rule\?/);
  btn($$('#rules .rule-card')[0], 'Delete').click();
  await waitFor(() => $$('#rules .rule-card').length === 2);
  assert.equal(api.calls.rules.at(-1)[0], 'delete');
});

test('rules: empty state invites the first rule; empty text is not saved', async () => {
  const { $, $$, api } = await boot({ getRules: async () => [] }, { tab: 'home' });
  await waitFor(() => $('.rules-empty'));
  assert.ok(!$('.rules-empty').classList.contains('hidden'));
  $('#add-rule').click();
  const box = await waitFor(() => $('#rules .rule-input'));
  box.value = '   ';
  [...box.closest('li').querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
  await tick(30);
  assert.equal(api.calls.rules.length, 0);
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

test('P&L types are named Total, Pure trading, After Share — in that order — with no "Schema" wording or explanations on the pages', async () => {
  const { $ } = await boot();
  const sel = $('select[aria-label="P&L type"]');
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['Total', 'Pure trading', 'After Share']);
  assert.ok(!/Schema/i.test(document.body.textContent));
  assert.equal(document.querySelector('#view .notice'), null, 'no explanation banner');
});

test('Dashboard: the P&L type switch changes the numbers; account value is PropReports’ own; no Open exposure', async () => {
  const { $, $$ } = await boot();
  const kpis = () => Object.fromEntries($$('.kpi').map((k) => [text(k.querySelector('.label')), text(k.querySelector('.value'))]));
  assert.equal(kpis()['Account value'], '($646.46)');
  assert.ok(!('Open exposure' in kpis()));
  // Total · all time = PropReports Cash + Unrealized − deposits (the fake account's balance; its one stored
  // week alone adds up to (9.39), because this fixture's chain starts at −637.07, not at 0)
  assert.equal(kpis()['Total P&L · all time'], '($646.46)');
  const sel = $('select[aria-label="P&L type"]');
  sel.value = 'schema3'; sel.dispatchEvent(new window.Event('change'));
  await tick(80);
  assert.equal(kpis()['Pure trading P&L · all time'], '$41.56');
  assert.ok(!('Total P&L · all time' in kpis()));
});

test('Dashboard: account value uses PropReports Cash + Unrealized even when the stored daily chain differs', async () => {
  const { $$ } = await boot({ getSyncStatus: async () => ({ state: { status: 'idle', last_success_at: '2026-09-04T20:00:00Z', account_cash: -1200, account_unrealized: 34.5 }, lastRun: null }) });
  const k = $$('.kpi').find((x) => /Account value/.test(x.textContent));
  assert.equal(text(k.querySelector('.value')), '($1,165.50)');
});

test('Dashboard chart: range buttons (week / month / 6 months / 1 year / all), no Cumulative / Account value buttons, drag moves the window', async () => {
  const { $, ctx } = await boot();
  const card = $('#perf-chart').closest('.card');
  assert.deepEqual([...card.querySelectorAll('.segmented button')].map(text), ['This week', 'This month', '6 months', '1 year', 'All time']);
  assert.ok(!/Cumulative|Account value/.test(text(card.querySelector('.segmented'))));
  [...card.querySelectorAll('.segmented button')].find((b) => text(b) === 'All time').click();
  await waitFor(() => /31 Aug 2026/.test(text($('#chart-window'))));
  assert.ok($('#perf-chart svg.chart polyline'), 'chart drawn');
  assert.ok($('#perf-chart svg.chart line[stroke-dasharray]'), 'zero line');
  [...card.querySelectorAll('.segmented button')].find((b) => text(b) === 'This month').click();
  const before = ctx.state.chartWindow.from;
  const holder = $('#perf-chart');
  const ev = (type, x) => { const e = new window.MouseEvent(type, { clientX: x, bubbles: true }); e.pointerId = 1; holder.dispatchEvent(e); };
  ev('pointerdown', 600); ev('pointermove', 900); ev('pointerup', 900);
  assert.ok(ctx.state.chartWindow.from < before, 'dragging right shows earlier dates');
});

test('Dashboard: overall statistics can be shown for this week / this month / this year / all time', async () => {
  const { $, $$ } = await boot();
  const pick = () => [...$('#overall-stats .segmented').querySelectorAll('button')];
  assert.deepEqual(pick().map(text), ['This week', 'This month', 'This year', 'All time']);
  assert.match(text($('#overall-stats')), /2 trades/);
  pick().find((b) => text(b) === 'This month').click();
  await waitFor(() => /No completed trades in this period/.test(text($('#overall-stats'))));
});

test('Dashboard: no buying power card; KPI cards share one grid; overall stats headline + closed sections; Worst 10 tab', async () => {
  const { $, $$ } = await boot();
  assert.ok(!$$('.kpi').some((k) => /Buying power/.test(k.textContent)));
  assert.equal($$('.cards-kpi > .kpi').length, 5);
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

test('Positions: ONE pink Edit button per row; Split lives inside Edit and proposes one lot per entry day; "Keep as one position" undoes it', async () => {
  const { $, $$, api } = await boot({}, { tab: 'positions' });
  await waitFor(() => $$('.btn-edit').length === 4);
  assert.ok($$('.btn-edit, .btn-edit-lot').every((b) => b.classList.contains('primary')), 'pink');
  assert.equal($$('.btn-split').length, 0);
  $$('.btn-edit')[0].click();
  (await waitFor(() => $('#open-split'))).click();
  await waitFor(() => $$('.lot-select').length === 2);
  assert.deepEqual($$('.lot-select').map((s) => s.value), ['0', '1']);
  $('#save-split').click();
  await waitFor(() => api.calls.saveLots.length === 1);
  const [id, lots] = api.calls.saveLots[0];
  assert.equal(id, 'p1');
  assert.deepEqual(lots.map((l) => [l.label, l.entry_keys.length, l.original_stop, l.current_stop]), [['Lot 1', 1, 9, 9], ['Lot 2', 1, 9, 9]]);
  await waitFor(() => $$('.btn-edit').length === 4 && !document.querySelector('.overlay'));
  $$('.btn-edit')[3].click();                       // DDD, already split
  (await waitFor(() => $('#open-split'))).click();
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
  assert.match(text($$('.cal-week')[0]), /\(9\.39\)/);     // Total week: 41.56 − 50.95
});

test('Calendar: switching to Pure trading changes the weekly result to 41.56; After Share has no day calendar (months / years only)', async () => {
  const { $, $$ } = await boot({}, { tab: 'calendar', before: (c) => { c.state.cal = { year: 2026, month: 9, selected: null }; } });
  const sel = await waitFor(() => $('select[aria-label="P&L type"]'));
  sel.value = 'schema3'; sel.dispatchEvent(new window.Event('change'));
  await waitFor(() => $$('.cal-week').length && /41\.56/.test(text($$('.cal-week')[0])));
  const sel2 = $('select[aria-label="P&L type"]');
  sel2.value = 'schema2'; sel2.dispatchEvent(new window.Event('change'));
  await waitFor(() => $('#months-grid'));
  assert.equal($('.cal-grid'), null);
  assert.deepEqual($$('#view .segmented button').map(text), ['Months', 'Years']);
  assert.match(text($('#cal-stats')), /Green months/);
});

test('Calendar day: every stock open that day (held overnight too) in the SELECTED P&L type, adding up to the day', async () => {
  const { $, $$, api } = await boot({}, { tab: 'calendar', before: (c) => { c.state.cal = { year: 2026, month: 9, selected: null }; } });
  (await waitFor(() => $('.cal-cell[data-date="2026-09-04"]'))).click();
  const panel = await waitFor(() => $('#day-panel'));
  await waitFor(() => $('#day-positions'));
  const heads = [...$('#day-positions').querySelectorAll('thead th')].map(text);
  assert.deepEqual(heads, ['Symbol', 'Direction', 'That day', 'Shares traded', 'Realized', 'Unrealized Δ', 'Total']);
  const rows = [...$('#day-positions').querySelectorAll('tbody tr')].map(text);
  assert.ok(rows.some((r) => /HOLD/.test(r) && /Held/.test(r) && /25\.24/.test(r)), rows.join(' | '));
  assert.ok(rows.some((r) => /WIN/.test(r) && /Closed/.test(r) && /23\.18/.test(r) && /\(2\.00\)/.test(r) && /21\.18/.test(r)), rows.join(' | '));
  assert.match(rows.at(-1), /Day Total\s*46\.42/);
  assert.ok(!rows.some((r) => /Other/.test(r)), 'stocks add up to the day');
  assert.equal(panel.querySelector('table.breakdown'), null, 'no Trading result / Fees / Total Δ rows');
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
  assert.equal(vals['Month P&L · Total'], '($5.01)');   // Sep 1–4: −55.16 −0.09 +3.82 +46.42
  assert.equal(vals['Green days'], '2'); assert.equal(vals['Red days'], '2'); assert.equal(vals['Green %'], '50%');
  assert.equal(vals['Bats'], '50%');
  assert.notEqual(vals['W/L'], '—');
  $$('#view .segmented button').find((b) => b.textContent === 'Months').click();
  const months = await waitFor(() => $('#months-grid'));
  assert.equal(months.querySelectorAll('.period-tile').length, 12);
  assert.match(text(months.querySelector('[data-month="2026-08"]')), /\(4\.38\)/);
  months.querySelector('[data-month="2026-09"]').click();
  await waitFor(() => $('.cal-grid'));
  $$('#view .segmented button').find((b) => b.textContent === 'Years').click();
  const years = await waitFor(() => $('#years-grid'));
  assert.match(text(years), /2026/);
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

test('Settings: the P&L types are explained here (and only here)', async () => {
  const { $ } = await boot({}, { tab: 'settings' });
  const card = await waitFor(() => $('#pnl-types'));
  assert.deepEqual([...card.querySelectorAll('.pnl-type b')].map(text), ['Total', 'Pure trading', 'After Share']);
  assert.match(text(card), /profit share/i);
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

// ---------- the user's REAL days, 19 Oct – 4 Nov 2026 (PropReports exports) ----------
import fs from 'node:fs';
import { buildDailySnapshots } from '../../packages/engine/src/dailySnapshots.js';
const RF = JSON.parse(fs.readFileSync(new URL('../../packages/engine/test/fixtures/gabriela-2026-10-19-to-11-04.json', import.meta.url), 'utf8'));
const realSnap = buildDailySnapshots({
  positionRows: RF.days.flatMap((d) => d.symbols.map((x) => ({ Date: d.date, Symbol: x.symbol, Realized: String(x.gross), 'Unrealized Delta': String(x.unrealizedDelta), 'Qty Traded': String(x.qty), ...x.fees }))),
  adjustments: RF.days.flatMap((d) => d.fees.map((f) => ({ date: d.date, categoryName: f.name, amount: f.amount, categoryType: 'fee' }))),
  startingAccountValue: 0,
});
const realApi = {
  getSnapshots: async () => realSnap.rows.map((r) => ({ ...r, date: r.tradeDate })),
  getPositionsOnDay: async () => [],
  getSymbolDays: async (from) => realSnap.symbolRows.filter((x) => x.tradeDate === from).map((x) => ({ date: x.tradeDate, symbol: x.symbol, realized: x.realized, unrealizedDelta: x.unrealizedDelta, tradeCosts: x.tradeCosts, quantityTraded: x.quantityTraded })),
  getDailyComments: async () => [],
};
async function openRealDay(date, schema = 'schema1') {
  const [y, m] = date.split('-').map(Number);
  const b = await boot(realApi, { tab: 'calendar', before: (c) => { c.state.schema = schema; c.state.cal = { year: y, month: m, selected: date, view: 'days' }; } });
  await waitFor(() => b.$('#day-positions'));
  const rows = [...b.$('#day-positions').querySelectorAll('tbody tr')].map(text);
  return { ...b, rows, row: (sym) => rows.find((r) => r.startsWith(sym)) };
}

test('REAL 30 Oct, Total: Realized = Net, Total = Total Δ, no phantom Other, Day Total (14.52)', async () => {
  const { rows, row } = await openRealDay('2026-10-30');
  assert.match(row('MDLZ'), /\(11\.18\)\s*0\.00\s*\(11\.18\)$/);
  assert.match(row('AZN'), /10\.51\s*0\.00\s*10\.51$/);
  assert.match(row('DOCS'), /\(0\.58\)\s*\(7\.95\)\s*\(8\.53\)$/);
  assert.match(row('CDNA'), /\(5\.32\)\s*0\.00\s*\(5\.32\)$/);
  assert.ok(!rows.some((r) => /Other/.test(r)), rows.join(' | '));
  assert.match(rows.at(-1), /Day Total\s*\(14\.52\)/);
});

test('REAL 20 Oct, Total: ARM (5.14), Other (fees) = Daily Interest (0.03), Day Total (0.93)', async () => {
  const { rows, row } = await openRealDay('2026-10-20');
  assert.match(row('ARM'), /\(5\.14\)\s*0\.00\s*\(5\.14\)$/);
  assert.match(rows.find((r) => r.startsWith('Other')), /^Other \(fees\)\s*\(0\.03\)$/);
  assert.match(rows.at(-1), /Day Total\s*\(0\.93\)/);
});

test('REAL 29 Oct and 1 Nov, Total: Day Total (7.26) and (50.95) — a fee-only day still shows its table', async () => {
  const a = await openRealDay('2026-10-29');
  assert.match(a.rows.at(-1), /Day Total\s*\(7\.26\)/);
  assert.match(a.rows.find((r) => r.startsWith('Other')), /\(0\.06\)$/);
  const b = await openRealDay('2026-11-01');
  assert.equal(b.rows.length, 2);
  assert.match(b.rows[0], /^Other \(fees\)\s*\(50\.95\)$/);
  assert.match(b.rows[1], /^Day Total\s*\(50\.95\)$/);
});

test('REAL days, Pure trading: same stock rows, the Fee: rows left out (29 Oct (7.20), 28 Oct 22.14 without Fee: Misc, 1 Nov 0.00)', async () => {
  const a = await openRealDay('2026-10-29', 'schema3');
  assert.match(a.row('GEN'), /9\.99\s*0\.00\s*9\.99$/);
  assert.ok(!a.rows.some((r) => /Other/.test(r)));
  assert.match(a.rows.at(-1), /Day Pure trading\s*\(7\.20\)/);
  const b = await openRealDay('2026-10-28', 'schema3');
  assert.match(b.rows.at(-1), /Day Pure trading\s*22\.14/);
});

test('REAL account: Dashboard Total · all time = PropReports balance (1,008.43)', async () => {
  const { $$ } = await boot({ ...realApi, getClosedTrades: async () => [], getSyncStatus: async () => ({ state: { status: 'idle', last_success_at: '2026-11-04T20:00:00Z', account_cash: -1008.4298, account_unrealized: 0 }, lastRun: null }) });
  const kpis = Object.fromEntries($$('.kpi').map((k) => [text(k.querySelector('.label')), text(k.querySelector('.value'))]));
  assert.equal(kpis['Total P&L · all time'], '($1,008.43)');
});
