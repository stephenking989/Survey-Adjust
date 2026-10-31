// 2D networks: classification, traverses, the solver against an independent calculation, noise-free
// recovery, and agreement with the 3D engine on the same data held flat.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAdjustment, checkData, parseDat, defaultSettings, AdjustmentError, DatParseError, detectKind } from '../engine/index.js';
import { near } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = fs.readFileSync(path.join(here, '..', 'app', 'samples', '2D_TRAVERSE.dat'), 'utf8').replace(/\r\n/g, '\n');
const settings = (over = {}) => {
  const s = defaultSettings();
  s.instrument = { ...s.instrument, distanceConstant: 0.02, distancePpm: 0, direction: 5, angle: 5, azimuth: 5, centeringInstrument: 0, centeringTarget: 0, ...over };
  return s;
};
const run = (text, s = settings()) => runAdjustment([{ name: 'job.dat', text }], s, {});

test('jobs are classified: levelling, 2D (all horizontal) or 3D (any elevation or zenith)', () => {
  const kind = (t) => detectKind(parseDat(t));
  assert.equal(kind('C A 0 0 ! !\nD A-B 10\n'), '2d');
  assert.equal(kind('.3D\nC A 0 0 10 ! ! !\nD A-B 10\n'), '3d');
  assert.equal(kind('C A 0 0 ! !\nD A-B 10\nV A-B 090-00-00\n'), '3d');
  assert.equal(kind('E A 1 !\nL A-B 1 10\n'), 'level');
});

test('code glued to a station name: C1 and T2 read like C 1 and T 2', () => {
  const p = parseDat('C1 5000 5000 ! !\nTB 1\nT2 90-00-00 100\nTE 3\n');
  assert.equal(p.records[0].name, '1');
  assert.equal(p.records[1].type, 'M');
  assert.equal(p.records[1].at, '2');
});

test('traverse lines become M records with the right previous and next points', () => {
  const p = parseDat("TB 5\nT 7 100-00-00 100.00\nT 9 240-00-00 150.00 4 .03\nT 10 78-50-00 85.00 'pin\nTE 15 125-13-26 24 5.0\n");
  const m = p.records.filter((r) => r.type === 'M');
  assert.deepEqual(m.map((r) => [r.at, r.from, r.to]), [['7', '5', '9'], ['9', '7', '10'], ['10', '9', '15']]);
  assert.deepEqual([m[1].stdErr.angle, m[1].stdErr.distance], [4, 0.03]);
  assert.equal(m[2].description, 'pin');
  const close = p.records.find((r) => r.type === 'A');
  assert.deepEqual([close.at, close.from, close.to, close.stdErr.angle], ['15', '10', '24', 5]);
});

test('traverse mistakes are reported with their line', () => {
  assert.throws(() => parseDat('T 7 100-00-00 100\n'), (e) => e instanceof DatParseError && e.line === 1 && /outside a traverse/.test(e.message));
  assert.throws(() => parseDat('TB 5\nT 7 100-00-00 100\n'), (e) => e instanceof DatParseError && /never closed/.test(e.message));
  assert.throws(() => parseDat('TB N45-00-00E\n'), (e) => e instanceof DatParseError && /fixed bearing/.test(e.message));
  assert.throws(() => parseDat('TB 5\nTB 6\n'), (e) => e instanceof DatParseError && e.line === 2);
  const p = parseDat('TB 5\nT 7 100-00-00 100\nTB 6\nTE 9\n', { collectErrors: true });
  assert.equal(p.errors.length, 1);
});

test('a trilateration against three fixed points matches an independent Gauss-Newton calculation', () => {
  const text = ['C A 0 0 ! !', 'C B 0 100 ! !', 'C C 100 0 ! !', 'C P 50 50', 'D A-P 70.72', 'D B-P 70.69', 'D C-P 70.75'].join('\n');
  const out = run(text, settings({ distanceConstant: 0.01 }));
  // Independent: unknown (n, e); each distance has sigma 0.01, so the weights are equal.
  const ctl = [[0, 0, 70.72], [0, 100, 70.69], [100, 0, 70.75]];
  let n = 50; let e = 50;
  for (let it = 0; it < 8; it++) {
    let a = 0; let b = 0; let c = 0; let r1 = 0; let r2 = 0;
    for (const [cn, ce, d] of ctl) {
      const pred = Math.hypot(n - cn, e - ce);
      const jn = (n - cn) / pred; const je = (e - ce) / pred; const l = d - pred;
      a += jn * jn; b += jn * je; c += je * je; r1 += jn * l; r2 += je * l;
    }
    const det = a * c - b * b;
    n += (c * r1 - b * r2) / det; e += (a * r2 - b * r1) / det;
  }
  const P = out.result.stations.find((s) => s.name === 'P');
  near(assert, P.n, n, 1e-9, 'N'); near(assert, P.e, e, 1e-9, 'E');
  assert.equal(out.result.stats.nUnknowns, 2);
  assert.equal(out.result.stats.dof, 1);
});

