/*
 * MapMap Web - converts mappings to triangles for WebGL.
 * Port of the drawing code of src/gui/ShapeGraphicsItem.cpp:
 *  - triangles are mapped affinely,
 *  - mesh quads use the same bilinear correspondence as the desktop recursive subdivision,
 *  - ellipses are drawn as a fan around the (movable) center control point.
 *
 * Output arrays are interleaved [x, y, u, v] per vertex (u, v = normalized texture coords).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Mesh, Ellipse } from '../model/shapes.js';
import { side, dist } from '../model/geometry.js';

const ELLIPSE_N_TRIANGLES = 100;
const MESH_SUBDIVISION_STEP = 16; // approx. size (output units) of each sub-quad of a warped mesh cell
const MESH_MAX_SUBDIVISIONS = 48;

class Builder {
  constructor() { this.data = []; }
  v(p, t) { this.data.push(p.x, p.y, t ? t.x : 0, t ? t.y : 0); }
  tri(p0, p1, p2, t0, t1, t2) { this.v(p0, t0); this.v(p1, t1); this.v(p2, t2); }
  result() { return new Float32Array(this.data); }
}

const bilinear = (q, u, v) => {
  const [a, b, c, d] = q; // top-left, top-right, bottom-right, bottom-left
  const tx = a.x + (b.x - a.x) * u, ty = a.y + (b.y - a.y) * u;
  const bx = d.x + (c.x - d.x) * u, by = d.y + (c.y - d.y) * u;
  return { x: tx + (bx - tx) * v, y: ty + (by - ty) * v };
};

const isParallelogram = (q, eps) => {
  const [a, b, c, d] = q;
  return Math.abs(a.x + c.x - b.x - d.x) < eps && Math.abs(a.y + c.y - b.y - d.y) < eps;
};

/** Adds a (possibly concave) simple quad as two triangles split along its interior diagonal. */
function addQuad(builder, q, tq) {
  const [a, b, c, d] = q;
  const s1 = side(a, c, b);
  const s3 = side(a, c, d);
  if (s1 * s3 <= 0) {
    builder.tri(a, b, c, tq?.[0], tq?.[1], tq?.[2]);
    builder.tri(a, c, d, tq?.[0], tq?.[2], tq?.[3]);
  } else {
    builder.tri(a, b, d, tq?.[0], tq?.[1], tq?.[3]);
    builder.tri(b, c, d, tq?.[1], tq?.[2], tq?.[3]);
  }
}

function texCoordFn(rect) {
  const w = rect.width || 1;
  const h = rect.height || 1;
  return (p) => ({ x: (p.x - rect.x) / w, y: (p.y - rect.y) / h });
}

/** Triangles for a solid color shape. */
export function colorShapeTriangles(shape) {
  const b = new Builder();
  if (shape instanceof Mesh) {
    for (const column of shape.getQuads2d()) for (const q of column) addQuad(b, q, null);
  } else if (shape instanceof Ellipse) {
    const c = shape.getCenter();
    let prev = null;
    for (let k = 0; k <= ELLIPSE_N_TRIANGLES; k++) {
      const a = (k / ELLIPSE_N_TRIANGLES) * Math.PI * 2;
      const p = shape.fromUnitCircle({ x: Math.cos(a), y: Math.sin(a) });
      if (prev) b.tri(c, prev, p);
      prev = p;
    }
  } else if (shape.nVertices() === 3) {
    const [p0, p1, p2] = shape.vertices;
    b.tri(p0, p1, p2);
  } else if (shape.nVertices() === 4) {
    addQuad(b, shape.vertices, null);
  }
  return b.result();
}

/** Triangles for a texture mapping (output positions + input texture coordinates). */
export function textureMappingTriangles(outputShape, inputShape, rect) {
  const tc = texCoordFn(rect);
  const b = new Builder();
  if (outputShape instanceof Mesh && inputShape instanceof Mesh) {
    const outQuads = outputShape.getQuads2d();
    const inQuads = inputShape.getQuads2d();
    for (let x = 0; x < outQuads.length; x++) {
      for (let y = 0; y < outQuads[x].length; y++) {
        const qo = outQuads[x][y];
        const qi = inQuads[x]?.[y];
        if (!qi) continue;
        addMeshCell(b, qo, qi.map(tc), qi);
      }
    }
  } else if (outputShape instanceof Ellipse && inputShape instanceof Ellipse) {
    addTexturedEllipse(b, outputShape, inputShape, tc);
  } else {
    const n = Math.min(outputShape.nVertices(), inputShape.nVertices());
    if (n === 3) {
      const o = outputShape.vertices, i = inputShape.vertices;
      b.tri(o[0], o[1], o[2], tc(i[0]), tc(i[1]), tc(i[2]));
    } else if (n === 4) {
      addMeshCell(b, outputShape.vertices, inputShape.vertices.map(tc), inputShape.vertices);
    }
  }
  return b.result();
}

