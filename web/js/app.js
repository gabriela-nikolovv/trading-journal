// Application shell: sign-in → first-time setup → tabs, with a sync bar visible on every page.
// startApp() takes its dependencies as arguments so the whole thing can be driven by a fake api in tests.
import { h, clear, toast, errorCard } from './lib.js';
import * as dashboard from './views/dashboard.js';
import * as positions from './views/positions.js';
import * as calendar from './views/calendar.js';
import * as trades from './views/trades.js';
import * as weekly from './views/weekly.js';
import * as settings from './views/settings.js';

export const TABS = [
  ['dashboard', 'Dashboard', dashboard], ['positions', 'Current Positions', positions], ['calendar', 'Calendar', calendar],
  ['trades', 'Trades', trades], ['weekly', 'Weekly Report', weekly], ['settings', 'Settings', settings],
];

export function startApp({ api, root, pdf, store = globalThis.localStorage, autoSync = true }) {
  const state = { session: null, userId: null, account: null, schema: store?.getItem('schema') ?? 'schema1', schedule: [], classifyTried: new Set(), tab: 'dashboard' };
  let viewEl = null, syncEl = null, syncing = false;

  const ctx = {
    api, state, pdf,
    setSchema(v, rerender = true) { state.schema = v; try { store?.setItem('schema', v); } catch { /* storage can be unavailable */ } if (rerender) show(state.tab); },
    syncNow,
    async signOut() { await api.signOut(); },
    navigate: (tab) => { location.hash = `#/${tab}`; },
  };

  // ---------- sign-in ----------
  function renderLogin(message) {
    const email = h('input', { type: 'email', name: 'username', id: 'email', autocomplete: 'username', required: true });
    const password = h('input', { type: 'password', name: 'password', id: 'password', autocomplete: 'current-password', required: true });
    const err = h('div', {});
    const form = h('form', { class: 'login-wrap card', onsubmit: async (e) => {
      e.preventDefault(); clear(err);
      try { await api.signIn(email.value.trim(), password.value); await boot(); } catch (ex) { err.append(errorCard(ex.message)); }
    } },
      h('div', { class: 'brand', style: 'font-size:1.5rem;margin-bottom:.5rem' }, 'Trading ', h('span', {}, 'Journal')),
      message ? h('div', { class: 'notice' }, message) : null,
      h('label', { class: 'field' }, 'Email', email), h('label', { class: 'field' }, 'Password', password), err,
      h('button', { class: 'btn primary big', type: 'submit', id: 'login-btn', style: 'width:100%' }, 'Sign in'));
    clear(root).append(form);
  }

  // ---------- first-time setup ----------
  function renderSetup() {
    const out = h('div', {});
    const go = h('button', { class: 'btn primary big', id: 'connect-btn', onclick: async () => {
      go.disabled = true; clear(out).append(h('div', { class: 'notice' }, 'Checking your PropReports connection…'));
      try {
        await api.setupAccount();
        state.account = await api.getAccount();
        clear(out).append(h('div', { class: 'notice' }, 'Connected. Downloading your full trading history — this can take a minute…'));
        await syncNow({ full: true, quiet: true, skipShell: true });
        await boot();
      } catch (e) { go.disabled = false; clear(out).append(errorCard(e.message)); }
    } }, 'Connect PropReports and download my history');
    clear(root).append(h('div', { class: 'login-wrap card', style: 'max-width:560px' },
      h('h1', {}, 'Welcome 💗'), h('p', {}, 'One last step. The journal will ask PropReports which account your token can read, then download all of your trading history automatically. You never upload anything.'),
      h('p', { class: 'muted' }, 'Your PropReports token is stored only as a server-side secret — it is never typed into or sent to this page.'), go, out,
      h('div', { style: 'margin-top:1rem' }, h('button', { class: 'btn', onclick: () => api.signOut() }, 'Sign out'))));
  }

  // ---------- shell ----------
  function renderShell() {
    syncEl = h('div', { class: 'syncbar', id: 'syncbar' });
    viewEl = h('main', { id: 'view' });
    const tabs = h('nav', { class: 'tabs' }, TABS.map(([id, label]) => h('button', { class: 'tab', 'data-tab': id, onclick: () => ctx.navigate(id) }, label)));
    clear(root).append(h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' }, h('div', { class: 'brand' }, 'Trading ', h('span', {}, 'Journal')), tabs, syncEl)), viewEl);
  }

  async function show(tab) {
    state.tab = TABS.some((t) => t[0] === tab) ? tab : 'dashboard';
    for (const b of root.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === state.tab);
    const mod = TABS.find((t) => t[0] === state.tab)[2];
    try { await mod.render(viewEl, ctx); }
    catch (e) { clear(viewEl).append(errorCard('Something went wrong showing this page. Your data is safe.', e)); }
  }

  async function refreshStatus() {
    if (!syncEl || !state.account) return;
    let s;
    try { s = await api.getSyncStatus(state.account.id); } catch { return; }
    const st = s.state;
    const warnCount = Array.isArray(s.lastRun?.warnings) ? s.lastRun.warnings.length : 0;
    const label = syncing || st?.status === 'running' ? ['Syncing…', 'run'] : st?.status === 'failed' ? ['Sync failed', 'fail'] : st?.last_success_at ? ['Synced', 'ok'] : ['Not synced yet', ''];
    clear(syncEl).append(
      h('span', { class: `pill ${label[1]}`, id: 'sync-pill' }, label[0]),
      st?.last_success_at ? h('span', { class: 'muted', id: 'sync-time' }, `Last sync ${new Date(st.last_success_at).toLocaleString()}`) : null,
      s.lastRun && s.lastRun.status === 'success' ? h('span', { class: 'muted' }, `${s.lastRun.fills_new} new · ${s.lastRun.fills_updated} updated`) : null,
      warnCount ? h('span', { class: 'pill warn', title: 'Open Settings to see the reconciliation warnings' }, `${warnCount} warning${warnCount > 1 ? 's' : ''}`) : null,
      st?.status === 'failed' && st.last_error ? h('span', { class: 'pill fail', title: st.last_error }, 'Previous data kept') : null,
      h('button', { class: 'btn primary', id: 'sync-now', disabled: syncing, onclick: () => syncNow({}) }, 'SYNC NOW'));
  }

  async function syncNow({ full = false, quiet = false, skipShell = false } = {}) {
    if (syncing) return;
    syncing = true; if (!skipShell) refreshStatus();
    try {
      const r = await api.runSync({ full });
      if (!quiet) toast(`Synced — ${r.fillsNew ?? 0} new, ${r.fillsUpdated ?? 0} updated, ${r.openPositions ?? 0} open position(s).`);
    } catch (e) { toast(`${e.message} Your previous data is still available.`, 'error'); console.error(e); }
    finally { syncing = false; if (!skipShell) { await refreshStatus(); if (viewEl) show(state.tab); } }
  }

  async function ensureSchedule() {
    let sched = await api.getProfitShareSchedule();
    if (sched.length === 0) { await api.saveProfitShare(state.userId, 50, '2000-01-01'); sched = await api.getProfitShareSchedule(); } // default 50%, editable in Settings
    state.schedule = sched;
  }

  async function boot() {
    try {
      const session = await api.getSession();
      if (!session) { renderLogin(); return; }
      state.session = session; state.userId = session.user.id;
      state.account = await api.getAccount();
      if (!state.account) { renderSetup(); return; }
      await ensureSchedule();
      renderShell();
      await refreshStatus();
      show(location.hash.replace('#/', '') || 'dashboard');
      if (autoSync) syncNow({ full: false });   // sync automatically every time the site is opened
    } catch (e) { clear(root).append(h('div', { class: 'login-wrap' }, errorCard('The journal could not start. Please reload the page.', e))); }
  }

  window.addEventListener('hashchange', () => { if (viewEl) show(location.hash.replace('#/', '') || 'dashboard'); });
  api.onAuthChange?.((session) => { if (!session) renderLogin(); });
  return { boot, ctx };
}
