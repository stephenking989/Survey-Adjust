// Leica GSI (GSI8 and GSI16) reader and converter to a STAR*NET-style .dat.
//
// FORMAT (Leica "GSI Online for Leica TPS" guide, Tab. 1 and the data format page; cross-checked against
// Total Open Station's GSI documentation and reader). A line is a row of blocks separated by one blank, ending in
// CR or CR/LF; the first block may carry a leading "*". Every block is
//
//    positions 1-2   word index (WI), e.g. 11 point number, 21 horizontal angle, 22 vertical angle
//    positions 3-5   information: 4 = automatic index, 5 = input mode (not used here)
//    position  6     UNIT of the value (code below)
//    position  7     sign, + or -
//    positions 8-15  data, 8 characters (GSI8)   |   positions 8-23  data, 16 characters (GSI16)
//
// The unit code gives the number of implied decimals:
//
//    0 metre (last digit 1 mm, 3 dec)      1 feet (1/1000 ft, 3 dec)        2 400 gon (5 dec)
//    3 360 degrees decimal (5 dec)         4 360 degrees sexagesimal DDD.MMSSs (5 dec)
//    5 6400 mil (4 dec)                    6 metre (1/10 mm, 4 dec)         7 feet (1/10000 ft, 4 dec)
//    8 metre (1/100 mm, 5 dec)
//
// Words used (TPS): 11 point id, 16 station id, 21 Hz angle, 22 vertical angle (a zenith angle unless the instrument
// is set to read elevation), 31 slope distance, 32 horizontal distance, 33 height difference, 41 code, 71-79 attributes,
// 81/82/83 target easting/northing/height, 84/85/86 station easting/northing/height, 87 reflector (target) height,
// 88 instrument height.
//
// WHAT IS NOT IN THE FORMAT: a GSI file does not say which pointing is a setup, a backsight or a repeat. Station lines
// (those with WI 84-86 or WI 16) start a setup; observation lines belong to the current station. A direction set is a
// run of pointings from one station in which no target repeats. Face 2 pointings (zenith over 180 degrees) are
// reduced to face 1 (zenith -> 360 - zenith, Hz -> Hz - 180), the standard reduction. Nothing here has been checked
// against a particular instrument's files beyond the examples in the guides, so the converter reports what it did.

const DEG_PER_GON = 0.9;
const DEG_PER_MIL = 360 / 6400;

const UNIT = {
  0: { kind: 'dist', per: 1e3, unit: 'm' }, 1: { kind: 'dist', per: 1e3, unit: 'ft' },
  6: { kind: 'dist', per: 1e4, unit: 'm' }, 7: { kind: 'dist', per: 1e4, unit: 'ft' }, 8: { kind: 'dist', per: 1e5, unit: 'm' },
  2: { kind: 'angle', per: 1e5, unit: 'gon' }, 3: { kind: 'angle', per: 1e5, unit: 'deg' }, 4: { kind: 'angle', per: 1e5, unit: 'dms' },
  5: { kind: 'angle', per: 1e4, unit: 'mil' },
};
const ANGLE_WORDS = new Set(['21', '22', '25']);
const DIST_WORDS = new Set(['31', '32', '33', '81', '82', '83', '84', '85', '86', '87', '88']);

export class GsiError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = 'GsiError';
    this.line = line;
  }
}

/** True when the text looks like a GSI file (first non-empty line is a run of well-formed blocks). */
export function looksLikeGsi(text) {
  const first = String(text).split(/\r\n|\n|\r/).find((l) => l.trim());
  return Boolean(first) && /^\*?\d{2}[.\d]{4}[+-][^\s]{8,16}(\s|$)/.test(first.trim());
}

/** Split one line into blocks { wi, info, unit, sign, data }. Throws GsiError on a malformed block. */
export function parseGsiLine(raw, lineNo) {
  const line = raw.replace(/^\*/, '').replace(/\s+$/, '');
  const tokens = line.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  // Block width comes from the first block: 7 information characters plus 8 or 16 data characters.
  const dataLen = tokens[0].replace(/^\*/, '').length - 7;
  if (dataLen !== 8 && dataLen !== 16) throw new GsiError(`the first block "${tokens[0]}" is not GSI8 (15 characters) or GSI16 (23)`, lineNo);
  const blocks = [];
  const step = 7 + dataLen + 1;
  for (let at = 0; at < line.length; at += step) {
    const b = line.slice(at, at + 7 + dataLen);
    if (b.length < 7 + dataLen) throw new GsiError(`block "${b}" is shorter than ${7 + dataLen} characters`, lineNo);
    if (!/^[\dA-Za-z]{2}[.\dA-Za-z]{4}[+-]/.test(b)) throw new GsiError(`"${b}" is not a GSI block (word index, information, sign, data)`, lineNo);
    blocks.push({ wi: b.slice(0, 2), info: b.slice(2, 6), unit: b[5], sign: b[6] === '-' ? -1 : 1, data: b.slice(7), raw: b });
  }
  return blocks;
}

