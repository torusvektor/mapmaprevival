/*
 * MapMap Web - paints (sources).
 * Port of src/core/Paint.{h,cpp} using browser media elements.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/** Frames per second used for animated images without timing info (MM::DEFAULT_FRAMES_PER_SECOND). */
export const DEFAULT_FRAMES_PER_SECOND = 29.97;

/** Largest texture side uploaded to the GPU (bigger images are downscaled). */
export const MAX_TEXTURE_SIZE = 4096;

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'gif', 'png', 'tiff', 'tif', 'bmp', 'webp', 'avif', 'heic', 'heif', 'svg'];
export const VIDEO_EXTENSIONS = ['mov', 'mp4', 'm4v', 'avi', 'ogg', 'ogv', 'mpeg', 'mpg', 'webm', 'mkv', 'wmv', '3gp'];

export function fileExtension(name = '') {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function baseName(path = '') {
  return String(path).split(/[\\/]/).pop();
}

export function isImageFile(file) {
  return (file.type && file.type.startsWith('image/')) || IMAGE_EXTENSIONS.includes(fileExtension(file.name));
}

export function isVideoFile(file) {
  return (file.type && file.type.startsWith('video/')) || VIDEO_EXTENSIONS.includes(fileExtension(file.name));
}

/** Hidden DOM container for media elements (some mobile browsers only decode attached videos). */
function mediaPool() {
  let pool = document.getElementById('media-pool');
  if (!pool) {
    pool = document.createElement('div');
    pool.id = 'media-pool';
    pool.setAttribute('aria-hidden', 'true');
    pool.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(pool);
  }
  return pool;
}

function once(target, events, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      for (const ev of events.ok) target.removeEventListener(ev, onOk);
      for (const ev of events.fail || []) target.removeEventListener(ev, onFail);
    };
    const onOk = () => { cleanup(); resolve(); };
    const onFail = () => { cleanup(); reject(new Error('media-error')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('media-timeout')); }, timeout);
    for (const ev of events.ok) target.addEventListener(ev, onOk);
    for (const ev of events.fail || []) target.addEventListener(ev, onFail);
  });
}

export class Paint {
  constructor(id) {
    this.id = id;
    this.name = '';
    this.opacity = 1;
    this.locked = false;
    this.playing = false;
  }

  get kind() { return 'paint'; }
  get className() { return 'Paint'; }
  isTexture() { return false; }

  play() { this.playing = true; }
  pause() { this.playing = false; }
  rewind() {}
  /** Called every frame. */
  update() {}
  /** Called when the paint leaves the project (e.g. stops camera). */
  deactivate() {}
  /** Called when the paint (re)enters the project. */
  activate() {}
  dispose() { this.deactivate(); }

  toJSON() {
    return { kind: this.kind, id: this.id, name: this.name, opacity: this.opacity, locked: this.locked };
  }

  applyJSON(json) {
    if (json.name !== undefined) this.name = json.name;
    if (json.opacity !== undefined) this.opacity = json.opacity;
    if (json.locked !== undefined) this.locked = json.locked;
  }
}

export class ColorPaint extends Paint {
  constructor(id, color = { r: 0, g: 255, b: 0, a: 255 }) {
    super(id);
    this.color = { ...color };
  }
  get kind() { return 'color'; }
  get className() { return 'Color'; }

  get hex() {
    const h = (n) => Math.round(n).toString(16).padStart(2, '0');
    return `#${h(this.color.r)}${h(this.color.g)}${h(this.color.b)}`;
  }

  /** Color string as written by Qt (#RRGGBB, or #AARRGGBB when not opaque). */
  get qtString() {
    const h = (n) => Math.round(n).toString(16).padStart(2, '0');
    return this.color.a < 255 ? `#${h(this.color.a)}${this.hex.slice(1)}` : this.hex;
  }

  get css() {
    const { r, g, b, a } = this.color;
    return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
  }

  static parseColor(str) {
    str = String(str || '').trim();
    let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(str);
    if (m) return { a: parseInt(m[1], 16), r: parseInt(m[2], 16), g: parseInt(m[3], 16), b: parseInt(m[4], 16) };
    m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(str);
    if (m) return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 255 };
    m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(str);
    if (m) return { r: parseInt(m[1] + m[1], 16), g: parseInt(m[2] + m[2], 16), b: parseInt(m[3] + m[3], 16), a: 255 };
    return { r: 0, g: 255, b: 0, a: 255 };
  }

  setHex(hex) {
    const c = ColorPaint.parseColor(hex);
    this.color = { ...c, a: this.color.a };
  }

  toJSON() { return { ...super.toJSON(), color: { ...this.color } }; }
  applyJSON(json) {
    super.applyJSON(json);
    if (json.color) this.color = { ...json.color };
  }
}

