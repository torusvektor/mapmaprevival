/*
 * MapMap Web - editor / output view.
 * Port of src/gui/MapperGLCanvas.cpp, OutputGLCanvas.cpp and OutputGLWindow.cpp:
 * input editor, output editor and the output (projection) window share this class.
 *
 * Interaction (mouse, pen and touch):
 *  - drag a vertex to move it (Shift toggles sticky vertices),
 *  - drag inside the current shape to move it,
 *  - click/tap the current shape to cycle vertex mode: move -> scale -> rotate,
 *  - click/tap another shape in the output to select its layer,
 *  - drag empty space (or middle button, or two fingers) to pan, wheel/pinch to zoom,
 *  - right click / long press for the layer context menu.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Renderer } from '../render/renderer.js';
import { drawShapeControls, drawShapeOutline, drawCrosshair, drawTestCard } from '../render/overlay.js';
import { ShapeMode } from '../model/shapes.js';
import { Affine, distSq, dist, sub, add, boundingRect, unionRect, clamp } from '../model/geometry.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

export const ZOOM_FACTOR = 1.4;
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 20;
const LONG_PRESS_MS = 550;

export class EditorView {
  /**
   * kind: 'input' | 'output'
   * presentation: true for the projection output (fit to window, no pan/zoom).
   */
  constructor(app, container, { kind, presentation = false } = {}) {
    this.app = app;
    this.kind = kind;
    this.presentation = presentation;
    this.container = container;
    this.doc = container.ownerDocument;
    this.win = this.doc.defaultView;

    this.zoom = 1;
    this.offset = { x: 0, y: 0 };
    this.needsFit = true;
    this.cssWidth = 0;
    this.cssHeight = 0;
    this.viewVersion = 0;
    this.lastSignature = '';

    this.activeVertex = -1;
    this.pointers = new Map();
    this.drag = null;
    this.hoverPoint = null;
    this.lastPointerType = 'mouse';
    this.lastTouchTime = 0;
    this.hovered = false;

    this._buildDom();
    this.renderer = new Renderer(this.glCanvas);
    this.ctx = this.overlay.getContext('2d');
    this._bindEvents();
    if (!this.renderer.gl) this._showGlError();
  }

  /* ------------------------------------------------------------------ DOM */

  _buildDom() {
    const d = this.doc;
    this.container.classList.add('editor-view', `editor-${this.kind}`);
    if (this.presentation) this.container.classList.add('presentation-view');
    this.stage = d.createElement('div');
    this.stage.className = 'view-stage';
    this.glCanvas = d.createElement('canvas');
    this.glCanvas.className = 'view-gl';
    this.overlay = d.createElement('canvas');
    this.overlay.className = 'view-overlay';
    this.overlay.tabIndex = 0;
    this.stage.append(this.glCanvas, this.overlay);
    this.container.appendChild(this.stage);

    if (!this.presentation) {
      const title = d.createElement('div');
      title.className = 'view-title';
      title.dataset.i18n = this.kind === 'input' ? 'view.input' : 'view.output';
      title.textContent = t(title.dataset.i18n);
      this.titleEl = title;

      const zoomBar = d.createElement('div');
      zoomBar.className = 'view-zoombar';
      zoomBar.innerHTML = `
        <button type="button" data-z="out" data-i18n-title="view.zoomOut">${icon('zoomOut')}</button>
        <button type="button" data-z="level" class="zoom-level" data-i18n-title="view.zoomReset">100%</button>
        <button type="button" data-z="in" data-i18n-title="view.zoomIn">${icon('zoomIn')}</button>
        <button type="button" data-z="fit" data-i18n-title="view.zoomFit">${icon('fit')}</button>`;
      zoomBar.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const z = b.dataset.z;
        if (z === 'in') this.zoomBy(ZOOM_FACTOR);
        else if (z === 'out') this.zoomBy(1 / ZOOM_FACTOR);
        else if (z === 'level') this.resetZoom();
        else if (z === 'fit') this.fit();
      });
      this.zoomLevelEl = zoomBar.querySelector('.zoom-level');

      const modeBar = d.createElement('div');
      modeBar.className = 'view-modebar';
      modeBar.innerHTML = `
        <button type="button" data-mode="0" data-i18n-title="mode.move">${icon('move')}</button>
        <button type="button" data-mode="1" data-i18n-title="mode.scale">${icon('scale')}</button>
        <button type="button" data-mode="2" data-i18n-title="mode.rotate">${icon('rotate')}</button>`;
      modeBar.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        const shape = this.getCurrentShape();
        if (!b || !shape) return;
        shape.setShapeMode(+b.dataset.mode);
        this.app.invalidate();
      });
      this.modeBar = modeBar;
      this.container.append(title, zoomBar, modeBar);
      this.app.i18nApply(this.container);
    }
  }

  _showGlError() {
    const msg = this.doc.createElement('div');
    msg.className = 'view-error';
    msg.textContent = t('error.webgl');
    this.container.appendChild(msg);
  }

  /* ------------------------------------------------------------ geometry */

  get scaleX() { return this._scale ? this._scale.x : this.zoom; }
  get scaleY() { return this._scale ? this._scale.y : this.zoom; }

  toScreen(p) { return { x: p.x * this.scaleX + this.offset.x, y: p.y * this.scaleY + this.offset.y }; }
  toScene(p) { return { x: (p.x - this.offset.x) / this.scaleX, y: (p.y - this.offset.y) / this.scaleY }; }

  _eventPoint(e) {
    const r = this.overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  getShapeFromMapping(mapping) {
    if (!mapping) return null;
    if (this.kind === 'output') return mapping.shape;
    return mapping.hasInputShape() ? mapping.inputShape : null;
  }

  getCurrentShape() { return this.getShapeFromMapping(this.app.getCurrentMapping()); }

  /** Paint displayed in the input editor. */
  getInputPaint() { return this.app.getInputPaint(); }

  _updatePresentationTransform() {
    const p = this.app.project;
    const W = p.outputWidth, H = p.outputHeight;
    const cw = this.cssWidth, ch = this.cssHeight;
    if (this.app.settings.outputFit === 'stretch') {
      this._scale = { x: cw / W, y: ch / H };
      this.offset = { x: 0, y: 0 };
    } else {
      const s = Math.min(cw / W, ch / H);
      this._scale = { x: s, y: s };
      this.offset = { x: (cw - W * s) / 2, y: (ch - H * s) / 2 };
    }
  }

  contentBounds() {
    const project = this.app.project;
    let r = null;
    if (this.kind === 'output') {
      r = { x: 0, y: 0, width: project.outputWidth, height: project.outputHeight };
      for (const m of project.getVisibleMappings()) r = unionRect(r, m.shape.boundingRect());
    } else {
      const paint = this.getInputPaint();
      if (paint && paint.isTexture()) {
        r = paint.getRect();
        for (const m of project.getPaintMappings(paint)) if (m.inputShape) r = unionRect(r, m.inputShape.boundingRect());
      }
    }
    return r || { x: 0, y: 0, width: project.outputWidth, height: project.outputHeight };
  }

  fit() {
    if (this.presentation) return;
    if (!this.cssWidth || !this.cssHeight) { this.needsFit = true; return; }
    const b = this.contentBounds();
    const margin = 0.9;
    const z = clamp(Math.min((this.cssWidth * margin) / Math.max(1, b.width), (this.cssHeight * margin) / Math.max(1, b.height)), ZOOM_MIN, ZOOM_MAX);
    this.zoom = z;
    this.offset = {
      x: this.cssWidth / 2 - (b.x + b.width / 2) * z,
      y: this.cssHeight / 2 - (b.y + b.height / 2) * z,
    };
    this.needsFit = false;
    this._changed();
  }

  zoomAt(newZoom, screenPoint) {
    if (this.presentation) return;
    newZoom = clamp(newZoom, ZOOM_MIN, ZOOM_MAX);
    const c = screenPoint || { x: this.cssWidth / 2, y: this.cssHeight / 2 };
    const s = this.toScene(c);
    this.zoom = newZoom;
    this.offset = { x: c.x - s.x * newZoom, y: c.y - s.y * newZoom };
    this._changed();
  }

  zoomBy(factor, screenPoint) { this.zoomAt(this.zoom * factor, screenPoint); }

  /** Original size (100%) centered on the content. */
  resetZoom() {
    const b = this.contentBounds();
    this.zoom = 1;
    this.offset = { x: this.cssWidth / 2 - (b.x + b.width / 2), y: this.cssHeight / 2 - (b.y + b.height / 2) };
    this._changed();
  }

  panBy(dx, dy) {
    if (this.presentation) return;
    this.offset = { x: this.offset.x + dx, y: this.offset.y + dy };
    this._changed();
  }

  _changed() {
    this.viewVersion++;
    if (this.zoomLevelEl) this.zoomLevelEl.textContent = `${Math.round(this.zoom * 100)}%`;
    this.app.onViewChanged(this);
  }

  /* ------------------------------------------------------------- events */

  _bindEvents() {
    const o = this.overlay;
    o.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    o.addEventListener('pointermove', (e) => this._onPointerMove(e));
    o.addEventListener('pointerup', (e) => this._onPointerUp(e));
    o.addEventListener('pointercancel', (e) => this._onPointerUp(e, true));
    o.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') { this.hoverPoint = null; this.hovered = false; this.viewVersion++; }
    });
    o.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') { this.hovered = true; this.viewVersion++; }
    });
    o.addEventListener('contextmenu', (e) => e.preventDefault());
    o.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    // Safari (macOS) trackpad pinch.
    o.addEventListener('gesturestart', (e) => { e.preventDefault(); this._gestureZoom = this.zoom; });
    o.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (this._gestureZoom) this.zoomAt(this._gestureZoom * e.scale, this._eventPoint(e));
    });
    o.addEventListener('gestureend', (e) => { e.preventDefault(); this._gestureZoom = null; });
    o.addEventListener('dblclick', (e) => {
      if (this.presentation) this.app.output.onPresentationDoubleClick(this, e);
    });

    this.resizeObserver = new this.win.ResizeObserver(() => this._measure());
    this.resizeObserver.observe(this.stage);
    this._measure();
  }

  _measure() {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    if (w === this.cssWidth && h === this.cssHeight) return;
    const oldW = this.cssWidth, oldH = this.cssHeight;
    if (oldW && oldH && w && h && !this.presentation) {
      // Keep the scene point at the center of the view in place.
      const c = this.toScene({ x: oldW / 2, y: oldH / 2 });
      this.offset = { x: w / 2 - c.x * this.zoom, y: h / 2 - c.y * this.zoom };
    }
    this.cssWidth = w;
    this.cssHeight = h;
    this.viewVersion++;
    if (w && h && this.needsFit) this.fit();
  }

  _hitRadius(pointerType) {
    return pointerType === 'touch' ? 26 : pointerType === 'pen' ? 18 : 12;
  }

  _vertexDrawRadius() {
    return this.app.coarsePointer ? 14 : 12;
  }

  _onPointerDown(e) {
    this.overlay.focus({ preventScroll: true });
    this.app.setActiveView(this);
    this.lastPointerType = e.pointerType;
    if (e.pointerType === 'touch') this.lastTouchTime = performance.now();
    this.app.unlockMedia();
    const pos = this._eventPoint(e);
    this.pointers.set(e.pointerId, pos);
    try { this.overlay.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    // Two fingers: pinch-zoom / pan (cancel what the first finger started).
    if (this.pointers.size === 2 && !this.presentation) {
      this._cancelDrag();
      const [a, b] = [...this.pointers.values()];
      this.drag = {
        type: 'pinch',
        startDist: Math.max(1, dist(a, b)),
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        startZoom: this.zoom,
        startOffset: { ...this.offset },
      };
      return;
    }
    if (this.pointers.size > 1) return;

    const interactive = !this.presentation || this.app.controlsVisibleIn(this);
    if (e.button === 1 && !this.presentation) {
      this.drag = { type: 'pan', last: pos };
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;

    const scenePos = this.toScene(pos);
    const project = this.app.project;
    let mapping = this.app.getCurrentMapping();
    let shape = interactive ? this.getShapeFromMapping(mapping) : null;
    let pressedOnSomething = false;
    let selectionChanged = false;
    let vertexGrabbed = false;
    this.activeVertex = -1;

    // Vertex selection first.
    if (shape && e.button === 0 && this.app.settings.displayControls) {
      let minDist = this._hitRadius(e.pointerType) ** 2;
      for (let i = 0; i < shape.nVertices(); i++) {
        const d = distSq(pos, this.toScreen(shape.getVertex(i)));
        if (d < minDist) {
          minDist = d;
          this.activeVertex = i;
          vertexGrabbed = !shape.locked;
          pressedOnSomething = true;
        }
      }
    }

    // Change the current layer by clicking on its shape (output only).
    if (!vertexGrabbed && interactive) {
      for (const m of project.getVisibleMappings()) {
        const s = this.getShapeFromMapping(m);
        if (s && s.includesPoint(scenePos)) {
          pressedOnSomething = true;
          this.activeVertex = -1;
          if (this.kind === 'output' && s !== shape) {
            this.app.setCurrentMapping(m.id);
            mapping = m;
            shape = s;
            selectionChanged = true;
          }
          break;
        }
      }
    }

    if (vertexGrabbed) {
      const v = shape.getVertex(this.activeVertex);
      this.drag = {
        type: 'vertex',
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        index: this.activeVertex,
        startScene: scenePos,
        startVertex: { ...v },
        original: shape.clone(),
        startScreen: pos,
        moved: false,
      };
    } else if (shape && shape.includesPoint(scenePos)) {
      if (e.button === 0) {
        const prevMode = shape.mode;
        if (selectionChanged) shape.setShapeMode(ShapeMode.Default);
        else shape.setShapeMode(shape.mode, true);
        this.drag = {
          type: 'shape',
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          startScreen: pos,
          lastScene: scenePos,
          original: shape.clone(),
          grabbable: !shape.locked,
          prevMode,
          moved: false,
        };
      } else if (e.button === 2) {
        this.app.showMappingContextMenu(e.clientX, e.clientY, this.win);
      }
    } else if (!pressedOnSomething) {
      this.activeVertex = -1;
      if (!this.presentation && e.button === 0) this.drag = { type: 'pan', last: pos, startScreen: pos, moved: false };
      if (e.button === 2 && mapping) this.app.showMappingContextMenu(e.clientX, e.clientY, this.win);
    }

    // Long press opens the context menu on touch screens.
    clearTimeout(this._longPress);
    if (e.pointerType !== 'mouse' && e.button === 0 && this.app.getCurrentMapping() && (this.drag?.type === 'shape' || this.drag?.type === 'vertex')) {
      const startDrag = this.drag;
      this._longPress = setTimeout(() => {
        if (this.drag === startDrag && !startDrag.moved) {
          this._cancelDrag();
          if (startDrag.type === 'shape') shape.setShapeMode(startDrag.prevMode);
          this.app.showMappingContextMenu(e.clientX, e.clientY, this.win);
        }
      }, LONG_PRESS_MS);
    }
    this.app.invalidate();
  }

  _cancelDrag() {
    clearTimeout(this._longPress);
    const d = this.drag;
    if (d && (d.type === 'vertex' || d.type === 'shape') && d.moved) {
      const shape = this.getCurrentShape();
      if (shape) shape.copyFrom(d.original);
    }
    this.drag = null;
    this.app.invalidate();
  }

  _snap(p) {
    const settings = this.app.settings;
    const radius = (settings.stickRadius || 20) / Math.max(this.scaleX, 0.0001);
    const current = this.getCurrentShape();
    let best = null;
    let bestD = radius * radius;
    for (const m of this.app.project.mappings) {
      const s = this.getShapeFromMapping(m);
      if (!s || s === current) continue;
      for (const v of s.vertices) {
        const d = distSq(v, p);
        if (d < bestD) { bestD = d; best = v; }
      }
    }
    return best ? { x: best.x, y: best.y } : p;
  }

  _applyVertexDrag(d, pointerScene, shiftKey) {
    const shape = this.getCurrentShape();
    if (!shape) return;
    let p = add(d.startVertex, sub(pointerScene, d.startScene));
    const sticky = this.app.settings.stickyVertices !== !!shiftKey;
    if (sticky) p = this._snap(p);
    if (shape.mode === ShapeMode.Default) {
      shape.setVertex(d.index, p);
    } else {
      const center = d.original.getCenter();
      const v0 = sub(d.startVertex, center);
      const v1 = sub(p, center);
      shape.copyFrom(d.original);
      if (shape.mode === ShapeMode.Rotate) {
        const angle = Math.atan2(v1.y, v1.x) - Math.atan2(v0.y, v0.x);
        shape.applyTransform(Affine.aroundCenter(center, { rotate: angle }));
      } else {
        const l0 = Math.hypot(v0.x, v0.y);
        const s = l0 > 0 ? Math.hypot(v1.x, v1.y) / l0 : 1;
        shape.applyTransform(Affine.aroundCenter(center, { scaleX: s, scaleY: s }));
      }
    }
    this.app.onShapeEdited(this);
  }

  _onPointerMove(e) {
    const pos = this._eventPoint(e);
    if (e.pointerType === 'mouse') {
      this.hoverPoint = pos;
      this.hovered = true;
      this.viewVersion++;
    } else {
      this.lastTouchTime = performance.now();
    }
    this.app.setPointerPosition(this, this.toScene(pos));
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, pos);
    const d = this.drag;
    if (!d) return;

    if (d.type === 'pinch') {
      const pts = [...this.pointers.values()];
      if (pts.length < 2) return;
      const [a, b] = pts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = clamp(d.startZoom * (dist(a, b) / d.startDist), ZOOM_MIN, ZOOM_MAX);
      // Keep the scene point under the initial midpoint under the current midpoint.
      const sx = (d.startMid.x - d.startOffset.x) / d.startZoom;
      const sy = (d.startMid.y - d.startOffset.y) / d.startZoom;
      this.zoom = z;
      this.offset = { x: mid.x - sx * z, y: mid.y - sy * z };
      this._changed();
      return;
    }
    if (d.pointerId !== undefined && d.pointerId !== e.pointerId) return;

    const threshold = e.pointerType === 'mouse' ? 2 : 8;
    if (d.startScreen && !d.moved && dist(pos, d.startScreen) < threshold) return;
    if (!d.moved) clearTimeout(this._longPress);

    if (d.type === 'vertex') {
      d.moved = true;
      this._applyVertexDrag(d, this.toScene(pos), e.shiftKey);
    } else if (d.type === 'shape') {
      if (!d.grabbable) return;
      const shape = this.getCurrentShape();
      if (!shape) return;
      if (!d.moved) {
        d.moved = true;
        shape.setShapeMode(ShapeMode.Default);
      }
      const sp = this.toScene(pos);
      shape.translate(sub(sp, d.lastScene));
      d.lastScene = sp;
      this.app.onShapeEdited(this);
    } else if (d.type === 'pan') {
      d.moved = true;
      this.panBy(pos.x - d.last.x, pos.y - d.last.y);
      d.last = pos;
    }
  }

  _onPointerUp(e, cancelled = false) {
    clearTimeout(this._longPress);
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.type === 'pinch') {
      if (this.pointers.size < 2) this.drag = null;
      return;
    }
    if (d.pointerId !== undefined && d.pointerId !== e.pointerId) return;
    this.drag = null;
    if (cancelled) {
      if (d.moved && (d.type === 'vertex' || d.type === 'shape')) {
        const shape = this.getCurrentShape();
        if (shape) shape.copyFrom(d.original);
        this.app.invalidate();
      }
      return;
    }
    if (d.type === 'vertex' && d.moved) {
      const shape = this.getCurrentShape();
      const label = shape?.mode === ShapeMode.Rotate ? 'history.rotateShape' : shape?.mode === ShapeMode.Scale ? 'history.scaleShape' : 'history.moveVertex';
      this.app.commit(label);
    } else if (d.type === 'shape' && d.moved) {
      this.app.commit('history.moveShape');
    }
    this.app.invalidate();
  }

  _onWheel(e) {
    if (this.presentation) return;
    e.preventDefault();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= this.cssWidth; dy *= this.cssHeight; }
    if (e.ctrlKey || e.metaKey) {
      // Pinch on trackpads is reported as ctrl+wheel.
      const factor = Math.pow(1.0025, -clamp(dy, -200, 200));
      this.zoomBy(factor, this._eventPoint(e));
    } else {
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      this.panBy(-dx, -dy);
    }
  }

  /** Keyboard handling for this view (port of MapperGLCanvas::keyPressEvent). Returns true if handled. */
  handleKey(e) {
    const shape = this.getCurrentShape();
    const key = e.key;
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (shape && this.activeVertex >= 0 && this.activeVertex < shape.nVertices()) {
      if (e.shiftKey && (key === ' ' || e.code === 'Space')) {
        this.activeVertex = (this.activeVertex + 1) % shape.nVertices();
        this.app.invalidate();
        return true;
      }
      if (arrows[key] && !shape.locked) {
        const step = e.shiftKey ? 20 : e.altKey ? 1 : 2;
        const [dx, dy] = arrows[key];
        const sp = this.toScreen(shape.getVertex(this.activeVertex));
        const p = this.toScene({ x: sp.x + dx * step, y: sp.y + dy * step });
        shape.setVertex(this.activeVertex, p);
        this.app.onShapeEdited(this);
        this.app.commit('history.moveVertex', { mergeKey: `key-vertex-${this.kind}-${this.activeVertex}` });
        return true;
      }
    } else if (arrows[key] && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const [dx, dy] = arrows[key];
      this.panBy(-dx * 50, -dy * 50);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------- render */

  isVisible() {
    return this.cssWidth > 0 && this.cssHeight > 0 && this.stage.offsetParent !== null;
  }

  signature() {
    const app = this.app;
    let s = `${app.renderVersion}|${this.viewVersion}|${this.cssWidth}x${this.cssHeight}|${this.win.devicePixelRatio}`;
    const paints = this.kind === 'input' ? [this.getInputPaint()] : app.project.getVisiblePaints();
    for (const p of paints) if (p && p.isTexture()) s += `|${p.id}:${p.version}`;
    if (this.presentation) s += `|${this.controlsShown() ? 1 : 0}`;
    return s;
  }

  controlsShown() {
    return this.app.controlsVisibleIn(this);
  }

  render() {
    if (!this.cssWidth || !this.cssHeight) this._measure();
    if (!this.isVisible()) return;
    if (this.presentation) this._updatePresentationTransform();
    const sig = this.signature();
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;

    const dpr = Math.min(this.win.devicePixelRatio || 1, 3);
    const w = this.cssWidth, h = this.cssHeight;
    const r = this.renderer;
    r.resize(w, h, dpr);
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (this.overlay.width !== pw || this.overlay.height !== ph) {
      this.overlay.width = pw;
      this.overlay.height = ph;
    }

    const project = this.app.project;
    if (r.begin({ scaleX: this.scaleX, scaleY: this.scaleY, offsetX: this.offset.x, offsetY: this.offset.y }, w, h)) {
      if (this.kind === 'output') {
        r.drawMappings(project.getVisibleMappings());
      } else {
        const paint = this.getInputPaint();
        if (paint && paint.isTexture()) r.drawTexturePaint(paint, paint.opacity);
      }
      r.end();
    }

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawOverlay(ctx, w, h);
    this._updateModeBar();
  }

  _drawOverlay(ctx, w, h) {
    const app = this.app;
    const project = app.project;
    const toScreen = (p) => this.toScreen(p);

    if (this.presentation) {
      if (app.settings.showTestSignal) {
        const tl = this.toScreen({ x: 0, y: 0 });
        const br = this.toScreen({ x: project.outputWidth, y: project.outputHeight });
        drawTestCard(ctx, app.settings.testCard | 0, tl.x, tl.y, br.x - tl.x, br.y - tl.y, {
          resolutionText: app.settings.showResolution ? `${project.outputWidth} x ${project.outputHeight}` : null,
        });
        return;
      }
      if (!this.controlsShown()) return;
    } else {
      // Frame showing the output area / the texture bounds.
      let frame = null;
      let label = '';
      if (this.kind === 'output') {
        frame = { x: 0, y: 0, width: project.outputWidth, height: project.outputHeight };
        label = `${project.outputWidth} × ${project.outputHeight}`;
      } else {
        const paint = this.getInputPaint();
        if (paint && paint.isTexture()) {
          frame = paint.getRect();
          label = paint.ready ? `${paint.width} × ${paint.height}` : '';
        }
      }
      if (frame) {
        const a = toScreen({ x: frame.x, y: frame.y });
        const b = toScreen({ x: frame.x + frame.width, y: frame.y + frame.height });
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
        ctx.setLineDash([]);
        if (label) {
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.textBaseline = 'bottom';
          ctx.textAlign = 'right';
          ctx.fillText(label, b.x - 2, a.y - 3);
        }
        ctx.restore();
      }
      if (this.kind === 'input') {
        const paint = this.getInputPaint();
        if (!paint || !paint.isTexture()) {
          ctx.save();
          ctx.fillStyle = 'rgba(255,255,255,0.45)';
          ctx.font = '13px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(t(paint ? 'view.inputColorHint' : 'view.inputEmptyHint'), w / 2, h / 2);
          ctx.restore();
        } else if (!paint.ready) {
          ctx.save();
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.font = '13px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(t(paint.status === 'loading' ? 'view.loading' : 'view.missingMedia'), w / 2, h / 2);
          ctx.restore();
        }
      } else if (project.mappings.length === 0) {
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = '13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t(project.paints.length ? 'view.outputAddLayerHint' : 'view.outputEmptyHint'), w / 2, h / 2);
        ctx.restore();
      }
    }

    if (!app.settings.displayControls) return;
    const current = app.getCurrentMapping();
    if (current) {
      // Controls of the other layers using the same source.
      if (app.settings.displayPaintControls) {
        for (const m of project.getPaintMappings(current.paint)) {
          if (m === current) continue;
          const s = this.getShapeFromMapping(m);
          if (s) drawShapeOutline(ctx, s, toScreen, { selected: false });
        }
      }
      const shape = this.getShapeFromMapping(current);
      if (shape) {
        drawShapeControls(ctx, shape, toScreen, {
          selectedVertices: this.activeVertex >= 0 ? [this.activeVertex] : [],
          radius: this._vertexDrawRadius(),
        });
      }
    }
    if (this.presentation && this.hoverPoint && this.lastPointerType === 'mouse') {
      drawCrosshair(ctx, this.hoverPoint, w, h);
    }
  }

  _updateModeBar() {
    if (!this.modeBar) return;
    const shape = this.app.settings.displayControls ? this.getCurrentShape() : null;
    this.modeBar.hidden = !shape;
    if (!shape) return;
    for (const b of this.modeBar.querySelectorAll('button')) b.classList.toggle('active', +b.dataset.mode === shape.mode);
  }

  dispose() {
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
  }
}

export { boundingRect };
