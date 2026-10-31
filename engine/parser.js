// STAR*NET-style .dat parser.
//
// Turns the text of a data file into a plain object:
//
//   {
//     options:  [ { name:'UNITS', args:['Meters'], line:5 }, ... ]   // every .OPTION, in file order
//     state:    { units, order, dimension, ... }                      // option state at end of file
//     records:  [ { type:'E'|'C'|'L'|..., line, ... }, ... ]          // data records, in file order
//     warnings: [ { line, message } ],
//   }
//
// Design for growth: each record code (E, C, L, and later DB/DM/DE/DV/M/B...)
// is handled by one function registered in RECORD_PARSERS. Adding a new record
// type next session means writing one function and adding one line to the
// table - the line splitter, comment handling, option handling, error
// reporting and line numbering do not change. Codes that have no parser yet
// are kept as { type:'unsupported', code, tokens } with a warning, so a file
// containing them still loads.

export class DatParseError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = 'DatParseError';
    this.line = line;
  }
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
export const isNumber = (s) => NUMBER_RE.test(s);

// ---------------------------------------------------------------------------
// Line level: strip comments / descriptions, split into tokens.
// ---------------------------------------------------------------------------

/**
 * '#' starts a comment (whole line or trailing). An apostrophe starts a
 * description that belongs to the record, e.g.  E N01 6000.0 ! 'BM N01'.
 * Returns { body, description }.
 */
