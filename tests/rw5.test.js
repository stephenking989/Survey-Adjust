// Carlson RW5 raw files: the record layout from Carlson's specification, the shot types, and the conversion of a
// traverse to M/B/D records. All coordinates and readings below are invented; a traverse is generated from known
// points so the converted data can be adjusted and compared with the truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rw5ToDat, parseRw5Line, looksLikeRw5, Rw5Error, parseDat, runAdjustment, defaultSettings, checkData } from '../engine/index.js';
import { near } from './helpers.js';

const DEG = Math.PI / 180;
const az = (a, b) => ((Math.atan2(b.e - a.e, b.n - a.n) / DEG) + 360) % 360;
const dist = (a, b) => Math.hypot(b.n - a.n, b.e - a.e);
/** degrees -> DDD.MMSSss, the RW5 way of writing an angle */
const packed = (deg, dec = 2) => {
  let t = Math.round((((deg % 360) + 360) % 360) * 3600 * 10 ** dec) / 10 ** dec;
  const d = Math.floor(t / 3600); t -= d * 3600; const m = Math.floor(t / 60); const s = t - m * 60;
  const [si, sf = ''] = s.toFixed(dec).split('.');
  return `${d}.${String(m).padStart(2, '0')}${si.padStart(2, '0')}${sf}`;
};

test('record fields: two-character headers, "N " and "E " coordinates, notes', () => {
  const r = parseRw5Line('SP,PN100,N 5000.210,E 6000.286,EL,--CM', 1);
  assert.deepEqual([r.type, r.f.PN, r.f.N, r.f.E, r.f.EL, r.note], ['SP', '100', '5000.210', '6000.286', '', 'CM']);
  const t = parseRw5Line('TR,OP1,FP2,BRN0.0000E,VA0.0000,HD270.650,--ST', 2);
  assert.deepEqual([t.f.OP, t.f.FP, t.f.BR, t.f.VA, t.f.HD, t.note], ['1', '2', 'N0.0000E', '0.0000', '270.650', 'ST']);
  const k = parseRw5Line('BK,OP1,BP2,BS315.0000,BC0.0044', 3);
  assert.deepEqual([k.f.OP, k.f.BP, k.f.BS, k.f.BC], ['1', '2', '315.0000', '0.0044']);
  assert.equal(looksLikeRw5('MO,AD0,UN1,SF1.0\r\nSP,PN1,N 5000,E 5000,EL,--CM\r\n'), true);
  assert.equal(looksLikeRw5('E A 100 !\nL A-B 1 100\n'), false);
  assert.throws(() => parseRw5Line('!!!,x', 4), Rw5Error);
});

// A closed traverse around five invented points, observed from the first with angle-right shots and a bearing first leg.
const P = { A: { n: 5000, e: 5000 }, B: { n: 5270.65, e: 5000 }, C: { n: 5621.35, e: 5058.65 }, D: { n: 5505.1, e: 5458.4 }, E: { n: 4986.7, e: 5371.8 } };
function loopRw5({ closeName = 'F', abName = 'G', zenith = false } = {}) {
  const lines = ['JB,NMTEST,DT01-01-2026,TM10:00:00', 'MO,AD0,UN1,SF1.00000000,EC0,EO0.0,AU0', 'SP,PN1,N 5000.0000,E 5000.0000,EL,--CM'];
  const order = ['A', 'B', 'C', 'D', 'E', 'A'];
  const nm = { A: '1', B: '2', C: '3', D: '4', E: '5' };
  const shot = (kind, from, to, back, extra = '') => {
    const ar = ((az(P[from], P[to]) - az(P[from], P[back])) % 360 + 360) % 360;
    const d = dist(P[from], P[to]);
    const dpart = zenith ? `ZE${packed(88)},SD${(d / Math.sin(88 * DEG)).toFixed(3)}` : `VA0.0000,HD${d.toFixed(3)}`;
    return `${kind},OP${nm[from]},FP${extra || nm[to]},AR${packed(ar)},${dpart},--X`;
  };
  // first leg on a bearing: from A to B, azimuth 0
  lines.push(`TR,OP1,FP2,BRN0.0000E,VA0.0000,HD${dist(P.A, P.B).toFixed(3)},--ST`);
  lines.push(shot('TR', 'B', 'C', 'A'));
  lines.push(shot('TR', 'C', 'D', 'B'));
  lines.push(shot('SS', 'D', 'A', 'C', '40'));             // a sideshot from D while it is occupied (it points back at the start)
  lines.push(shot('TR', 'D', 'E', 'C'));
  lines.push(shot('CL', 'E', 'A', 'D', closeName));          // closing leg: new name for the start point
  lines.push(`AB,OP${closeName},FP${abName},AR${packed(((az(P.A, P.B) - az(P.A, P.E)) % 360 + 360) % 360)},VA0.0000,HD${dist(P.A, P.B).toFixed(3)},--CLOSE`);
  void order;
  return lines.join('\r\n') + '\r\n';
}

