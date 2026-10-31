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
const OPTION_HANDLERS = {
  UNITS(state, args) { state.units = args; },
  ORDER(state, args) { state.order = (args[0] || 'NE').toUpperCase(); },
  '2D'(state) { state.dimension = 2; },
  '3D'(state) { state.dimension = 3; },
  LEVEL(state, args) { state.level = { stdErr: Number(args[0]), mode: (args[1] || 'LENGTH').toUpperCase() }; },
};

function initialState() {
  return { units: [], order: 'NE', dimension: 2, level: null };
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

/** Register new record types here. */
export const RECORD_PARSERS = {
  E: parseE,
  C: parseC,
  L: parseL,
  // Next session: DB, DM, DE, DV, M, B ...
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
  return { options, state, records, warnings };
}
