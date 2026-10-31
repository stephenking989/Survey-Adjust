import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDat } from '../engine/parser.js';
import { adjustNetwork3D, errorModel, geom, partialsAzimuth, partialsDistance, partialsZenith, RHO } from '../engine/network3d.js';
import { defaultSettings, LINEAR_UNITS } from '../engine/project.js';
import { AdjustmentError } from '../engine/level.js';
import { near } from './helpers.js';

const R = 6372000;
const DEG = Math.PI / 180;

const settings = (over = {}) => {
  const s = defaultSettings();
  s.unitsInfo = LINEAR_UNITS.meters;
  s.instrument = { ...s.instrument, distanceConstant: 0.0005, distancePpm: 2, direction: 3, zenith: 3, angle: 4, azimuth: 4, centeringInstrument: 0, centeringTarget: 0.0003, centeringVertical: 0.0003 };
  return { ...s, ...over };
};

// ---- Partial derivatives agree with finite differences ----------------------

test('analytic partials of azimuth, distance and zenith match finite differences', () => {
  const A = { n: 100, e: 200, z: 50 };
  const B = { n: 163.4, e: 171.9, z: 52.3 };
  const q = (0.5 - 0.142) / R;
  const hi = 1.5; const ht = 1.2;
  const fn = {
    az: (a, b) => geom(a, b, hi, ht).az,
    dist: (a, b) => geom(a, b, hi, ht).S,
    zen: (a, b) => { const g = geom(a, b, hi, ht); return g.z + q * g.Dh; },
  };
  const part = { az: partialsAzimuth(geom(A, B, hi, ht)), dist: partialsDistance(geom(A, B, hi, ht)), zen: partialsZenith(geom(A, B, hi, ht), q) };
  const h = 1e-6;
  for (const kind of ['az', 'dist', 'zen']) {
    ['n', 'e', 'z'].forEach((c, i) => {
      for (const [who, st, sign] of [['B', B, 1], ['A', A, 1]]) {
        const up = { ...st, [c]: st[c] + h }; const dn = { ...st, [c]: st[c] - h };
        const f = who === 'B' ? (fn[kind](A, up) - fn[kind](A, dn)) : (fn[kind](up, B) - fn[kind](dn, B));
        near(assert, part[kind][who][i], f / (2 * h) * sign, 1e-7, `${kind} d/d${who}.${c}`);
      }
    });
  }
});

// ---- Centering-error formulas of the STAR*NET manual (Appendix C.4) -------------

test('error model reproduces std errors printed in a real STAR*NET listing', () => {
  const ins = settings().instrument;
  // P36 -> P3: slope 65.7767 m, zenith 83-00-18.7 (listing: dir 3.15", zen 3.28", dist 0.0007 m)
  const S = 65.7767; const z = (83 + 18.7 / 3600) * DEG; const Dh = S * Math.sin(z);
  assert.equal(errorModel('dir', ins, { S, z, Dh }).toFixed(2), '3.15');
  assert.equal(errorModel('zen', ins, { S, z, Dh }).toFixed(2), '3.28');
  assert.equal(errorModel('dist', ins, { S, z, Dh }).toFixed(4), '0.0007');
  // P36 -> P37: 12.8477 m, zenith 94-09-23.6 (listing: dir 5.69", zen 7.44" (7.435 at the rounding edge), dist 0.0006 m)
  const S2 = 12.8477; const z2 = (94 + 9 / 60 + 23.6 / 3600) * DEG; const Dh2 = S2 * Math.sin(z2);
  assert.equal(errorModel('dir', ins, { S: S2, z: z2, Dh: Dh2 }).toFixed(2), '5.69');
  near(assert, errorModel('zen', ins, { S: S2, z: z2, Dh: Dh2 }), 7.44, 0.006);
  assert.equal(errorModel('dist', ins, { S: S2, z: z2, Dh: Dh2 }).toFixed(4), '0.0006');
});

test('distance std error is constant + ppm (additive) unless .EDM PROPAGATED', () => {
  const ins = { ...settings().instrument, centeringInstrument: 0, centeringTarget: 0, centeringVertical: 0, distanceConstant: 0.005, distancePpm: 3 };
  const g = { S: 2000, z: Math.PI / 2, Dh: 2000 };
  near(assert, errorModel('dist', ins, g), 0.005 + 0.006, 1e-12);                       // 0.011: simple sum
  near(assert, errorModel('dist', { ...ins, edmMethod: 'propagated' }, g), Math.hypot(0.005, 0.006), 1e-12);
});

