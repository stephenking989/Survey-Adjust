// Public surface of the engine. The UI and the tests import from here.
//
//   const out = runAdjustment(datText, settings, { projectName: 'JOB1' });
//   out.kind    - 'level' (1D) or '3d' (total-station network)
//   out.result  - adjusted stations, observations, statistics
//   out.report  - { text, lines }  STAR*NET-style listing
//   out.csv(fmt) - level: 'PE' | 'PNEZD';  3d: 'PNEZD' | 'PNE' | 'PE'

import { parseDat } from './parser.js';
import { adjustLevelling, AdjustmentError } from './level.js';
import { adjustNetwork3D, RHO } from './network3d.js';
import { buildReport, exportCsv } from './report.js';
import { buildReport3D, exportCsv3D } from './report3d.js';
import { defaultSettings, linearUnitsFromDat, LINEAR_UNITS } from './project.js';

export { parseDat, DatParseError, RECORD_PARSERS, parseAngle, parseBearing } from './parser.js';
export { adjustLevelling, AdjustmentError } from './level.js';
export { adjustNetwork3D, errorModel } from './network3d.js';
export { buildReport, exportCsv } from './report.js';
export { buildReport3D, exportCsv3D, fmtDms } from './report3d.js';
export { ENGINE_NAME, ENGINE_VERSION } from './version.js';
export { defaultSettings, settingsFromSnproj, parseSnprojRaw, linearUnitsFromDat, LINEAR_UNITS } from './project.js';
export { chiSquareTest, chiSquareQuantile, normalQuantile, propagationScale } from './stats.js';
export { Matrix, cholesky, choleskySolve, inverseSPD } from './matrix.js';
export const RHO_ARCSEC = RHO;

const TOTAL_STATION = new Set(['DM', 'DN', 'DV', 'D', 'V', 'A', 'B', 'M']);

/** 'level' when the file has L records, '3d' when it has total-station records. */
export function detectKind(parsed) {
  const level = parsed.records.some((r) => r.type === 'L');
  const ts = parsed.records.some((r) => TOTAL_STATION.has(r.type));
  if (level && ts) throw new AdjustmentError('This file mixes differential levels (L) with total-station observations; adjust them in separate files for now');
  if (level) return 'level';
  if (ts) return '3d';
  throw new AdjustmentError('The data file has no observations this version can adjust (L, DM, DN, DV, D, V, A, B or M records)');
}

export function runAdjustment(datText, settings = defaultSettings(), opts = {}) {
  const parsed = parseDat(datText);
  const kind = detectKind(parsed);
  // Units come from the .dat's .UNITS when it has one, otherwise from the settings.
  const s = { ...settings };
  const fromDat = linearUnitsFromDat(parsed.state.units);
  if (fromDat) s.linearUnits = fromDat;
  const common = { projectName: opts.projectName || s.projectName, dataFiles: opts.dataFiles, coordinateOrder: parsed.state.order, runDate: opts.runDate };
  if (kind === 'level') {
    const result = adjustLevelling(parsed, s);
    const report = buildReport(result, common);
    return { kind, parsed, result, report, csv: (format, o) => exportCsv(result, { format, ...o }) };
  }
  s.unitsInfo = LINEAR_UNITS[s.linearUnits];
  const result = adjustNetwork3D(parsed, s);
  const report = buildReport3D(result, common);
  return { kind, parsed, result, report, csv: (format, o) => exportCsv3D(result, { format, ...o }) };
}
