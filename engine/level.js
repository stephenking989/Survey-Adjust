// 1D differential-levelling least-squares adjustment.
//
// THE MODEL
// ---------
// Unknowns: the elevation h_k of every station that is not fixed.
//
// Observation equation for a differential level from station i to station j
// (dElev = Elev(j) - Elev(i), measured over a line of length d):
//
//        h_j - h_i  =  dElev + v          v = residual
//
// Writing every unknown as an approximate value plus a correction,
// h = h0 + x, the equations become linear in x:
//
//        A x - l = v          (matrix form, one row per observation)
//
//        row of A:  +1 in column j, -1 in column i
//        l        = dElev - (h0_j - h0_i)        "observed minus computed"
//
// Fixed stations are known constants: they have no column in A, their
// elevation just moves into l. A weighted station contributes one more
// equation  h_k = value + v  with row +1 in column k (so it is both an
// unknown and an observation).
//
// WEIGHTS
// -------
// Each observation has an a-priori standard error sigma_i. For levelling with
// a per-distance figure c (e.g. 0.0002 m/km) the variance grows with line
// length:
//
//        sigma_i^2 = c^2 * d_i          (d in km)       <- STAR*NET "LENGTH" type
//
// The weight is w_i = 1 / sigma_i^2 and P = diag(w_i), taking the a-priori
// variance factor sigma_0^2 = 1. (An explicit std error on an L record
// replaces the formula for that observation.)
//
// NORMAL EQUATIONS
// ----------------
// Minimising  v^T P v  over x gives
//
//        N x = u      with   N = A^T P A ,   u = A^T P l
//
// N and u are accumulated row by row, N += w a^T a, u += w a l, which equals
// the matrix products but exploits that each row has at most two non-zeros.
// N is solved by Cholesky; its inverse Qxx = N^-1 is the cofactor matrix.
//
// STATISTICS
// ----------
//   residuals            v = A x - l              (adjusted minus observed)
//   standardised resid.  v_i / sigma_i            (STAR*NET's "StdRes")
//   sum of squares       T = v^T P v = sum (v_i / sigma_i)^2
//   degrees of freedom   r = n_obs - n_unknowns
//   a-posteriori var.    s0^2 = T / r             (should be ~1 if the weights are right)
//   total error factor   s0 = sqrt(T / r)
//   chi-square test      T ~ chi2(r)  =>  accept if  chi2(a/2) <= T <= chi2(1-a/2),
//                        reported as bounds on s0:  sqrt(chi2_bound / r)
//
// ERROR PROPAGATION - WHEN IS THE ERROR FACTOR APPLIED?
// -----------------------------------------------------
// The a-priori covariance of the unknowns is  Cx = sigma_0^2 Qxx  (sigma_0^2 = 1).
// If the weights are too optimistic the a-posteriori covariance is  s0^2 Qxx,
// i.e. every std dev is multiplied by the error factor s0.
//
// STAR*NET (manual, "Station Error Ellipses"): if the adjustment passes the
// chi-square test the adjusted std devs are used as they are; if it fails, they
// are increased by the total error factor. Both real listings agree:
//   - 1D levelling, error factor 6.336, test FAILED -> std devs scaled
//     (station N02: 0.0000352 m unscaled x 6.336 = 0.000223 m as listed);
//   - 3D pier job, error factor 0.968, test PASSED -> std devs NOT scaled
//     (max difference to the listing 5e-7 m unscaled, 6e-5 m if scaled).
// This is settings.errorScaling = 'auto' (the default); 'always' and 'never'
// are available too (see propagationScale in stats.js).
//
// A fixed station is eliminated exactly (no column) so it has no true variance;
// for reporting it gets  fixedStdErr * scale  (the 1e-7 m STAR*NET gives a fixed
// value, scaled the same way, which is why the failed 1D run lists 0.000001).

import { Matrix, cholesky, choleskySolve, inverseSPD, SingularMatrixError } from './matrix.js';
import { chiSquareTest, normalQuantile, propagationScale } from './stats.js';
import { LINEAR_UNITS, linearUnitsFromDat } from './project.js';

export class AdjustmentError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'AdjustmentError';
    this.details = details || null;
  }
}

/**
 * @param {object} parsed    result of parseDat()
 * @param {object} settings  see defaultSettings() in project.js
 */
