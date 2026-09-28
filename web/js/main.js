/*
 * MapMap Web - entry point.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { App } from './app.js';

const app = new App();
window.mapmap = app; // handy for debugging from the console

app.start().catch((err) => {
  console.error(err);
  const p = document.createElement('pre');
  p.style.cssText = 'position:fixed;inset:auto 0 0 0;margin:0;padding:12px;background:#400;color:#fff;z-index:9999;white-space:pre-wrap';
  p.textContent = 'MapMap Web failed to start: ' + (err && err.stack ? err.stack : err);
  document.body.appendChild(p);
});

// Offline support / installation as an app (needs HTTPS or localhost).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
  });
}
