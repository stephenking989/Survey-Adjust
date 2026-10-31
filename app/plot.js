// Network plot: stations, observation lines and error ellipses on an SVG you can pan and zoom
// (drag, wheel, or two-finger pinch). North is up. Everything is redrawn in screen pixels on each
// view change so lines, markers and text keep their size while you zoom.
import { connectedPairs } from '../engine/index.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const el = {
  svg: $('plotSvg'), info: $('plotInfo'), names: $('plotNames'), ellipses: $('plotEllipses'),
  relative: $('plotRelative'), lines: $('plotLines'), size: $('plotSize'), fit: $('plotFit'),
  zoomIn: $('plotZoomIn'), zoomOut: $('plotZoomOut'), note: $('plotNote'),
};

let data = null;      // { stations, lines, ellipses, relative, extent, baseExag }
let view = null;      // { cx, cy (world centre, E and N), mpp (metres per pixel) }
let pending = false;

const node = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Called once with the controls; the page redraws on every change. */
export function initPlot() {
  for (const c of [el.names, el.ellipses, el.relative, el.lines]) c.addEventListener('change', draw);
  el.size.addEventListener('input', () => { draw(); label(); });
  el.fit.addEventListener('click', fit);
  el.zoomIn.addEventListener('click', () => zoomBy(1 / 1.5));
  el.zoomOut.addEventListener('click', () => zoomBy(1.5));
  el.svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  gestures();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (data && el.svg.clientWidth) schedule(); }).observe(el.svg);
}

/** out = the 2D or 3D result of runAdjustment. */
export function setPlotData(out) {
  const { result, ellipses, parsed } = out;
  const byName = new Map(result.stations.map((s) => [s.name, s]));
  const lines = connectedPairs(parsed).filter(([a, b]) => byName.has(a) && byName.has(b));
  const es = result.stations.map((s) => s.e); const ns = result.stations.map((s) => s.n);
  const extent = Math.max(Math.max(...es) - Math.min(...es), Math.max(...ns) - Math.min(...ns), 1e-6);
  const biggest = Math.max(1e-9, ...ellipses.stations.map((e) => e.semiMajor));
  data = {
    stations: result.stations, byName, lines, ellipses: new Map(ellipses.stations.map((e) => [e.name, e])), relative: ellipses.relative,
    two: result.type === '2D', extent, baseExag: (0.06 * extent) / biggest, conf: ellipses.confidence, unit: result.units.short,
    bounds: { e0: Math.min(...es), e1: Math.max(...es), n0: Math.min(...ns), n1: Math.max(...ns) },
  };
  el.size.value = '0';
  el.info.textContent = 'Tap a station for details.';
  view = null;
}

/** The exaggeration the slider is set to (slider: -2 .. +2 in powers of ten around the automatic size). */
const exag = () => data.baseExag * 10 ** Number(el.size.value);
function label() { el.note.textContent = data ? `Ellipses at ${Number(data.conf.toFixed(2))}% confidence, drawn ${exag() >= 10 ? Math.round(exag()) : Number(exag().toPrecision(2))} times life size.` : ''; }

export function showPlot() {
  if (!data) return;
  if (!view) fit(); else draw();
  label();
}

function fit() {
  const w = el.svg.clientWidth || 600; const h = el.svg.clientHeight || 400;
  const b = data.bounds;
  const spanE = Math.max(b.e1 - b.e0, data.extent * 0.05); const spanN = Math.max(b.n1 - b.n0, data.extent * 0.05);
  view = { cx: (b.e0 + b.e1) / 2, cy: (b.n0 + b.n1) / 2, mpp: Math.max(spanE / (w * 0.8), spanN / (h * 0.8)) };
  draw();
}

function zoomAt(px, py, factor) {
  if (!view) return;
  const [e, n] = toWorld(px, py);
  view.mpp = Math.min(Math.max(view.mpp * factor, data.extent * 1e-5), data.extent * 10);
  const [e2, n2] = toWorld(px, py);
  view.cx += e - e2; view.cy += n - n2;
  schedule();
}
function zoomBy(factor) { zoomAt(el.svg.clientWidth / 2, el.svg.clientHeight / 2, factor); }

const toScreen = (e, n) => [el.svg.clientWidth / 2 + (e - view.cx) / view.mpp, el.svg.clientHeight / 2 - (n - view.cy) / view.mpp];
function toWorld(px, py) { return [view.cx + (px - el.svg.clientWidth / 2) * view.mpp, view.cy - (py - el.svg.clientHeight / 2) * view.mpp]; }

function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; draw(); });
}

function ellipseNode(cx, cy, major, minor, azimuth, attrs) {
  // The major axis points along azimuth (clockwise from north); SVG's x axis points east, so rotate by azimuth - 90.
  return node('ellipse', { cx, cy, rx: Math.max(major, 0.5), ry: Math.max(minor, 0.5), transform: `rotate(${azimuth - 90} ${cx} ${cy})`, ...attrs });
}

