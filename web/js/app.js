/*
 * MapMap Web - application controller.
 * Plays the role of src/gui/MainWindow.cpp: actions, menus, shortcuts, selection,
 * undo/redo, media import, project files, playback and the render loop.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Project, Mapping, createShapeForColor, createShapeForTexture } from './model/project.js';
import { ColorPaint, ImagePaint, VideoPaint, CameraPaint, isImageFile, isVideoFile, fileExtension, baseName } from './model/paints.js';
import { Affine } from './model/geometry.js';
import { ShapeMode } from './model/shapes.js';
import { parseMmp, writeMmp, ProjectFormatError } from './io/mmp.js';
import { createZip, readZip } from './io/zip.js';
import { storage } from './io/storage.js';
import { History } from './history.js';
import { EditorView, ZOOM_FACTOR } from './ui/view.js';
import { Panels } from './ui/panels.js';
import { OutputManager } from './ui/output.js';
import { showMenu, closeMenu, isMenuOpen, openModal, confirmDialog, promptDialog, alertDialog, toast, pickFiles, downloadBlob, escapeHtml } from './ui/widgets.js';
import { icon } from './ui/icons.js';
import { t, setLanguage, getLanguage, applyI18n, LANGUAGES } from './i18n.js';
import { preloadTestCards } from './render/overlay.js';

export const APP_VERSION = '0.7.0-web';

const DEFAULT_SETTINGS = {
  lang: 'auto',
  stickyVertices: true,
  stickRadius: 20,
  displayControls: true,
  displayPaintControls: true,
  showTestSignal: false,
  testCard: 0,
  showResolution: true,
  controlsOnHover: true,
  outputFit: 'contain',
  layout: 'both',
  playInLoop: true,
  sidebarWidth: 330,
  viewsSplit: 0.5,
};

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent);

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('mapmap-web-settings') || '{}');
    return { ...DEFAULT_SETTINGS, ...s };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Formats a shortcut spec ("mod+shift+KeyS") for display. */
function formatShortcut(spec) {
  if (!spec) return '';
  const first = Array.isArray(spec) ? spec[0] : spec;
  return first.split('+').map((p) => {
    switch (p) {
      case 'mod': return IS_MAC ? '⌃' : 'Ctrl+';
      case 'shift': return IS_MAC ? '⇧' : 'Shift+';
      case 'alt': return IS_MAC ? '⌥' : 'Alt+';
      case 'Space': return t('key.space');
      case 'Delete': return IS_MAC ? '⌫' : 'Del';
      case 'Equal': return '+';
      case 'Minus': return '-';
      case 'Comma': return ',';
      case 'PageUp': return 'PgUp';
      case 'PageDown': return 'PgDn';
      default: return p.replace(/^Key/, '').replace(/^Digit/, '');
    }
  }).join('');
}

function matchShortcut(spec, e) {
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    const parts = s.split('+');
    const code = parts.pop();
    const mod = parts.includes('mod');
    const shift = parts.includes('shift');
    const alt = parts.includes('alt');
    if (mod !== (e.ctrlKey || e.metaKey)) continue;
    if (shift !== e.shiftKey) continue;
    if (alt !== e.altKey) continue;
    if (e.code === code || (code === 'Delete' && e.code === 'Backspace')) return true;
  }
  return false;
}

export class App {
  constructor() {
    this.settings = loadSettings();
    setLanguage(this.settings.lang);
    this.project = new Project();
    this.projectName = 'mapmap';
    this.history = new History();
    this.currentMappingId = null;
    this.currentPaintId = null;
    this.renderVersion = 0;
    this.playing = true;
    this.listeners = {};
    this.activeView = null;
    this.pointerInfo = null;
    this.coarsePointer = matchMedia('(pointer: coarse)').matches;
    this.mobileTab = 'output';
    this.fps = 0;
    this._frames = 0;
    this._fpsTime = performance.now();
    this._autosaveTimer = null;
    this._storedMedia = new Map(); // paint id -> blob already written to IndexedDB
    this.lastColor = { r: 0, g: 255, b: 0, a: 255 };
    this.outputFileHandle = null;
  }

  /* ------------------------------------------------------------ startup */

  async start() {
    this.dom = {
      app: document.getElementById('app'),
      views: document.getElementById('views'),
      sidebar: document.getElementById('sidebar'),
      status: document.getElementById('statusbar'),
    };
    this.actions = this._defineActions();
    this._buildToolbar();
    this.i18nApply(document);

    this.views = {
      input: new EditorView(this, document.getElementById('view-input'), { kind: 'input' }),
      output: new EditorView(this, document.getElementById('view-output'), { kind: 'output' }),
    };
    this.activeView = this.views.output;
    this.panels = new Panels(this);
    this.output = new OutputManager(this);

    this._bindGlobalEvents();
    this._setupSplitters();
    this.applyLayout();
    preloadTestCards();

    this.history.reset(this._historyState('history.new'));
    await this.restoreAutosave();
    this.emitChange();
    requestAnimationFrame(() => this._tick());
    storage.requestPersistence();
  }

  i18nApply(root) {
    applyI18n(root, (key) => {
      const a = this.actions && Object.values(this.actions).find((x) => x.label === key && x.shortcut);
      return a ? formatShortcut(a.shortcut) : '';
    });
  }

  /* -------------------------------------------------------------- events */

  on(event, fn) { (this.listeners[event] ||= []).push(fn); }
  emit(event, ...args) { for (const fn of this.listeners[event] || []) fn(...args); }

  /** Something changed in the model or selection: refresh UI and redraw. */
  emitChange() {
    this.invalidate();
    this._statusDirty = true;
    this.emit('change');
    this._updateToolbarState();
  }

  invalidate() { this.renderVersion++; }

  /* ----------------------------------------------------------- selection */

  getCurrentMapping() { return this.currentMappingId != null ? this.project.getMappingById(this.currentMappingId) : null; }
  getCurrentPaint() { return this.currentPaintId != null ? this.project.getPaintById(this.currentPaintId) : null; }

  /** Paint shown in the input editor: paint of the current layer or selected source. */
  getInputPaint() {
    const m = this.getCurrentMapping();
    return m ? m.paint : this.getCurrentPaint();
  }

  setCurrentMapping(id) {
    const m = id != null ? this.project.getMappingById(id) : null;
    if (m && m.id === this.currentMappingId) return;
    const prevPaint = this.getInputPaint();
    this.currentMappingId = m ? m.id : null;
    if (m) this.currentPaintId = m.paint.id;
    for (const v of this.allViews()) v.activeVertex = -1;
    if (this.getInputPaint() !== prevPaint && this.views) this.views.input.needsFit = true;
    this._fitInputIfNeeded();
    this.updatePlayingState();
    this.emitChange();
  }

  setCurrentPaint(id) {
    const p = id != null ? this.project.getPaintById(id) : null;
    const prevPaint = this.getInputPaint();
    this.currentPaintId = p ? p.id : null;
    const m = this.getCurrentMapping();
    if (m && m.paint !== p) this.currentMappingId = null;
    if (this.getInputPaint() !== prevPaint && this.views) this.views.input.needsFit = true;
    this._fitInputIfNeeded();
    this.updatePlayingState();
    this.emitChange();
  }

  _fitInputIfNeeded() {
    const v = this.views?.input;
    if (v && v.needsFit && v.cssWidth) v.fit();
  }

  _validateSelection() {
    if (this.currentMappingId != null && !this.project.getMappingById(this.currentMappingId)) this.currentMappingId = null;
    if (this.currentPaintId != null && !this.project.getPaintById(this.currentPaintId)) this.currentPaintId = null;
    if (this.currentPaintId == null && this.project.paints.length) this.currentPaintId = this.project.paints[this.project.paints.length - 1].id;
  }

  /* ------------------------------------------------------------- history */

  _historyState(label) {
    return {
      label,
      snap: this.project.snapshot(),
      mappingId: this.currentMappingId,
      paintId: this.currentPaintId,
    };
  }

