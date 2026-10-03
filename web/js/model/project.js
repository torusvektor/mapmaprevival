/*
 * MapMap Web - mappings (layers) and the project model.
 * Port of src/core/Mapping.{h,cpp} and src/core/MappingManager.{h,cpp}.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Mesh, Triangle, Ellipse, shapeFromJSON, shapesMatch } from './shapes.js';
import { createPaint, ColorPaint } from './paints.js';

export class Mapping {
  constructor(id, paint, shape, inputShape = null) {
    this.id = id;
    this.name = '';
    this.opacity = 1;
    this.locked = false;
    this.solo = false;
    this.visible = true;
    this.depth = id;
    this.paint = paint;
    this.shape = shape;
    this.inputShape = inputShape;
  }

  get isTexture() { return !!this.paint && this.paint.isTexture(); }
  get className() { return this.isTexture ? 'TextureMapping' : 'ColorMapping'; }
  get type() { return this.shape.type; }
  hasInputShape() { return this.isTexture && !!this.inputShape; }

  paintIsCompatible(paint) {
    return !!paint && paint.isTexture() === this.isTexture;
  }

  setLocked(locked) {
    this.locked = locked;
    if (this.shape) this.shape.locked = locked;
    if (this.inputShape) this.inputShape.locked = locked;
  }

  getComputedOpacity() { return this.opacity * (this.paint ? this.paint.opacity : 1); }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      opacity: this.opacity,
      locked: this.locked,
      solo: this.solo,
      visible: this.visible,
      depth: this.depth,
      paintId: this.paint ? this.paint.id : null,
      shape: this.shape.toJSON(),
      inputShape: this.hasInputShape() ? this.inputShape.toJSON() : null,
    };
  }

  /** Returns null when the output shape is invalid. */
  static fromJSON(json, paint) {
    const shape = shapeFromJSON(json.shape);
    if (!shape) return null;
    let inputShape = null;
    if (paint && paint.isTexture()) {
      inputShape = shapeFromJSON(json.inputShape);
      if (!shapesMatch(shape, inputShape)) inputShape = shape.clone();
    }
    const m = new Mapping(json.id, paint, shape, inputShape);
    m.name = json.name || '';
    m.opacity = json.opacity ?? 1;
    m.solo = !!json.solo;
    m.visible = json.visible !== false;
    m.depth = json.depth ?? json.id;
    m.setLocked(!!json.locked);
    return m;
  }
}

