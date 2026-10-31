// Validation against a real STAR*NET-PRO 14 3D run (NET_A): 25 stations,
// 24 direction sets, 192 DM records (directions + slope distances + zeniths),
// 3 weighted control points, two free resections. The job's files live in
// tests/fixtures/local/ (git-ignored; the data carry a student number and an
// instrument serial), so these tests skip when they are absent.
//
// Expected values are read from the STAR*NET .lst and .pts. Tolerances are the
// precision STAR*NET printed (and in two places the small, documented residual
// difference - see the notes next to the assertions).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDat, adjustNetwork3D, settingsFromSnproj, LINEAR_UNITS, RHO_ARCSEC } from '../engine/index.js';
import { near } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = (e) => path.join(here, 'fixtures', 'local', `NET_A.${e}`);
const have = fs.existsSync(file('dat')) && fs.existsSync(file('lst')) && fs.existsSync(file('pts')) && fs.existsSync(file('snproj'));
const opt = { skip: have ? false : 'local fixture NET_A.* not present' };
const read = (e) => fs.readFileSync(file(e), 'utf8');

let r; let lst; let pts;
if (have) {
  const s = settingsFromSnproj(read('snproj'));
  s.unitsInfo = LINEAR_UNITS.meters;
  r = adjustNetwork3D(parseDat(read('dat')), s);
  lst = read('lst').split(/\r?\n/);
  pts = Object.fromEntries(read('pts').trim().split(/\r?\n/).map((l) => { const t = l.trim().split(/\s+/); return [t[0], { n: +t[1], e: +t[2], z: +t[3] }]; }));
}
const dms2s = (t) => { const m = /^(-?)(\d+)-(\d+)-(\d+\.\d+)$/.exec(t); const v = (+m[2]) * 3600 + (+m[3]) * 60 + +m[4]; return m[1] ? -v : v; };

test('counts: 25 stations, 585 observations, 99 unknowns, 486 redundant', opt, () => {
  assert.equal(r.stats.nStations, 25);
  assert.equal(r.stats.nObservations, 585);
  assert.equal(r.stats.nUnknowns, 99);
  assert.equal(r.stats.dof, 486);
  assert.deepEqual(r.stats.classes.map((c) => [c.name, c.count]), [['Coordinates', 9], ['Directions', 192], ['Distances', 192], ['Zeniths', 192]]);
});

test('error factor 0.968 and chi-square PASSED with bounds 0.937 / 1.063', opt, () => {
  near(assert, r.stats.errorFactor, 0.968, 0.001);
  assert.equal(r.stats.chiSquare.passed, true);
  assert.equal(r.stats.chiSquare.lowerBound.toFixed(3), '0.937');
  assert.equal(r.stats.chiSquare.upperBound.toFixed(3), '1.063');
});

test('sum of squares of StdRes per class (listing: 10.431 / 195.223 / 164.004 / 86.009; total 455.666)', opt, () => {
  const ss = Object.fromEntries(r.stats.classes.map((c) => [c.name, c.sumSq]));
  // Distances agree to the printed digit. The other classes are within 0.03 (0.007% of the total):
  // the whole free network sits a few micrometres (max 16) from STAR*NET's solution - see below.
  near(assert, ss.Distances, 164.004, 0.002, 'distances');
  near(assert, ss.Directions, 195.223, 0.01, 'directions');
  near(assert, ss.Zeniths, 86.009, 0.01, 'zeniths');
  near(assert, ss.Coordinates, 10.431, 0.03, 'coordinates');
  near(assert, r.stats.sumSqStdRes, 455.666, 0.05, 'total');
});

test('adjusted coordinates within 0.00002 m of the .pts (which is rounded to 0.00001 m)', opt, () => {
  let worst = 0;
  for (const s of r.stations) {
    const p = pts[s.name];
    assert.ok(p, `station ${s.name} in .pts`);
    worst = Math.max(worst, Math.abs(s.n - p.n), Math.abs(s.e - p.e), Math.abs(s.z - p.z));
  }
  assert.equal(Object.keys(pts).length, r.stations.length);
  // Measured: 0.000016 m. Rounding alone allows 0.000005 m; the rest is an unexplained, tiny
  // difference (about 0.02 arc-seconds at 100 m) that is not iteration count, weighting or refraction.
  assert.ok(worst <= 0.00002, `worst coordinate difference ${worst}`);
});

test('std devs equal the listing UNSCALED because the chi-square test passed', opt, () => {
  const i = lst.findIndex((l) => /Station Coordinate Standard Deviations/.test(l));
  let n = 0;
  for (let k = i; k < i + 40; k++) {
    const m = /^(\S+)\s+(\d\.\d+)\s+(\d\.\d+)\s+(\d\.\d+)\s*$/.exec(lst[k]);
    if (!m) continue;
    const s = r.stations.find((x) => x.name === m[1]);
    [2, 3, 4].forEach((g, j) => near(assert, s.stdDev[j], +m[g], 0.000001, `${m[1]} std dev ${j}`));
    n++;
  }
  assert.equal(n, 25);
  assert.equal(r.stats.errorFactorApplied, 1);
});

test('every observation std error matches the listing (distances to 0.0001 m, angles to 0.01")', opt, () => {
  const rows = (head, tail, re) => { const a = lst.findIndex((l) => l.includes(head)); const b = lst.findIndex((l, i) => i > a && l.includes(tail)); return lst.slice(a, b).map((l) => re.exec(l)).filter(Boolean); };
  const dist = rows('Adjusted Distance Observations', 'Adjusted Zenith Observations', /^\s+(\S+)\s+(\S+)\s+(\d+\.\d+)\s+(-?\d+\.\d+)\s+(\d\.\d+)\s+(-?\d+\.\d)\*?\s+1:(\d+)/);
  const zen = rows('Adjusted Zenith Observations', 'Adjusted Direction Observations', /^\s+(\S+)\s+(\S+)\s+(\d+-\d+-\d+\.\d+)\s+(-?\d+-\d+-\d+\.\d+)\s+(-?\d+\.\d+)\s+(\d\.\d+)\s+(-?\d+\.\d)\*?\s+1:(\d+)/);
  assert.equal(dist.length, 192); assert.equal(zen.length, 192);
  const mine = (k) => r.observations.filter((o) => o.kind === k);
  mine('dist').forEach((o, i) => assert.equal(o.sigma.toFixed(4), dist[i][5], `distance ${o.from}-${o.to} line ${o.line}`));
  // Some angles sit on a rounding edge (ours 7.4348", printed 7.44"), so allow half a unit of the last
  // printed digit plus 0.0005".
  mine('zen').forEach((o, i) => near(assert, o.sigma * RHO_ARCSEC, +zen[i][6], 0.0055, `zenith ${o.from}-${o.to} line ${o.line}`));
});

test('observation residuals agree with the listing (distance 0.0001 m, angle 0.1")', opt, () => {
  const a = lst.findIndex((l) => l.includes('Adjusted Zenith Observations'));
  const b = lst.findIndex((l) => l.includes('Adjusted Direction Observations'));
  const zen = lst.slice(a, b).map((l) => /^\s+(\S+)\s+(\S+)\s+(\d+-\d+-\d+\.\d+)\s+(-?\d+-\d+-\d+\.\d+)\s+/.exec(l)).filter(Boolean);
  const mine = r.observations.filter((o) => o.kind === 'zen');
  mine.forEach((o, i) => near(assert, o.residual * RHO_ARCSEC, dms2s(zen[i][4]), 0.1, `zenith residual ${o.from}-${o.to}`));
});
