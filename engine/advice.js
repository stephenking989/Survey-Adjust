// Plain-language help for a failed chi-square test.
//
// The test compares the sum of squared standardized residuals T = v'Pv with its expected value
// (the redundancy, dof). The "total error factor" sqrt(T/dof) is how many times bigger the
// real scatter is than the std errors you told the adjustment to expect (1 = perfect).
// A failed test therefore means exactly one of two things:
//   - a few observations are wrong (blunders), which inflate T on their own, or
//   - the std errors are set too small (or too large) for the whole data set.
// Nothing below is guesswork about STAR*NET: it only re-reads numbers the adjustment already
// produced and says which of the two cases the numbers look like.

import { chiSquareTest } from './stats.js';

const KIND_NAME = { dist: 'Distance', zen: 'Zenith', dir: 'Direction', ang: 'Angle', az: 'Azimuth' };

/** Every residual in a flat list, labelled for display: { label, stdRes, residual, flagged, file, line }. */
function allResiduals(out) {
  const r = out.result;
  const rows = [];
  if (out.kind === 'level') {
    for (const o of r.observations) rows.push({ label: `${o.from} to ${o.to}`, type: 'Level', stdRes: o.stdRes, residual: o.residual, flagged: o.flagged, file: o.file, line: o.line });
    for (const o of r.weightedControl) rows.push({ label: `${o.name} (weighted control)`, type: 'Control', stdRes: o.stdRes, residual: o.residual, flagged: o.flagged, file: null, line: null });
  } else {
    for (const o of r.observations) {
      const label = o.via ? `${o.from} from ${o.via} to ${o.to}` : `${o.from} to ${o.to}`;
      rows.push({ label, type: KIND_NAME[o.kind] || o.kind, stdRes: o.stdRes, residual: o.residual, flagged: o.flagged, file: o.file, line: o.line });
    }
    for (const o of r.coordinateObservations) rows.push({ label: `${o.name} ${o.component}`, type: 'Coordinate', stdRes: o.stdRes, residual: o.residual, flagged: o.flagged, file: o.file || null, line: o.line || null });
  }
  return rows;
}

/** The n observations with the largest |StdRes|, worst first. */
export function worstResiduals(out, n = 10) {
  return allResiduals(out).sort((a, b) => Math.abs(b.stdRes) - Math.abs(a.stdRes)).slice(0, n);
}

/** Which Options field controls each class of observation (so the advice can point at it). */
const CLASS_SETTING = {
  Directions: 'the direction std error in Options (and any std error written on DM/DN/DV lines)',
  Distances: 'the distance constant and ppm in Options (and any std error written on DM/DV/D lines)',
  Zeniths: 'the zenith std error in Options (and any std error written on zenith lines)',
  Angles: 'the angle std error in Options',
  Azimuths: 'the azimuth std error in Options',
  Coordinates: 'the std errors on the C records',
};

/**
 * Returns [{ level: 'ok' | 'info' | 'warn', text }] for the Summary page. Empty when there is
 * nothing to add (the test passed).
 */
