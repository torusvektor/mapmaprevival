/*
 * MapMap Web - WebGL renderer (one instance per canvas).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { colorShapeTriangles, textureMappingTriangles, geometryKey } from './tessellate.js';

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec2 u_size;
varying vec2 v_uv;
void main() {
  vec2 s = a_pos * u_scale + u_offset;
  vec2 c = s / u_size * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_tex;
uniform vec4 u_color;
uniform bool u_useTex;
varying vec2 v_uv;
void main() {
  if (u_useTex) {
    // Like GL_CLAMP_TO_BORDER in the desktop version: nothing outside the texture.
    if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) discard;
    gl_FragColor = texture2D(u_tex, v_uv) * u_color;
  } else {
    gl_FragColor = u_color;
  }
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader error: ' + log);
  }
  return sh;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.frame = 0;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this._init(); });
    this._init();
  }

  get ok() { return !!this.gl && !this.lost; }

  _init() {
    const opts = { alpha: false, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    const gl = this.canvas.getContext('webgl2', opts) || this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
    this.gl = gl;
    this.lost = false;
    this.textures = new Map(); // paint -> { tex, version, lastUsed }
    this.geometry = new Map(); // mapping id -> { key, buffer, count }
    if (!gl) return;
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = {
      pos: gl.getAttribLocation(prog, 'a_pos'),
      uv: gl.getAttribLocation(prog, 'a_uv'),
      scale: gl.getUniformLocation(prog, 'u_scale'),
      offset: gl.getUniformLocation(prog, 'u_offset'),
      size: gl.getUniformLocation(prog, 'u_size'),
      color: gl.getUniformLocation(prog, 'u_color'),
      useTex: gl.getUniformLocation(prog, 'u_useTex'),
      tex: gl.getUniformLocation(prog, 'u_tex'),
    };
    this.tmpBuffer = gl.createBuffer();
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** Resizes the drawing buffer. Returns true if size changed. */
  resize(cssWidth, cssHeight, dpr) {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      return true;
    }
    return false;
  }

  /**
   * Starts a frame. The view maps scene coordinates to CSS pixels as
   * screen = scene * scale + offset.
   */
  begin(view, cssWidth, cssHeight, background = [0, 0, 0, 1]) {
    const gl = this.gl;
    if (!this.ok) return false;
    this.frame++;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(...background);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(this.loc.scale, view.scaleX, view.scaleY);
    gl.uniform2f(this.loc.offset, view.offsetX, view.offsetY);
    gl.uniform2f(this.loc.size, cssWidth, cssHeight);
    gl.uniform1i(this.loc.tex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    return true;
  }

  end() {
    // Garbage collect textures/geometry not used for a while.
    if (this.frame % 240 !== 0) return;
    const gl = this.gl;
    for (const [paint, t] of this.textures) {
      if (this.frame - t.lastUsed > 600) {
        gl.deleteTexture(t.tex);
        this.textures.delete(paint);
      }
    }
    for (const [id, g] of this.geometry) {
      if (this.frame - g.lastUsed > 600) {
        gl.deleteBuffer(g.buffer);
        this.geometry.delete(id);
      }
    }
  }

  /** Returns a texture up to date with the paint pixels (or null if not ready). */
  textureFor(paint) {
    const gl = this.gl;
    const source = paint.getTextureSource();
    if (!source) return null;
    let t = this.textures.get(paint);
    if (!t) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      t = { tex, version: -1, source: null, lastUsed: this.frame };
      this.textures.set(paint, t);
    }
    t.lastUsed = this.frame;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (t.version !== paint.version || t.source !== source) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        const isStatic = paint.kind === 'image';
        if (this.isWebGL2 && isStatic) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } else {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
        t.version = paint.version;
        t.source = source;
      } catch (err) {
        if (!t.warned) console.warn('Texture upload failed', err);
        t.warned = true;
        return t.version >= 0 ? t.tex : null;
      }
    }
    return t.tex;
  }

  _drawArray(data, count, color, tex, buffer) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer || this.tmpBuffer);
    if (!buffer) gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.loc.uv);
    gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 16, 8);
    gl.uniform4f(this.loc.color, color[0], color[1], color[2], color[3]);
    gl.uniform1i(this.loc.useTex, tex ? 1 : 0);
    if (tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    gl.drawArrays(gl.TRIANGLES, 0, count);
  }

  /** Draws one mapping in output space. */
  drawMapping(mapping) {
    const paint = mapping.paint;
    if (!paint || !mapping.shape) return;
    const opacity = mapping.getComputedOpacity();
    if (opacity <= 0) return;
    let tex = null;
    let rect = null;
    if (paint.isTexture()) {
      if (!mapping.inputShape) return;
      tex = this.textureFor(paint);
      if (!tex) return;
      rect = paint.getRect();
    }
    const key = geometryKey(mapping, rect);
    let g = this.geometry.get(mapping.id);
    if (!g || g.key !== key) {
      const data = paint.isTexture()
        ? textureMappingTriangles(mapping.shape, mapping.inputShape, rect)
        : colorShapeTriangles(mapping.shape);
      const gl = this.gl;
      if (!g) g = { buffer: gl.createBuffer() };
      gl.bindBuffer(gl.ARRAY_BUFFER, g.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      g.key = key;
      g.count = data.length / 4;
      this.geometry.set(mapping.id, g);
    }
    g.lastUsed = this.frame;
    if (!g.count) return;
    if (paint.isTexture()) {
      this._drawArray(null, g.count, [1, 1, 1, opacity], tex, g.buffer);
    } else {
      const c = paint.color;
      this._drawArray(null, g.count, [c.r / 255, c.g / 255, c.b / 255, (c.a / 255) * opacity], null, g.buffer);
    }
  }

  /** Draws all visible mappings (bottom layer first). */
  drawMappings(mappings) {
    for (let i = mappings.length - 1; i >= 0; i--) this.drawMapping(mappings[i]);
  }

  /** Draws a texture paint at its position in input space. */
  drawTexturePaint(paint, opacity = paint.opacity) {
    const tex = this.textureFor(paint);
    if (!tex) return;
    const r = paint.getRect();
    const x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
    const data = new Float32Array([
      x0, y0, 0, 0, x1, y0, 1, 0, x1, y1, 1, 1,
      x0, y0, 0, 0, x1, y1, 1, 1, x0, y1, 0, 1,
    ]);
    this._drawArray(data, 6, [1, 1, 1, opacity], tex);
  }

  /** Fills a rectangle (scene coordinates) with a solid color. */
  fillRect(x, y, w, h, color) {
    const data = new Float32Array([
      x, y, 0, 0, x + w, y, 0, 0, x + w, y + h, 0, 0,
      x, y, 0, 0, x + w, y + h, 0, 0, x, y + h, 0, 0,
    ]);
    this._drawArray(data, 6, color, null);
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    for (const t of this.textures.values()) gl.deleteTexture(t.tex);
    for (const g of this.geometry.values()) gl.deleteBuffer(g.buffer);
    this.textures.clear();
    this.geometry.clear();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