function splitLine(raw) {
  let s = raw;
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  let description = '';
  const quote = s.search(/['"]/);
  if (quote >= 0) {
    description = s.slice(quote + 1).replace(/['"]\s*$/, '').trim();
    s = s.slice(0, quote);
  }
  return { body: s.trim(), description };
}

// ---------------------------------------------------------------------------
// Option (dot-command) handling.
// ---------------------------------------------------------------------------

/** Options that change how later records are read. All options are stored regardless. */
const onOff = (args, dflt) => (args.length ? /^(on|yes|true|1)$/i.test(args[0]) : dflt);

const OPTION_HANDLERS = {
  // Several .UNITS lines add up: ".UNITS Meters" then ".UNITS DMS".
  UNITS(state, args) { for (const a of args) if (!state.units.includes(a)) state.units.push(a); },
  // .ORDER carries two unrelated settings, told apart by their value:
  // coordinate order (NE / EN) and angle station order (ATFROMTO / FROMATTO).
  ORDER(state, args) {
    for (const a of args) {
      const w = a.toUpperCase();
      if (w === 'NE' || w === 'EN') state.order = w;
      else if (w === 'ATFROMTO' || w === 'FROMATTO') state.angleOrder = w;
    }
  },
  '2D'(state) { state.dimension = 2; },
  '3D'(state) { state.dimension = 3; },
  LEVEL(state, args) { state.level = { stdErr: Number(args[0]), mode: (args[1] || 'LENGTH').toUpperCase() }; },
  CURVE(state, args) { state.curve = onOff(args, true); },
  REF(state, args) { state.refraction = Number(args[0]); },
  DELTA(state, args) { state.delta = onOff(args, true); },
};

function initialState() {
  return {
    units: [], order: 'NE', angleOrder: 'ATFROMTO', dimension: 2, level: null,
    curve: true, refraction: null, delta: false,
    openSet: null, setCount: 0,    // direction-set bookkeeping (DB ... DE)
  };
}

// ---------------------------------------------------------------------------
// Record parsers. Each gets (tokens-after-the-code, ctx) and returns a record.
// ctx = { line, state, description, fail(msg) }
// ---------------------------------------------------------------------------

/**
 * A control tail is the part of an E/C record after the coordinate values:
 *   !         fixed
 *   *         free (an approximate value only)
 *   number    weighted - the number is the standard error
 *   (nothing) free
 * A flag may also be glued to the value ("6000.0!").
 */
function controlStatus(token) {
  if (token === '!') return { status: 'fixed', stdErr: null };
  if (token === '*' || token === undefined) return { status: 'free', stdErr: null };
  if (isNumber(token)) return { status: 'weighted', stdErr: Number(token) };
  return null;
}

/** Split "6000.0!" / "6000.0*" into value + flag tokens. */
function unglueFlags(tokens) {
  const out = [];
  for (const t of tokens) {
    const m = /^(.+?)([!*])$/.exec(t);
    if (m && isNumber(m[1])) out.push(m[1], m[2]);
    else out.push(t);
  }
  return out;
}

/** E name elevation [!|*|stdErr]   - a 1D control point (elevation only). */
function parseE(rawTokens, ctx) {
  const t = unglueFlags(rawTokens);
  if (t.length < 2 || !isNumber(t[1])) ctx.fail('E record needs: E name elevation [! | * | stdErr]');
  const ctl = t.length > 2 ? controlStatus(t[2]) : controlStatus(undefined);
  if (!ctl || t.length > 3) ctx.fail(`unexpected "${t.slice(2).join(' ')}" on E record`);
  return {
    type: 'E', name: t[0], elevation: Number(t[1]),
    status: ctl.status, stdErr: ctl.stdErr, description: ctx.description,
  };
}

/**
 * C name N E [Z] [tail...]   - a 2D/3D control point. Coordinates are read
 * in the order set by .ORDER (default NE); Z is read only when .3D is on.
 * The tail gives one status per coordinate, or a single status for all of them:
 *   C A 5000 5000 !              both fixed
 *   C A 5000 5000 ! *            N fixed, E free
 *   C A 5000 5000 0.01 0.02      weighted N, E
 * Parsed and stored now; used by the 2D/3D adjustment in a later session.
 */
function parseC(rawTokens, ctx) {
  const t = unglueFlags(rawTokens);
  const nCoords = ctx.state.dimension === 3 ? 3 : 2;
  if (t.length < 1 + nCoords) ctx.fail(`C record needs a name and ${nCoords} coordinates`);
  const name = t[0];
  const vals = t.slice(1, 1 + nCoords);
  if (!vals.every(isNumber)) ctx.fail('C record coordinates must be numbers');
  const tail = t.slice(1 + nCoords);
  const comps = ctx.state.order === 'EN' ? ['east', 'north'] : ['north', 'east'];
  if (nCoords === 3) comps.push('elevation');
  const rec = { type: 'C', name, status: {}, stdErr: {}, description: ctx.description };
  comps.forEach((c, i) => { rec[c] = Number(vals[i]); });
  const perComp = tail.length === 0 ? [undefined] : tail;
  if (perComp.length !== 1 && perComp.length !== comps.length) ctx.fail('C record tail must be one value or one per coordinate');
  comps.forEach((c, i) => {
    const ctl = controlStatus(perComp.length === 1 ? perComp[0] : perComp[i]);
    if (!ctl) ctx.fail(`unexpected "${tail.join(' ')}" on C record`);
    rec.status[c] = ctl.status;
    rec.stdErr[c] = ctl.stdErr;
  });
  return rec;
}

/**
 * L from-to dElev length [stdErr]    or    L from to dElev length [stdErr]
 * Differential level: dElev = Elev(to) - Elev(from) over a line of the given
 * length, in project units. A trailing std error overrides the .LEVEL default.
 * The hyphen form splits at the FIRST hyphen (use the spaced form when
 * station names themselves contain hyphens - same rule as STAR*NET).
 */
function parseL(t, ctx) {
  let from; let to; let rest;
  if (t.length >= 3 && !isNumber(t[1])) {
    [from, to] = t; rest = t.slice(2);
  } else if (t.length >= 1 && t[0].includes('-')) {
    const h = t[0].indexOf('-');
    from = t[0].slice(0, h); to = t[0].slice(h + 1); rest = t.slice(1);
    if (!from || !to) ctx.fail(`cannot split "${t[0]}" into from-to`);
    if (t[0].split('-').length > 2) ctx.warn(`"${t[0]}" has several hyphens; read as ${from} to ${to}`);
  } else {
    ctx.fail('L record needs: L from-to dElev length [stdErr]');
  }
  if (rest.length < 2 || rest.length > 3 || !rest.every(isNumber)) {
    ctx.fail('L record needs numeric dElev, length and an optional std error');
  }
  const [dElev, length, stdErr] = rest.map(Number);
  return {
    type: 'L', from, to, dElev, length,
    stdErr: stdErr === undefined ? null : stdErr, description: ctx.description,
    // Snapshot of the .LEVEL option in force on this line (it can change mid-file).
    levelOption: ctx.state.level ? { ...ctx.state.level } : null,
  };
}

// ---------------------------------------------------------------------------
// Angles, station lists and the common observation tail (2D / 3D records).
// ---------------------------------------------------------------------------

/**
 * Angle token -> decimal degrees. Accepts "087-14-00.3" (D-M-S), a quadrant
 * bearing is handled by parseBearing. A bare number is packed DDD.MMSSss under
 * .UNITS DMS (the default) and plain decimal degrees under .UNITS DD.
 */
export function parseAngle(token, units = []) {
  const t = String(token);
  const sign = t.startsWith('-') ? -1 : 1;
  const body = t.replace(/^[+-]/, '');
  let deg;
  if (body.includes('-')) {
    const parts = body.split('-');
    if (parts.length > 3 || !parts.every((p) => p !== '' && isNumber(p))) return NaN;
    const [d, m = 0, s = 0] = parts.map(Number);
    if (m >= 60 || s >= 60) return NaN;
    deg = d + m / 60 + s / 3600;
  } else if (!isNumber(body)) {
    return NaN;
  } else if (units.some((u) => /^dd$/i.test(u))) {
    deg = Number(body);
  } else {
    const [whole, frac = ''] = body.split('.');
    const mm = Number((frac.slice(0, 2) || '0').padEnd(2, '0'));
    const ss = Number(`${(frac.slice(2, 4) || '0').padEnd(2, '0')}.${frac.slice(4) || '0'}`);
    if (mm >= 60 || ss >= 60) return NaN;
    deg = Number(whole) + mm / 60 + ss / 3600;
  }
  return sign * deg;
}

/** Bearing token -> azimuth in degrees: "N45-30-00E", "S10-00-00W" or a plain azimuth. */
export function parseBearing(token, units = []) {
  const q = /^([NSns])(.+?)([EWew])$/.exec(token);
  if (!q) return parseAngle(token, units);
  const a = parseAngle(q[2], units);
  const ns = q[1].toUpperCase(); const ew = q[3].toUpperCase();
  if (ns === 'N') return ew === 'E' ? a : 360 - a;
  return ew === 'E' ? 180 - a : 180 + a;
}

/**
 * Take `n` station names off the front of the tokens. Either one hyphenated
 * token ("6002-6000-6007") or n separate tokens. Returns { names, rest }.
 */
function takeStations(tokens, n, ctx, what) {
  if (tokens.length && n > 1 && tokens[0].split('-').length === n && tokens[0].split('-').every(Boolean)) {
    return { names: tokens[0].split('-'), rest: tokens.slice(1) };
  }
  if (tokens.length < n) ctx.fail(`${what} needs ${n} station name${n > 1 ? 's' : ''}`);
  return { names: tokens.slice(0, n), rest: tokens.slice(n) };
}

/** Put at/from/to names in the right slots for the .ORDER ATFROMTO | FROMATTO setting. */
function atFromTo(names, ctx) {
  return ctx.state.angleOrder === 'FROMATTO'
    ? { at: names[1], from: names[0], to: names[2] }
    : { at: names[0], from: names[1], to: names[2] };
}

/**
 * Observation tail: the part after the required values.
 *   HI/HT       instrument and target heights ("1.483/0.030")
 *   number      a std error, in the order the record lists its quantities
 *   !           that quantity is fixed (held exactly)
 *   *           that quantity uses the project default
 * Returns { hi, ht, errs } with errs = [number | 'fixed' | null, ...].
 */
function parseTail(tokens, ctx) {
  const out = { hi: null, ht: null, errs: [] };
  for (const t of tokens) {
    const hh = /^([+-]?(?:\d+\.?\d*|\.\d+))\/([+-]?(?:\d+\.?\d*|\.\d+))$/.exec(t);
    if (hh) { out.hi = Number(hh[1]); out.ht = Number(hh[2]); }
    else if (t === '!') out.errs.push('fixed');
    else if (t === '*') out.errs.push(null);
    else if (isNumber(t)) out.errs.push(Number(t));
    else ctx.fail(`unexpected "${t}"`);
  }
  return out;
}

const errsAs = (errs, names) => Object.fromEntries(names.map((n, i) => [n, errs[i] === undefined ? null : errs[i]]));
const need = (t, k, ctx, usage) => { if (t.length < k) ctx.fail(`needs: ${usage}`); };
const num = (s, ctx, what) => { if (!isNumber(s)) ctx.fail(`${what} must be a number, got "${s}"`); return Number(s); };
const ang = (s, ctx, what) => {
  const v = parseAngle(s, ctx.state.units);
  if (Number.isNaN(v)) ctx.fail(`${what} "${s}" is not a valid angle`);
  return v;
};

/** A at-from-to angle [stdErr] */
function parseA(t, ctx) {
  const { names, rest } = takeStations(t, 3, ctx, 'A record');
  need(rest, 1, ctx, 'A at-from-to angle [stdErr]');
  const tail = parseTail(rest.slice(1), ctx);
  return { type: 'A', ...atFromTo(names, ctx), angle: ang(rest[0], ctx, 'angle'), stdErr: errsAs(tail.errs, ['angle']), description: ctx.description };
}

/** B from-to bearing|azimuth [stdErr | !] */
function parseB(t, ctx) {
  const { names, rest } = takeStations(t, 2, ctx, 'B record');
  need(rest, 1, ctx, 'B from-to bearing [stdErr]');
  const az = parseBearing(rest[0], ctx.state.units);
  if (Number.isNaN(az)) ctx.fail(`bearing "${rest[0]}" is not valid`);
  const tail = parseTail(rest.slice(1), ctx);
  return { type: 'B', from: names[0], to: names[1], azimuth: az, stdErr: errsAs(tail.errs, ['azimuth']), description: ctx.description };
}

/** D from-to distance [stdErr] [HI/HT]    (slope distance in 3D) */
function parseD(t, ctx) {
  const { names, rest } = takeStations(t, 2, ctx, 'D record');
  need(rest, 1, ctx, 'D from-to distance [stdErr] [HI/HT]');
  const tail = parseTail(rest.slice(1), ctx);
  return { type: 'D', from: names[0], to: names[1], distance: num(rest[0], ctx, 'distance'), hi: tail.hi, ht: tail.ht, stdErr: errsAs(tail.errs, ['distance']), description: ctx.description };
}

/** V from-to zenith [stdErr] [HI/HT] */
function parseV(t, ctx) {
  const { names, rest } = takeStations(t, 2, ctx, 'V record');
  need(rest, 1, ctx, 'V from-to zenith [stdErr] [HI/HT]');
  const tail = parseTail(rest.slice(1), ctx);
  return { type: 'V', from: names[0], to: names[1], zenith: ang(rest[0], ctx, 'zenith'), hi: tail.hi, ht: tail.ht, stdErr: errsAs(tail.errs, ['zenith']), description: ctx.description };
}

/** M at-from-to angle distance [zenith] [stdErrs] [HI/HT]   - angle + distance (+ zenith) in one line */
function parseM(t, ctx) {
  const { names, rest } = takeStations(t, 3, ctx, 'M record');
  need(rest, 2, ctx, 'M at-from-to angle distance [zenith] [HI/HT]');
  const angle = ang(rest[0], ctx, 'angle');
  const distance = num(rest[1], ctx, 'distance');
  let tailTokens = rest.slice(2);
  let zenith = null;
  if (tailTokens.length && !/\/|^[!*]$/.test(tailTokens[0]) && !Number.isNaN(parseAngle(tailTokens[0], ctx.state.units)) && /-/.test(tailTokens[0])) {
    zenith = ang(tailTokens[0], ctx, 'zenith');
    tailTokens = tailTokens.slice(1);
  }
  const tail = parseTail(tailTokens, ctx);
  return {
    type: 'M', ...atFromTo(names, ctx), angle, distance, zenith, hi: tail.hi, ht: tail.ht,
    stdErr: errsAs(tail.errs, zenith === null ? ['angle', 'distance'] : ['angle', 'distance', 'zenith']), description: ctx.description,
  };
}

// ---- Direction sets: DB at ... DE -----------------------------------------
// A set is one round of pointings from one instrument station. Each set has its
// own unknown circle orientation in the adjustment, so every record inside a
// set carries the set number. DB opens, DE closes.

/** DB at-station */
function parseDB(t, ctx) {
  if (ctx.state.openSet) ctx.fail(`DB inside an open direction set (opened on line ${ctx.state.openSet.line}; missing DE)`);
  need(t, 1, ctx, 'DB at-station');
  const set = { id: ++ctx.state.setCount, at: t[0], line: ctx.line };
  ctx.state.openSet = set;
  return { type: 'DB', set: set.id, at: set.at, description: ctx.description };
}

function inSet(ctx, code) {
  if (!ctx.state.openSet) ctx.fail(`${code} outside a direction set (no DB before it)`);
  return ctx.state.openSet;
}

/** DE - ends the set */
function parseDE(t, ctx) {
  const set = inSet(ctx, 'DE');
  ctx.state.openSet = null;
  return { type: 'DE', set: set.id };
}

/** DN to direction [stdErr]     direction only */
function parseDN(t, ctx) {
  const set = inSet(ctx, 'DN');
  need(t, 2, ctx, 'DN to direction [stdErr]');
  const tail = parseTail(t.slice(2), ctx);
  return { type: 'DN', set: set.id, at: set.at, to: t[0], direction: ang(t[1], ctx, 'direction'), stdErr: errsAs(tail.errs, ['direction']), description: ctx.description };
}

/** DM to direction distance zenith [stdErrs] [HI/HT]    direction + slope distance + zenith */
function parseDM(t, ctx) {
  const set = inSet(ctx, 'DM');
  need(t, 4, ctx, 'DM to direction distance zenith [HI/HT]');
  const tail = parseTail(t.slice(4), ctx);
  return {
    type: 'DM', set: set.id, at: set.at, to: t[0],
    direction: ang(t[1], ctx, 'direction'), distance: num(t[2], ctx, 'distance'), zenith: ang(t[3], ctx, 'zenith'),
    hi: tail.hi, ht: tail.ht, stdErr: errsAs(tail.errs, ['direction', 'distance', 'zenith']), description: ctx.description,
  };
}

/** DV to distance zenith [HI/HT]    (inside a set) or  DV from-to distance zenith [HI/HT] (outside) */
function parseDV(t, ctx) {
  const set = ctx.state.openSet;
  let from; let to; let rest;
  if (set) { from = set.at; to = t[0]; rest = t.slice(1); } else {
    const s = takeStations(t, 2, ctx, 'DV record');
    [from, to] = s.names; rest = s.rest;
  }
  need(rest, 2, ctx, set ? 'DV to distance zenith [HI/HT]' : 'DV from-to distance zenith [HI/HT]');
  const tail = parseTail(rest.slice(2), ctx);
  return {
    type: 'DV', set: set ? set.id : null, from, to, distance: num(rest[0], ctx, 'distance'), zenith: ang(rest[1], ctx, 'zenith'),
    hi: tail.hi, ht: tail.ht, stdErr: errsAs(tail.errs, ['distance', 'zenith']), description: ctx.description,
  };
}

/** Register new record types here. */
export const RECORD_PARSERS = {
  E: parseE,
  C: parseC,
  L: parseL,
  A: parseA,
  B: parseB,
  D: parseD,
  V: parseV,
  M: parseM,
  DB: parseDB,
  DE: parseDE,
  DN: parseDN,
  DM: parseDM,
  DV: parseDV,
};

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * @param {string} text   contents of the .dat file (LF or CRLF)
 * @param {object} [opts] { fileIndex: 1 }   file number used in File:Line labels
 */
export function parseDat(text, opts = {}) {
  const fileIndex = opts.fileIndex || 1;
  const state = initialState();
  const options = [];
  const records = [];
  const warnings = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/);

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const { body, description } = splitLine(lines[i]);
    if (!body) continue;
    const tokens = body.split(/\s+/);
    const head = tokens[0];

    if (head.startsWith('.')) {
      const name = head.slice(1).toUpperCase();
      if (name === 'END') break;
      const args = tokens.slice(1);
      options.push({ name, args, line });
      if (OPTION_HANDLERS[name]) OPTION_HANDLERS[name](state, args);
      continue;
    }

    const code = head.toUpperCase();
    const ctx = {
      line, state, description,
      fail(message) { throw new DatParseError(message, line); },
      warn(message) { warnings.push({ line, message }); },
    };
    const parser = RECORD_PARSERS[code];
    if (!parser) {
      warnings.push({ line, message: `Record type "${code}" is not supported yet and was ignored` });
      records.push({ type: 'unsupported', code, tokens: tokens.slice(1), line, file: fileIndex });
      continue;
    }
    const rec = parser(tokens.slice(1), ctx);
    rec.line = line;
    rec.file = fileIndex;
    records.push(rec);
  }
  if (state.openSet) {
    warnings.push({ line: state.openSet.line, message: `Direction set ${state.openSet.id} at ${state.openSet.at} was never closed with DE` });
  }
  return { options, state, records, warnings };
}
