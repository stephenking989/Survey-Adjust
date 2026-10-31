// Leica GSI reader: the examples and unit codes from Leica's guide, the conversion rules, and a round trip
// (a .dat written out as GSI, read back and adjusted must give the same network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGsiLine, readGsi, gsiToDat, looksLikeGsi, GsiError, parseDat, runAdjustment, defaultSettings, checkData } from '../engine/index.js';
import { near } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample3d = fs.readFileSync(path.join(here, '..', 'app', 'samples', '3D_SAMPLE.dat'), 'utf8').replace(/\r\n/g, '\n');

// ---- A GSI writer, independent of the reader, following the layout in Leica's guide ---------------------

/** One block: word index, unit code, an integer in implied-decimal units, data width 8 or 16. Angles carry a "0" in position 4. */
const num = (wi, unit, int, width) => `${wi}.${wi === '21' || wi === '22' ? '0' : '.'}0${unit}${int < 0 ? '-' : '+'}${String(Math.abs(Math.round(int))).padStart(width, '0')}`;
const gonBlock = (wi, deg, width) => num(wi, 2, (deg / 0.9) * 1e5, width);
const mBlock = (wi, metres, width) => num(wi, 0, metres * 1e3, width);

function writeGsi(rows, width = 16) {
  return rows.map((r) => (Array.isArray(r) ? r.join(' ') : r)).join('\r\n') + '\r\n';
}

// ---- The format --------------------------------------------------------------------------------------------

test('the GSI8 and GSI16 examples from the Leica guide read as printed there', () => {
  const g8 = parseGsiLine('110001+0000A110 81..00+00005387 82..00-00000992', 1);
  assert.deepEqual(g8.map((b) => b.wi), ['11', '81', '82']);
  assert.equal(g8[0].data, '0000A110');
  const { rows } = readGsi('110001+0000A110 81..00+00005387 82..00-00000992\r\n110002+0000A111 81..00+00007586 82..00-00003031\r\n');
  assert.equal(rows[0].id, 'A110');
  near(assert, rows[0].num['81'], 5.387, 1e-9);
  near(assert, rows[0].num['82'], -0.992, 1e-9);
  near(assert, rows[1].num['82'], -3.031, 1e-9);

  const g16 = readGsi('110001+000000000PNC0055 21.002+0000000013384650 22.002+0000000005371500\r\n');
  assert.equal(g16.rows[0].id, 'PNC0055');
  near(assert, g16.rows[0].num['21'], 133.8465 * 0.9, 1e-9);        // 400 gon, 5 decimals
  near(assert, g16.rows[0].num['22'], 53.715 * 0.9, 1e-9);
});

test('every unit code gives the right number of decimals', () => {
  const v = (block) => readGsi(`${block}\r\n`).rows[0].num;
  near(assert, v('31..00+00123456')['31'], 123.456, 1e-9);       // 0: metre, 1 mm
  near(assert, v('31..01+00123456')['31'], 123.456, 1e-9);       // 1: feet, 1/1000 ft
  near(assert, v('31..06+01234567')['31'], 123.4567, 1e-9);      // 6: metre, 1/10 mm
  near(assert, v('31..07+01234567')['31'], 123.4567, 1e-9);      // 7: feet, 1/10000 ft
  near(assert, v('31..08+12345678')['31'], 123.45678, 1e-9);     // 8: metre, 1/100 mm
  near(assert, v('21.022+12345678')['21'], 123.45678 * 0.9, 1e-9);   // 2: gon
  near(assert, v('21.023+12345678')['21'], 123.45678, 1e-9);     // 3: decimal degrees
  near(assert, v('21.024+12149400')['21'], 121 + 49 / 60 + 40 / 3600, 1e-12);   // 4: DDD.MMSSs, the guide's 121.4940
  near(assert, v('21.024+12149405')['21'], 121 + 49 / 60 + 40.5 / 3600, 1e-12);
  near(assert, v('21.025+12345678')['21'], 1234.5678 * 360 / 6400, 1e-9);   // 5: mil, 4 decimals
  near(assert, v('83..00-00000992')['83'], -0.992, 1e-9);
  assert.throws(() => readGsi('31..09+00123456\r\n'), GsiError);
  assert.throws(() => readGsi('21.024+12199900\r\n'), /not a valid sexagesimal/);
});

