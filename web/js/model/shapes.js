/*
 * MapMap Web - shapes.
 * Port of src/shape/{Shape,Polygon,Quad,Triangle,Mesh,Ellipse}.{h,cpp}.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {
  Affine, add, sub, mul, dot, len, normalize, wrapAround, intersectLines,
  polygonContains, rotateVec, boundingRect,
} from './geometry.js';

export const ShapeMode = Object.freeze({ Default: 0, Scale: 1, Rotate: 2 });

const CONSTRAIN_VERTEX_SEGMENT_ELONGATION = 10.0;
const CONSTRAIN_VERTEX_INTERSECTION_PULLAWAY = 30.0;

const copyPoints = (points) => points.map((p) => ({ x: +p.x, y: +p.y }));

export class Shape {
  constructor(vertices = []) {
    this.vertices = copyPoints(vertices);
    this.locked = false;
    this.mode = ShapeMode.Default;
  }

  /** Class name as used in the .mmp file format. */
  get className() { return 'Shape'; }
  /** 'mesh' | 'triangle' | 'ellipse' | 'quad' */
  get type() { return 'shape'; }

  build() {}

  nVertices() { return this.vertices.length; }
  getVertex(i) { return this.vertices[i]; }
  getVertices() { return this.vertices; }

  setVertices(vertices) { this.vertices = copyPoints(vertices); }

  /** Sets vertex (subclasses may constrain it). */
  setVertex(i, v) { this._rawSetVertex(i, v); }

  _rawSetVertex(i, v) { this.vertices[i] = { x: v.x, y: v.y }; }

  isMajorVertex() { return true; }

  getCenter() {
    let x = 0, y = 0;
    for (const v of this.vertices) { x += v.x; y += v.y; }
    const n = this.vertices.length || 1;
    return { x: x / n, y: y / n };
  }

  applyTransform(affine) {
    this.vertices = this.vertices.map((v) => affine.map(v));
  }

  translate(offset) {
    this.vertices = this.vertices.map((v) => ({ x: v.x + offset.x, y: v.y + offset.y }));
  }

  /** Rotation in radians around center. */
  rotate(angle) {
    this.applyTransform(Affine.aroundCenter(this.getCenter(), { rotate: angle }));
  }

  scale(factor) {
    this.applyTransform(Affine.aroundCenter(this.getCenter(), { scaleX: factor, scaleY: factor }));
  }

  flip(horizontal) {
    this.applyTransform(Affine.aroundCenter(this.getCenter(), horizontal ? { scaleX: -1 } : { scaleY: -1 }));
  }

  setShapeMode(mode, next = false) {
    this.mode = next ? (mode + 1) % 3 : mode;
  }

  includesPoint() { return false; }

  /** Polygon approximating the contour of the shape (used for outlines, bounds). */
  toPolygon() { return this.vertices; }

  boundingRect() { return boundingRect(this.toPolygon()); }

  copyFrom(shape) { this.setVertices(shape.vertices); this.build(); }

  clone() {
    const s = new this.constructor();
    s.copyFrom(this);
    s.locked = this.locked;
    return s;
  }

  toJSON() {
    return { className: this.className, locked: this.locked, vertices: copyPoints(this.vertices) };
  }
}

export class Polygon extends Shape {
  toPolygon() { return this.vertices; }

  includesPoint(p) { return polygonContains(this.toPolygon(), p); }

  setVertex(i, v) {
    const realV = constrainVertex(this.toPolygon(), i, v);
    this._rawSetVertex(i, realV);
  }
}

/**
 * Makes sure vertex v, as the i-th point of polygon, does not make the polygon
 * self-intersect (port of Polygon::_constrainVertex).
 */
