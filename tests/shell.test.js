// Structure checks: the engine stays DOM-free, and the PWA shell is complete.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

test('engine files never touch the DOM, storage or network', () => {
  const banned = /\b(document|window|localStorage|sessionStorage|navigator|fetch|XMLHttpRequest|alert)\b/;
  for (const f of fs.readdirSync(path.join(root, 'engine')).filter((n) => n.endsWith('.js'))) {
    // Strip comments so prose like "no DOM" does not trip the check.
    const code = read(`engine/${f}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!banned.test(code), `engine/${f} uses a browser-only API`);
  }
});

test('engine has no imports from outside /engine', () => {
  for (const f of fs.readdirSync(path.join(root, 'engine')).filter((n) => n.endsWith('.js'))) {
    for (const m of read(`engine/${f}`).matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(m[1].startsWith('./'), `engine/${f} imports ${m[1]}`);
    }
  }
});

test('every file in the service worker precache list exists', () => {
  const sw = read('sw.js');
  const list = /APP_SHELL\s*=\s*\[([\s\S]*?)\]/.exec(sw)[1];
  const urls = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(urls.length > 10);
  for (const u of urls) {
    let rel = u.replace(/^\.\//, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    assert.ok(exists(rel), `precached file missing: ${u}`);
  }
  assert.match(sw, /const CACHE_NAME = 'survey-adjust-v/);
});

test('every engine and app file is in the precache list (so offline never breaks)', () => {
  const sw = read('sw.js');
  for (const f of fs.readdirSync(path.join(root, 'engine')).filter((n) => n.endsWith('.js'))) {
    assert.ok(sw.includes(`./engine/${f}`), `engine/${f} is not precached`);
  }
  const appFiles = fs.readdirSync(path.join(root, 'app')).filter((n) => /\.(js|html|css|json|svg)$/.test(n));
  assert.ok(appFiles.length >= 8);
  for (const f of appFiles) {
    assert.ok(sw.includes(`./app/${f}`), `app/${f} is not precached`);
  }
});

test('manifest is valid and its icon exists', () => {
  const m = JSON.parse(read('app/manifest.json'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.start_url && m.name && m.short_name);
  for (const icon of m.icons) assert.ok(exists(`app/${icon.src}`), `icon ${icon.src}`);
});

test('app page links its assets and registers the root service worker', () => {
  const html = read('app/index.html');
  assert.match(html, /rel="manifest" href="\.\/manifest\.json"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /href="\.\/style\.css"/);
  assert.match(read('app/app.js'), /serviceWorker\s*\.register\('\.\.\/sw\.js'\)/);
  assert.match(html, /name="viewport"/);
});

test('no committed fixture carries a student number, instrument serial number or crew tag', () => {
  // Every real job under tests/fixtures (the git-ignored local/ folder is skipped: it is never committed).
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => (
    d.isDirectory() ? (d.name === 'local' ? [] : walk(`${dir}/${d.name}`)) : [`${dir}/${d.name}`]));
  const files = walk('tests/fixtures');
  assert.ok(files.length >= 6);
  for (const f of files) {
    const text = read(f);
    assert.ok(!/\bW\d{7}\b/.test(text), `${f} contains a student number`);
    assert.ok(!/s\/n\s*\d{5,}/i.test(text), `${f} contains an instrument serial number`);
    assert.ok(!/crew\s*\d/i.test(text), `${f} contains a crew tag`);
  }
});

test('every relative import in the app resolves to a real file', () => {
  for (const f of fs.readdirSync(path.join(root, 'app')).filter((n) => n.endsWith('.js'))) {
    for (const m of read(`app/${f}`).matchAll(/from\s+'(\.[^']+)'/g)) {
      assert.ok(exists(path.posix.normalize(`app/${m[1]}`)), `app/${f} imports ${m[1]}, which does not exist`);
    }
  }
});

test('every element id the app code looks up exists in the page', () => {
  const html = read('app/index.html');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const f of ['app.js', 'editor.js', 'results.js']) {
    for (const m of read(`app/${f}`).matchAll(/\$\('([^']+)'\)/g)) {
      assert.ok(ids.has(m[1]), `app/${f} looks up #${m[1]}, which is not in index.html`);
    }
  }
});
