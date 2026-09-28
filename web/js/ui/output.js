/*
 * MapMap Web - projection output: fullscreen presentation in the page and a separate
 * output window (for a projector / second screen). Port of src/gui/OutputGLWindow.cpp.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { EditorView } from './view.js';
import { icon } from './icons.js';
import { toast } from './widgets.js';
import { t } from '../i18n.js';

const HUD_TIMEOUT = 2500;

function requestFullscreen(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn) return Promise.reject(new Error('unsupported'));
  try {
    const r = fn.call(el, { navigationUI: 'hide' });
    return r && r.then ? r : Promise.resolve();
  } catch (err) {
    return Promise.reject(err);
  }
}

function fullscreenElement(doc) {
  return doc.fullscreenElement || doc.webkitFullscreenElement || null;
}

function exitFullscreen(doc) {
  const fn = doc.exitFullscreen || doc.webkitExitFullscreen;
  if (fn && fullscreenElement(doc)) {
    try { const r = fn.call(doc); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ }
  }
}

function hudHtml() {
  return `
    <button type="button" data-hud="close" title="${t('output.exit')}">${icon('close')}</button>
    <button type="button" data-hud="fullscreen" title="${t('output.fullscreen')}">${icon('fullscreen')}</button>
    <button type="button" data-hud="play" title="${t('action.playPause')}">${icon('pause')}</button>
    <button type="button" data-hud="controls" title="${t('action.displayControls')}">${icon('controls')}</button>
    <button type="button" data-hud="test" title="${t('action.testSignal')}">${icon('testSignal')}</button>
    <span class="hud-info"></span>`;
}

export class OutputManager {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('presentation');
    this.presentationView = null;
    this.windowView = null;
    this.win = null;
    this.wakeLock = null;
    document.addEventListener('fullscreenchange', () => this._onFullscreenChange());
    document.addEventListener('webkitfullscreenchange', () => this._onFullscreenChange());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.isPresenting()) this._acquireWakeLock();
    });
  }

  views() {
    return [this.presentationView, this.windowView].filter(Boolean);
  }

  isPresenting() { return !!this.presentationView; }

  windowSupported() { return !this.app.isPhone(); }

  /* -------------------------------------------------- in-page presentation */

  togglePresentation() {
    if (this.isPresenting()) this.exitPresentation();
    else this.enterPresentation();
  }

  enterPresentation() {
    if (this.presentationView) return;
    const root = this.root;
    root.hidden = false;
    root.innerHTML = `<div class="pres-stage"></div><div class="pres-hud">${hudHtml()}</div>`;
    this.presentationView = new EditorView(this.app, root.querySelector('.pres-stage'), { kind: 'output', presentation: true });
    this._setupHud(root, document, this.presentationView, () => this.exitPresentation());
    document.body.classList.add('presenting');
    requestFullscreen(root).catch(() => {
      if (/iPhone|iPod/.test(navigator.userAgent) && !navigator.standalone) {
        toast(t('output.iosHint'), { timeout: 6000 });
      }
    });
    this._acquireWakeLock();
    this.app.invalidate();
  }

  exitPresentation() {
    if (!this.presentationView) return;
    exitFullscreen(document);
    this.presentationView.dispose();
    this.presentationView = null;
    clearTimeout(this._hudTimer);
    this.root.innerHTML = '';
    this.root.hidden = true;
    document.body.classList.remove('presenting');
    this._releaseWakeLock();
    this.app.invalidate();
  }

  _onFullscreenChange() {
    // Leaving fullscreen with the browser UI (Esc) also leaves presentation mode.
    if (this.presentationView && !fullscreenElement(document) && this._wasFullscreen) this.exitPresentation();
    this._wasFullscreen = !!fullscreenElement(document);
  }

  async _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch { /* not allowed */ }
  }

  _releaseWakeLock() {
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
  }

  onPresentationDoubleClick(view) {
    const doc = view.doc;
    const target = view === this.presentationView ? this.root : doc.documentElement;
    if (fullscreenElement(doc)) exitFullscreen(doc);
    else requestFullscreen(target).catch(() => {});
  }

  /** Auto-hiding control bar shown over the output. */
  _setupHud(root, doc, view, onClose) {
    const hud = root.querySelector('.pres-hud');
    const info = hud.querySelector('.hud-info');
    const win = doc.defaultView;
    const update = () => {
      const s = this.app.settings;
      hud.querySelector('[data-hud=controls]').classList.toggle('active', s.displayControls);
      hud.querySelector('[data-hud=test]').classList.toggle('active', s.showTestSignal);
      hud.querySelector('[data-hud=play]').innerHTML = icon(this.app.playing ? 'pause' : 'play');
      const fsSupported = !!(doc.documentElement.requestFullscreen || doc.documentElement.webkitRequestFullscreen);
      hud.querySelector('[data-hud=fullscreen]').hidden = !fsSupported;
      info.textContent = `${this.app.project.outputWidth}×${this.app.project.outputHeight}`;
    };
    const show = () => {
      root.classList.add('hud-visible');
      update();
      clearTimeout(view._hudTimer);
      view._hudTimer = setTimeout(() => {
        if (!hud.matches(':hover')) root.classList.remove('hud-visible');
      }, HUD_TIMEOUT);
    };
    hud.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-hud]');
      if (!b) return;
      const act = b.dataset.hud;
      if (act === 'close') onClose();
      else if (act === 'fullscreen') {
        const target = view === this.presentationView ? this.root : doc.documentElement;
        if (fullscreenElement(doc)) exitFullscreen(doc); else requestFullscreen(target).catch(() => {});
      } else if (act === 'play') this.app.togglePlay();
      else if (act === 'controls') this.app.toggleSetting('displayControls');
      else if (act === 'test') this.app.toggleSetting('showTestSignal');
      update();
      show();
    });
    root.addEventListener('pointermove', show);
    root.addEventListener('pointerdown', show);
    win.addEventListener('keydown', show);
    this.app.on('change', () => { if (root.isConnected) update(); });
    show();
  }

  /* ------------------------------------------------------ output window */

  openWindow() {
    if (this.win && !this.win.closed) {
      this.win.focus();
      return;
    }
    const w = window.open('', 'mapmap-output', 'popup=yes,width=960,height=540');
    if (!w) {
      toast(t('error.popupBlocked'), { kind: 'error', timeout: 5000 });
      return;
    }
    this.win = w;
    const doc = w.document;
    doc.open();
    doc.write(`<!doctype html><html lang="${document.documentElement.lang}"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${t('output.windowTitle')}</title>
      <link rel="icon" href="${new URL('icons/icon-192.png', location.href)}">
      <link rel="stylesheet" href="${new URL('css/app.css', location.href)}">
      </head><body class="output-window"><div id="output-root" class="presentation"><div class="pres-stage"></div><div class="pres-hud">${hudHtml()}</div></div>
      <div class="output-hint">${t('output.windowHint')}</div></body></html>`);
    doc.close();

    const setup = () => {
      if (this.windowView || w.closed) return;
      const root = doc.getElementById('output-root');
      this.windowView = new EditorView(this.app, root.querySelector('.pres-stage'), { kind: 'output', presentation: true });
      this._setupHud(root, doc, this.windowView, () => w.close());
      w.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && fullscreenElement(doc)) return;
        if (e.key === 'f' || e.key === 'F') {
          if (!e.ctrlKey && !e.metaKey) {
            if (fullscreenElement(doc)) exitFullscreen(doc); else requestFullscreen(doc.documentElement).catch(() => {});
            e.preventDefault();
            return;
          }
        }
        this.app.setActiveView(this.windowView);
        this.app.handleKeyDown(e);
      });
      const loop = () => {
        if (!this.windowView || w.closed) return;
        this.app.renderFrame([this.windowView]);
        w.requestAnimationFrame(loop);
      };
      w.requestAnimationFrame(loop);
      w.addEventListener('pagehide', () => this._disposeWindow());
      const hint = doc.querySelector('.output-hint');
      setTimeout(() => hint && hint.classList.add('fade'), 4000);
    };
    // The stylesheet may take a moment; the view measures itself on resize anyway.
    if (doc.readyState === 'complete') setup(); else w.addEventListener('load', setup);
    setTimeout(setup, 300);
    this._pollClosed = setInterval(() => { if (w.closed) this._disposeWindow(); }, 1000);
    this._placeOnSecondScreen(w);
  }

  /** With the Window Management API (Chrome), move the window to another screen. */
  async _placeOnSecondScreen(w) {
    try {
      if (!('getScreenDetails' in window) || !window.screen.isExtended) return;
      const details = await window.getScreenDetails();
      const other = details.screens.find((s) => s !== details.currentScreen);
      if (!other || w.closed) return;
      w.moveTo(other.availLeft, other.availTop);
      w.resizeTo(other.availWidth, other.availHeight);
      toast(t('output.movedToScreen', { name: other.label || '2' }), { timeout: 4000 });
    } catch { /* permission denied or unsupported */ }
  }

  _disposeWindow() {
    clearInterval(this._pollClosed);
    if (this.windowView) {
      try { this.windowView.dispose(); } catch { /* window gone */ }
      this.windowView = null;
    }
    this.win = null;
  }

  closeWindow() {
    if (this.win && !this.win.closed) this.win.close();
    this._disposeWindow();
  }

  onLanguageChanged() {
    if (this.presentationView) {
      const hud = this.root.querySelector('.pres-hud');
      if (hud) hud.innerHTML = hudHtml();
    }
  }
}