test('angle centering matches the manual: instrument d3/(d1 d2) I and targets sqrt(d1^2+d2^2)/(d1 d2) T', () => {
  const ins = { ...settings().instrument, angle: 4, centeringInstrument: 0.002, centeringTarget: 0.003, centeringVertical: 0 };
  const d1 = 80; const d2 = 120; const theta = 70 * DEG;
  const d3 = Math.sqrt(d1 * d1 + d2 * d2 - 2 * d1 * d2 * Math.cos(theta));
  const inst = (d3 / (d1 * d2)) * 0.002; const tgt = (Math.hypot(d1, d2) / (d1 * d2)) * 0.003;
  const expect = Math.sqrt((4 / RHO) ** 2 + inst ** 2 + tgt ** 2) * RHO;
  near(assert, errorModel('ang', ins, { Dh1: d1, Dh2: d2, theta }), expect, 1e-9);
});

// ---- Adjustment machinery on a synthetic, noise-free network --------------------

/** Build DM lines from true coordinates using the same geometry the engine uses. */
function synthetic(truth, hi = 1.5, ht = 1.2, k = 0.07) {
  const q = (0.5 - k) / R;
  const dms = (deg) => { const t = Math.round(deg * 3600 * 1000) / 1000; const d = Math.floor(t / 3600); const m = Math.floor((t - d * 3600) / 60); return `${d}-${m}-${(t - d * 3600 - m * 60).toFixed(3)}`; };
  const line = (from, to) => {
    const g = geom(truth[from], truth[to], hi, ht);
    return { az: g.az, text: (dir) => `DM ${to} ${dms(((dir % TWO) + TWO) % TWO / DEG)} ${g.S.toFixed(5)} ${dms((g.z + q * g.Dh) / DEG)} ${hi}/${ht}` };
  };
  return line;
}
const TWO = 2 * Math.PI;

const TRUTH = {
  A: { n: 1000, e: 1000, z: 100 }, B: { n: 1080, e: 1090, z: 101.2 }, C: { n: 1150, e: 960, z: 99.4 }, D: { n: 1040, e: 1160, z: 100.3 },
};
function network(approxShift = 0.03) {
  const line = synthetic(TRUTH);
  const lines = ['.3D', '.REF 0.07', 'C A 1000 1000 100 ! ! !', 'C B 1080 1090 101.2 0.001 0.001 0.001'];
  for (const [name, t] of Object.entries(TRUTH)) {
    if (name === 'A' || name === 'B') continue;
    lines.push(`C ${name} ${t.n + approxShift} ${t.e - approxShift} ${t.z + approxShift} * * *`);
  }
  const omega = { A: 0.7, B: 2.1, C: 4.0, D: 5.5 };
  for (const at of ['A', 'B', 'C', 'D']) {
    for (let round = 0; round < 2; round++) {
      lines.push(`DB ${at}`);
      for (const to of ['A', 'B', 'C', 'D']) if (to !== at) { const l = line(at, to); lines.push(l.text(l.az - omega[at])); }
      lines.push('DE');
    }
  }
  return lines.join('\n');
}

test('noise-free network: approximate coordinates 4 cm off converge to the truth with zero residuals', () => {
  const r = adjustNetwork3D(parseDat(network()), settings());
  assert.ok(r.iterations <= 6, `iterations ${r.iterations}`);
  for (const s of r.stations) {
    near(assert, s.n, TRUTH[s.name].n, 2e-5, `${s.name} N`);   // observations are rounded to 1e-5 m / 0.001"
    near(assert, s.e, TRUTH[s.name].e, 2e-5, `${s.name} E`);
    near(assert, s.z, TRUTH[s.name].z, 2e-5, `${s.name} Z`);
  }
  assert.ok(Math.abs(r.stats.errorFactor) < 0.2, `error factor ${r.stats.errorFactor}`);
  // 4 stations: A fixed, B weighted -> 3*3 + ... unknowns: B,C,D coordinates (9) + 8 sets
  assert.equal(r.stats.nUnknowns, 9 + 8);
  assert.equal(r.sets.length, 8);
  assert.equal(r.stats.nObservations, 8 * 3 * 3 + 3);   // 72 dir + dist + zen, + 3 weighted components of B
  assert.equal(r.stats.dof, 75 - 17);
});

test('reported residual = computed(adjusted) - observed, and StdRes = residual / sigma', () => {
  const r = adjustNetwork3D(parseDat(network()), settings());
  for (const o of r.observations) {
    near(assert, o.adjusted - o.observed, o.residual, 1e-12);
    near(assert, o.stdRes, o.residual / o.sigma, 1e-9);
  }
  const total = r.observations.reduce((a, o) => a + o.stdRes ** 2, 0) + r.coordinateObservations.reduce((a, o) => a + o.stdRes ** 2, 0);
  near(assert, total, r.stats.sumSqStdRes, 1e-9);
  assert.deepEqual(r.stats.classes.map((c) => c.name), ['Coordinates', 'Directions', 'Distances', 'Zeniths']);
});

