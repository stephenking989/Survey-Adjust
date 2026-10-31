// The in-page text editor for one data file: line numbers, error marks, jump to line,
// find, undo/redo and a row of the characters that are awkward on a phone keyboard.
// It edits the project store directly, so nothing is ever "unsaved".
import { parseDataFiles } from '../engine/index.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const el = {
  view: $('view-editor'), back: $('edBack'), name: $('edName'), include: $('edInclude'),
  text: $('edText'), gutter: $('edGutter'), pos: $('edPos'), count: $('edCount'),
  undo: $('edUndo'), redo: $('edRedo'), find: $('edFind'), findNext: $('edFindNext'), download: $('edDownload'),
  problems: $('edProblems'), keys: document.querySelector('.ed-keys'),
};

let current = null;          // id of the file being edited
let marks = new Map();       // line number -> 'bad' | 'warn'
let gutterLines = 0;
let gutterSig = '';
let checkTimer = null;
let hooks = {};

/** hooks: { onBack(), onChange(), showProblems(list) } */
export function initEditor(h) {
  hooks = h;
  el.back.addEventListener('click', () => hooks.onBack());
  el.text.addEventListener('input', onInput);
  el.text.addEventListener('scroll', () => { el.gutter.scrollTop = el.text.scrollTop; });
  for (const ev of ['keyup', 'click', 'focus']) el.text.addEventListener(ev, updatePos);
  document.addEventListener('selectionchange', () => { if (document.activeElement === el.text) updatePos(); });
  el.name.addEventListener('change', () => {
    if (current == null) return;
    store.renameFile(current, el.name.value);
    const f = store.getFile(current);
    if (f) el.name.value = f.name;
    hooks.onChange();
  });
  el.include.addEventListener('change', () => { if (current != null) { store.setInclude(current, el.include.checked); hooks.onChange(); } });
  // Keep keyboard focus in the text while tapping helper buttons, so the phone keyboard stays up.
  el.keys.addEventListener('mousedown', (e) => e.preventDefault());
  el.keys.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ins]');
    if (b) insert(b.dataset.ins);
  });
  for (const b of [el.undo, el.redo]) b.addEventListener('mousedown', (e) => e.preventDefault());
  el.undo.addEventListener('click', () => { el.text.focus(); document.execCommand('undo'); });
  el.redo.addEventListener('click', () => { el.text.focus(); document.execCommand('redo'); });
  el.findNext.addEventListener('click', findNext);
  el.find.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(); } });
  el.download.addEventListener('click', downloadCurrent);
}

export const currentId = () => current;

export function openFile(id, line) {
  const f = store.getFile(id);
  if (!f) return;
  current = id;
  el.name.value = f.name;
  el.include.checked = f.include;
  el.text.value = f.text;
  gutterSig = '';
  marks = new Map();
  drawGutter();
  scheduleCheck(0);
  updatePos();
  if (line) goToLine(line);
  else el.text.scrollTop = 0;
}

function insert(s) {
  el.text.focus();
  // execCommand keeps the browser's undo history; setRangeText is the fallback.
  if (!document.execCommand('insertText', false, s)) {
    el.text.setRangeText(s, el.text.selectionStart, el.text.selectionEnd, 'end');
    onInput();
  }
}

function onInput() {
  if (current == null) return;
  store.setText(current, el.text.value);
  drawGutter();
  updatePos();
  scheduleCheck(450);
  hooks.onChange();
}

function lineCount() {
  let n = 1;
  const t = el.text.value;
  for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) n++;
  return n;
}

/** Line numbers with the error and warning lines coloured; rebuilt only when something changed. */
function drawGutter() {
  const n = lineCount();
  const sig = n + '|' + [...marks].join(',');
  el.count.textContent = `${n} line${n === 1 ? '' : 's'}`;
  if (sig === gutterSig) return;
  gutterSig = sig;
  gutterLines = n;
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= n; i++) {
    const s = document.createElement('span');
    const m = marks.get(i);
    if (m) s.className = m;
    s.textContent = String(i);
    frag.appendChild(s);
  }
  el.gutter.replaceChildren(frag);
  el.gutter.scrollTop = el.text.scrollTop;
}

function updatePos() {
  const t = el.text.value;
  const at = el.text.selectionStart;
  const before = t.slice(0, at);
  const ln = before.split('\n').length;
  const col = at - (before.lastIndexOf('\n') + 1) + 1;
  el.pos.textContent = `Ln ${ln}, Col ${col}`;
}

function lineHeight() {
  const lh = parseFloat(getComputedStyle(el.text).lineHeight);
  return Number.isFinite(lh) ? lh : 19.5;
}

/** Select line n and scroll it into the upper third of the editor. */
export function goToLine(n) {
  const lines = el.text.value.split('\n');
  const idx = Math.max(1, Math.min(n, lines.length));
  let start = 0;
  for (let i = 0; i < idx - 1; i++) start += lines[i].length + 1;
  el.text.focus({ preventScroll: true });
  el.text.setSelectionRange(start, start + lines[idx - 1].length);
  el.text.scrollTop = Math.max(0, (idx - 1) * lineHeight() - el.text.clientHeight / 3);
  el.gutter.scrollTop = el.text.scrollTop;
  el.view.scrollIntoView({ block: 'nearest' });
  updatePos();
}

function findNext() {
  const q = el.find.value;
  if (!q) return;
  const hay = el.text.value.toLowerCase();
  const needle = q.toLowerCase();
  let i = hay.indexOf(needle, el.text.selectionEnd);
  if (i < 0) i = hay.indexOf(needle);               // wrap round
  if (i < 0) { el.pos.textContent = `"${q}" not found`; return; }
  const ln = el.text.value.slice(0, i).split('\n').length;
  el.text.focus({ preventScroll: true });
  el.text.setSelectionRange(i, i + q.length);
  el.text.scrollTop = Math.max(0, (ln - 1) * lineHeight() - el.text.clientHeight / 3);
  el.gutter.scrollTop = el.text.scrollTop;
  updatePos();
}

// ---- Live syntax marks ------------------------------------------------------------------

function scheduleCheck(delay) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runLiveCheck, delay);
}

/** Mark the syntax errors and parser warnings of this file in the gutter (the same checks as "Check data"). */
function runLiveCheck() {
  if (current == null) return;
  const f = store.getFile(current);
  if (!f) return;
  const next = new Map();
  const items = [];
  try {
    // Read the file on its own: the marks are about this file's syntax, wherever it sits in the list.
    const p = parseDataFiles([{ name: f.name, text: f.text, include: true }], { collectErrors: true });
    for (const w of p.warnings) if (w.line) { next.set(w.line, 'warn'); items.push({ severity: 'warning', fileName: f.name, line: w.line, message: w.message }); }
    for (const e of p.errors) { next.set(e.line, 'bad'); items.push({ severity: 'error', fileName: f.name, line: e.line, message: e.message }); }
  } catch { /* nothing to mark */ }
  marks = next;
  drawGutter();
  items.sort((a, b) => a.line - b.line);
  hooks.showEditorProblems(items);
}

function downloadCurrent() {
  const f = store.getFile(current);
  if (!f) return;
  const url = URL.createObjectURL(new Blob([f.text.replace(/\r?\n/g, '\r\n')], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
