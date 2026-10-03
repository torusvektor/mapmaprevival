/*
 * MapMap Web - minimal ZIP reader/writer used for project bundles (.mmpz).
 * Writing uses the "store" method (media files are already compressed);
 * reading supports "store" and "deflate" (through DecompressionStream).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function crc32OfBlob(blob) {
  const CHUNK = 8 * 1024 * 1024;
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    const buf = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
    crc = crc32Update(crc, buf);
  }
  return crc;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;

/**
 * Error thrown for archives that are damaged ('corrupt'), not ZIP files ('not-a-zip'),
 * use features this reader does not support ('encrypted', 'zip64', 'method'), or
 * that do not fit in a classic ZIP file when writing ('too-large').
 */
export class ZipError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ZipError';
    this.code = code;
  }
}

/**
 * Creates a ZIP Blob from entries [{ name, data: Blob|string|Uint8Array }].
 * Classic ZIP only (no ZIP64): throws ZipError('too-large') past 4 GB or 65535 entries.
 */
export async function createZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime();
  if (entries.length > MAX_U16) throw new ZipError('too-large');

  for (const entry of entries) {
    const blob = entry.data instanceof Blob ? entry.data : new Blob([entry.data]);
    const nameBytes = enc.encode(entry.name);
    const size = blob.size;
    if (size >= MAX_U32 || offset >= MAX_U32 || nameBytes.length > MAX_U16) throw new ZipError('too-large');
    const crc = await crc32OfBlob(blob);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // store
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, nameBytes, blob);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, day, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const cdSize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  if (offset >= MAX_U32 || offset + cdSize >= MAX_U32) throw new ZipError('too-large');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/**
 * Reads a ZIP Blob. Returns a Map name -> { name, size, blob(): Promise<Blob>, text() }.
 * The structure is checked when reading; every blob() is checked against the size and
 * CRC-32 recorded in the archive and rejects with a ZipError if it does not match.
 */
export async function readZip(blob) {
  const tailSize = Math.min(blob.size, 65535 + 22);
  const tailStart = blob.size - tailSize;
  const tail = new DataView(await blob.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    // The comment must fit in the file (rules out the signature bytes inside the comment).
    if (tail.getUint32(i, true) === 0x06054b50 && i + 22 + tail.getUint16(i + 20, true) <= tail.byteLength) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not-a-zip');
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) throw new ZipError('zip64');
  const disk = tail.getUint16(eocd + 4, true);
  const cdDisk = tail.getUint16(eocd + 6, true);
  const diskCount = tail.getUint16(eocd + 8, true);
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (count === MAX_U16 || cdSize === MAX_U32 || cdOffset === MAX_U32) throw new ZipError('zip64');
  if (disk !== 0 || cdDisk !== 0 || diskCount !== count) throw new ZipError('corrupt');
  // The central directory sits between the local entries and the end record.
  const eocdPos = tailStart + eocd;
  if (cdOffset + cdSize > eocdPos) throw new ZipError('corrupt');
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) throw new ZipError('corrupt');
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    const compSize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen + commentLen > cd.byteLength) throw new ZipError('corrupt');
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x0041) throw new ZipError('encrypted'); // bit 0: encrypted, bit 6: strong encryption
    if (compSize === MAX_U32 || size === MAX_U32 || localOffset === MAX_U32) throw new ZipError('zip64');
    if (localOffset + 30 + compSize > cdOffset) throw new ZipError('corrupt');
    if (method === 0 && compSize !== size) throw new ZipError('corrupt');
    if (name.endsWith('/')) continue;
    if (entries.has(name)) throw new ZipError('corrupt');
    entries.set(name, {
      name,
      size,
      async blob() {
        const lh = new DataView(await blob.slice(localOffset, localOffset + 30).arrayBuffer());
        if (lh.byteLength < 30 || lh.getUint32(0, true) !== 0x04034b50) throw new ZipError('corrupt');
        if (lh.getUint16(6, true) & 0x0041) throw new ZipError('encrypted');
        if (lh.getUint16(8, true) !== method) throw new ZipError('corrupt');
        const start = localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        if (start + compSize > cdOffset) throw new ZipError('corrupt');
        const raw = blob.slice(start, start + compSize);
        let data;
        if (method === 0) {
          data = raw;
        } else if (method === 8 && typeof DecompressionStream !== 'undefined') {
          try {
            data = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
          } catch {
            throw new ZipError('corrupt');
          }
        } else {
          throw new ZipError('method');
        }
        if (data.size !== size || await crc32OfBlob(data) !== crc) throw new ZipError('corrupt');
        return data;
      },
      async text() { return (await this.blob()).text(); },
    });
  }
  return entries;
}
