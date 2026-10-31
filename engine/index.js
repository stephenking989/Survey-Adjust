// Public surface of the engine. The UI and the tests import from here.
//
//   const out = runAdjustment(datText, settings, { projectName: 'JOB1' });
//   out.kind    - 'level' (1D) or '3d' (total-station network)
//   out.result  - adjusted stations, observations, statistics
//   out.report  - { text, lines }  STAR*NET-style listing
//   out.csv(fmt) - level: 'PE' | 'PNEZD';  3d: 'PNEZD' | 'PNE' | 'PE'

import { parseDat } from './parser.js';
import { parseDataFiles, placeLabel } from './files.js';
import { adjustLevelling, AdjustmentError } from './level.js';
import { adjustNetwork3D, RHO } from './network3d.js';
import { buildReport, exportCsv } from './report.js';
import { buildReport3D, exportCsv3D } from './report3d.js';
import { ellipseTables } from './ellipse.js';
import { defaultSettings, linearUnitsFromDat, LINEAR_UNITS } from './project.js';

export { parseDat, DatParseError, RECORD_PARSERS, parseAngle, parseBearing } from './parser.js';
export { parseDataFiles, DataFileError } from './files.js';
export { adviseOnAdjustment, worstResiduals } from './advice.js';
export { gsiToDat, readGsi, parseGsiLine, looksLikeGsi, GsiError } from './gsi.js';
export { ellipseTables, stationEllipse, relativeEllipse, connectedPairs } from './ellipse.js';
export { adjustLevelling, AdjustmentError } from './level.js';
export { adjustNetwork3D, errorModel } from './network3d.js';
export { buildReport, exportCsv } from './report.js';
export { buildReport3D, exportCsv3D, fmtDms } from './report3d.js';
export { ENGINE_NAME, ENGINE_VERSION } from './version.js';
export { defaultSettings, settingsFromSnproj, parseSnprojRaw, dataFileNamesFromSnproj, linearUnitsFromDat, LINEAR_UNITS } from './project.js';
export { chiSquareTest, chiSquareQuantile, normalQuantile, propagationScale } from './stats.js';
export { Matrix, cholesky, choleskySolve, inverseSPD } from './matrix.js';
export const RHO_ARCSEC = RHO;

const TOTAL_STATION = new Set(['DM', 'DN', 'DV', 'D', 'V', 'A', 'B', 'M']);

/**
 * 'level' when the files have L records; otherwise the total-station records decide between '2d' and '3d':
 * the job is 3D when any control point has an elevation or any observation is in 3D format (a zenith, or
 * written after .3D), and 2D when everything is horizontal.
 */
export function detectKind(parsed) {
  const level = parsed.records.some((r) => r.type === 'L');
  const ts = parsed.records.some((r) => TOTAL_STATION.has(r.type));
  if (level && ts) throw new AdjustmentError('This file mixes differential levels (L) with total-station observations; adjust them in separate files for now');
  if (level) return 'level';
  if (ts) {
    const is3d = parsed.records.some((r) => (r.type === 'C' && r.elevation !== undefined)
      || (TOTAL_STATION.has(r.type) && (r.dim === 3 || (r.zenith !== undefined && r.zenith !== null) || r.type === 'V' || r.type === 'DV')));
    return is3d ? '3d' : '2d';
  }
  throw new AdjustmentError('The data file has no observations this version can adjust (L, DM, DN, DV, D, V, A, B or M records)');
}

/**
 * Accept one piece of text (the old call) or a list of files { name, text, include }.
 * Returns the files that will be read, in order.
 */
function normaliseFiles(input, opts) {
  if (typeof input === 'string') return [{ name: (opts.dataFiles && opts.dataFiles[0]) || `${opts.projectName || 'job'}.dat`, text: input, include: true }];
  return input.filter((f) => f.include !== false);
}

/** Put the file name in front of "Line N:" once there is more than one file to tell apart. */
function locateError(err, parsed) {
  if (err instanceof AdjustmentError && err.details && err.details.file && parsed.files.length > 1) {
    err.message = err.message.replace(/^Line \d+: /, `${placeLabel(parsed, err.details.file, err.details.line)}: `);
  }
  return err;
}

