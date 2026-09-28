/*
 * MapMap Web - side panels: source library, layer list and property editors.
 * Port of the paint list / mapping list and of src/gui/PaintGui.cpp and MappingGui.cpp.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { icon } from './icons.js';
import { escapeHtml, showMenu } from './widgets.js';
import { t } from '../i18n.js';
import { CameraPaint } from '../model/paints.js';

const SHAPE_ICONS = { mesh: 'mesh', triangle: 'triangle', ellipse: 'ellipse', quad: 'quad' };
const KIND_ICONS = { color: 'color', image: 'media', video: 'video', camera: 'camera' };

export class Panels {
  constructor(app) {
    this.app = app;
    this.tab = 'sources';
    this.root = document.getElementById('sidebar');
    this.sourcesList = document.getElementById('sources-list');
    this.layersList = document.getElementById('layers-list');
    this.sourceProps = document.getElementById('source-props');
    this.layerProps = document.getElementById('layer-props');
    this._propsKey = { source: '', layer: '' };
    this._refreshers = { source: [], layer: [] };
    this._thumbs = new Map();

    this._buildToolbars();
    this.root.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (b) { this.setTab(b.dataset.tab); this.app.mobileTab = b.dataset.tab; this.app.applyLayout(); }
    });
    this.sourcesList.addEventListener('click', (e) => this._onSourceClick(e));
    this.sourcesList.addEventListener('dblclick', (e) => {
      const li = e.target.closest('[data-id]');
      if (li) this.app.renamePaint(this.app.project.getPaintById(+li.dataset.id));
    });
    this.layersList.addEventListener('click', (e) => this._onLayerClick(e));
    this.layersList.addEventListener('dblclick', (e) => {
      const li = e.target.closest('[data-id]');
      if (li && !e.target.closest('button')) this.app.renameMapping(this.app.project.getMappingById(+li.dataset.id));
    });
    this.layersList.addEventListener('contextmenu', (e) => {
      const li = e.target.closest('[data-id]');
      if (!li) return;
      e.preventDefault();
      this.app.setCurrentMapping(+li.dataset.id);
      this.app.showMappingContextMenu(e.clientX, e.clientY);
    });
    this._setupLayerDrag();

    app.on('change', () => this.refresh());
    app.on('shapeEdited', () => this._refreshValues('layer'));
    setInterval(() => this._updateThumbnails(), 1000);
    this.setTab(this.tab);
  }

  setTab(tab) {
    if (tab !== 'sources' && tab !== 'layers') return;
    this.tab = tab;
    for (const b of this.root.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    this.root.dataset.tab = tab;
  }

  _buildToolbars() {
    const st = document.getElementById('sources-toolbar');
    st.innerHTML = `
      <button type="button" class="btn btn-small" data-action="file.importMedia">${icon('media')}<span data-i18n="panel.addMedia"></span></button>
      <button type="button" class="btn btn-small" data-action="file.addCamera">${icon('camera')}<span data-i18n="panel.addCamera"></span></button>
      <button type="button" class="btn btn-small" data-action="file.addColor">${icon('color')}<span data-i18n="panel.addColor"></span></button>`;
    const lt = document.getElementById('layers-toolbar');
    lt.innerHTML = `
      <button type="button" class="btn btn-small" data-action="layer.addMesh" data-i18n-title="action.addMesh">${icon('mesh')}<span data-i18n="shape.mesh"></span></button>
      <button type="button" class="btn btn-small" data-action="layer.addTriangle" data-i18n-title="action.addTriangle">${icon('triangle')}<span data-i18n="shape.triangle"></span></button>
      <button type="button" class="btn btn-small" data-action="layer.addEllipse" data-i18n-title="action.addEllipse">${icon('ellipse')}<span data-i18n="shape.ellipse"></span></button>
      <span class="spacer"></span>
      <button type="button" class="icon-btn" data-action="layer.duplicate" data-i18n-title="action.duplicateLayer">${icon('duplicate')}</button>
      <button type="button" class="icon-btn" data-action="layer.raise" data-i18n-title="action.raise">${icon('up')}</button>
      <button type="button" class="icon-btn" data-action="layer.lower" data-i18n-title="action.lower">${icon('down')}</button>
      <button type="button" class="icon-btn" data-action="layer.delete" data-i18n-title="action.deleteLayer">${icon('trash')}</button>`;
    for (const el of [st, lt]) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-action]');
        if (b) this.app.run(b.dataset.action);
      });
    }
    this.app.i18nApply(this.root);
  }

  refresh() {
    this._renderSources();
    this._renderLayers();
    this._renderSourceProps();
    this._renderLayerProps();
  }

  /* ------------------------------------------------------------ sources */

  _thumbFor(paint) {
    if (paint.kind === 'color') return `<span class="thumb swatch" style="background:${paint.css}"></span>`;
    return `<canvas class="thumb" width="48" height="36" data-thumb="${paint.id}"></canvas>`;
  }

  _updateThumbnails() {
    for (const c of document.querySelectorAll('canvas[data-thumb]')) {
      const paint = this.app.project.getPaintById(+c.dataset.thumb);
      if (!paint) continue;
      const key = `${paint.status}:${paint.kind === 'image' ? paint.version : Math.floor(performance.now() / 3000)}`;
      if (c.dataset.key === key) continue;
      const src = paint.getTextureSource();
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1b1d26';
      ctx.fillRect(0, 0, c.width, c.height);
      if (src && paint.ready) {
        try {
          const s = Math.min(c.width / paint.width, c.height / paint.height);
          const w = paint.width * s, h = paint.height * s;
          ctx.drawImage(src, (c.width - w) / 2, (c.height - h) / 2, w, h);
          c.dataset.key = key;
        } catch { /* not ready */ }
      } else {
        ctx.fillStyle = paint.status === 'loading' ? '#888' : '#e0303c';
        ctx.font = 'bold 18px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(paint.status === 'loading' ? '…' : '!', c.width / 2, c.height / 2);
        c.dataset.key = key;
      }
    }
  }

  _renderSources() {
    const app = this.app;
    const project = app.project;
    if (!project.paints.length) {
      this.sourcesList.innerHTML = `<li class="empty">${escapeHtml(t('panel.noSources'))}</li>`;
      return;
    }
    const current = app.getCurrentPaint();
    this.sourcesList.innerHTML = project.paints.map((p) => {
      const n = project.getPaintMappings(p).length;
      const kind = t('kind.' + p.kind);
      const info = p.isTexture() ? (p.ready ? `${p.width}×${p.height}` : t(p.status === 'loading' ? 'view.loading' : 'panel.missing')) : p.hex.toUpperCase();
      const warn = p.isTexture() && (p.status === 'missing' || p.status === 'error');
      return `<li class="item ${p === current ? 'selected' : ''} ${warn ? 'warn' : ''}" data-id="${p.id}" tabindex="0">
        ${this._thumbFor(p)}
        <span class="item-text"><span class="item-name">${escapeHtml(p.name)}</span>
        <small>${icon(KIND_ICONS[p.kind], 'mini')} ${escapeHtml(kind)} · ${escapeHtml(info)} · ${escapeHtml(t('panel.layerCount', { n }))}</small></span>
        <button type="button" class="icon-btn" data-act="more" data-i18n-title="common.more" title="${escapeHtml(t('common.more'))}">${icon('more')}</button>
      </li>`;
    }).join('');
    this._updateThumbnails();
  }

  _onSourceClick(e) {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    const paint = this.app.project.getPaintById(+li.dataset.id);
    if (!paint) return;
    const act = e.target.closest('button')?.dataset.act;
    if (paint !== this.app.getCurrentPaint() || this.app.getCurrentMapping()) this.app.setCurrentPaint(paint.id);
    if (act === 'more') {
      const r = e.target.closest('button').getBoundingClientRect();
      showMenu([
        { label: t('action.addMesh'), icon: 'mesh', action: () => this.app.addLayer('mesh', paint) },
        { label: t('action.addTriangle'), icon: 'triangle', action: () => this.app.addLayer('triangle', paint) },
        { label: t('action.addEllipse'), icon: 'ellipse', action: () => this.app.addLayer('ellipse', paint) },
        { separator: true },
        { label: t('action.renameSource'), icon: 'edit', action: () => this.app.renamePaint(paint) },
        ...(paint.kind === 'image' || paint.kind === 'video' ? [{ label: t('prop.replaceFile'), icon: 'open', action: () => this._replaceMedia(paint) }] : []),
        { label: t('action.deleteSource'), icon: 'trash', action: () => this.app.deletePaint(paint) },
      ], { x: r.left, y: r.bottom });
    }
  }

  async _replaceMedia(paint) {
    const { pickFiles, toast } = await import('./widgets.js');
    const files = await pickFiles({ accept: paint.kind === 'image' ? 'image/*' : 'video/*' });
    if (!files.length) return;
    try {
      await paint.load(files[0], files[0].name);
      this.app.updatePlayingState();
      this.app.commit('history.replaceMedia');
    } catch {
      toast(t('error.cannotLoad', { name: files[0].name }), { kind: 'error' });
    }
  }

  /* ------------------------------------------------------------- layers */

  _renderLayers() {
    const app = this.app;
    const project = app.project;
    if (!project.mappings.length) {
      this.layersList.innerHTML = `<li class="empty">${escapeHtml(t(project.paints.length ? 'panel.noLayers' : 'panel.noLayersNoSources'))}</li>`;
      return;
    }
    const current = app.getCurrentMapping();
    const hasSolo = project.hasSolo();
    this.layersList.innerHTML = project.mappings.map((m) => {
      const visible = project.mappingIsVisible(m);
      return `<li class="item layer ${m === current ? 'selected' : ''} ${visible ? '' : 'dimmed'}" data-id="${m.id}" tabindex="0">
        <button type="button" class="icon-btn toggle ${m.visible ? 'on' : ''}" data-act="visible" title="${escapeHtml(t('action.hideLayer'))}">${icon(m.visible ? 'eye' : 'eyeOff')}</button>
        <span class="shape-icon">${icon(SHAPE_ICONS[m.type] || 'quad')}</span>
        <span class="item-text"><span class="item-name">${escapeHtml(m.name)}</span>
        <small>${m.paint.kind === 'color' ? `<span class="dot" style="background:${m.paint.css}"></span>` : icon(KIND_ICONS[m.paint.kind], 'mini')} ${escapeHtml(m.paint.name)}</small></span>
        <button type="button" class="icon-btn toggle ${m.solo ? 'on solo' : ''} ${hasSolo && !m.solo ? 'muted' : ''}" data-act="solo" title="${escapeHtml(t('action.soloLayer'))}">${icon('solo')}</button>
        <button type="button" class="icon-btn toggle ${m.locked ? 'on locked' : ''}" data-act="locked" title="${escapeHtml(t('action.lockLayer'))}">${icon(m.locked ? 'lock' : 'unlock')}</button>
        <span class="grip" data-act="grip" title="${escapeHtml(t('panel.dragToReorder'))}">${icon('grip')}</span>
      </li>`;
    }).join('');
  }

  _onLayerClick(e) {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    const m = this.app.project.getMappingById(+li.dataset.id);
    if (!m) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'visible' || act === 'solo' || act === 'locked') {
      this.app.toggleMappingProp(act, m);
      return;
    }
    if (act === 'grip') return;
    this.app.setCurrentMapping(m.id);
  }

  /** Reordering layers by dragging the grip (pointer events work with mouse and touch). */
  _setupLayerDrag() {
    let drag = null;
    this.layersList.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('[data-act="grip"]');
      if (!grip) return;
      const li = grip.closest('[data-id]');
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const items = [...this.layersList.querySelectorAll('li[data-id]')];
      drag = { li, grip, id: +li.dataset.id, startY: e.clientY, items, from: items.indexOf(li), to: items.indexOf(li) };
      li.classList.add('dragging');
    });
    this.layersList.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.startY;
      drag.li.style.transform = `translateY(${dy}px)`;
      const y = e.clientY;
      let to = drag.items.length - 1;
      for (let i = 0; i < drag.items.length; i++) {
        const r = drag.items[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { to = i; break; }
      }
      if (to > drag.from) to = Math.max(drag.from, to - 1);
      drag.to = to;
      drag.items.forEach((it, i) => it.classList.toggle('drop-before', i === to && to < drag.from));
      drag.items.forEach((it, i) => it.classList.toggle('drop-after', i === to && to > drag.from));
    });
    const end = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      d.li.style.transform = '';
      d.li.classList.remove('dragging');
      d.items.forEach((it) => it.classList.remove('drop-before', 'drop-after'));
      if (d.to !== d.from) {
        this.app.project.moveMapping(d.id, d.to);
        this.app.currentMappingId = d.id;
        this.app.commit('history.moveLayer');
      }
    };
    this.layersList.addEventListener('pointerup', end);
    this.layersList.addEventListener('pointercancel', end);
  }

  /* --------------------------------------------------------- properties */

  _renderSourceProps() {
    const paint = this.app.getCurrentPaint();
    const key = paint ? `${paint.id}:${paint.kind}:${paint.status}` : '';
    if (key === this._propsKey.source && !this._structureChanged('source')) {
      this._refreshValues('source');
      return;
    }
    this._propsKey.source = key;
    const el = this.sourceProps;
    this._refreshers.source = [];
    el.innerHTML = '';
    if (!paint) {
      el.innerHTML = `<p class="hint">${escapeHtml(t('panel.selectSource'))}</p>`;
      return;
    }
    const b = new PropBuilder(el, this._refreshers.source, this.app);
    b.heading(t('panel.sourceProps'), `ID ${paint.id}`);
    b.text(t('prop.name'), () => paint.name, (v) => { paint.name = v; this.app.commit('history.renameSource'); });
    b.percent(t('prop.opacity'), () => paint.opacity, (v, final) => { paint.opacity = v; this.app.invalidate(); if (final) this.app.commit('history.opacity', { mergeKey: `paint-opacity-${paint.id}` }); }, { max: 1 });
    if (paint.kind === 'color') {
      b.color(t('prop.color'), () => paint.hex, (hex, final) => {
        paint.setHex(hex);
        this.app.invalidate();
        if (final) { this.app.commit('history.color', { mergeKey: `paint-color-${paint.id}` }); }
      });
      b.percent(t('prop.alpha'), () => paint.color.a / 255, (v, final) => { paint.color.a = Math.round(v * 255); this.app.invalidate(); if (final) this.app.commit('history.color', { mergeKey: `paint-alpha-${paint.id}` }); }, { max: 1 });
    } else {
      const fileInfo = paint.kind === 'camera' ? paint.uri.replace(/^camera:/, '') : paint.uri;
      b.info(paint.kind === 'camera' ? t('prop.camera') : t('prop.file'), () => fileInfo || '—');
      b.info(t('prop.size'), () => (paint.ready ? `${paint.width} × ${paint.height}` : t(paint.status === 'loading' ? 'view.loading' : 'panel.missing')));
      if (paint.kind === 'image' || paint.kind === 'video') {
        b.buttons([{ label: t('prop.replaceFile'), icon: 'open', run: () => this._replaceMedia(paint) }]);
      }
      if (paint.kind === 'camera') {
        b.buttons([{ label: t('camera.switch'), icon: 'camera', run: () => this._switchCamera(paint) }]);
      }
      if (paint.kind === 'image' || paint.kind === 'video') {
        b.number(t('prop.speed'), () => Math.round(paint.rate * 1000) / 10, (v) => {
          if (paint.setRate) paint.setRate(v / 100); else paint.rate = v / 100;
          this.app.commit('history.speed', { mergeKey: `paint-rate-${paint.id}` });
        }, { min: paint.kind === 'video' ? 6.25 : 0, max: 1600, step: 10, unit: '%' });
      }
      if (paint.kind === 'video') {
        b.percent(t('prop.volume'), () => paint.volume, (v, final) => { paint.setVolume(v); if (final) this.app.commit('history.volume', { mergeKey: `paint-volume-${paint.id}` }); }, { max: 1 });
      }
      b.pair(t('prop.position'), () => [paint.x, paint.y], ([x, y]) => { paint.x = x; paint.y = y; this.app.commit('history.position'); });
    }
    b.buttons([
      { label: t('action.addMesh'), icon: 'mesh', run: () => this.app.addLayer('mesh', paint) },
      { label: t('action.addTriangle'), icon: 'triangle', run: () => this.app.addLayer('triangle', paint) },
      { label: t('action.addEllipse'), icon: 'ellipse', run: () => this.app.addLayer('ellipse', paint) },
    ], 'stack');
    b.buttons([{ label: t('action.deleteSource'), icon: 'trash', danger: true, run: () => this.app.deletePaint(paint) }]);
  }

  async _switchCamera(paint) {
    const devices = await CameraPaint.listDevices().catch(() => []);
    const items = [];
    if (this.app.coarsePointer) {
      items.push({ label: t('camera.back'), action: () => this._reopenCamera(paint, { facingMode: 'environment', deviceId: '' }) });
      items.push({ label: t('camera.front'), action: () => this._reopenCamera(paint, { facingMode: 'user', deviceId: '' }) });
    }
    devices.forEach((d, i) => items.push({ label: d.label || t('camera.device', { n: i + 1 }), checked: d.deviceId === paint.deviceId, action: () => this._reopenCamera(paint, { deviceId: d.deviceId, label: d.label }) }));
    if (!items.length) items.push({ label: t('camera.default'), action: () => this._reopenCamera(paint, {}) });
    showMenu(items, { x: innerWidth / 2 - 100, y: innerHeight / 3 });
  }

  async _reopenCamera(paint, opts) {
    paint.deactivate();
    try {
      await paint.open(opts);
      paint.name = paint.uri.replace(/^camera:/, '') || paint.name;
      this.app.commit('history.changeSource');
    } catch {
      this.app.emitChange();
    }
  }

  _renderLayerProps() {
    const m = this.app.getCurrentMapping();
    const key = m ? `${m.id}:${m.type}:${m.paint.id}:${m.shape.nVertices()}:${m.inputShape?.nVertices() ?? 0}:${this.app.project.paints.length}` : '';
    if (key === this._propsKey.layer) {
      this._refreshValues('layer');
      return;
    }
    this._propsKey.layer = key;
    const el = this.layerProps;
    this._refreshers.layer = [];
    el.innerHTML = '';
    if (!m) {
      el.innerHTML = `<p class="hint">${escapeHtml(t('panel.selectLayer'))}</p>`;
      return;
    }
    const app = this.app;
    const get = () => app.getCurrentMapping();
    const b = new PropBuilder(el, this._refreshers.layer, app);
    b.heading(t('panel.layerProps'), `ID ${m.id}`);
    b.text(t('prop.name'), () => get()?.name ?? '', (v) => { const mm = get(); if (mm) { mm.name = v; app.commit('history.renameLayer'); } });
    b.percent(t('prop.opacity'), () => get()?.opacity ?? 1, (v, final) => { const mm = get(); if (!mm) return; mm.opacity = v; app.invalidate(); if (final) app.commit('history.opacity', { mergeKey: `map-opacity-${mm.id}` }); }, { max: 1 });
    const compatible = app.project.getPaintsCompatibleWith(m);
    b.select(t('prop.source'), compatible.map((p) => ({ value: String(p.id), label: p.name })), () => String(get()?.paint.id), (v) => {
      const mm = get();
      if (mm) app.setMappingPaint(mm, app.project.getPaintById(+v));
    });
    b.toggles([
      { label: t('prop.visible'), get: () => !!get()?.visible, set: () => app.toggleMappingProp('visible') },
      { label: t('prop.solo'), get: () => !!get()?.solo, set: () => app.toggleMappingProp('solo') },
      { label: t('prop.locked'), get: () => !!get()?.locked, set: () => app.toggleMappingProp('locked') },
    ]);
    if (m.type === 'mesh') {
      b.pair(t('prop.subdivisions'), () => [get()?.shape.nColumns ?? 2, get()?.shape.nRows ?? 2], ([c, r]) => app.resizeMesh(get(), c, r), { min: 2, max: 64, step: 1, labels: [t('prop.columns'), t('prop.rows')], integer: true });
    }
    b.iconButtons(t('prop.transform'), [
      { icon: 'rotateCCW', title: t('action.rotate90CCW'), run: () => app.transformMapping('rotateCCW') },
      { icon: 'rotateCW', title: t('action.rotate90CW'), run: () => app.transformMapping('rotateCW') },
      { icon: 'rotate', title: t('action.rotate180'), run: () => app.transformMapping('rotate180') },
      { icon: 'flipH', title: t('action.flipH'), run: () => app.transformMapping('flipH') },
      { icon: 'flipV', title: t('action.flipV'), run: () => app.transformMapping('flipV') },
    ]);
    b.iconButtons(t('prop.order'), [
      { icon: 'top', title: t('action.raiseTop'), run: () => app.moveMappingBy('top') },
      { icon: 'up', title: t('action.raise'), run: () => app.moveMappingBy('raise') },
      { icon: 'down', title: t('action.lower'), run: () => app.moveMappingBy('lower') },
      { icon: 'bottom', title: t('action.lowerBottom'), run: () => app.moveMappingBy('bottom') },
      { icon: 'duplicate', title: t('action.duplicateLayer'), run: () => app.duplicateMapping() },
      { icon: 'trash', title: t('action.deleteLayer'), run: () => app.deleteMapping() },
    ]);
    if (m.hasInputShape()) b.vertices(t('prop.inputShape'), () => get()?.inputShape, 'input');
    b.vertices(t('prop.outputShape'), () => get()?.shape, 'output');
  }

  _structureChanged() { return false; }

  onLanguageChanged() {
    this._buildToolbars();
    this._propsKey = { source: '', layer: '' };
    this.refresh();
  }

  _refreshValues(which) {
    for (const r of this._refreshers[which]) r();
  }
}