/** Numeric value of a block in its own unit system: { value (metres/feet or degrees), kind, unit }. */
function numeric(b, lineNo) {
  const u = UNIT[b.unit];
  if (!u) throw new GsiError(`word ${b.wi} has unit code "${b.unit}", which is not one of the GSI unit codes 0-8`, lineNo);
  if (!/^\d+$/.test(b.data.replace(/^ +/, ''))) throw new GsiError(`word ${b.wi} data "${b.data}" is not a number`, lineNo);
  const n = Number(b.data) * b.sign;
  if (u.kind === 'dist') return { value: n / u.per, kind: 'dist', unit: u.unit };
  let deg;
  if (u.unit === 'gon') deg = (n / u.per) * DEG_PER_GON;
  else if (u.unit === 'deg') deg = n / u.per;
  else if (u.unit === 'mil') deg = (n / u.per) * DEG_PER_MIL;
  else {
    // DDD.MMSSs: five implied decimals hold minutes, seconds and tenths of a second.
    const a = Math.abs(n);
    const D = Math.floor(a / u.per);
    const rest = a - D * u.per;                     // MMSSs as an integer
    const M = Math.floor(rest / 1000); const S = (rest % 1000) / 10;
    if (M >= 60 || S >= 60) throw new GsiError(`word ${b.wi} "${b.data}" is not a valid sexagesimal angle`, lineNo);
    deg = Math.sign(n) * (D + M / 60 + S / 3600);
  }
  return { value: deg, kind: 'angle', unit: u.unit };
}

/** A point id: the data field without its zero padding ("0000A110" -> "A110"). */
function pointId(b) {
  const s = b.data.replace(/^[0 ]+/, '');
  return s === '' ? '0' : s.trim();
}

const norm360 = (d) => ((d % 360) + 360) % 360;

function dms(deg, decimals = 2) {
  let t = Math.round(norm360(deg) * 3600 * 10 ** decimals) / 10 ** decimals;
  if (t >= 360 * 3600) t -= 360 * 3600;
  const d = Math.floor(t / 3600); t -= d * 3600;
  const m = Math.floor(t / 60); const s = t - m * 60;
  return `${String(d).padStart(3, '0')}-${String(m).padStart(2, '0')}-${s.toFixed(decimals).padStart(decimals + 3, '0')}`;
}

/** Read every line into { line, words: Map(wi -> block), vals }. Records which unit systems appear. */
export function readGsi(text) {
  const rows = [];
  const units = { dist: new Set(), angle: new Set() };
  String(text).split(/\r\n|\n|\r/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const blocks = parseGsiLine(raw, i + 1);
    const words = new Map();
    for (const b of blocks) if (!words.has(b.wi)) words.set(b.wi, b);
    const num = {};
    for (const [wi, b] of words) {
      if (ANGLE_WORDS.has(wi) || DIST_WORDS.has(wi) || wi === '51') {
        if (wi === '51') continue;
        const v = numeric(b, i + 1);
        num[wi] = v.value;
        units[v.kind].add(v.unit);
      }
    }
    rows.push({ line: i + 1, words, num, id: words.has('11') ? pointId(words.get('11')) : null, station: words.has('16') ? pointId(words.get('16')) : null });
  });
  return { rows, units };
}

/**
 * Convert GSI text to a .dat.
 * opts: { name = 'job', coords = 'fixed' | 'free'  (coordinates given as 81-83 / 84-86 lines),
 *         station = id used when the file has no station line,
 *         vertical = 'zenith' | 'elevation'  (how WI 22 is to be read) }
 * Returns { text, summary, warnings } with warnings as { line, message }.
 */
