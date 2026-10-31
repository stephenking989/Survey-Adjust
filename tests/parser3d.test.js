import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDat, parseAngle, parseBearing, DatParseError } from '../engine/parser.js';
import { near } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const local = (n) => path.join(here, 'fixtures', 'local', n);
const haveLocal = (n) => fs.existsSync(local(n));

test('parseAngle: D-M-S, packed DMS, decimal degrees, signs', () => {
  near(assert, parseAngle('087-14-00.3'), 87 + 14 / 60 + 0.3 / 3600, 1e-12);
  near(assert, parseAngle('087-14'), 87 + 14 / 60, 1e-12);
  near(assert, parseAngle('45.3015', ['DMS']), 45 + 30 / 60 + 15 / 3600, 1e-12);
  near(assert, parseAngle('45.30155', ['DMS']), 45 + 30 / 60 + 15.5 / 3600, 1e-12);
  near(assert, parseAngle('45.5', ['DD']), 45.5, 1e-12);
  near(assert, parseAngle('-00-30-00'), -0.5, 1e-12);
  assert.ok(Number.isNaN(parseAngle('10-75-00')));
  assert.ok(Number.isNaN(parseAngle('abc')));
});

test('parseBearing: quadrant bearings become azimuths', () => {
  near(assert, parseBearing('N45-00-00E'), 45, 1e-12);
  near(assert, parseBearing('S45-00-00E'), 135, 1e-12);
  near(assert, parseBearing('S45-00-00W'), 225, 1e-12);
  near(assert, parseBearing('N45-00-00W'), 315, 1e-12);
  near(assert, parseBearing('090-00-00.0'), 90, 1e-12);
});

test('.ORDER takes coordinate order and angle station order independently; .UNITS accumulates', () => {
  const p = parseDat('.UNITS METERS\n.UNITS DMS\n.ORDER NE\n.ORDER ATFROMTO\n.3D\n.DELTA OFF\n.CURVE ON\n.REF 0.142\n');
  assert.equal(p.state.order, 'NE');
  assert.equal(p.state.angleOrder, 'ATFROMTO');
  assert.deepEqual(p.state.units, ['METERS', 'DMS']);
  assert.equal(p.state.dimension, 3);
  assert.equal(p.state.delta, false);
  assert.equal(p.state.curve, true);
  assert.equal(p.state.refraction, 0.142);
});

test('direction set: DB / DM / DN / DV / DE with HI/HT and std errors', () => {
  const p = parseDat([
    '.3D', 'DB 100 # round 1',
    'DM P3 000-00-00.0 65.7767 083-00-18.7 1.483/0.000  # F1',
    'DN 6004 074-12-36.8',
    'DV 6005 111.0680 083-36-09.4 1.483/0.030 5 0.001 3',
    'DE', 'DB 100', 'DM P3 000-00-00.2 65.7786 083-00-12.9 1.483/0.000', 'DE'].join('\n'));
  const r = p.records;
  assert.deepEqual(r.map((x) => x.type), ['DB', 'DM', 'DN', 'DV', 'DE', 'DB', 'DM', 'DE']);
  assert.deepEqual(r.map((x) => x.set), [1, 1, 1, 1, 1, 2, 2, 2]);
  assert.equal(r[1].at, '100');
  assert.equal(r[1].to, 'P3');
  near(assert, r[1].distance, 65.7767, 1e-12);
  near(assert, r[1].zenith, 83 + 18.7 / 3600, 1e-9);
  assert.deepEqual([r[1].hi, r[1].ht], [1.483, 0]);
  assert.equal(r[2].type, 'DN');
  assert.deepEqual(r[3].stdErr, { distance: 5, zenith: 0.001 });
  assert.deepEqual([r[3].hi, r[3].ht], [1.483, 0.03]);
  assert.equal(r[3].from, '100');
});

test('DM outside a set, DB inside a set, and an unclosed set are reported', () => {
  assert.throws(() => parseDat('DM 1 000-00-00 10 090-00-00\n'), (e) => e instanceof DatParseError && e.line === 1 && /outside a direction set/.test(e.message));
  assert.throws(() => parseDat('DB 1\nDB 2\n'), (e) => e instanceof DatParseError && e.line === 2);
  const p = parseDat('DB 1\nDM 2 000-00-00 10 090-00-00\n');
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0].message, /never closed/);
});