/** Helper building property editor rows. */
class PropBuilder {
  constructor(root, refreshers, app) {
    this.root = root;
    this.refreshers = refreshers;
    this.app = app;
  }

  _row(label, content, cls = '') {
    const row = document.createElement('div');
    row.className = 'prop ' + cls;
    if (label !== null) {
      const l = document.createElement('span');
      l.className = 'prop-label';
      l.textContent = label;
      row.appendChild(l);
    }
    const c = document.createElement('div');
    c.className = 'prop-control';
    if (typeof content === 'string') c.innerHTML = content; else if (content) c.appendChild(content);
    row.appendChild(c);
    this.root.appendChild(row);
    return c;
  }

  _refresh(input, getter, fmt = (v) => v) {
    this.refreshers.push(() => {
      if (document.activeElement === input) return;
      const v = fmt(getter());
      if (input.type === 'checkbox') input.checked = !!v;
      else if (String(input.value) !== String(v)) input.value = v;
    });
  }

  heading(title, sub) {
    const h = document.createElement('div');
    h.className = 'prop-heading';
    h.innerHTML = `<span>${escapeHtml(title)}</span><small>${escapeHtml(sub || '')}</small>`;
    this.root.appendChild(h);
  }

  info(label, get) {
    const c = this._row(label, '<span class="prop-info"></span>');
    const span = c.firstChild;
    const r = () => { span.textContent = get(); span.title = span.textContent; };
    r();
    this.refreshers.push(r);
  }

