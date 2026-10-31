// Survey-Adjust UI. All maths lives in ../engine; this file wires the page together:
// a project of several data files (Data tab, with an in-page editor), the project options
// (Options tab) and the results pages (Results tab).
import {
  runAdjustment, checkData, parseDataFiles, detectKind, gsiToDat, looksLikeGsi, GsiError, rw5ToDat, looksLikeRw5, Rw5Error, defaultSettings, settingsFromSnproj, dataFileNamesFromSnproj,
  LINEAR_UNITS, linearUnitsFromDat, AdjustmentError, DataFileError, ENGINE_VERSION,
} from '../engine/index.js';
import * as store from './store.js';
import { initEditor, openFile } from './editor.js';
import { initResults, renderResults } from './results.js';

const $ = (id) => document.getElementById(id);
const el = {
  tabs: [...document.querySelectorAll('.tab')], resultsDot: $('resultsDot'),
  viewData: $('view-data'), viewEditor: $('view-editor'), viewOptions: $('view-options'), viewResults: $('view-results'),
  projectName: $('projectName'), fileList: $('fileList'), fileEmpty: $('fileEmpty'), addInput: $('addInput'), newFileBtn: $('newFileBtn'),
  sampleBtn: $('sampleBtn'), sampleGsiBtn: $('sampleGsiBtn'), sampleLevelGsiBtn: $('sampleLevelGsiBtn'), sampleRw5Btn: $('sampleRw5Btn'), gsiCoords: $('gsiCoords'), gsiVertical: $('gsiVertical'), gsiStation: $('gsiStation'), sample2dBtn: $('sample2dBtn'), sample3dBtn: $('sample3dBtn'), addNote: $('addNote'),
  kindInfo: $('kindInfo'), checkBtn: $('checkBtn'), adjustBtn: $('adjustBtn'), problems: $('problems'),
  edCheck: $('edCheck'), edAdjust: $('edAdjust'), edProblems: $('edProblems'),
  snprojInput: $('snprojInput'), optInfo: $('optInfo'), resetOpts: $('resetOpts'), optError: $('optError'),
  levelFields: $('levelFields'), tsFields: $('tsFields'), insUnit: $('insUnit'),
  levelStdErr: $('levelStdErr'), levelUnit: $('levelUnit'), chiPercent: $('chiPercent'),
  stdResFlag: $('stdResFlag'), confPercent: $('confPercent'), scaleFactor: $('scaleFactor'),
  insDist: $('insDist'), insPpm: $('insPpm'), insDir: $('insDir'), insZen: $('insZen'), insAng: $('insAng'), insAz: $('insAz'),
  cenI: $('cenI'), cenT: $('cenT'), cenV: $('cenV'), refr: $('refr'),
  noResults: $('noResults'), resBody: $('resBody'), stale: $('stale'), rerun: $('rerun'),
  dlReport: $('dlReport'), csvFormat: $('csvFormat'), dlCsv: $('dlCsv'), editData: $('editData'),
  offlineBadge: $('offlineBadge'), ver: $('ver'),
};
el.ver.textContent = ENGINE_VERSION;

const SETTINGS_KEY = 'survey-adjust:settings:v2';
const make = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };

let tab = 'data';
let editing = false;
let kind = null;                 // 'level' | '2d' | '3d' | null, from the ticked files
let lastOut = null;              // the last successful adjustment
let lastRun = { rev: -1, sig: '' };
let lastProblems = [];

// ---- Tabs and views ----------------------------------------------------------------------------

function showTab(name) {
  tab = name;
  document.body.dataset.tab = name;
  for (const t of el.tabs) t.setAttribute('aria-current', t.dataset.tab === name ? 'page' : 'false');
  el.viewData.hidden = !(name === 'data' && !editing);
  el.viewEditor.hidden = !(name === 'data' && editing);
  el.viewOptions.hidden = name !== 'options';
  el.viewResults.hidden = name !== 'results';
  if (name === 'results') el.resultsDot.hidden = true;
  window.scrollTo(0, 0);
}
for (const t of el.tabs) t.addEventListener('click', () => showTab(t.dataset.tab));