  /** Records the current state as an undoable step. */
  commit(label, { mergeKey = null } = {}) {
    this.history.push(this._historyState(label), mergeKey);
    this.updatePlayingState();
    this.emitChange();
    this.scheduleAutosave();
  }

  _restoreState(state) {
    const before = new Set(this.project.paints);
    this.project.restore(state.snap);
    const after = new Set(this.project.paints);
    for (const p of before) if (!after.has(p)) p.deactivate();
    for (const p of after) if (!before.has(p)) p.activate();
    this.currentMappingId = state.mappingId;
    this.currentPaintId = state.paintId;
    this._validateSelection();
    for (const v of this.allViews()) v.activeVertex = -1;
    this.updatePlayingState();
    this.emitChange();
    this.scheduleAutosave();
  }

  undo() {
    const r = this.history.undo();
    if (!r) return;
    this._restoreState(r.state);
    toast(t('history.undone', { what: t(r.label) }));
  }

  redo() {
    const r = this.history.redo();
    if (!r) return;
    this._restoreState(r.state);
    toast(t('history.redone', { what: t(r.label) }));
  }

  /* ------------------------------------------------------------- actions */

  _defineActions() {
    const cur = () => this.getCurrentMapping();
    const hasMapping = () => !!cur();
    const hasPaint = () => !!this.getCurrentPaint();
    const a = (label, iconName, shortcut, run, extra = {}) => ({ label, icon: iconName, shortcut, run, ...extra });
    return {
      'file.new': a('action.new', 'fileNew', 'mod+KeyN', () => this.newProject()),
      'file.open': a('action.open', 'open', 'mod+KeyO', () => this.openProjectDialog()),
      'file.save': a('action.save', 'save', 'mod+KeyS', () => this.saveBundle()),
      'file.exportMmp': a('action.exportMmp', 'download', 'mod+shift+KeyS', () => this.exportMmp()),
      'file.importMedia': a('action.importMedia', 'media', 'mod+KeyI', () => this.importMediaDialog()),
      'file.addCamera': a('action.addCamera', 'camera', 'mod+shift+KeyC', () => this.addCameraDialog(), { enabled: () => CameraPaint.supported }),
      'file.addColor': a('action.addColor', 'color', 'mod+shift+KeyA', () => this.addColorDialog()),
      'file.relink': a('action.relink', 'link', null, () => this.relinkMediaDialog(), { enabled: () => this.missingMedia().length > 0 }),
      'edit.undo': a('action.undo', 'undo', 'mod+KeyZ', () => this.undo(), { enabled: () => this.history.canUndo() }),
      'edit.redo': a('action.redo', 'redo', ['mod+shift+KeyZ', 'mod+KeyY'], () => this.redo(), { enabled: () => this.history.canRedo() }),
      'edit.preferences': a('action.preferences', 'settings', 'mod+Comma', () => this.preferencesDialog()),
      'layer.addMesh': a('action.addMesh', 'mesh', 'mod+KeyM', () => this.addLayer('mesh'), { enabled: hasPaint }),
      'layer.addTriangle': a('action.addTriangle', 'triangle', 'mod+KeyT', () => this.addLayer('triangle'), { enabled: hasPaint }),
      'layer.addEllipse': a('action.addEllipse', 'ellipse', 'mod+KeyE', () => this.addLayer('ellipse'), { enabled: hasPaint }),
      'layer.duplicate': a('action.duplicateLayer', 'duplicate', 'mod+KeyD', () => this.duplicateMapping(), { enabled: hasMapping }),
      'layer.delete': a('action.deleteLayer', 'trash', 'Delete', () => this.deleteMapping(), { enabled: hasMapping }),
      'layer.rename': a('action.renameLayer', 'edit', 'F2', () => this.renameMapping(), { enabled: hasMapping }),
      'layer.lock': a('action.lockLayer', 'lock', null, () => this.toggleMappingProp('locked'), { enabled: hasMapping, checked: () => !!cur()?.locked }),
      'layer.hide': a('action.hideLayer', 'eyeOff', null, () => this.toggleMappingProp('visible'), { enabled: hasMapping, checked: () => cur() ? !cur().visible : false }),
      'layer.solo': a('action.soloLayer', 'solo', null, () => this.toggleMappingProp('solo'), { enabled: hasMapping, checked: () => !!cur()?.solo }),
      'layer.rotateCW': a('action.rotate90CW', 'rotateCW', null, () => this.transformMapping('rotateCW'), { enabled: hasMapping }),
      'layer.rotateCCW': a('action.rotate90CCW', 'rotateCCW', null, () => this.transformMapping('rotateCCW'), { enabled: hasMapping }),
      'layer.rotate180': a('action.rotate180', 'rotate', null, () => this.transformMapping('rotate180'), { enabled: hasMapping }),
      'layer.flipH': a('action.flipH', 'flipH', 'KeyH', () => this.transformMapping('flipH'), { enabled: hasMapping }),
      'layer.flipV': a('action.flipV', 'flipV', 'KeyV', () => this.transformMapping('flipV'), { enabled: hasMapping }),
      'layer.raise': a('action.raise', 'up', 'PageUp', () => this.moveMappingBy('raise'), { enabled: hasMapping }),
      'layer.lower': a('action.lower', 'down', 'PageDown', () => this.moveMappingBy('lower'), { enabled: hasMapping }),
      'layer.top': a('action.raiseTop', 'top', 'Home', () => this.moveMappingBy('top'), { enabled: hasMapping }),
      'layer.bottom': a('action.lowerBottom', 'bottom', 'End', () => this.moveMappingBy('bottom'), { enabled: hasMapping }),
      'source.rename': a('action.renameSource', 'edit', null, () => this.renamePaint(), { enabled: hasPaint }),
      'source.delete': a('action.deleteSource', 'trash', null, () => this.deletePaint(), { enabled: hasPaint }),
      'play.toggle': a('action.playPause', 'play', 'Space', () => this.togglePlay()),
      'play.rewind': a('action.rewind', 'rewind', 'mod+KeyR', () => this.rewind()),
      'view.present': a('action.present', 'output', 'mod+KeyF', () => this.output.togglePresentation()),
      'view.outputWindow': a('action.outputWindow', 'window', 'mod+shift+KeyF', () => this.output.openWindow(), { enabled: () => this.output?.windowSupported() }),
      'view.controls': a('action.displayControls', 'controls', 'alt+KeyC', () => this.toggleSetting('displayControls'), { checked: () => this.settings.displayControls }),
      'view.paintControls': a('action.displayPaintControls', null, null, () => this.toggleSetting('displayPaintControls'), { checked: () => this.settings.displayPaintControls }),
      'view.sticky': a('action.stickyVertices', 'magnet', 'alt+KeyS', () => this.toggleSetting('stickyVertices'), { checked: () => this.settings.stickyVertices }),
      'view.testSignal': a('action.testSignal', 'testSignal', 'alt+KeyT', () => this.toggleSetting('showTestSignal'), { checked: () => this.settings.showTestSignal }),
      'view.layoutBoth': a('action.layoutBoth', null, 'mod+alt+Digit1', () => this.setLayout('both'), { checked: () => this.settings.layout === 'both' }),
      'view.layoutInput': a('action.layoutInput', null, 'mod+alt+Digit2', () => this.setLayout('input'), { checked: () => this.settings.layout === 'input' }),
      'view.layoutOutput': a('action.layoutOutput', null, 'mod+alt+Digit3', () => this.setLayout('output'), { checked: () => this.settings.layout === 'output' }),
      'view.zoomIn': a('action.zoomIn', 'zoomIn', ['mod+Equal', 'mod+shift+Equal', 'mod+NumpadAdd'], () => this.activeView?.zoomBy(ZOOM_FACTOR)),
      'view.zoomOut': a('action.zoomOut', 'zoomOut', ['mod+Minus', 'mod+NumpadSubtract'], () => this.activeView?.zoomBy(1 / ZOOM_FACTOR)),
      'view.zoomReset': a('action.zoomReset', 'zoomReset', ['mod+Digit0', 'mod+Numpad0'], () => this.activeView?.resetZoom()),
      'view.zoomFit': a('action.zoomFit', 'fit', null, () => this.activeView?.fit()),
      'help.shortcuts': a('action.shortcuts', 'keyboard', 'mod+KeyK', () => this.shortcutsDialog()),
      'help.about': a('action.about', 'info', null, () => this.aboutDialog()),
    };
  }