export function runAdjustment(input, settings = defaultSettings(), opts = {}) {
  const files = normaliseFiles(input, opts);
  if (files.length === 0) throw new AdjustmentError('No data files are included. Tick at least one file in the list.');
  const parsed = parseDataFiles(files);
  const kind = detectKind(parsed);
  // Units come from the .dat's .UNITS when it has one, otherwise from the settings.
  const s = { ...settings };
  const fromDat = linearUnitsFromDat(parsed.state.units);
  if (fromDat) s.linearUnits = fromDat;
  const common = { projectName: opts.projectName || s.projectName, dataFiles: parsed.files.map((f) => f.name), coordinateOrder: parsed.state.order, runDate: opts.runDate };
  try {
    if (kind === 'level') {
      const result = adjustLevelling(parsed, s);
      const report = buildReport(result, common);
      return { kind, parsed, result, report, csv: (format, o) => exportCsv(result, { format, ...o }) };
    }
    s.unitsInfo = LINEAR_UNITS[s.linearUnits];
    s.dimension = kind === '2d' ? 2 : 3;
    const result = adjustNetwork3D(parsed, s);
    const ellipses = ellipseTables({ parsed, result });
    const report = buildReport3D(result, { ...common, ellipses });
    return { kind, parsed, result, ellipses, report, csv: (format, o) => exportCsv3D(result, { format, ...o }) };
  } catch (err) {
    throw locateError(err, parsed);
  }
}

/**
 * "Data check" in the spirit of STAR*NET's Run > Data Check Only: read every included file,
 * list every syntax error and warning with its file and line, then confirm the data can be
 * set up as a network. It does not report an adjustment.
 *
 * Returns { ok, errors, warnings, summary } with errors/warnings as { file, fileName, line, message }.
 */
export function checkData(input, settings = defaultSettings(), opts = {}) {
  const files = normaliseFiles(input, opts);
  const errors = [];
  const warnings = [];
  const summary = { kind: null, files: [], records: {} };
  if (files.length === 0) {
    errors.push({ file: null, fileName: '', line: null, message: 'No data files are included. Tick at least one file in the list.' });
    return { ok: false, errors, warnings, summary };
  }
  const parsed = parseDataFiles(files, { collectErrors: true });
  const nameOf = (i) => (parsed.files[i - 1] ? parsed.files[i - 1].name : '');
  for (const e of parsed.errors) errors.push({ file: e.file, fileName: e.fileName, line: e.line, message: e.message });
  for (const w of parsed.warnings) warnings.push({ file: w.file, fileName: nameOf(w.file), line: w.line, message: w.message });
  summary.files = parsed.files.map((f) => ({ ...f, records: parsed.records.filter((r) => r.file === f.index && r.type !== 'DB' && r.type !== 'DE').length }));
  for (const r of parsed.records) summary.records[r.type] = (summary.records[r.type] || 0) + 1;
  if (errors.length === 0) {
    try {
      summary.kind = detectKind(parsed);
      // Setting up the network finds stations without coordinates, unreachable stations and
      // an unconstrained datum; the engine reports them with the offending line.
      const out = runAdjustment(files, settings, opts);
      for (const w of out.result.warnings) {
        if (!parsed.warnings.some((p) => p.line === w.line && p.file === w.file && p.message === w.message)) {
          warnings.push({ file: w.file || null, fileName: w.file ? nameOf(w.file) : '', line: w.line || null, message: w.message, note: !!w.note });
        }
      }
    } catch (err) {
      const d = err && err.details;
      errors.push({
        file: d && d.file ? d.file : null, fileName: d && d.file ? nameOf(d.file) : '', line: d && d.line ? d.line : null,
        message: err.message.replace(/^.*?, line \d+: /, '').replace(/^Line \d+: /, ''),
      });
    }
  }
  return { ok: errors.length === 0, errors, warnings, summary };
}