export function adjustLevelling(parsed, settings) {
  const warnings = parsed.warnings.map((w) => ({ ...w }));
  const unitKey = linearUnitsFromDat(parsed.state.units) || settings.linearUnits;
  const unitInfo = LINEAR_UNITS[unitKey];
  if (!unitInfo) throw new AdjustmentError(`Unsupported units "${unitKey}"`);

  // ---- 1. Collect stations (order of first appearance, as in the .lst) -----
  const stations = new Map();
  const getStation = (name, rec) => {
    if (!stations.has(name)) {
      stations.set(name, { name, control: null, description: '', firstLine: rec.line, firstFile: rec.file, nObs: 0 });
    }
    return stations.get(name);
  };

  const levelRecs = [];
  for (const r of parsed.records) {
    if (r.type === 'E' || (r.type === 'C' && r.elevation !== undefined)) {
      const st = getStation(r.name, r);
      const ctl = r.type === 'E'
        ? { status: r.status, value: r.elevation, stdErr: r.stdErr }
        : { status: r.status.elevation, value: r.elevation, stdErr: r.stdErr.elevation };
      if (ctl.status === 'weighted' && !(ctl.stdErr > 0)) {
        throw new AdjustmentError(`Line ${r.line}: weighted station ${r.name} needs a std error > 0`, { file: r.file, line: r.line });
      }
      if (st.control) warnings.push({ file: r.file, line: r.line, message: `Station ${r.name} entered again; the later value is used` });
      st.control = ctl;
      if (r.description) st.description = r.description;
    } else if (r.type === 'L') {
      levelRecs.push(r);
      if (r.from === r.to) throw new AdjustmentError(`Line ${r.line}: level run from ${r.from} to itself`, { file: r.file, line: r.line });
      getStation(r.from, r);
      getStation(r.to, r);
    }
  }
  if (levelRecs.length === 0) throw new AdjustmentError('The data file has no L (differential level) observations');

  // ---- 2. Observations and their a-priori std errors ----------------------
  const obs = levelRecs.map((r) => {
    let sigma = r.stdErr;
    if (sigma === null) {
      const lv = r.levelOption;
      const mode = (lv ? lv.mode : settings.levelSectionType) || 'LENGTH';
      if (mode !== 'LENGTH') throw new AdjustmentError(`Line ${r.line}: level std error by ${mode} is not supported yet (only LENGTH)`, { file: r.file, line: r.line });
      const c = lv && Number.isFinite(lv.stdErr) ? lv.stdErr : settings.levelStdErr;
      if (!(c > 0)) throw new AdjustmentError('The level std error per distance must be greater than zero');
      if (!(r.length > 0)) throw new AdjustmentError(`Line ${r.line}: ${r.from}-${r.to} has no length, so it cannot be weighted`, { file: r.file, line: r.line });
      // sigma^2 = c^2 * d   (d in the per-distance unit: km or mile)
      sigma = c * Math.sqrt(r.length / unitInfo.perDistance);
    }
    if (!(sigma > 0)) throw new AdjustmentError(`Line ${r.line}: std error must be greater than zero`, { file: r.file, line: r.line });
    stations.get(r.from).nObs++;
    stations.get(r.to).nObs++;
    return { rec: r, from: r.from, to: r.to, observed: r.dElev, length: r.length, sigma, line: r.line, file: r.file };
  });

  // Free stations that nothing refers to are not part of the network.
  for (const [name, st] of [...stations]) {
    if (st.nObs === 0 && (!st.control || st.control.status === 'free')) {
      warnings.push({ file: st.firstFile, line: st.firstLine, message: `Station ${name} has no observations and is not control; ignored` });
      stations.delete(name);
    }
  }

  // ---- 3. Unknowns, connectivity, datum check ----------------------------
  const list = [...stations.values()];
  const col = new Map();
  for (const st of list) {
    st.status = st.control ? st.control.status : 'free';
    if (st.status !== 'fixed') col.set(st.name, col.size);
  }
  const n = col.size;
  const adj = new Map(list.map((s) => [s.name, []]));
  for (const o of obs) { adj.get(o.from).push(o.to); adj.get(o.to).push(o.from); }

  const seen = new Set();
  for (const st of list) {
    if (seen.has(st.name)) continue;
    const comp = [];
    const stack = [st.name];
    seen.add(st.name);
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      for (const nb of adj.get(k)) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    const anchored = comp.some((k) => { const s = stations.get(k).status; return s === 'fixed' || s === 'weighted'; });
    if (!anchored) {
      const shown = comp.slice(0, 6).join(', ') + (comp.length > 6 ? ', ...' : '');
      throw new AdjustmentError(
        `No vertical control: stations ${shown} are not tied to any fixed or weighted elevation`,
        { stations: comp },
      );
    }
  }

  // ---- 4. Approximate elevations h0 (breadth-first from entered values) ---
  const h0 = new Map();
  const queue = [];
  for (const st of list) {
    if (st.control) { h0.set(st.name, st.control.value); queue.push(st.name); }
  }
  const byStation = new Map(list.map((s) => [s.name, []]));
  for (const o of obs) { byStation.get(o.from).push(o); byStation.get(o.to).push(o); }
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi];
    for (const o of byStation.get(k)) {
      if (o.from === k && !h0.has(o.to)) { h0.set(o.to, h0.get(k) + o.observed); queue.push(o.to); }
      else if (o.to === k && !h0.has(o.from)) { h0.set(o.from, h0.get(k) - o.observed); queue.push(o.from); }
    }
  }

  // ---- 5. Build the equations as sparse rows -----------------------------
  // eq = { cols:[index...], coefs:[...], l, sigma }
  const eqs = [];
  for (const o of obs) {
    const cols = []; const coefs = [];
    if (col.has(o.to)) { cols.push(col.get(o.to)); coefs.push(1); }
    if (col.has(o.from)) { cols.push(col.get(o.from)); coefs.push(-1); }
    const l = o.observed - (h0.get(o.to) - h0.get(o.from));
    eqs.push({ cols, coefs, l, sigma: o.sigma, obs: o });
  }
  const weightedObs = [];
  for (const st of list) {
    if (st.status === 'weighted') {
      const l = st.control.value - h0.get(st.name);
      const eq = { cols: [col.get(st.name)], coefs: [1], l, sigma: st.control.stdErr, station: st };
      eqs.push(eq);
      weightedObs.push(eq);
    }
  }

  // ---- 6. Normal equations  N x = u --------------------------------------
  const N = Matrix.zeros(n, n);
  const u = new Float64Array(n);
  for (const e of eqs) {
    const w = 1 / (e.sigma * e.sigma);
    for (let p = 0; p < e.cols.length; p++) {
      u[e.cols[p]] += w * e.coefs[p] * e.l;
      for (let q = 0; q < e.cols.length; q++) N.add(e.cols[p], e.cols[q], w * e.coefs[p] * e.coefs[q]);
    }
  }

  let x; let Qxx;
  try {
    const L = cholesky(N);
    x = choleskySolve(L, u);
    Qxx = inverseSPD(N, L);
  } catch (err) {
    if (err instanceof SingularMatrixError) {
      throw new AdjustmentError('The network cannot be solved: it is not tied down by enough fixed or weighted control', { cause: err.message });
    }
    throw err;
  }

  // ---- 7. Residuals and statistics ---------------------------------------
  let T = 0;                                   // v^T P v
  for (const e of eqs) {
    let ax = 0;
    for (let p = 0; p < e.cols.length; p++) ax += e.coefs[p] * x[e.cols[p]];
    e.v = ax - e.l;                            // adjusted - observed
    e.stdRes = e.v / e.sigma;
    T += e.stdRes * e.stdRes;
  }
  const nObs = eqs.length;
  const dof = nObs - n;
  const alpha = settings.chiSquarePercent / 100;
  const test = dof > 0 ? chiSquareTest(T, dof, alpha) : null;
  const errorFactor = dof > 0 ? Math.sqrt(T / dof) : 1;
  const scale = dof > 0 ? propagationScale(settings.errorScaling, test, errorFactor) : 1;
  const z = normalQuantile(0.5 + settings.confidencePercent / 200);

  // ---- 8. Results --------------------------------------------------------
  const outStations = list.map((st) => {
    let elevation; let stdDev;
    if (st.status === 'fixed') {
      elevation = st.control.value;
      stdDev = settings.fixedStdErr * scale;
    } else {
      const k = col.get(st.name);
      elevation = h0.get(st.name) + x[k];
      stdDev = Math.sqrt(Qxx.get(k, k)) * scale;
    }
    return {
      name: st.name, status: st.status, elevation, stdDev, stdDevConf: stdDev * z,
      entered: st.control ? st.control.value : null,
      enteredStdErr: st.control ? st.control.stdErr : null,
      description: st.description,
    };
  });

  const flag = settings.stdResFlag;
  const outObs = eqs.filter((e) => e.obs).map((e) => ({
    from: e.obs.from, to: e.obs.to, line: e.obs.line, file: e.obs.file,
    length: e.obs.length, stdErr: e.sigma, observed: e.obs.observed,
    residual: e.v, adjusted: e.obs.observed + e.v, stdRes: e.stdRes,
    flagged: Math.abs(e.stdRes) > flag,
  }));
  const outWeighted = weightedObs.map((e) => ({
    name: e.station.name, observed: e.station.control.value, stdErr: e.sigma,
    residual: e.v, adjusted: e.station.control.value + e.v, stdRes: e.stdRes,
    flagged: Math.abs(e.stdRes) > flag,
  }));

  return {
    units: unitInfo,
    unitKey,
    stations: outStations,
    observations: outObs,
    weightedControl: outWeighted,
    stats: {
      nStations: list.length,
      nFixed: list.filter((s) => s.status === 'fixed').length,
      nObservations: nObs,
      nLevelObservations: outObs.length,
      nUnknowns: n,
      dof,
      sumSqStdRes: T,
      errorFactor,
      errorFactorApplied: scale,
      confidenceZ: z,
      chiSquare: test,
      nFlagged: outObs.filter((o) => o.flagged).length + outWeighted.filter((o) => o.flagged).length,
    },
    settings: { ...settings },
    warnings,
  };
}
