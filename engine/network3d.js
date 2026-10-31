// 3D total-station network adjustment (directions, slope distances, zenith
// angles, angles, azimuths, weighted/fixed control) - the same least-squares
// machinery as the levelling adjustment, but non-linear, so it iterates.
//
// UNKNOWNS
//   N, E, Z of every station component that is not fixed, plus one circle
//   orientation (omega) for every direction set (DB ... DE). A direction set is
//   one round of pointings; the instrument circle is not oriented to north, so
//   each set carries its own unknown zero direction. That is why a network of
//   25 stations and 24 sets has 25*3 + 24 = 99 unknowns.
//
// OBSERVATION EQUATIONS (local plane coordinates, N-E order)
//   For an instrument at A pointing to B, with  dN = N_B - N_A,  dE = E_B - E_A,
//   Dh = sqrt(dN^2 + dE^2)  and  dZ = (Z_B + HT) - (Z_A + HI):
//
//   direction   d = atan2(dE, dN) - omega_set
//   zenith      z = atan2(Dh, dc)                     }  with the curvature and refraction
//   slope dist  S = sqrt(Dh^2 + dc^2)                 }  corrected vertical component
//                   dc = dZ - C * Dh^2 ,   C = (1 - k) / (2 R)
//   angle       at A from F to T  = az(A->T) - az(A->F)
//   azimuth     az(A->B)
//
//   R is the earth radius, k the coefficient of refraction. The (1-k)/(2R) term
//   is the usual earth-curvature-and-refraction correction to trigonometric
//   heighting; 1 - k because refraction bends the sight line back toward the
//   earth's curvature.
//
// LINEARISATION  (Gauss-Newton)
//   Let l = observed - computed at the current coordinates. Then, as in the
//   levelling case,   A x - l = v ,   N = A^T P A ,   u = A^T P l ,   N x = u,
//   and the coordinates are updated, x repeated until the corrections vanish.
//   Residuals are reported as  v = computed(adjusted) - observed.
//
// WEIGHTS
//   Each observation gets sigma from the instrument settings (see errorModel):
//   constant + ppm for distances, an angular figure for angles, plus the effect
//   of centering errors, which shrink with distance for angles but not for
//   distances. P = diag(1 / sigma^2), sigma_0 = 1.
//   Weighted control is an observation of the coordinate itself; fixed control
//   is not an unknown at all.
//
// STATISTICS are identical to the 1D case: v^T P v, redundancy, error factor,
// chi-square test, and std devs from Qxx = N^-1 (scaled by the error factor).

import { Matrix, cholesky, choleskySolve, inverseSPD, SingularMatrixError } from './matrix.js';
import { chiSquareTest, normalQuantile, propagationScale } from './stats.js';
import { AdjustmentError } from './level.js';
import { approximateStations } from './approx.js';

export const RHO = 206264.80624709636;          // arc-seconds per radian
const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const wrapPi = (x) => x - TWO_PI * Math.round(x / TWO_PI);

// ---------------------------------------------------------------------------
// Standard-error model
// ---------------------------------------------------------------------------

/**
 * A-priori standard error of one observation.
 *   ins = settings.instrument; geometry = { S, z, Dh } in metres / radians.
 * The centering terms project the horizontal (instrument, target) and vertical
 * centering errors onto the quantity being measured.
 */
