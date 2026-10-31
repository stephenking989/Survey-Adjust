// A writer for Leica digital-level GSI files, used to build test and sample files. It follows the block layout in
// Leica's guide and the word indices seen in real DNA level files (11 point id, 32 distance, 331/332 readings, 83 height,
// 573/574 balances, 505-514 closure summary, 41-49 code blocks), but every value here is invented.
//
// Blocks are 23 characters (GSI16), separated by one blank, and a line starts with "*".

const pad = (n, w = 16) => String(Math.abs(Math.round(n))).padStart(w, '0');
const sg = (n) => (n < 0 ? '-' : '+');
const txt = (s, w = 16) => String(s).padStart(w, '0');

/** Numeric block in metres with 5 decimals (unit 8): "331.28+0000000000125300". */
export function metres(wi, value) {
  const v = value * 1e5;
  const head = wi.length === 3 ? `${wi}.28` : `${wi}..28`;
  return `${head}${sg(v)}${pad(v)}`;
}
/** A distance block, like the real ones: unit 8 and information "...8". */
export function dist(value) { return `32...8${sg(value)}${pad(value * 1e5)}`; }
const count = (n) => `390...+${pad(n)}`;
const sdev = (n) => `391.28+${pad(n)}`;

/**
 * runs: [{ start: 'B0', startHeight: 10, setups: [{ from, to, bs: reading, fs: reading, dbs, dfs }], endId }]
 * Heights are accumulated like the instrument does (83 after each fore sight).
 * Options: { codes: true } adds a code line before some readings; { height(i, h) } can falsify the instrument height.
 */
export function writeLevelGsi(runs, opts = {}) {
  const lines = [];
  let n = 0;
  const num = () => String(++n).padStart(4, '0');
  const startLine = () => `*41${num()}+${'00000000?......1'} `;
  const code = (c) => `*41${num()}+${txt(c)} ${[42, 43, 44, 45, 46, 47, 48, 49].map((w) => `${w}....+${pad(0)}`).join(' ')} `;
  for (const run of runs) {
    lines.push(startLine());
    lines.push(`*11${num()}+${txt(run.start)} ${metres('83', run.startHeight).replace('83.28', '83..58').replace('83..28', '83..58')} `);
    let h = run.startHeight; let balance = 0; let total = 0;
    run.setups.forEach((s, i) => {
      if (opts.codes && i % 2 === 1) lines.push(code('TP'));
      lines.push(`*11${num()}+${txt(s.from)} ${dist(s.dbs)} ${metres('331', s.bs)} ${count(3)} ${sdev(1)} `);
      if (opts.codes) lines.push(code('CP'));
      lines.push(`*11${num()}+${txt(s.to)} ${dist(s.dfs)} ${metres('332', s.fs)} ${count(3)} ${sdev(0)} `);
      h += s.bs - s.fs; balance += s.dbs - s.dfs; total += s.dbs + s.dfs;
      const shown = opts.height ? opts.height(i, h) : h;
      lines.push(`*11${num()}+${txt(s.to)} ${metres('573', balance)} ${metres('574', total)} ${metres('83', shown)} `);
    });
    const closure = h - run.startHeight;
    lines.push(`*${[metres('505', closure), metres('506', total), metres('507', 0), `508...+${'000Quick Closure'}`, `509...+${txt(run.start)}`, metres('510', 0), metres('511', 0), `512...+${txt(run.endId ?? run.start)}`, metres('513', closure), metres('514', 0), `271...+${txt('LINE00001')}`, count(3), sdev(1)].join(' ')} `);
  }
  return lines.join('\r\n') + '\r\n';
}