/** Base class for paints drawn from pixels (images, videos, cameras). */
export class TexturePaint extends Paint {
  constructor(id) {
    super(id);
    this.x = 0;
    this.y = 0;
    this.uri = '';
    this.rate = 1;
    this.version = 0; // increments whenever pixels change
    this.status = 'empty'; // 'empty' | 'loading' | 'ready' | 'missing' | 'error'
    this.naturalWidth = 0;
    this.naturalHeight = 0;
  }
  isTexture() { return true; }

  get width() { return this.naturalWidth; }
  get height() { return this.naturalHeight; }
  get ready() { return this.status === 'ready' && this.width > 0 && this.height > 0; }

  getRect() { return { x: this.x, y: this.y, width: this.width || 640, height: this.height || 480 }; }

  /** Returns the object to upload to WebGL (image, bitmap, canvas or video) or null. */
  getTextureSource() { return null; }

  /** Small image used as icon in the library list. */
  getThumbnailSource() { return this.getTextureSource(); }

  toJSON() {
    return { ...super.toJSON(), x: this.x, y: this.y, uri: this.uri, rate: this.rate, width: this.naturalWidth, height: this.naturalHeight };
  }

  applyJSON(json) {
    super.applyJSON(json);
    for (const k of ['x', 'y', 'uri', 'rate']) if (json[k] !== undefined) this[k] = json[k];
    // Keeps the original size while the media is missing or still loading, so layers
    // keep their place; loaded media always reports its own size.
    if (this.status !== 'ready') {
      const valid = (n) => Number.isFinite(n) && n > 0;
      if (valid(json.width) && valid(json.height)) {
        this.naturalWidth = json.width;
        this.naturalHeight = json.height;
      }
    }
  }
}

export class ImagePaint extends TexturePaint {
  constructor(id) {
    super(id);
    this.blob = null;
    this.url = null;
    this.frames = []; // [{ source, duration(ms) }]
    this.currentFrame = 0;
    this._frameTime = 0;
    this._lastTick = 0;
  }
  get kind() { return 'image'; }
  get className() { return 'Image'; }

  isAnimation() { return this.frames.length > 1; }

  /** Loads the image from a Blob/File. */
  async load(blob, uri) {
    this.status = 'loading';
    this.blob = blob;
    if (uri) this.uri = uri;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    try {
      const oldFrames = this.frames;
      const frames = await decodeAnimatedImage(blob);
      if (frames && frames.length > 1) {
        this.frames = frames.frames;
        this.naturalWidth = frames.width;
        this.naturalHeight = frames.height;
      } else {
        const img = new Image();
        img.decoding = 'async';
        img.src = this.url;
        await (img.decode ? img.decode() : once(img, { ok: ['load'], fail: ['error'] }));
        this.naturalWidth = img.naturalWidth || img.width;
        this.naturalHeight = img.naturalHeight || img.height;
        this.frames = [{ source: downscaleIfNeeded(img, this.naturalWidth, this.naturalHeight), duration: 0 }];
      }
      closeFrames(oldFrames);
      this.currentFrame = 0;
      this.status = 'ready';
      this.version++;
    } catch (err) {
      console.warn('Cannot load image', uri, err);
      this.status = 'error';
      throw err;
    }
  }

  getTextureSource() { return this.frames[this.currentFrame]?.source || null; }

  play() { super.play(); this._lastTick = performance.now(); }

  rewind() {
    this.currentFrame = 0;
    this._frameTime = 0;
    this._lastTick = performance.now();
    this.version++;
  }

  update(now = performance.now()) {
    if (!this.isAnimation() || !this.playing) { this._lastTick = now; return; }
    const dt = Math.max(0, now - this._lastTick) * Math.max(0, this.rate);
    this._lastTick = now;
    this._frameTime += dt;
    let changed = false;
    let guard = 0;
    for (;;) {
      const d = this.frames[this.currentFrame].duration || 1000 / DEFAULT_FRAMES_PER_SECOND;
      if (this._frameTime < d || guard++ > this.frames.length) break;
      this._frameTime -= d;
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      changed = true;
    }
    if (changed) this.version++;
  }

