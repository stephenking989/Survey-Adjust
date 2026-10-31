// Survey-Adjust UI. All maths lives in ../engine; this file only wires the page.
import {
  runAdjustment, parseDat, defaultSettings, settingsFromSnproj, linearUnitsFromDat, LINEAR_UNITS,
  AdjustmentError, DatParseError, ENGINE_VERSION,
} from '../engine/index.js';

const $ = (id) => document.getElementById(id);
const el = {
  datInput: $('datInput'), fileInfo: $('fileInfo'), pasteArea: $('pasteArea'), usePaste: $('usePaste'),
  sampleBtn: $('sampleBtn'), snprojInput: $('snprojInput'),
  levelStdErr: $('levelStdErr'), levelUnit: $('levelUnit'), chiPercent: $('chiPercent'),
  stdResFlag: $('stdResFlag'), scaleFactor: $('scaleFactor'),
  adjustBtn: $('adjustBtn'), errorBox: $('errorBox'),
  results: $('results'), verdict: $('verdict'), summary: $('summary'), report: $('report'),
  dlReport: $('dlReport'), csvFormat: $('csvFormat'), dlCsv: $('dlCsv'),
  offlineBadge: $('offlineBadge'), ver: $('ver'),
};
el.ver.textContent = ENGINE_VERSION;

const SETTINGS_KEY = 'survey-adjust:settings:v1';
let job = { name: '', text: '' };   // the loaded .dat
let last = null;                    // the last adjustment output

// ---- Settings persistence (per-device convenience only; may be unavailable) --
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!s) return;
    if (Number.isFinite(s.levelStdErr)) el.levelStdErr.value = s.levelStdErr;
    if (Number.isFinite(s.chiSquarePercent)) el.chiPercent.value = s.chiSquarePercent;
    if (Number.isFinite(s.stdResFlag)) el.stdResFlag.value = s.stdResFlag;
    if (typeof s.errorScaling === 'string') el.scaleFactor.checked = s.errorScaling !== 'never';
  } catch { /* storage blocked or corrupt: fall back to defaults */ }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function readSettings() {
  const s = defaultSettings();
  s.levelStdErr = Number(el.levelStdErr.value);
  s.chiSquarePercent = Number(el.chiPercent.value);
  s.stdResFlag = Number(el.stdResFlag.value);
  s.errorScaling = el.scaleFactor.checked ? 'auto' : 'never';
  s.projectName = job.name || s.projectName;
  return s;
}

function showError(msg) {
  el.errorBox.textContent = msg;
  el.errorBox.hidden = !msg;
}

// ---- Loading a job -----------------------------------------------------------
function setJob(name, text) {
  job = { name: name.replace(/\.[^.]+$/, ''), text };
  el.results.hidden = true;
  showError('');
  try {
    const p = parseDat(text);
    const nL = p.records.filter((r) => r.type === 'L').length;
    const nC = p.records.filter((r) => r.type === 'E' || r.type === 'C').length;
    const unitKey = linearUnitsFromDat(p.state.units) || 'meters';
    const u = LINEAR_UNITS[unitKey];
    el.levelUnit.textContent = `(${u.short} per ${u.perShort})`;
    const lvl = p.state.level ? ` The file sets .LEVEL ${p.state.level.stdErr}.` : '';
    el.fileInfo.textContent = `${name}: ${nL} level runs, ${nC} control points, units ${u.label}.${lvl}`;
    el.adjustBtn.disabled = nL === 0;
    if (nL === 0) showError('That file has no L (differential level) records.');
  } catch (err) {
    el.fileInfo.textContent = name;
    el.adjustBtn.disabled = true;
    showError(err instanceof DatParseError ? err.message : `Could not read the file: ${err.message}`);
  }
}

async function loadFile(file) {
  if (!file) return;
  setJob(file.name, await file.text());
}

el.datInput.addEventListener('change', () => loadFile(el.datInput.files[0]));
el.usePaste.addEventListener('click', () => { if (el.pasteArea.value.trim()) setJob('pasted-job.dat', el.pasteArea.value); });