test('a traverse with a bearing first leg, a sideshot, a closing leg and a closing angle converts and adjusts', () => {
  const r = rw5ToDat(loopRw5(), {});
  assert.equal(r.summary.traverseShots, 5);
  assert.equal(r.summary.bearingLegs, 1);
  assert.equal(r.summary.sideshots, 2);                        // the SS and the AB
  // The closing leg and the closing angle are given the start point's name (they land on it).
  assert.ok(r.warnings.some((w) => /renamed 1/.test(w.message)));
  assert.ok(r.warnings.some((w) => /renamed 2/.test(w.message)));
  const p = parseDat(r.text);
  assert.equal(p.records.filter((x) => x.type === 'C').length, 1);
  const B = p.records.find((x) => x.type === 'B');
  assert.deepEqual([B.from, B.to], ['1', '2']);
  near(assert, B.azimuth, 0, 1e-9);
  const M = p.records.filter((x) => x.type === 'M');
  const close = M.find((x) => x.at === '5' && x.to === '1');
  assert.ok(close, 'the closing leg ends on point 1');
  const ang = M.find((x) => x.type === 'M' && x.at === '1' && x.from === '5' && x.to === '2');
  assert.ok(ang, 'the closing angle is at 1 from 5 to 2');
  const s = defaultSettings(); s.instrument = { ...s.instrument, distanceConstant: 0.01, direction: 5, angle: 5, azimuth: 5 };
  const out = runAdjustment([{ name: 't.dat', text: r.text }], s, {});
  assert.equal(out.kind, '2d');
  // Observations are exact, so the adjusted points are the true ones and the residuals vanish.
  for (const [name, key] of [['2', 'B'], ['3', 'C'], ['4', 'D'], ['5', 'E']]) {
    const st = out.result.stations.find((x) => x.name === name);
    near(assert, st.n, P[key].n, 2e-3, name); near(assert, st.e, P[key].e, 2e-3, name);
  }
  assert.ok(out.result.stats.sumSqStdRes < 0.05, `sum of squares ${out.result.stats.sumSqStdRes}`);
  assert.equal(checkData([{ name: 't.dat', text: r.text }], s).ok, true);
});

test('slope distances are reduced with the zenith, and angle-left, deflections and a south azimuth are converted', () => {
  const r = rw5ToDat(loopRw5({ zenith: true }), {});
  assert.ok(r.warnings.some((w) => /slope distance/.test(w.message) && /reduced to horizontal/.test(w.message)));
  const M = parseDat(r.text).records.filter((x) => x.type === 'M');
  near(assert, M.find((x) => x.at === '2').distance, dist(P.B, P.C), 1e-3);
  const text = ['MO,AD1,UN0,SF1.0', 'SP,PN1,N 1000.000,E 1000.000,EL,--CM', 'SP,PN2,N 1000.000,E 1100.000,EL,--CM',
    'BK,OP1,BP2,BS,BC0.0000', 'SS,OP1,FP10,AL90.0000,VA0.0000,HD50.000', 'SS,OP1,FP11,DR30.0000,VA0.0000,HD60.000', 'SS,OP1,FP12,DL30.0000,VA0.0000,HD70.000', 'SS,OP1,FP13,AZ10.0000,VA0.0000,HD80.000'].join('\n');
  const q = rw5ToDat(text, {});
  const p = parseDat(q.text);
  assert.match(q.text, /\.UNITS Feet/);
  const m = Object.fromEntries(p.records.filter((x) => x.type === 'M').map((x) => [x.to, x.angle]));
  near(assert, m['10'], 270, 1e-9);        // angle left 90 = angle right 270
  near(assert, m['11'], 210, 1e-9);        // deflection right 30 = angle right 180 + 30
  near(assert, m['12'], 150, 1e-9);        // deflection left 30 = angle right 180 - 30
  const B = p.records.find((x) => x.type === 'B');
  near(assert, B.azimuth, 190, 1e-9);      // south azimuth direction: 10 + 180
});

test('a link traverse that ends on a known point is renamed to it; an angle with no back point is skipped and reported', () => {
  const pts = { S: { n: 1000, e: 1000 }, BKP: { n: 1000, e: 900 }, T1: { n: 1000, e: 1200 }, T2: { n: 1150, e: 1300 }, END: { n: 1300, e: 1250 } };
  const ar = (at, bk, to) => packed(((az(pts[at], pts[to]) - az(pts[at], pts[bk])) % 360 + 360) % 360);
  const text = [
    'MO,AD0,UN1,SF1.0', ...Object.entries({ S: 'S', BKP: 'BKP', END: 'END' }).map(([k, n]) => `SP,PN${n},N ${pts[k].n.toFixed(3)},E ${pts[k].e.toFixed(3)},EL,--CM`),
    'BK,OPS,BPBKP,BS,BC0.0000',
    `TR,OPS,FPT1,AR${ar('S', 'BKP', 'T1')},VA0.0000,HD${dist(pts.S, pts.T1).toFixed(3)}`,
    `TR,OPT1,FPT2,AR${ar('T1', 'S', 'T2')},VA0.0000,HD${dist(pts.T1, pts.T2).toFixed(3)}`,
    `TR,OPT2,FPX9,AR${ar('T2', 'T1', 'END')},VA0.0000,HD${(dist(pts.T2, pts.END) + 0.02).toFixed(3)}`,
  ].join('\r\n');
  const r = rw5ToDat(text, {});
  assert.ok(r.warnings.some((w) => /renamed END/.test(w.message)));
  assert.match(r.text, /^M T2-T1-END /m);
  const noBack = rw5ToDat('MO,AD0,UN1,SF1.0\nSP,PN1,N 0,E 0,EL,--CM\nTR,OP1,FP2,AR90.0000,VA0.0000,HD10.000\nSS,OP1,FP3,BRN45.0000E,VA0.0000,HD10.000\n', {});
  assert.ok(noBack.warnings.some((w) => /no back point/.test(w.message)));
  assert.equal(noBack.summary.skipped, 1);
  assert.throws(() => rw5ToDat('JB,NMX,DT1,TM2\n', {}), Rw5Error);
});

test('a prefix goes in front of every point name', () => {
  const r = rw5ToDat(loopRw5(), { prefix: 'F2_' });
  assert.match(r.text, /^C F2_1 /m);
  assert.match(r.text, /^B F2_1-F2_2 /m);
});
