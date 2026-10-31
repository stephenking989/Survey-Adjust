// Carlson SurvCE raw data (.rw5) reader and converter to a STAR*NET-style 2D .dat.
//
// FORMAT (Carlson "SurvCE Raw Data File Format (*.rw5) Version 3.03"). A comma separated text file, one record per
// line: a record type, then fields, each a two-character header followed by its value ("OP1", "AR90.3333"). The
// coordinate headers are "N " and "E " (letter and a blank). A field starting "--" is a note.
//
//    MO,AD0,UN0,SF1.0,EC1,EO0.0,AU0      mode: azimuth direction (0 north, 1 south), units (0 feet, 1 metre), scale factor
//    LS,HI5.0,HR6.0                      instrument and rod heights
//    SP,PN100,N 5002.0,E 5000.0,EL100.0  stored point (coordinates)
//    OC,OP1,N 5000.0,E 5000.0,EL100.0    occupy
//    BK,OP1,BP2,BS315.0000,BC0.0044      backsight: from occupied OP to back point BP (BS = its azimuth when known)
//    TR/SS/BD/BR/FD/FR,OP1,FP4, angle, vertical, distance, note
//        angle     AZ azimuth | BR bearing (N123.4500W) | AR angle right | AL angle left | DR / DL deflection right / left
//        vertical  ZE zenith | VA vertical (elevation) angle | CE change in elevation
//        distance  SD slope distance | HD horizontal distance
// Angles are written DDD.MMSSss (degrees, minutes, seconds run together).
//
// A TR record is a traverse shot: the occupied point moves to FP, and the back point becomes the old OP. An SS is a sideshot:
// the occupied point and back point stay. Angles are measured from the back point (angle right = clockwise).
//
// What this reader does NOT take from the specification, and does by a rule of its own (each is reported):
//   * CL and AB records appear in files made for Carlson's traverse routines but are not in the specification. CL is
//     read as a traverse shot, AB as a sideshot (an angle and distance at the closing point to the first leg).
//   * A closing shot is given a new point name by the data collector. The last traverse shot, any CL, and an AB are
//     renamed to a known or earlier computed point when they land within a tolerance of it (default 0.5 units).
//   * Slope distances are reduced to horizontal with the zenith (or vertical angle). Elevations are not used, so the
//     result is a 2D job.

import { parseAngle, parseBearing } from './parser.js';

export class Rw5Error extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = 'Rw5Error';
    this.line = line;
  }
}

const RECORDS = new Set(['JB', 'MO', 'LS', 'SP', 'OC', 'BK', 'TR', 'SS', 'BD', 'BR', 'FD', 'FR', 'OF', 'CL', 'AB', 'BP', 'GPS', 'G0', 'G1', 'G2', 'G3', 'G4']);

/** True when the text looks like an RW5 file: its first records are known record types followed by comma fields. */
export function looksLikeRw5(text) {
  const lines = String(text).split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 6);
  if (!lines.length) return false;
  return lines.filter((l) => /^[A-Z0-9]{2,3},/.test(l.trim()) && RECORDS.has(l.trim().split(',')[0])).length >= Math.min(2, lines.length);
}

/** One line -> { type, f: { OP: '1', AR: '90.3333', ... }, note }. */
export function parseRw5Line(raw, lineNo) {
  const line = raw.replace(/[\r\n]+$/, '');
  const parts = line.split(',');
  const type = parts[0].trim();
  if (!/^[A-Z0-9]{1,3}$/.test(type)) throw new Rw5Error(`"${type}" is not an RW5 record type`, lineNo);
  const f = {};
  let note = '';
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('--')) { note = parts.slice(i).join(',').slice(2); break; }
    const code = p.slice(0, 2).trim();
    if (code) f[code] = p.slice(2).trim();
  }
  return { type, f, note, line: lineNo };
}

const DEG = Math.PI / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;
const num = (s) => (s === undefined || s === '' ? null : Number(s));