  text(label, get, set) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.value = get();
    input.addEventListener('change', () => set(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    this._row(label, input);
    this._refresh(input, get);
  }

  /** Slider + number, value in [0, max] shown as percent. */
  percent(label, get, set, { max = 1 } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'range-row';
    wrap.innerHTML = `<input type="range" class="range" min="0" max="${max * 100}" step="0.5"><input type="number" class="input num" min="0" max="${max * 100}" step="1"><span class="unit">%</span>`;
    const [range, num] = wrap.querySelectorAll('input');
    const fmt = (v) => Math.round(v * 1000) / 10;
    range.value = fmt(get());
    num.value = fmt(get());
    range.addEventListener('input', () => { num.value = range.value; set(+range.value / 100, false); });
    range.addEventListener('change', () => set(+range.value / 100, true));
    num.addEventListener('change', () => {
      const v = Math.max(0, Math.min(max * 100, +num.value || 0));
      num.value = v; range.value = v;
      set(v / 100, true);
    });
    this._row(label, wrap);
    this._refresh(range, get, fmt);
    this._refresh(num, get, fmt);
  }

  number(label, get, set, { min = -Infinity, max = Infinity, step = 1, unit = '' } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'range-row';
    wrap.innerHTML = `<input type="number" class="input num wide" step="${step}" ${Number.isFinite(min) ? `min="${min}"` : ''} ${Number.isFinite(max) ? `max="${max}"` : ''}><span class="unit">${escapeHtml(unit)}</span>`;
    const num = wrap.querySelector('input');
    num.value = get();
    num.addEventListener('change', () => {
      let v = +num.value;
      if (!Number.isFinite(v)) v = get();
      v = Math.max(min, Math.min(max, v));
      num.value = v;
      set(v);
    });
    this._row(label, wrap);
    this._refresh(num, get);
  }

  pair(label, get, set, { min = -1e6, max = 1e6, step = 1, labels = ['x', 'y'], integer = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'pair';
    wrap.innerHTML = `<label><small>${escapeHtml(labels[0])}</small><input type="number" class="input num" step="${step}" min="${min}" max="${max}"></label><label><small>${escapeHtml(labels[1])}</small><input type="number" class="input num" step="${step}" min="${min}" max="${max}"></label>`;
    const [a, b] = wrap.querySelectorAll('input');
    const fmt = (v) => (integer ? Math.round(v) : Math.round(v * 100) / 100);
    const update = () => { const [x, y] = get(); a.value = fmt(x); b.value = fmt(y); };
    update();
    const onChange = () => {
      let x = +a.value, y = +b.value;
      const [ox, oy] = get();
      if (!Number.isFinite(x)) x = ox;
      if (!Number.isFinite(y)) y = oy;
      x = Math.max(min, Math.min(max, integer ? Math.round(x) : x));
      y = Math.max(min, Math.min(max, integer ? Math.round(y) : y));
      set([x, y]);
    };
    a.addEventListener('change', onChange);
    b.addEventListener('change', onChange);
    this._row(label, wrap);
    this.refreshers.push(() => {
      if (document.activeElement === a || document.activeElement === b) return;
      update();
    });
  }

  color(label, get, set) {
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'input color-input';
    input.value = get();
    input.addEventListener('input', () => set(input.value, false));
    input.addEventListener('change', () => set(input.value, true));
    this._row(label, input);
    this._refresh(input, get);
  }

  select(label, options, get, set) {
    const sel = document.createElement('select');
    sel.className = 'input';
    sel.innerHTML = options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
    sel.value = get();
    sel.addEventListener('change', () => set(sel.value));
    this._row(label, sel);
    this._refresh(sel, get);
  }

  toggles(items) {
    const wrap = document.createElement('div');
    wrap.className = 'toggles';
    for (const it of items) {
      const l = document.createElement('label');
      l.className = 'check';
      l.innerHTML = `<input type="checkbox"> <span>${escapeHtml(it.label)}</span>`;
      const cb = l.querySelector('input');
      cb.checked = it.get();
      cb.addEventListener('change', () => it.set(cb.checked));
      wrap.appendChild(l);
      this._refresh(cb, it.get);
    }
    this._row(null, wrap, 'prop-full');
  }

  buttons(items, cls = '') {
    const wrap = document.createElement('div');
    wrap.className = 'btn-row ' + cls;
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-small' + (it.danger ? ' btn-danger-outline' : '');
      b.innerHTML = `${it.icon ? icon(it.icon) : ''}<span>${escapeHtml(it.label)}</span>`;
      b.addEventListener('click', it.run);
      wrap.appendChild(b);
    }
    this._row(null, wrap, 'prop-full');
  }

  iconButtons(label, items) {
    const wrap = document.createElement('div');
    wrap.className = 'icon-row';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn';
      b.title = it.title;
      b.setAttribute('aria-label', it.title);
      b.innerHTML = icon(it.icon);
      b.addEventListener('click', it.run);
      wrap.appendChild(b);
    }
    this._row(label, wrap);
  }

