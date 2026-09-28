/*
 * MapMap Web - 2D overlay drawing: shape controls, vertices, crosshair, test cards.
 * Port of src/gui/ShapeControlPainter.cpp, Util::drawControlsVertex and
 * the test signals of src/gui/OutputGLCanvas.cpp.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Mesh, Ellipse, ShapeMode } from '../model/shapes.js';

export const COLORS = {
  control: '#f6f5f5',
  controlNonSelected: 'rgba(246,245,245,0.28)',
  locked: '#e0303c',
  vertexBackground: 'rgba(0,0,0,0.5)',
  vertexSelected: 'rgba(246,245,245,0.75)',
  crosshairStroke: 'rgba(0,0,0,0.25)',
};

export const SHAPE_STROKE_WIDTH = 1.5;
export const SHAPE_INNER_STROKE_WIDTH = 0.5;
export const VERTEX_SELECT_STROKE_WIDTH = 2;

/**
 * Draws the outline of a shape.
 * toScreen maps scene points to canvas (CSS pixel) coordinates.
 */
export function drawShapeOutline(ctx, shape, toScreen, { selected = true } = {}) {
  const color = selected ? (shape.locked ? COLORS.locked : COLORS.control) : COLORS.controlNonSelected;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  if (shape instanceof Mesh) {
    ctx.lineWidth = SHAPE_INNER_STROKE_WIDTH;
    ctx.beginPath();
    for (let x = 1; x < shape.nColumns - 1; x++) {
      for (let y = 0; y < shape.nRows; y++) {
        const p = toScreen(shape.getVertex2d(x, y));
        if (y === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
    }
    for (let y = 1; y < shape.nRows - 1; y++) {
      for (let x = 0; x < shape.nColumns; x++) {
        const p = toScreen(shape.getVertex2d(x, y));
        if (x === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
  }
  ctx.lineWidth = SHAPE_STROKE_WIDTH;
  ctx.beginPath();
  const poly = shape instanceof Ellipse ? shape.toPolygon(96) : shape.toPolygon();
  poly.forEach((v, i) => {
    const p = toScreen(v);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawScaleIcon(ctx, x, y, r) {
  const k = r * 0.55;
  ctx.beginPath();
  ctx.moveTo(x - k, y - k); ctx.lineTo(x + k, y + k);
  // arrow heads
  const h = r * 0.35;
  ctx.moveTo(x - k, y - k); ctx.lineTo(x - k + h, y - k);
  ctx.moveTo(x - k, y - k); ctx.lineTo(x - k, y - k + h);
  ctx.moveTo(x + k, y + k); ctx.lineTo(x + k - h, y + k);
  ctx.moveTo(x + k, y + k); ctx.lineTo(x + k, y + k - h);
  ctx.stroke();
}

function drawRotateIcon(ctx, x, y, r) {
  const rr = r * 0.55;
  ctx.beginPath();
  ctx.arc(x, y, rr, -Math.PI * 0.1, Math.PI * 1.35);
  ctx.stroke();
  const a = -Math.PI * 0.1;
  const ex = x + Math.cos(a) * rr;
  const ey = y + Math.sin(a) * rr;
  const h = r * 0.35;
  ctx.beginPath();
  ctx.moveTo(ex, ey); ctx.lineTo(ex - h * 0.2, ey - h);
  ctx.moveTo(ex, ey); ctx.lineTo(ex - h, ey + h * 0.1);
  ctx.stroke();
}

/** Port of Util::drawControlsVertex. */
export function drawVertex(ctx, p, { major = true, selected = false, locked = false, mode = ShapeMode.Default, radius = 12 }) {
  ctx.save();
  if (locked) {
    ctx.fillStyle = COLORS.locked;
    ctx.strokeStyle = COLORS.locked;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.fillStyle = selected ? COLORS.vertexSelected : COLORS.vertexBackground;
  ctx.strokeStyle = COLORS.control;
  ctx.lineWidth = VERTEX_SELECT_STROKE_WIDTH;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const iconColor = selected ? '#111' : COLORS.control;
  ctx.strokeStyle = iconColor;
  if (mode === ShapeMode.Default) {
    const o = Math.sin(Math.PI / 4) * radius;
    ctx.beginPath();
    ctx.moveTo(p.x + o, p.y + o); ctx.lineTo(p.x - o, p.y - o);
    ctx.moveTo(p.x + o, p.y - o); ctx.lineTo(p.x - o, p.y + o);
    ctx.stroke();
  } else if (major) {
    ctx.lineWidth = 1.6;
    if (mode === ShapeMode.Scale) drawScaleIcon(ctx, p.x, p.y, radius);
    else drawRotateIcon(ctx, p.x, p.y, radius);
  }
  ctx.restore();
}

export function drawShapeControls(ctx, shape, toScreen, { selectedVertices = [], radius = 12 } = {}) {
  drawShapeOutline(ctx, shape, toScreen, { selected: true });
  for (let i = 0; i < shape.nVertices(); i++) {
    drawVertex(ctx, toScreen(shape.getVertex(i)), {
      major: shape.isMajorVertex(i),
      selected: selectedVertices.includes(i),
      locked: shape.locked,
      mode: shape.mode,
      radius,
    });
  }
}

/** Crosshair used in the output window (port of OutputGLCanvas::drawForeground). */
export function drawCrosshair(ctx, p, width, height) {
  ctx.save();
  ctx.strokeStyle = COLORS.crosshairStroke;
  ctx.fillStyle = COLORS.control;
  ctx.fillRect(p.x - 2, 0, 4, height);
  ctx.strokeRect(p.x - 2, 0, 4, height);
  ctx.fillRect(0, p.y - 2, width, 4);
  ctx.strokeRect(0, p.y - 2, width, 4);
  ctx.strokeStyle = COLORS.control;
  ctx.fillStyle = COLORS.crosshairStroke;
  ctx.fillRect(p.x - 10, p.y - 10, 20, 20);
  ctx.strokeRect(p.x - 10, p.y - 10, 20, 20);
  ctx.restore();
}

/* ------------------------------------------------------------ test cards */

const testImages = {};
let onTestImageLoad = null;
function testImage(name) {
  if (!testImages[name]) {
    const img = new Image();
    img.onload = () => onTestImageLoad && onTestImageLoad();
    img.src = new URL(`../../assets/${name}`, import.meta.url).href;
    testImages[name] = img;
  }
  const img = testImages[name];
  return img.complete && img.naturalWidth ? img : null;
}

/** Preloads the test card images; onLoad is called when one finishes loading (to redraw). */
export function preloadTestCards(onLoad = null) {
  onTestImageLoad = onLoad;
  ['test-signal.svg', 'pal-test-signal.svg', 'ntsc-test-signal.svg', 'mapmap-logo.svg'].forEach((n) => testImage(n));
}

function drawResolutionText(ctx, rect, fontSize, text) {
  ctx.fillStyle = '#000';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(fontSize)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2);
}

/**
 * Draws a test card in the rectangle (x, y, w, h) of the canvas.
 * type: 0 = classic, 1 = PAL, 2 = NTSC.
 */
export function drawTestCard(ctx, type, x, y, w, h, { resolutionText = null } = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x, y);
  if (type === 1) {
    const size = Math.max(20, Math.round(Math.min(w, h) / 12.7));
    const mx = (size - (w % size)) / 2;
    const my = (size - (h % size)) / 2;
    for (let gx = 0; gx < w + size; gx += size) {
      for (let gy = 0; gy < h + size; gy += size) {
        const inner = gx > 0 && gx <= w - size && gy > 0 && gy <= h - size;
        const rx = gx - mx, ry = gy - my;
        if (inner) {
          ctx.fillStyle = '#808080';
          ctx.fillRect(rx, ry, size, size);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 3;
          ctx.strokeRect(rx, ry, size, size);
        } else {
          ctx.fillStyle = ((gx + gy) / size) % 2 === 0 ? '#fff' : '#000';
          ctx.fillRect(rx, ry, size, size);
        }
      }
    }
    const img = testImage('pal-test-signal.svg');
    const s = h - size * 2;
    if (img && s > 0) {
      const ix = (w - s) / 2, iy = (h - s) / 2;
      ctx.drawImage(img, ix, iy, s, s);
      if (resolutionText) {
        const fs = s / 18;
        drawResolutionText(ctx, { x: w / 2 - fs * 3, y: iy + s / 19, w: fs * 6, h: fs }, fs * 0.8, resolutionText);
      }
    }
  } else if (type === 2) {
    const img = testImage('ntsc-test-signal.svg');
    if (img) ctx.drawImage(img, 0, 0, w, h);
    const logo = testImage('mapmap-logo.svg');
    if (logo) {
      const lh = h / 15;
      const lw = (logo.naturalWidth / logo.naturalHeight) * lh;
      ctx.drawImage(logo, (w - lw) / 2, h / 4, lw, lh);
    }
    if (resolutionText) {
      const fs = h / 21;
      drawResolutionText(ctx, { x: w / 2 - fs * 3, y: h / 3, w: fs * 6, h: fs }, fs * 0.8, resolutionText);
    }
  } else {
    const cell = 10;
    for (let gx = 0; gx < w; gx += cell) {
      for (let gy = 0; gy < h; gy += cell) {
        ctx.fillStyle = (gx + gy) % 20 === 0 ? '#bfbfbf' : '#808080';
        ctx.fillRect(gx, gy, cell, cell);
      }
    }
    const img = testImage('test-signal.svg');
    if (img) {
      const s = Math.min(w, h);
      ctx.drawImage(img, (w - s) / 2, (h - s) / 2, s, s);
    }
  }
  ctx.restore();
}
