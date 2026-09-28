/*
 * MapMap Web - reading / writing MapMap project files (.mmp).
 * Port of src/core/ProjectReader.cpp, ProjectWriter.cpp and Serializable.cpp.
 * Files written here can be opened by the desktop MapMap and vice versa
 * (media files must then be re-linked since browsers cannot access file paths).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Project, Mapping, DEFAULT_OUTPUT_WIDTH, DEFAULT_OUTPUT_HEIGHT } from '../model/project.js';
import { ColorPaint, ImagePaint, VideoPaint, CameraPaint } from '../model/paints.js';
import { createShape, Mesh } from '../model/shapes.js';

export const WEB_VERSION = '0.7.0-web';
const SUPPORTED_FILE_VERSIONS = /\d+\.\d+\.\d+/;

const num = (v, def = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
};
const bool = (v, def = false) => (v === null || v === undefined || v === '' ? def : String(v).trim().toLowerCase() === 'true' || v === '1');

function childText(el, name) {
  for (const c of el.children) if (c.tagName === name) return c.textContent;
  return null;
}

function child(el, name) {
  for (const c of el.children) if (c.tagName === name) return c;
  return null;
}

export class ProjectFormatError extends Error {}

/**
 * Parses a .mmp XML string.
 * Returns { project, media: [{ paint, uri }] } where media lists the texture paints whose
 * media still has to be located and loaded.
 */
export function parseMmp(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new ProjectFormatError('parse');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'project') throw new ProjectFormatError('not-a-project');
  const version = root.getAttribute('version') || '';
  if (!SUPPORTED_FILE_VERSIONS.test(version)) throw new ProjectFormatError('version');

  const project = new Project();
  project.outputWidth = num(root.getAttribute('outputWidth'), DEFAULT_OUTPUT_WIDTH) || DEFAULT_OUTPUT_WIDTH;
  project.outputHeight = num(root.getAttribute('outputHeight'), DEFAULT_OUTPUT_HEIGHT) || DEFAULT_OUTPUT_HEIGHT;

  const media = [];
  const paintsEl = child(root, 'paints');
  if (paintsEl) {
    for (const el of paintsEl.children) {
      const paint = parsePaint(el);
      if (!paint) continue;
      project.paints.push(paint);
      if (paint.isTexture()) media.push({ paint, uri: paint.uri });
    }
  }

  const mappingsEl = child(root, 'mappings');
  if (mappingsEl) {
    for (const el of mappingsEl.children) {
      const m = parseMapping(el, project);
      if (m) project.mappings.push(m);
    }
  }
  project.reserveIds();
  return { project, media };
}

function readElement(el, target) {
  target.name = el.getAttribute('name') || '';
  target.locked = bool(el.getAttribute('locked'));
  const op = childText(el, 'opacity');
  if (op !== null) target.opacity = Math.min(1, Math.max(0, num(op, 1)));
}

function parsePaint(el) {
  const className = el.getAttribute('className');
  const id = parseInt(el.getAttribute('id'), 10);
  if (!Number.isFinite(id)) return null;
  let paint;
  if (className === 'Color') {
    paint = new ColorPaint(id, ColorPaint.parseColor(childText(el, 'color')));
  } else if (className === 'Image') {
    paint = new ImagePaint(id);
    paint.uri = childText(el, 'uri') || '';
    paint.rate = num(childText(el, 'rate'), 1);
  } else if (className === 'Video') {
    const uri = childText(el, 'uri') || '';
    const web = child(el, 'web');
    if (uri.startsWith('camera:') || (web && web.getAttribute('kind') === 'camera')) {
      paint = new CameraPaint(id);
      if (web) {
        paint.deviceId = web.getAttribute('deviceId') || '';
        paint.facingMode = web.getAttribute('facingMode') || '';
      }
    } else {
      paint = new VideoPaint(id);
      paint.rate = num(childText(el, 'rate'), 1);
      paint.volume = num(childText(el, 'volume'), 1);
    }
    paint.uri = uri;
  } else {
    console.warn('Unknown paint class', className);
    return null;
  }
  readElement(el, paint);
  if (paint.isTexture()) {
    paint.x = num(childText(el, 'x'), 0);
    paint.y = num(childText(el, 'y'), 0);
    const web = child(el, 'web');
    if (web) {
      // Size of the media when it was saved, so shapes keep their meaning until it is re-linked.
      paint.naturalWidth = num(web.getAttribute('width'), 0);
      paint.naturalHeight = num(web.getAttribute('height'), 0);
    }
  }
  return paint;
}

