// Settings (spec section 41): connection, sync status + reconciliation warnings, profit share,
// report name, market-data / TradingView status, preferences, sign-out.
import { h, clear, loading, errorCard, toast, fmtDate, SCHEMA_LABELS } from '../lib.js';

export async function render(container, ctx) {
  const { api, state } = ctx;
  clear(container).append(loading('Loading settings…'));
  let status, schedule, settings;
  try { [status, schedule, settings] = await Promise.all([api.getSyncStatus(state.account.id), api.getProfitShareSchedule(), api.getSettings()]); }
  catch (e) { clear(container).append(errorCard('Settings could not be loaded.', e)); return; }

  const a = state.account, st = status.state, run = status.lastRun;
  const current = [...schedule].sort((x, y) => y.effectiveFrom.localeCompare(x.effectiveFrom))[0];
  const pctInput = h('input', { id: 'pct-input', type: 'number', min: '0', max: '100', step: '0.5', value: current?.pct ?? 50, style: 'width:100px' });
  const fromInput = h('input', { id: 'pct-from', type: 'date', value: new Date().toISOString().slice(0, 7) + '-01' });
  const nameInput = h('input', { id: 'report-name', value: settings?.report_display_name ?? '', placeholder: a.propreports_account_name ?? 'Your name' });
  const warnings = Array.isArray(run?.warnings) ? run.warnings : [];
  const test = (label, fn) => { const out = h('span', { class: 'muted' }, ''); return h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { clear(out).append('Checking…'); try { clear(out).append(await fn()); } catch (e) { clear(out).append(e.message); } } }, label), out); };

  clear(container).append(h('h1', {}, 'Settings'),
    h('div', { class: 'card' }, h('h2', {}, 'PropReports connection'),
      h('p', {}, 'Account: ', h('b', {}, a.account_code || a.propreports_account_name || '—'), h('span', { class: 'muted' }, ` · PropReports account id ${a.propreports_account_id} · ${a.prop_firm} / ${a.platform}`)),
      h('p', { class: 'muted' }, 'The API token lives only on the server (Supabase secret). It is never shown here and never reaches your browser.'),
      test('Test the connection', async () => { const r = await api.setupAccount(); return `Connected ✔ (account ${r.propAccountId ? 'found' : 'ok'})`; })),
    h('div', { class: 'card' }, h('h2', {}, 'Synchronization'),
      h('p', {}, 'Status: ', h('b', {}, st?.status ?? 'never run'), st?.last_success_at ? ` · last success ${new Date(st.last_success_at).toLocaleString()}` : ''),
      st?.last_error ? h('div', { class: 'notice error' }, st.last_error + ' Your previous data is still available.') : null,
      run ? h('div', { class: 'muted' }, `Last run: ${run.fills_fetched} fills fetched · ${run.fills_new} new · ${run.fills_updated} updated · ${run.adjustments_fetched} adjustments (${run.adjustments_new} new) · ${run.positions_detected} positions detected`) : null,
      warnings.length ? h('div', {}, h('h3', { style: 'margin-top:1rem' }, 'Reconciliation warnings'), warnings.map((w) => h('div', { class: 'notice warn' }, w.message))) : h('div', { class: 'muted' }, 'No reconciliation warnings from the last run.'),
      h('div', { class: 'row', style: 'margin-top:.8rem' }, h('button', { class: 'btn', onclick: () => ctx.syncNow({ full: true }) }, 'Re-download full history'))),
    h('div', { class: 'card' }, h('h2', {}, 'Profit share (Schema 2)'),
      h('p', { class: 'muted' }, 'Charged once per month, on the last day, only when the month is positive. Changing it affects the chosen month onward — earlier months keep the percentage they had.'),
      h('div', { class: 'row' }, h('label', {}, 'Percentage ', pctInput, ' %'), h('label', {}, 'Applies from the month of ', fromInput),
        h('button', { class: 'btn primary', id: 'save-pct', onclick: async () => {
          const v = Number(pctInput.value); if (!(v >= 0 && v <= 100)) { toast('Enter a percentage between 0 and 100.', 'error'); return; }
          const from = fromInput.value.slice(0, 7) + '-01';
          try { await api.saveProfitShare(state.userId, v, from); state.schedule = await api.getProfitShareSchedule(); toast('Profit share saved.'); render(container, ctx); } catch (e) { toast('Could not save.', 'error'); console.error(e); } } }, 'Save')),
      h('div', { class: 'muted', style: 'margin-top:.5rem' }, 'History: ', schedule.map((s) => `${s.pct}% from ${fmtDate(s.effectiveFrom)}`).join(' · '))),
    h('div', { class: 'card' }, h('h2', {}, 'Weekly report'),
      h('label', { class: 'field' }, 'Name printed on the report', nameInput),
      h('button', { class: 'btn primary', onclick: async () => { try { await api.saveSettings(state.userId, { report_display_name: nameInput.value.trim() || null }); toast('Saved.'); } catch (e) { toast('Could not save.', 'error'); console.error(e); } } }, 'Save')),
    h('div', { class: 'card' }, h('h2', {}, 'Market data and classification'),
      test('Test the price provider (Yahoo Finance)', async () => { const r = await api.getQuotes(['AAPL']); const q = r.quotes.AAPL; return q.ok ? `Working ✔ AAPL ${q.price} (${q.session}, ${q.asOf})` : `Not available: ${q.reason}`; }),
      h('div', { style: 'height:.5rem' }),
      test('Test TradingView classification', async () => { const r = await api.classify(['AAPL']); const c = r.classifications.AAPL; return c.status === 'ok' ? `Working ✔ AAPL → ${c.sector} / ${c.industry}` : c.reason; })),
    h('div', { class: 'card' }, h('h2', {}, 'Preferences'),
      h('label', { class: 'field' }, 'Default P&L view', h('select', { onchange: (e) => ctx.setSchema(e.target.value, false) }, Object.entries(SCHEMA_LABELS).map(([k, l]) => h('option', { value: k, selected: state.schema === k }, l)))),
      h('p', { class: 'muted' }, 'Times are shown exactly as PropReports reports them. Weeks start on Monday.')),
    h('div', { class: 'card' }, h('button', { class: 'btn danger big', onclick: () => ctx.signOut() }, 'Sign out')));
}
