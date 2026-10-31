// The results pages: summary (with advice), the full listing, residuals, adjusted points, messages.
import { adviseOnAdjustment, worstResiduals, RHO_ARCSEC } from '../engine/index.js';
import { initPlot, setPlotData, showPlot } from './plot.js';

const $ = (id) => document.getElementById(id);
const el = {
  verdict: $('verdict'), summary: $('summary'), advice: $('advice'), classes: $('classes'),
  report: $('report'), jump: $('jump'),
  resSort: $('resSort'), resFilter: $('resFilter'), resTable: $('resTable'),
  ptsTable: $('ptsTable'), messages: $('messages'), msgCount: $('msgCount'),
  seg: document.querySelector('.seg'),
};

const fmt = (x, d) => Number(x).toFixed(d);
const make = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

let shown = null;          // { out, openLine }

export function showPage(name) {
  for (const b of el.seg.querySelectorAll('.seg-btn')) b.setAttribute('aria-current', String(b.dataset.page === name));
  for (const p of document.querySelectorAll('#view-results .page')) p.hidden = p.id !== `page-${name}`;
  if (name === 'plot') showPlot();
}

export function initResults() {
  initPlot();
  el.seg.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) showPage(b.dataset.page);
  });
  el.resSort.addEventListener('change', () => shown && renderResiduals());
  el.resFilter.addEventListener('change', () => shown && renderResiduals());
  el.jump.addEventListener('change', () => {
    const child = el.report.children[Number(el.jump.value)];
    if (child) el.report.scrollTop = Math.max(0, child.offsetTop - 4);
  });
}

/** out = result of runAdjustment; openLine(fileIndex, line) opens the editor there. */
export function renderResults(out, openLine) {
  shown = { out, openLine };
  renderSummary();
  renderListing();
  renderResiduals();
  renderPoints();
  renderMessages();
  $('plotTab').hidden = out.kind !== '3d';
  if (out.kind === '3d') setPlotData(out);
  showPage('summary');
}

// ---- Summary ---------------------------------------------------------------------------------

function renderSummary() {
  const { out } = shown;
  const { stats, settings } = out.result;
  const ct = stats.chiSquare;
  el.verdict.className = 'verdict ' + (ct && ct.passed ? 'pass' : 'fail');
  el.verdict.textContent = !ct
    ? 'No redundancy - chi-square test not possible'
    : ct.passed
      ? `Chi-square test PASSED at ${settings.chiSquarePercent}%`
      : `Chi-square test FAILED (${ct.verdict === 'above-upper' ? 'above upper' : 'below lower'} bound)`;

  const cells = [
    ['Stations', stats.nStations], ['Observations', stats.nObservations], ['Unknowns', stats.nUnknowns],
    ['Redundancy', stats.dof], ['Sum sq. StdRes', fmt(stats.sumSqStdRes, 3)], ['Error factor', stats.dof > 0 ? fmt(stats.errorFactor, 3) : 'n/a'],
    ['Bounds', ct ? `${fmt(ct.lowerBound, 3)} / ${fmt(ct.upperBound, 3)}` : 'n/a'], ['|StdRes| flagged', stats.nFlagged],
  ];
  if (out.kind === '3d') cells.push(['Iterations', out.result.iterations]);
  el.summary.replaceChildren(...cells.map(([k, v]) => make('div', {}, make('dt', { textContent: k }), make('dd', { textContent: v }))));

  el.advice.replaceChildren(...adviseOnAdjustment(out).map((n) => make('p', { className: n.level === 'warn' ? 'warn' : '', textContent: n.text })));

  // Error factor by type of observation (3D): where the misfit is.
  if (stats.classes && stats.classes.length) {
    const t = make('table', { className: 'data' });
    t.append(make('tr', {}, ...['Type', 'Count', 'Sum sq. StdRes', 'Error factor'].map((h, i) => make('th', { textContent: h, className: i === 0 ? 'l' : '' }))));
    for (const c of stats.classes) {
      t.append(make('tr', {}, make('td', { textContent: c.name }), make('td', { textContent: c.count }), make('td', { textContent: fmt(c.sumSq, 3) }), make('td', { textContent: fmt(Math.sqrt(c.sumSq / c.count), 3) })));
    }
    el.classes.replaceChildren(make('h3', { textContent: 'By type of observation' }), make('div', { className: 'table-wrap' }, t));
  } else {
    el.classes.replaceChildren();
  }
}

// ---- Listing ----------------------------------------------------------------------------------

function renderListing() {
  const { out } = shown;
  const lines = out.report.lines;
  const frag = document.createDocumentFragment();
  const sections = [];
  lines.forEach((line, i) => {
    const s = make('span', { className: 'ln' + (line.tag ? ' ' + line.tag : ''), textContent: line.text === '' ? ' ' : line.text });
    frag.appendChild(s);
    // A section title is a line followed by a line of "=" signs.
    const next = lines[i + 1];
    if (line.text.trim() && next && /^\s*=+\s*$/.test(next.text)) sections.push({ title: line.text.trim(), index: i });
  });
  el.report.replaceChildren(frag);
  el.jump.replaceChildren(make('option', { value: '0', textContent: 'Top' }), ...sections.map((s) => make('option', { value: String(s.index), textContent: s.title })));
  el.report.scrollTop = 0;
}

