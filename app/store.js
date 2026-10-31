// The project: its name and its list of data files (name, text, include checkbox, order).
// Kept in memory, and copied to localStorage after every change so a reload or a dropped
// connection never loses edits. Storage can be blocked (private mode): then it just stays in memory.

const KEY = 'survey-adjust:project:v1';

const state = { name: 'My project', files: [], rev: 0 };   // rev bumps on every change to the data
let nextId = 1;
const listeners = new Set();
let saveTimer = null;

const notify = (what) => { for (const fn of listeners) fn(what); };

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ name: state.name, files: state.files.map(({ name, text, include }) => ({ name, text, include })) }));
  } catch { /* storage blocked or full: keep working in memory */ }
}

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && Array.isArray(saved.files)) {
      state.name = String(saved.name || 'My project');
      state.files = saved.files.map((f) => ({ id: nextId++, name: String(f.name), text: String(f.text), include: f.include !== false }));
    }
  } catch { /* corrupt or blocked: start empty */ }
}

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getState = () => state;
export const getFile = (id) => state.files.find((f) => f.id === id) || null;
/** The files in the shape the engine takes. */
export const engineFiles = () => state.files.map(({ name, text, include }) => ({ name, text, include }));

function changed(what, dataChanged = true) {
  if (dataChanged) state.rev++;
  scheduleSave();
  notify(what);
}

/** "job.dat" -> "job (2).dat" when the name is taken, so two files never look alike. */
export function uniqueName(name, exceptId = null) {
  const taken = new Set(state.files.filter((f) => f.id !== exceptId).map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const m = /^(.*?)(\.[^.]*)?$/.exec(name);
  for (let i = 2; ; i++) {
    const candidate = `${m[1]} (${i})${m[2] || ''}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function addFile(name, text, include = true) {
  const f = { id: nextId++, name: uniqueName(name), text, include };
  state.files.push(f);
  changed('files');
  return f;
}

export function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  changed('files');
}

export function moveFile(id, delta) {
  const i = state.files.findIndex((f) => f.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.files.length) return;
  [state.files[i], state.files[j]] = [state.files[j], state.files[i]];
  changed('files');
}

export function setInclude(id, include) {
  const f = getFile(id);
  if (f) { f.include = include; changed('files'); }
}

export function setText(id, text) {
  const f = getFile(id);
  if (f && f.text !== text) { f.text = text; changed('text'); }
}

export function renameFile(id, name) {
  const f = getFile(id);
  const clean = String(name).trim().replace(/[\\/:*?"<>|]/g, '_');
  if (f && clean) { f.name = uniqueName(clean, id); changed('files', false); }
}

export function setProjectName(name) {
  state.name = String(name).trim() || 'My project';
  changed('name', false);
}

/** Put the files in the order of `names` (case-insensitive); files not named keep their place after. */
export function orderBy(names) {
  const rank = (f) => { const i = names.findIndex((n) => n.toLowerCase() === f.name.toLowerCase()); return i < 0 ? names.length : i; };
  state.files = state.files.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map((x) => x.f);
  changed('files');
}

/** Start a new project (used by the samples and "new project"). */
export function replaceAll(name, files) {
  state.name = name;
  state.files = files.map((f) => ({ id: nextId++, name: f.name, text: f.text, include: f.include !== false }));
  changed('files');
}
