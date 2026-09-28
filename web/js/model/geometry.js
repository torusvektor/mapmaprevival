/*
 * MapMap Web - geometry helpers.
 * Port of src/core/Maths.h and the parts of Qt (QPointF, QLineF, QTransform)
 * used by the original MapMap shape code.
 *
 * Coordinates use the screen convention (y axis pointing down), exactly like Qt.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

export const pt = (x, y) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.hypot(a.x, a.y);
export const distSq = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const dist = (a, b) => Math.sqrt(distSq(a, b));
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normalize(a) {
  const l = len(a);
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

/** Wrap value around, ie. wrapAround(-1, 3) === 2. */
export function wrapAround(index, max) {
  if (max <= 0) return 0;
  return ((index % max) + max) % max;
}

export function wrapAroundReal(value, max) {
  while (value < 0) value += max;
  while (value >= max) value -= max;
  return value;
}

export const degToRad = (d) => (d / 180) * Math.PI;
export const radToDeg = (r) => (r / Math.PI) * 180;

/**
 * Rotates a vector by angle (radians) using Qt's convention:
 * with y pointing down, a positive angle rotates clockwise on screen.
 */
export function rotateVec(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/**
 * 2D affine transform. Points are mapped as:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export class Affine {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    Object.assign(this, { a, b, c, d, e, f });
  }

  static translation(tx, ty) { return new Affine(1, 0, 0, 1, tx, ty); }
  static scaling(sx, sy = sx) { return new Affine(sx, 0, 0, sy, 0, 0); }
  static rotation(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Affine(c, s, -s, c, 0, 0);
  }

  /** Returns the transform that applies `this` first and then `other`. */
  then(other) {
    const m = this;
    const n = other;
    return new Affine(
      n.a * m.a + n.c * m.b,
      n.b * m.a + n.d * m.b,
      n.a * m.c + n.c * m.d,
      n.b * m.c + n.d * m.d,
      n.a * m.e + n.c * m.f + n.e,
      n.b * m.e + n.d * m.f + n.f
    );
  }

  map(p) {
    return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f };
  }

  inverted() {
    const det = this.a * this.d - this.b * this.c;
    if (Math.abs(det) < 1e-12) return new Affine();
    const ia = this.d / det;
    const ib = -this.b / det;
    const ic = -this.c / det;
    const id = this.a / det;
    return new Affine(ia, ib, ic, id, -(ia * this.e + ic * this.f), -(ib * this.e + id * this.f));
  }

  /** Transform that rotates (radians) / scales around a given center. */
  static aroundCenter(center, { rotate = 0, scaleX = 1, scaleY = 1 } = {}) {
    return Affine.translation(-center.x, -center.y)
      .then(Affine.scaling(scaleX, scaleY))
      .then(Affine.rotation(rotate))
      .then(Affine.translation(center.x, center.y));
  }
}

/**
 * Intersection of two segments (like QLineF::intersect).
 * Returns { type: 'none' | 'bounded' | 'unbounded', point }.
 */
export function intersectLines(p1, p2, p3, p4) {
  const d1 = sub(p2, p1);
  const d2 = sub(p4, p3);
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-12) return { type: 'none', point: null };
  const w = sub(p3, p1);
  const t = (w.x * d2.y - w.y * d2.x) / denom;
  const u = (w.x * d1.y - w.y * d1.x) / denom;
  const point = { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
  const bounded = t >= 0 && t <= 1 && u >= 0 && u <= 1;
  return { type: bounded ? 'bounded' : 'unbounded', point };
}

/** Odd-even fill rule point-in-polygon test (like QPolygonF::containsPoint). */
export function polygonContains(poly, p) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)) {
      const xCross = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

export function boundingRect(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function unionRect(r1, r2) {
  if (!r1) return r2;
  if (!r2) return r1;
  const x = Math.min(r1.x, r2.x);
  const y = Math.min(r1.y, r2.y);
  return {
    x, y,
    width: Math.max(r1.x + r1.width, r2.x + r2.width) - x,
    height: Math.max(r1.y + r1.height, r2.y + r2.height) - y,
  };
}

/** Signed side of point p relative to the line (a, b). */
export function side(a, b, p) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
