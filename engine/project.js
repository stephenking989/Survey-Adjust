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
    /** 'auto' (STAR*NET: scale std devs by the error factor only if chi-square fails), 'always' or 'never'. */
    errorScaling: 'auto',
    /** |StdRes| above this is flagged. */
    stdResFlag: 3,
    /** Confidence level of the "68%" column, percent. */
    confidencePercent: 68,
    elevationDecimals: 5,
    // ---- 2D/3D total-station settings (STAR*NET's defaults) ----
    /** Default instrument. Angles in arc-seconds, lengths in project units. */
    instrument: {
      distanceConstant: 0.0091440183, distancePpm: 0, edmMethod: 'additive',
      angle: 4, direction: 3, azimuth: 4, zenith: 10,
      centeringInstrument: 0, centeringTarget: 0, centeringVertical: 0,
    },
    earthRadius: 6372000,
    /** Coefficient of refraction; a .REF line in the data file overrides it. */
    refraction: 0.07,
    /** Std error of an angle/azimuth marked "!" (arc-seconds). */
    fixedAngularStdErr: 1.0001e-3,
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
  // 2D/3D instrument and geometry settings
  const num = (v) => (v === undefined ? undefined : Number(v));
  const ii = { ...s.instrument };
  const take = (key, field) => { const v = num(ins[key]); if (v !== undefined) ii[field] = v; };
  take('distance_std_err', 'distanceConstant'); take('edm_ppm', 'distancePpm');
  take('angle_std_err', 'angle'); take('direction_std_err', 'direction'); take('azimuth_std_err', 'azimuth');
  take('zenith_std_err', 'zenith'); take('instrument_centering_error', 'centeringInstrument');
  take('target_centering_error', 'centeringTarget'); take('vertical_centering_error', 'centeringVertical');
  s.instrument = ii;
  if (adj.earth_radius_meters !== undefined) s.earthRadius = Number(adj.earth_radius_meters);
  if (adj.index_of_refraction !== undefined) s.refraction = Number(adj.index_of_refraction);
  if (adj.fixed_angular_std_err !== undefined) s.fixedAngularStdErr = Number(adj.fixed_angular_std_err);
  return s;
}

/**
 * The data file names listed under [DataFileList] in a .snproj, in order, e.g.  3 "Network.dat".
 * (The number in front is not interpreted: only the quoted names and their order are used.)
 */
export function dataFileNamesFromSnproj(text) {
  const names = [];
  let inList = false;
  for (const raw of String(text).split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { inList = sec[1] === 'DataFileList'; continue; }
    if (!inList || line.startsWith('#')) continue;
    const m = /"([^"]+)"/.exec(line);
    if (m) names.push(m[1].replace(/^.*[\\/]/, ''));
  }
  return names;
}
