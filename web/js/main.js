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
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  startApp({ api: createApi(sb), root, pdf: browserPdf() }).boot();
}
