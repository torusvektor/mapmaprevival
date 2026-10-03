/*
 * MapMap Web - service worker: makes the app work offline and installable.
 * Strategy: network first, cached copy when offline.
 * Bump CACHE_VERSION when files are added or renamed.
 */
const CACHE_VERSION = 'v2';
// Other apps can live on the same origin (e.g. user.github.io/other-app): the cache name
// carries this app's scope, and only this app's caches are ever deleted.
const CACHE_PREFIX = `mapmap-web:${self.registration.scope}:`;
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const LEGACY_CACHES = ['mapmap-web-v1'];
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/app.js',
  './js/i18n.js',
  './js/history.js',
  './js/model/geometry.js',
  './js/model/shapes.js',
  './js/model/paints.js',
  './js/model/project.js',
  './js/io/mmp.js',
  './js/io/zip.js',
  './js/io/storage.js',
  './js/render/renderer.js',
  './js/render/tessellate.js',
  './js/render/overlay.js',
  './js/ui/view.js',
  './js/ui/panels.js',
  './js/ui/output.js',
  './js/ui/widgets.js',
  './js/ui/icons.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './assets/test-signal.svg',
  './assets/pal-test-signal.svg',
  './assets/ntsc-test-signal.svg',
  './assets/mapmap-logo.svg',
];
const SHELL_URLS = new Set(APP_SHELL.map((p) => new URL(p, self.registration.scope).href));
const INDEX_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== CACHE_NAME && (k.startsWith(CACHE_PREFIX) || LEGACY_CACHES.includes(k)))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so an update never mixes old and new modules), cache as offline fallback.
// Only the app's own files are cached; everything else goes to the network untouched.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  url.search = '';
  url.hash = '';
  const navigate = req.mode === 'navigate' && url.href.startsWith(self.registration.scope);
  const key = navigate && !SHELL_URLS.has(url.href) ? INDEX_URL : url.href;
  if (!navigate && !SHELL_URLS.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      // A redirected response must not be stored: Safari refuses to serve one for a page.
      if (res && res.ok && res.type === 'basic' && !res.redirected && SHELL_URLS.has(url.href)) {
        event.waitUntil(cache.put(key, res.clone()));
      }
      return res;
    } catch {
      const cached = await cache.match(key);
      if (cached) return cached;
      if (navigate) {
        const shell = await cache.match(INDEX_URL);
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