export function adviseOnAdjustment(out) {
  const { stats, settings } = out.result;
  const ct = stats.chiSquare;
  const notes = [];
  if (!ct) {
    notes.push({ level: 'info', text: 'There is no redundancy (as many unknowns as observations), so the chi-square test cannot be run and the residuals are all zero.' });
    return notes;
  }
  if (ct.passed) return notes;

  const high = ct.verdict === 'above-upper';
  const ef = stats.errorFactor;
  const times = high ? ef : 1 / ef;
  notes.push({
    level: 'warn',
    text: high
      ? `The total error factor is ${ef.toFixed(2)}: the data scatter about ${times.toFixed(1)} times more than the std errors say it should.`
      : `The total error factor is ${ef.toFixed(2)}: the data scatter about ${times.toFixed(1)} times LESS than the std errors say, so the std errors are too pessimistic (this does not indicate a blunder).`,
  });

  // Blunder or std errors? A blunder shows as ONE residual far larger than the rest (its
  // neighbours pick up smaller ones); std errors set too small show as many moderate residuals.
  const rows = allResiduals(out);
  const sorted = rows.slice().sort((x, y) => Math.abs(y.stdRes) - Math.abs(x.stdRes));
  const flagged = rows.filter((r) => r.flagged);
  const where = (r) => {
    if (!r.line) return '';
    const f = out.parsed && out.parsed.files && out.parsed.files[r.file - 1];
    return ` (${f && out.parsed.files.length > 1 ? `${f.name}, ` : ''}line ${r.line})`;
  };
  const passesWithout = (drop) => {
    const T = stats.sumSqStdRes - drop.reduce((s, r) => s + r.stdRes * r.stdRes, 0);
    const dof = stats.dof - drop.length;
    return dof > 0 ? { dof, ef: Math.sqrt(T / dof), passed: chiSquareTest(T, dof, settings.chiSquarePercent / 100).passed } : null;
  };
  if (high) {
    const top = sorted[0];
    const second = sorted[1];
    const standout = top && Math.abs(top.stdRes) >= settings.stdResFlag && (!second || Math.abs(top.stdRes) >= 1.5 * Math.abs(second.stdRes));
    if (standout) {
      const alone = passesWithout([top]);
      notes.push({
        level: 'info',
        text: `One observation stands out: ${top.type.toLowerCase()} ${top.label}${where(top)} has a standardized residual of ${top.stdRes.toFixed(1)}, ${second ? `${(Math.abs(top.stdRes) / Math.abs(second.stdRes)).toFixed(1)} times the next largest` : 'the only one'}. A single blunder looks exactly like this, so check that line first for a typo, a wrong target or height, or a wrong station name.`
          + (alone ? (alone.passed ? ' Without it the rest of the data would pass the test.' : ` Even without it the error factor is ${alone.ef.toFixed(2)}, so the std errors are probably too small as well.`) : ''),
      });
    } else if (flagged.length === 0) {
      notes.push({ level: 'info', text: 'No observation is over the StdRes limit and none stands out, so this looks like std errors set too small for the whole job rather than one blunder.' });
    } else if (flagged.length <= rows.length / 4) {
      const alone = passesWithout(flagged);
      notes.push({
        level: 'info',
        text: `${flagged.length} observation${flagged.length > 1 ? 's are' : ' is'} over the StdRes limit of ${settings.stdResFlag}. `
          + (alone && alone.passed ? 'Without them the rest would pass, so look for blunders there first (the Residuals page lists them by file and line).'
            : `Even without them the error factor is ${alone ? alone.ef.toFixed(2) : 'still high'}, so check the worst ones on the Residuals page and also the std errors below.`),
      });
    } else {
      notes.push({ level: 'info', text: `${flagged.length} of ${rows.length} observations are over the StdRes limit and none stands far above the others: that is the pattern of std errors set too small for the whole job, not of one blunder.` });
    }
  }

  // Which class of observation fits worst?
  if (stats.classes && stats.classes.length > 1) {
    const ranked = stats.classes
      .filter((c) => c.count > 0)
      .map((c) => ({ ...c, ef: Math.sqrt(c.sumSq / c.count) }))
      .sort((a, b) => b.ef - a.ef);
    const list = ranked.map((c) => `${c.name} ${c.ef.toFixed(2)}`).join(', ');
    const target = high ? ranked[0] : ranked[ranked.length - 1];
    notes.push({
      level: 'info',
      text: `Error factor by type: ${list}. ${high ? 'Start with' : 'The most pessimistic is'} ${target.name.toLowerCase()}: check ${CLASS_SETTING[target.name] || 'its std errors'}. Scaling that std error by about ${Number(target.ef.toPrecision(2))} would bring that type to 1.0, but only do that if it is a fair description of your instrument and procedure.`,
    });
  } else if (out.kind === 'level' && settings.levelStdErr > 0) {
    notes.push({
      level: 'info',
      text: `Differential level std error is ${Number(settings.levelStdErr.toPrecision(4))} per unit of length now. A value near ${Number((settings.levelStdErr * ef).toPrecision(3))} would make the runs without their own std error fit (error factor 1.0). Check it matches your procedure before using it, and fix any flagged runs first.`,
    });
  }
  notes.push({ level: 'info', text: `Std devs in the results ${stats.errorFactorApplied !== 1 ? `HAVE been scaled by the error factor ${stats.errorFactorApplied.toFixed(3)}, the way STAR*NET does when the test fails.` : 'have not been scaled.'}` });
  return notes;
}
