// Validation against a real STAR*NET-PRO 14 run (LEVEL_JOB).
// Expected values are read from the STAR*NET .lst / .pts files themselves;
// project settings come from the .snproj (the .dat does not carry them).
//
// The tolerances below are the ones set in the brief, or the rounding of the
// printed value - they are not loosened to make the test pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdjustment, settingsFromSnproj, defaultSettings } from '../engine/index.js';
import { fixture, near } from './helpers.js';

const dat = fixture('LEVEL_JOB.dat');
const lst = fixture('LEVEL_JOB.lst');
const pts = fixture('LEVEL_JOB.pts');
const snproj = fixture('LEVEL_JOB.snproj');

const settings = settingsFromSnproj(snproj);
const run = runAdjustment(dat, settings, { projectName: 'LEVEL_JOB', runDate: new Date(2026, 9, 30, 8, 3, 50) });
const { result } = run;
const st = result.stats;

// ---- Read the expected answers out of the .lst ----------------------------
function section(title) {
  const i = lst.indexOf(title);
  assert.ok(i >= 0, `section "${title}" not found in .lst`);
  return lst.slice(i);
}
const expectedStations = [];
for (const line of section('Adjusted Elevations and Error Propagation').split(/\r?\n/).slice(3)) {
  const m = /^(\S+)\s+(-?\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s*$/.exec(line);
  if (m) expectedStations.push({ name: m[1], elev: +m[2], sd: +m[3], sd68: +m[4] });
  else if (expectedStations.length) break;
}
const expectedObs = [];
for (const line of section('Adjusted Differential Level Observations').split(/\r?\n/)) {
  const m = /^(\S+)\s+(\S+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d)(\*?)\s+1:(\d+)\s*$/.exec(line);
  if (m) expectedObs.push({ from: m[1], to: m[2], adj: +m[3], v: +m[4], stdRes: +m[6], flag: m[7] === '*', line: +m[8] });
}

test('settings read from the .snproj: 0.0002 m/km, 5% chi-square', () => {
  near(assert, settings.levelStdErr, 0.0002, 1e-12, 'level std err per km');
  assert.equal(settings.chiSquarePercent, 5);
  assert.equal(settings.levelSectionType, 'LENGTH');
  assert.equal(settings.linearUnits, 'meters');
});

test('the .lst parsed cleanly (40 stations, 50 observations)', () => {
  assert.equal(expectedStations.length, 40);
  assert.equal(expectedObs.length, 50);
});

test('counts: 40 stations, 50 observations, 39 unknowns, 11 redundant', () => {
  assert.equal(st.nStations, 40);
  assert.equal(st.nObservations, 50);
  assert.equal(st.nUnknowns, 39);
  assert.equal(st.dof, 11);
});

test('sum of squares of StdRes 441.532 and error factor 6.336 (+/-0.001)', () => {
  near(assert, st.sumSqStdRes, 441.532, 0.001, 'sum squares');
  near(assert, st.errorFactor, 6.336, 0.001, 'error factor');
});

test('chi-square FAILS above the upper bound; bounds 0.589 / 1.412', () => {
  assert.equal(st.chiSquare.passed, false);
  assert.equal(st.chiSquare.verdict, 'above-upper');
  assert.equal(st.chiSquare.lowerBound.toFixed(3), '0.589');
  assert.equal(st.chiSquare.upperBound.toFixed(3), '1.412');
});

test('adjusted elevations are within 0.00001 m of the .pts values', () => {
  const rows = pts.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/));
  assert.equal(rows.length, 40);
  for (const [name, elev] of rows) {
    const s = result.stations.find((x) => x.name === name);
    assert.ok(s, `station ${name} missing`);
    near(assert, s.elevation, Number(elev), 0.00001, `elevation ${name}`);
  }
});

test('station order matches the .lst', () => {
  assert.deepEqual(result.stations.map((s) => s.name), expectedStations.map((s) => s.name));
});

test('elevation std devs match the .lst (+/-0.000002 m): STAR*NET scales by the error factor', () => {
  for (const e of expectedStations) {
    const s = result.stations.find((x) => x.name === e.name);
    near(assert, s.stdDev, e.sd, 0.000002, `stddev ${e.name}`);
    near(assert, s.stdDevConf, e.sd68, 0.000002, `68% ${e.name}`);
  }
});

test('the same std devs WITHOUT scaling do not match (proves the scaling is real)', () => {
  const unscaled = runAdjustment(dat, { ...settings, scaleByErrorFactor: false }).result;
  const e = expectedStations.find((x) => x.name === 'N02');
  const s = unscaled.stations.find((x) => x.name === 'N02');
  assert.ok(Math.abs(s.stdDev - e.sd) > 1e-4, `unscaled ${s.stdDev} unexpectedly close to ${e.sd}`);
  near(assert, s.stdDev * st.errorFactor, e.sd, 0.000002);
});

test('adjusted observations: elev diff, residual, StdRes and * flags match the .lst', () => {
  assert.equal(result.observations.length, expectedObs.length);
  result.observations.forEach((o, i) => {
    const e = expectedObs[i];
    assert.equal(`${o.from}-${o.to}`, `${e.from}-${e.to}`);
    assert.equal(o.line, e.line, 'file line');
    near(assert, o.adjusted, e.adj, 0.00005 + 1e-9, `adjusted ${e.from}-${e.to}`);   // .lst prints 4 dp
    near(assert, o.residual, e.v, 0.00005 + 1e-9, `residual ${e.from}-${e.to}`);
    near(assert, Math.abs(o.stdRes), e.stdRes, 0.05 + 1e-9, `stdres ${e.from}-${e.to}`);   // printed to 1 dp
    assert.equal(o.flagged, e.flag, `flag on ${e.from}-${e.to} (StdRes ${o.stdRes})`);
  });
});

test('the report shows the failed chi-square and the same headline numbers', () => {
  const text = run.report.text;
  assert.match(text, /Number of Stations\s+=\s+40/);
  assert.match(text, /Number of Observations\s+=\s+50/);
  assert.match(text, /Number of Unknowns\s+=\s+39/);
  assert.match(text, /Number of Redundant Obs\s+=\s+11/);
  assert.match(text, /Total\s+50\s+441\.532\s+6\.336/);
  assert.match(text, /Warning: The Chi-Square Test at 5\.00% Level Exceeded Upper Bound/);
  assert.match(text, /Lower\/Upper Bounds \(0\.589\/1\.412\)/);
  assert.match(text, /Differential Levels\s+:\s+0\.000200 Meters \/ Km/);
  const warn = run.report.lines.filter((l) => l.tag === 'warn');
  assert.ok(warn.length >= 2);
  assert.equal(run.report.lines.filter((l) => l.tag === 'flag').length, st.nFlagged);
});

test('running with the plain 0.0002 m/km setting (as typed in the UI) gives the same answer', () => {
  const r = runAdjustment(dat, { ...defaultSettings(), levelStdErr: 0.0002 }).result;
  near(assert, r.stats.sumSqStdRes, 441.532, 0.001);
});

test('CSV export: PE and PNEZD', () => {
  const pe = run.csv('PE').trim().split('\r\n');
  assert.equal(pe.length, 40);
  assert.equal(pe[0], 'N01,6000.00000');
  assert.equal(pe[1], 'N02,5999.87003');
  const pnezd = run.csv('PNEZD').trim().split('\r\n');
  assert.equal(pnezd[1], 'N02,,,5999.87003,');
});