function addMeshCell(b, qo, qt, qi) {
  // Affine correspondence: two triangles are exact.
  if (isParallelogram(qo, 0.5) && isParallelogram(qi, 0.5)) {
    addQuad(b, qo, qt);
    return;
  }
  const size = Math.max(dist(qo[0], qo[1]), dist(qo[1], qo[2]), dist(qo[2], qo[3]), dist(qo[3], qo[0]));
  const n = Math.max(2, Math.min(MESH_MAX_SUBDIVISIONS, Math.ceil(size / MESH_SUBDIVISION_STEP)));
  // Bilinear correspondence (same limit as the desktop recursive midpoint subdivision).
  const po = [];
  const pt = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      po.push(bilinear(qo, i / n, j / n));
      pt.push(bilinear(qt, i / n, j / n));
    }
  }
  const idx = (i, j) => j * (n + 1) + i;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = idx(i, j), bb = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
      b.tri(po[a], po[bb], po[c], pt[a], pt[bb], pt[c]);
      b.tri(po[a], po[c], po[d], pt[a], pt[c], pt[d]);
    }
  }
}

/** Port of EllipseTextureGraphicsItem::DrawingData. */
function ellipseDrawingData(ellipse) {
  const center = ellipse.getCenter();
  const controlCenter = ellipse.hasCenterControl() ? ellipse.vertices[4] : center;
  const hr = ellipse.getHorizontalRadius();
  const vr = ellipse.getVerticalRadius();
  const rotation = ellipse.getRotationRadians();
  const u = ellipse.toUnitCircle(controlCenter);
  const a1 = Math.asin(Math.max(-1, Math.min(1, u.y)));
  const a2 = Math.acos(Math.max(-1, Math.min(1, u.x)));
  const quarterAngles = [a1, a2, Math.PI - a1, 2 * Math.PI - a2];
  return {
    controlCenter,
    quarterAngles,
    spanInQuarter(q) {
      let span = quarterAngles[(q + 1) % 4] - quarterAngles[q];
      while (span < 0) span += 2 * Math.PI;
      return span;
    },
    pointAt(angle) {
      const xc = Math.cos(angle) * hr;
      const yc = Math.sin(angle) * vr;
      const d = Math.sqrt(xc * xc + yc * yc);
      const a = Math.atan2(yc, xc);
      return { x: Math.cos(a + rotation) * d + center.x, y: Math.sin(a + rotation) * d + center.y };
    },
  };
}

function addTexturedEllipse(b, outputEllipse, inputEllipse, tc) {
  const inData = ellipseDrawingData(inputEllipse);
  const outData = ellipseDrawingData(outputEllipse);
  const tcCenter = tc(inData.controlCenter);
  for (let q = 0; q < 4; q++) {
    const inSpan = inData.spanInQuarter(q);
    const outSpan = outData.spanInQuarter(q);
    const nTriangles = Math.max(1, Math.ceil((outSpan / (2 * Math.PI)) * ELLIPSE_N_TRIANGLES));
    const inStep = inSpan / nTriangles;
    const outStep = outSpan / nTriangles;
    let inAngle = inData.quarterAngles[q];
    let outAngle = outData.quarterAngles[q];
    let prevIn = null, prevOut = null;
    for (let j = 0; j <= nTriangles; j++, inAngle += inStep, outAngle += outStep) {
      const curIn = inData.pointAt(inAngle);
      const curOut = outData.pointAt(outAngle);
      if (j > 0) b.tri(outData.controlCenter, prevOut, curOut, tcCenter, tc(prevIn), tc(curIn));
      prevIn = curIn;
      prevOut = curOut;
    }
  }
}

/** Cache key describing everything the triangles depend on. */
export function geometryKey(mapping, rect) {
  const parts = [mapping.paint?.isTexture() ? 't' : 'c'];
  const push = (s) => {
    if (!s) return;
    parts.push(s.className, s.nColumns || 0);
    for (const v of s.vertices) parts.push(v.x.toFixed(2), v.y.toFixed(2));
  };
  push(mapping.shape);
  if (mapping.isTexture) {
    push(mapping.inputShape);
    parts.push(rect.x, rect.y, rect.width, rect.height);
  }
  return parts.join(',');
}
