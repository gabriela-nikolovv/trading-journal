// Home page, opened from the "Trading Journal" logo: the trading rules to read before each session.
// The rules are written by the user and stored in `trading_rules` (migration 0008) — kept until deleted.
// Each rule is a card in a row of cards (like the Dashboard's); tapping a card shows Edit / Delete.
import { h, clear, toast } from '../lib.js';

export async function render(container, ctx) {
  const { api, state } = ctx;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  let rules = [];
  let loadError = false;
  try { rules = await api.getRules(); } catch (e) { loadError = true; console.error(e); }
  let editing = null;   // rule id being edited, or 'new'
  let confirming = null; // rule id waiting for "Delete?" confirmation
  let selected = null;   // rule id whose Edit / Delete are shown (after a tap)

  const list = h('ol', { class: 'rules', id: 'rules' });
  const addBtn = h('button', { class: 'btn primary small rules-add', id: 'add-rule', onclick: () => { editing = 'new'; confirming = null; selected = null; draw(); } }, '+ Add rule');

  function editor(initial, onSave) {
    const box = h('textarea', { class: 'rule-input', rows: 2, placeholder: 'e.g. No new positions after 15:30.', 'aria-label': 'Rule' });
    box.value = initial;
    const save = async () => {
      if (!box.value.trim()) { toast('Write the rule first.', 'error'); return; }
      try { await onSave(box.value); editing = null; draw(); } catch (e) { toast('Could not save the rule.', 'error'); console.error(e); }
    };
    const cancel = () => { editing = null; draw(); };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') cancel();
    });
    setTimeout(() => { box.focus(); box.setSelectionRange?.(box.value.length, box.value.length); }, 0);
    return h('div', { class: 'rule-edit' }, box,
      h('div', { class: 'rule-actions' },
        h('button', { class: 'btn primary small', onclick: save }, 'Save'),
        h('button', { class: 'btn small', onclick: cancel }, 'Cancel')));
  }

  async function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= rules.length) return;
    [rules[i], rules[j]] = [rules[j], rules[i]];
    draw();
    try { await api.reorderRules(rules.map((r) => r.id)); } catch (e) { toast('Could not save the new order.', 'error'); console.error(e); }
  }

  function card(r, i) {
    if (editing === r.id) {
      return h('li', { class: 'rule-card editing', 'data-id': r.id }, editor(r.text, async (text) => { await api.updateRule(r.id, text); r.text = text.trim(); }));
    }
    const actions = confirming === r.id
      ? h('div', { class: 'rule-actions' },
        h('span', { class: 'muted small' }, 'Delete this rule?'),
        h('button', { class: 'btn small danger', onclick: async () => {
          try { await api.deleteRule(r.id); rules = rules.filter((x) => x.id !== r.id); confirming = null; draw(); } catch (e) { toast('Could not delete the rule.', 'error'); console.error(e); }
        } }, 'Delete'),
        h('button', { class: 'btn small', onclick: () => { confirming = null; draw(); } }, 'Keep'))
      : h('div', { class: 'rule-actions' },
        h('button', { class: 'link-btn', title: 'Move earlier', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '←'),
        h('button', { class: 'link-btn', title: 'Move later', 'aria-label': 'Move down', disabled: i === rules.length - 1, onclick: () => move(i, 1) }, '→'),
        h('button', { class: 'link-btn', onclick: () => { editing = r.id; confirming = null; selected = null; draw(); } }, 'Edit'),
        h('button', { class: 'link-btn', onclick: () => { confirming = r.id; editing = null; draw(); } }, 'Delete'));
    const open = selected === r.id || confirming === r.id;
    const li = h('li', { class: `rule-card${open ? ' selected' : ''}`, 'data-id': r.id, tabindex: 0 }, h('p', { class: 'rule-text' }, r.text), open ? actions : null);
    const toggle = (e) => { if (e.target.closest('button')) return; selected = open ? null : r.id; confirming = null; draw(); };
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
    return li;
  }

  function draw() {
    clear(list);
    rules.forEach((r, i) => list.append(card(r, i)));
    if (editing === 'new') {
      list.append(h('li', { class: 'rule-card editing' },
        editor('', async (text) => {
          const position = rules.length;
          const id = await api.addRule(state.userId, text, position);
          rules.push({ id, text: text.trim(), position });
        })));
    }
    empty.classList.toggle('hidden', rules.length > 0 || editing === 'new' || loadError);
  }

  const empty = h('p', { class: 'rules-empty muted' }, 'No rules yet. Add the boundaries you want to read before every session.');
  clear(container).append(h('section', { class: 'intro', id: 'intro' },
    h('div', { class: 'rules-head' },
      h('div', {}, h('div', { class: 'intro-kicker' }, today), h('h1', {}, 'Rules')),
      addBtn),
    loadError ? h('p', { class: 'notice' }, 'Your rules could not be loaded. Check your connection and open this page again.') : null,
    empty, list));
  draw();
}
