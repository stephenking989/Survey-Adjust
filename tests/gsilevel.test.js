// Leica digital-level GSI files: three-character word indices, text data that contains blanks, and the conversion of
// back sight / fore sight set-ups to L records. All data are invented; the layout matches real level files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gsiToDat, readGsi, parseGsiLine, looksLikeGsi, parseDat, runAdjustment, defaultSettings, checkData } from '../engine/index.js';
import { near } from './helpers.js';
import { writeLevelGsi } from './gsiwriter.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// A loop of four set-ups from B0 back to B0 (the instrument names the last point "4").
const loop = {
  start: 'B0', startHeight: 100,
  setups: [
    { from: 'B0', to: '1', bs: 1.52000, fs: 1.10000, dbs: 15.0, dfs: 14.5 },
    { from: '1', to: '2', bs: 1.30000, fs: 0.80000, dbs: 12.0, dfs: 12.5 },
    { from: '2', to: '3', bs: 0.90000, fs: 1.60000, dbs: 10.0, dfs: 10.5 },
    { from: '3', to: '4', bs: 1.40000, fs: 1.61020, dbs: 13.0, dfs: 13.5 },
  ],
};

test('three-character word indices and blanks inside text data read correctly', () => {
  const gsi = writeLevelGsi([loop]);
  const lines = gsi.split('\r\n').filter(Boolean);
  const bs = parseGsiLine(lines[2], 3);
  assert.deepEqual(bs.map((b) => b.wi), ['11', '32', '331', '390', '391']);
  const summary = parseGsiLine(lines[lines.length - 1], 99);
  assert.deepEqual(summary.map((b) => b.wi).slice(0, 5), ['505', '506', '507', '508', '509']);
  assert.equal(summary.find((b) => b.wi === '508').data, '000Quick Closure');
  const { rows } = readGsi(gsi);
  near(assert, rows[2].num['331'], 1.52, 1e-9);
  near(assert, rows[2].num['32'], 15.0, 1e-9);
  assert.equal(looksLikeGsi(gsi), true);
});

test('a level run becomes E and L records: reading difference and the sum of the sight distances', () => {
  const r = gsiToDat(writeLevelGsi([loop]), {});
  assert.equal(r.summary.kind, 'level');
  assert.equal(r.summary.setups, 4);
  const p = parseDat(r.text);
  const E = p.records.filter((x) => x.type === 'E');
  assert.deepEqual(E.map((x) => [x.name, x.elevation, x.status]), [['B0', 100, 'fixed']]);
  const L = p.records.filter((x) => x.type === 'L');
  assert.equal(L.length, 4);
  near(assert, L[0].dElev, 0.42, 1e-9); near(assert, L[0].length, 29.5, 1e-9);
  near(assert, L[1].dElev, 0.5, 1e-9);
  // The last fore sight closes within a millimetre of the start benchmark, so it takes the benchmark's name.
  assert.deepEqual([L[3].from, L[3].to], ['3', 'B0']);
  assert.ok(r.warnings.some((w) => /renamed B0/.test(w.message)));
  // The instrument's running heights agree with the set-ups, so there is no height warning.
  assert.equal(r.warnings.some((w) => /differs from the sum/.test(w.message)), false);
});

test('a loop whose last point is far from the start is not renamed, and a wrong instrument height is reported', () => {
  const bad = { ...loop, setups: loop.setups.map((s, i) => (i === 3 ? { ...s, fs: 1.55 } : s)) };
  const r = gsiToDat(writeLevelGsi([bad]), {});
  assert.equal(parseDat(r.text).records.filter((x) => x.type === 'L')[3].to, '4');
  assert.ok(r.warnings.some((w) => /was not renamed/.test(w.message)));
  const r2 = gsiToDat(writeLevelGsi([loop], { height: (i, h) => (i === 2 ? h + 0.0385 : h) }), {});
  assert.ok(r2.warnings.some((w) => /differs from the sum of the set-ups here/.test(w.message) && /38\.5 ?mm|38\.\d\d ?mm/.test(w.message)));
});

test('several runs in one file, code lines, a point-id prefix, and an adjustment of the result', () => {
  const run2 = { start: 'B0', startHeight: 100, setups: [
    { from: 'B0', to: '1', bs: 1.2, fs: 1.12, dbs: 20, dfs: 20 },
    { from: '1', to: '2', bs: 1.4, fs: 1.7, dbs: 20, dfs: 20 },
    { from: '2', to: '3', bs: 1.1, fs: 0.78, dbs: 20, dfs: 20 },
  ] };
  const gsi = writeLevelGsi([loop, run2], { codes: true });
  const r = gsiToDat(gsi, { prefix: 'R1_' });
  assert.equal(r.summary.runs, 2);
  assert.equal(r.summary.setups, 7);
  assert.match(r.text, /^E R1_B0 100\.00000 !$/m);
  assert.match(r.text, /^L R1_B0-R1_1 /m);
  const s = defaultSettings(); s.levelStdErr = 0.005;
  const out = runAdjustment([{ name: 'l.dat', text: r.text }], s, {});
  assert.equal(out.kind, 'level');
  assert.ok(out.result.stations.some((x) => x.name === 'R1_B0' && x.status === 'fixed'));
  assert.equal(checkData([{ name: 'l.dat', text: r.text }], s).ok, true);
});

test('stray readings are reported, not guessed at, and a file with no set-ups is refused', () => {
  const gsi = writeLevelGsi([loop]).split('\r\n');
  // Drop the first fore sight: the next back sight then follows another back sight.
  const broken = [...gsi.slice(0, 3), ...gsi.slice(4)].join('\r\n');
  const r = gsiToDat(broken, {});
  assert.ok(r.warnings.some((w) => /no fore sight after it/.test(w.message) || /no back sight before it/.test(w.message)));
  assert.throws(() => gsiToDat('*410001+00000000?......1 \r\n*110002+00000000000000B0 83..58+0000000000000000 \r\n', {}), /no observations|no level set-ups/);
});

test('the level GSI sample in the app converts and adjusts', () => {
  const gsi = fs.readFileSync(path.join(here, '..', 'app', 'samples', 'LEVEL_GSI_SAMPLE.gsi'), 'utf8');
  assert.equal(looksLikeGsi(gsi), true);
  const r = gsiToDat(gsi, {});
  assert.equal(r.summary.kind, 'level');
  const s = defaultSettings(); s.levelStdErr = 0.0004;
  const out = runAdjustment([{ name: 's.dat', text: r.text }], s, {});
  assert.equal(out.kind, 'level');
  assert.equal(out.result.stats.chiSquare.passed, true);
});
