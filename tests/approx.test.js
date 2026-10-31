import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDat, adjustNetwork3D, settingsFromSnproj, LINEAR_UNITS, runAdjustment, detectKind, AdjustmentError } from '../engine/index.js';
import { geom } from '../engine/network3d.js';
import { near } from './helpers.js';

const R = 6372000;
const DEG = Math.PI / 180;

function dmsStr(deg) {
  const t = Math.round(deg * 3600 * 1000) / 1000;
  const d = Math.floor(t / 3600); const m = Math.floor((t - d * 3600) / 60);
  return `${d}-${m}-${(t - d * 3600 - m * 60).toFixed(3)}`;
}

const TRUTH = {
  A: { n: 5000, e: 5000, z: 120 }, B: { n: 5090, e: 5130, z: 121.4 }, C: { n: 5210, e: 4950, z: 118.9 },
  D: { n: 5040, e: 5260, z: 122.2 }, E: { n: 5300, e: 5200, z: 119.5 },
};
const k = 0.07;
const q = (0.5 - k) / R;
const OMEGA = { A: 1.1, B: 3.3, C: 5.0, D: 2.2, E: 0.4 };

/** One direction set at `at` to the listed targets, using the engine's own geometry. */
function set(at, targets, hi = 1.5, ht = 1.2) {
  const rows = [`DB ${at}`];
  for (const to of targets) {
    const g = geom(TRUTH[at], TRUTH[to], hi, ht);
    const dir = (((g.az - OMEGA[at]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    rows.push(`DM ${to} ${dmsStr(dir / DEG)} ${g.S.toFixed(5)} ${dmsStr((g.z + q * g.Dh) / DEG)} ${hi}/${ht}`);
  }
  rows.push('DE');
  return rows;
}

const OBS = [
  ...set('A', ['B', 'C', 'D']), ...set('B', ['A', 'C', 'D', 'E']), ...set('C', ['A', 'B', 'E']),
  ...set('D', ['A', 'B', 'E']), ...set('E', ['B', 'C', 'D']),
];
const settings = () => {
  const s = settingsFromSnproj('[Adjustment]\n[Instrument]\n');
  s.unitsInfo = LINEAR_UNITS.meters;
  s.instrument = { ...s.instrument, distanceConstant: 0.001, distancePpm: 2, direction: 3, zenith: 3 };
  return s;
};

test('only A and B are entered; C, D and E are computed from the observations and the answer is exact', () => {
  const dat = ['.3D', '.REF 0.07', 'C A 5000 5000 120 ! ! !', 'C B 5090 5130 121.4 ! ! !', ...OBS].join('\n');
  const r = adjustNetwork3D(parseDat(dat), settings());
  assert.equal(r.stations.length, 5);
  for (const s of r.stations) {
    near(assert, s.n, TRUTH[s.name].n, 3e-5, `${s.name} N`);
    near(assert, s.e, TRUTH[s.name].e, 3e-5, `${s.name} E`);
    near(assert, s.z, TRUTH[s.name].z, 3e-5, `${s.name} Z`);
  }
  const notes = r.warnings.filter((w) => /starting coordinates were computed/.test(w.message));
  assert.deepEqual(notes.map((w) => w.message.match(/Station (\w)/)[1]).sort(), ['C', 'D', 'E']);
});

test('a fixed azimuth (B record) orients a set when no target has coordinates yet', () => {
  // Only A is known. Set at A to B carries the whole story: A -> B has azimuth 31.65 deg by B record.
  const g = geom(TRUTH.A, TRUTH.B, 1.5, 1.2);
  const az = (g.az / DEG).toFixed(6);
  const dat = ['.3D', '.REF 0.07', 'C A 5000 5000 120 ! ! !', `B A-B ${dmsStr(Number(az))} !`, ...set('A', ['B', 'C']), ...set('B', ['A', 'C']), ...set('C', ['A', 'B'])].join('\n');
  const r = adjustNetwork3D(parseDat(dat), settings());
  near(assert, r.stations.find((s) => s.name === 'B').n, TRUTH.B.n, 5e-5);
  near(assert, r.stations.find((s) => s.name === 'C').e, TRUTH.C.e, 5e-5);
});

test('M record (angle + distance + zenith) also yields a starting position', () => {
  const A = TRUTH.A; const B = TRUTH.B; const D = TRUTH.D;
  const gB = geom(A, B, 1.5, 1.2); const gD = geom(A, D, 1.5, 1.2);
  const ang = (((gD.az - gB.az) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const dat = ['.3D', '.REF 0.07', 'C A 5000 5000 120 ! ! !', 'C B 5090 5130 121.4 ! ! !',
    `M A-B-D ${dmsStr(ang / DEG)} ${gD.S.toFixed(5)} ${dmsStr((gD.z + q * gD.Dh) / DEG)} 1.5/1.2`].join('\n');
  const r = adjustNetwork3D(parseDat(dat), settings());
  near(assert, r.stations.find((s) => s.name === 'D').n, TRUTH.D.n, 5e-3);   // before any redundancy: starting position only
  assert.ok(r.stats.nObservations >= 3);
});

test('unreachable stations are named', () => {
  const dat = ['.3D', 'C A 5000 5000 120 ! ! !', 'DB A', 'DM Q 000-00-00 100 090-00-00 1.5/1.2', 'DE'].join('\n');
  assert.throws(() => adjustNetwork3D(parseDat(dat), settings()), (e) => e instanceof AdjustmentError && /approximate coordinates for Q/.test(e.message));
});

test('runAdjustment routes level files and total-station files, and rejects a mix', () => {
  const lvl = runAdjustment('E A 100 !\nL A-B 1.0 1000\n', { ...settings(), levelStdErr: 0.001, errorScaling: 'auto' });
  assert.equal(lvl.kind, 'level');
  const dat = ['.3D', '.REF 0.07', 'C A 5000 5000 120 ! ! !', 'C B 5090 5130 121.4 ! ! !', ...OBS].join('\n');
  const ts = runAdjustment(dat, settings());
  assert.equal(ts.kind, '3d');
  assert.match(ts.report.text, /Type of Adjustment\s+: 3D/);
  assert.equal(ts.csv('PNEZD').trim().split('\r\n').length, 5);
  assert.throws(() => detectKind(parseDat('E A 100 !\nL A-B 1 100\nD A-B 100\n')), AdjustmentError);
});

// ---- Second real job (local-only fixture): one control point, fixed azimuth, M/DN/DV records ----

const here = path.dirname(fileURLToPath(import.meta.url));
const file = (e) => path.join(here, 'fixtures', 'local', `NET_B.${e}`);
const have = ['dat', 'lst', 'pts', 'snproj'].every((e) => fs.existsSync(file(e)));

test('NET_B: counts, error factor, chi-square and coordinates match the STAR*NET run', { skip: have ? false : 'local fixture NET_B.* not present' }, () => {
  const s = settingsFromSnproj(fs.readFileSync(file('snproj'), 'utf8'));
  const r = runAdjustment(fs.readFileSync(file('dat'), 'utf8'), s).result;
  assert.deepEqual([r.stats.nStations, r.stats.nObservations, r.stats.nUnknowns, r.stats.dof], [9, 246, 50, 196]);
  near(assert, r.stats.errorFactor, 0.947, 0.001);
  assert.equal(r.stats.chiSquare.passed, true);
  assert.equal(r.stats.chiSquare.lowerBound.toFixed(3), '0.901');
  assert.equal(r.stats.chiSquare.upperBound.toFixed(3), '1.099');
  const ss = Object.fromEntries(r.stats.classes.map((c) => [c.name, c.sumSq]));
  // Exact where no instrument centering is involved; within 0.07 (0.04% of the total) elsewhere.
  // Known cause: this job sets instrument centering = 1 mm, which STAR*NET models as a correlation
  // between the directions of a set; we do not yet (the engine warns).
  near(assert, ss.Angles, 0.096, 0.001);
  near(assert, ss.Azimuths, 0.000, 0.001);
  near(assert, ss.Directions, 39.668, 0.01);
  near(assert, ss.Distances, 34.517, 0.07);
  near(assert, ss.Zeniths, 101.358, 0.02);
  const pts = Object.fromEntries(fs.readFileSync(file('pts'), 'utf8').trim().split(/\r?\n/).map((l) => { const t = l.trim().split(/\s+/); return [t[0], { n: +t[1], e: +t[2], z: +t[3] }]; }));
  let worst = 0;
  for (const st of r.stations) { const p = pts[st.name]; worst = Math.max(worst, Math.abs(st.n - p.n), Math.abs(st.e - p.e), Math.abs(st.z - p.z)); }
  assert.ok(worst < 0.00005, `worst coordinate difference ${worst}`);
  assert.ok(r.warnings.some((w) => /correlation/.test(w.message)));
});