test('a gross error in one distance stands out in StdRes and is flagged', () => {
  const dat = network().replace(/(DM B \S+ )(\d+\.\d+)/, (m, a, d) => a + (Number(d) + 0.05).toFixed(5));
  const r = adjustNetwork3D(parseDat(dat), settings());
  const worst = r.observations.reduce((a, o) => (Math.abs(o.stdRes) > Math.abs(a.stdRes) ? o : a));
  assert.equal(worst.kind, 'dist');
  assert.ok(worst.flagged && Math.abs(worst.stdRes) > 10);
  assert.equal(r.stats.chiSquare.passed, false);
});

test('.CURVE OFF turns the curvature/refraction correction off for the observations after it', () => {
  // Data generated WITH the correction (k = 0.07). Fixed A and B pin the frame; D is weighted
  // at 1 mm, so a 190 m sight whose zenith is wrong by (1/2 - k) Dh / R (about 2.3") cannot be absorbed.
  const line = synthetic(TRUTH);
  const mk = (curve) => [
    '.3D', 'C A 1000 1000 100 ! ! !', 'C B 1080 1090 101.2 ! ! !', 'C D 1040 1160 100.3 0.001 0.001 0.001',
    curve ? '.CURVE ON' : '.CURVE OFF', '.REF 0.07',
    'DB A', line('A', 'B').text(0), line('A', 'D').text(line('A', 'D').az - line('A', 'B').az), 'DE',
    'DB B', line('B', 'A').text(0), line('B', 'D').text(line('B', 'D').az - line('B', 'A').az), 'DE',
  ].join('\n');
  const zen = (r) => r.stats.classes.find((c) => c.name === 'Zeniths').sumSq;
  const on = adjustNetwork3D(parseDat(mk(true)), settings());
  const off = adjustNetwork3D(parseDat(mk(false)), settings());
  assert.ok(zen(on) < 0.01, `with the correction on, zeniths fit: ${zen(on)}`);
  assert.ok(zen(off) > 0.5, `with it off, the uncorrected zeniths misfit: ${zen(off)}`);
  // Size of the correction on the longest sight, from the manual's formula: (1/2 - k) * Dh / R.
  const Dh = geom(TRUTH.A, TRUTH.D, 1.5, 1.2).Dh;
  assert.ok(Dh > 160 && Dh < 180);
  near(assert, ((0.5 - 0.07) * Dh / R) * RHO, 2.3, 0.1);     // about 2.3 arc-seconds at 170 m
});

test('an explicit std error is used as given; .ADDCENTERING inflates it', () => {
  const base = network().split('\n');
  const target = base.findIndex((l) => l.startsWith('DM C'));
  const make = (addc) => {
    const rows = base.map((l, i) => (i === target ? `${l} 2 0.002 5` : l));
    if (addc) rows.splice(target, 0, '.ADDC ON');           // takes effect from the next line
    return rows.join('\n');
  };
  const distSigma = (dat) => {
    const p = parseDat(dat);
    const line = p.records.find((r) => r.type === 'DM' && r.stdErr.distance === 0.002).line;
    return adjustNetwork3D(p, settings()).observations.find((o) => o.line === line && o.kind === 'dist').sigma;
  };
  near(assert, distSigma(make(false)), 0.002, 1e-12);        // used exactly as entered
  const inflated = distSigma(make(true));
  assert.ok(inflated > 0.002, `ADDC should add centering: ${inflated}`);
  // distance: sqrt(0.002^2 + (d/s)^2 (I^2 + T^2) + 2 (e/s)^2 V^2) with I = 0, T = V = 0.0003 and a near-horizontal sight
  assert.ok(inflated < Math.sqrt(0.002 ** 2 + 3 * 0.0003 ** 2) + 1e-9);
});

test('a station without coordinates is reported by name and line', () => {
  const dat = 'C A 1000 1000 100 ! ! !\n.3D\nDB A\nDM Q 000-00-00 50 090-00-00\nDE\n';
  assert.throws(() => adjustNetwork3D(parseDat('.3D\n' + dat), settings()), (e) => e instanceof AdjustmentError && /approximate coordinates for Q/.test(e.message));
});

test('a network with nothing fixed or weighted cannot be solved', () => {
  const dat = network().replace('C A 1000 1000 100 ! ! !', 'C A 1000 1000 100 * * *').replace('C B 1080 1090 101.2 0.001 0.001 0.001', 'C B 1080 1090 101.2 * * *');
  assert.throws(() => adjustNetwork3D(parseDat(dat), settings()), AdjustmentError);
});
