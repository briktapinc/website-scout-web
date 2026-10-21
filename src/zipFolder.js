'use strict';

/**
 * Build an in-memory ZIP (DEFLATE) of a directory tree. No third-party deps.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function walkFiles(rootDir) {
  const out = [];
  function walk(abs, rel) {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent || !ent.name || ent.name === '.' || ent.name === '..') continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(childAbs, childRel.replace(/\\/g, '/'));
      } else if (ent.isFile()) {
        out.push({ abs: childAbs, rel: childRel.replace(/\\/g, '/') });
      }
    }
  }
  walk(path.resolve(rootDir), '');
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/**
 * @param {string} dirPath absolute directory to zip
 * @param {{ rootName?: string }} [opts] optional top-level folder name inside the zip
 * @returns {{ buffer: Buffer, files: string[], bytes: number }}
 */
function zipFolder(dirPath, opts = {}) {
  const root = path.resolve(dirPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    const e = new Error('Export folder not found');
    e.code = 'EXPORT_MISSING';
    throw e;
  }
  const files = walkFiles(root);
  if (!files.length) {
    const e = new Error('Export folder is empty');
    e.code = 'EXPORT_EMPTY';
    throw e;
  }

  const rootName = String(opts.rootName || '').replace(/[\\/]+/g, '').replace(/^\.+/, '');
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const relNames = [];

  for (const file of files) {
    const data = fs.readFileSync(file.abs);
    const name = rootName ? `${rootName}/${file.rel}` : file.rel;
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const useStore = compressed.length >= data.length;
    const payload = useStore ? data : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);
    const localSize = localHeader.length + payload.length;
    localParts.push(localHeader, payload);

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    centralParts.push(central);
    offset += localSize;
    relNames.push(name);
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);

  const buffer = Buffer.concat([...localParts, centralDir, end]);
  return { buffer, files: relNames, bytes: buffer.length };
}

module.exports = { zipFolder, walkFiles };
