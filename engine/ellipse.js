// Error ellipses from the covariance matrix of the adjusted coordinates.
//
// For two coordinates N, E with covariance [[sNN, sNE], [sNE, sEE]] the standard error ellipse has
//   semi-axes  sqrt(lambda1), sqrt(lambda2)   (lambda = eigenvalues of that 2x2 matrix)
//   major-axis azimuth  theta = 1/2 * atan2(2 sNE, sNN - sEE)   (clockwise from north, taken mod 180)
// and is scaled to the chosen confidence by k = sqrt(chi-square quantile(p, 2 dof)), which for two
// dimensions is sqrt(-2 ln(1 - p)) (2.448 at 95%). A height has one dimension, so it is scaled by the
// normal quantile (1.960 at 95%). When the chi-square test failed the covariance is already scaled
// by the total error factor (result.covariance.scale), as STAR*NET does for ellipses (manual 8.15).
import { chiSquareQuantile, normalQuantile } from './stats.js';

/** Covariance of [N, E, Z] of one station (zeros for components held fixed). */
function block(cov, name) {
  const idx = cov.index.get(name);
  if (!idx) throw new RangeError(`unknown station ${name}`);
  return idx;
}

function q(cov, ja, jb) {
  return ja >= 0 && jb >= 0 ? cov.Q.get(ja, jb) * cov.scale * cov.scale : 0;
}

/** Ellipse from a 3x3 covariance given as a function (i, j) -> value, indices 0=N 1=E 2=Z. */
function ellipseOf(c, confidencePercent) {
  const p = confidencePercent / 100;
  const k2 = Math.sqrt(chiSquareQuantile(p, 2));
  const k1 = normalQuantile(0.5 + p / 2);
  const sNN = c(0, 0); const sEE = c(1, 1); const sNE = c(0, 1);
  const mean = (sNN + sEE) / 2;
  const diff = Math.sqrt(((sNN - sEE) / 2) ** 2 + sNE ** 2);
  const major = Math.sqrt(Math.max(0, mean + diff));
  const minor = Math.sqrt(Math.max(0, mean - diff));
  let az = (0.5 * Math.atan2(2 * sNE, sNN - sEE) * 180) / Math.PI;
  az = ((az % 180) + 180) % 180;
  return { semiMajor: k2 * major, semiMinor: k2 * minor, azimuth: az, vertical: k1 * Math.sqrt(Math.max(0, c(2, 2))) };
}

/** Station error ellipse: { semiMajor, semiMinor, azimuth (degrees), vertical } at the given confidence. */
export function stationEllipse(result, name, confidencePercent = result.settings.confidencePercent) {
  const j = block(result.covariance, name);
  return ellipseOf((a, b) => q(result.covariance, j[a], j[b]), confidencePercent);
}

/** Relative ellipse of B with respect to A (covariance of the coordinate differences). */
export function relativeEllipse(result, from, to, confidencePercent = result.settings.confidencePercent) {
  const ja = block(result.covariance, from);
  const jb = block(result.covariance, to);
  const c = (a, b) => q(result.covariance, ja[a], ja[b]) + q(result.covariance, jb[a], jb[b])
    - q(result.covariance, ja[a], jb[b]) - q(result.covariance, jb[a], ja[b]);
  return ellipseOf(c, confidencePercent);
}

// ---- Which ellipses to list (the .ELLIPSE and .RELATIVE inline options) -------------------------
//
// STAR*NET manual, ch. 5 (inline options): error ellipses are produced at all stations unless
// ".ELLIPSE name ..." lists some; relative ellipses are produced between every pair of stations
// connected by an observation unless ".RELATIVE a-b ..." lists pairs, in which case only those
// pairs are produced (plus the connected pairs when a ".REL /OBS" line is present). ".REL /CON a b c"
// adds every pair among the named stations ("/CON=Group" keeps separately named groups).

const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => names.compare(a, b);
const optionNamed = (o, full) => full.startsWith(o.name) && o.name.length >= 3;   // ".REL", ".ELL" and longer spellings

/** Station pairs joined by at least one observation, as [a, b] with a before b by name. */
export function connectedPairs(parsed) {
  const pairs = new Set();
  const add = (a, b) => { if (a && b && a !== b) pairs.add(a < b ? `${a}\t${b}` : `${b}\t${a}`); };
  for (const r of parsed.records) {
    if (r.type === 'DM' || r.type === 'DN' || r.type === 'DV') add(r.at, r.to);
    else if (r.type === 'D' || r.type === 'V' || r.type === 'B') add(r.from, r.to);
    else if (r.type === 'A') { add(r.at, r.from); add(r.at, r.to); }
    else if (r.type === 'M') { add(r.at, r.from); add(r.at, r.to); }
  }
  return [...pairs].map((k) => k.split('\t'));
}

/**
 * The tables the listing and the plot show: { confidence, stations, relative }.
 * `out` is the object runAdjustment returns for a 3D job.
 */
export function ellipseTables(out) {
  const { parsed, result } = out;
  const known = new Set(result.stations.map((s) => s.name));
  const conf = result.settings.confidencePercent;

  // Stations: all, unless .ELLIPSE names some.
  const wanted = [];
  for (const o of parsed.options) if (optionNamed(o, 'ELLIPSE')) wanted.push(...o.args.filter((a) => known.has(a)));
  const ellipseNames = (wanted.length ? [...new Set(wanted)] : result.stations.map((s) => s.name)).sort(byName);
  const stations = ellipseNames.map((name) => ({ name, ...stationEllipse(result, name, conf) }));

  // Relative pairs.
  const rel = parsed.options.filter((o) => optionNamed(o, 'RELATIVE'));
  const pairs = new Set();
  const key = (a, b) => (byName(a, b) <= 0 ? `${a}\t${b}` : `${b}\t${a}`);
  let useConnected = rel.length === 0;
  const groups = new Map();
  for (const o of rel) {
    const [first = '', ...rest] = o.args;
    if (/^\/OBS/i.test(first)) { useConnected = true; continue; }
    if (/^\/CON/i.test(first)) {
      const g = /^\/CON\w*=(.+)$/i.exec(first);
      const gname = g ? g[1] : '';
      groups.set(gname, [...(groups.get(gname) || []), ...rest.filter((n) => known.has(n))]);
      continue;
    }
    for (const a of o.args) {
      const m = /^(.+?)-(.+)$/.exec(a);                       // names with hyphens split at the first one
      if (m && known.has(m[1]) && known.has(m[2]) && m[1] !== m[2]) pairs.add(key(m[1], m[2]));
    }
  }
  for (const list of groups.values()) {
    const u = [...new Set(list)];
    for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) pairs.add(key(u[i], u[j]));
  }
  if (useConnected) for (const [a, b] of connectedPairs(parsed)) if (known.has(a) && known.has(b)) pairs.add(key(a, b));
  const relative = [...pairs]
    .map((k) => k.split('\t'))
    .sort((p, q) => byName(p[0], q[0]) || byName(p[1], q[1]))
    .map(([from, to]) => ({ from, to, ...relativeEllipse(result, from, to, conf) }));

  return { confidence: conf, stations, relative };
}
