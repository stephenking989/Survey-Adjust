import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name) {
  return fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
}

/** Assert |a - b| <= tol with a message that shows the numbers. */
export function near(assert, a, b, tol, label = '') {
  assert.ok(Math.abs(a - b) <= tol, `${label} ${a} vs ${b} differ by ${Math.abs(a - b)} (tolerance ${tol})`);
}