test('malformed lines are refused with their line number', () => {
  assert.throws(() => readGsi('110001+0000A110\r\nxx\r\n'), (e) => e instanceof GsiError && e.line === 2);
  assert.throws(() => parseGsiLine('110001+0000A110 21.022+123', 5), (e) => e instanceof GsiError && e.line === 5);
  assert.equal(looksLikeGsi('*110001+0000A110 21.022+16640000 22.022+10015000\r\n'), true);
  assert.equal(looksLikeGsi('E A 100 !\nL A-B 1 100\n'), false);
  assert.equal(looksLikeGsi(''), false);
});

// ---- Conversion rules ----------------------------------------------------------------------------------------

const station = (id, e, n, h, hi) => ['110001+' + String(id).padStart(8, '0'), `84..16+${String(Math.round(e * 1e4)).padStart(8, '0')}`, `85..16+${String(Math.round(n * 1e4)).padStart(8, '0')}`, `86..16+${String(Math.round(h * 1e4)).padStart(8, '0')}`, `88..16+${String(Math.round(hi * 1e4)).padStart(8, '0')}`].join(' ');
const shot = (id, hzDeg, zDeg, slope, ht = 0) => ['110002+' + String(id).padStart(8, '0'), gonBlock('21', hzDeg, 8), gonBlock('22', zDeg, 8), mBlock('31', slope, 8), `87..16+${String(Math.round(ht * 1e4)).padStart(8, '0')}`].join(' ');

test('station lines, direction sets and face 2 reduction', () => {
  const text = writeGsi([
    station('S1', 1000, 2000, 50, 1.5),
    shot('B1', 10, 88, 100.0, 1.3),            // face 1
    shot('B2', 100, 91, 120.5, 1.3),
    shot('B1', 190, 272, 100.0, 1.3),          // face 2 of B1: zenith 360 - 88, Hz + 180
    shot('B2', 280, 269, 120.5, 1.3),
  ]);
  const r = gsiToDat(text, { name: 'x' });
  assert.equal(r.summary.sets, 2);          // the second B1 repeats a target, so it starts a new set
  assert.equal(r.summary.face2, 2);
  assert.equal(r.summary.dimension, 3);
  const p = parseDat(r.text);
  const dm = p.records.filter((x) => x.type === 'DM');
  assert.equal(dm.length, 4);
  assert.deepEqual(dm.map((x) => x.to), ['B1', 'B2', 'B1', 'B2']);
  near(assert, dm[0].direction, 10, 1e-5); near(assert, dm[2].direction, 10, 1e-5);       // face 2 reduced to face 1
  near(assert, dm[0].zenith, 88, 1e-5); near(assert, dm[2].zenith, 88, 1e-5);
  assert.deepEqual([dm[0].hi, dm[0].ht], [1.5, 1.3]);
  const c = p.records.find((x) => x.type === 'C');
  assert.deepEqual([c.name, c.north, c.east, c.elevation, c.status.north], ['S1', 2000, 1000, 50, 'fixed']);
});

test('a horizontal distance with a height difference becomes a slope distance and zenith; lines without a station are flagged', () => {
  const hd = 100; const dh = 10;
  const text = writeGsi([['110001+0000T001', gonBlock('21', 45, 8), mBlock('32', hd, 8), mBlock('33', dh, 8), '87..16+00000000']]);
  const r = gsiToDat(text, { name: 'x', station: 'ST' });
  assert.ok(r.warnings.some((w) => /assumed to be from station ST/.test(w.message)));
  const dm = parseDat(r.text).records.find((x) => x.type === 'DM');
  near(assert, dm.distance, Math.hypot(hd, dh), 5e-5);
  near(assert, dm.zenith, (Math.atan2(hd, dh) * 180) / Math.PI, 1e-5);
});

