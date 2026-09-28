/*
 * MapMap Web - service worker: makes the app work offline and installable.
 * Strategy: network first, cached copy when offline.
 * Bump CACHE_VERSION when files are added or renamed.
 */
const CACHE_VERSION = 'mapmap-web-v1';
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
  './icons/apple-touch-icon.png',
  './assets/test-signal.svg',
  './assets/pal-test-signal.svg',
  './assets/ntsc-test-signal.svg',
  './assets/mapmap-logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so an update never mixes old and new modules), cache as offline fallback.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