export function errorModel(kind, ins, g) {
  const ei2 = ins.centeringInstrument ** 2;
  const et2 = ins.centeringTarget ** 2;
  const ev2 = ins.centeringVertical ** 2;
  const sin2 = Math.sin(g.z) ** 2;
  const cos2 = Math.cos(g.z) ** 2;
  switch (kind) {
    case 'dir':   // pointing error + horizontal centering across the line of sight
      return Math.sqrt(ins.direction ** 2 + (RHO ** 2) * (ei2 + et2) / (g.Dh ** 2));
    case 'zen': { // vertical centering of both ends, horizontal centering along the line
      const v = 2 * ev2 * sin2 + (ei2 + et2) * cos2;
      return Math.sqrt(ins.zenith ** 2 + (RHO / g.S) ** 2 * v);
    }
    case 'dist': {
      // STAR*NET's default (.EDM ADDITIVE) adds the constant and ppm parts
      // linearly: c + ppm * S. (.EDM PROPAGATED would use sqrt(c^2 + (ppm S)^2).)
      // Found by checking the printed StdErr of every distance in a real
      // listing: a root-sum-of-squares model gets the far shots wrong.
      const ppmPart = ins.distancePpm * 1e-6 * g.S;
      const lin = ins.edmMethod === 'propagated' ? Math.hypot(ins.distanceConstant, ppmPart) : ins.distanceConstant + ppmPart;
      return Math.sqrt(lin ** 2 + (ei2 + et2) * sin2 + 2 * ev2 * cos2);
    }
    case 'ang':   // difference of two directions
      return Math.sqrt(ins.angle ** 2 + (RHO ** 2) * (et2 / g.Dh1 ** 2 + et2 / g.Dh2 ** 2
        + ei2 * (1 / g.Dh1 ** 2 + 1 / g.Dh2 ** 2 - 2 * Math.cos(g.theta) / (g.Dh1 * g.Dh2))));
    case 'az':
      return Math.sqrt(ins.azimuth ** 2 + (RHO ** 2) * (ei2 + et2) / (g.Dh ** 2));
    default: throw new Error(`errorModel: unknown kind ${kind}`);
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Plan and height geometry from station A (instrument) to B (target). */
export function geom(A, B, hi, ht) {
  const dN = B.n - A.n;
  const dE = B.e - A.e;
  const Dh = Math.hypot(dN, dE);
  const dZ = (B.z + ht) - (A.z + hi);
  const S = Math.hypot(Dh, dZ);
  return { dN, dE, Dh, dZ, S, z: Math.atan2(Dh, dZ), az: Math.atan2(dE, dN) };
}

/**
 * Parameters of a computed quantity w.r.t. coordinates, as sparse entries
 * [stationKey, component, coefficient]; component 0 = N, 1 = E, 2 = Z.
 */
export function partialsAzimuth(g) {
  // d(az)/dN_B = -dE/Dh^2 ,  d(az)/dE_B = dN/Dh^2 ; A has the opposite sign.
  const a = -g.dE / (g.Dh * g.Dh); const b = g.dN / (g.Dh * g.Dh);
  return { B: [a, b, 0], A: [-a, -b, 0] };
}

export function partialsDistance(g) {
  // S = hypot(Dh, dZ)
  const uN = g.dN / g.Dh; const uE = g.dE / g.Dh;      // d(Dh)/dN_B, d(Dh)/dE_B
  const dSdDh = g.Dh / g.S;
  const B = [dSdDh * uN, dSdDh * uE, g.dZ / g.S];
  return { B, A: B.map((v) => -v) };
}

export function partialsZenith(g, q) {
  // z = atan2(Dh, dZ) + q Dh   ->   dz/dDh = dZ/S^2 + q ,  dz/dZ = -Dh/S^2
  const dzdDh = g.dZ / (g.S * g.S) + q;
  const uN = g.dN / g.Dh; const uE = g.dE / g.Dh;
  const B = [dzdDh * uN, dzdDh * uE, -g.Dh / (g.S * g.S)];
  return { B, A: B.map((v) => -v) };
}

// ---------------------------------------------------------------------------
// The adjustment
// ---------------------------------------------------------------------------

const COMP = ['n', 'e', 'z'];
const COMP_NAME = ['N', 'E', 'Elev'];

/** Number of direction observations in each set. */
function setList0(obs) {
  const n = new Map();
  for (const o of obs) if (o.kind === 'dir') n.set(o.set.id, (n.get(o.set.id) || 0) + 1);
  return [...n.values()];
}

export function adjustNetwork3D(parsed, settings) {
  const warnings = parsed.warnings.map((w) => ({ ...w }));
  const ins = { ...settings.instrument, edmMethod: parsed.state.edm || settings.instrument.edmMethod };
  const R = settings.earthRadius;
  const kDefault = settings.refraction;

  // ---- 1. Stations from C records ---------------------------------------
  const stations = new Map();
  for (const r of parsed.records) {
    if (r.type !== 'C') continue;
    if (r.elevation === undefined) {
      throw new AdjustmentError(`Line ${r.line}: C record for ${r.name} has no elevation (add .3D to the data file)`);
    }
    if (stations.has(r.name)) warnings.push({ line: r.line, message: `Station ${r.name} entered again; the later value is used` });
    stations.set(r.name, {
      name: r.name, n: r.north, e: r.east, z: r.elevation,
      status: [r.status.north, r.status.east, r.status.elevation],
      stdErr: [r.stdErr.north, r.stdErr.east, r.stdErr.elevation],
      description: r.description, line: r.line, used: false,
      input: { n: r.north, e: r.east, z: r.elevation, sd: [r.stdErr.north, r.stdErr.east, r.stdErr.elevation] },
    });
  }
  // Stations with no C record get starting coordinates from the observations.
  try {
    const added = approximateStations(parsed, stations, (name, n, e, z) => ({
      name, n, e, z, status: ['free', 'free', 'free'], stdErr: [null, null, null], description: '', line: 0, used: false,
      input: { n, e, z, sd: [null, null, null] }, approximate: true,
    }));
    for (const name of added) warnings.push({ line: null, note: true, message: `Station ${name} has no C record; starting coordinates were computed from the observations` });
  } catch (err) {
    throw new AdjustmentError(err.message);
  }
  const sta = (name, line) => {
    const s = stations.get(name);
    if (!s) throw new AdjustmentError(`Line ${line}: station ${name} has no coordinates (add a C record, free is fine: C ${name} N E Z * * *)`);
    s.used = true;
    return s;
  };

  // ---- 2. Observations ---------------------------------------------------
  const obs = [];
  const sets = new Map();           // set id -> { id, at, omega, params }
  const addSet = (r) => { if (!sets.has(r.set)) sets.set(r.set, { id: r.set, at: r.at, omega: 0, count: 0 }); return sets.get(r.set); };
  const isFixed = (e) => e === 'fixed';
  const sigmaOrFixed = (given, model, fixedValue) => (isFixed(given) ? fixedValue : (given !== null && given !== undefined ? given : model));
  const fixedAng = settings.fixedAngularStdErr;       // arc-seconds
  const fixedLin = settings.fixedStdErr;              // metres

  const pushDist = (r, from, to, distance, errGiven) => {
    const A = sta(from, r.line); const B = sta(to, r.line);
    obs.push({ kind: 'dist', rec: r, A, B, hi: r.hi || 0, ht: r.ht || 0, value: distance, errGiven, line: r.line, file: r.file });
  };
  const pushZen = (r, from, to, zenithDeg, errGiven) => {
    const A = sta(from, r.line); const B = sta(to, r.line);
    obs.push({ kind: 'zen', rec: r, A, B, hi: r.hi || 0, ht: r.ht || 0, value: zenithDeg * DEG, errGiven, line: r.line, file: r.file });
  };

  for (const r of parsed.records) {
    switch (r.type) {
      case 'DM': case 'DN': {
        const set = addSet(r); set.count++;
        const A = sta(r.at, r.line); const B = sta(r.to, r.line);
        obs.push({ kind: 'dir', rec: r, A, B, set, hi: r.hi || 0, ht: r.ht || 0, value: r.direction * DEG, errGiven: r.stdErr.direction, line: r.line, file: r.file });
        if (r.type === 'DM') {
          pushDist(r, r.at, r.to, r.distance, r.stdErr.distance);
          pushZen(r, r.at, r.to, r.zenith, r.stdErr.zenith);
        }
        break;
      }
      case 'DV': pushDist(r, r.from, r.to, r.distance, r.stdErr.distance); pushZen(r, r.from, r.to, r.zenith, r.stdErr.zenith); break;
      case 'D': pushDist(r, r.from, r.to, r.distance, r.stdErr.distance); break;
      case 'V': pushZen(r, r.from, r.to, r.zenith, r.stdErr.zenith); break;
      case 'A': case 'M': {
        const At = sta(r.at, r.line); const F = sta(r.from, r.line); const T = sta(r.to, r.line);
        obs.push({ kind: 'ang', rec: r, A: At, F, B: T, value: r.angle * DEG, errGiven: r.stdErr.angle, line: r.line, file: r.file });
        if (r.type === 'M') {
          pushDist(r, r.at, r.to, r.distance, r.stdErr.distance);
          if (r.zenith !== null) pushZen(r, r.at, r.to, r.zenith, r.stdErr.zenith);
        }
        break;
      }
      case 'B': {
        const A = sta(r.from, r.line); const B = sta(r.to, r.line);
        obs.push({ kind: 'az', rec: r, A, B, value: r.azimuth * DEG, errGiven: r.stdErr.azimuth, line: r.line, file: r.file });
        break;
      }
      case 'unsupported': break;
      default: break;
    }
  }
  if (obs.length === 0) throw new AdjustmentError('The data file has no 2D/3D observations');

  // Inline options (.REF, .CURVE, .EDM, .ADDC) can change part-way through a file, so
  // every observation uses the setting that was in force on its own line.
  //
  // Curvature and refraction (STAR*NET manual, Appendix C.2, after Bomford): the
  // refraction correction to a zenith angle is  k * psi  where psi = Dh / R is the
  // central angle subtended by the line and k the coefficient of refraction (0.07 is
  // the textbook average). Curvature tilts the chord by psi / 2, so the net correction
  // added to the computed zenith is (1/2 - k) * Dh / R  =  q * Dh.  Slope distances
  // are not corrected: they are the chord.
  for (const o of obs) {
    const inl = o.rec.inline || {};
    const kk = Number.isFinite(inl.refraction) ? inl.refraction : kDefault;
    o.q = inl.curve === false ? 0 : (0.5 - kk) / R;
    o.refractionUsed = inl.curve === false ? 0 : kk;
    o.edm = inl.edm || ins.edmMethod;
    o.addCentering = Boolean(inl.addCentering);
  }

  // Instrument centering error makes the directions of one set statistically dependent
  // (they all share the same instrument offset). STAR*NET accounts for this; we do not
  // yet, so say so rather than silently differ slightly.
  if (ins.centeringInstrument > 0 && setList0(obs).some((n) => n >= 2)) {
    warnings.push({ line: null, message: 'Instrument centering error is set: the correlation it causes between directions of the same set is not modelled yet, so results differ slightly from STAR*NET' });
  }

  // ---- 3. Parameters -------------------------------------------------------
  // param index per station component, -1 when the component is fixed.
  const used = [...stations.values()].filter((s) => s.used || s.status.some((x) => x !== 'free'));
  let nParam = 0;
  const pidx = new Map();
  const paramLabel = [];
  for (const s of used) {
    pidx.set(s, COMP.map((c, i) => {
      if (s.status[i] === 'fixed') return -1;
      paramLabel.push(`${s.name} ${COMP_NAME[i]}`);
      return nParam++;
    }));
  }
  const setList = [...sets.values()];
  for (const st of setList) { st.param = nParam++; paramLabel.push(`orientation of set ${st.id} at ${st.at}`); }

  // Coordinate observations: weighted components.
  const coordObs = [];
  for (const s of used) {
    s.status.forEach((st, i) => {
      if (st === 'weighted') coordObs.push({ kind: 'coord', station: s, comp: i, value: [s.n, s.e, s.z][i], sigma: s.stdErr[i], param: pidx.get(s)[i], line: s.line });
    });
  }

  // ---- 4. Sigmas -------------------------------------------------------------
  // The a-priori std error depends on the geometry (distance, zenith), so it is
  // evaluated at the current computed coordinates and refreshed every iteration.
  // (Evaluating it at the observed values instead changes the answer slightly.)
  function updateSigmas() {
    for (const o of obs) {
      const g = geom(o.A, o.B, o.hi, o.ht);
      const given = typeof o.errGiven === 'number';
      // Explicit std errors are used exactly as given (and the distance ppm does not touch
      // them) unless .ADDCENTERING is on, in which case centering is added to them.
      const insO = { ...ins, edmMethod: o.edm };
      if (given && o.addCentering) {
        if (o.kind === 'dist') { insO.distanceConstant = o.errGiven; insO.distancePpm = 0; }
        else if (o.kind === 'dir') insO.direction = o.errGiven;
        else if (o.kind === 'zen') insO.zenith = o.errGiven;
        else if (o.kind === 'ang') insO.angle = o.errGiven;
        else if (o.kind === 'az') insO.azimuth = o.errGiven;
      }
      let model;
      if (o.kind === 'ang') {
        const gf = geom(o.A, o.F, 0, 0);
        model = errorModel('ang', insO, { Dh1: gf.Dh, Dh2: g.Dh, theta: Math.abs(wrapPi(g.az - gf.az)) });
      } else {
        model = errorModel(o.kind, insO, { S: g.S, z: g.z, Dh: g.Dh });
      }
      o.sigmaModel = model;
      o.sigma = given && !o.addCentering ? o.errGiven : (isFixed(o.errGiven) ? (o.kind === 'dist' ? fixedLin : fixedAng) : model);
      if (o.kind !== 'dist') o.sigma /= RHO;      // arc-seconds -> radians
    }
  }
  updateSigmas();
  for (const c of coordObs) c.sigma = isFixed(c.sigma) ? fixedLin : c.sigma;


  // ---- 5. Initial orientations ---------------------------------------------
  for (const st of setList) {
    let sx = 0; let sy = 0;
    for (const o of obs) {
      if (o.kind !== 'dir' || o.set !== st) continue;
      const g = geom(o.A, o.B, 0, 0);
      sx += Math.cos(g.az - o.value); sy += Math.sin(g.az - o.value);
    }
    st.omega = Math.atan2(sy, sx);
  }

  // ---- 6. Gauss-Newton iterations ---------------------------------------------
  const get = (s, i) => s[COMP[i]];
  const apply = (vec, sign) => {   // vec of corrections over params
    for (const s of used) { const p = pidx.get(s); for (let i = 0; i < 3; i++) if (p[i] >= 0) s[COMP[i]] += sign * vec[p[i]]; }
    for (const st of setList) st.omega += sign * vec[st.param];
  };

  /** Computed value of an observation at the current coordinates, plus its partials. */
  function evaluate(o) {
    if (o.kind === 'dir') {
      const g = geom(o.A, o.B, 0, 0);
      const p = partialsAzimuth(g);
      return { comp: wrapPi(g.az - o.set.omega), rows: [[o.A, p.A], [o.B, p.B]], omegaCoef: -1, wrap: true };
    }
    if (o.kind === 'az') {
      const g = geom(o.A, o.B, 0, 0);
      const p = partialsAzimuth(g);
      return { comp: g.az < 0 ? g.az + TWO_PI : g.az, rows: [[o.A, p.A], [o.B, p.B]], wrap: true };
    }
    if (o.kind === 'ang') {
      const gt = geom(o.A, o.B, 0, 0); const gf = geom(o.A, o.F, 0, 0);
      const pt = partialsAzimuth(gt); const pf = partialsAzimuth(gf);
      // angle = az(A->T) - az(A->F)
      const rows = [[o.B, pt.B], [o.F, pf.B.map((v) => -v)], [o.A, pt.A.map((v, i) => v - pf.A[i])]];
      return { comp: ((gt.az - gf.az) % TWO_PI + TWO_PI) % TWO_PI, rows, wrap: true };
    }
    const g = geom(o.A, o.B, o.hi, o.ht);
    if (o.kind === 'dist') { const p = partialsDistance(g); return { comp: g.S, rows: [[o.A, p.A], [o.B, p.B]], wrap: false }; }
    const p = partialsZenith(g, o.q);
    return { comp: g.z + o.q * g.Dh, rows: [[o.A, p.A], [o.B, p.B]], wrap: false };
  }

  let N = null; let Lfac = null; let iterations = 0;
  const maxIter = settings.maxIterations || 50;
  for (let it = 0; it < maxIter; it++) {
    if (it > 0) updateSigmas();
    N = Matrix.zeros(nParam, nParam);
    const u = new Float64Array(nParam);
    const addRow = (cols, coefs, l, w) => {
      for (let a = 0; a < cols.length; a++) {
        u[cols[a]] += w * coefs[a] * l;
        for (let b = 0; b < cols.length; b++) N.add(cols[a], cols[b], w * coefs[a] * coefs[b]);
      }
    };
    for (const o of obs) {
      const ev = evaluate(o);
      let l = o.value - ev.comp;
      if (ev.wrap) l = wrapPi(l);
      const cols = []; const coefs = [];
      for (const [s, part] of ev.rows) {
        const p = pidx.get(s);
        for (let i = 0; i < 3; i++) if (p[i] >= 0 && part[i] !== 0) { cols.push(p[i]); coefs.push(part[i]); }
      }
      if (o.kind === 'dir') { cols.push(o.set.param); coefs.push(-1); }
      addRow(cols, coefs, l, 1 / (o.sigma * o.sigma));
    }
    for (const c of coordObs) {
      addRow([c.param], [1], c.value - get(c.station, c.comp), 1 / (c.sigma * c.sigma));
    }
    // A parameter nothing constrains shows up as a zero on the diagonal.
    for (let j = 0; j < nParam; j++) {
      if (!(N.get(j, j) > 0)) throw new AdjustmentError(`Nothing constrains ${paramLabel[j]}; check its observations and control`);
    }
    let x;
    try { Lfac = cholesky(N); x = choleskySolve(Lfac, u); } catch (err) {
      if (err instanceof SingularMatrixError) {
        throw new AdjustmentError('The network cannot be solved: it is not tied down by enough fixed or weighted control', { cause: err.message });
      }
      throw err;
    }
    apply(x, +1);
    iterations = it + 1;
    let maxCorr = 0;
    for (let j = 0; j < nParam; j++) maxCorr = Math.max(maxCorr, Math.abs(x[j]));
    if (maxCorr < 1e-8) break;     // 10 nanometres / 0.002 arc-seconds
    if (it === maxIter - 1 && !settings.maxIterations) throw new AdjustmentError('The adjustment did not converge in 50 iterations; check the data for gross errors');
  }
  const Qxx = inverseSPD(N, Lfac);

  // ---- 7. Residuals, statistics -----------------------------------------------
  const classOf = { dir: 'Directions', dist: 'Distances', zen: 'Zeniths', ang: 'Angles', az: 'Azimuths', coord: 'Coordinates' };
  const byClass = new Map();
  let T = 0;
  const resultObs = [];
  const account = (kind, stdRes) => {
    const c = byClass.get(classOf[kind]) || { name: classOf[kind], count: 0, sumSq: 0 };
    c.count++; c.sumSq += stdRes * stdRes; byClass.set(classOf[kind], c);
    T += stdRes * stdRes;
  };
  const flag = settings.stdResFlag;

  for (const o of obs) {
    const ev = evaluate(o);
    let v = ev.comp - o.value;                 // computed(adjusted) - observed
    if (ev.wrap) v = wrapPi(v);
    const stdRes = v / o.sigma;
    account(o.kind, stdRes);
    resultObs.push({
      kind: o.kind, from: o.A.name, to: o.B.name, via: o.F ? o.F.name : null, set: o.set ? o.set.id : null,
      observed: o.value, adjusted: o.value + v, residual: v, sigma: o.sigma, sigmaModel: o.sigmaModel, errGiven: o.errGiven,
      stdRes, flagged: Math.abs(stdRes) > flag, line: o.line, file: o.file, hi: o.hi, ht: o.ht,
      refraction: o.refractionUsed, slope: geom(o.A, o.B, o.hi, o.ht).S, horizontal: geom(o.A, o.B, o.hi, o.ht).Dh,
    });
  }
  const resultCoordObs = coordObs.map((c) => {
    const v = get(c.station, c.comp) - c.value;
    const stdRes = v / c.sigma;
    account('coord', stdRes);
    return { name: c.station.name, component: COMP_NAME[c.comp], observed: c.value, adjusted: get(c.station, c.comp), residual: v, sigma: c.sigma, stdRes, flagged: Math.abs(stdRes) > flag, line: c.line };
  });

  const nObs = obs.length + coordObs.length;
  const dof = nObs - nParam;
  const alpha = settings.chiSquarePercent / 100;
  const test = dof > 0 ? chiSquareTest(T, dof, alpha) : null;
  const errorFactor = dof > 0 ? Math.sqrt(T / dof) : 1;
  const scale = dof > 0 ? propagationScale(settings.errorScaling, test, errorFactor) : 1;
  const z = normalQuantile(0.5 + settings.confidencePercent / 200);

  const outStations = used.map((s) => {
    const p = pidx.get(s);
    const std = p.map((j, i) => (j >= 0 ? Math.sqrt(Qxx.get(j, j)) * scale : settings.fixedStdErr * scale));
    return { name: s.name, n: s.n, e: s.e, z: s.z, status: s.status.slice(), stdDev: std, description: s.description, input: s.input };
  });

  return {
    type: '3D',
    units: settings.unitsInfo,
    stations: outStations,
    sets: setList.map((st) => ({ id: st.id, at: st.at, orientation: ((st.omega / DEG) % 360 + 360) % 360, count: st.count })),
    observations: resultObs,
    coordinateObservations: resultCoordObs,
    iterations,
    stats: {
      nStations: used.length,
      nObservations: nObs,
      nUnknowns: nParam,
      dof,
      sumSqStdRes: T,
      errorFactor,
      errorFactorApplied: scale,
      confidenceZ: z,
      chiSquare: test,
      classes: ['Coordinates', 'Directions', 'Distances', 'Zeniths', 'Angles', 'Azimuths'].map((n) => byClass.get(n)).filter(Boolean),
      nFlagged: resultObs.filter((o) => o.flagged).length + resultCoordObs.filter((o) => o.flagged).length,
    },
    settings: { ...settings },
    warnings,
  };
}