  run(id) {
    const a = this.actions[id];
    if (!a) return;
    if (a.enabled && !a.enabled()) return;
    a.run();
  }

  _menuItems(ids) {
    return ids.map((id) => {
      if (id === '-') return { separator: true };
      const a = this.actions[id];
      return {
        label: t(a.label),
        icon: a.icon,
        shortcut: this.isPhone() ? '' : formatShortcut(a.shortcut),
        disabled: a.enabled ? !a.enabled() : false,
        checked: a.checked ? a.checked() : undefined,
        action: () => this.run(id),
      };
    });
  }

  menus() {
    return {
      file: ['file.new', 'file.open', 'file.save', 'file.exportMmp', '-', 'file.importMedia', 'file.addCamera', 'file.addColor', 'file.relink'],
      edit: ['edit.undo', 'edit.redo', '-', 'layer.duplicate', 'layer.delete', 'layer.rename', '-', 'layer.lock', 'layer.hide', 'layer.solo', '-', 'layer.rotateCW', 'layer.rotateCCW', 'layer.rotate180', 'layer.flipH', 'layer.flipV', '-', 'layer.raise', 'layer.lower', 'layer.top', 'layer.bottom', '-', 'source.rename', 'source.delete', '-', 'edit.preferences'],
      layer: ['layer.addMesh', 'layer.addTriangle', 'layer.addEllipse', '-', 'play.toggle', 'play.rewind'],
      view: ['view.present', 'view.outputWindow', '-', 'view.controls', 'view.paintControls', 'view.sticky', 'view.testSignal', '-', 'view.layoutBoth', 'view.layoutInput', 'view.layoutOutput', '-', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', 'view.zoomFit'],
      help: ['help.shortcuts', 'help.about'],
    };
  }

  showNamedMenu(name, anchor) {
    showMenu(this._menuItems(this.menus()[name]), { anchor });
  }

  showMainMenu(anchor) {
    const m = this.menus();
    const items = [
      { header: t('menu.file') }, ...this._menuItems(m.file),
      { header: t('menu.layers') }, ...this._menuItems(m.layer),
      { header: t('menu.edit') }, ...this._menuItems(m.edit),
      { header: t('menu.view') }, ...this._menuItems(m.view.filter((id) => !id.startsWith('view.layout') && !(this.isPhone() && id.startsWith('view.zoom')))),
      { header: t('menu.help') }, ...this._menuItems(m.help),
    ];
    showMenu(items, { anchor, sheet: this.isPhone() ? true : null });
  }

  showAddMenu(anchor) {
    showMenu(this._menuItems(['file.importMedia', 'file.addCamera', 'file.addColor', '-', 'layer.addMesh', 'layer.addTriangle', 'layer.addEllipse']), { anchor });
  }

  showMappingContextMenu(x, y, win = window) {
    const m = this.getCurrentMapping();
    if (!m) return;
    const items = [
      { header: m.name },
      ...this._menuItems(['layer.rename', 'layer.duplicate', 'layer.delete', '-', 'layer.lock', 'layer.hide', 'layer.solo', '-', 'layer.rotateCW', 'layer.rotateCCW', 'layer.rotate180', 'layer.flipH', 'layer.flipV', '-', 'layer.raise', 'layer.lower', 'layer.top', 'layer.bottom']),
    ];
    showMenu(items, { x, y, doc: win.document });
  }

  /* ------------------------------------------------------------- toolbar */

  _buildToolbar() {
    const tools = document.getElementById('tools');
    const btn = (id, extraClass = '') => {
      const a = this.actions[id];
      return `<button type="button" class="tool ${extraClass}" data-action="${id}" data-i18n-title="${a.label}">${icon(a.icon)}</button>`;
    };
    tools.innerHTML = [
      '<div class="tool-group">', btn('edit.undo'), btn('edit.redo'), '</div>',
      '<div class="tool-group hide-compact">', btn('file.importMedia'), btn('file.addCamera'), btn('file.addColor'), '</div>',
      '<div class="tool-group show-compact"><button type="button" class="tool" data-add-menu data-i18n-title="action.add">' + icon('plus') + '</button></div>',
      '<div class="tool-group hide-compact">', btn('layer.addMesh'), btn('layer.addTriangle'), btn('layer.addEllipse'), '</div>',
      '<div class="tool-group">', btn('play.toggle', 'play-toggle'), btn('play.rewind', 'hide-xs'), '</div>',
      '<div class="tool-group">', btn('view.present'), btn('view.outputWindow', 'hide-compact'), '</div>',
    ].join('');
    tools.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-add-menu')) { this.showAddMenu(b); return; }
      if (b.dataset.action) this.run(b.dataset.action);
    });
    document.getElementById('menubar').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-menu]');
      if (b) this.showNamedMenu(b.dataset.menu, b);
    });
    document.getElementById('btn-main-menu').addEventListener('click', (e) => this.showMainMenu(e.currentTarget));
    document.getElementById('btn-main-menu').innerHTML = icon('menu');
    const layoutSeg = document.getElementById('layout-seg');
    layoutSeg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-layout]');
      if (b) this.setLayout(b.dataset.layout);
    });
  }

  _updateToolbarState() {
    if (!this.actions) return;
    for (const b of document.querySelectorAll('[data-action]')) {
      const a = this.actions[b.dataset.action];
      if (!a) continue;
      b.disabled = a.enabled ? !a.enabled() : false;
      if (a.checked) b.classList.toggle('active', !!a.checked());
    }
    const pb = document.querySelector('.play-toggle');
    if (pb) {
      pb.innerHTML = icon(this.playing ? 'pause' : 'play');
      pb.title = t(this.playing ? 'action.pause' : 'action.play') + ' (' + formatShortcut('Space') + ')';
    }
    const u = document.querySelector('[data-action="edit.undo"]');
    if (u) u.title = `${t('action.undo')}${this.history.undoLabel ? ': ' + t(this.history.undoLabel) : ''} (${formatShortcut('mod+KeyZ')})`;
    for (const b of document.querySelectorAll('#layout-seg button')) b.classList.toggle('active', b.dataset.layout === this.effectiveLayout());
  }

  /* -------------------------------------------------------------- layout */

  isCompact() {
    return matchMedia('(max-width: 760px), (max-height: 520px)').matches;
  }

  isPhone() {
    return matchMedia('(max-width: 760px)').matches;
  }

  effectiveLayout() {
    if (this.isCompact()) return this.mobileView || (this.settings.layout === 'input' ? 'input' : 'output');
    return this.settings.layout;
  }

  setLayout(layout) {
    if (this.isCompact()) this.mobileView = layout === 'both' ? 'output' : layout;
    else this.settings.layout = layout;
    this.saveSettings();
    this.applyLayout();
  }

  applyLayout() {
    const app = this.dom.app;
    const layout = this.effectiveLayout();
    app.dataset.layout = layout;
    app.classList.toggle('compact', this.isCompact());
    app.classList.toggle('phone', this.isPhone());
    document.body.classList.toggle('phone', this.isPhone());
    app.dataset.mtab = this.mobileTab;
    document.documentElement.style.setProperty('--sidebar-width', `${this.settings.sidebarWidth}px`);
    document.documentElement.style.setProperty('--views-split', String(this.settings.viewsSplit));
    const sheet = this.sheetOpen();
    for (const b of document.querySelectorAll('#mobile-nav button')) {
      const tab = b.dataset.mtab;
      const isView = tab === 'input' || tab === 'output';
      b.classList.toggle('active', isView ? layout === tab && !(this.isPhone() && sheet) : this.isPhone() ? sheet && this.mobileTab === tab : this.panels?.tab === tab);
    }
    this.panels?.setTab(this.mobileTab === 'layers' || this.mobileTab === 'sources' ? this.mobileTab : this.panels.tab);
    for (const v of this.allViews()) v._measure();
    this._updateToolbarState();
    this.invalidate();
  }

  sheetOpen() { return this.dom.app.classList.contains('sheet-open'); }

  setMobileTab(tab) {
    const app = this.dom.app;
    if (tab === 'input' || tab === 'output') {
      this.mobileView = tab;
      if (this.isPhone()) app.classList.remove('sheet-open');
    } else if (this.isPhone()) {
      if (this.mobileTab === tab && app.classList.contains('sheet-open')) app.classList.remove('sheet-open');
      else app.classList.add('sheet-open');
      this.mobileTab = tab;
      this.panels.setTab(tab);
    } else {
      this.mobileTab = tab;
      this.panels.setTab(tab);
    }
    this.applyLayout();
  }

  _setupSplitters() {
    const sidebarSplitter = document.getElementById('sidebar-splitter');
    const viewsSplitter = document.getElementById('views-splitter');
    const drag = (el, onMove) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        const move = (ev) => onMove(ev);
        const up = () => {
          el.classList.remove('dragging');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          this.saveSettings();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    };
    drag(sidebarSplitter, (e) => {
      const w = Math.min(Math.max(220, window.innerWidth - e.clientX), Math.min(620, window.innerWidth * 0.6));
      this.settings.sidebarWidth = Math.round(w);
      document.documentElement.style.setProperty('--sidebar-width', `${this.settings.sidebarWidth}px`);
    });
    drag(viewsSplitter, (e) => {
      const r = this.dom.views.getBoundingClientRect();
      const f = Math.min(0.85, Math.max(0.15, (e.clientY - r.top) / r.height));
      this.settings.viewsSplit = f;
      document.documentElement.style.setProperty('--views-split', String(f));
    });
  }

  /* ------------------------------------------------------ global events */

  _bindGlobalEvents() {
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    window.addEventListener('resize', () => this.applyLayout());
    document.getElementById('mobile-nav').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mtab]');
      if (b) this.setMobileTab(b.dataset.mtab);
    });
    // Drag & drop of media and project files.
    let dragDepth = 0;
    const hint = document.getElementById('drop-hint');
    document.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      hint.hidden = false;
    });
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    });
    document.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) hint.hidden = true;
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      hint.hidden = true;
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) this.openFiles(files);
    });
    window.addEventListener('beforeunload', () => {
      this.flushAutosave();
      this.output?.closeWindow();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushAutosave();
    });
    // Restore sound after autoplay restrictions on the first gesture.
    const unlock = () => this.unlockMedia();
    document.addEventListener('pointerdown', unlock, { capture: true });
    document.addEventListener('keydown', unlock, { capture: true });
  }

  unlockMedia() {
    for (const p of this.project.paints) if (p.unlockAudio) p.unlockAudio();
  }

  _isTyping(e) {
    const el = e.target;
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    return el.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'range', 'color'].includes(el.type));
  }

  /** Global keyboard handling (also used by the output window). */
  handleKeyDown(e) {
    if (e.defaultPrevented) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (isMenuOpen()) return;
    if (this._isTyping(e)) return;

    if (e.key === 'Escape') {
      if (this.output.isPresenting()) { this.output.exitPresentation(); e.preventDefault(); return; }
      if (this.activeView && this.activeView.activeVertex >= 0) { this.activeView.activeVertex = -1; this.invalidate(); e.preventDefault(); }
      return;
    }
    // Keys handled by the active view first (vertex nudging, Shift+Space).
    const view = this.activeView;
    const isArrow = e.key.startsWith('Arrow');
    if (view && (isArrow || (e.shiftKey && e.code === 'Space'))) {
      if (view.handleKey(e)) { e.preventDefault(); return; }
    }
    for (const [id, a] of Object.entries(this.actions)) {
      if (a.shortcut && matchShortcut(a.shortcut, e)) {
        e.preventDefault();
        this.run(id);
        return;
      }
    }
    // Shape modes (M = move vertices, S = scale, R = rotate).
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const modes = { KeyM: ShapeMode.Default, KeyS: ShapeMode.Scale, KeyR: ShapeMode.Rotate };
      if (e.code in modes && view) {
        const shape = view.getCurrentShape();
        if (shape) {
          shape.setShapeMode(modes[e.code]);
          this.invalidate();
          e.preventDefault();
        }
      }
    }
  }

  setActiveView(view) {
    if (this.activeView !== view) {
      this.activeView = view;
      this.emit('activeView', view);
    }
  }

  onViewChanged(view) {
    if (view === this.activeView) this._statusDirty = true;
  }

  /** Called while a shape is being edited interactively. */
  onShapeEdited() {
    this.invalidate();
    this.emit('shapeEdited');
  }

  setPointerPosition(view, p) {
    this.pointerInfo = { view, p };
    this._statusDirty = true;
  }

  /** Whether shape controls are drawn in a view (output window shows them on hover). */
  controlsVisibleIn(view) {
    if (!this.settings.displayControls) return false;
    if (!view.presentation) return true;
    if (this.settings.showTestSignal) return false;
    if (!this.settings.controlsOnHover) return true;
    if (view.hovered && view.lastPointerType === 'mouse') return true;
    return performance.now() - view.lastTouchTime < 4000;
  }

  toggleSetting(key) {
    this.settings[key] = !this.settings[key];
    this.saveSettings();
    this.emitChange();
    const labels = { displayControls: 'action.displayControls', stickyVertices: 'action.stickyVertices', showTestSignal: 'action.testSignal', displayPaintControls: 'action.displayPaintControls' };
    if (labels[key]) toast(`${t(labels[key])}: ${this.settings[key] ? t('common.on') : t('common.off')}`);
  }

  saveSettings() {
    try { localStorage.setItem('mapmap-web-settings', JSON.stringify(this.settings)); } catch { /* ignore */ }
  }

  allViews() {
    const list = [];
    if (this.views) list.push(this.views.input, this.views.output);
    if (this.output) list.push(...this.output.views());
    return list;
  }

  /* ---------------------------------------------------------- rendering */

  _tick() {
    this.renderFrame();
    requestAnimationFrame(() => this._tick());
  }

  /** Renders all views of the main window (output window has its own loop). */
  renderFrame(onlyViews = null) {
    const now = performance.now();
    if (!this._lastPaintUpdate || now - this._lastPaintUpdate > 4) {
      this._lastPaintUpdate = now;
      for (const p of this.project.paints) p.update(now);
    }
    const views = onlyViews || [this.views.input, this.views.output, ...(this.output.presentationView ? [this.output.presentationView] : [])];
    for (const v of views) {
      try { v.render(); } catch (err) { console.error(err); }
    }
    if (!onlyViews) {
      this._frames++;
      if (now - this._fpsTime > 1000) {
        this.fps = (this._frames * 1000) / (now - this._fpsTime);
        this._frames = 0;
        this._fpsTime = now;
        this._statusDirty = true;
      }
      if (this._statusDirty) this._updateStatus();
    }
  }

  _updateStatus() {
    this._statusDirty = false;
    const s = this.dom.status;
    if (!s) return;
    const m = this.getCurrentMapping();
    const p = this.getCurrentPaint();
    const set = (id, text) => { const el = s.querySelector(id); if (el && el.textContent !== text) el.textContent = text; };
    set('#st-layer', m ? `${t('status.layer')}: ${m.name}` : '');
    set('#st-source', p ? `${t('status.source')}: ${p.name}` : '');
    const view = this.activeView;
    set('#st-zoom', view ? `${t(view.kind === 'input' ? 'view.input' : 'view.output')} ${Math.round(view.zoom * 100)}%` : '');
    const info = this.pointerInfo;
    set('#st-pos', info ? `x ${Math.round(info.p.x)}  y ${Math.round(info.p.y)}` : '');
    set('#st-output', `${this.project.outputWidth}×${this.project.outputHeight}`);
    set('#st-fps', `${Math.round(this.fps)} FPS`);
  }

  /* ----------------------------------------------------------- playback */

  togglePlay() {
    this.playing = !this.playing;
    this.updatePlayingState();
    this.emitChange();
  }

  rewind() {
    for (const p of this.project.paints) p.rewind();
    this.invalidate();
  }

  /** Plays visible paints and pauses the others (port of MainWindow::updatePlayingState). */
  updatePlayingState() {
    const active = new Set(this.project.getVisiblePaints());
    const inputPaint = this.getInputPaint();
    if (inputPaint) active.add(inputPaint);
    for (const p of this.project.paints) {
      if (p.video) p.video.loop = this.settings.playInLoop;
      const shouldPlay = this.playing && active.has(p);
      if (shouldPlay && !p.playing) p.play();
      else if (!shouldPlay && p.playing) p.pause();
      else if (shouldPlay && p.video && p.video.paused && p.status === 'ready' && !p.video.ended) p.play();
    }
  }

  /* ------------------------------------------------------------ sources */

  async importMediaDialog() {
    const files = await pickFiles({ accept: 'image/*,video/*,.mov,.mp4,.m4v,.webm,.ogv,.mkv,.gif,.png,.jpg,.jpeg,.webp,.avif,.bmp,.svg', multiple: true });
    if (files.length) await this.importMediaFiles(files);
  }

  /** Imports images / videos as new sources. */
  async importMediaFiles(files) {
    let last = null;
    for (const file of files) {
      const isImage = isImageFile(file);
      const isVideo = !isImage && isVideoFile(file);
      if (!isImage && !isVideo) {
        toast(t('error.unsupportedFile', { name: file.name }), { kind: 'error' });
        continue;
      }
      const id = this.project.allocatePaintId();
      const paint = isImage ? new ImagePaint(id) : new VideoPaint(id);
      paint.name = file.name.replace(/\.[^.]+$/, '') || file.name;
      toast(t('status.loading', { name: file.name }), { timeout: 1500 });
      try {
        await paint.load(file, file.name);
      } catch {
        toast(t('error.cannotLoad', { name: file.name }), { kind: 'error', timeout: 5000 });
        paint.dispose();
        continue;
      }
      this.project.addPaint(paint);
      last = paint;
    }
    if (last) {
      this.currentMappingId = null;
      this.currentPaintId = last.id;
      if (this.views) this.views.input.needsFit = true;
      this.commit('history.addSource');
      this._fitInputIfNeeded();
      toast(t('status.fileImported'));
      if (this.isPhone()) this.setMobileTab('input');
    }
    return last;
  }

  async addColorDialog() {
    const body = document.createElement('div');
    const c = this.lastColor;
    const hex = '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('');
    body.innerHTML = `
      <label class="field"><span>${escapeHtml(t('prop.color'))}</span><input type="color" class="input color-input" value="${hex}"></label>
      <label class="field"><span>${escapeHtml(t('prop.alpha'))}</span><input type="range" min="0" max="255" value="${c.a}" class="range"></label>`;
    const r = await openModal({
      title: t('action.addColor').replace(/…$/, ''),
      body,
      buttons: [
        { label: t('common.cancel'), value: null },
        { label: t('common.add'), primary: true, value: (el) => ({ hex: el.querySelector('input[type=color]').value, a: +el.querySelector('input[type=range]').value }) },
      ],
    });
    if (!r) return;
    const color = { ...ColorPaint.parseColor(r.hex), a: r.a };
    this.lastColor = color;
    this.addColorPaint(color);
  }

  addColorPaint(color) {
    const paint = new ColorPaint(this.project.allocatePaintId(), color);
    paint.name = paint.hex;
    this.project.addPaint(paint);
    this.currentMappingId = null;
    this.currentPaintId = paint.id;
    this.commit('history.addSource');
    toast(t('status.colorAdded'));
    return paint;
  }

  async addCameraDialog() {
    if (!CameraPaint.supported) {
      alertDialog(t('error.noCamera'));
      return;
    }
    let devices = [];
    try { devices = await CameraPaint.listDevices(); } catch { /* ignore */ }
    let choice = { facingMode: this.coarsePointer ? 'environment' : '' };
    const labelled = devices.filter((d) => d.label);
    if (devices.length > 1 || this.coarsePointer) {
      const body = document.createElement('div');
      const opts = [];
      if (this.coarsePointer) {
        opts.push(`<option value="facing:environment">${escapeHtml(t('camera.back'))}</option>`);
        opts.push(`<option value="facing:user">${escapeHtml(t('camera.front'))}</option>`);
      }
      devices.forEach((d, i) => opts.push(`<option value="id:${escapeHtml(d.deviceId)}">${escapeHtml(d.label || t('camera.device', { n: i + 1 }))}</option>`));
      if (!opts.length) opts.push(`<option value="">${escapeHtml(t('camera.default'))}</option>`);
      body.innerHTML = `<label class="field"><span>${escapeHtml(t('camera.select'))}</span><select class="input">${opts.join('')}</select></label>`;
      const r = await openModal({
        title: t('action.addCamera').replace(/…$/, ''),
        body,
        buttons: [{ label: t('common.cancel'), value: null }, { label: t('common.add'), primary: true, value: (el) => el.querySelector('select').value }],
      });
      if (r === null) return;
      if (r.startsWith('facing:')) choice = { facingMode: r.slice(7) };
      else if (r.startsWith('id:')) {
        const dev = devices.find((d) => d.deviceId === r.slice(3));
        choice = { deviceId: r.slice(3), label: dev?.label };
      }
    } else if (labelled.length === 1) {
      choice = { deviceId: labelled[0].deviceId, label: labelled[0].label };
    }
    const paint = new CameraPaint(this.project.allocatePaintId());
    try {
      await paint.open(choice);
    } catch (err) {
      console.warn(err);
      alertDialog(t(err && err.name === 'NotAllowedError' ? 'error.cameraDenied' : 'error.cameraFailed'));
      paint.dispose();
      return;
    }
    paint.name = paint.uri.replace(/^camera:/, '') || t('camera.default');
    this.project.addPaint(paint);
    this.currentMappingId = null;
    this.currentPaintId = paint.id;
    if (this.views) this.views.input.needsFit = true;
    this.commit('history.addSource');
    this._fitInputIfNeeded();
  }

  async renamePaint(paint = this.getCurrentPaint()) {
    if (!paint) return;
    const name = await promptDialog(t('prop.name'), paint.name, { title: t('action.renameSource') });
    if (name === null || name === paint.name) return;
    paint.name = name;
    this.commit('history.renameSource');
  }

  async deletePaint(paint = this.getCurrentPaint()) {
    if (!paint) return;
    const n = this.project.getPaintMappings(paint).length;
    const ok = await confirmDialog(n ? t('confirm.deleteSourceWithLayers', { n }) : t('confirm.deleteSource'), { ok: t('common.delete'), danger: true });
    if (!ok) return;
    this.project.removePaint(paint.id);
    paint.deactivate();
    this._validateSelection();
    this.commit('history.deleteSource');
  }

  /* ------------------------------------------------------------- layers */

  addLayer(type, paint = this.getCurrentPaint()) {
    if (!paint) {
      toast(t('error.selectSourceFirst'), { kind: 'error' });
      return null;
    }
    const project = this.project;
    const id = project.allocateMappingId();
    let mapping;
    if (paint.isTexture()) {
      const rect = paint.getRect();
      const input = createShapeForTexture(type, rect);
      const output = input.clone();
      // Center the output shape in the output area (and scale it down if it is bigger).
      const W = project.outputWidth, H = project.outputHeight;
      const s = Math.min(1, (W * 0.9) / rect.width, (H * 0.9) / rect.height);
      const tr = Affine.translation(-(rect.x + rect.width / 2), -(rect.y + rect.height / 2))
        .then(Affine.scaling(s))
        .then(Affine.translation(W / 2, H / 2));
      output.applyTransform(tr);
      mapping = new Mapping(id, paint, output, input);
    } else {
      mapping = new Mapping(id, paint, createShapeForColor(type, project.outputWidth, project.outputHeight));
    }
    mapping.name = `${t('shape.' + type)} ${id}`;
    project.addMapping(mapping);
    project.updateMappingsDepths();
    this.currentMappingId = mapping.id;
    this.currentPaintId = paint.id;
    this.commit('history.addLayer');
    if (this.isPhone() && this.sheetOpen()) this.dom.app.classList.remove('sheet-open');
    if (this.isCompact()) { this.mobileView = 'output'; this.applyLayout(); }
    return mapping;
  }

  duplicateMapping(m = this.getCurrentMapping()) {
    if (!m) return;
    const json = m.toJSON();
    json.id = this.project.allocateMappingId();
    json.name = `${t('shape.' + m.type)} ${json.id}`;
    json.solo = false;
    const clone = Mapping.fromJSON(json, m.paint);
    this.project.addMapping(clone);
    this.project.updateMappingsDepths();
    this.currentMappingId = clone.id;
    this.commit('history.duplicateLayer');
  }

  deleteMapping(m = this.getCurrentMapping()) {
    if (!m) return;
    this.project.removeMapping(m.id);
    if (this.currentMappingId === m.id) this.currentMappingId = null;
    this.commit('history.deleteLayer');
  }

  async renameMapping(m = this.getCurrentMapping()) {
    if (!m) return;
    const name = await promptDialog(t('prop.name'), m.name, { title: t('action.renameLayer') });
    if (name === null || name === m.name) return;
    m.name = name;
    this.commit('history.renameLayer');
  }

  toggleMappingProp(prop, m = this.getCurrentMapping()) {
    if (!m) return;
    if (prop === 'locked') m.setLocked(!m.locked);
    else m[prop] = !m[prop];
    this.commit(prop === 'locked' ? 'history.lockLayer' : prop === 'solo' ? 'history.soloLayer' : 'history.hideLayer');
  }

  /** Rotations and flips of the output shape (port of RotateShapeCommand / FlipShapeCommand). */
  transformMapping(op, m = this.getCurrentMapping()) {
    if (!m) return;
    const view = this.activeView && !this.activeView.presentation ? this.activeView : this.views.output;
    const shape = view.getShapeFromMapping(m) || m.shape;
    if (shape.locked) return;
    const c = shape.getCenter();
    const tr = {
      rotateCW: { rotate: Math.PI / 2 },
      rotateCCW: { rotate: -Math.PI / 2 },
      rotate180: { rotate: Math.PI },
      flipH: { scaleX: -1 },
      flipV: { scaleY: -1 },
    }[op];
    shape.applyTransform(Affine.aroundCenter(c, tr));
    if (shape.build && shape.type === 'ellipse') shape.build();
    this.commit(op.startsWith('flip') ? 'history.flipShape' : 'history.rotateShape');
  }

  moveMappingBy(how, m = this.getCurrentMapping()) {
    if (!m) return;
    const idx = this.project.getMappingIndex(m.id);
    const max = this.project.mappings.length - 1;
    const to = { raise: Math.max(idx - 1, 0), lower: Math.min(idx + 1, max), top: 0, bottom: max }[how];
    if (to === idx) return;
    this.project.moveMapping(m.id, to);
    this.commit(how === 'raise' || how === 'top' ? 'history.raiseLayer' : 'history.lowerLayer');
  }

  setMappingPaint(m, paint) {
    if (!m || !paint || !m.paintIsCompatible(paint) || m.paint === paint) return;
    m.paint = paint;
    this.currentPaintId = paint.id;
    this.commit('history.changeSource');
  }

  resizeMesh(m, nColumns, nRows) {
    if (!m || m.shape.type !== 'mesh') return;
    m.shape.resize(nColumns, nRows);
    if (m.inputShape && m.inputShape.type === 'mesh') m.inputShape.resize(nColumns, nRows);
    this.commit('history.meshSubdivisions');
  }

  /* ---------------------------------------------------- project files */

  async newProject(skipConfirm = false) {
    if (!skipConfirm && this.project.paints.length) {
      const ok = await confirmDialog(t('confirm.newProject'), { ok: t('action.new') });
      if (!ok) return;
    }
    this._replaceProject(new Project(), 'mapmap');
    try { await storage.clearMedia(); } catch { /* ignore */ }
    this._storedMedia.clear();
    this.flushAutosave();
    toast(t('status.newProject'));
  }

  _replaceProject(project, name) {
    for (const p of this.project.paints) p.dispose();
    this.project = project;
    this.projectName = name || 'mapmap';
    this.currentMappingId = null;
    this.currentPaintId = null;
    if (project.mappings.length) {
      this.currentMappingId = project.mappings[0].id;
      this.currentPaintId = project.mappings[0].paint.id;
    }
    this._validateSelection();
    this.history.reset(this._historyState('history.open'));
    for (const v of this.allViews()) { v.needsFit = true; v.activeVertex = -1; v.fit(); }
    this.updatePlayingState();
    this.emitChange();
  }

  async openProjectDialog() {
    const files = await pickFiles({ accept: '.mmp,.mmpz,.zip,application/zip,application/xml,text/xml,image/*,video/*', multiple: true });
    if (files.length) await this.openFiles(files);
  }

  /** Opens any mix of project files (.mmp/.mmpz) and media files. */
  async openFiles(files) {
    const projects = files.filter((f) => ['mmp', 'mmpz', 'zip'].includes(fileExtension(f.name)));
    const media = files.filter((f) => !projects.includes(f));
    if (projects.length) {
      if (this.project.paints.length) {
        const ok = await confirmDialog(t('confirm.openProject'), { ok: t('action.open') });
        if (!ok) return;
      }
      await this.loadProjectFile(projects[0], media);
    } else if (media.length) {
      await this.importMediaFiles(media);
    }
  }

  async loadProjectFile(file, extraMedia = []) {
    const ext = fileExtension(file.name);
    let parsed;
    let zipEntries = null;
    try {
      if (ext === 'mmp') {
        parsed = parseMmp(await file.text());
      } else {
        zipEntries = await readZip(file);
        const mmpEntry = [...zipEntries.values()].find((e) => e.name.toLowerCase().endsWith('.mmp'));
        if (!mmpEntry) throw new ProjectFormatError('not-a-project');
        parsed = parseMmp(await mmpEntry.text());
      }
    } catch (err) {
      console.warn(err);
      alertDialog(err instanceof ProjectFormatError && err.message === 'version' ? t('error.projectVersion') : t('error.projectInvalid'));
      return;
    }
    const { project, media } = parsed;
    const name = file.name.replace(/\.[^.]+$/, '');
    this._replaceProject(project, name);
    try { await storage.clearMedia(); } catch { /* ignore */ }
    this._storedMedia.clear();

    const byName = new Map(extraMedia.map((f) => [f.name.toLowerCase(), f]));
    const loads = [];
    for (const { paint, uri } of media) {
      if (paint.kind === 'camera') { loads.push(paint.open({ deviceId: paint.deviceId, facingMode: paint.facingMode }).catch(() => { paint.status = 'error'; })); continue; }
      let blob = null;
      if (zipEntries) {
        const entry = zipEntries.get(uri) || [...zipEntries.values()].find((e) => baseName(e.name).toLowerCase() === baseName(uri).toLowerCase());
        if (entry) blob = await entry.blob();
      }
      if (!blob) blob = byName.get(baseName(uri).toLowerCase()) || null;
      if (blob) {
        loads.push(paint.load(blob instanceof File ? blob : new File([blob], baseName(uri), { type: blob.type || mimeFromName(uri) }), uri).catch(() => { paint.status = 'error'; }));
      } else {
        paint.status = 'missing';
      }
    }
    await Promise.all(loads);
    this.updatePlayingState();
    this.emitChange();
    for (const v of this.allViews()) v.fit();
    this.scheduleAutosave();
    const missing = this.missingMedia();
    if (missing.length) {
      toast(t('status.mediaMissing', { n: missing.length }), { timeout: 5000 });
      this.relinkMediaDialog();
    } else {
      toast(t('status.projectOpened', { name }));
    }
  }

  missingMedia() {
    return this.project.paints.filter((p) => (p.kind === 'image' || p.kind === 'video') && (p.status === 'missing' || p.status === 'error'));
  }

  async relinkMediaDialog() {
    const missing = this.missingMedia();
    if (!missing.length) return;
    const body = document.createElement('div');
    body.innerHTML = `<p>${escapeHtml(t('relink.text'))}</p><ul class="relink-list">${missing.map((p) => `<li><strong>${escapeHtml(baseName(p.uri) || p.name)}</strong><small>${escapeHtml(p.uri)}</small></li>`).join('')}</ul>`;
    const r = await openModal({
      title: t('action.relink').replace(/…$/, ''),
      body,
      buttons: [{ label: t('common.later'), value: false }, { label: t('relink.select'), primary: true, value: true }],
    });
    if (!r) return;
    const files = await pickFiles({ accept: 'image/*,video/*', multiple: true });
    if (!files.length) return;
    const remaining = [...files];
    const loads = [];
    for (const p of missing) {
      const name = baseName(p.uri).toLowerCase();
      let idx = remaining.findIndex((f) => f.name.toLowerCase() === name);
      if (idx < 0 && missing.length === 1 && remaining.length === 1) idx = 0;
      if (idx < 0) continue;
      const [f] = remaining.splice(idx, 1);
      loads.push(p.load(f, p.uri).catch(() => { p.status = 'error'; }));
    }
    await Promise.all(loads);
    this.updatePlayingState();
    this.emitChange();
    this.scheduleAutosave();
    const still = this.missingMedia().length;
    toast(still ? t('status.mediaMissing', { n: still }) : t('status.mediaRelinked'));
  }

  /** Saves a portable bundle (.mmpz = zip with project.mmp + media files). */
  async saveBundle() {
    const entries = [];
    const paths = new Map();
    const used = new Set();
    for (const p of this.project.paints) {
      if ((p.kind === 'image' || p.kind === 'video') && p.blob) {
        let name = baseName(p.uri) || `${p.kind}-${p.id}`;
        name = name.replace(/[\\/:*?"<>|]/g, '_');
        let path = `media/${name}`;
        if (used.has(path)) path = `media/${p.id}-${name}`;
        used.add(path);
        paths.set(p.id, path);
        entries.push({ name: path, data: p.blob });
      }
    }
    const xml = writeMmp(this.project, { uriFor: (p) => paths.get(p.id) || p.uri });
    entries.unshift({ name: 'project.mmp', data: xml });
    toast(t('status.saving'), { timeout: 1200 });
    try {
      const zip = await createZip(entries);
      await this.saveBlob(zip, `${this.projectName || 'mapmap'}.mmpz`, 'application/zip');
    } catch (err) {
      console.error(err);
      alertDialog(t('error.saveFailed'));
    }
  }

  /** Exports a plain .mmp file (for the desktop MapMap; media referenced by file name). */
  async exportMmp() {
    const xml = writeMmp(this.project, { uriFor: (p) => p.uri });
    await this.saveBlob(new Blob([xml], { type: 'application/xml' }), `${this.projectName || 'mapmap'}.mmp`, 'application/xml');
  }

  async saveBlob(blob, filename, mime) {
    // Native "save as" where available (Chrome/Edge desktop).
    if (window.showSaveFilePicker && !this.coarsePointer) {
      try {
        const ext = filename.slice(filename.lastIndexOf('.'));
        const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'MapMap', accept: { [mime]: [ext] } }] });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        this.projectName = handle.name.replace(/\.[^.]+$/, '');
        toast(t('status.saved', { name: handle.name }));
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    downloadBlob(blob, filename);
    toast(t('status.downloaded', { name: filename }));
  }

  /* ----------------------------------------------------------- autosave */

  scheduleAutosave() {
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => this.flushAutosave(), 700);
  }

  async flushAutosave() {
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = null;
    try {
      const json = this.project.toJSON();
      json.projectName = this.projectName;
      json.currentMappingId = this.currentMappingId;
      json.currentPaintId = this.currentPaintId;
      json.playing = this.playing;
      await storage.set('project', json);
      const ids = new Set();
      for (const p of this.project.paints) {
        if ((p.kind === 'image' || p.kind === 'video') && p.blob) {
          ids.add(p.id);
          if (this._storedMedia.get(p.id) !== p.blob) {
            await storage.putMedia(p.id, { blob: p.blob, name: p.uri, type: p.blob.type });
            this._storedMedia.set(p.id, p.blob);
          }
        }
      }
      for (const key of await storage.mediaKeys()) {
        if (!ids.has(key)) { await storage.deleteMedia(key); this._storedMedia.delete(key); }
      }
      this._setSaveStatus(t('status.autosaved'));
    } catch (err) {
      console.warn('Autosave failed', err);
      this._setSaveStatus(t('status.autosaveFailed'));
      if (!this._autosaveWarned && err && err.name === 'QuotaExceededError') {
        this._autosaveWarned = true;
        toast(t('error.quota'), { kind: 'error', timeout: 6000 });
      }
    }
  }

  _setSaveStatus(text) {
    const el = document.getElementById('st-save');
    if (el) el.textContent = text;
  }

  async restoreAutosave() {
    let json = null;
    try { json = await storage.get('project'); } catch { /* ignore */ }
    if (!json || json.format !== 'mapmap-web') return false;
    let project;
    try { project = Project.fromJSON(json); } catch (err) { console.warn(err); return false; }
    this._replaceProject(project, json.projectName);
    const loads = [];
    for (const p of project.paints) {
      if (p.kind === 'camera') {
        loads.push(p.open({ deviceId: p.deviceId, facingMode: p.facingMode }).catch(() => { p.status = 'error'; }));
      } else if (p.kind === 'image' || p.kind === 'video') {
        loads.push((async () => {
          const rec = await storage.getMedia(p.id).catch(() => null);
          if (!rec || !rec.blob) { p.status = 'missing'; return; }
          const file = rec.blob instanceof File ? rec.blob : new File([rec.blob], baseName(rec.name || p.uri), { type: rec.type || rec.blob.type });
          await p.load(file, p.uri).catch(() => { p.status = 'error'; });
          this._storedMedia.set(p.id, p.blob);
        })());
      }
    }
    this.currentMappingId = json.currentMappingId ?? this.currentMappingId;
    this.currentPaintId = json.currentPaintId ?? this.currentPaintId;
    if (json.playing === false) this.playing = false;
    this._validateSelection();
    this.history.reset(this._historyState('history.open'));
    this.emitChange();
    await Promise.all(loads);
    this.updatePlayingState();
    this.emitChange();
    for (const v of this.allViews()) v.fit();
    if (this.missingMedia().length) toast(t('status.mediaMissing', { n: this.missingMedia().length }), { timeout: 5000 });
    return true;
  }

  /* ------------------------------------------------------------ dialogs */

  async preferencesDialog() {
    const s = this.settings;
    const p = this.project;
    const body = document.createElement('div');
    body.className = 'prefs';
    const screenW = Math.round(screen.width * (window.devicePixelRatio || 1));
    const screenH = Math.round(screen.height * (window.devicePixelRatio || 1));
    const presets = [[1920, 1080], [1280, 720], [1280, 800], [1024, 768], [1400, 1050], [1920, 1200], [2560, 1440], [3840, 2160]];
    body.innerHTML = `
      <fieldset><legend>${escapeHtml(t('prefs.general'))}</legend>
        <label class="field"><span>${escapeHtml(t('prefs.language'))}</span>
          <select class="input" name="lang">
            <option value="auto">${escapeHtml(t('prefs.langAuto'))}</option>
            ${LANGUAGES.map((l) => `<option value="${l.code}">${escapeHtml(l.name)}</option>`).join('')}
          </select></label>
      </fieldset>
      <fieldset><legend>${escapeHtml(t('prefs.output'))}</legend>
        <div class="field"><span>${escapeHtml(t('prefs.resolution'))}</span>
          <div class="row">
            <input type="number" class="input num" name="ow" min="16" max="16384" value="${p.outputWidth}"> ×
            <input type="number" class="input num" name="oh" min="16" max="16384" value="${p.outputHeight}">
            <select class="input" name="preset">
              <option value="">${escapeHtml(t('prefs.presets'))}</option>
              <option value="${screenW}x${screenH}">${escapeHtml(t('prefs.thisScreen'))} (${screenW}×${screenH})</option>
              ${presets.map(([w, h]) => `<option value="${w}x${h}">${w}×${h}</option>`).join('')}
            </select>
          </div>
          <small>${escapeHtml(t('prefs.resolutionHint'))}</small>
        </div>
        <label class="field"><span>${escapeHtml(t('prefs.fit'))}</span>
          <select class="input" name="fit">
            <option value="contain">${escapeHtml(t('prefs.fitContain'))}</option>
            <option value="stretch">${escapeHtml(t('prefs.fitStretch'))}</option>
          </select></label>
        <label class="check"><input type="checkbox" name="hover"> ${escapeHtml(t('prefs.controlsOnHover'))}</label>
      </fieldset>
      <fieldset><legend>${escapeHtml(t('prefs.testSignal'))}</legend>
        <label class="field"><span>${escapeHtml(t('prefs.testCard'))}</span>
          <select class="input" name="card">
            <option value="0">${escapeHtml(t('prefs.cardClassic'))}</option>
            <option value="1">PAL</option>
            <option value="2">NTSC</option>
          </select></label>
        <label class="check"><input type="checkbox" name="res"> ${escapeHtml(t('prefs.showResolution'))}</label>
      </fieldset>
      <fieldset><legend>${escapeHtml(t('prefs.editing'))}</legend>
        <label class="field"><span>${escapeHtml(t('prefs.stickRadius'))}</span><input type="number" class="input num" name="stick" min="1" max="200" value="${s.stickRadius}"></label>
        <label class="check"><input type="checkbox" name="loop"> ${escapeHtml(t('prefs.playInLoop'))}</label>
      </fieldset>`;
    body.querySelector('[name=lang]').value = s.lang;
    body.querySelector('[name=fit]').value = s.outputFit;
    body.querySelector('[name=card]').value = String(s.testCard);
    body.querySelector('[name=hover]').checked = s.controlsOnHover;
    body.querySelector('[name=res]').checked = s.showResolution;
    body.querySelector('[name=loop]').checked = s.playInLoop;
    body.querySelector('[name=preset]').addEventListener('change', (e) => {
      const [w, h] = e.target.value.split('x').map(Number);
      if (w && h) {
        body.querySelector('[name=ow]').value = w;
        body.querySelector('[name=oh]').value = h;
      }
      e.target.value = '';
    });
    const r = await openModal({
      title: t('action.preferences').replace(/…$/, ''),
      body,
      className: 'modal-wide',
      buttons: [{ label: t('common.cancel'), value: null }, { label: t('common.ok'), primary: true, value: (el) => el }],
    });
    if (!r) return;
    const q = (n) => r.querySelector(`[name=${n}]`);
    const langChanged = q('lang').value !== s.lang;
    s.lang = q('lang').value;
    s.outputFit = q('fit').value;
    s.testCard = +q('card').value;
    s.controlsOnHover = q('hover').checked;
    s.showResolution = q('res').checked;
    s.playInLoop = q('loop').checked;
    s.stickRadius = Math.max(1, Math.min(200, +q('stick').value || 20));
    this.saveSettings();
    const ow = Math.round(+q('ow').value), oh = Math.round(+q('oh').value);
    if (ow >= 16 && oh >= 16 && (ow !== p.outputWidth || oh !== p.outputHeight)) {
      p.outputWidth = Math.min(16384, ow);
      p.outputHeight = Math.min(16384, oh);
      this.commit('history.outputSize');
      this.views.output.fit();
    }
    if (langChanged) {
      setLanguage(s.lang);
      this.i18nApply(document);
      this.output.onLanguageChanged();
      this.panels.onLanguageChanged();
      for (const v of this.allViews()) v.viewVersion++;
      this._setSaveStatus('');
    }
    this.updatePlayingState();
    this.emitChange();
  }

  shortcutsDialog() {
    const groups = [
      ['menu.file', ['file.new', 'file.open', 'file.save', 'file.exportMmp', 'file.importMedia', 'file.addCamera', 'file.addColor']],
      ['menu.layers', ['layer.addMesh', 'layer.addTriangle', 'layer.addEllipse', 'layer.duplicate', 'layer.delete', 'layer.rename', 'layer.flipH', 'layer.flipV', 'layer.raise', 'layer.lower', 'layer.top', 'layer.bottom']],
      ['menu.playback', ['play.toggle', 'play.rewind']],
      ['menu.view', ['view.present', 'view.outputWindow', 'view.controls', 'view.sticky', 'view.testSignal', 'view.layoutBoth', 'view.layoutInput', 'view.layoutOutput', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset']],
      ['menu.edit', ['edit.undo', 'edit.redo', 'edit.preferences', 'help.shortcuts']],
    ];
    const row = (keys, label) => `<tr><td><kbd>${escapeHtml(keys)}</kbd></td><td>${escapeHtml(label)}</td></tr>`;
    let html = '<div class="shortcuts">';
    for (const [title, ids] of groups) {
      html += `<table><caption>${escapeHtml(t(title))}</caption>`;
      for (const id of ids) {
        const a = this.actions[id];
        const specs = Array.isArray(a.shortcut) ? a.shortcut : [a.shortcut];
        const shown = specs.filter((sp) => sp && !sp.includes('Numpad') && sp !== 'mod+shift+Equal');
        html += row(shown.map(formatShortcut).join(' / '), t(a.label));
      }
      html += '</table>';
    }
    html += `<table><caption>${escapeHtml(t('shortcuts.editing'))}</caption>
      ${row('M / S / R', t('shortcuts.modes'))}
      ${row(t('shortcuts.arrows'), t('shortcuts.moveVertex'))}
      ${row(formatShortcut('shift') + t('shortcuts.arrows'), t('shortcuts.moveVertexBig'))}
      ${row(formatShortcut('alt') + t('shortcuts.arrows'), t('shortcuts.moveVertexSmall'))}
      ${row(formatShortcut('shift') + t('key.space'), t('shortcuts.nextVertex'))}
      ${row(formatShortcut('shift') + t('shortcuts.drag'), t('shortcuts.toggleSticky'))}
      ${row(t('shortcuts.wheel'), t('shortcuts.pan'))}
      ${row(formatShortcut('mod') + t('shortcuts.wheel'), t('shortcuts.zoom'))}
      ${row('Esc', t('shortcuts.escape'))}
    </table>
    <table><caption>${escapeHtml(t('shortcuts.touch'))}</caption>
      ${row(t('shortcuts.tapShape'), t('shortcuts.tapShapeText'))}
      ${row(t('shortcuts.twoFingers'), t('shortcuts.twoFingersText'))}
      ${row(t('shortcuts.longPress'), t('shortcuts.longPressText'))}
    </table></div>`;
    openModal({ title: t('action.shortcuts'), body: html, className: 'modal-wide', buttons: [] });
  }

  aboutDialog() {
    openModal({
      title: t('action.about'),
      body: `
        <div class="about">
          <img src="icons/icon-192.png" alt="" width="72" height="72">
          <div>
            <h3>MapMap Web <small>${APP_VERSION}</small></h3>
            <p>${escapeHtml(t('about.text'))}</p>
            <p>${escapeHtml(t('about.port'))}</p>
            <p>${escapeHtml(t('about.authors'))}: Sofian Audry, Dame Diongue, Alexandre Quessy, Mike Latona, Vasilis Liaskovitis ${escapeHtml(t('about.andContributors'))}.</p>
            <p><a href="https://github.com/mapmapteam/mapmap" target="_blank" rel="noopener">github.com/mapmapteam/mapmap</a> · GNU GPL v3</p>
          </div>
        </div>`,
      buttons: [{ label: t('common.close'), value: true, primary: true }],
    });
  }
}

function mimeFromName(name) {
  const ext = fileExtension(name);
  const map = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg', mkv: 'video/x-matroska', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif' };
  return map[ext] || '';
}

export { closeMenu, getLanguage };