function enterEditor(id, line) {
  const wasEditing = editing;
  editing = true;
  showTab('data');
  openFile(id, line);
  if (!wasEditing) { try { history.pushState({ ed: 1 }, ''); } catch { /* ignore */ } }
  renderProblems(el.edProblems, lastProblems);
}
function leaveEditor() {
  editing = false;
  renderFileList();
  showTab('data');
}
window.addEventListener('popstate', () => { if (editing) leaveEditor(); });

/** Open the file at the given 1-based position among the files read in the last run (or by name) at a line. */
function openAt(fileRef, line) {
  let f = null;
  if (typeof fileRef === 'string') f = store.getState().files.find((x) => x.name === fileRef);
  else if (lastOut && lastOut.parsed.files[fileRef - 1]) f = store.getState().files.find((x) => x.name === lastOut.parsed.files[fileRef - 1].name);
  if (!f) return;
  enterEditor(f.id, line);
}

// ---- File list ---------------------------------------------------------------------------------

function renderFileList() {
  const files = store.getState().files;
  el.projectName.value = store.getState().name;
  el.fileEmpty.hidden = files.length > 0;
  el.fileList.replaceChildren(...files.map((f, i) => {
    const lines = f.text.split('\n').length;
    const li = make('li', { className: f.include ? '' : 'off' });
    const box = make('input', { type: 'checkbox', checked: f.include });
    box.setAttribute('aria-label', `Read ${f.name}`);
    box.addEventListener('change', () => store.setInclude(f.id, box.checked));
    const open = make('button', { type: 'button', className: 'file-open' },
      make('span', { className: 'nm', textContent: f.name }), make('span', { className: 'meta', textContent: `${lines} line${lines === 1 ? '' : 's'}${f.include ? '' : ' - not read'}` }));
    open.addEventListener('click', () => enterEditor(f.id));
    const up = make('button', { type: 'button', className: 'icon-btn', textContent: '▲', disabled: i === 0 });
    up.setAttribute('aria-label', `Move ${f.name} up`);
    up.addEventListener('click', () => store.moveFile(f.id, -1));
    const down = make('button', { type: 'button', className: 'icon-btn', textContent: '▼', disabled: i === files.length - 1 });
    down.setAttribute('aria-label', `Move ${f.name} down`);
    down.addEventListener('click', () => store.moveFile(f.id, +1));
    const rm = make('button', { type: 'button', className: 'icon-btn', textContent: '✕' });
    rm.setAttribute('aria-label', `Remove ${f.name}`);
    rm.addEventListener('click', () => {
      if (confirm(`Remove ${f.name} from the project? Its text is deleted from this device.`)) store.removeFile(f.id);
    });
    li.append(box, open, up, down, rm);
    return li;
  }));
}

el.projectName.addEventListener('change', () => store.setProjectName(el.projectName.value));

/** Every station name used by the files already in the project. */
function projectStationNames() {
  const names = new Set();
  try {
    const p = parseDataFiles(store.engineFiles().filter((f) => f.include !== false), { collectErrors: true });
    for (const r of p.records) for (const k of ['name', 'from', 'to', 'at']) if (r[k]) names.add(String(r[k]));
  } catch { /* unreadable files: no names to compare */ }
  return names;
}

/** True for the field-file formats that are converted on the way in (Leica GSI, Carlson RW5). */
const isFieldFile = (name, text) => /\.(gsi|rw5)$/i.test(name) || looksLikeGsi(text) || looksLikeRw5(text);