el.snprojInput.addEventListener('change', async () => {
  const f = el.snprojInput.files[0];
  if (!f) return;
  const s = settingsFromSnproj(await f.text());
  el.levelStdErr.value = Number(s.levelStdErr.toPrecision(10));
  el.chiPercent.value = s.chiSquarePercent;
  showError('');
  el.fileInfo.textContent += ` Settings loaded from ${f.name}.`;
});

el.sampleBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('../tests/fixtures/LEVEL_JOB.dat');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    el.levelStdErr.value = 0.0002;   // from the sample's .snproj
    setJob('LEVEL_JOB.dat', await res.text());
  } catch (err) {
    showError(`Could not load the sample: ${err.message}`);
  }
});

// Desktop PWA: double-clicking a .dat opens it here (see file_handlers in the manifest).
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    try { if (params.files && params.files.length) await loadFile(await params.files[0].getFile()); } catch { /* ignore */ }
  });
}

// ---- Adjust ----------------------------------------------------------------------
const fmt = (x, d) => Number(x).toFixed(d);

function renderResult(out) {
  const { stats } = out.result;
  const ct = stats.chiSquare;
  el.verdict.className = 'verdict ' + (ct && ct.passed ? 'pass' : 'fail');
  el.verdict.textContent = !ct
    ? 'No redundancy - chi-square test not possible'
    : ct.passed
      ? `Chi-square test PASSED at ${out.result.settings.chiSquarePercent}%`
      : `Chi-square test FAILED (${ct.verdict === 'above-upper' ? 'above upper' : 'below lower'} bound)`;

  const cells = [
    ['Stations', stats.nStations], ['Observations', stats.nObservations], ['Unknowns', stats.nUnknowns],
    ['Redundancy', stats.dof], ['Sum sq. StdRes', fmt(stats.sumSqStdRes, 3)], ['Error factor', stats.dof > 0 ? fmt(stats.errorFactor, 3) : 'n/a'],
    ['Bounds', ct ? `${fmt(ct.lowerBound, 3)} / ${fmt(ct.upperBound, 3)}` : 'n/a'], ['|StdRes| flagged', stats.nFlagged],
  ];
  el.summary.replaceChildren(...cells.map(([k, v]) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    d.append(dt, dd);
    return d;
  }));

  const frag = document.createDocumentFragment();
  for (const line of out.report.lines) {
    const s = document.createElement('span');
    s.className = 'ln' + (line.tag ? ' ' + line.tag : '');
    s.textContent = line.text === '' ? ' ' : line.text;
    frag.appendChild(s);
  }
  el.report.replaceChildren(frag);
  el.results.hidden = false;
}

el.adjustBtn.addEventListener('click', () => {
  showError('');
  const settings = readSettings();
  if (!(settings.levelStdErr > 0)) { showError('Enter a level std error greater than zero.'); return; }
  if (!(settings.chiSquarePercent > 0 && settings.chiSquarePercent < 100)) { showError('Chi-square level must be between 0 and 100 %.'); return; }
  try {
    last = runAdjustment(job.text, settings, { projectName: job.name, dataFiles: [job.name + '.dat'] });
    last.projectName = job.name || 'adjustment';
    saveSettings(settings);
    renderResult(last);
    el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    el.results.hidden = true;
    last = null;
    showError(err instanceof AdjustmentError || err instanceof DatParseError ? err.message : `Unexpected error: ${err.message}`);
  }
});

// ---- Downloads -----------------------------------------------------------------------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
el.dlReport.addEventListener('click', () => {
  if (last) download(`${last.projectName}.lst`, last.report.text.replace(/\n/g, '\r\n'), 'text/plain');
});
el.dlCsv.addEventListener('click', () => {
  if (!last) return;
  const fmtKey = el.csvFormat.value;
  download(`${last.projectName}_${fmtKey}.csv`, last.csv(fmtKey), 'text/csv');
});

// ---- Offline support -----------------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('../sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => { el.offlineBadge.hidden = false; })
    .catch(() => { /* e.g. file:// or private mode - the app still works online */ });
}

loadSettings();