// ---- Residuals --------------------------------------------------------------------------------

/** Residual in a readable unit: arc-seconds for angles, the project length unit for the rest. */
function residualText(out, row) {
  const angular = ['Direction', 'Zenith', 'Angle', 'Azimuth'].includes(row.type);
  return angular ? `${fmt(row.residual * RHO_ARCSEC, 1)}"` : fmt(row.residual, 4);
}

function renderResiduals() {
  const { out, openLine } = shown;
  const rows = worstResiduals(out, Infinity);
  const filter = el.resFilter.value;
  let list = rows;
  if (filter === 'flagged') list = rows.filter((r) => r.flagged);
  if (el.resSort.value === 'file') list = list.slice().sort((a, b) => (a.file || 0) - (b.file || 0) || (a.line || 0) - (b.line || 0));
  if (filter === 'top') list = el.resSort.value === 'file' ? rows.slice(0, 25).sort((a, b) => (a.file || 0) - (b.file || 0) || (a.line || 0) - (b.line || 0)) : rows.slice(0, 25);

  const t = el.resTable;
  t.replaceChildren(make('tr', {}, ...['Type', 'Observation', 'Residual', 'StdRes', 'Line'].map((h, i) => make('th', { textContent: h, className: i < 2 ? 'l' : '' }))));
  if (!list.length) {
    t.append(make('tr', {}, make('td', { colSpan: 5, textContent: 'Nothing to show.' })));
    return;
  }
  const names = out.parsed.files.map((f) => f.name);
  const multi = names.length > 1;
  for (const r of list) {
    const tr = make('tr', { className: (r.flagged ? 'flag ' : '') + (r.line ? 'click' : '') },
      make('td', { textContent: r.type, className: 'l' }), make('td', { textContent: r.label, className: 'l' }),
      make('td', { textContent: residualText(out, r) }), make('td', { textContent: fmt(r.stdRes, 2) }),
      make('td', { textContent: r.line ? `${multi ? names[r.file - 1] + ':' : ''}${r.line}` : '' }));
    if (r.line) {
      tr.tabIndex = 0;
      const go = () => openLine(r.file, r.line);
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    }
    t.append(tr);
  }
}

// ---- Adjusted points ----------------------------------------------------------------------------

function renderPoints() {
  const { out } = shown;
  const t = el.ptsTable;
  const u = out.result.units;
  const r = out.result;
  if (out.kind === 'level') {
    t.replaceChildren(
      make('tr', {}, ...['Station', `Elevation (${u.short})`, `Std dev (${u.short})`, 'Control'].map((h, i) => make('th', { textContent: h, className: i === 0 || i === 3 ? 'l' : '' }))),
      ...r.stations.map((s) => make('tr', {}, make('td', { textContent: s.name }), make('td', { textContent: fmt(s.elevation, 5) }), make('td', { textContent: fmt(s.stdDev, 5) }), make('td', { textContent: s.status === 'fixed' ? 'fixed' : s.status === 'weighted' ? 'weighted' : '', className: 'l' }))),
    );
    return;
  }
  const en = out.parsed.state.order === 'EN';
  const head = en ? ['E', 'N'] : ['N', 'E'];
  t.replaceChildren(
    make('tr', {}, ...['Station', ...head, 'Z', `σ ${head[0]}`, `σ ${head[1]}`, 'σ Z'].map((h, i) => make('th', { textContent: h, className: i === 0 ? 'l' : '' }))),
    ...r.stations.map((s) => {
      const c = en ? [s.e, s.n, s.z] : [s.n, s.e, s.z];
      const sd = en ? [s.stdDev[1], s.stdDev[0], s.stdDev[2]] : s.stdDev;
      return make('tr', {}, make('td', { textContent: s.name }), ...c.map((v) => make('td', { textContent: fmt(v, 4) })), ...sd.map((v) => make('td', { textContent: fmt(v, 4) })));
    }),
  );
}

// ---- Messages -------------------------------------------------------------------------------------

function renderMessages() {
  const { out, openLine } = shown;
  const names = out.parsed.files.map((f) => f.name);
  const items = out.result.warnings;
  el.msgCount.textContent = items.length ? `(${items.length})` : '';
  if (!items.length) {
    el.messages.replaceChildren(make('div', { className: 'ok', textContent: 'No warnings.' }));
    return;
  }
  el.messages.replaceChildren(...items.map((w) => {
    const b = make('button', { type: 'button', className: 'item ' + (w.note ? 'note' : 'warning'), disabled: !w.line });
    if (w.line) {
      b.append(make('span', { className: 'where', textContent: `${names[(w.file || 1) - 1] || ''} line ${w.line}` }));
      b.addEventListener('click', () => openLine(w.file || 1, w.line));
    }
    b.append(w.message);
    return b;
  }));
}