/** Convert one Leica GSI or Carlson RW5 file and add the .dat; returns the note to show, and pushes warnings for the problems list. */
function importGsi(name, text, warnings) {
  const rw5 = /\.rw5$/i.test(name) || (!/\.gsi$/i.test(name) && !looksLikeGsi(text) && looksLikeRw5(text));
  try {
    const opts = { coords: el.gsiCoords.value, vertical: el.gsiVertical.value, station: el.gsiStation.value.trim() || undefined };
    const convert = (o) => (rw5 ? rw5ToDat(text, o) : gsiToDat(text, o));
    let r = convert(opts);
    // Instruments number points from 1 in every job, so a second file would silently join the first one's points.
    let prefixed = '';
    const existing = projectStationNames();
    if (existing.size && r.summary.stations.some((n) => existing.has(n))) {
      prefixed = `F${store.getState().files.length + 1}_`;
      r = convert({ ...opts, prefix: prefixed });
    }
    const datName = name.replace(/\.[^.]*$/, '') + '.dat';
    store.addFile(datName, r.text);
    if (prefixed) warnings.push({ severity: 'warning', message: `${name}: some point names (such as ${r.summary.stations.find((n) => existing.has(n.slice(prefixed.length))) || 'the first ones'}) are already used by another file in the project, so every point in this file was given the prefix ${prefixed} to keep the files apart. Rename them in the .dat if some points really are shared.` });
    for (const w of r.warnings) warnings.push({ severity: 'warning', message: `${name}${w.line ? `, ${rw5 ? 'line' : 'GSI line'} ${w.line}` : ''}: ${w.message}` });
    const s = r.summary;
    if (s.kind === 'rw5') {
      return `Converted ${name} to ${datName}: 2D traverse, ${s.traverseShots} traverse shot${s.traverseShots === 1 ? '' : 's'}, ${s.sideshots} sideshot${s.sideshots === 1 ? '' : 's'}${s.bearingLegs ? `, ${s.bearingLegs} on a fixed bearing` : ''}, ${s.controlPoints} control point${s.controlPoints === 1 ? '' : 's'}. Check the closing shots, then set the instrument on the Options tab.`;
    }
    if (s.kind === 'level') {
      return `Converted ${name} to ${datName}: differential levelling, ${s.runs} run${s.runs === 1 ? '' : 's'}, ${s.setups} set-up${s.setups === 1 ? '' : 's'}, ${s.benchmarks} benchmark${s.benchmarks === 1 ? '' : 's'}. Set the level std error on the Options tab.`;
    }
    return `Converted ${name} to ${datName}: ${s.dimension}D, ${s.stations.length} station${s.stations.length === 1 ? '' : 's'}, ${s.sets} direction set${s.sets === 1 ? '' : 's'}, ${s.directionsWithDistance + s.directionsOnly} pointings${s.face2 ? ` (${s.face2} on face 2, reduced to face 1)` : ''}. Check the stations and heights, then set the instrument on the Options tab.`;
  } catch (err) {
    if (!(err instanceof GsiError || err instanceof Rw5Error)) throw err;
    warnings.push({ severity: 'error', message: `${name}: ${err.message}` });
    return `${name} could not be converted.`;
  }
}

async function addFiles(fileList) {
  const picked = [...fileList];
  const notes = [];
  const projects = picked.filter((f) => /\.snproj$/i.test(f.name));
  const data = picked.filter((f) => !/\.snproj$/i.test(f.name));
  const first = store.getState().files.length === 0;
  const warnings = [];
  for (const f of data) {
    const text = await f.text();
    if (isFieldFile(f.name, text)) {
      const note = importGsi(f.name, text, warnings);
      if (note) notes.push(note);
    } else {
      store.addFile(f.name, text);
    }
  }
  if (warnings.length) showProblems(warnings);
  for (const p of projects) {
    const text = await p.text();
    putSettings(settingsFromSnproj(text));
    saveSettings(readSettings());
    const names = dataFileNamesFromSnproj(text);
    if (names.length) {
      store.orderBy(names);
      const have = new Set(store.getState().files.map((f) => f.name.toLowerCase()));
      const missing = names.filter((n) => !have.has(n.toLowerCase()));
      if (missing.length) notes.push(`${p.name} lists ${missing.join(', ')}, which you have not added.`);
    }
    if (first && !data.length) store.setProjectName(p.name.replace(/\.[^.]+$/, ''));
    notes.push(`Options loaded from ${p.name}.`);
  }
  if (first && data.length === 1 && !projects.length) store.setProjectName(data[0].name.replace(/\.[^.]+$/, ''));
  else if (first && projects.length) store.setProjectName(projects[0].name.replace(/\.[^.]+$/, ''));
  el.addNote.textContent = notes.join(' ');
  el.addNote.hidden = notes.length === 0;
}
el.addInput.addEventListener('change', async () => { await addFiles(el.addInput.files); el.addInput.value = ''; });