  dispose() {
    super.dispose();
    closeFrames(this.frames);
    this.frames = [];
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

/** Frees the decoded animation frames (ImageBitmaps) that are no longer displayed. */
function closeFrames(frames) {
  for (const f of frames) if (f.source && f.source.close) f.source.close();
}

/** Downscales very large images so they fit into a GPU texture. */
function downscaleIfNeeded(source, w, h) {
  const maxSide = Math.max(w, h);
  if (maxSide <= MAX_TEXTURE_SIZE) return source;
  const s = MAX_TEXTURE_SIZE / maxSide;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * s));
  canvas.height = Math.max(1, Math.round(h * s));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Decodes animated GIF / WebP / APNG frames with the WebCodecs ImageDecoder when available. */
async function decodeAnimatedImage(blob) {
  const type = blob.type || '';
  if (typeof window.ImageDecoder === 'undefined') return null;
  if (!/gif|webp|png|apng/.test(type)) return null;
  try {
    if (!(await window.ImageDecoder.isTypeSupported(type))) return null;
    const decoder = new window.ImageDecoder({ data: await blob.arrayBuffer(), type });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount <= 1) { decoder.close(); return null; }
    const frameCount = Math.min(track.frameCount, 600);
    const frames = [];
    let width = 0, height = 0;
    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      width = image.displayWidth;
      height = image.displayHeight;
      const s = Math.min(1, MAX_TEXTURE_SIZE / Math.max(width, height));
      const bitmap = await createImageBitmap(image, s < 1 ? { resizeWidth: Math.round(width * s), resizeHeight: Math.round(height * s) } : {});
      frames.push({ source: bitmap, duration: (image.duration || 0) / 1000 });
      image.close();
    }
    decoder.close();
    return { frames, width, height, length: frames.length };
  } catch (err) {
    console.warn('ImageDecoder failed, falling back to static image', err);
    return null;
  }
}

export class VideoPaint extends TexturePaint {
  constructor(id) {
    super(id);
    this.volume = 1;
    this.blob = null;
    this.url = null;
    this.video = null;
    this.autoMuted = false;
    this._frameCallback = null;
    this._ownsUrl = false; // true when this.url is a Blob URL created by load()
  }
  get kind() { return 'video'; }
  get className() { return 'Video'; }

  get width() { return this.video?.videoWidth || this.naturalWidth; }
  get height() { return this.video?.videoHeight || this.naturalHeight; }

  _createVideo() {
    if (this.video) this._destroyVideo();
    const v = document.createElement('video');
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.loop = true;
    v.preload = 'auto';
    v.muted = true;
    v.crossOrigin = 'anonymous';
    v.style.cssText = 'width:2px;height:2px';
    mediaPool().appendChild(v);
    const bump = () => { this.version++; };
    v.addEventListener('seeked', bump);
    v.addEventListener('loadeddata', bump);
    v.addEventListener('resize', () => {
      this.naturalWidth = v.videoWidth;
      this.naturalHeight = v.videoHeight;
      bump();
    });
    this.video = v;
    this._watchFrames();
    return v;
  }

  _watchFrames() {
    const v = this.video;
    if (!v || !('requestVideoFrameCallback' in v)) return;
    const cb = () => {
      if (this.video !== v) return;
      this.version++;
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
    this._hasFrameCallback = true;
  }

  _destroyVideo() {
    const v = this.video;
    if (!v) return;
    this.video = null;
    try { v.pause(); } catch { /* ignore */ }
    if (v.srcObject) v.srcObject = null;
    v.removeAttribute('src');
    try { v.load(); } catch { /* ignore */ }
    v.remove();
  }

  async load(blob, uri) {
    this.status = 'loading';
    this.blob = blob;
    if (uri) this.uri = uri;
    this._releaseUrl();
    this.url = URL.createObjectURL(blob);
    this._ownsUrl = true;
    await this._loadUrl(this.url);
  }

  async loadUrl(url, uri) {
    this.status = 'loading';
    if (uri) this.uri = uri;
    this._releaseUrl();
    this.url = url;
    await this._loadUrl(url);
  }

  _releaseUrl() {
    if (this.url && this._ownsUrl) URL.revokeObjectURL(this.url);
    this.url = null;
    this._ownsUrl = false;
  }

  async _loadUrl(url) {
    const v = this._createVideo();
    v.src = url;
    try {
      v.load();
      if (v.readyState < 2) await once(v, { ok: ['loadeddata'], fail: ['error'] }, 30000);
      this.naturalWidth = v.videoWidth;
      this.naturalHeight = v.videoHeight;
      this.status = 'ready';
      this._applySettings();
      this.version++;
      if (this.playing) this._doPlay();
    } catch (err) {
      console.warn('Cannot load video', this.uri, err);
      this.status = 'error';
      throw err;
    }
  }

  _applySettings() {
    const v = this.video;
    if (!v) return;
    try { v.playbackRate = Math.min(16, Math.max(0.0625, this.rate || 1)); } catch { /* unsupported rate */ }
    v.volume = Math.min(1, Math.max(0, this.volume));
    if (!this.autoMuted) v.muted = this.volume <= 0;
  }

  setRate(rate) { this.rate = rate; this._applySettings(); }
  setVolume(volume) { this.volume = volume; this._applySettings(); }

  getTextureSource() {
    const v = this.video;
    return v && v.readyState >= 2 ? v : null;
  }

  play() { super.play(); this._doPlay(); }
  pause() { super.pause(); if (this.video) this.video.pause(); }

  _doPlay() {
    const v = this.video;
    if (!v || this.status !== 'ready') return;
    this._applySettings();
    const p = v.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err && err.name === 'NotAllowedError' && !v.muted) {
          // Autoplay with sound refused: play muted until the next user gesture.
          this.autoMuted = true;
          v.muted = true;
          v.play().catch(() => {});
        }
      });
    }
  }

  /** Called after a user gesture: restores sound after an autoplay restriction. */
  unlockAudio() {
    if (!this.autoMuted || !this.video) return;
    this.autoMuted = false;
    this._applySettings();
    if (this.playing) this.video.play().catch(() => {});
  }

  rewind() {
    if (this.video) {
      try { this.video.currentTime = 0; } catch { /* ignore */ }
    }
    this.version++;
  }

  update() {
    // Without requestVideoFrameCallback, assume a new frame each tick while playing.
    if (!this._hasFrameCallback && this.video && !this.video.paused) this.version++;
  }

  activate() {
    if (!this.video && this.url) this._loadUrl(this.url).catch(() => {});
  }

  deactivate() {
    if (this.video) this.video.pause();
  }

  dispose() {
    this._destroyVideo();
    this._releaseUrl();
  }

  toJSON() { return { ...super.toJSON(), volume: this.volume }; }
  applyJSON(json) {
    super.applyJSON(json);
    if (json.volume !== undefined) this.volume = json.volume;
    this._applySettings();
  }
}

