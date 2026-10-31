// Several data files, one adjustment.
//
// STAR*NET reads the checked files of a project in list order (manual, ch. 5.2: "Each file in
// the list has a check box. When checked, the file will be read ... when unchecked, it will not")
// and inline options never leak from one file into the next (manual, ch. 5.8: options that
// affect data "are reset to the project defaults for the next file"). parseDat() already starts
// every call with fresh option state, so reading the files one by one and joining the records
// reproduces both rules.
//
// A file is { name, text, include }; include defaults to true.

import { parseDat, DatParseError } from './parser.js';
import { linearUnitsFromDat } from './project.js';

/** A syntax error tied to one file and line, so the editor can jump straight to it. */
export class DataFileError extends Error {
  constructor(message, file, fileName, line) {
    super(`${fileName}, line ${line}: ${message}`);
    this.name = 'DataFileError';
    this.file = file;            // 1-based position among the files that were read
    this.fileName = fileName;
    this.line = line;
    this.detail = message;
  }
}

const included = (files) => files.filter((f) => f.include !== false);

/**
 * Read every included file in order. Throws DataFileError at the first bad line unless
 * opts.collectErrors is set, in which case every bad line is returned in `errors`.
 *
 * Returns { options, state, records, warnings, errors, files } where each record, option and
 * warning carries `file` (1-based among the included files) and `line`, and `files` lists
 * [{ name, index, lines }].
 */
export function parseDataFiles(files, opts = {}) {
  const list = included(files);
  const out = { options: [], records: [], warnings: [], errors: [], state: null, files: [] };
  let setStart = 0;
  list.forEach((f, i) => {
    const index = i + 1;
    let p;
    try {
      p = parseDat(f.text, { fileIndex: index, setStart, collectErrors: opts.collectErrors });
    } catch (err) {
      if (err instanceof DatParseError) throw new DataFileError(err.message.replace(/^Line \d+: /, ''), index, f.name, err.line);
      throw err;
    }
    setStart = p.state.setCount;
    for (const o of p.options) out.options.push({ ...o, file: index });
    out.records.push(...p.records);
    out.warnings.push(...p.warnings);
    for (const e of p.errors) out.errors.push({ ...e, fileName: f.name });
    out.files.push({ name: f.name, index, lines: String(f.text).split(/\r\n|\n|\r/).length });
    if (!out.state) {
      out.state = p.state;
    } else {
      // The engine reads units and coordinate order once for the whole job.
      // The first file that names units (via .UNITS) decides them for the job.
      const a = linearUnitsFromDat(out.state.units) || '';
      const b = linearUnitsFromDat(p.state.units) || '';
      if (!a && b) out.state.units = p.state.units;
      else if (b && a !== b) out.warnings.push({ file: index, line: null, message: `${f.name} uses different linear units from the earlier files; the earlier units are applied to the whole job` });
      if (p.state.order !== out.state.order && p.records.some((r) => r.type === 'C')) {
        out.warnings.push({ file: index, line: null, message: `${f.name} uses a different coordinate order from the earlier files; the first file's order is applied to the whole job` });
      }
    }
  });
  if (!out.state) out.state = parseDat('').state;
  return out;
}

/** "file 2, line 14" style label for messages that have to name a place. */
export const placeLabel = (parsed, file, line) => {
  const f = parsed.files && parsed.files[file - 1];
  const name = f ? f.name : `file ${file}`;
  return line ? `${name}, line ${line}` : name;
};