el.newFileBtn.addEventListener('click', () => {
  const f = store.addFile('new-file.dat', '# New data file. Lines starting with # are comments.\n');
  enterEditor(f.id);
});

async function loadSample(url, name, settings) {
  if (store.getState().files.length && !confirm('Replace the current project with the sample?')) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    putSettings(settings);
    saveSettings(readSettings());
    store.replaceAll(name.replace(/\.[^.]+$/, ''), [{ name, text }]);
    el.addNote.hidden = true;
    clearProblems();
  } catch (err) {
    showProblems([{ severity: 'error', message: `Could not load the sample: ${err.message}` }]);
  }
}
el.sampleBtn.addEventListener('click', () => loadSample('./samples/LEVEL_SAMPLE.dat', 'LEVEL_SAMPLE.dat', { levelStdErr: 0.0002 }));
/** A sample that is a Leica GSI file: converted as it is loaded, like a file the user adds. */
async function loadGsiSample(url, name, settings) {
  if (store.getState().files.length && !confirm('Replace the current project with the GSI sample?')) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    putSettings(settings);
    saveSettings(readSettings());
    store.replaceAll(name.replace(/\.[^.]*$/, ''), []);
    const warnings = [];
    el.addNote.textContent = importGsi(name, text, warnings);
    el.addNote.hidden = false;
    if (warnings.length) showProblems(warnings); else clearProblems();
  } catch (err) {
    showProblems([{ severity: 'error', message: `Could not load the sample: ${err.message}` }]);
  }
}
el.sampleGsiBtn.addEventListener('click', () => loadGsiSample('./samples/GSI_SAMPLE.gsi', 'GSI_SAMPLE.gsi', {
  refraction: 0.07,
  instrument: { distanceConstant: 0.0007, distancePpm: 2, direction: 3, zenith: 3, angle: 4, azimuth: 4, centeringInstrument: 0, centeringTarget: 0, centeringVertical: 0 },
}));
el.sampleRw5Btn.addEventListener('click', () => loadGsiSample('./samples/RW5_SAMPLE.rw5', 'RW5_SAMPLE.rw5', { instrument: { distanceConstant: 0.005, distancePpm: 0, direction: 5, angle: 5, azimuth: 5, centeringInstrument: 0, centeringTarget: 0 } }));
el.sampleLevelGsiBtn.addEventListener('click', () => loadGsiSample('./samples/LEVEL_GSI_SAMPLE.gsi', 'LEVEL_GSI_SAMPLE.gsi', { levelStdErr: 0.0004 }));
el.sample2dBtn.addEventListener('click', () => loadSample('./samples/2D_TRAVERSE.dat', '2D_TRAVERSE.dat', {
  instrument: { distanceConstant: 0.02, distancePpm: 0, direction: 5, angle: 5, azimuth: 5, centeringInstrument: 0, centeringTarget: 0 },
}));
el.sample3dBtn.addEventListener('click', () => loadSample('./samples/3D_SAMPLE.dat', '3D_SAMPLE.dat', {
  refraction: 0.07,
  instrument: { distanceConstant: 0.0007, distancePpm: 2, direction: 3, zenith: 3, angle: 4, azimuth: 4, centeringInstrument: 0, centeringTarget: 0, centeringVertical: 0 },
}));

// Desktop PWA: double-clicking a .dat opens it here (see file_handlers in the manifest).
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    try {
      if (params.files && params.files.length) await addFiles(await Promise.all(params.files.map((h) => h.getFile())));
    } catch { /* ignore */ }
  });
}

// ---- Options -------------------------------------------------------------------------------------

const INSTRUMENT_FIELDS = {
  distanceConstant: el.insDist, distancePpm: el.insPpm, direction: el.insDir, zenith: el.insZen,
  angle: el.insAng, azimuth: el.insAz, centeringInstrument: el.cenI, centeringTarget: el.cenT, centeringVertical: el.cenV,
};