test('A, B, D, V, M records: hyphenated and spaced station lists, ATFROMTO order', () => {
  const p = parseDat([
    'A 2-1-3 090-00-00 3', 'B P0-P1 090-00-00.0 !', 'B 1 2 N45-00-00E',
    'D 1-2 123.456 0.002 1.5/1.2', 'V 1-2 089-30-00 5', 'M P2-P0-P7 132-56-20.0 52.2525 089-01-51.7 1.389/1.375',
    'M 2 1 3 010-00-00 100.5'].join('\n'));
  const [a, b1, b2, d, v, m1, m2] = p.records;
  assert.deepEqual([a.at, a.from, a.to], ['2', '1', '3']);
  assert.deepEqual(a.stdErr, { angle: 3 });
  assert.equal(b1.stdErr.azimuth, 'fixed');
  near(assert, b1.azimuth, 90, 1e-12);
  assert.deepEqual([b2.from, b2.to], ['1', '2']);
  near(assert, b2.azimuth, 45, 1e-12);
  assert.deepEqual([d.distance, d.stdErr.distance, d.hi, d.ht], [123.456, 0.002, 1.5, 1.2]);
  near(assert, v.zenith, 89.5, 1e-12);
  assert.deepEqual([m1.at, m1.from, m1.to, m1.distance], ['P2', 'P0', 'P7', 52.2525]);
  near(assert, m1.zenith, 89 + 1 / 60 + 51.7 / 3600, 1e-9);
  assert.deepEqual([m1.hi, m1.ht], [1.389, 1.375]);
  assert.equal(m2.zenith, null);
});

test('FROMATTO order swaps the first two stations', () => {
  const p = parseDat('.ORDER FROMTOAT\n.ORDER FROMATTO\nA 1-2-3 090-00-00\n');
  assert.deepEqual([p.records[0].from, p.records[0].at, p.records[0].to], ['1', '2', '3']);
});

test('3D control with per-component std errors', () => {
  const p = parseDat(".3D\nC P3 5118.7739 5130.8033 5010.0381 0.0010 0.0008 0.0010 'RP P9\nC P36 5076.778 5080.815 5000.544 * * *\nC P0 1 2 3 ! ! !\n");
  assert.deepEqual(p.records[0].stdErr, { north: 0.001, east: 0.0008, elevation: 0.001 });
  assert.deepEqual(p.records[0].status, { north: 'weighted', east: 'weighted', elevation: 'weighted' });
  assert.equal(p.records[0].description, 'RP P9');
  assert.deepEqual(p.records[1].status, { north: 'free', east: 'free', elevation: 'free' });
  assert.deepEqual(p.records[2].status, { north: 'fixed', east: 'fixed', elevation: 'fixed' });
});

// ---- Real jobs (local-only fixtures; skipped when absent) -------------------

test('NET_A.dat parses completely: 192 DM, 24 sets, 25 C, no warnings', { skip: !haveLocal('NET_A.dat') }, () => {
  const p = parseDat(fs.readFileSync(local('NET_A.dat'), 'utf8'));
  const count = (t) => p.records.filter((r) => r.type === t).length;
  assert.equal(count('DM'), 192);
  assert.equal(count('DB'), 24);
  assert.equal(count('DE'), 24);
  assert.equal(count('C'), 25);
  assert.equal(p.records.filter((r) => r.type === 'unsupported').length, 0);
  assert.equal(p.warnings.length, 0);
  assert.equal(p.state.dimension, 3);
  assert.equal(p.state.refraction, 0.142);
  assert.equal(p.records.filter((r) => r.type === 'C' && r.status.north === 'weighted').length, 3);
});

test('NET_B.dat parses completely (B, DN, DV, M, DM)', { skip: !haveLocal('NET_B.dat') }, () => {
  const p = parseDat(fs.readFileSync(local('NET_B.dat'), 'utf8'));
  const count = (t) => p.records.filter((r) => r.type === t).length;
  assert.equal(count('DM') + count('DN') + count('DV'), p.records.filter((r) => ['DM', 'DN', 'DV'].includes(r.type)).length);
  assert.ok(count('B') >= 1 && count('M') >= 1);
  assert.equal(p.records.filter((r) => r.type === 'unsupported').length, 0);
});