/** Live camera (getUserMedia). Saved in .mmp files as a Video paint with a "camera:" uri. */
export class CameraPaint extends VideoPaint {
  constructor(id) {
    super(id);
    this.deviceId = '';
    this.facingMode = '';
    this.stream = null;
    this.volume = 0;
  }
  get kind() { return 'camera'; }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  static async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  async open({ deviceId, facingMode, label } = {}) {
    this.status = 'loading';
    if (deviceId !== undefined) this.deviceId = deviceId;
    if (facingMode !== undefined) this.facingMode = facingMode;
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    const attempts = [];
    if (this.deviceId) attempts.push({ ...base, deviceId: { exact: this.deviceId } });
    if (this.facingMode) attempts.push({ ...base, facingMode: this.facingMode });
    attempts.push(base);
    let stream = null;
    let lastErr = null;
    for (const video of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        break;
      } catch (err) {
        lastErr = err;
        if (err && err.name === 'NotAllowedError') break;
      }
    }
    if (!stream) {
      this.status = 'error';
      throw lastErr || new Error('camera-error');
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings ? track.getSettings() : {};
    if (settings.deviceId) this.deviceId = settings.deviceId;
    this.uri = 'camera:' + (label || track?.label || this.deviceId || 'default');
    const v = this._createVideo();
    v.srcObject = stream;
    v.muted = true;
    if (v.readyState < 2) await once(v, { ok: ['loadeddata'], fail: ['error'] }, 15000);
    this.naturalWidth = v.videoWidth;
    this.naturalHeight = v.videoHeight;
    this.status = 'ready';
    this.version++;
    v.play().catch(() => {});
  }

  _applySettings() {
    if (this.video) this.video.muted = true;
  }

  play() { this.playing = true; if (this.video) this.video.play().catch(() => {}); }
  // A live camera keeps running when paused, like the desktop version.
  pause() { this.playing = false; }
  rewind() {}

  activate() {
    if (!this.stream && this.status !== 'loading') this.open().catch((e) => console.warn('camera', e));
  }

  deactivate() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this._destroyVideo();
    this.status = 'empty';
  }

  dispose() { this.deactivate(); }

  toJSON() { return { ...super.toJSON(), deviceId: this.deviceId, facingMode: this.facingMode }; }
  applyJSON(json) {
    super.applyJSON(json);
    if (json.deviceId !== undefined) this.deviceId = json.deviceId;
    if (json.facingMode !== undefined) this.facingMode = json.facingMode;
  }
}

export function createPaint(kind, id) {
  switch (kind) {
    case 'color': return new ColorPaint(id);
    case 'image': return new ImagePaint(id);
    case 'video': return new VideoPaint(id);
    case 'camera': return new CameraPaint(id);
    default: return null;
  }
}
