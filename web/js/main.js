import { createApi } from './api.js';
import { startApp } from './app.js';
import { browserPdf } from './pdf.js';
import { h, clear } from './lib.js';

const root = document.getElementById('app');
const cfg = window.APP_CONFIG ?? {};
if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) {
  clear(root).append(h('div', { class: 'login-wrap card' }, h('h2', {}, 'Almost there'),
    h('p', {}, 'The site is running, but it is not connected to Supabase yet. Follow the setup guide (step “Connect the website to Supabase”): add the two repository variables SUPABASE_URL and SUPABASE_ANON_KEY, then re-run the “Deploy website” action.')));
} else {
  // Accept the URL however it was pasted: the supabase client adds /rest/v1, /auth/v1 and /functions/v1 itself,
  // so a value copied from the Data API page (".../rest/v1/") would send every request to the wrong place.
  const url = String(cfg.SUPABASE_URL).trim().replace(/\/(rest|auth|functions)\/v1\/?$/i, '').replace(/\/+$/, '');
  const sb = window.supabase.createClient(url, cfg.SUPABASE_ANON_KEY.trim());
  startApp({ api: createApi(sb), root, pdf: browserPdf() }).boot();
}
