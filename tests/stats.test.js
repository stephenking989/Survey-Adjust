import test from 'node:test';
import assert from 'node:assert/strict';
import { chiSquareQuantile, chiSquareCdf, normalQuantile, normalCdf, chiSquareTest } from '../engine/stats.js';
import { near } from './helpers.js';

test('chi-square quantiles match published table values', () => {
  near(assert, chiSquareQuantile(0.95, 1), 3.841459, 1e-5);
  near(assert, chiSquareQuantile(0.975, 11), 21.920049, 1e-5);
  near(assert, chiSquareQuantile(0.025, 11), 3.815748, 1e-5);
  near(assert, chiSquareQuantile(0.5, 10), 9.341818, 1e-5);
  near(assert, chiSquareQuantile(0.99, 100), 135.806723, 1e-4);
});

test('chi-square CDF and quantile are inverses', () => {
  for (const k of [1, 2, 5, 11, 40]) {
    for (const p of [0.025, 0.5, 0.975]) near(assert, chiSquareCdf(chiSquareQuantile(p, k), k), p, 1e-12);
  }
});

test('normal quantile matches known z-values', () => {
  near(assert, normalQuantile(0.975), 1.959964, 1e-6);
  near(assert, normalQuantile(0.84), 0.994458, 1e-6);   // two-sided 68% -> 0.9945
  near(assert, normalCdf(0), 0.5, 1e-15);
  near(assert, normalCdf(1.96), 0.975002, 1e-6);
});

test('chiSquareTest reports error-factor bounds and a verdict', () => {
  const pass = chiSquareTest(11, 11, 0.05);
  assert.equal(pass.verdict, 'passed');
  const high = chiSquareTest(441.532, 11, 0.05);
  assert.equal(high.verdict, 'above-upper');
  near(assert, high.lowerBound, 0.589, 5e-4);
  near(assert, high.upperBound, 1.412, 5e-4);
  const low = chiSquareTest(1, 11, 0.05);
  assert.equal(low.verdict, 'below-lower');
});