function putSettings(s) {
  if (Number.isFinite(s.levelStdErr)) el.levelStdErr.value = Number(s.levelStdErr.toPrecision(10));
  if (Number.isFinite(s.chiSquarePercent)) el.chiPercent.value = s.chiSquarePercent;
  if (Number.isFinite(s.stdResFlag)) el.stdResFlag.value = s.stdResFlag;
  if (Number.isFinite(s.confidencePercent)) el.confPercent.value = s.confidencePercent;
  if (typeof s.errorScaling === 'string') el.scaleFactor.checked = s.errorScaling !== 'never';
  if (Number.isFinite(s.refraction)) el.refr.value = s.refraction;
  if (s.instrument) {
    for (const [key, input] of Object.entries(INSTRUMENT_FIELDS)) {
      if (Number.isFinite(s.instrument[key])) input.value = Number(s.instrument[key].toPrecision(10));
    }
  }
}

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
  s.confidencePercent = Number(el.confPercent.value);
  s.errorScaling = el.scaleFactor.checked ? 'auto' : 'never';
  s.refraction = Number(el.refr.value);
  s.instrument = { ...s.instrument };
  for (const [key, input] of Object.entries(INSTRUMENT_FIELDS)) s.instrument[key] = Number(input.value);
  s.projectName = store.getState().name || s.projectName;
  return s;
}

el.resetOpts.addEventListener('click', () => {
  const d = defaultSettings();
  putSettings({ ...d, levelStdErr: 0.0005 });
  saveSettings(readSettings());
  updateStale();
});

el.snprojInput.addEventListener('change', async () => {
  const f = el.snprojInput.files[0];
  if (!f) return;
  putSettings(settingsFromSnproj(await f.text()));
  saveSettings(readSettings());
  el.optInfo.textContent = `Options loaded from ${f.name}.`;
  el.optInfo.hidden = false;
  el.snprojInput.value = '';
  updateStale();
});

for (const input of document.querySelectorAll('#view-options input')) {
  if (input.type === 'file') continue;
  input.addEventListener('input', () => { saveSettings(readSettings()); updateStale(); });
}

/** Show the options that apply to this kind of job, and the matching CSV choices. */
function applyKind(k, unitKey) {
  const u = LINEAR_UNITS[unitKey] || LINEAR_UNITS.meters;
  el.levelFields.hidden = k === '3d' || k === '2d';
  el.tsFields.hidden = k !== '3d' && k !== '2d';
  for (const f of document.querySelectorAll('[data-3d]')) f.hidden = k === '2d';
  el.levelUnit.textContent = `(${u.short} per ${u.perShort})`;
  el.insUnit.textContent = `(lengths in ${u.short})`;
  // Levelling has no northing/easting; a 2D job has no elevation.
  for (const o of el.csvFormat.options) o.disabled = (k === 'level' && o.value === 'PNE') || (k === '2d' && o.value !== 'PNE');
  if (el.csvFormat.selectedOptions[0] && el.csvFormat.selectedOptions[0].disabled) el.csvFormat.value = k === '2d' ? 'PNE' : 'PE';
}

// ---- What kind of job is in the ticked files ---------------------------------------------------------

function updateKind() {
  const files = store.engineFiles().filter((f) => f.include !== false);
  const any = store.getState().files.length > 0;
  el.checkBtn.disabled = el.edCheck.disabled = files.length === 0;
  el.adjustBtn.disabled = el.edAdjust.disabled = files.length === 0;
  kind = null;
  if (!any) { el.kindInfo.textContent = 'Add a data file to begin.'; return; }
  if (!files.length) { el.kindInfo.textContent = 'No file is ticked. Tick at least one file to read.'; return; }
  try {
    const p = parseDataFiles(files, { collectErrors: true });
    const unitKey = linearUnitsFromDat(p.state.units) || 'meters';
    const u = LINEAR_UNITS[unitKey];
    const control = p.records.filter((r) => r.type === 'E' || r.type === 'C').length;
    const bad = p.errors.length ? ` ${p.errors.length} line${p.errors.length > 1 ? 's have' : ' has'} errors: press Check data.` : '';
    try {
      kind = detectKind(p);
    } catch (err) {
      el.kindInfo.textContent = err.message + bad;
      return;
    }
    if (kind === 'level') {
      const n = p.records.filter((r) => r.type === 'L').length;
      el.kindInfo.textContent = `Differential levelling (1D): ${n} level runs, ${control} control points, ${p.files.length} file${p.files.length > 1 ? 's' : ''}, units ${u.label}.${bad}`;
    } else if (kind === '2d') {
      const sets = new Set(p.records.filter((r) => r.set).map((r) => r.set)).size;
      const n = p.records.filter((r) => ['DM', 'DN', 'D', 'A', 'B', 'M'].includes(r.type)).length;
      el.kindInfo.textContent = `Horizontal network (2D): ${n} observation records${sets ? ` in ${sets} direction sets` : ''}, ${control} stations entered, ${p.files.length} file${p.files.length > 1 ? 's' : ''}, units ${u.label}. Check the instrument on the Options tab.${bad}`;
    } else {
      const sets = new Set(p.records.filter((r) => r.set).map((r) => r.set)).size;
      const n = p.records.filter((r) => ['DM', 'DN', 'DV', 'D', 'V', 'A', 'B', 'M'].includes(r.type)).length;
      el.kindInfo.textContent = `Total-station network (3D): ${n} observation records in ${sets} direction sets, ${control} stations entered, ${p.files.length} file${p.files.length > 1 ? 's' : ''}, units ${u.label}. Check the instrument on the Options tab.${bad}`;
    }
    applyKind(kind, unitKey);
  } catch (err) {
    el.kindInfo.textContent = `Could not read the files: ${err.message}`;
  }
}

