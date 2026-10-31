// Error ellipses against the STAR*NET listings of the two real 3D jobs, plus the maths on small cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdjustment, settingsFromSnproj, defaultSettings } from '../engine/index.js';
import { ellipseTables, stationEllipse, relativeEllipse } from '../engine/ellipse.js';
import { near } from './helpers.js';
import { listingJob, publicJob, SKIP_NO_LISTING } from './jobs.js';

const lf = (s) => s.replace(/\r\n/g, '\n');
const runJob = (J) => runAdjustment([{ name: `${J.base}.dat`, text: lf(J.read('dat')) }], settingsFromSnproj(J.read('snproj')), {});

/** Rows of a listing section: station(s) then semi-major, semi-minor, azimuth D-MM, vertical. */
function listingRows(lst, title, nameCount) {
  const at = lst.indexOf(title);
  assert.ok(at >= 0, title);
  const rows = [];
  for (const line of lst.slice(at).split('\n').slice(1)) {
    const re = nameCount === 1
      ? /^(\S+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+)-(\d+)\s+(\d+\.\d+)\s*$/
      : /^(\S+)\s+(\S+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+)-(\d+)\s+(\d+\.\d+)\s*$/;
    const m = re.exec(line);
    if (m) {
      const k = nameCount;
      rows.push({ names: m.slice(1, 1 + k), major: +m[1 + k], minor: +m[2 + k], az: +m[3 + k] + +m[4 + k] / 60, vert: +m[5 + k] });
    } else if (rows.length && /Elapsed/.test(line)) break;
  }
  return rows;
}

const diffAz = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };

for (const [key, confText] of [['control', '95%'], ['pier', '68.27%']]) {
  const J = listingJob(key);
  test(`3D job ${key}: station and relative error ellipses match the STAR*NET listing (${confText})`, { skip: J ? false : SKIP_NO_LISTING }, () => {
    const out = runJob(J);
    const lst = lf(J.read('lst'));
    assert.ok(lst.includes(`Confidence Region = ${confText}`));
    const t = ellipseTables(out);
    const stRows = listingRows(lst, 'Station Coordinate Error Ellipses', 1);
    const relRows = listingRows(lst, 'Relative Error Ellipses (', 2);
    assert.equal(t.stations.length, stRows.length);
    assert.equal(t.relative.length, relRows.length);
    let worst = { major: 0, az: 0, vert: 0 };
    const compare = (mine, row) => {
      // The ellipse of a circle (or a fixed point) has no meaningful azimuth.
      worst.major = Math.max(worst.major, Math.abs(mine.semiMajor - row.major), Math.abs(mine.semiMinor - row.minor));
      worst.vert = Math.max(worst.vert, Math.abs(mine.vertical - row.vert));
      if (row.major > 1e-5 && row.major - row.minor > 1e-5) worst.az = Math.max(worst.az, diffAz(mine.azimuth, row.az));
    };
    for (const row of stRows) compare(t.stations.find((s) => s.name === row.names[0]), row);
    for (const row of relRows) compare(t.relative.find((r) => r.from === row.names[0] && r.to === row.names[1]), row);
    console.log(`${key}: largest differences  axes ${worst.major.toExponential(2)} m, vertical ${worst.vert.toExponential(2)} m, azimuth ${worst.az.toFixed(3)} deg`);
    // The listing prints 6 decimals, so half a unit in the last place (5e-7) is rounding, not a difference.
    near(assert, worst.major, 0, 1e-6, 'semi-axes');
    near(assert, worst.vert, 0, 1e-6, 'vertical');
    near(assert, worst.az, 0, 0.02, 'azimuth');
  });
}

test('ellipse maths: a known covariance gives the known axes, azimuth and confidence scaling', () => {
  // N and E uncorrelated, sigma_N = 3 mm, sigma_E = 1 mm, sigma_Z = 2 mm, two stations, no scaling.
  const Q = { get: (i, j) => ({ 0: 9e-6, 1: 1e-6, 2: 4e-6, 3: 4e-6, 4: 1e-6, 5: 9e-6 }[i] * (i === j ? 1 : 0)) };
  const result = { settings: { confidencePercent: 95 }, covariance: { Q, scale: 1, index: new Map([['A', [0, 1, 2]], ['B', [3, 4, 5]]]) } };
  const a = stationEllipse(result, 'A');
  near(assert, a.semiMajor, 2.4477 * 3e-3, 1e-6, 'major');
  near(assert, a.semiMinor, 2.4477 * 1e-3, 1e-6, 'minor');
  near(assert, a.azimuth, 0, 1e-9, 'major axis points north');
  near(assert, a.vertical, 1.95996 * 2e-3, 1e-6, 'vertical');
  // The relative ellipse of two uncorrelated stations adds the variances: sigma_N = sqrt(9+4) mm.
  const r = relativeEllipse(result, 'A', 'B');
  near(assert, r.semiMajor, 2.4477 * Math.sqrt(13e-6), 1e-6);
  // 68.27% in one dimension is one sigma; in two dimensions it is 1.5152 sigma.
  const one = stationEllipse(result, 'A', 68.27);
  near(assert, one.vertical, 2e-3, 2e-6);
  near(assert, one.semiMajor, 1.5152 * 3e-3, 2e-6);
  // Correlated N and E at 45 degrees: major axis azimuth 45.
  const Qc = { get: (i, j) => [[4e-6, 3e-6], [3e-6, 4e-6]][i % 3 < 2 ? i % 3 : 0][j % 3 < 2 ? j % 3 : 0] };
  const rc = { settings: { confidencePercent: 95 }, covariance: { Q: Qc, scale: 1, index: new Map([['A', [0, 1, 2]]]) } };
  near(assert, stationEllipse(rc, 'A').azimuth, 45, 1e-6);
});

test('.ELLIPSE limits the stations listed; .REL pairs, /OBS and /CON choose the relative ellipses', () => {
  const P = publicJob('control');
  const dat = lf(P.read('dat'));
  const settings = settingsFromSnproj(P.read('snproj'));
  const withExtra = (extra) => ellipseTables(runAdjustment([{ name: 'a.dat', text: dat + '\n' + extra + '\n' }], settings, {}));
  const base = ellipseTables(runAdjustment([{ name: 'a.dat', text: dat }], settings, {}));
  assert.equal(base.stations.length, 9);
  const names = base.stations.map((s) => s.name);
  const nm = (i) => names[i];
  assert.deepEqual(withExtra(`.ELL ${nm(3)} ${nm(5)}`).stations.map((s) => s.name), [nm(3), nm(5)]);
  const grp = withExtra(`.REL /CON ${nm(3)} ${nm(4)} ${nm(5)}`);
  assert.ok(grp.relative.some((r) => r.from === nm(4) && r.to === nm(5)));
  const obs = withExtra('.REL /OBS');
  assert.ok(obs.relative.length >= base.relative.length);
});
