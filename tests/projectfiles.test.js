// A project made of several data files: ordering, include checkboxes, per-file options,
// error locations, the data check, and the chi-square advice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runAdjustment, checkData, parseDataFiles, DataFileError, AdjustmentError, adviseOnAdjustment, worstResiduals,
  defaultSettings, settingsFromSnproj, dataFileNamesFromSnproj,
} from '../engine/index.js';
import { near } from './helpers.js';
import { publicJob } from './jobs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample3d = fs.readFileSync(path.join(here, '..', 'app', 'samples', '3D_SAMPLE.dat'), 'utf8').replace(/\r\n/g, '\n');
const level = publicJob('level').read('dat').replace(/\r\n/g, '\n');
const levelSettings = () => ({ ...defaultSettings(), ...settingsFromSnproj(publicJob('level').read('snproj')) });
const sample3dSettings = () => ({
  ...defaultSettings(), refraction: 0.07,
  instrument: { ...defaultSettings().instrument, distanceConstant: 0.0007, distancePpm: 2, direction: 3, zenith: 3, angle: 4, azimuth: 4 },
});

// Cut a text in two at the first line that matches `re` (that line starts the second part).
function splitAt(text, re) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => re.test(l));
  assert.ok(i > 0, 'split marker not found');
  return [lines.slice(0, i).join('\n') + '\n', lines.slice(i).join('\n')];
}

test('the same data in two files gives the same levelling adjustment as one file', () => {
  const [a, b] = splitAt(level, /^L /);
  const one = runAdjustment(level, levelSettings());
  const two = runAdjustment([{ name: 'control.dat', text: a }, { name: 'runs.dat', text: b }], levelSettings());
  assert.equal(two.result.stats.nObservations, one.result.stats.nObservations);
  near(assert, two.result.stats.sumSqStdRes, one.result.stats.sumSqStdRes, 1e-9);
  near(assert, two.result.stats.sumSqStdRes, 441.532, 5e-4);
  // The listing names both files and labels residuals with the file they came from.
  assert.match(two.report.text, /1\. control\.dat/);
  assert.match(two.report.text, /2\. runs\.dat/);
  assert.match(two.report.text, /\s2:\d+\s*$/m);
});