test('feet, decimal degrees and mils are converted and the units written', () => {
  const text = ['110001+000000S1 84..11+00100000 85..11+00200000 86..11+00000000 88..11+00000000', '110002+000000P1 21.023+09000000 22.023+09000000 31..01+00100000 87..11+00000000'].join('\r\n') + '\r\n';
  const r = gsiToDat(text, {});
  assert.match(r.text, /\.UNITS Feet/);
  const p = parseDat(r.text);
  const c = p.records.find((x) => x.type === 'C');
  assert.deepEqual([c.north, c.east], [200, 100]);
  near(assert, p.records.find((x) => x.type === 'DM').direction, 90, 1e-5);
  near(assert, p.records.find((x) => x.type === 'DM').distance, 100, 1e-9);
});

// ---- Round trip: the 3D sample written as GSI and read back adjusts to the same network ------------------------

function sampleAsGsi(width) {
  const p = parseDat(sample3d);
  const rows = [];
  const ctl = new Map(p.records.filter((r) => r.type === 'C').map((r) => [r.name, r]));
  let at = null;
  for (const r of p.records) {
    if (r.type === 'DB') {
      at = r.at;
      const c = ctl.get(at);
      const hi = 1.5;
      rows.push(c ? station(at, c.east, c.north, c.elevation, hi) : ['16' + '0001+' + at.padStart(8, '0'), '88..16+00015000']);
    } else if (r.type === 'DM') {
      rows.push(['110002+' + String(r.to).padStart(8, '0'), gonBlock('21', r.direction, 8), gonBlock('22', r.zenith, 8), mBlock('31', r.distance, 8), `87..16+${String(Math.round((r.ht || 0) * 1e4)).padStart(8, '0')}`]);
    }
  }
  void width;
  return writeGsi(rows);
}

test('the 3D sample written out as GSI and converted back adjusts to the same coordinates', () => {
  const s = defaultSettings();
  s.instrument = { ...s.instrument, distanceConstant: 0.0007, distancePpm: 2, direction: 3, zenith: 3, angle: 4, azimuth: 4 };
  const original = runAdjustment([{ name: 'o.dat', text: sample3d }], s, {});
  const gsi = sampleAsGsi();
  assert.equal(looksLikeGsi(gsi), true);
  const conv = gsiToDat(gsi, { name: 'g' });
  assert.equal(conv.summary.sets, 10);
  assert.equal(conv.summary.directionsWithDistance, 32);
  const back = runAdjustment([{ name: 'g.dat', text: conv.text }], s, {});
  assert.equal(back.result.stats.nObservations, original.result.stats.nObservations);
  assert.equal(back.result.stats.nUnknowns, original.result.stats.nUnknowns);
  for (const st of original.result.stations) {
    const t = back.result.stations.find((x) => x.name === st.name);
    // GSI keeps 1 mm and 0.00001 gon, so the rounded observations move the answer by well under a millimetre.
    near(assert, t.n, st.n, 0.001, st.name); near(assert, t.e, st.e, 0.001, st.name); near(assert, t.z, st.z, 0.001, st.name);
  }
  near(assert, back.result.stats.errorFactor, original.result.stats.errorFactor, 0.05);
  assert.equal(checkData([{ name: 'g.dat', text: conv.text }], s).ok, true);
});

test('the GSI sample file in the app converts and adjusts', () => {
  const file = path.join(here, '..', 'app', 'samples', 'GSI_SAMPLE.gsi');
  const gsi = fs.readFileSync(file, 'utf8');
  assert.equal(looksLikeGsi(gsi), true);
  const conv = gsiToDat(gsi, {});
  const s = defaultSettings();
  s.instrument = { ...s.instrument, distanceConstant: 0.0007, distancePpm: 2, direction: 3, zenith: 3 };
  const out = runAdjustment([{ name: 's.dat', text: conv.text }], s, {});
  assert.equal(out.kind, '3d');
  assert.equal(out.result.stats.chiSquare.passed, true);
});
