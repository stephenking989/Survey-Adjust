import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDat } from '../engine/parser.js';
import { adjustLevelling, AdjustmentError } from '../engine/level.js';
import { defaultSettings } from '../engine/project.js';
import { near } from './helpers.js';

const settings = (over = {}) => ({ ...defaultSettings(), levelStdErr: 0.001, ...over });
const run = (dat, over) => adjustLevelling(parseDat(dat), settings(over));

test('two equal-weight runs A->B: adjusted B is the mean, both residuals are minus half the misclosure', () => {
  // 1 km each, sigma = 0.001 m. Runs disagree by 0.002.
  const r = run('E A 100 !\nL A-B 1.002 1000\nL B-A -1.000 1000\n', { errorScaling: 'always' });
  const B = r.stations.find((s) => s.name === 'B');
  near(assert, B.elevation, 101.001, 1e-9);
  near(assert, r.observations[0].residual, -0.001, 1e-9);
  // Second run is B->A = -1.000 (so B-A = 1.000); adjusted B-A = 1.001, i.e. A-B = -1.001: also -0.001.
  near(assert, r.observations[1].residual, -0.001, 1e-9);
  assert.equal(r.stats.dof, 1);
  assert.equal(r.stats.nUnknowns, 1);
  near(assert, r.stats.sumSqStdRes, 2, 1e-9);        // (1 + 1)
  near(assert, r.stats.errorFactor, Math.SQRT2, 1e-9);
  // Unscaled std dev of B: sigma / sqrt(2) = 0.000707; scaled by error factor sqrt2 -> 0.001.
  near(assert, B.stdDev, 0.001, 1e-9);
});

test("errorScaling 'never' gives pure a-priori propagation; 'auto' leaves a passing test unscaled", () => {
  const r = run('E A 100 !\nL A-B 1.002 1000\nL B-A -1.000 1000\n', { errorScaling: 'never' });
  near(assert, r.stations.find((s) => s.name === 'B').stdDev, 0.001 / Math.SQRT2, 1e-9);
  assert.equal(r.stats.errorFactorApplied, 1);
  // Error factor 1.41 is inside the 5% chi-square bounds for 1 dof, so STAR*NET's rule does not scale.
  const auto = run('E A 100 !\nL A-B 1.002 1000\nL B-A -1.000 1000\n');
  assert.equal(auto.stats.chiSquare.passed, true);
  assert.equal(auto.stats.errorFactorApplied, 1);
  near(assert, auto.stations.find((s) => s.name === 'B').stdDev, 0.001 / Math.SQRT2, 1e-9);
});

test('weights follow sigma^2 = c^2 * length(km): a short run outweighs a long one', () => {
  // Run 1 is 0.25 km, run 2 is 1 km: weights 4:1, so B = (4*1.010 + 1*1.000)/5 above A.
  const r = run('E A 100 !\nL A-B 1.010 250\nL A-B 1.000 1000\n');
  near(assert, r.stations[1].elevation, 100 + (4 * 1.010 + 1.000) / 5, 1e-9);
  near(assert, r.observations[0].stdErr, 0.001 * Math.sqrt(0.25), 1e-12);
});

test('explicit std error on an L record overrides the per-km formula', () => {
  const r = run('E A 100 !\nL A-B 1.0 1000 0.01\n');
  assert.equal(r.observations[0].stdErr, 0.01);
});

test('.LEVEL in the data file overrides the project setting', () => {
  const r = run('.LEVEL 0.004 LENGTH\nE A 100 !\nL A-B 1.0 1000\n');
  near(assert, r.observations[0].stdErr, 0.004, 1e-12);
});

