'use strict';

/**
 * Focal-point crop helpers for website images.
 * aspect: "16:9" | "1:1" | "4:3" | number (width/height)
 * focalX / focalY: 0..1 (default 0.5)
 * Optional width/height: output pixel box (defaults derived from source).
 */

const sharp = require('sharp');

function parseAspect(aspect) {
  if (aspect == null || aspect === '') return null;
  if (typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0) return aspect;
  const s = String(aspect).trim();
  const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/i.exec(s);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) return w / h;
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

function clamp01(v, fallback = 0.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * Crop buffer to aspect around focal point; optionally resize to width×height.
 * Returns { buffer, width, height, aspect, focalX, focalY, ext }.
 */
async function cropBuffer(input, opts = {}) {
  const aspect = parseAspect(opts.aspect);
  if (!aspect) {
    const e = new Error('crop.aspect is required (e.g. "16:9" or 1.777)');
    e.code = 'INVALID_CROP';
    throw e;
  }
  const focalX = clamp01(opts.focalX != null ? opts.focalX : opts.focal_x, 0.5);
  const focalY = clamp01(opts.focalY != null ? opts.focalY : opts.focal_y, 0.5);
  const img = sharp(input, { failOn: 'none' });
  const meta = await img.metadata();
  const srcW = meta.width || 0;
  const srcH = meta.height || 0;
  if (!srcW || !srcH) {
    const e = new Error('Could not read image dimensions for crop');
    e.code = 'INVALID_IMAGE';
    throw e;
  }

  let extractW;
  let extractH;
  if (srcW / srcH > aspect) {
    extractH = srcH;
    extractW = Math.round(srcH * aspect);
  } else {
    extractW = srcW;
    extractH = Math.round(srcW / aspect);
  }
  extractW = Math.max(1, Math.min(srcW, extractW));
  extractH = Math.max(1, Math.min(srcH, extractH));

  const maxLeft = Math.max(0, srcW - extractW);
  const maxTop = Math.max(0, srcH - extractH);
  const left = Math.round(maxLeft * focalX);
  const top = Math.round(maxTop * focalY);

  let outW = opts.width != null ? Math.round(Number(opts.width)) : extractW;
  let outH = opts.height != null ? Math.round(Number(opts.height)) : extractH;
  if (!Number.isFinite(outW) || outW < 1) outW = extractW;
  if (!Number.isFinite(outH) || outH < 1) outH = Math.round(outW / aspect);
  // Prefer exact CROP box: if only one dimension given, derive the other from aspect.
  if (opts.width != null && opts.height == null) outH = Math.round(outW / aspect);
  if (opts.height != null && opts.width == null) outW = Math.round(outH * aspect);
  outW = Math.max(1, Math.min(8192, outW));
  outH = Math.max(1, Math.min(8192, outH));

  const format = String(opts.format || meta.format || 'jpeg').toLowerCase();
  let pipeline = sharp(input, { failOn: 'none' })
    .extract({ left, top, width: extractW, height: extractH })
    .resize(outW, outH, { fit: 'fill' });

  let buffer;
  let ext = '.jpg';
  if (format === 'png' || opts.preferPng) {
    buffer = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    ext = '.png';
  } else if (format === 'webp' || opts.preferWebp) {
    buffer = await pipeline.webp({ quality: opts.quality != null ? Number(opts.quality) : 82 }).toBuffer();
    ext = '.webp';
  } else {
    buffer = await pipeline.jpeg({ quality: opts.quality != null ? Number(opts.quality) : 85, mozjpeg: true }).toBuffer();
    ext = '.jpg';
  }

  return {
    buffer,
    width: outW,
    height: outH,
    aspect,
    aspectLabel: typeof opts.aspect === 'string' ? String(opts.aspect).trim() : String(aspect),
    focalX,
    focalY,
    ext,
  };
}

function cropMetaFromResult(result, opts = {}) {
  return {
    aspect: (opts && opts.aspect) != null ? opts.aspect : result.aspectLabel,
    focalX: result.focalX,
    focalY: result.focalY,
    width: result.width,
    height: result.height,
  };
}

module.exports = {
  parseAspect,
  clamp01,
  cropBuffer,
  cropMetaFromResult,
};