// ---- Problems (errors and warnings with a place to jump to) -----------------------------------------------

function renderProblems(container, items, headline) {
  container.hidden = false;
  const head = headline ? [make('div', { className: items.some((p) => p.severity === 'error') ? 'item note' : 'ok', textContent: headline })] : [];
  if (!items.length) {
    container.replaceChildren(make('div', { className: 'ok', textContent: headline || 'No problems found.' }));
    return;
  }
  container.replaceChildren(...head, ...items.map((p) => {
    const b = make('button', { type: 'button', className: `item ${p.severity}`, disabled: !(p.fileName && p.line) });
    if (p.fileName && p.line) {
      b.append(make('span', { className: 'where', textContent: `${p.fileName} line ${p.line}` }));
      b.addEventListener('click', () => openAt(p.fileName, p.line));
    }
    b.append(p.message);
    return b;
  }));
}

function showProblems(items, okText) {
  lastProblems = items;
  renderProblems(el.problems, items, okText);
  if (editing) renderProblems(el.edProblems, items, okText);
}
function clearProblems() {
  lastProblems = [];
  el.problems.hidden = true;
  el.edProblems.hidden = true;
}

// ---- Check data and Adjust ------------------------------------------------------------------------------------

function validateOptions(s) {
  if (kind === 'level' && !(s.levelStdErr > 0)) return 'Enter a level std error greater than zero on the Options tab.';
  if (!(s.chiSquarePercent > 0 && s.chiSquarePercent < 100)) return 'Chi-square level must be between 0 and 100 % (Options tab).';
  if (!(s.confidencePercent > 0 && s.confidencePercent < 100)) return 'The error ellipse confidence region must be between 0 and 100 % (Options tab).';
  if (kind === '2d' && !(s.instrument.distanceConstant >= 0 && s.instrument.direction > 0 && s.instrument.angle > 0)) {
    return 'Enter the instrument std errors on the Options tab (direction and angle must be greater than zero).';
  }
  if (kind === '3d' && !(s.instrument.distanceConstant >= 0 && s.instrument.direction > 0 && s.instrument.zenith > 0)) {
    return 'Enter the instrument std errors on the Options tab (direction and zenith must be greater than zero).';
  }
  return '';
}