  /** Collapsible list of editable vertex coordinates. */
  vertices(label, getShape, which) {
    const details = document.createElement('details');
    details.className = 'vertices';
    const app = this.app;
    const key = `mapmap-open-${which}`;
    try { details.open = sessionStorage.getItem(key) === '1'; } catch { /* ignore */ }
    details.addEventListener('toggle', () => { try { sessionStorage.setItem(key, details.open ? '1' : '0'); } catch { /* ignore */ } });
    const shape = getShape();
    details.innerHTML = `<summary>${escapeHtml(label)} <small>(${shape.nVertices()} ${escapeHtml(t('prop.points'))})</small></summary><div class="vertex-grid"></div>`;
    const grid = details.querySelector('.vertex-grid');
    const inputs = [];
    for (let i = 0; i < shape.nVertices(); i++) {
      const row = document.createElement('div');
      row.className = 'vertex-row';
      row.innerHTML = `<span>${i}</span><input type="number" class="input num" step="1"><input type="number" class="input num" step="1">`;
      const [x, y] = row.querySelectorAll('input');
      const onChange = () => {
        const s = getShape();
        if (!s || s.locked) return;
        const vx = +x.value, vy = +y.value;
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
        s.setVertex(i, { x: vx, y: vy });
        app.commit('history.moveVertex');
      };
      x.addEventListener('change', onChange);
      y.addEventListener('change', onChange);
      inputs.push([x, y]);
      grid.appendChild(row);
    }
    const update = () => {
      const s = getShape();
      if (!s || !details.open) return;
      inputs.forEach(([x, y], i) => {
        const v = s.vertices[i];
        if (!v) return;
        if (document.activeElement !== x) x.value = Math.round(v.x * 10) / 10;
        if (document.activeElement !== y) y.value = Math.round(v.y * 10) / 10;
      });
    };
    details.addEventListener('toggle', update);
    update();
    this.refreshers.push(update);
    this._row(null, details, 'prop-full');
  }
}