test('a 3D job split into control and observation files adjusts identically', () => {
  const [ctl, obs] = splitAt(sample3d, /^# ---- Station A/);
  const header = '.UNITS METERS\n.UNITS DMS\n.3D\n';
  const one = runAdjustment(sample3d, sample3dSettings());
  const two = runAdjustment([{ name: 'control.dat', text: ctl }, { name: 'obs.dat', text: header + obs }], sample3dSettings());
  near(assert, two.result.stats.sumSqStdRes, one.result.stats.sumSqStdRes, 1e-9);
  for (const s of one.result.stations) {
    const t = two.result.stations.find((x) => x.name === s.name);
    near(assert, t.n, s.n, 1e-9, s.name); near(assert, t.e, s.e, 1e-9, s.name); near(assert, t.z, s.z, 1e-9, s.name);
  }
});

test('an unticked file is not read; the order of the list is the order of reading', () => {
  const [a, b] = splitAt(level, /^L /);
  const files = [{ name: 'runs.dat', text: b }, { name: 'control.dat', text: a }];
  const p = parseDataFiles(files);
  assert.deepEqual(p.files.map((f) => f.name), ['runs.dat', 'control.dat']);
  assert.equal(p.records.find((r) => r.type === 'L').file, 1);
  assert.equal(p.records.find((r) => r.type === 'E').file, 2);
  const off = parseDataFiles([{ name: 'a.dat', text: 'E A 1 !\n' }, { name: 'b.dat', text: 'E B 2 !\n', include: false }]);
  assert.deepEqual(off.records.map((r) => r.name), ['A']);
  assert.throws(() => runAdjustment([{ name: 'a.dat', text: 'E A 1 !', include: false }], levelSettings()), /No data files are included/);
});

test('inline options end with their file (STAR*NET manual 5.8); direction sets stay distinct across files', () => {
  const f1 = '.REF 0.2\n.CURVE OFF\nDB A\nDM B 000-00-00 10 090-00-00\nDE\n';
  const f2 = 'DB A\nDM B 000-00-00 10 090-00-00\nDE\n';
  const p = parseDataFiles([{ name: 'one.dat', text: f1 }, { name: 'two.dat', text: f2 }]);
  const dm = p.records.filter((r) => r.type === 'DM');
  assert.equal(dm[0].inline.refraction, 0.2);
  assert.equal(dm[0].inline.curve, false);
  assert.equal(dm[1].inline.refraction, null);
  assert.equal(dm[1].inline.curve, true);
  assert.deepEqual(dm.map((r) => r.set), [1, 2]);
});

test('a syntax error names the file and line; the data check lists every error', () => {
  const files = [{ name: 'ok.dat', text: 'E A 100 !\n' }, { name: 'bad.dat', text: 'E B 101 !\nL A-B oops 100\nL A-B 1 xx\n' }];
  assert.throws(() => parseDataFiles(files), (e) => e instanceof DataFileError && e.file === 2 && e.fileName === 'bad.dat' && e.line === 2 && /bad\.dat, line 2/.test(e.message));
  const chk = checkData(files, levelSettings());
  assert.equal(chk.ok, false);
  assert.deepEqual(chk.errors.map((e) => [e.fileName, e.line]), [['bad.dat', 2], ['bad.dat', 3]]);
});

test('an engine error in the second file carries its file and line, and its message names the file', () => {
  const files = [{ name: 'ctl.dat', text: 'E A 100 !\n' }, { name: 'runs.dat', text: 'L A-B 1.0 100\nL A-A 1 100\n' }];
  assert.throws(() => runAdjustment(files, levelSettings()), (e) => e instanceof AdjustmentError && e.details.file === 2 && e.details.line === 2 && /^runs\.dat, line 2: /.test(e.message));
  // With a single file the old wording is kept.
  assert.throws(() => runAdjustment('E A 100 !\nL A-A 1 100\n', levelSettings()), (e) => /^Line 2: /.test(e.message));
  const chk = checkData(files, levelSettings());
  assert.equal(chk.ok, false);
  assert.deepEqual([chk.errors[0].fileName, chk.errors[0].line], ['runs.dat', 2]);
});

test('the data check passes a good job and counts what it found', () => {
  const chk = checkData([{ name: 'job.dat', text: sample3d }], sample3dSettings());
  assert.equal(chk.ok, true, JSON.stringify(chk.errors));
  assert.equal(chk.summary.kind, '3d');
  assert.equal(chk.summary.files[0].name, 'job.dat');
  assert.ok(chk.summary.records.DM > 20);
  assert.equal(chk.summary.records.C, 2);
});

// ---- Advice on a failed chi-square test ---------------------------------------------

test('advice: a clean job gives no advice; the levelling fixture explains its failure and names the worst runs', () => {
  const good = runAdjustment(sample3d, sample3dSettings());
  assert.equal(good.result.stats.chiSquare.passed, true);
  assert.deepEqual(adviseOnAdjustment(good), []);

  const bad = runAdjustment(level, levelSettings());
  assert.equal(bad.result.stats.chiSquare.passed, false);
  const notes = adviseOnAdjustment(bad);
  assert.equal(notes[0].level, 'warn');
  assert.match(notes[0].text, /6\.34/);
  const worst = worstResiduals(bad, 5);
  assert.equal(worst.length, 5);
  for (let i = 1; i < worst.length; i++) assert.ok(Math.abs(worst[i - 1].stdRes) >= Math.abs(worst[i].stdRes));
  assert.ok(worst[0].line > 0 && worst[0].file === 1);
});

test('advice: one blunder in an otherwise good loop is called a blunder, and it is the top residual', () => {
  // A level net on known heights with tiny, fixed "noise" so the run is repeatable.
  const h = { A: 100, B: 101.1, C: 101.6, D: 100.85, E: 101.35, F: 100.35 };
  const runs = [['A', 'B', 400], ['B', 'C', 400], ['C', 'D', 400], ['D', 'E', 400], ['E', 'F', 400], ['F', 'A', 400],
    ['A', 'C', 800], ['C', 'E', 800], ['B', 'D', 800], ['D', 'F', 800], ['E', 'A', 400], ['B', 'F', 1200], ['A', 'D', 1000], ['C', 'F', 900]];
  const noise = [0.0004, -0.0003, 0.0002, -0.0005, 0.0003, -0.0002, 0.0005, -0.0004, 0.0001, -0.0001, 0.0003, -0.0003, 0.0002, -0.0002];
  const build = (blunderAt) => ['E A 100.000 !', ...runs.map(([f, t, len], i) => {
    const d = h[t] - h[f] + noise[i] + (i === blunderAt ? 0.01 : 0);
    return `L ${f}-${t} ${d.toFixed(4)} ${len}`;
  })].join('\n');
  const s = { ...defaultSettings(), levelStdErr: 0.00025 };
  const clean = runAdjustment(build(-1), s);
  assert.equal(clean.result.stats.chiSquare.passed, true);
  assert.deepEqual(adviseOnAdjustment(clean), []);
  const out = runAdjustment(build(1), s);          // run B-C is on line 3 of the data
  assert.equal(out.result.stats.chiSquare.passed, false);
  const top = worstResiduals(out, 3);
  assert.ok(top.some((r) => r.line === 3), `lines of the worst residuals: ${top.map((r) => r.line)}`);
  assert.ok(Math.abs(top[0].stdRes) > 3);
  const texts = adviseOnAdjustment(out).map((n) => n.text).join(' ');
  assert.match(texts, /blunder/i);
});

test('a .snproj names its data files in order', () => {
  assert.deepEqual(dataFileNamesFromSnproj('[DataFileList]\n#\n3 "b.dat"\n1 "C:\\jobs\\a.dat"\n[Plot]\n3 "not-a-data-file.dat"\n'), ['b.dat', 'a.dat']);
  assert.deepEqual(dataFileNamesFromSnproj(publicJob('control').read('snproj')), ['Network3D_B.dat']);
  assert.deepEqual(dataFileNamesFromSnproj(''), []);
});