function runCheck() {
  const s = readSettings();
  const bad = validateOptions(s);
  if (bad) { showProblems([{ severity: 'error', message: bad }]); return; }
  const res = checkData(store.engineFiles(), s, { projectName: store.getState().name });
  const items = [
    ...res.errors.map((e) => ({ severity: 'error', fileName: e.fileName, line: e.line, message: e.message })),
    ...res.warnings.map((w) => ({ severity: w.note ? 'note' : 'warning', fileName: w.fileName, line: w.line, message: w.message })),
  ];
  const sum = res.summary;
  const counts = Object.entries(sum.records).map(([k, v]) => `${v} ${k}`).join(', ');
  const nWarn = items.filter((i) => i.severity === 'warning').length;
  const headline = res.ok
    ? `Data check passed${nWarn ? ` with ${nWarn} warning${nWarn > 1 ? 's' : ''}` : ''}: ${sum.files.length} file${sum.files.length > 1 ? 's' : ''}, ${counts}.`
    : `Data check found ${res.errors.length} error${res.errors.length > 1 ? 's' : ''}. Tap one to go to its line.`;
  showProblems(items, headline);
  (editing ? el.edProblems : el.problems).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function runAdjust() {
  const s = readSettings();
  const bad = validateOptions(s);
  if (bad) { showProblems([{ severity: 'error', message: bad }]); return; }
  const files = store.engineFiles();
  try {
    const out = runAdjustment(files, s, { projectName: store.getState().name });
    lastOut = out;
    lastRun = { rev: store.getState().rev, sig: JSON.stringify(s) };
    saveSettings(s);
    clearProblems();
    renderResults(out, openAt);
    el.noResults.hidden = true;
    el.resBody.hidden = false;
    updateStale();
    if (editing) { editing = false; renderFileList(); }
    showTab('results');
    el.resultsDot.hidden = true;
  } catch (err) {
    let item = { severity: 'error', message: `Unexpected error: ${err.message}` };
    if (err instanceof DataFileError) {
      item = { severity: 'error', fileName: err.fileName, line: err.line, message: err.detail };
    } else if (err instanceof AdjustmentError) {
      const d = err.details || {};
      const included = files.filter((f) => f.include !== false);
      const f = d.file ? included[d.file - 1] : null;
      item = { severity: 'error', fileName: f ? f.name : '', line: f ? d.line : null, message: err.message.replace(/^.*?, line \d+: /, '').replace(/^Line \d+: /, '') };
    }
    showProblems([item]);
    (editing ? el.edProblems : el.problems).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

el.checkBtn.addEventListener('click', runCheck);
el.edCheck.addEventListener('click', runCheck);
el.adjustBtn.addEventListener('click', runAdjust);
el.edAdjust.addEventListener('click', runAdjust);
el.rerun.addEventListener('click', runAdjust);
el.editData.addEventListener('click', () => { editing = false; renderFileList(); showTab('data'); });

/** Results go stale when the data or the options change after a run. */
function updateStale() {
  if (!lastOut) return;
  el.stale.hidden = store.getState().rev === lastRun.rev && JSON.stringify(readSettings()) === lastRun.sig;
}

// ---- Downloads ---------------------------------------------------------------------------------------------------------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const safeName = () => (store.getState().name || 'adjustment').replace(/[\\/:*?"<>|]/g, '_');
el.dlReport.addEventListener('click', () => {
  if (lastOut) download(`${safeName()}.lst`, lastOut.report.text.replace(/\n/g, '\r\n'), 'text/plain');
});
el.dlCsv.addEventListener('click', () => {
  if (!lastOut) return;
  const fmtKey = el.csvFormat.value;
  download(`${safeName()}_${fmtKey}.csv`, lastOut.csv(fmtKey), 'text/csv');
});

// ---- Wiring ----------------------------------------------------------------------------------------------------------------

let kindTimer = null;
store.subscribe((what) => {
  if (what === 'files' || what === 'name') renderFileList();
  clearTimeout(kindTimer);
  kindTimer = setTimeout(updateKind, what === 'text' ? 400 : 0);
  updateStale();
});

initEditor({
  onBack: () => { if (history.state && history.state.ed) history.back(); else leaveEditor(); },
  onChange: () => {},
  showEditorProblems: (items) => {
    // Live marks while typing; the last explicit check/run message stays if there is nothing live to show.
    if (items.length) renderProblems(el.edProblems, items.map((i) => ({ ...i })));
    else if (lastProblems.length) renderProblems(el.edProblems, lastProblems);
    else el.edProblems.hidden = true;
  },
});
initResults();
load();

function load() {
  store.load();
  loadSettings();
  renderFileList();
  applyKind('level', 'meters');
  updateKind();
  showTab('data');
}

// ---- Offline support ---------------------------------------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('../sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => { el.offlineBadge.hidden = false; })
    .catch(() => { /* e.g. file:// or private mode - the app still works online */ });
}