/** Default shapes for a texture of given rect (port of Util::create*ForTexture). */
export function createShapeForTexture(type, rect) {
  const { x, y, width: w, height: h } = rect;
  switch (type) {
    case 'triangle':
      return new Triangle({ x, y: y + h }, { x: x + w, y: y + h }, { x: x + w / 2, y });
    case 'ellipse':
      return new Ellipse({ x, y: y + h / 2 }, { x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, true);
    case 'mesh':
    default:
      return new Mesh({ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h });
  }
}

/** Default shapes for a color paint (port of Util::create*ForColor). */
export function createShapeForColor(type, frameWidth, frameHeight) {
  const W = frameWidth, H = frameHeight;
  switch (type) {
    case 'triangle':
      return new Triangle({ x: W / 4, y: (H * 3) / 4 }, { x: (W * 3) / 4, y: (H * 3) / 4 }, { x: W / 2, y: H / 4 });
    case 'ellipse':
      return new Ellipse({ x: W / 4, y: H / 2 }, { x: W / 2, y: H / 4 }, { x: (W * 3) / 4, y: H / 2 }, { x: W / 2, y: (H * 3) / 4 }, false);
    case 'mesh':
    default:
      return new Mesh({ x: W / 4, y: H / 4 }, { x: (W * 3) / 4, y: H / 4 }, { x: (W * 3) / 4, y: (H * 3) / 4 }, { x: W / 4, y: (H * 3) / 4 });
  }
}

export const DEFAULT_OUTPUT_WIDTH = 1920;
export const DEFAULT_OUTPUT_HEIGHT = 1080;

export class Project {
  constructor() {
    this.paints = [];
    this.mappings = []; // index 0 is the top-most layer
    this.outputWidth = DEFAULT_OUTPUT_WIDTH;
    this.outputHeight = DEFAULT_OUTPUT_HEIGHT;
    this.nextPaintId = 1;
    this.nextMappingId = 1;
  }

  allocatePaintId() { return this.nextPaintId++; }
  allocateMappingId() { return this.nextMappingId++; }

  reserveIds() {
    for (const p of this.paints) this.nextPaintId = Math.max(this.nextPaintId, p.id + 1);
    for (const m of this.mappings) this.nextMappingId = Math.max(this.nextMappingId, m.id + 1);
  }

  getPaintById(id) { return this.paints.find((p) => p.id === id) || null; }
  getMappingById(id) { return this.mappings.find((m) => m.id === id) || null; }
  getMappingIndex(id) { return this.mappings.findIndex((m) => m.id === id); }

  addPaint(paint) {
    this.paints.push(paint);
    this.nextPaintId = Math.max(this.nextPaintId, paint.id + 1);
    return paint.id;
  }

  /** Removes paint and all mappings using it. */
  removePaint(id) {
    const paint = this.getPaintById(id);
    if (!paint) return false;
    this.mappings = this.mappings.filter((m) => m.paint !== paint);
    this.paints = this.paints.filter((p) => p !== paint);
    this.updateMappingsDepths();
    return true;
  }

  addMapping(mapping) {
    this.mappings.unshift(mapping);
    this.nextMappingId = Math.max(this.nextMappingId, mapping.id + 1);
    return mapping.id;
  }

  removeMapping(id) {
    const idx = this.getMappingIndex(id);
    if (idx < 0) return false;
    this.mappings.splice(idx, 1);
    this.updateMappingsDepths();
    return true;
  }

  moveMapping(id, toIndex) {
    const idx = this.getMappingIndex(id);
    if (idx < 0) return false;
    toIndex = Math.max(0, Math.min(this.mappings.length - 1, toIndex));
    const [m] = this.mappings.splice(idx, 1);
    this.mappings.splice(toIndex, 0, m);
    this.updateMappingsDepths();
    return true;
  }

  updateMappingsDepths() {
    this.mappings.forEach((m, i) => { m.depth = i; });
  }

  getPaintMappings(paint) { return this.mappings.filter((m) => m.paint === paint); }

  getPaintsCompatibleWith(mapping) { return this.paints.filter((p) => mapping.paintIsCompatible(p)); }

  hasSolo() { return this.mappings.some((m) => m.solo); }

  /** Ordered list of visible mappings, using both the "visible" and "solo" properties. */
  getVisibleMappings() {
    const solo = this.hasSolo();
    return this.mappings.filter((m) => (solo ? m.solo : m.visible));
  }

  mappingIsVisible(mapping) {
    if (mapping.solo) return true;
    if (!mapping.visible) return false;
    return !this.hasSolo();
  }

  getVisiblePaints() {
    const set = new Set();
    for (const m of this.getVisibleMappings()) if (m.paint) set.add(m.paint);
    return [...set];
  }

  /** Snapshot of the model for undo/redo (paint objects are kept by reference). */
  snapshot() {
    return {
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      // The media blob is kept too, so undoing "replace file" brings the old media back.
      paints: this.paints.map((p) => ({ ref: p, data: p.toJSON(), blob: p.blob || null })),
      mappings: this.mappings.map((m) => m.toJSON()),
    };
  }

  /**
   * Restores a snapshot. Returns the paints whose media differs from the snapshot
   * ([{ paint, blob, uri }]); the caller reloads them (loading is asynchronous).
   */
  restore(snap) {
    this.outputWidth = snap.outputWidth;
    this.outputHeight = snap.outputHeight;
    const reload = [];
    this.paints = snap.paints.map(({ ref, data, blob }) => {
      ref.applyJSON(data);
      if (blob && ref.blob !== blob && ref.load) reload.push({ paint: ref, blob, uri: data.uri });
      return ref;
    });
    this.mappings = snap.mappings
      .map((json) => {
        const paint = this.getPaintById(json.paintId);
        return paint ? Mapping.fromJSON(json, paint) : null;
      })
      .filter(Boolean);
    this.reserveIds();
    return reload;
  }

  /** Plain JSON (without media) for persistence. */
  toJSON() {
    return {
      format: 'mapmap-web',
      version: 1,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      paints: this.paints.map((p) => p.toJSON()),
      mappings: this.mappings.map((m) => m.toJSON()),
    };
  }

  /** Creates a project from toJSON() data. Media still has to be loaded afterwards. */
  static fromJSON(json) {
    const project = new Project();
    const size = (n, def) => (Number.isFinite(n) && n > 0 ? n : def);
    project.outputWidth = size(json.outputWidth, DEFAULT_OUTPUT_WIDTH);
    project.outputHeight = size(json.outputHeight, DEFAULT_OUTPUT_HEIGHT);
    for (const pj of json.paints || []) {
      const paint = createPaint(pj.kind, pj.id);
      if (!paint) continue;
      paint.applyJSON(pj);
      project.paints.push(paint);
    }
    for (const mj of json.mappings || []) {
      const paint = project.getPaintById(mj.paintId);
      const mapping = paint ? Mapping.fromJSON(mj, paint) : null;
      if (mapping) project.mappings.push(mapping);
    }
    project.reserveIds();
    return project;
  }
}

export { ColorPaint };