export function gsiToDat(text, opts = {}) {
  const { rows, units } = readGsi(text);
  const warnings = [];
  const coordsMode = opts.coords === 'free' ? 'free' : 'fixed';
  const vertical = opts.vertical === 'elevation' ? 'elevation' : 'zenith';
  if (!rows.length) throw new GsiError('the file has no data lines');

  const distUnit = [...units.dist][0] || 'm';
  if (units.dist.size > 1) warnings.push({ line: null, message: `Mixed distance units (${[...units.dist].join(', ')}); the first (${distUnit}) is used for the whole file.` });

  // ---- Pass 1: stations, coordinates, observations ----------------------------------------------------
  const coords = new Map();         // id -> { n, e, z, fixed }
  const setCoord = (id, n, e, z, fixed, line) => {
    const old = coords.get(id);
    if (old) {
      const moved = Math.hypot(old.n - n, old.e - e);
      if (moved > 0.005) warnings.push({ line, message: `Station/point ${id} is given again with different coordinates (${moved.toFixed(3)} apart); the first values are kept.` });
      if (fixed && !old.fixed && old.approx) { Object.assign(old, { n, e, z, fixed, approx: false }); }
      return;
    }
    coords.set(id, { n, e, z, fixed, approx: !fixed });
  };

  let station = null; let hi = 0;
  const stationsSeen = new Set();
  const obs = [];                    // { line, at, to, hz, z, slope, hd, dh, hi, ht, face2 }
  let assumed = false;
  for (const r of rows) {
    const { num } = r;
    const hasStationWords = r.words.has('84') || r.words.has('85') || r.words.has('16') || (r.words.has('88') && !r.words.has('21'));
    const hasAngles = '21' in num || '22' in num;
    const hasDist = '31' in num || '32' in num || '33' in num;
    if (hasStationWords && !hasAngles) {
      const id = r.station || r.id;
      if (!id) { warnings.push({ line: r.line, message: 'A station line has no station id (word 16 or 11); it was skipped.' }); continue; }
      station = id; stationsSeen.add(id);
      hi = '88' in num ? num['88'] : 0;
      if ('84' in num && '85' in num) setCoord(id, num['85'], num['84'], '86' in num ? num['86'] : 0, coordsMode === 'fixed', r.line);
      continue;
    }
    if (!hasAngles && !hasDist) {
      // A coordinate line: point id with 81-83.
      if (r.id && '81' in num && '82' in num) setCoord(r.id, num['82'], num['81'], '83' in num ? num['83'] : 0, coordsMode === 'fixed', r.line);
      else if (!r.words.has('41') && !r.words.has('42')) warnings.push({ line: r.line, message: 'This line has no angles, distances or coordinates; it was ignored.' });
      continue;
    }
    // An observation line.
    if (!r.id) { warnings.push({ line: r.line, message: 'An observation line has no point id (word 11); it was skipped.' }); continue; }
    if (!station) {
      station = opts.station || 'STN';
      assumed = true; stationsSeen.add(station);
      warnings.push({ line: r.line, message: `No station line before the first observation; the observations are assumed to be from station ${station}. Rename it in the .dat if that is wrong.` });
    }
    let hz = '21' in num ? num['21'] : null;
    let z = '22' in num ? num['22'] : null;
    if (z !== null && vertical === 'elevation') z = 90 - z;
    let face2 = false;
    if (z !== null && z > 180) { face2 = true; z = 360 - z; if (hz !== null) hz = norm360(hz - 180); }
    obs.push({
      line: r.line, at: station, to: r.id, hz, z,
      slope: '31' in num ? num['31'] : null, hd: '32' in num ? num['32'] : null, dh: '33' in num ? num['33'] : null,
      hi: '88' in num ? num['88'] : hi, ht: '87' in num ? num['87'] : 0, face2,
    });
    // Coordinates computed by the instrument for the target are good starting values.
    if ('81' in num && '82' in num) setCoord(r.id, num['82'], num['81'], '83' in num ? num['83'] : 0, false, r.line);
  }
  if (!obs.length && !coords.size) throw new GsiError('the file has no observations or coordinates this converter understands');

  if (vertical === 'zenith') {
    const zs = obs.filter((o) => o.z !== null).map((o) => o.z).sort((a, b) => a - b);
    if (zs.length > 3 && zs[Math.floor(zs.length / 2)] < 50) {
      warnings.push({ line: null, message: 'Most vertical angles are below 50 degrees: if the instrument reads elevation angles (not zeniths), convert the file again with the vertical angle set to "elevation".' });
    }
  }

  // ---- Sort out slope / zenith for each observation -----------------------------------------------------
  let nFace2 = 0; let nDerived = 0; let nDropped = 0;
  for (const o of obs) {
    if (o.face2) nFace2++;
    if (o.slope === null && o.hd !== null) {
      if (o.dh !== null) { o.slope = Math.hypot(o.hd, o.dh); o.z = (Math.atan2(o.hd, o.dh) * 180) / Math.PI; nDerived++; }
      else if (o.z !== null && Math.sin((o.z * Math.PI) / 180) > 0.05) { o.slope = o.hd / Math.sin((o.z * Math.PI) / 180); nDerived++; }
    }
  }
  const is3D = obs.some((o) => o.z !== null && o.slope !== null) || [...coords.values()].some((c) => c.z !== 0);
  const hasZenith = obs.some((o) => o.z !== null);

  // ---- Write the .dat ----------------------------------------------------------------------------------------
  const out = [];
  const angleUnits = [...units.angle].join(', ') || 'none';
  out.push('# Imported from a Leica GSI file by Survey-Adjust.');
  out.push(`# Angles were in ${angleUnits}, distances in ${distUnit}. Face 2 pointings were reduced to face 1. Check the stations and heights before adjusting.`);
  out.push(distUnit === 'ft' ? '.UNITS Feet' : '.UNITS Meters');
  out.push('.UNITS DMS', '.ORDER NE', '.ORDER ATFROMTO');
  out.push(is3D && hasZenith ? '.3D' : '.2D');
  out.push('');
  const f = (v, d = 4) => v.toFixed(d);
  const c3 = is3D && hasZenith;
  for (const [id, c] of coords) {
    const flag = c.fixed ? '!' : '*';
    out.push(c3 ? `C ${id} ${f(c.n)} ${f(c.e)} ${f(c.z)} ${flag} ${flag} ${flag}` : `C ${id} ${f(c.n)} ${f(c.e)} ${flag} ${flag}`);
  }
  if (coords.size) out.push('');

  const hiHt = (o) => (o.hi || o.ht ? ` ${f(o.hi, 3)}/${f(o.ht, 3)}` : '');
  let openSet = null; let setAt = null; let setTargets = new Set();
  const closeSet = () => { if (openSet) { out.push('DE'); out.push(''); openSet = null; } };
  let nSets = 0; let nDM = 0; let nDN = 0; let nOther = 0;
  for (const o of obs) {
    if (o.hz === null) {
      closeSet();
      if (o.slope !== null && o.z !== null && c3) { out.push(`DV ${o.at}-${o.to} ${f(o.slope)} ${dms(o.z)}${hiHt(o)}`); nOther++; }
      else if (o.slope !== null || o.hd !== null) { out.push(`D ${o.at}-${o.to} ${f(c3 ? (o.slope ?? o.hd) : (o.hd ?? o.slope))}`); nOther++; }
      else if (o.z !== null && c3) { out.push(`V ${o.at}-${o.to} ${dms(o.z)}${hiHt(o)}`); nOther++; }
      else nDropped++;
      continue;
    }
    if (!openSet || setAt !== o.at || setTargets.has(o.to)) {
      closeSet();
      out.push(`DB ${o.at}`);
      openSet = true; setAt = o.at; setTargets = new Set(); nSets++;
    }
    setTargets.add(o.to);
    if (o.slope !== null && o.z !== null && c3) { out.push(`DM ${o.to} ${dms(o.hz)} ${f(o.slope)} ${dms(o.z)}${hiHt(o)}`); nDM++; }
    else if ((o.hd !== null || o.slope !== null) && !c3) { out.push(`DM ${o.to} ${dms(o.hz)} ${f(o.hd ?? o.slope)}`); nDM++; }
    else {
      out.push(`DN ${o.to} ${dms(o.hz)}`); nDN++;
      if (o.slope !== null || o.hd !== null) warnings.push({ line: o.line, message: `The distance to ${o.to} was not used: there is no zenith angle or height difference to turn it into a slope distance in a 3D job.` });
    }
  }
  closeSet();
  while (out.length && out[out.length - 1] === '') out.pop();

  if (nDerived) warnings.push({ line: null, message: `${nDerived} slope distance(s) were worked out from a horizontal distance with a zenith or height difference (no curvature or refraction).` });
  if (assumed) stationsSeen.add(station);
  const summary = {
    lines: rows.length, stations: [...stationsSeen], sets: nSets, directionsWithDistance: nDM, directionsOnly: nDN,
    otherShots: nOther, dropped: nDropped, face2: nFace2, coordinates: coords.size, dimension: c3 ? 3 : 2,
    distanceUnit: distUnit, angleUnits: [...units.angle],
  };
  return { text: out.join('\n') + '\n', summary, warnings };
}
