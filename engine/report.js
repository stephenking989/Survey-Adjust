// Plain-text adjustment listing, laid out like a STAR*NET .lst, plus CSV export.
//
// buildReport() returns { text, lines } where `lines` is [{ text, tag }].
// `tag` is 'warn' (failed chi-square, warnings) or 'flag' (|StdRes| above the
// threshold) or null, so a UI can colour lines without re-parsing the text.
// Pure function: pass `runDate` if you need a reproducible listing.

export const ENGINE_NAME = 'Survey-Adjust';
export const ENGINE_VERSION = '0.1.0';

const WIDTH = 80;
const LIST_DECIMALS = 4;   // the .lst prints elevations to 4 places

const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const padL = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s).padEnd(n);
const center = (s) => ' '.repeat(Math.max(0, Math.floor((WIDTH - s.length) / 2))) + s;

function fmtRunDate(d) {
  const day = d.toDateString();                         // "Fri Oct 30 2026"
  const pad = (n) => String(n).padStart(2, '0');
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function buildReport(result, opts = {}) {
  const lines = [];
  const push = (text = '', tag = null) => lines.push({ text, tag });
  const heading = (title) => { push(center(title)); push(center('='.repeat(title.length))); push(); };

  const { stats, units, settings } = result;
  const u = units.label;                                  // "Meters"
  const perLabel = `${units.label} / ${units.perLabel}`;  // "Meters / Km"
  const runDate = opts.runDate || new Date();
  const projectName = opts.projectName || settings.projectName || 'Untitled';
  const dataFiles = opts.dataFiles && opts.dataFiles.length ? opts.dataFiles : [`${projectName}.dat`];
  const order = (opts.coordinateOrder || 'NE').toUpperCase() === 'EN' ? 'East-North' : 'North-East';

  // ---- Header and options ------------------------------------------------
  push(center(`${ENGINE_NAME} Version ${ENGINE_VERSION}  -  1D Levelling Adjustment`));
  push(center(`Run Date: ${fmtRunDate(runDate)}`));
  push(); push();
  heading('Summary of Files Used and Option Settings');
  push(center('Project Folder and Data Files'));
  push();
  push(`      Project Name       ${projectName}`);
  dataFiles.forEach((name, i) => push(`      ${i === 0 ? 'Data File List  ' : '                '}${i + 1}. ${name}`));
  push();
  push(center('Project Option Settings'));
  push();
  push('      Survey-Adjust Run Mode              : Adjust with Error Propagation');
  push('      Type of Adjustment                  : Lev');
  push(`      Project Units                       : ${u}`);
  push(`      Input/Output Coordinate Order       : ${order}`);
  push(`      Chi-Square Test Significance        : ${f(settings.chiSquarePercent, 2)}%`);
  push(`      Std Devs Scaled by Error Factor     : ${settings.scaleByErrorFactor ? 'Yes' : 'No'}`);
  push();
  push(center('Instrument Standard Error Settings'));
  push();
  push('      Project Default Instrument');
  push(`        Differential Levels               : ${padL(f(settings.levelStdErr, 6), 11)} ${perLabel}`);
  push();

  // ---- Warnings from the parser/engine ----------------------------------
  if (result.warnings.length) {
    heading('Warnings');
    for (const w of result.warnings) push(`      Line ${w.line}: ${w.message}`, 'warn');
    push();
  }

  // ---- Unadjusted observations ------------------------------------------
  heading('Summary of Unadjusted Input Observations');
  const entered = result.stations.filter((s) => s.entered !== null);
  push(center(`Number of Entered Stations (${u}) = ${entered.length}`));
  push();
  const group = (title, status, extra) => {
    const rows = entered.filter((s) => s.status === status);
    if (!rows.length) return;
    push(`${padR(title, 16)}${padL('Elev', 12)}${extra ? padL(extra.head, 10) : ''}   Description`);
    for (const s of rows) {
      push(`${padR(s.name, 16)}${padL(f(s.entered, LIST_DECIMALS), 12)}${extra ? padL(f(s.enteredStdErr, LIST_DECIMALS), 10) : ''}${s.description ? '   ' + s.description : ''}`.trimEnd());
    }
    push();
  };
  group('Fixed Stations', 'fixed');
  group('Weighted Stations', 'weighted', { head: 'StdErr' });
  group('Free Stations', 'free');

  push(center(`Number of Differential Level Observations (${u}) = ${stats.nLevelObservations}`));
  push();
  push('From            To                  Elev Diff    StdErr  Length');
  for (const o of result.observations) {
    push(`${padR(o.from, 16)}${padR(o.to, 16)}${padL(f(o.observed, LIST_DECIMALS), 13)}${padL(f(o.stdErr, LIST_DECIMALS), 10)}${padL(f(o.length, 0), 8)}`);
  }
  push();

  // ---- Statistical summary ----------------------------------------------
  heading('Adjustment Statistical Summary');
  const T = stats.sumSqStdRes;
  push(`                        Number of Stations      = ${padL(stats.nStations, 6)}`);
  push();
  push(`                        Number of Observations  = ${padL(stats.nObservations, 6)}`);
  push(`                        Number of Unknowns      = ${padL(stats.nUnknowns, 6)}`);
  push(`                        Number of Redundant Obs = ${padL(stats.dof, 6)}`);
  push();
  push('            Observation   Count   Sum Squares         Error');
  push('                                    of StdRes        Factor');
  const levelSS = result.observations.reduce((a, o) => a + o.stdRes * o.stdRes, 0);
  const wtdSS = result.weightedControl.reduce((a, o) => a + o.stdRes * o.stdRes, 0);
  const ef = (ss, n) => (stats.dof > 0 && n > 0 ? f(Math.sqrt(ss / stats.dof), 3) : '');
  const row = (label, n, ss, factor) => `${padL(label, 22)}${padL(n, 8)}${padL(f(ss, 3), 14)}${padL(factor, 14)}`;
  push(row('Level Data', stats.nLevelObservations, levelSS, stats.dof > 0 ? f(Math.sqrt(levelSS / stats.dof), 3) : ''));
  if (result.weightedControl.length) {
    push(row('Weighted Elev', result.weightedControl.length, wtdSS, ef(wtdSS, 1)));
  }
  push();
  push(row('Total', stats.nObservations, T, stats.dof > 0 ? f(stats.errorFactor, 3) : ''));
  push();
  const ct = stats.chiSquare;
  if (!ct) {
    push('       The Chi-Square Test was not performed: there are no redundant observations.', 'warn');
  } else {
    const pct = f(settings.chiSquarePercent, 2);
    const bounds = `Lower/Upper Bounds (${f(ct.lowerBound, 3)}/${f(ct.upperBound, 3)})`;
    if (ct.passed) {
      push(`       The Chi-Square Test at ${pct}% Level Succeeded`);
      push(center(bounds).replace(/^ {0,8}/, '                       '));
    } else {
      const which = ct.verdict === 'above-upper' ? 'Upper' : 'Lower';
      push(`       Warning: The Chi-Square Test at ${pct}% Level Exceeded ${which} Bound`, 'warn');
      push(`                       ${bounds}`, 'warn');
    }
  }
  push();

  // ---- Adjusted elevations ----------------------------------------------
  heading(`Adjusted Elevations and Error Propagation (${u})`);
  if (settings.scaleByErrorFactor && stats.dof > 0) {
    push(`Std deviations are scaled by the Total Error Factor (${f(stats.errorFactor, 3)}).`);
    push();
  }
  push(`Station                  Elev        StdDev        ${padR(f(settings.confidencePercent, 0) + '%', 4)}     Description`);
  for (const s of result.stations) {
    push(`${padR(s.name, 16)}${padL(f(s.elevation, LIST_DECIMALS), 14)}${padL(f(s.stdDev, 6), 14)}${padL(f(s.stdDevConf, 6), 14)}${s.description ? '     ' + s.description : ''}`.trimEnd());
  }
  push();

  // ---- Adjusted observations --------------------------------------------
  heading('Adjusted Observations and Residuals');
  const stdResCell = (o) => `${padL(f(Math.abs(o.stdRes), 1), 6)}${o.flagged ? '*' : ' '}`;
  if (result.weightedControl.length) {
    push(center(`Adjusted Weighted Elevation Observations (${u})`));
    push();
    push('Station                          Elev      Residual   StdErr StdRes');
    for (const o of result.weightedControl) {
      push(`${padR(o.name, 16)}${padL(f(o.adjusted, LIST_DECIMALS), 20)}${padL(f(o.residual, LIST_DECIMALS), 14)}${padL(f(o.stdErr, LIST_DECIMALS), 9)}${stdResCell(o)}`, o.flagged ? 'flag' : null);
    }
    push();
  }
  push(center(`Adjusted Differential Level Observations (${u})`));
  push();
  push('From            To                   Elev Diff      Residual   StdErr StdRes File:Line');
  for (const o of result.observations) {
    push(`${padR(o.from, 16)}${padR(o.to, 16)}${padL(f(o.adjusted, LIST_DECIMALS), 14)}${padL(f(o.residual, LIST_DECIMALS), 14)}${padL(f(o.stdErr, LIST_DECIMALS), 9)}${stdResCell(o)}   ${padR(`${o.file}:${o.line}`, 6)}`.trimEnd(), o.flagged ? 'flag' : null);
  }
  push();
  if (stats.nFlagged) {
    push(`  * ${stats.nFlagged} observation(s) have |StdRes| greater than ${f(settings.stdResFlag, 1)}.`);
    push();
  }
  push();
  push(center(`${ENGINE_NAME} ${ENGINE_VERSION}`));

  return { text: lines.map((l) => l.text).join('\n') + '\n', lines };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const csvCell = (s) => (/[",\r\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

/**
 * format 'PE'    : Point,Elevation
 * format 'PNEZD' : Point,Northing,Easting,Elevation,Description  (N and E are
 *                  blank for a 1D job - there is no horizontal position)
 * Elevations use settings.elevationDecimals places (5 by default, like STAR*NET's .pts).
 */
export function exportCsv(result, { format = 'PE', header = false, decimals } = {}) {
  const d = decimals === undefined ? result.settings.elevationDecimals : decimals;
  const rows = [];
  if (format === 'PNEZD') {
    if (header) rows.push('Point,Northing,Easting,Elevation,Description');
    for (const s of result.stations) rows.push([csvCell(s.name), '', '', s.elevation.toFixed(d), csvCell(s.description || '')].join(','));
  } else if (format === 'PE') {
    if (header) rows.push('Point,Elevation');
    for (const s of result.stations) rows.push(`${csvCell(s.name)},${s.elevation.toFixed(d)}`);
  } else {
    throw new Error(`Unknown CSV format "${format}"`);
  }
  return rows.join('\r\n') + '\r\n';
}