function draw() {
  if (!data || !view) return;
  const w = el.svg.clientWidth; const h = el.svg.clientHeight;
  el.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const g = node('g');
  const k = exag();
  const mute = 'var(--muted)';

  if (el.lines.checked) {
    for (const [a, b] of data.lines) {
      const A = data.byName.get(a); const B = data.byName.get(b);
      const [x1, y1] = toScreen(A.e, A.n); const [x2, y2] = toScreen(B.e, B.n);
      g.append(node('line', { x1, y1, x2, y2, stroke: mute, 'stroke-width': 1, opacity: 0.45 }));
    }
  }
  if (el.relative.checked) {
    for (const r of data.relative) {
      const A = data.byName.get(r.from); const B = data.byName.get(r.to);
      const [x, y] = toScreen((A.e + B.e) / 2, (A.n + B.n) / 2);
      g.append(ellipseNode(x, y, (r.semiMajor * k) / view.mpp, (r.semiMinor * k) / view.mpp, r.azimuth, { fill: 'none', stroke: 'var(--warn-ink)', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }));
    }
  }
  if (el.ellipses.checked) {
    for (const s of data.stations) {
      const e = data.ellipses.get(s.name);
      if (!e) continue;
      const [x, y] = toScreen(s.e, s.n);
      g.append(ellipseNode(x, y, (e.semiMajor * k) / view.mpp, (e.semiMinor * k) / view.mpp, e.azimuth, { fill: 'var(--accent)', 'fill-opacity': 0.12, stroke: 'var(--accent)', 'stroke-width': 1.4 }));
    }
  }
  for (const s of data.stations) {
    const [x, y] = toScreen(s.e, s.n);
    if (x < -40 || y < -40 || x > w + 40 || y > h + 40) continue;
    const held = s.status.slice(0, data.two ? 2 : 3).some((v) => v === 'fixed');
    if (held) g.append(node('path', { d: `M${x} ${y - 6.5} L${x + 6} ${y + 4.5} L${x - 6} ${y + 4.5} Z`, fill: 'var(--ink)', stroke: 'var(--card)', 'stroke-width': 1 }));
    else g.append(node('circle', { cx: x, cy: y, r: 4, fill: 'var(--card)', stroke: 'var(--ink)', 'stroke-width': 1.6 }));
    if (el.names.checked) g.append(node('text', { x: x + 8, y: y - 7, 'font-size': 11, fill: 'var(--ink)', stroke: 'var(--card)', 'stroke-width': 3, 'paint-order': 'stroke', 'font-family': 'system-ui, sans-serif' }, s.name));
  }
  // North arrow and a scale bar of a round length about 100 px wide.
  g.append(node('path', { d: `M${w - 22} ${34} L${w - 22} ${12} M${w - 22} ${12} L${w - 27} ${20} M${w - 22} ${12} L${w - 17} ${20}`, stroke: 'var(--ink)', fill: 'none', 'stroke-width': 1.6 }));
  g.append(node('text', { x: w - 22, y: 48, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink)' }, 'N'));
  const target = view.mpp * 100;
  const mag = 10 ** Math.floor(Math.log10(target));
  const len = [1, 2, 5, 10].map((m) => m * mag).find((m) => m >= target * 0.6) || mag * 10;
  const px = len / view.mpp;
  g.append(node('line', { x1: 12, y1: h - 14, x2: 12 + px, y2: h - 14, stroke: 'var(--ink)', 'stroke-width': 2 }));
  g.append(node('text', { x: 12, y: h - 20, 'font-size': 11, fill: 'var(--ink)' }, `${Number(len.toPrecision(2))} ${(data.unit || 'm')}`));
  el.svg.replaceChildren(g);
}

// ---- Touch and mouse: drag to pan, pinch to zoom, tap a station ------------------------------------

function gestures() {
  const pts = new Map();
  let last = null; let moved = 0; let pinch = 0;
  el.svg.addEventListener('pointerdown', (e) => {
    el.svg.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.offsetX, e.offsetY]);
    moved = 0;
    last = [e.offsetX, e.offsetY];
    if (pts.size === 2) pinch = distance();
  });
  el.svg.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !view) return;
    pts.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pts.size === 2) {
      const d = distance();
      if (pinch) { const [mx, my] = mid(); zoomAt(mx, my, pinch / d); }
      pinch = d; moved += 10;
      return;
    }
    const dx = e.offsetX - last[0]; const dy = e.offsetY - last[1];
    moved += Math.abs(dx) + Math.abs(dy);
    view.cx -= dx * view.mpp; view.cy += dy * view.mpp;
    last = [e.offsetX, e.offsetY];
    schedule();
  });
  const up = (e) => {
    const wasTap = pts.size === 1 && moved < 6;
    pts.delete(e.pointerId);
    pinch = 0;
    if (wasTap) tap(e.offsetX, e.offsetY);
  };
  el.svg.addEventListener('pointerup', up);
  el.svg.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch = 0; });
  const distance = () => { const [a, b] = [...pts.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; };
  const mid = () => { const [a, b] = [...pts.values()]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
}

function tap(px, py) {
  if (!data || !view) return;
  let best = null; let bestD = 18;
  for (const s of data.stations) {
    const [x, y] = toScreen(s.e, s.n);
    const d = Math.hypot(x - px, y - py);
    if (d < bestD) { best = s; bestD = d; }
  }
  if (!best) { el.info.textContent = 'Tap a station for details.'; return; }
  const e = data.ellipses.get(best.name);
  const f = (v) => v.toFixed(4);
  el.info.textContent = data.two
    ? `${best.name}: N ${f(best.n)}  E ${f(best.e)}. Std dev N ${f(best.stdDev[0])}, E ${f(best.stdDev[1])}.`
    : `${best.name}: N ${f(best.n)}  E ${f(best.e)}  Z ${f(best.z)}. Std dev N ${f(best.stdDev[0])}, E ${f(best.stdDev[1])}, Z ${f(best.stdDev[2])}.`
    + (e ? ` Ellipse ${f(e.semiMajor)} x ${f(e.semiMinor)} at azimuth ${e.azimuth.toFixed(1)}°.` : '');
}