export function constrainVertex(polygon, i, v) {
  if (polygon.length <= 3) return { x: v.x, y: v.y };
  v = { x: v.x, y: v.y };
  const n = polygon.length;
  const originalV = polygon[i];
  const originalToNew = [originalV, v];

  const segments = [];
  for (let k = 0; k < n; k++) segments.push([polygon[k], polygon[(k + 1) % n]]);
  const prev = wrapAround(i - 1, n);
  const next = wrapAround(i + 1, n);
  segments[prev] = [polygon[prev], v];
  segments[i] = [v, polygon[next]];

  // Stretch segments a little bit to cope with approximation errors.
  for (let k = 0; k < n; k++) {
    const [p1, p2] = segments[k];
    const diff = mul(normalize(sub(p2, p1)), CONSTRAIN_VERTEX_SEGMENT_ELONGATION);
    segments[k] = [sub(p1, diff), add(p2, diff)];
  }

  for (let adj = 0; adj < 2; adj++) {
    const idx = wrapAround(i + adj - 1, n);
    for (let j = 0; j < n; j++) {
      if (j !== idx && j !== wrapAround(idx - 1, n) && j !== wrapAround(idx + 1, n)) {
        let inter = intersectLines(segments[idx][0], segments[idx][1], segments[j][0], segments[j][1]);
        if (inter.type !== 'bounded') {
          inter = intersectLines(originalToNew[0], originalToNew[1], segments[j][0], segments[j][1]);
        }
        if (inter.type === 'bounded') {
          const diff = mul(normalize(sub(inter.point, originalV)), CONSTRAIN_VERTEX_INTERSECTION_PULLAWAY);
          v = sub(inter.point, diff);
          segments[prev] = [polygon[prev], v];
          segments[i] = [v, polygon[next]];
        }
      }
    }
  }
  return v;
}

