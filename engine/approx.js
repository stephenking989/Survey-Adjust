// Approximate station coordinates for stations that have no C record.
//
// The adjustment is non-linear, so it needs starting values. STAR*NET works them
// out itself; a data file then only needs its control entered. We do the same by
// "walking" through the observations from the stations that are known:
//
//   * A direction set (DB ... DE) at a known station A gets its circle orientation
//     omega from any of its pointings whose target already has coordinates
//     (omega = az(A->T) - direction), or from a B (azimuth) record between A and a
//     target in the set.
//   * With omega known, every other pointing that also has a slope distance and zenith
//     fixes its target:  az = direction + omega,  Dh = S sin z,
//         N_T = N_A + Dh cos az ,  E_T = E_A + Dh sin az ,  Z_T = Z_A + HI - HT + S cos z.
//   * An M record (angle + distance [+ zenith]) fixes its target the same way from
//     the azimuth to its "from" station.
//
// Repeat until nothing new is found. Curvature and refraction are ignored here
// (millimetres at most); the adjustment itself applies them.

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;
const norm = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

function azimuth(A, B) { return Math.atan2(B.e - A.e, B.n - A.n); }

/**
 * @param {object} parsed    result of parseDat()
 * @param {Map} stations     name -> station, already holding the C-record stations
 * @param {Function} make    (name, n, e, z) -> station object to store
 * @returns {string[]} names of the stations that were added
 */
export function approximateStations(parsed, stations, make, opts = {}) {
  // Everything the observations refer to.
  const referenced = new Set();
  const sets = new Map();
  const azimuths = [];
  const angles = [];
  const sloped = [];                 // D / DV / V style: from, to, distance, zenith
  for (const r of parsed.records) {
    if (r.type === 'DM' || r.type === 'DN') {
      if (!sets.has(r.set)) sets.set(r.set, { at: r.at, dirs: [] });
      sets.get(r.set).dirs.push(r);
      referenced.add(r.at); referenced.add(r.to);
    } else if (r.type === 'B') { azimuths.push(r); referenced.add(r.from); referenced.add(r.to); }
    else if (r.type === 'A' || r.type === 'M') { angles.push(r); referenced.add(r.at); referenced.add(r.from); referenced.add(r.to); }
    else if (r.type === 'D' || r.type === 'DV' || r.type === 'V') { sloped.push(r); referenced.add(r.from); referenced.add(r.to); }
  }
  const missing = () => [...referenced].filter((n) => !stations.has(n));
  if (missing().length === 0) return [];

  const added = [];
  const place = (name, n, e, z) => { stations.set(name, make(name, n, e, z)); added.push(name); };
  const known = (name) => stations.get(name);

  // Reduce a pointing from A (heights hi/ht) to a position for T.
  const locate = (A, r, az) => {
    if (!(r.distance > 0)) return null;
    // A 2D job has no zenith angles: its distances are horizontal.
    if (r.zenith === undefined || r.zenith === null) {
      return opts.twoD ? { n: A.n + r.distance * Math.cos(az), e: A.e + r.distance * Math.sin(az), z: A.z } : null;
    }
    const z = r.zenith * DEG;
    const Dh = r.distance * Math.sin(z);
    return { n: A.n + Dh * Math.cos(az), e: A.e + Dh * Math.sin(az), z: A.z + (r.hi || 0) - (r.ht || 0) + r.distance * Math.cos(z) };
  };

  for (let pass = 0; pass < 200 && missing().length; pass++) {
    const before = added.length;

    for (const set of sets.values()) {
      const A = known(set.at);
      if (!A) continue;
      // Orientation: from known targets, else from an azimuth record.
      let sx = 0; let sy = 0; let cnt = 0;
      for (const d of set.dirs) {
        const T = known(d.to);
        if (T && T !== A) { const w = norm(azimuth(A, T) - d.direction * DEG); sx += Math.cos(w); sy += Math.sin(w); cnt++; }
      }
      if (!cnt) {
        for (const d of set.dirs) {
          for (const b of azimuths) {
            let az = null;
            if (b.from === set.at && b.to === d.to) az = b.azimuth * DEG;
            else if (b.to === set.at && b.from === d.to) az = b.azimuth * DEG + Math.PI;
            if (az !== null) { const w = norm(az - d.direction * DEG); sx += Math.cos(w); sy += Math.sin(w); cnt++; }
          }
        }
      }
      if (!cnt) continue;
      const omega = Math.atan2(sy, sx);
      for (const d of set.dirs) {
        if (known(d.to) || d.type !== 'DM') continue;
        const p = locate(A, d, d.direction * DEG + omega);
        if (p) place(d.to, p.n, p.e, p.z);
      }
    }

    for (const a of angles) {
      if (a.type !== 'M' || known(a.to)) continue;
      const A = known(a.at); const F = known(a.from);
      if (!A || !F) continue;
      const p = locate(A, a, azimuth(A, F) + a.angle * DEG);
      if (p) place(a.to, p.n, p.e, p.z);
    }
    if (added.length === before) break;
  }
  void sloped;

  const still = missing();
  if (still.length) {
    const shown = still.slice(0, 6).join(', ') + (still.length > 6 ? ', ...' : '');
    const err = new Error(`Cannot work out approximate coordinates for ${shown}. Add a C record (free is fine: C name N E Z * * *) or an observation chain from a known station.`);
    err.stations = still;
    throw err;
  }
  return added;
}
