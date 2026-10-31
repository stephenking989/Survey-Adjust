// Survey-Adjust UI. All maths lives in ../engine; this file only wires the page.
import {
  runAdjustment, parseDat, detectKind, defaultSettings, settingsFromSnproj, linearUnitsFromDat, LINEAR_UNITS,
  AdjustmentError, DatParseError, ENGINE_VERSION,
} from '../engine/index.js';

const $ = (id) => document.getElementById(id);
const el = {
  datInput: $('datInput'), fileInfo: $('fileInfo'), pasteArea: $('pasteArea'), usePaste: $('usePaste'),
  sampleBtn: $('sampleBtn'), sample3dBtn: $('sample3dBtn'), snprojInput: $('snprojInput'),
  kindInfo: $('kindInfo'), levelFields: $('levelFields'), tsFields: $('tsFields'), insUnit: $('insUnit'),
  levelStdErr: $('levelStdErr'), levelUnit: $('levelUnit'), chiPercent: $('chiPercent'),
  stdResFlag: $('stdResFlag'), scaleFactor: $('scaleFactor'),
  insDist: $('insDist'), insPpm: $('insPpm'), insDir: $('insDir'), insZen: $('insZen'), insAng: $('insAng'), insAz: $('insAz'),
  cenI: $('cenI'), cenT: $('cenT'), cenV: $('cenV'), refr: $('refr'),
  adjustBtn: $('adjustBtn'), errorBox: $('errorBox'),
  results: $('results'), verdict: $('verdict'), summary: $('summary'), report: $('report'),
  dlReport: $('dlReport'), csvFormat: $('csvFormat'), dlCsv: $('dlCsv'),
  offlineBadge: $('offlineBadge'), ver: $('ver'),
};
el.ver.textContent = ENGINE_VERSION;

const SETTINGS_KEY = 'survey-adjust:settings:v2';
let job = { name: '', text: '', kind: null, unitKey: 'meters' };   // the loaded .dat
let last = null;                                                  // the last adjustment output

// Fields that hold the 3D instrument, keyed by the engine's setting names.
const INSTRUMENT_FIELDS = {
  distanceConstant: el.insDist, distancePpm: el.insPpm, direction: el.insDir, zenith: el.insZen,
  angle: el.insAng, azimuth: el.insAz, centeringInstrument: el.cenI, centeringTarget: el.cenT, centeringVertical: el.cenV,
};

function putSettings(s) {
  if (Number.isFinite(s.levelStdErr)) el.levelStdErr.value = Number(s.levelStdErr.toPrecision(10));
  if (Number.isFinite(s.chiSquarePercent)) el.chiPercent.value = s.chiSquarePercent;
  if (Number.isFinite(s.stdResFlag)) el.stdResFlag.value = s.stdResFlag;
  if (typeof s.errorScaling === 'string') el.scaleFactor.checked = s.errorScaling !== 'never';
  if (Number.isFinite(s.refraction)) el.refr.value = s.refraction;
  if (s.instrument) {
    for (const [key, input] of Object.entries(INSTRUMENT_FIELDS)) {
      if (Number.isFinite(s.instrument[key])) input.value = Number(s.instrument[key].toPrecision(10));
    }
  }
}

// ---- Settings persistence (per-device convenience only; may be unavailable) --
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) putSettings(s);
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
  s.refraction = Number(el.refr.value);
  s.instrument = { ...s.instrument };
  for (const [key, input] of Object.entries(INSTRUMENT_FIELDS)) s.instrument[key] = Number(input.value);
  s.projectName = job.name || s.projectName;
  return s;
}

function showError(msg) {
  el.errorBox.textContent = msg;
  el.errorBox.hidden = !msg;
}

/** Show the settings that apply to this kind of job, and the matching CSV choices. */
function applyKind(kind, unitKey) {
  const u = LINEAR_UNITS[unitKey] || LINEAR_UNITS.meters;
  el.levelFields.hidden = kind === '3d';
  el.tsFields.hidden = kind !== '3d';
  el.levelUnit.textContent = `(${u.short} per ${u.perShort})`;
  el.insUnit.textContent = `(lengths in ${u.short})`;
  for (const o of el.csvFormat.options) o.disabled = kind === 'level' && o.value === 'PNE';
  if (el.csvFormat.selectedOptions[0] && el.csvFormat.selectedOptions[0].disabled) el.csvFormat.value = 'PE';
}

