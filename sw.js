// Survey-Adjust Service Worker - caches the app shell so it works offline in the field.
// Lives at the repo root (not in /app) so its scope covers /app, /engine and the sample job.

// Bump this string every time you deploy new code. The activate handler deletes
// any cache with a different name, forcing browsers and installed PWAs to
// discard stale files and re-fetch everything. (Same convention as FieldBook.)
const CACHE_NAME = 'survey-adjust-v0.1.0';

const APP_SHELL = [
  './',
  './index.html',
  './app/',
  './app/index.html',
  './app/style.css',
  './app/app.js',
  './app/manifest.json',
  './app/icon.svg',
  './engine/index.js',
  './engine/matrix.js',
  './engine/stats.js',
  './engine/parser.js',
  './engine/project.js',
  './engine/level.js',
  './engine/network3d.js',
  './engine/report3d.js',
  './engine/version.js',
  './engine/report.js',
  './tests/fixtures/LEVEL_JOB.dat',
];

// Fetch every shell file fresh, past the HTTP cache and the GitHub Pages CDN
// (both keep files ~10 minutes), so a phone updating right after a deploy never
// stores the previous version's file under the new cache name.
function fetchFresh(url) {
  return fetch(`${url}?v=${CACHE_NAME}`, { cache: 'reload' }).then((response) => {
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return response;
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Fetch everything first so a failed download leaves nothing half-written;
    // a failed install is simply retried the next time the app is opened.
    Promise.all(APP_SHELL.map(fetchFresh)).then((responses) =>
      caches.open(CACHE_NAME).then((cache) =>
        Promise.all(APP_SHELL.map((url, i) => cache.put(url, responses[i])))
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Cache first, then network. Same-origin GETs only.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Offline and not cached: for page loads, fall back to the app itself.
        if (request.mode === 'navigate') return caches.match('./app/index.html');
        return Response.error();
      });
    })
  );
});
