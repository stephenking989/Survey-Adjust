// STAR*NET-style plain-text listing for a 3D total-station adjustment, and its CSV export.
// Same contract as report.js: returns { text, lines: [{ text, tag }] } with tag 'warn' | 'flag' | null.

import { ENGINE_NAME, ENGINE_VERSION } from './version.js';
import { RHO } from './network3d.js';

const WIDTH = 80;
const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const padL = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s).padEnd(n);
const center = (s) => ' '.repeat(Math.max(0, Math.floor((WIDTH - s.length) / 2))) + s;

/** Decimal degrees -> "D-MM-SS.ss" (signed form "-0-00-01.76" like the STAR*NET listing). */
export function fmtDms(deg, decimals = 2) {
  const neg = deg < 0;
  let t = Math.round(Math.abs(deg) * 3600 * 10 ** decimals) / 10 ** decimals;
  const d = Math.floor(t / 3600); t -= d * 3600;
  const m = Math.floor(t / 60); const s = t - m * 60;
  const ss = s.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0');
  return `${neg ? '-' : ''}${d}-${String(m).padStart(2, '0')}-${ss}`;
}
const dmsRad = (rad, d) => fmtDms((rad * 180) / Math.PI, d);
const norm360 = (rad) => ((rad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

function fmtRunDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.toDateString()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function buildReport3D(result, opts = {}) {
  const lines = [];
  const push = (text = '', tag = null) => lines.push({ text, tag });
  const heading = (title) => { push(center(title)); push(center('='.repeat(title.length))); push(); };

  const { stats, settings } = result;
  const u = result.units.label;
  const ins = settings.instrument;
  const projectName = opts.projectName || settings.projectName || 'Untitled';
  const dataFiles = opts.dataFiles && opts.dataFiles.length ? opts.dataFiles : [`${projectName}.dat`];
  const en = (opts.coordinateOrder || 'NE').toUpperCase() === 'EN';
  const coordHead = en ? ['E', 'N'] : ['N', 'E'];
  const pick = (s) => (en ? [s.e, s.n, s.z] : [s.n, s.e, s.z]);
  const pickSd = (s) => (en ? [s.stdDev[1], s.stdDev[0], s.stdDev[2]] : [s.stdDev[0], s.stdDev[1], s.stdDev[2]]);
  const k = Number.isFinite(opts.refraction) ? opts.refraction : settings.refraction;

  push(center(`${ENGINE_NAME} Version ${ENGINE_VERSION}  -  3D Adjustment`));
  push(center(`Run Date: ${fmtRunDate(opts.runDate || new Date())}`));
  push(); push();
  heading('Summary of Files Used and Option Settings');
  push(center('Project Folder and Data Files')); push();
  push(`      Project Name       ${projectName}`);
  dataFiles.forEach((n, i) => push(`      ${i === 0 ? 'Data File List  ' : '                '}${i + 1}. ${n}`));
  push();
  push(center('Project Option Settings')); push();
  push('      Survey-Adjust Run Mode              : Adjust with Error Propagation');
  push('      Type of Adjustment                  : 3D');
  push(`      Project Units                       : ${u}; DMS`);
  push('      Coordinate System                   : LOCAL');
  push(`      Input/Output Coordinate Order       : ${en ? 'East-North' : 'North-East'}`);
  push('      Distance/Vertical Data Type         : Slope/Zenith');
  push(`      Default Coefficient of Refraction   : ${f(settings.refraction, 6)}`);
  push(`      Earth Radius                        : ${f(settings.earthRadius, 2)} ${u}`);
  push(`      Chi-Square Test Significance        : ${f(settings.chiSquarePercent, 2)}%`);
  push(`      Std Devs Scaled by Error Factor     : ${stats.errorFactorApplied !== 1 ? 'Yes (chi-square test failed)' : 'No'}`);
  push();
  push(center('Instrument Standard Error Settings')); push();
  push('      Project Default Instrument');
  push(`        Distances (Constant)              : ${padL(f(ins.distanceConstant, 6), 11)} ${u}`);
  push(`        Distances (PPM)                   : ${padL(f(ins.distancePpm, 6), 11)}`);
  push(`        Angles                            : ${padL(f(ins.angle, 6), 11)} Seconds`);
  push(`        Directions                        : ${padL(f(ins.direction, 6), 11)} Seconds`);
  push(`        Azimuths & Bearings               : ${padL(f(ins.azimuth, 6), 11)} Seconds`);
  push(`        Zeniths                           : ${padL(f(ins.zenith, 6), 11)} Seconds`);
  push(`        Centering Error Instrument        : ${padL(f(ins.centeringInstrument, 6), 11)} ${u}`);
  push(`        Centering Error Target            : ${padL(f(ins.centeringTarget, 6), 11)} ${u}`);
  push(`        Centering Error Vertical          : ${padL(f(ins.centeringVertical, 6), 11)} ${u}`);
  push();
  if (result.warnings.length) {
    heading('Warnings');
    for (const w of result.warnings) push(`      ${w.line ? `${w.file || 1}:${w.line}  ` : ''}${w.message}`, w.note ? null : 'warn');
    push();
  }

  // ---- Unadjusted input -------------------------------------------------
  heading('Summary of Unadjusted Input Observations');
  const control = result.stations.filter((s) => s.status.some((x) => x !== 'free'));
  push(center(`Number of Entered Stations (${u}) = ${result.stations.length}`)); push();
  const sigmaOf = (s) => (s.enteredSd || []);
  const fixed = control.filter((s) => s.status.every((x) => x === 'fixed'));
  const partial = control.filter((s) => !s.status.every((x) => x === 'fixed'));
  if (fixed.length) {
    push(`Fixed Stations              ${padL(coordHead[0], 1)}                 ${coordHead[1]}          Elev   Description`);
    for (const s of fixed) { const c = pick(s.input); push(`${padR(s.name, 16)}${padL(f(c[0], 4), 15)}${padL(f(c[1], 4), 15)}${padL(f(c[2], 4), 12)}  ${s.description}`.trimEnd()); }
    push();
  }
  if (partial.length) {
    push(`Partially Fixed             ${coordHead[0]}                 ${coordHead[1]}          Elev   Description`);
    push('                          StdErr            StdErr      StdErr');
    for (const s of partial) {
      const c = pick(s.input); const sd = en ? [s.input.sd[1], s.input.sd[0], s.input.sd[2]] : s.input.sd;
      const st = en ? [s.status[1], s.status[0], s.status[2]] : s.status;
      const cell = (i) => (st[i] === 'weighted' ? f(sd[i], 4) : (st[i] === 'fixed' ? '!' : '*'));
      push(`${padR(s.name, 16)}${padL(f(c[0], 4), 15)}${padL(f(c[1], 4), 15)}${padL(f(c[2], 4), 12)}  ${s.description}`.trimEnd());
      push(`${' '.repeat(26)}${padL(cell(0), 6)}${padL(cell(1), 18)}${padL(cell(2), 12)}`);
    }
    push();
  }
  const free = result.stations.filter((s) => s.status.every((x) => x === 'free'));
  if (free.length) {
    push(`Free Stations               ${coordHead[0]}                 ${coordHead[1]}          Elev   Description`);
    for (const s of free) { const c = pick(s.input); push(`${padR(s.name, 16)}${padL(f(c[0], 4), 15)}${padL(f(c[1], 4), 15)}${padL(f(c[2], 4), 12)}  ${s.description}`.trimEnd()); }
    push();
  }
  const kinds = [['dist', 'Distance', `Meters`], ['zen', 'Zenith', 'DMS'], ['dir', 'Direction', 'DMS'], ['ang', 'Angle', 'DMS'], ['az', 'Azimuth/Bearing', 'DMS']];
  const unit = (kk) => (kk === 'dist' ? u : 'DMS');
  const byKind = (kk) => result.observations.filter((o) => o.kind === kk);
  if (byKind('dist').length) {
    push(center(`Number of Distance Observations (${u}) = ${byKind('dist').length}`)); push();
    push('From       To            Distance   StdErr      HI      HT  Type');
    for (const o of byKind('dist')) push(`${padR(o.from, 11)}${padR(o.to, 10)}${padL(f(o.observed, 4), 10)}${padL(f(o.sigma, 4), 9)}${padL(f(o.hi, 3), 8)}${padL(f(o.ht, 3), 8)}   S`);
    push();
  }
  if (byKind('zen').length) {
    push(center(`Number of Zenith Observations (DMS) = ${byKind('zen').length}`)); push();
    push('From       To              Zenith      StdErr      HI      HT    Refr');
    for (const o of byKind('zen')) push(`${padR(o.from, 11)}${padR(o.to, 10)}${padL(dmsRad(o.observed, 2), 14)}${padL(f(o.sigma * RHO, 2), 10)}${padL(f(o.hi, 3), 8)}${padL(f(o.ht, 3), 8)}${padL(f(o.refraction ?? k, 3), 8)}`);
    push();
  }
  if (byKind('dir').length) {
    push(center(`Number of Direction Observations (DMS) = ${byKind('dir').length}`)); push();
    push('From       To            Direction      StdErr');
    let set = null;
    for (const o of byKind('dir')) {
      if (o.set !== set) { set = o.set; push(); push(`Set ${set}`); }
      push(`${padR(o.from, 11)}${padR(o.to, 10)}${padL(dmsRad(norm360(o.observed), 2), 14)}${padL(f(o.sigma * RHO, 2), 10)}`);
    }
    push();
  }
  if (byKind('ang').length) {
    push(center(`Number of Angle Observations (DMS) = ${byKind('ang').length}`)); push();
    push('At         From       To              Angle       StdErr');
    for (const o of byKind('ang')) push(`${padR(o.from, 11)}${padR(o.via, 11)}${padR(o.to, 10)}${padL(dmsRad(norm360(o.observed), 2), 14)}${padL(f(o.sigma * RHO, 2), 10)}`);
    push();
  }
  if (byKind('az').length) {
    push(center(`Number of Azimuth/Bearing Observations (DMS) = ${byKind('az').length}`)); push();
    push('From       To            Azimuth       StdErr');
    for (const o of byKind('az')) push(`${padR(o.from, 11)}${padR(o.to, 10)}${padL(dmsRad(norm360(o.observed), 2), 14)}${padL(f(o.sigma * RHO, 2), 10)}`);
    push();
  }

  // ---- Statistical summary ------------------------------------------------
  heading('Adjustment Statistical Summary');
  push(`                        Iterations              = ${padL(result.iterations, 6)}`); push();
  push(`                        Number of Stations      = ${padL(stats.nStations, 6)}`); push();
  push(`                        Number of Observations  = ${padL(stats.nObservations, 6)}`);
  push(`                        Number of Unknowns      = ${padL(stats.nUnknowns, 6)}`);
  push(`                        Number of Redundant Obs = ${padL(stats.dof, 6)}`); push();
  push('            Observation   Count   Sum Squares         Error');
  push('                                    of StdRes        Factor');
  for (const c of stats.classes) {
    const label = c.name === 'Azimuths' ? 'Az/Bearings' : c.name;
    push(`${padL(label, 22)}${padL(c.count, 8)}${padL(f(c.sumSq, 3), 14)}${padL(stats.dof > 0 ? f(Math.sqrt(c.sumSq / stats.dof), 3) : '', 14)}`);
  }
  push();
  push(`${padL('Total', 22)}${padL(stats.nObservations, 8)}${padL(f(stats.sumSqStdRes, 3), 14)}${padL(stats.dof > 0 ? f(stats.errorFactor, 3) : '', 14)}`);
  push();
  const ct = stats.chiSquare;
  if (!ct) {
    push('       The Chi-Square Test was not performed: there are no redundant observations.', 'warn');
  } else {
    const pct = f(settings.chiSquarePercent, 2);
    const bounds = `Lower/Upper Bounds (${f(ct.lowerBound, 3)}/${f(ct.upperBound, 3)})`;
    if (ct.passed) {
      push(`       The Chi-Square Test at ${pct}% Level Passed`);
      push(`                       ${bounds}`);
    } else {
      push(`       Warning: The Chi-Square Test at ${pct}% Level Exceeded ${ct.verdict === 'above-upper' ? 'Upper' : 'Lower'} Bound`, 'warn');
      push(`                       ${bounds}`, 'warn');
    }
  }
  push();

  // ---- Adjusted coordinates -------------------------------------------------
  heading(`Adjusted Coordinates (${u})`);
  push(`Station                   ${coordHead[0]}              ${coordHead[1]}          Elev   Description`);
  for (const s of result.stations) { const c = pick(s); push(`${padR(s.name, 16)}${padL(f(c[0], 4), 14)}${padL(f(c[1], 4), 15)}${padL(f(c[2], 4), 12)}  ${s.description}`.trimEnd()); }
  push();

  // ---- Adjusted observations --------------------------------------------------
  heading('Adjusted Observations and Residuals');
  const stdResCell = (o) => `${padL(f(Math.abs(o.stdRes), 1), 6)}${o.flagged ? '*' : ' '}`;
  if (result.coordinateObservations.length) {
    push(center(`Adjusted Coordinate Observations (${u})`));
    push(center('(Stations with Partially Fixed Coordinate Components)')); push();
    push('Station           Component     Adj Coordinate      Residual   StdErr StdRes File:Line');
    for (const o of result.coordinateObservations) {
      push(`${padR(o.name, 18)}${padR(o.component, 10)}${padL(f(o.adjusted, 4), 15)}${padL(f(o.residual, 4), 14)}${padL(f(o.sigma, 4), 9)}${stdResCell(o)}   ${o.file || 1}:${o.line}`.trimEnd(), o.flagged ? 'flag' : null);
    }
    push();
  }
  const adjRows = (kk, title, head, row) => {
    const list = byKind(kk);
    if (!list.length) return;
    push(center(`${title} (${unit(kk)})`)); push();
    push(head);
    let set = null;
    for (const o of list) {
      if (kk === 'dir' && o.set !== set) { set = o.set; push(); push(`           Set ${set}`); }
      push(row(o).trimEnd(), o.flagged ? 'flag' : null);
    }
    push();
  };
  const tail = (o) => `${stdResCell(o)}   ${padR(`${o.file}:${o.line}`, 6)}`;
  adjRows('dist', 'Adjusted Distance Observations', '           From       To              Distance      Residual   StdErr StdRes File:Line',
    (o) => `           ${padR(o.from, 11)}${padR(o.to, 10)}${padL(f(o.adjusted, 4), 12)}${padL(f(o.residual, 4), 14)}${padL(f(o.sigma, 4), 9)}${tail(o)}`);
  adjRows('zen', 'Adjusted Zenith Observations', '           From       To              Zenith        Residual     Distance   StdErr StdRes File:Line',
    (o) => `           ${padR(o.from, 11)}${padR(o.to, 10)}${padL(dmsRad(o.adjusted, 2), 14)}${padL(dmsRad(o.residual, 2), 14)}${padL(f(o.residual * o.slope, 4), 12)}${padL(f(o.sigma * RHO, 2), 9)}${tail(o)}`);
  adjRows('dir', 'Adjusted Direction Observations', '           From       To            Direction        Residual     Distance   StdErr StdRes File:Line',
    (o) => `           ${padR(o.from, 11)}${padR(o.to, 10)}${padL(dmsRad(norm360(o.adjusted), 2), 14)}${padL(dmsRad(o.residual, 2), 14)}${padL(f(o.residual * o.horizontal, 4), 12)}${padL(f(o.sigma * RHO, 2), 9)}${tail(o)}`);
  adjRows('ang', 'Adjusted Angle Observations', '           At         From       To              Angle       Residual   StdErr StdRes File:Line',
    (o) => `           ${padR(o.from, 11)}${padR(o.via, 11)}${padR(o.to, 10)}${padL(dmsRad(norm360(o.adjusted), 2), 14)}${padL(dmsRad(o.residual, 2), 14)}${padL(f(o.sigma * RHO, 2), 9)}${tail(o)}`);
  adjRows('az', 'Adjusted Azimuth/Bearing Observations', '           From       To            Azimuth        Residual   StdErr StdRes File:Line',
    (o) => `           ${padR(o.from, 11)}${padR(o.to, 10)}${padL(dmsRad(norm360(o.adjusted), 2), 14)}${padL(dmsRad(o.residual, 2), 14)}${padL(f(o.sigma * RHO, 2), 9)}${tail(o)}`);
  if (stats.nFlagged) { push(`  * ${stats.nFlagged} observation(s) have |StdRes| greater than ${f(settings.stdResFlag, 1)}.`); push(); }

  // ---- Error propagation -------------------------------------------------------
  heading('Error Propagation');
  push(center(`Station Coordinate Standard Deviations (${u})`)); push();
  push(`Station                     ${coordHead[0]}             ${coordHead[1]}            Elev`);
  for (const s of result.stations) { const d = pickSd(s); push(`${padR(s.name, 16)}${padL(f(d[0], 6), 14)}${padL(f(d[1], 6), 14)}${padL(f(d[2], 6), 14)}`); }
  push();
  if (opts.ellipses) {
    const { confidence, stations, relative } = opts.ellipses;
    const conf = `${Number(confidence.toFixed(2))}%`;
    const az = (deg) => {
      let d = Math.floor(deg); let m = Math.round((deg - d) * 60);
      if (m === 60) { d += 1; m = 0; }
      return `${d % 180}-${String(m).padStart(2, '0')}`;
    };
    push(center(`Station Coordinate Error Ellipses (${u})`));
    push(center(`Confidence Region = ${conf}`)); push();
    push('Station                 Semi-Major    Semi-Minor   Azimuth of       Elev');
    push('                            Axis          Axis     Major Axis');
    for (const e of stations) push(`${padR(e.name, 16)}${padL(f(e.semiMajor, 6), 18)}${padL(f(e.semiMinor, 6), 14)}${padL(az(e.azimuth), 11)}${padL(f(e.vertical, 6), 13)}`);
    push();
    if (relative.length) {
      push(center(`Relative Error Ellipses (${u})`));
      push(center(`Confidence Region = ${conf}`)); push();
      push('Stations                Semi-Major    Semi-Minor   Azimuth of     Vertical');
      push('From       To               Axis          Axis     Major Axis');
      for (const e of relative) push(`${padR(e.from, 11)}${padR(e.to, 11)}${padL(f(e.semiMajor, 6), 12)}${padL(f(e.semiMinor, 6), 14)}${padL(az(e.azimuth), 11)}${padL(f(e.vertical, 6), 13)}`);
      push();
    }
  }
  push(center(`${ENGINE_NAME} ${ENGINE_VERSION}`));
  return { text: lines.map((l) => l.text).join('\n') + '\n', lines };
}

const csvCell = (s) => (/[",\r\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

/** format 'PNEZD' (Point,Northing,Easting,Elevation,Description), 'PNE' (no elevation) or 'PE' (Point,Elevation). */
export function exportCsv3D(result, { format = 'PNEZD', header = false, decimals } = {}) {
  const d = decimals === undefined ? result.settings.elevationDecimals : decimals;
  const rows = [];
  if (format === 'PNEZD') {
    if (header) rows.push('Point,Northing,Easting,Elevation,Description');
    for (const s of result.stations) rows.push([csvCell(s.name), s.n.toFixed(d), s.e.toFixed(d), s.z.toFixed(d), csvCell(s.description || '')].join(','));
  } else if (format === 'PNE') {
    if (header) rows.push('Point,Northing,Easting');
    for (const s of result.stations) rows.push([csvCell(s.name), s.n.toFixed(d), s.e.toFixed(d)].join(','));
  } else if (format === 'PE') {
    if (header) rows.push('Point,Elevation');
    for (const s of result.stations) rows.push(`${csvCell(s.name)},${s.z.toFixed(d)}`);
  } else throw new Error(`Unknown CSV format "${format}"`);
  return rows.join('\r\n') + '\r\n';
}