// ---- Loading a job -----------------------------------------------------------
function setJob(name, text) {
  job = { name: name.replace(/\.[^.]+$/, ''), text, kind: null, unitKey: 'meters' };
  el.results.hidden = true;
  el.kindInfo.hidden = true;
  showError('');
  try {
    const p = parseDat(text);
    const kind = detectKind(p);
    job.kind = kind;
    job.unitKey = linearUnitsFromDat(p.state.units) || 'meters';
    const u = LINEAR_UNITS[job.unitKey];
    const control = p.records.filter((r) => r.type === 'E' || r.type === 'C').length;
    if (kind === 'level') {
      const nL = p.records.filter((r) => r.type === 'L').length;
      const lvl = p.state.level ? ` The file sets .LEVEL ${p.state.level.stdErr}.` : '';
      el.fileInfo.textContent = `${name}: ${nL} level runs, ${control} control points, units ${u.label}.${lvl}`;
      el.kindInfo.textContent = 'Differential levelling (1D).';
    } else {
      const sets = new Set(p.records.filter((r) => r.set).map((r) => r.set)).size;
      const n = p.records.filter((r) => ['DM', 'DN', 'DV', 'D', 'V', 'A', 'B', 'M'].includes(r.type)).length;
      el.fileInfo.textContent = `${name}: ${n} observation records in ${sets} direction sets, ${control} stations entered, units ${u.label}.`;
      el.kindInfo.textContent = 'Total-station network (3D). Set the instrument below; refraction comes from .REF in the file when present.';
      if (Number.isFinite(p.state.refraction)) el.refr.value = p.state.refraction;
    }
    el.kindInfo.hidden = false;
    applyKind(kind, job.unitKey);
    el.adjustBtn.disabled = false;
  } catch (err) {
    el.fileInfo.textContent = name;
    el.adjustBtn.disabled = true;
    showError(err instanceof DatParseError || err instanceof AdjustmentError ? err.message : `Could not read the file: ${err.message}`);
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
  putSettings(settingsFromSnproj(await f.text()));
  showError('');
  el.fileInfo.textContent += ` Settings loaded from ${f.name}.`;
});

async function loadSample(url, name, settings) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    putSettings(settings);
    setJob(name, await res.text());
  } catch (err) {
    showError(`Could not load the sample: ${err.message}`);
  }
}
el.sampleBtn.addEventListener('click', () => loadSample('../tests/fixtures/LEVEL_JOB.dat', 'LEVEL_JOB.dat', { levelStdErr: 0.0002 }));
el.sample3dBtn.addEventListener('click', () => loadSample('./samples/3D_SAMPLE.dat', '3D_SAMPLE.dat', {
  refraction: 0.07,
  instrument: { distanceConstant: 0.0007, distancePpm: 2, direction: 3, zenith: 3, angle: 4, azimuth: 4, centeringInstrument: 0, centeringTarget: 0, centeringVertical: 0 },
}));

// Desktop PWA: double-clicking a .dat opens it here (see file_handlers in the manifest).
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    try { if (params.files && params.files.length) await loadFile(await params.files[0].getFile()); } catch { /* ignore */ }
  });
}

// ---- Adjust ----------------------------------------------------------------------
const fmt = (x, d) => Number(x).toFixed(d);

function renderResult(out) {
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
  if (job.kind === 'level' && !(settings.levelStdErr > 0)) { showError('Enter a level std error greater than zero.'); return; }
  if (!(settings.chiSquarePercent > 0 && settings.chiSquarePercent < 100)) { showError('Chi-square level must be between 0 and 100 %.'); return; }
  if (job.kind === '3d' && !(settings.instrument.distanceConstant >= 0 && settings.instrument.direction > 0 && settings.instrument.zenith > 0)) {
    showError('Enter the instrument std errors (direction and zenith must be greater than zero).'); return;
  }
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
applyKind('level', 'meters');