export class Triangle extends Polygon {
  constructor(p1, p2, p3) {
    super(p1 ? [p1, p2, p3] : [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
  }
  get className() { return 'Triangle'; }
  get type() { return 'triangle'; }
}

export class Quad extends Polygon {
  constructor(p1, p2, p3, p4) {
    super(p1 ? [p1, p2, p3, p4] : [0, 1, 2, 3].map(() => ({ x: 0, y: 0 })));
  }
  get className() { return 'Quad'; }
  get type() { return 'quad'; }
}

/**
 * Mesh of quads. Vertices are stored in row-major order:
 *
 *   0----1----2----3
 *   |    |    |    |
 *   4----5----6----7
 */
export class Mesh extends Quad {
  /**
   * new Mesh(p1, p2, p3, p4): quad mesh from 4 corners in clockwise order
   * (top-left, top-right, bottom-right, bottom-left), like the Quad constructor.
   */
  constructor(p1, p2, p3, p4) {
    super();
    if (p1) this.init([p1, p2, p4, p3], 2, 2);
    else this.init([0, 1, 2, 3].map(() => ({ x: 0, y: 0 })), 2, 2);
  }

  static fromGrid(points, nColumns, nRows) {
    const m = new Mesh();
    m.init(points, nColumns, nRows);
    return m;
  }

  get className() { return 'Mesh'; }
  get type() { return 'mesh'; }

  init(points, nColumns, nRows) {
    this.nColumns = nColumns;
    this.nRows = nRows;
    this.setVertices(points);
  }

  getVertex2d(x, y) { return this.vertices[y * this.nColumns + x]; }
  setVertex2d(x, y, v) { this.vertices[y * this.nColumns + x] = { x: v.x, y: v.y }; }

  nHorizontalQuads() { return this.nColumns - 1; }
  nVerticalQuads() { return this.nRows - 1; }

  isMajorVertex(idx) {
    const n = this.nVertices();
    return idx === 0 || idx === this.nColumns - 1 || idx === n - 1 || idx === n - this.nColumns;
  }

  /** Contour of the mesh. */
  toPolygon() {
    const poly = [];
    const nc = this.nColumns, nr = this.nRows;
    for (let i = 0; i < nc; i++) poly.push(this.getVertex2d(i, 0));
    for (let i = 1; i < nr - 1; i++) poly.push(this.getVertex2d(nc - 1, i));
    for (let i = nc - 1; i >= 0; i--) poly.push(this.getVertex2d(i, nr - 1));
    for (let i = nr - 2; i >= 1; i--) poly.push(this.getVertex2d(0, i));
    return poly;
  }

  setVertex(i, v) {
    const col = i % this.nColumns;
    const row = Math.floor(i / this.nColumns);
    let realV = { x: v.x, y: v.y };
    const g = (x, y) => this.getVertex2d(x, y);
    // Constrain vertex to stay within the internal quads it is part of.
    if (col < this.nColumns - 1) {
      if (row < this.nRows - 1)
        realV = constrainVertex([g(col, row), g(col + 1, row), g(col + 1, row + 1), g(col, row + 1)], 0, realV);
      if (row > 0)
        realV = constrainVertex([g(col, row), g(col + 1, row), g(col + 1, row - 1), g(col, row - 1)], 0, realV);
    }
    if (col > 0) {
      if (row < this.nRows - 1)
        realV = constrainVertex([g(col, row), g(col - 1, row), g(col - 1, row + 1), g(col, row + 1)], 0, realV);
      if (row > 0)
        realV = constrainVertex([g(col, row), g(col - 1, row), g(col - 1, row - 1), g(col, row - 1)], 0, realV);
    }
    this._rawSetVertex(i, realV);
  }

  _grid() {
    const grid = [];
    for (let x = 0; x < this.nColumns; x++) {
      grid.push([]);
      for (let y = 0; y < this.nRows; y++) grid[x].push({ ...this.getVertex2d(x, y) });
    }
    return grid;
  }

  _setGrid(grid) {
    this.nColumns = grid.length;
    this.nRows = grid[0].length;
    const v = [];
    for (let y = 0; y < this.nRows; y++)
      for (let x = 0; x < this.nColumns; x++) v.push(grid[x][y]);
    this.vertices = v;
  }

  addColumn() {
    const nc = this.nColumns;
    const grid = this._grid();
    const leftMoveProp = 1 / (nc - 1) - 1 / nc;
    const newGrid = [];
    for (let x = 0; x <= nc; x++) newGrid.push([]);
    for (let y = 0; y < this.nRows; y++) {
      const left = grid[0][y];
      const right = grid[nc - 1][y];
      const diff = sub(right, left);
      for (let x = 1; x < nc - 1; x++) grid[x][y] = sub(grid[x][y], mul(diff, x * leftMoveProp));
      const newPoint = sub(right, mul(diff, 1 / nc));
      for (let x = 0; x < nc - 1; x++) newGrid[x][y] = grid[x][y];
      newGrid[nc - 1][y] = newPoint;
      newGrid[nc][y] = grid[nc - 1][y];
    }
    this._setGrid(newGrid);
  }

  addRow() {
    const nr = this.nRows;
    const grid = this._grid();
    const topMoveProp = 1 / (nr - 1) - 1 / nr;
    const newGrid = grid.map(() => []);
    for (let x = 0; x < this.nColumns; x++) {
      const top = grid[x][0];
      const bottom = grid[x][nr - 1];
      const diff = sub(bottom, top);
      for (let y = 1; y < nr - 1; y++) grid[x][y] = sub(grid[x][y], mul(diff, y * topMoveProp));
      const newPoint = sub(bottom, mul(diff, 1 / nr));
      for (let y = 0; y < nr - 1; y++) newGrid[x][y] = grid[x][y];
      newGrid[x][nr - 1] = newPoint;
      newGrid[x][nr] = grid[x][nr - 1];
    }
    this._setGrid(newGrid);
  }

  removeColumn(columnId) {
    const nc = this.nColumns;
    if (columnId < 1 || columnId >= nc - 1) return;
    const grid = this._grid();
    const rightMoveProp = 1 / (nc - 2) - 1 / (nc - 1);
    const newGrid = [];
    for (let x = 0; x < nc - 1; x++) newGrid.push([]);
    for (let y = 0; y < this.nRows; y++) {
      const diff = sub(grid[nc - 1][y], grid[0][y]);
      for (let x = 0; x < nc; x++) {
        if (x === columnId) continue;
        let p = grid[x][y];
        const newX = x < columnId ? x : x - 1;
        if (x > 0 && x < nc - 1) p = add(p, mul(diff, (x < columnId ? 1 : -1) * newX * rightMoveProp));
        newGrid[newX][y] = p;
      }
    }
    this._setGrid(newGrid);
  }

  removeRow(rowId) {
    const nr = this.nRows;
    if (rowId < 1 || rowId >= nr - 1) return;
    const grid = this._grid();
    const bottomMoveProp = 1 / (nr - 2) - 1 / (nr - 1);
    const newGrid = grid.map(() => []);
    for (let x = 0; x < this.nColumns; x++) {
      const diff = sub(grid[x][nr - 1], grid[x][0]);
      for (let y = 0; y < nr; y++) {
        if (y === rowId) continue;
        let p = grid[x][y];
        const newY = y < rowId ? y : y - 1;
        if (y > 0 && y < nr - 1) p = add(p, mul(diff, (y < rowId ? 1 : -1) * newY * bottomMoveProp));
        newGrid[x][newY] = p;
      }
    }
    this._setGrid(newGrid);
  }

  resize(nColumns, nRows) {
    nColumns = Math.max(2, Math.round(nColumns));
    nRows = Math.max(2, Math.round(nRows));
    while (nColumns < this.nColumns) this.removeColumn(this.nColumns - 2);
    while (nRows < this.nRows) this.removeRow(this.nRows - 2);
    while (nColumns > this.nColumns) this.addColumn();
    while (nRows > this.nRows) this.addRow();
  }

  /** quads[x][y] = [topLeft, topRight, bottomRight, bottomLeft] */
  getQuads2d() {
    const quads = [];
    for (let x = 0; x < this.nHorizontalQuads(); x++) {
      const column = [];
      for (let y = 0; y < this.nVerticalQuads(); y++) {
        column.push([this.getVertex2d(x, y), this.getVertex2d(x + 1, y), this.getVertex2d(x + 1, y + 1), this.getVertex2d(x, y + 1)]);
      }
      quads.push(column);
    }
    return quads;
  }

  copyFrom(shape) {
    this.nColumns = shape.nColumns;
    this.nRows = shape.nRows;
    this.setVertices(shape.vertices);
  }

  toJSON() {
    return { ...super.toJSON(), nColumns: this.nColumns, nRows: this.nRows };
  }
}

/**
 * Ellipse controlled by 4 points on its axes (0 and 2 on the "horizontal" axis,
 * 1 and 3 on the "vertical" axis) plus an optional 5th center control point
 * used for texture mapping.
 */
export class Ellipse extends Shape {
  constructor(p1, p2, p3, p4, p5OrHasCenter = true) {
    super();
    if (p1) {
      this.vertices = [p1, p2, p3, p4].map((p) => ({ x: p.x, y: p.y }));
      if (typeof p5OrHasCenter === 'object' && p5OrHasCenter) this.vertices.push({ ...p5OrHasCenter });
      else if (p5OrHasCenter) this.vertices.push(this.getCenter());
      this.build();
    }
  }

  get className() { return 'Ellipse'; }
  get type() { return 'ellipse'; }

  build() { if (this.vertices.length >= 4) this.sanitize(); }

  hasCenterControl() { return this.vertices.length === 5; }

  getHorizontalAxis() { return sub(this.vertices[0], this.vertices[2]); }
  getVerticalAxis() { return sub(this.vertices[1], this.vertices[3]); }
  getCenter() {
    if (this.vertices.length < 4) return super.getCenter();
    return sub(this.vertices[0], mul(this.getHorizontalAxis(), 0.5));
  }
  getHorizontalRadius() { return len(this.getHorizontalAxis()) / 2; }
  getVerticalRadius() { return len(this.getVerticalAxis()) / 2; }
  getRotationRadians() {
    const h = this.getHorizontalAxis();
    return Math.atan2(h.y, h.x);
  }

  /** Maps a point from ellipse coordinates to the unit circle. */
  toUnitCircle(p) {
    const c = this.getCenter();
    const hr = this.getHorizontalRadius() || 1e-9;
    const vr = this.getVerticalRadius() || 1e-9;
    const r = rotateVec(sub(p, c), -this.getRotationRadians());
    return { x: r.x / hr, y: r.y / vr };
  }

  /** Maps a point from the unit circle to ellipse coordinates. */
  fromUnitCircle(q) {
    const c = this.getCenter();
    const r = rotateVec({ x: q.x * this.getHorizontalRadius(), y: q.y * this.getVerticalRadius() }, this.getRotationRadians());
    return add(r, c);
  }

  clipInside(v) {
    const u = this.toUnitCircle(v);
    const l = len(u);
    return l <= 1 ? { x: v.x, y: v.y } : this.fromUnitCircle({ x: u.x / l, y: u.y / l });
  }

  sanitize() {
    const hAxis = this.getHorizontalAxis();
    const center = this.getCenter();
    const vAxisNormalized = normalize({ x: hAxis.y, y: -hAxis.x });
    const vFromCenter = sub(this.vertices[1], center);
    const projection = mul(vAxisNormalized, dot(vFromCenter, vAxisNormalized));
    this._rawSetVertex(1, add(center, projection));
    this._rawSetVertex(3, sub(center, projection));
    if (this.hasCenterControl()) this._rawSetVertex(4, this.clipInside(this.vertices[4]));
  }

  includesPoint(p) { return len(this.toUnitCircle(p)) <= 1; }

  isMajorVertex(idx) { return !this.hasCenterControl() || idx !== 4; }

  setVertex(i, v) {
    const vAxis = this.getVerticalAxis();
    if (i === 0 || i === 2) {
      // Remember positions of dependent points in unit circle space, then re-map.
      const u1 = this.toUnitCircle(this.vertices[1]);
      const u3 = this.toUnitCircle(this.vertices[3]);
      const u4 = this.hasCenterControl() ? this.toUnitCircle(this.vertices[4]) : null;
      this._rawSetVertex(i, v);
      // Compute all remapped points before modifying them (the transform depends on them).
      const n1 = this.fromUnitCircle(u1);
      const n3 = this.fromUnitCircle(u3);
      const n4 = u4 ? this.fromUnitCircle(u4) : null;
      this._rawSetVertex(1, n1);
      this._rawSetVertex(3, n3);
      if (n4) this._rawSetVertex(4, n4);
    } else if (i === 1 || i === 3) {
      const center = this.getCenter();
      const vFromCenter = sub(v, center);
      const vAxisNormalized = normalize(vAxis);
      const projection = mul(vAxisNormalized, dot(vFromCenter, vAxisNormalized));
      const v1 = i === 1 ? add(center, projection) : sub(center, projection);
      const v3 = i === 1 ? sub(center, projection) : add(center, projection);
      const u4 = this.hasCenterControl() ? this.toUnitCircle(this.vertices[4]) : null;
      this._rawSetVertex(1, v1);
      this._rawSetVertex(3, v3);
      if (u4) this._rawSetVertex(4, this.fromUnitCircle(u4));
    } else if (this.hasCenterControl()) {
      this._rawSetVertex(4, this.clipInside(v));
    }
    this.sanitize();
  }

  /** Contour polygon approximation (for outlines / bounds). */
  toPolygon(segments = 72) {
    const pts = [];
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      pts.push(this.fromUnitCircle({ x: Math.cos(a), y: Math.sin(a) }));
    }
    return pts;
  }

  copyFrom(shape) { this.setVertices(shape.vertices); }
}

/** Creates a shape instance from its .mmp class name. */
export function createShape(className) {
  switch (className) {
    case 'Mesh': return new Mesh();
    case 'Quad': return new Quad();
    case 'Triangle': return new Triangle();
    case 'Ellipse': return new Ellipse();
    default: return null;
  }
}

/**
 * Whether the vertices fit the shape class: finite coordinates and the vertex count the
 * class needs (a Mesh needs its full grid). Damaged files are rejected here rather than
 * failing later while drawing.
 */
export function validShapeData(className, vertices, nColumns, nRows) {
  if (!Array.isArray(vertices)) return false;
  if (!vertices.every((v) => v && Number.isFinite(v.x) && Number.isFinite(v.y))) return false;
  const n = vertices.length;
  switch (className) {
    case 'Triangle': return n === 3;
    case 'Quad': return n === 4;
    case 'Ellipse': return n === 4 || n === 5;
    case 'Mesh':
      return Number.isInteger(nColumns) && Number.isInteger(nRows) && nColumns >= 2 && nRows >= 2 && n === nColumns * nRows;
    default: return false;
  }
}

/** Whether `input` can be the input (source) shape of a layer whose output shape is `shape`. */
export function shapesMatch(shape, input) {
  if (!shape || !input || input.className !== shape.className || input.nVertices() !== shape.nVertices()) return false;
  return !(shape instanceof Mesh) || (input.nColumns === shape.nColumns && input.nRows === shape.nRows);
}

/** Restores a shape from toJSON() output; returns null for invalid data. */
export function shapeFromJSON(json) {
  if (!json || !validShapeData(json.className, json.vertices, json.nColumns, json.nRows)) return null;
  const shape = createShape(json.className);
  if (shape instanceof Mesh) shape.init(json.vertices, json.nColumns, json.nRows);
  else shape.setVertices(json.vertices);
  shape.locked = !!json.locked;
  return shape;
}
