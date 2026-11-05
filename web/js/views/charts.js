// Dependency-free SVG line chart that handles negative values (spec section 19):
// the axis is NOT forced to start at zero, a zero line is always drawn, and the area between
// the line and zero is tinted green above / red below so negative periods are obvious.
const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => { const e = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

/** @param {{label:string,value:number}[]} points */
export function lineChart(points, { width = 900, height = 280, format = (v) => v.toFixed(0) } = {}) {
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': 'Performance chart', preserveAspectRatio: 'none' });
  if (points.length === 0) return svg;
  const pad = { l: 56, r: 12, t: 12, b: 24 };
  const vals = points.map((p) => p.value);
  let min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  if (min === max) { min -= 1; max += 1; }
  const margin = (max - min) * 0.08; min -= margin; max += margin;
  const x = (i) => pad.l + (points.length === 1 ? (width - pad.l - pad.r) / 2 : (i * (width - pad.l - pad.r)) / (points.length - 1));
  const y = (v) => pad.t + ((max - v) * (height - pad.t - pad.b)) / (max - min);
  const zeroY = y(0);

  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    svg.append(el('line', { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), stroke: '#eceef2' }));
    const t = el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#6b7280' });
    t.textContent = format(v); svg.append(t);
  }
  const d = `M${x(0)},${zeroY} ${points.map((p, i) => `L${x(i)},${y(p.value)}`).join(' ')} L${x(points.length - 1)},${zeroY} Z`;
  const defs = el('defs');
  const cAbove = el('clipPath', { id: 'clipAbove' }); cAbove.append(el('rect', { x: 0, y: 0, width, height: Math.max(0, zeroY) }));
  const cBelow = el('clipPath', { id: 'clipBelow' }); cBelow.append(el('rect', { x: 0, y: zeroY, width, height: Math.max(0, height - zeroY) }));
  defs.append(cAbove, cBelow); svg.append(defs);
  svg.append(el('path', { d, fill: 'rgba(22,128,60,.16)', 'clip-path': 'url(#clipAbove)' }));
  svg.append(el('path', { d, fill: 'rgba(192,57,43,.18)', 'clip-path': 'url(#clipBelow)' }));
  svg.append(el('line', { x1: pad.l, x2: width - pad.r, y1: zeroY, y2: zeroY, stroke: '#9aa0ad', 'stroke-dasharray': '4 3' }));
  svg.append(el('polyline', { points: points.map((p, i) => `${x(i)},${y(p.value)}`).join(' '), fill: 'none', stroke: '#e0218a', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
  for (const [i, anchor] of [[0, 'start'], [points.length - 1, 'end']]) {
    const t = el('text', { x: x(i), y: height - 6, 'text-anchor': anchor, 'font-size': 11, fill: '#6b7280' }); t.textContent = points[i].label; svg.append(t);
  }
  svg.append(el('circle', { cx: x(points.length - 1), cy: y(points.at(-1).value), r: 4, fill: '#e0218a' }));
  return svg;
}

const DAY = 86400000;
const t = (iso) => Date.parse(`${iso}T00:00:00Z`);
let uid = 0;

/**
 * Time-scaled chart: x is the calendar date between `from` and `to` (YYYY-MM-DD), so a window can be
 * dragged smoothly across time. Same negative-value handling as lineChart.
 * @param {{date:string,value:number}[]} points  already limited to the window, cumulative
 */
export function timeChart(points, { from, to, width = 900, height = 280, format = (v) => v.toFixed(0) } = {}) {
  const id = `c${++uid}`;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': 'Performance chart', preserveAspectRatio: 'none' });
  const pad = { l: 56, r: 12, t: 12, b: 24 };
  const x0 = t(from), x1 = Math.max(t(to), x0 + DAY);
  const x = (iso) => pad.l + ((t(iso) - x0) * (width - pad.l - pad.r)) / (x1 - x0);
  const vals = points.map((p) => p.value);
  let min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  if (min === max) { min -= 1; max += 1; }
  const m = (max - min) * 0.08; min -= m; max += m;
  const y = (v) => pad.t + ((max - v) * (height - pad.t - pad.b)) / (max - min);
  const zeroY = y(0);
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    svg.append(el('line', { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), stroke: '#eceef2' }));
    const tx = el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#6b7280' }); tx.textContent = format(v); svg.append(tx);
  }
  // date ticks
  const fmt = (ms) => new Date(ms).toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', ...(x1 - x0 > 200 * DAY ? { year: '2-digit' } : {}) });
  for (let i = 0; i <= 4; i++) {
    const ms = x0 + ((x1 - x0) * i) / 4;
    const tx = el('text', { x: pad.l + ((width - pad.l - pad.r) * i) / 4, y: height - 6, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', 'font-size': 11, fill: '#6b7280' });
    tx.textContent = fmt(ms); svg.append(tx);
  }
  svg.append(el('line', { x1: pad.l, x2: width - pad.r, y1: zeroY, y2: zeroY, stroke: '#9aa0ad', 'stroke-dasharray': '4 3' }));
  if (!points.length) return svg;
  const first = x(points[0].date), last = x(points.at(-1).date);
  const d = `M${first},${zeroY} ${points.map((p) => `L${x(p.date)},${y(p.value)}`).join(' ')} L${last},${zeroY} Z`;
  const defs = el('defs');
  const cA = el('clipPath', { id: `${id}a` }); cA.append(el('rect', { x: 0, y: 0, width, height: Math.max(0, zeroY) }));
  const cB = el('clipPath', { id: `${id}b` }); cB.append(el('rect', { x: 0, y: zeroY, width, height: Math.max(0, height - zeroY) }));
  defs.append(cA, cB); svg.append(defs);
  svg.append(el('path', { d, fill: 'rgba(22,128,60,.16)', 'clip-path': `url(#${id}a)` }));
  svg.append(el('path', { d, fill: 'rgba(192,57,43,.18)', 'clip-path': `url(#${id}b)` }));
  svg.append(el('polyline', { points: points.map((p) => `${x(p.date)},${y(p.value)}`).join(' '), fill: 'none', stroke: '#e0218a', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
  svg.append(el('circle', { cx: last, cy: y(points.at(-1).value), r: 4, fill: '#e0218a' }));
  return svg;
}
