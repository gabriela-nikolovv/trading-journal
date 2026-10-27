// Weekly Report tab (spec sections 26-29, 55).
//   SELECT WEEK → CALCULATE → ASK FOR COMMENT → GENERATE → DISPLAY → MANUAL EDITS → REVIEW → DOWNLOAD PDF
// The PDF is never produced automatically. Edits change only the report instance (manual_overrides),
// never the trading data: DATABASE TRUTH (computed_data) and REPORT PRESENTATION EDITS stay separate.
import { h, clear, money, loading, errorCard, toast, openModal, fmtDate } from '../lib.js';
import { buildWeekInput, mondayOf, addDays } from '../engine/weekBuilder.js';
import { assembleWeeklyReportData, buildWeeklyCommentDraft, applyManualOverrides } from '../engine/weeklyReport.js';
import { formatSignedParen } from '../engine/format.js';

const num = (v) => { const t = String(v).trim().replace(/[()]/g, (c) => (c === '(' ? '-' : '')); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };

export async function render(container, ctx) {
  const { api, state } = ctx;
  state.week ??= { weekStart: mondayOf(new Date().toISOString().slice(0, 10)) };
  const weekStart = state.week.weekStart;
  const weekEnd = addDays(weekStart, 4);
  clear(container).append(loading('Calculating the week…'));

  let snapshots, trades, comments, saved, settings;
  try {
    [snapshots, trades, comments, saved, settings] = await Promise.all([
      api.getSnapshots(), api.getClosedTrades(), api.getDailyComments(weekStart, addDays(weekStart, 6)), api.getWeeklyReport(state.account.id, weekStart), api.getSettings(),
    ]);
  } catch (e) { clear(container).append(errorCard('The week could not be calculated. Your data is safe — try again.', e)); return; }

  const week = buildWeekInput({ weekStart, snapshots, closedTrades: trades, dailyComments: comments });
  const accountName = settings?.report_display_name || state.account.propreports_account_name || 'Trader';
  const accountCode = state.account.account_code || '';
  const draft = buildWeeklyCommentDraft(week.commentDays);

  const picker = h('div', { class: 'row' },
    h('button', { class: 'btn', 'aria-label': 'Previous week', onclick: () => { state.week = { weekStart: addDays(weekStart, -7) }; render(container, ctx); } }, '◀'),
    h('input', { type: 'date', value: weekStart, 'aria-label': 'Pick any day in the week', onchange: (e) => { if (e.target.value) { state.week = { weekStart: mondayOf(e.target.value) }; render(container, ctx); } } }),
    h('button', { class: 'btn', 'aria-label': 'Next week', onclick: () => { state.week = { weekStart: addDays(weekStart, 7) }; render(container, ctx); } }, '▶'),
    h('b', {}, `Mon ${fmtDate(weekStart)} – Fri ${fmtDate(weekEnd)}`));

  const baseFor = (comment) => assembleWeeklyReportData({ accountName, accountCode, weekStart, weekEnd, days: week.days, propReportsNative: week.propReportsNative, weeklyComment: comment });
  const base = baseFor(draft);
  const summary = h('div', { class: 'card' }, h('h2', {}, 'Calculated from your synced data'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), week.days.map((d) => h('th', { class: 'num' }, d.label)))),
      h('tbody', {}, h('tr', {}, h('td', {}, 'Total Δ'), week.days.map((d) => h('td', { class: `num ${d.totalDelta < 0 ? 'neg' : d.totalDelta > 0 ? 'pos' : ''}` }, formatSignedParen(d.totalDelta)))),
        h('tr', {}, h('td', {}, 'Account value'), week.days.map((d) => h('td', { class: 'num' }, formatSignedParen(d.accountValue))))))),
    h('div', { class: 'row', style: 'margin-top:.8rem' },
      ...[['Total Δ (Weekly P&L)', `$${formatSignedParen(base.totals.totalDeltaWeeklyPnl)}`], ['Average daily Δ', formatSignedParen(base.totals.averageDailyDelta)], ['Up / down days', `${base.totals.upDays} / ${base.totals.downDays}`], ['Max drawdown', formatSignedParen(base.totals.maxDrawdown)]]
        .map(([k, v]) => h('div', { class: 'card kpi', style: 'flex:1;min-width:150px' }, h('div', { class: 'label' }, k), h('div', { class: 'value' }, v)))),
    h('div', { class: 'muted', style: 'font-size:.8rem;margin-top:.5rem' }, 'The Total Δ row leaves out the market-data / platform / multisport fees that post on the 1st of the month; account value includes them.'),
    h('div', { class: 'row', style: 'margin-top:1rem' },
      h('button', { class: 'btn primary big', id: 'generate-btn', onclick: () => askComment(saved?.weekly_comment ?? draft) }, 'Generate report…'),
      saved ? h('button', { class: 'btn big', onclick: () => showReport(saved.weekly_comment ?? '', saved.manual_overrides) }, 'Open saved draft') : null));

  const stage = h('div', {});
  clear(container).append(h('div', { class: 'row between' }, h('h1', {}, 'Weekly report'), picker), summary, stage);

  // Step: ask for the weekly comment, pre-filled with the daily comments.
  function askComment(initial) {
    const box = h('textarea', { id: 'weekly-comment', style: 'min-height:140px' }, initial);
    const modal = openModal('Comment for this week', [
      h('p', { class: 'muted' }, draft ? 'Suggested from the comments you left on individual days. Edit freely.' : 'You have not left any day comments this week. Write your comment for the week (or leave it empty).'),
      box, h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'btn primary big', id: 'comment-ok', onclick: () => { modal.close(); showReport(box.value, saved?.manual_overrides); } }, 'Generate report'), h('button', { class: 'btn big', onclick: () => modal.close() }, 'Cancel'))]);
  }

  // Step: editable report + live preview + explicit download.
  async function showReport(comment, overrides) {
    const root = baseFor(comment);
    const edit = structuredClone({ accountName: root.accountName, accountCode: root.accountCode, days: root.days, totals: root.totals, propReportsNative: root.propReportsNative, weeklyComment: comment, ...(overrides ?? {}) });
    let blobUrl = null, bytes = null, timer = null;
    const frame = h('iframe', { class: 'pdf-frame', title: 'Report preview' });
    const status = h('div', { class: 'muted' }, '');
    const current = () => applyManualOverrides(root, edit);

    const refreshPreview = async () => {
      clear(status).append('Updating preview…');
      try {
        bytes = await ctx.pdf.render(current());
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        frame.src = blobUrl; clear(status).append('Preview is up to date.');
      } catch (e) { clear(status).append(errorCard('The preview could not be drawn.', e)); }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(refreshPreview, 450); };
    const recompute = () => { // totals follow the (possibly edited) daily rows, like the template's formulas
      const t = assembleWeeklyReportData({ ...root, days: edit.days, propReportsNative: edit.propReportsNative }).totals;
      Object.assign(edit.totals, t); for (const [k, inp] of Object.entries(totalInputs)) inp.value = String(Math.round(t[k] * 100) / 100);
    };
    const field = (label, get, set, { id, text = false } = {}) => { const inp = h('input', { id, value: get() ?? '', inputmode: text ? 'text' : 'decimal', oninput: (e) => { set(text ? e.target.value : num(e.target.value)); schedule(); } }); return h('div', {}, h('label', { for: id }, label), inp); };
    const totalInputs = {};
    const totalField = (label, key) => { const f = field(label, () => String(Math.round(edit.totals[key] * 100) / 100), (v) => { edit.totals[key] = v; }, { id: `t-${key}` }); totalInputs[key] = f.querySelector('input'); return f; };
    const N = edit.propReportsNative;

    const form = h('div', { class: 'card' }, h('h2', {}, 'Review and edit'),
      h('div', { class: 'notice' }, 'Edits here change only this report. Your trading data stays exactly as PropReports reported it.'),
      h('div', { class: 'mini-grid' }, field('Name on report', () => edit.accountName, (v) => { edit.accountName = v; }, { id: 'f-name', text: true }), field('Account', () => edit.accountCode, (v) => { edit.accountCode = v; }, { id: 'f-code', text: true })),
      h('h3', { style: 'margin-top:1rem' }, 'Days'),
      h('div', { class: 'mini-grid' }, edit.days.flatMap((d, i) => [
        field(`${d.label} Total Δ`, () => d.totalDelta, (v) => { d.totalDelta = v ?? 0; recompute(); }, { id: `d-delta-${i}` }),
        field(`${d.label} Account value`, () => d.accountValue, (v) => { d.accountValue = v ?? 0; }, { id: `d-av-${i}` })])),
      h('h3', { style: 'margin-top:1rem' }, 'Automatic totals'),
      h('div', { class: 'mini-grid' }, totalField('Total Δ (Weekly P&L)', 'totalDeltaWeeklyPnl'), totalField('Average daily Δ', 'averageDailyDelta'), totalField('Up days', 'upDays'), totalField('Down days', 'downDays'), totalField('Max drawdown', 'maxDrawdown')),
      h('h3', { style: 'margin-top:1rem' }, 'Trade performance (from your completed trades)'),
      h('div', { class: 'mini-grid' },
        field('Realized net', () => N.realizedNet, (v) => { N.realizedNet = v; }, { id: 'n-realized' }), field('Quantity', () => N.quantity, (v) => { N.quantity = v; }, { id: 'n-qty' }),
        field('BAT % (e.g. 50)', () => (N.bat === null ? '' : Math.round(N.bat * 10000) / 100), (v) => { N.bat = v === null ? null : v / 100; }, { id: 'n-bat' }), field('W/L ratio', () => N.wlRatio, (v) => { N.wlRatio = v; }, { id: 'n-wl' }),
        field('Avg size in position', () => N.avgSizeInPosition, (v) => { N.avgSizeInPosition = v; }, { id: 'n-size' }), field('Avg hold time', () => N.avgHoldTime, (v) => { N.avgHoldTime = v ?? ''; }, { id: 'n-hold', text: true }),
        field('Avg net winner', () => N.avgNetWinner, (v) => { N.avgNetWinner = v; }, { id: 'n-aw' }), field('Avg net loser', () => N.avgNetLoser, (v) => { N.avgNetLoser = v; }, { id: 'n-al' }),
        field('Biggest net winner', () => N.biggestNetWinner, (v) => { N.biggestNetWinner = v; }, { id: 'n-bw' }), field('Biggest net loser', () => N.biggestNetLoser, (v) => { N.biggestNetLoser = v; }, { id: 'n-bl' })),
      h('label', { class: 'field' }, 'Comment', h('textarea', { id: 'f-comment', oninput: (e) => { edit.weeklyComment = e.target.value; schedule(); } }, edit.weeklyComment)),
      h('div', { class: 'row' },
        h('button', { class: 'btn', id: 'save-draft', onclick: async () => {
          try { await api.saveWeeklyReport({ prop_account_id: state.account.id, user_id: state.userId, week_start_date: weekStart, week_end_date: weekEnd, computed_data: root, weekly_comment: edit.weeklyComment, manual_overrides: edit, status: 'draft' }); toast('Draft saved.'); }
          catch (e) { toast('Could not save the draft.', 'error'); console.error(e); } } }, 'Save draft'),
        h('button', { class: 'btn primary big', id: 'download-pdf', onclick: async () => {
          await refreshPreview(); if (!bytes) return;
          const a = h('a', { href: blobUrl, download: `Weekly-Report-${edit.accountName.replace(/\s+/g, '-')}-${weekStart}.pdf` }); document.body.append(a); a.click(); a.remove();
          api.saveWeeklyReport({ prop_account_id: state.account.id, user_id: state.userId, week_start_date: weekStart, week_end_date: weekEnd, computed_data: root, weekly_comment: edit.weeklyComment, manual_overrides: edit, status: 'finalized', pdf_generated_at: new Date().toISOString(), finalized_at: new Date().toISOString() }).catch(console.error);
        } }, 'Download PDF')),
      status);

    clear(stage).append(h('div', { class: 'report-layout' }, form, h('div', { class: 'card' }, h('h2', {}, 'Preview'), frame)));
    stage.scrollIntoView?.({ behavior: 'smooth' });
    refreshPreview();
  }
}