test('noise-free angles and distances give the true coordinates back and a zero sum of squares', () => {
  const truth = { A: [1000, 2000], B: [1100, 2250], C: [1350, 2210], D: [1280, 1950], E: [1150, 2110] };
  const az = (p, q) => Math.atan2(q[1] - p[1], q[0] - p[0]);
  const dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  const dms = (rad) => {
    let d = (((rad * 180) / Math.PI) % 360 + 360) % 360;
    const D = Math.floor(d); d = (d - D) * 60;
    const M = Math.floor(d); const S = (d - M) * 60;
    return `${D}-${String(M).padStart(2, '0')}-${S.toFixed(6).padStart(9, '0')}`;
  };
  const ang = (at, from, to) => dms(az(truth[at], truth[to]) - az(truth[at], truth[from]));
  const lines = ['C A 1000 2000 ! !', `C B ${truth.B[0]} ${truth.B[1]} ! !`];
  // Starting values a few units off the truth; the adjustment has to move them back.
  for (const k of ['C', 'D', 'E']) lines.push(`C ${k} ${truth[k][0] + 3} ${truth[k][1] - 4}`);
  for (const [at, from, to] of [['C', 'B', 'D'], ['D', 'C', 'E'], ['E', 'D', 'A'], ['E', 'A', 'B'], ['C', 'A', 'B']]) {
    lines.push(`A ${at}-${from}-${to} ${ang(at, from, to)}`);
  }
  for (const [p, q] of [['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'A'], ['A', 'D'], ['B', 'E'], ['A', 'C']]) lines.push(`D ${p}-${q} ${dist(truth[p], truth[q]).toFixed(9)}`);
  const out = run(lines.join('\n'));
  for (const name of ['C', 'D', 'E']) {
    const s = out.result.stations.find((x) => x.name === name);
    near(assert, s.n, truth[name][0], 1e-5, `${name} N`); near(assert, s.e, truth[name][1], 1e-5, `${name} E`);
  }
  assert.ok(out.result.stats.sumSqStdRes < 1e-3, `sum of squares ${out.result.stats.sumSqStdRes}`);
});

test('traverse lines give the same adjustment as the M lines they stand for', () => {
  const trav = ['C1 100 100 ! !', 'C2 100 300 ! !', 'C9 300 100', 'TB 1', 'T 2 90-00-00 200.01', 'T 3 90-00-12 199.99', 'TE 9'].join('\n');
  const long = ['C1 100 100 ! !', 'C2 100 300 ! !', 'C9 300 100', 'M 2-1-3 90-00-00 200.01', 'M 3-2-9 90-00-12 199.99'].join('\n');
  const a = run(trav); const b = run(long);
  assert.equal(a.result.stats.nObservations, b.result.stats.nObservations);
  for (const s of a.result.stations) {
    const t = b.result.stations.find((x) => x.name === s.name);
    near(assert, s.n, t.n, 1e-9); near(assert, s.e, t.e, 1e-9);
  }
});

test('the 2D sample adjusts, passes at the suggested options, and agrees with the 3D engine run flat', () => {
  const two = run(sample);
  assert.equal(two.kind, '2d');
  assert.equal(two.result.type, '2D');
  assert.deepEqual([two.result.stats.nObservations, two.result.stats.nUnknowns, two.result.stats.dof], [26, 18, 8]);
  assert.equal(two.result.stats.chiSquare.passed, true);
  assert.equal(two.result.stats.classes.some((c) => c.name === 'Zeniths'), false);
  // The same observations as a 3D job with every height fixed at zero and no zenith angles.
  const dms = (deg) => { const D = Math.floor(deg); const m = (deg - D) * 60; const M = Math.floor(m); return `${D}-${String(M).padStart(2, '0')}-${((m - M) * 60).toFixed(8).padStart(11, '0')}`; };
  // (A 3D job cannot work out starting positions without zenith angles, so give every station one, a metre off.)
  const flatLines = ['.3D', 'C 1 5045.572 5495.338 0 ! ! !'];
  for (const s of two.result.stations) if (s.name !== '1') flatLines.push(`C ${s.name} ${(s.n + 1).toFixed(3)} ${(s.e - 1).toFixed(3)} 0 * * !`);
  for (const r of parseDat(sample).records) {
    if (r.type === 'M') flatLines.push(`M ${r.at}-${r.from}-${r.to} ${dms(r.angle)} ${r.distance}`);
    else if (r.type === 'A') flatLines.push(`A ${r.at}-${r.from}-${r.to} ${dms(r.angle)}`);
    else if (r.type === 'B') flatLines.push(`B ${r.from}-${r.to} ${dms(r.azimuth)} !`);
  }
  const flat = flatLines.join('\n');
  const three = run(flat);
  assert.equal(three.kind, '3d');
  assert.equal(three.result.stats.nUnknowns, 18);
  near(assert, three.result.stats.sumSqStdRes, two.result.stats.sumSqStdRes, 1e-9);
  for (const s of two.result.stations) {
    const t = three.result.stations.find((x) => x.name === s.name);
    near(assert, s.n, t.n, 1e-9, s.name); near(assert, s.e, t.e, 1e-9, s.name);
  }
  // And the ellipses agree.
  for (const e of two.ellipses.stations) {
    const t = three.ellipses.stations.find((x) => x.name === e.name);
    near(assert, e.semiMajor, t.semiMajor, 1e-9, e.name); near(assert, e.semiMinor, t.semiMinor, 1e-9, e.name);
  }
});

test('the 2D listing has no elevation columns, no zeniths and no vertical ellipse figures', () => {
  const out = run(sample);
  const text = out.report.text;
  assert.match(text, /2D Adjustment/);
  assert.match(text, /Type of Adjustment\s+: 2D/);
  assert.doesNotMatch(text, /Elev|Zenith|Vertical|Refraction/);
  assert.match(text, /Station Coordinate Error Ellipses/);
  assert.equal(out.ellipses.stations.length, 10);
  assert.ok(out.ellipses.stations.every((e) => e.semiMajor >= e.semiMinor && e.semiMinor >= 0));
});

test('a zenith makes the job 3D (which then needs elevations, and says where); a traverse from a bearing is refused', () => {
  const bad = 'C A 0 0 ! !\nC B 0 100 ! !\nC C 100 0 ! !\nC P 50 50\nD A-P 70.7\nDV B-P 70.7 090-00-00\nD C-P 70.7\n';
  // A zenith makes the job 3D, and a 3D job needs elevations: the message says so with the line.
  assert.throws(() => run(bad), (e) => e instanceof AdjustmentError && /Line \d+/.test(e.message));
  const chk = checkData([{ name: 'a.dat', text: 'TB N45-00-00E\n' }], settings());
  assert.equal(chk.ok, false);
  assert.match(chk.errors[0].message, /fixed bearing/);
});

test('a fixed bearing and a distance place the station at the far end, in either direction', () => {
  const near1 = (s, name) => s.result.stations.find((x) => x.name === name);
  // Known station 1; 2 lies 100 m due east (azimuth 90); 3 is placed from 2 by an angle and a distance.
  const fwd = run(['C 1 1000 2000 ! !', 'B 1-2 90-00-00 !', 'D 1-2 100.000', 'M 2-1-3 090-00-00 50.000', 'D 1-3 111.8034', 'D 2-3 50.00'].join('\n'));
  near(assert, near1(fwd, '2').n, 1000, 1e-4); near(assert, near1(fwd, '2').e, 2100, 1e-4);
  // The same bearing written from 2 to 1 (azimuth 270), with 1 unknown and 2 known.
  const back = run(['C 2 1000 2100 ! !', 'B 2-1 270-00-00 !', 'D 1-2 100.000'].join('\n'));
  near(assert, near1(back, '1').n, 1000, 1e-4); near(assert, near1(back, '1').e, 2000, 1e-4);
});
