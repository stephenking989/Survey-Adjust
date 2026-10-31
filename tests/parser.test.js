import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDat, DatParseError, RECORD_PARSERS } from '../engine/parser.js';
import { fixture } from './helpers.js';

test('comments, blank lines and CRLF are handled; line numbers are 1-based', () => {
  const p = parseDat('# header\r\n\r\nE A 100.0 !   # trailing comment\r\nL A-B 1.5 200\r\n');
  assert.equal(p.records.length, 2);
  assert.equal(p.records[0].line, 3);
  assert.equal(p.records[1].line, 4);
});

test('E record: fixed, free, weighted, glued flag, description', () => {
  const p = parseDat("E A 100 !\nE B 101 *\nE C 102\nE D 103 0.005\nE F 104!\nE G 105 ! 'bench mark'\n");
  const r = p.records;
  assert.deepEqual([r[0].status, r[1].status, r[2].status, r[3].status, r[4].status], ['fixed', 'free', 'free', 'weighted', 'fixed']);
  assert.equal(r[3].stdErr, 0.005);
  assert.equal(r[5].description, 'bench mark');
});

test('L record: hyphen form, spaced form, optional std error', () => {
  const p = parseDat('L A-B 1.5 200\nL 12-A 12-B -0.25 310 0.003\n');
  assert.deepEqual([p.records[0].from, p.records[0].to, p.records[0].dElev, p.records[0].length, p.records[0].stdErr], ['A', 'B', 1.5, 200, null]);
  assert.deepEqual([p.records[1].from, p.records[1].to, p.records[1].stdErr], ['12-A', '12-B', 0.003]);
});

test('options are stored in order and affect later records', () => {
  const p = parseDat('.UNITS Meters\n.ORDER EN\n.3D\n.LEVEL 0.0002 LENGTH\nC P1 2000 1000 50 ! ! !\nL A-B 1 100\n');
  assert.deepEqual(p.options.map((o) => o.name), ['UNITS', 'ORDER', '3D', 'LEVEL']);
  assert.deepEqual(p.state.units, ['Meters']);
  const c = p.records[0];
  assert.equal(c.east, 2000);
  assert.equal(c.north, 1000);
  assert.equal(c.elevation, 50);
  assert.deepEqual(c.status, { east: 'fixed', north: 'fixed', elevation: 'fixed' });
  assert.deepEqual(p.records[1].levelOption, { stdErr: 0.0002, mode: 'LENGTH' });
});

test('C record 2D: single flag applies to all, per-coordinate weights', () => {
  const p = parseDat('C A 5000 6000 !\nC B 5000 6000 0.01 0.02\nC C 5000 6000 ! *\n');
  assert.deepEqual(p.records[0].status, { north: 'fixed', east: 'fixed' });
  assert.deepEqual(p.records[1].stdErr, { north: 0.01, east: 0.02 });
  assert.deepEqual(p.records[2].status, { north: 'fixed', east: 'free' });
});

test('record types that are not supported yet are kept with a warning', () => {
  const p = parseDat('DB A-B 1 2 3\nE A 100 !\n');
  assert.equal(p.records[0].type, 'unsupported');
  assert.equal(p.records[0].code, 'TB');
  assert.equal(p.warnings.length, 1);
  assert.equal(p.warnings[0].line, 1);
});

test('a new record type can be added to the table without touching the parser core', () => {
  RECORD_PARSERS.ZZ = (t, ctx) => ({ type: 'ZZ', value: Number(t[0]) });
  try {
    const p = parseDat('ZZ 42\n');
    assert.deepEqual([p.records[0].type, p.records[0].value, p.warnings.length], ['ZZ', 42, 0]);
  } finally {
    delete RECORD_PARSERS.ZZ;
  }
});

test('bad records report the line number', () => {
  assert.throws(() => parseDat('E A 100 !\nL A-B oops 100\n'), (e) => e instanceof DatParseError && e.line === 2 && /Line 2/.test(e.message));
  assert.throws(() => parseDat('E A\n'), DatParseError);
});

test('.END stops reading', () => {
  const p = parseDat('E A 100 !\n.END\nE B 5 !\n');
  assert.equal(p.records.length, 1);
});

test('the real fixture parses to 1 control point and 50 level runs', () => {
  const p = parseDat(fixture('LEVEL_JOB.dat'));
  assert.equal(p.records.filter((r) => r.type === 'E').length, 1);
  assert.equal(p.records.filter((r) => r.type === 'L').length, 50);
  assert.deepEqual(p.state.units, ['Meters']);
  assert.equal(p.warnings.length, 0);
  const first = p.records.find((r) => r.type === 'L');
  assert.deepEqual([first.from, first.to, first.dElev, first.length, first.line], ['N01', 'N02', -0.129963, 40.207, 11]);
});
