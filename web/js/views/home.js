// Intro page, opened from the "Trading Journal" logo. Deliberately simple for now: a pink welcome
// with room for an image. To use your own picture, put it in web/assets/ as intro.jpg (or .png and
// change INTRO_IMAGE below) — until the file exists, the pink panel is shown on its own.
import { h, clear } from '../lib.js';
import { parseAccountLabel } from '../engine/weeklyReport.js';

const INTRO_IMAGE = 'assets/intro.jpg';

export async function render(container, ctx) {
  const name = ctx.state.account ? parseAccountLabel(ctx.state.account.account_code, ctx.state.account.propreports_account_name).name : '';
  const art = h('div', { class: 'intro-art' });
  const img = document.createElement('img');
  img.alt = '';
  img.onload = () => { art.classList.add('has-image'); art.append(img); };
  img.src = INTRO_IMAGE;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  clear(container).append(h('section', { class: 'intro', id: 'intro' },
    art,
    h('div', { class: 'intro-text' },
      h('div', { class: 'intro-kicker' }, today),
      h('h1', {}, name ? `Hi ${name.split(' ')[0]} 💗` : 'Hi there 💗'),
      h('p', {}, 'Your trading journal. Pick up where you left off.'),
      h('div', { class: 'intro-links' },
        [['dashboard', 'Dashboard'], ['positions', 'Current positions'], ['calendar', 'Calendar'], ['weekly', 'Weekly report']]
          .map(([id, label]) => h('button', { class: 'btn intro-btn', onclick: () => ctx.navigate(id) }, label))))));
}
