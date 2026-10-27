// Small DOM + formatting helpers shared by every view. No framework.
import { formatSignedParen } from './engine/format.js';

/** h('div', {class:'x', onclick: fn}, 'text', childEl) */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with static strings we wrote ourselves
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/** 1234.5 -> "1,234.50"; negatives in parentheses like the report; null -> "—" */
export function money(n, { dollar = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const body = dollar ? `$${abs}` : abs;
  return n < 0 ? `(${body})` : body;
}
export const pct = (n, d = 1) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(d)}%`);
export const signClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
export const signed = (n, opts) => h('span', { class: signClass(n) }, money(n, opts));
export const reportNum = formatSignedParen;

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}
/** Timestamps are stored exactly as PropReports reported them (wall-clock labelled UTC), so they are shown in UTC. */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short' })} ${d.toISOString().slice(11, 16)}`;
}
export const isoDay = (d) => d.toISOString().slice(0, 10);

export function toast(message, kind = 'info') {
  const t = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}`, role: 'status' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

/** Opens a modal; returns {close, body}. */
export function openModal(title, bodyNodes, { onClose } = {}) {
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { overlay.remove(); onClose?.(); };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  const body = h('div', {}, bodyNodes);
  overlay.append(h('div', { class: 'modal' }, h('div', { class: 'row between' }, h('h2', {}, title), h('button', { class: 'btn', onclick: close, 'aria-label': 'Close' }, '✕')), body));
  document.body.append(overlay);
  return { close, body };
}

/** Friendly error card — never a stack trace (spec section 44). */
export function errorCard(message, detail) {
  console.error(detail ?? message);
  return h('div', { class: 'notice error' }, message);
}
export const loading = (text = 'Loading…') => h('div', { class: 'empty' }, text);

export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'segmented' });
  for (const [val, label] of options) {
    wrap.append(h('button', { class: val === value ? 'active' : '', type: 'button', onclick: () => onChange(val) }, label));
  }
  return wrap;
}

export const SCHEMA_LABELS = {
  schema1: 'Schema 1 — Report Total (after all fees)',
  schema2: 'Schema 2 — After Profit Share',
  schema3: 'Schema 3 — Pure Trading (before costs)',
};
export const SCHEMA_SHORT = { schema1: 'Schema 1', schema2: 'Schema 2', schema3: 'Schema 3' };

export function schemaSelect(value, onChange) {
  const sel = h('select', { 'aria-label': 'P&L schema', onchange: (e) => onChange(e.target.value) });
  for (const [k, label] of Object.entries(SCHEMA_LABELS)) sel.append(h('option', { value: k, selected: k === value }, label));
  return sel;
}
