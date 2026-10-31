// Project settings.
//
// STAR*NET keeps adjustment settings in the .snproj file, not in the .dat.
// This module defines our defaults and can read the relevant keys out of a
// .snproj so a job can be loaded exactly as STAR*NET ran it.

/** Distance unit that "std error per distance" refers to, per project linear unit. */
export const LINEAR_UNITS = {
  meters: { label: 'Meters', short: 'm', perDistance: 1000, perLabel: 'Km', perShort: 'km' },
  feet:   { label: 'Feet',   short: 'ft', perDistance: 5280, perLabel: 'Mile', perShort: 'mi' },
};

/** Map the words allowed after .UNITS (Meters, Feet, Survey, IFeet, ...) to a LINEAR_UNITS key. */
export function linearUnitsFromDat(unitsArgs) {
  for (const a of unitsArgs || []) {
    const w = String(a).toLowerCase();
    if (w.startsWith('meter') || w === 'm') return 'meters';
    if (w.startsWith('feet') || w === 'survey' || w === 'ifeet' || w === 'ft') return 'feet';
  }
  return null;
}

export function defaultSettings() {
  return {
    projectName: 'Untitled',
    linearUnits: 'meters',
    /** Differential-level std error, in project units per kilometre (meters) / mile (feet) of line length. */
    levelStdErr: 0.0005,
    /** How levelStdErr grows with line length. Only LENGTH is implemented. */
    levelSectionType: 'LENGTH',
    /** Chi-square test significance level, percent. */
    chiSquarePercent: 5,
    /** Std error STAR*NET assigns to a "fixed" value (project units). */
    fixedStdErr: 1e-7,
    /** Multiply propagated std devs by the total error factor (see level.js). */
    scaleByErrorFactor: true,
    /** |StdRes| above this is flagged. */
    stdResFlag: 3,
    /** Confidence level of the "68%" column, percent. */
    confidencePercent: 68,
    elevationDecimals: 5,
  };
}

/** Parse the "[Section] key value" format of a .snproj into { section: { key: value } }. */
export function parseSnprojRaw(text) {
  const out = {};
  let section = '';
  for (const raw of String(text).split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('*')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { section = sec[1]; out[section] = out[section] || {}; continue; }
    const m = /^(\S+)\s*(.*)$/.exec(line);
    if (m && section) out[section][m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Extract the settings this engine understands from a .snproj.
 *
 * STAR*NET stores level_std_err per sqrt(metre) of line length
 * (0.0002 m/km  ->  0.0002 / sqrt(1000) = 6.3246e-6 m/sqrt(m)), so we convert back to the
 * per-kilometre figure the user types.
 */
export function settingsFromSnproj(text, base = defaultSettings()) {
  const raw = parseSnprojRaw(text);
  const adj = raw.Adjustment || {};
  const ins = raw.Instrument || {};
  const s = { ...base };
  if (/^feet|^survey|^ifeet/i.test(adj.linear_units || '')) s.linearUnits = 'feet';
  else if (/^meter/i.test(adj.linear_units || '')) s.linearUnits = 'meters';
  const per = LINEAR_UNITS[s.linearUnits].perDistance;
  if (ins.level_std_err !== undefined) s.levelStdErr = Number(ins.level_std_err) * Math.sqrt(per);
  if (ins.level_section_type) s.levelSectionType = ins.level_section_type.toUpperCase();
  if (adj.chi_sqr_percent_significance !== undefined) s.chiSquarePercent = Number(adj.chi_sqr_percent_significance);
  if (adj.fixed_linear_std_err !== undefined) s.fixedStdErr = Number(adj.fixed_linear_std_err);
  if (adj.ell_percent_confidence !== undefined) s.confidencePercent = Number(adj.ell_percent_confidence);
  if ((raw.Listing || {}).number_elevation_decimals !== undefined) s.elevationDecimals = Number((raw.Listing).number_elevation_decimals);
  s.adjustmentType = adj.adjustment_type || null;
  return s;
}