function dms(deg, decimals = 2) {
  let t = Math.round(norm360(deg) * 3600 * 10 ** decimals) / 10 ** decimals;
  if (t >= 360 * 3600) t -= 360 * 3600;
  const d = Math.floor(t / 3600); t -= d * 3600;
  const m = Math.floor(t / 60); const s = t - m * 60;
  return `${String(d).padStart(3, '0')}-${String(m).padStart(2, '0')}-${s.toFixed(decimals).padStart(decimals + 3, '0')}`;
}

/**
 * Convert RW5 text to a .dat.
 * opts: { prefix, closeTolerance (default 0.5, in the file's units) }
 * Returns { text, summary, warnings } (warnings as { line, message }).
 */
export function rw5ToDat(text, opts = {}) {
  const px = String(opts.prefix || '');
  const id = (s) => (s === undefined || s === null || s === '' ? null : px + s);
  const tol = Number.isFinite(opts.closeTolerance) ? opts.closeTolerance : 0.5;
  const warnings = [];
  const warn = (line, message) => warnings.push({ line, message });
  const recs = [];
  String(text).split(/\r\n|\n|\r/).forEach((raw, i) => { if (raw.trim()) recs.push(parseRw5Line(raw, i + 1)); });
  if (!recs.length) throw new Rw5Error('the file has no records');

  let azDir = 0; let feet = false; let scale = 1;
  const known = new Map();                     // coordinates given in the file: name -> { n, e }
  const pos = new Map();                       // known plus computed positions
  const alias = new Map();                     // data collector name -> name it was renamed to
  const stations = new Set();
  let occ = null; let bs = null;
  let nTr = 0; let nSs = 0; let nBearing = 0; let nSkipped = 0; let nReduced = 0; let nRenamed = 0; let lastTrIndex = -1;

  const resolve = (s) => { const a = id(s); return alias.get(a) || a; };

  // Coordinates and mode first, in file order.
  for (const r of recs) {
    if (r.type === 'MO') {
      azDir = Number(r.f.AD || 0); feet = r.f.UN === '0'; scale = Number(r.f.SF || 1) || 1;
      if (Math.abs(scale - 1) > 1e-9) warn(r.line, `The scale factor is ${r.f.SF}, not 1. It was not applied to the distances.`);
    } else if ((r.type === 'SP' || r.type === 'OC') && (r.f.N !== undefined) && (r.f.E !== undefined)) {
      const name = id(r.f.PN ?? r.f.OP);
      const n = num(r.f.N); const e = num(r.f.E);
      if (name && n !== null && e !== null) {
        const old = known.get(name);
        if (old && Math.hypot(old.n - n, old.e - e) > 0.001) warn(r.line, `Point ${name} is given again with different coordinates; the first is kept.`);
        else if (!old) { known.set(name, { n, e }); pos.set(name, { n, e }); }
      }
    }
  }

  const azTo = (a, b) => (Math.atan2(pos.get(b).e - pos.get(a).e, pos.get(b).n - pos.get(a).n) / DEG + 360) % 360;
  const nearest = (n, e, exclude) => {
    let best = null;
    for (const [name, p] of pos) {
      if (exclude.includes(name)) continue;
      const d = Math.hypot(p.n - n, p.e - e);
      // A point given in the file (control) is preferred to one computed from the shots, whatever the distances.
      const rank = known.has(name) ? 0 : 1;
      if (d <= tol && (!best || rank < best.rank || (rank === best.rank && d < best.d))) best = { name, d, rank };
    }
    return best;
  };

  // Everything in the traverse, in order.
  const obs = [];     // { kind: 'M'|'B', ..., line, type }
  for (const r of recs) {
    const t = r.type;
    if (t === 'LS' || t === 'JB' || t === 'MO' || t === 'SP' || t === 'GPS' || t === 'BP' || /^G[0-4]$/.test(t)) continue;
    if (t === 'OC') { occ = resolve(r.f.OP); stations.add(occ); continue; }
    if (t === 'BK') {
      occ = resolve(r.f.OP); bs = resolve(r.f.BP);
      if (!bs && r.f.BS) warn(r.line, 'The backsight is given as an azimuth with no back point; angles from it cannot be used and were skipped.');
      continue;
    }
    if (t === 'OF') { warn(r.line, 'An off-centre shot (OF) was ignored.'); nSkipped++; continue; }
    if (['BD', 'BR', 'FD', 'FR'].includes(t)) { warn(r.line, `Angle-set record ${t} is not supported and was skipped.`); nSkipped++; continue; }
    if (!['TR', 'SS', 'CL', 'AB'].includes(t)) { warn(r.line, `Record type ${t} is not used and was skipped.`); nSkipped++; continue; }

    // ---- A shot: TR, CL (a traverse shot), SS or AB (a sideshot) -----------------------------------------------
    let at = resolve(r.f.OP);
    const fpRaw = id(r.f.FP);
    if (!at || !fpRaw) { warn(r.line, `${t} record without an occupied or foresight point was skipped.`); nSkipped++; continue; }
    occ = at;                                   // the collector occupies the point named on the record
    // Horizontal distance.
    let hd = null;
    if (r.f.HD !== undefined) hd = num(r.f.HD);
    else if (r.f.SD !== undefined) {
      const sd = num(r.f.SD);
      if (r.f.ZE !== undefined) { hd = sd * Math.sin(parseAngle(r.f.ZE, ['DMS']) * DEG); nReduced++; }
      else if (r.f.VA !== undefined) { hd = sd * Math.cos(parseAngle(r.f.VA, ['DMS']) * DEG); nReduced++; }
      else hd = sd;
    }
    if (hd === null || !(hd > 0)) { warn(r.line, `${t} to ${fpRaw} has no distance; it was skipped.`); nSkipped++; continue; }

    const isTraverse = t === 'TR' || t === 'CL';
    if (r.f.BR !== undefined || r.f.AZ !== undefined) {
      // A direction given outright (a bearing or an azimuth): a fixed azimuth plus the distance.
      let az = r.f.BR !== undefined ? parseBearing(r.f.BR, ['DMS']) : parseAngle(r.f.AZ, ['DMS']);
      if (Number.isNaN(az)) { warn(r.line, `The direction "${r.f.BR ?? r.f.AZ}" is not valid; the shot was skipped.`); nSkipped++; continue; }
      if (azDir === 1) az = norm360(az + 180);
      obs.push({ kind: 'B', at, to: fpRaw, az, hd, line: r.line, type: t, traverse: isTraverse });
      nBearing++;
      if (pos.has(at)) pos.set(fpRaw, { n: pos.get(at).n + hd * Math.cos(az * DEG), e: pos.get(at).e + hd * Math.sin(az * DEG) });
    } else {
      // An angle from the back point.
      if (!bs) { warn(r.line, `${t} from ${at} to ${fpRaw} is an angle with no back point (no BK record, and no earlier traverse shot); it was skipped.`); nSkipped++; continue; }
      if (bs === at) { warn(r.line, `${t} at ${at} is measured from the back point ${bs}, which is the point itself (the shot is out of order: a sideshot must come while its point is still occupied); it was skipped.`); nSkipped++; continue; }
      let ar;
      if (r.f.AR !== undefined) ar = parseAngle(r.f.AR, ['DMS']);
      else if (r.f.AL !== undefined) ar = 360 - parseAngle(r.f.AL, ['DMS']);
      else if (r.f.DR !== undefined) ar = 180 + parseAngle(r.f.DR, ['DMS']);
      else if (r.f.DL !== undefined) ar = 180 - parseAngle(r.f.DL, ['DMS']);
      else { warn(r.line, `${t} to ${fpRaw} has no angle; it was skipped.`); nSkipped++; continue; }
      if (Number.isNaN(ar)) { warn(r.line, `An angle on the ${t} to ${fpRaw} is not valid; the shot was skipped.`); nSkipped++; continue; }
      ar = norm360(ar);
      if (pos.has(at) && pos.has(bs)) {
        const az = (azTo(at, bs) + ar) % 360;
        pos.set(fpRaw, { n: pos.get(at).n + hd * Math.cos(az * DEG), e: pos.get(at).e + hd * Math.sin(az * DEG) });
      }
      obs.push({ kind: 'M', at, from: bs, to: fpRaw, ar, hd, line: r.line, type: t, traverse: isTraverse, ab: t === 'AB' });
    }
    if (isTraverse) { nTr++; lastTrIndex = obs.length - 1; bs = at; occ = fpRaw; } else nSs++;
    stations.add(at); stations.add(fpRaw);
  }
  if (!obs.length) throw new Rw5Error('the file has no traverse or sideshot records this converter understands');

  // ---- A closing shot lands on a point that already exists: give it that point's name -----------------------------
  const lastTr = lastTrIndex >= 0 ? obs[lastTrIndex] : null;
  const candidates = [];
  if (lastTr) candidates.push(lastTr);
  for (const o of obs) if ((o.type === 'CL' || o.ab) && !candidates.includes(o)) candidates.push(o);
  const rename = (o, side) => {
    const orig = o[side];
    if (known.has(orig)) return;
    const p = pos.get(orig);
    if (!p) return;
    const hit = nearest(p.n, p.e, [orig, o.at, o.from].filter(Boolean));
    if (hit) {
      warn(o.line, `${o.type} ${side === 'to' ? 'to' : 'at'} ${orig} lands ${hit.d.toFixed(3)} from ${hit.name}, so it was renamed ${hit.name} (the closing shot of a traverse is a new point name for the point it closes on).`);
      alias.set(orig, hit.name); nRenamed++;
      for (const x of obs) for (const k of ['at', 'from', 'to']) if (x[k] === orig) x[k] = hit.name;
      pos.delete(orig);
    }
  };
  // Closing legs first, then the angle shots at the renamed point.
  for (const o of candidates.filter((x) => !x.ab)) rename(o, 'to');
  for (const o of candidates.filter((x) => x.ab)) rename(o, 'to');

  // ---- Write the .dat ----------------------------------------------------------------------------------------------
  const lines2 = [];
  lines2.push('# Imported from a Carlson SurvCE raw data (.rw5) file by Survey-Adjust.');
  lines2.push(`# Slope distances were reduced to horizontal with the zenith or vertical angle; heights are not used. Angles are angle right from the back point.`);
  lines2.push(feet ? '.UNITS Feet' : '.UNITS Meters', '.UNITS DMS', '.ORDER NE', '.ORDER ATFROMTO', '.2D', '');
  const f4 = (v) => v.toFixed(4);
  for (const [name, c] of known) lines2.push(`C ${name} ${f4(c.n)} ${f4(c.e)} ! !`);
  if (known.size) lines2.push('');
  let group = null;
  for (const o of obs) {
    const label = o.traverse ? 'traverse' : 'sideshots';
    if (label !== group) { if (group) lines2.push(''); lines2.push(`# ${label}`); group = label; }
    const pair = (a, b) => ((a.includes('-') || b.includes('-')) ? `${a} ${b}` : `${a}-${b}`);
    if (o.kind === 'B') {
      lines2.push(`B ${pair(o.at, o.to)} ${dms(o.az)} !`);
      lines2.push(`D ${pair(o.at, o.to)} ${o.hd.toFixed(3)}`);
    } else {
      const trip = (o.at.includes('-') || o.from.includes('-') || o.to.includes('-')) ? `${o.at} ${o.from} ${o.to}` : `${o.at}-${o.from}-${o.to}`;
      lines2.push(`M ${trip} ${dms(o.ar)} ${o.hd.toFixed(3)}`);
    }
  }
  const unitsNote = feet ? 'ft' : 'm';
  if (!known.size) warn(null, 'The file has no stored or occupied point with coordinates. Add a C record with fixed coordinates for the start before adjusting.');
  if (nReduced) warn(null, `${nReduced} slope distance${nReduced === 1 ? '' : 's'} were reduced to horizontal (no curvature or refraction); the zenith angles are not adjusted.`);
  return {
    text: lines2.join('\n') + '\n',
    warnings,
    summary: {
      kind: 'rw5', dimension: 2, lines: recs.length, stations: [...new Set(obs.flatMap((o) => [o.at, o.from, o.to].filter(Boolean)))],
      traverseShots: nTr, sideshots: nSs, bearingLegs: nBearing, skipped: nSkipped, renamed: nRenamed, controlPoints: known.size, distanceUnit: unitsNote,
    },
  };
}
