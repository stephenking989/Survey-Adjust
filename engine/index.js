// Public surface of the engine. The UI and the tests import from here.
//
//   const out = runAdjustment(datText, settings, { projectName: 'JOB1' });
//   out.result  - adjusted stations, observations, statistics
//   out.report  - { text, lines }  STAR*NET-style listing
//   out.csv(fmt) - 'PE' | 'PNEZD'

import { parseDat } from './parser.js';
import { adjustLevelling } from './level.js';
import { buildReport, exportCsv } from './report.js';
import { defaultSettings, linearUnitsFromDat } from './project.js';

export { parseDat, DatParseError, RECORD_PARSERS } from './parser.js';
export { adjustLevelling, AdjustmentError } from './level.js';
export { buildReport, exportCsv, ENGINE_NAME, ENGINE_VERSION } from './report.js';
export { defaultSettings, settingsFromSnproj, parseSnprojRaw, LINEAR_UNITS } from './project.js';
export { chiSquareTest, chiSquareQuantile, normalQuantile } from './stats.js';
export { Matrix, cholesky, choleskySolve, inverseSPD } from './matrix.js';

export function runAdjustment(datText, settings = defaultSettings(), opts = {}) {
  const parsed = parseDat(datText);
  // Units come from the .dat's .UNITS when it has one, otherwise from the settings.
  const s = { ...settings };
  const fromDat = linearUnitsFromDat(parsed.state.units);
  if (fromDat) s.linearUnits = fromDat;
  const result = adjustLevelling(parsed, s);
  const report = buildReport(result, {
    projectName: opts.projectName || s.projectName,
    dataFiles: opts.dataFiles,
    coordinateOrder: parsed.state.order,
    runDate: opts.runDate,
  });
  return { parsed, result, report, csv: (format, o) => exportCsv(result, { format, ...o }) };
}