function parseShape(el) {
  if (!el) return null;
  const shape = createShape(el.getAttribute('className'));
  if (!shape) return null;
  const vertices = [];
  const verticesEl = child(el, 'vertices');
  if (verticesEl) {
    for (const v of verticesEl.children) vertices.push({ x: num(v.getAttribute('x')), y: num(v.getAttribute('y')) });
  }
  if (shape instanceof Mesh) {
    const nColumns = Math.max(2, parseInt(childText(el, 'nColumns'), 10) || 2);
    const nRows = Math.max(2, parseInt(childText(el, 'nRows'), 10) || 2);
    if (vertices.length !== nColumns * nRows) return null;
    shape.init(vertices, nColumns, nRows);
  } else {
    if (vertices.length < 3) return null;
    shape.setVertices(vertices);
    shape.build();
  }
  const locked = childText(el, 'locked');
  shape.locked = bool(locked ?? el.getAttribute('locked'));
  return shape;
}

function parseMapping(el, project) {
  const id = parseInt(el.getAttribute('id'), 10);
  const paint = project.getPaintById(parseInt(el.getAttribute('paintId'), 10));
  if (!Number.isFinite(id) || !paint) return null;
  const shape = parseShape(child(el, 'destination'));
  if (!shape) return null;
  let inputShape = null;
  if (paint.isTexture()) {
    inputShape = parseShape(child(el, 'source'));
    if (!inputShape) inputShape = shape.clone();
  }
  const m = new Mapping(id, paint, shape, inputShape);
  readElement(el, m);
  m.solo = bool(el.getAttribute('solo'));
  m.visible = bool(el.getAttribute('visible'), true);
  m.depth = parseInt(el.getAttribute('depth'), 10);
  if (!Number.isFinite(m.depth)) m.depth = id;
  m.setLocked(m.locked);
  return m;
}

/* ---------------------------------------------------------------- writing */

const fmt = (n) => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '0');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Serializes the project to .mmp XML.
 * options.uriFor(paint) may return the uri written for texture paints (defaults to paint.uri).
 */
export function writeMmp(project, options = {}) {
  const uriFor = options.uriFor || ((p) => p.uri);
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE mapmap>');
  lines.push(`<project version="${WEB_VERSION}" outputWidth="${project.outputWidth}" outputHeight="${project.outputHeight}">`);
  lines.push('  <paints>');
  for (const p of project.paints) {
    lines.push(`    <paint className="${p.className}" id="${p.id}" name="${esc(p.name)}" locked="${p.locked}">`);
    lines.push(`      <opacity>${fmt(p.opacity)}</opacity>`);
    if (p.kind === 'color') {
      lines.push(`      <color>${p.qtString}</color>`);
    } else {
      lines.push(`      <uri>${esc(uriFor(p))}</uri>`);
      if (p.kind === 'video') {
        lines.push(`      <volume>${fmt(p.volume)}</volume>`);
        lines.push(`      <rate>${fmt(p.rate)}</rate>`);
      } else if (p.kind === 'camera') {
        lines.push('      <volume>0</volume>');
        lines.push('      <rate>1</rate>');
      } else {
        lines.push(`      <rate>${fmt(p.rate)}</rate>`);
      }
      lines.push(`      <x>${fmt(p.x)}</x>`);
      lines.push(`      <y>${fmt(p.y)}</y>`);
      const extra = p.kind === 'camera'
        ? ` kind="camera" deviceId="${esc(p.deviceId)}" facingMode="${esc(p.facingMode)}"`
        : ` kind="${p.kind}"`;
      lines.push(`      <web${extra} width="${p.width}" height="${p.height}"/>`);
    }
    lines.push('    </paint>');
  }
  lines.push('  </paints>');
  lines.push('  <mappings>');
  for (const m of project.mappings) {
    lines.push(`    <mapping className="${m.className}" id="${m.id}" name="${esc(m.name)}" locked="${m.locked}" solo="${m.solo}" visible="${m.visible}" depth="${m.depth}" paintId="${m.paint.id}">`);
    lines.push(`      <opacity>${fmt(m.opacity)}</opacity>`);
    writeShape(lines, 'destination', m.shape);
    if (m.hasInputShape()) writeShape(lines, 'source', m.inputShape);
    lines.push('    </mapping>');
  }
  lines.push('  </mappings>');
  lines.push('</project>');
  return lines.join('\n') + '\n';
}

function writeShape(lines, tag, shape) {
  lines.push(`      <${tag} className="${shape.className}">`);
  lines.push(`        <locked>${shape.locked}</locked>`);
  if (shape instanceof Mesh) {
    lines.push(`        <nColumns>${shape.nColumns}</nColumns>`);
    lines.push(`        <nRows>${shape.nRows}</nRows>`);
  }
  lines.push('        <vertices>');
  for (const v of shape.vertices) lines.push(`          <vertex x="${fmt(v.x)}" y="${fmt(v.y)}"/>`);
  lines.push('        </vertices>');
  lines.push(`      </${tag}>`);
}