test('a weighted control point is adjusted and counts as an observation', () => {
  // A fixed 100. B entered 101.0 with sigma 0.001 (1 mm). A->B measured 1.002 over 1 km (sigma 1 mm).
  const r = run('E A 100 !\nE B 101.0 0.001\nL A-B 1.002 1000\n');
  const B = r.stations.find((s) => s.name === 'B');
  near(assert, B.elevation, 101.001, 1e-9);
  assert.equal(r.stats.nObservations, 2);
  assert.equal(r.stats.nUnknowns, 1);
  assert.equal(r.stats.dof, 1);
  assert.equal(r.weightedControl.length, 1);
  near(assert, r.weightedControl[0].residual, 0.001, 1e-9);   // adjusted - entered
});

test('free control values are only starting points', () => {
  const r = run('E A 100 !\nE B 250 *\nL A-B 1.0 1000\n');
  near(assert, r.stations[1].elevation, 101.0, 1e-9);
  assert.equal(r.stats.dof, 0);
  assert.equal(r.stats.chiSquare, null);
});

test('a single run to a fixed station has no redundancy and no chi-square test', () => {
  const r = run('E A 100 !\nL A-B 1.0 1000\n');
  assert.equal(r.stats.dof, 0);
  assert.equal(r.stats.errorFactor, 1);
});

test('two fixed stations: misclosure is distributed by length', () => {
  // A=100, C=102 fixed; A->B 1.2 over 3 km, B->C 0.7 over 1 km. Misclosure = 102-100-1.9 = 0.1.
  // Distribution is proportional to variance (= length): B->C takes 3/4 of... check via weights:
  const r = run('E A 100 !\nE C 102 !\nL A-B 1.2 3000\nL B-C 0.7 1000\n');
  const B = r.stations.find((s) => s.name === 'B');
  // Residuals v1, v2 with v1 + v2 = 0.1 and v1/sigma1^2 = v2/sigma2^2  ->  v1 = 0.075, v2 = 0.025.
  near(assert, r.observations[0].residual, 0.075, 1e-9);
  near(assert, r.observations[1].residual, 0.025, 1e-9);
  near(assert, B.elevation, 100 + 1.2 + 0.075, 1e-9);
});

test('a network with no fixed or weighted control is rejected with a clear message', () => {
  assert.throws(() => run('E A 100 *\nL A-B 1.0 1000\nL B-A -1.0 1000\n'), (e) => e instanceof AdjustmentError && /No vertical control/.test(e.message));
});

test('a disconnected island is rejected', () => {
  assert.throws(() => run('E A 100 !\nL A-B 1.0 1000\nL X-Y 1.0 1000\n'), (e) => e instanceof AdjustmentError && /X, Y|Y, X/.test(e.message));
});

test('missing length (and no std error) is rejected with the line number', () => {
  assert.throws(() => run('E A 100 !\nL A-B 1.0 0\n'), (e) => e instanceof AdjustmentError && /Line 2/.test(e.message));
});

test('feet use a per-mile distance', () => {
  const r = run('.UNITS Feet\nE A 100 !\nL A-B 1.0 5280\n', { linearUnits: 'feet' });
  near(assert, r.observations[0].stdErr, 0.001, 1e-12);     // exactly 1 mile
});

test('unused free stations are ignored with a warning', () => {
  const r = run('E A 100 !\nE Z 5 *\nL A-B 1.0 1000\n');
  assert.equal(r.stations.length, 2);
  assert.ok(r.warnings.some((w) => /Station Z/.test(w.message)));
});

test('flagging uses the |StdRes| threshold', () => {
  const r = run('E A 100 !\nL A-B 1.0 1000\nL A-B 1.0 1000\nL A-B 1.0 1000\nL A-B 1.002 1000\n', { stdResFlag: 3 });
  assert.equal(r.observations.filter((o) => o.flagged).length, 0);
  const r2 = run('E A 100 !\nL A-B 1.0 1000\nL A-B 1.0 1000\nL A-B 1.0 1000\nL A-B 1.002 1000\n', { stdResFlag: 1 });
  assert.ok(r2.observations.some((o) => o.flagged));
});
