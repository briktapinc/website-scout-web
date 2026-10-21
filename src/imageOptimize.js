'use strict';

/**
 * Site image optimization for customer/portal exports.
 *
 * Goals: shrink oversized photos, re-encode with sensible quality, prefer WebP
 * for opaque raster photos when smaller — without casually breaking logos or
 * transparency. SVG / ICO / animated GIF are left alone.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const RASTER_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const SKIP_EXT = new Set(['.svg', '.ico', '.bmp', '.avif']);

const DEFAULTS = {
  maxEdge: 2400,
  jpegQuality: 80,
  webpQuality: 80,
  pngCompression: 9,
  minBytesToTouch: 6 * 1024,
  /** Prefer WebP for opaque photos when the result is meaningfully smaller. */
  preferWebp: true,
  /** Minimum relative savings before replacing / converting (0–1). */
  minSavings: 0.04,
  /** Never convert these basenames away from PNG (logos / marks). */
  preserveNames: ['logo.png', 'logo.svg', 'favicon.ico', 'apple-touch-icon.png'],
  force: false,
};

function mergeOpts(opts = {}) {
  return Object.assign({}, DEFAULTS, opts || {});
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function isPreserveName(fileName, opts) {
  const base = String(fileName || '').toLowerCase();
  const list = Array.isArray(opts.preserveNames) ? opts.preserveNames : DEFAULTS.preserveNames;
  return list.some((n) => String(n).toLowerCase() === base);
}

function extForMime(mime) {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  return '.bin';
}

function mimeForExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.png') return 'image/png';
  if (e === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

function replaceSrcDeep(value, from, to) {
  if (typeof value === 'string') {
    if (value === from) return to;
    if (from && value.includes(from)) return value.split(from).join(to);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => replaceSrcDeep(v, from, to));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceSrcDeep(v, from, to);
    return out;
  }
  return value;
}

function rewriteHtmlRefs(html, fromRel, toRel) {
  let out = String(html || '');
  if (!fromRel || !toRel || fromRel === toRel) return out;
  const variants = [fromRel, `./${fromRel}`, `/${fromRel}`];
  for (const v of variants) {
    if (!v) continue;
    out = out.split(v).join(v === fromRel ? toRel : (v.startsWith('./') ? `./${toRel}` : `/${toRel}`));
  }
  return out;
}

/**
 * Optimize a raster image buffer. Returns a new buffer when smaller / resized;
 * otherwise returns the original with skipped:true.
 *
 * @param {Buffer} inputBuffer
 * @param {{
 *   maxEdge?: number,
 *   jpegQuality?: number,
 *   webpQuality?: number,
 *   pngCompression?: number,
 *   minBytesToTouch?: number,
 *   preferWebp?: boolean,
 *   minSavings?: number,
 *   force?: boolean,
 *   fileName?: string,
 *   role?: 'logo'|'photo'|'unknown',
 * }} [opts]
 */
async function optimizeBuffer(inputBuffer, opts = {}) {
  const cfg = mergeOpts(opts);
  if (!Buffer.isBuffer(inputBuffer) || !inputBuffer.length) {
    throw fail('INVALID_IMAGE', 'Image buffer is empty.');
  }

  const bytesBefore = inputBuffer.length;
  const fileName = opts.fileName ? String(opts.fileName) : '';
  const role = String(opts.role || '').toLowerCase();
  const preserve = role === 'logo' || isPreserveName(fileName, cfg);

  if (!cfg.force && bytesBefore < cfg.minBytesToTouch) {
    return {
      buffer: inputBuffer,
      mime: null,
      ext: null,
      width: null,
      height: null,
      bytesBefore,
      bytesAfter: bytesBefore,
      skipped: true,
      reason: 'too_small',
      converted: false,
    };
  }

  let meta;
  try {
    meta = await sharp(inputBuffer, { failOn: 'none', animated: true }).metadata();
  } catch {
    return {
      buffer: inputBuffer,
      mime: null,
      ext: null,
      width: null,
      height: null,
      bytesBefore,
      bytesAfter: bytesBefore,
      skipped: true,
      reason: 'unreadable',
      converted: false,
    };
  }

  const format = String(meta.format || '').toLowerCase();
  if (format === 'svg' || format === 'ico') {
    return {
      buffer: inputBuffer,
      mime: format === 'svg' ? 'image/svg+xml' : 'image/x-icon',
      ext: format === 'svg' ? '.svg' : '.ico',
      width: meta.width || null,
      height: meta.height || null,
      bytesBefore,
      bytesAfter: bytesBefore,
      skipped: true,
      reason: 'vector_or_icon',
      converted: false,
    };
  }
  // Animated GIF / multi-page WebP: leave alone (sharp would flatten).
  if ((format === 'gif' || format === 'webp') && meta.pages && meta.pages > 1) {
    return {
      buffer: inputBuffer,
      mime: mimeForExt(`.${format}`),
      ext: `.${format === 'jpeg' ? 'jpg' : format}`,
      width: meta.width || null,
      height: meta.height || null,
      bytesBefore,
      bytesAfter: bytesBefore,
      skipped: true,
      reason: 'animated',
      converted: false,
    };
  }
  if (format === 'gif') {
    return {
      buffer: inputBuffer,
      mime: 'image/gif',
      ext: '.gif',
      width: meta.width || null,
      height: meta.height || null,
      bytesBefore,
      bytesAfter: bytesBefore,
      skipped: true,
      reason: 'gif',
      converted: false,
    };
  }

  const hasAlpha = !!meta.hasAlpha;
  const w = meta.width || 0;
  const h = meta.height || 0;
  const longEdge = Math.max(w, h);
  const needsResize = longEdge > cfg.maxEdge;

  let pipeline = sharp(inputBuffer, { failOn: 'none' }).rotate();
  if (needsResize) {
    pipeline = pipeline.resize({
      width: w >= h ? cfg.maxEdge : undefined,
      height: h > w ? cfg.maxEdge : undefined,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const candidates = [];

  async function encode(kind) {
    let p = pipeline.clone();
    if (kind === 'jpeg') {
      p = p.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({
        quality: cfg.jpegQuality,
        mozjpeg: true,
      });
    } else if (kind === 'webp') {
      p = p.webp({
        quality: cfg.webpQuality,
        alphaQuality: 90,
        effort: 4,
      });
    } else if (kind === 'png') {
      const pngOpts = {
        compressionLevel: cfg.pngCompression,
        adaptiveFiltering: true,
      };
      if (!hasAlpha && !preserve) pngOpts.palette = true;
      p = p.png(pngOpts);
    } else {
      return null;
    }
    const buf = await p.toBuffer();
    const info = await sharp(buf, { failOn: 'none' }).metadata();
    return {
      buffer: buf,
      mime: kind === 'jpeg' ? 'image/jpeg' : (kind === 'webp' ? 'image/webp' : 'image/png'),
      ext: kind === 'jpeg' ? '.jpg' : (kind === 'webp' ? '.webp' : '.png'),
      width: info.width || w,
      height: info.height || h,
      kind,
    };
  }

  try {
    if (preserve || role === 'logo') {
      // Logos: stay PNG (transparency-safe), compress only.
      const png = await encode('png');
      if (png) candidates.push(png);
    } else if (hasAlpha) {
      const png = await encode('png');
      if (png) candidates.push(png);
      if (cfg.preferWebp) {
        const webp = await encode('webp');
        if (webp) candidates.push(webp);
      }
    } else {
      // Opaque photo: try WebP + same-family re-encode; pick smallest that saves.
      if (cfg.preferWebp) {
        const webp = await encode('webp');
        if (webp) candidates.push(webp);
      }
      if (format === 'png') {
        const jpeg = await encode('jpeg');
        if (jpeg) candidates.push(jpeg);
        const png = await encode('png');
        if (png) candidates.push(png);
      } else if (format === 'webp') {
        const webp = await encode('webp');
        if (webp) candidates.push(webp);
      } else {
        // jpeg / unknown opaque
        const jpeg = await encode('jpeg');
        if (jpeg) candidates.push(jpeg);
      }
    }
  } catch (e) {
    return {
      buffer: inputBuffer,
      mime: mimeForExt(`.${format || 'bin'}`),
      ext: format === 'jpeg' ? '.jpg' : (format ? `.${format}` : null),
      width: w || null,
      height: h || null,
      bytesBefore,
      bytesAfter: bytesBefore,
      skipped: true,
      reason: `encode_failed:${e.message || e}`,
      converted: false,
    };
  }

  if (!candidates.length) {
    return {
      buffer: inputBuffer,
      mime: null,
      ext: null,
      width: w || null,
      height: h || null,
      bytesBefore,
      bytesAfter: bytesBefore,
      skipped: true,
      reason: 'no_candidate',
      converted: false,
    };
  }

  candidates.sort((a, b) => a.buffer.length - b.buffer.length);
  const best = candidates[0];
  const saved = (bytesBefore - best.buffer.length) / bytesBefore;
  const sameFamily =
    (format === 'jpeg' && best.kind === 'jpeg')
    || (format === 'jpg' && best.kind === 'jpeg')
    || (format === 'png' && best.kind === 'png')
    || (format === 'webp' && best.kind === 'webp');

  // Accept if we resized, or force, or meaningful byte savings.
  const accept = cfg.force
    || needsResize
    || saved >= cfg.minSavings
    || (sameFamily && best.buffer.length < bytesBefore);

  if (!accept) {
    return {
      buffer: inputBuffer,
      mime: mimeForExt(`.${format === 'jpeg' ? 'jpg' : format}`),
      ext: format === 'jpeg' ? '.jpg' : (format ? `.${format}` : null),
      width: w || null,
      height: h || null,
      bytesBefore,
      bytesAfter: bytesBefore,
      skipped: true,
      reason: 'no_savings',
      converted: false,
    };
  }

  const inExt = format === 'jpeg' ? '.jpg' : (format ? `.${format}` : null);
  const converted = !!(inExt && best.ext && inExt !== best.ext);

  return {
    buffer: best.buffer,
    mime: best.mime,
    ext: best.ext,
    width: best.width,
    height: best.height,
    bytesBefore,
    bytesAfter: best.buffer.length,
    skipped: false,
    reason: needsResize ? 'resized' : (converted ? 'converted' : 'compressed'),
    converted,
  };
}

/**
 * Optimize a file on disk. May rewrite in place or rename when format changes.
 * @returns {Promise<{
 *   path: string,
 *   from: string,
 *   relFrom?: string,
 *   relTo?: string,
 *   changed: boolean,
 *   renamed: boolean,
 *   bytesBefore: number,
 *   bytesAfter: number,
 *   skipped?: boolean,
 *   reason?: string,
 * }>}
 */
async function optimizeFile(absPath, opts = {}) {
  const cfg = mergeOpts(opts);
  const from = path.resolve(absPath);
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
    throw fail('NOT_FOUND', `Image not found: ${absPath}`);
  }
  const ext = path.extname(from).toLowerCase();
  const base = path.basename(from);
  if (SKIP_EXT.has(ext) || !RASTER_EXT.has(ext)) {
    return {
      path: from,
      from,
      changed: false,
      renamed: false,
      bytesBefore: fs.statSync(from).size,
      bytesAfter: fs.statSync(from).size,
      skipped: true,
      reason: 'unsupported_ext',
    };
  }

  const input = fs.readFileSync(from);
  const role = opts.role
    || (isPreserveName(base, cfg) || /^logo\./i.test(base) ? 'logo' : 'photo');
  const result = await optimizeBuffer(input, Object.assign({}, cfg, {
    fileName: base,
    role,
  }));

  if (result.skipped) {
    return {
      path: from,
      from,
      changed: false,
      renamed: false,
      bytesBefore: result.bytesBefore,
      bytesAfter: result.bytesAfter,
      skipped: true,
      reason: result.reason,
    };
  }

  let dest = from;
  let renamed = false;
  if (result.ext && result.ext !== ext) {
    dest = path.join(path.dirname(from), `${path.basename(from, ext)}${result.ext}`);
    renamed = dest !== from;
  }

  fs.writeFileSync(dest, result.buffer);
  if (renamed && dest !== from && fs.existsSync(from)) {
    try { fs.unlinkSync(from); } catch { /* keep old if unlink fails */ }
  }

  return {
    path: dest,
    from,
    changed: true,
    renamed,
    bytesBefore: result.bytesBefore,
    bytesAfter: result.bytesAfter,
    mime: result.mime,
    ext: result.ext,
    reason: result.reason,
    converted: result.converted,
  };
}

/**
 * Optimize every raster image under imgDir (non-recursive).
 * @returns {Promise<{ dir: string, files: object[], bytesBefore: number, bytesAfter: number, changed: number, renamed: Array<{from:string,to:string}> }>}
 */
async function optimizeDirectory(imgDir, opts = {}) {
  const dir = path.resolve(imgDir);
  const summary = {
    dir,
    files: [],
    bytesBefore: 0,
    bytesAfter: 0,
    changed: 0,
    renamed: [],
  };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return summary;
  }
  const names = fs.readdirSync(dir);
  for (const name of names) {
    const abs = path.join(dir, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (!RASTER_EXT.has(ext)) continue;
    try {
      const out = await optimizeFile(abs, opts);
      summary.bytesBefore += out.bytesBefore || 0;
      summary.bytesAfter += out.bytesAfter || 0;
      summary.files.push({
        name,
        path: out.path,
        changed: !!out.changed,
        renamed: !!out.renamed,
        bytesBefore: out.bytesBefore,
        bytesAfter: out.bytesAfter,
        reason: out.reason || null,
      });
      if (out.changed) summary.changed += 1;
      if (out.renamed) {
        const fromRel = `images/${path.basename(out.from)}`;
        const toRel = `images/${path.basename(out.path)}`;
        summary.renamed.push({ from: fromRel, to: toRel, fromAbs: out.from, toAbs: out.path });
      }
    } catch (e) {
      summary.files.push({
        name,
        path: abs,
        changed: false,
        error: e.message || String(e),
      });
      summary.bytesBefore += st.size;
      summary.bytesAfter += st.size;
    }
  }
  return summary;
}

/**
 * Apply rename map to pages/theme JSON and optional HTML strings on disk.
 */
function applyRenamesToPages(pages, renames) {
  let next = pages;
  for (const r of renames || []) {
    if (!r || !r.from || !r.to || r.from === r.to) continue;
    next = replaceSrcDeep(next, r.from, r.to);
    if (r.from.startsWith('images/')) {
      next = replaceSrcDeep(next, `./${r.from}`, r.to);
      next = replaceSrcDeep(next, `/${r.from}`, r.to);
    }
  }
  return next;
}

function applyRenamesToTheme(theme, renames) {
  let next = theme && typeof theme === 'object' ? Object.assign({}, theme) : {};
  for (const r of renames || []) {
    if (!r || !r.from || !r.to || r.from === r.to) continue;
    next = replaceSrcDeep(next, r.from, r.to);
  }
  return next;
}

function rewriteExportHtmlFiles(exportDir, renames) {
  if (!exportDir || !fs.existsSync(exportDir) || !(renames || []).length) return 0;
  let touched = 0;
  for (const name of fs.readdirSync(exportDir)) {
    if (!/\.html?$/i.test(name)) continue;
    const abs = path.join(exportDir, name);
    if (!fs.statSync(abs).isFile()) continue;
    let html = fs.readFileSync(abs, 'utf8');
    const before = html;
    for (const r of renames) {
      html = rewriteHtmlRefs(html, r.from, r.to);
    }
    if (html !== before) {
      fs.writeFileSync(abs, html, 'utf8');
      touched += 1;
    }
  }
  // Also rewrite styles.css url(...) refs if present.
  const cssPath = path.join(exportDir, 'styles.css');
  if (fs.existsSync(cssPath) && fs.statSync(cssPath).isFile()) {
    let css = fs.readFileSync(cssPath, 'utf8');
    const before = css;
    for (const r of renames) {
      css = rewriteHtmlRefs(css, r.from, r.to);
    }
    if (css !== before) {
      fs.writeFileSync(cssPath, css, 'utf8');
      touched += 1;
    }
  }
  return touched;
}

/**
 * Collect image directories for a website (app storage + publish export folder).
 */
function websiteImageDirs(db, siteId, opts = {}) {
  const openPreview = require('./openPreview');
  const dirs = [];
  const root = openPreview.exportRoot();
  const appDir = path.join(root, `site-${siteId}`, 'images');
  dirs.push(appDir);

  try {
    const site = db.prepare(
      'SELECT id, preview_path, export_slug FROM websites WHERE id = ?'
    ).get(Number(siteId));
    if (site) {
      let folder = null;
      if (site.preview_path) {
        const p = String(site.preview_path).replace(/\\/g, '/');
        const m = p.match(/website-scout-exports\/([^/]+)/i);
        if (m) folder = m[1];
      }
      if (!folder && site.export_slug) {
        const slug = String(site.export_slug).trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
        const ws = opts.workspaceId != null ? Number(opts.workspaceId) : null;
        if (ws && slug) folder = `ws-${ws}-site-${siteId}-${slug}`;
      }
      if (folder) {
        const exportImg = path.join(root, folder, 'images');
        if (exportImg !== appDir) dirs.push(exportImg);
      }
    }
  } catch { /* optional */ }

  // Dedupe
  const seen = new Set();
  return dirs.filter((d) => {
    const key = path.resolve(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Optimize all images for a website. Optionally rewrite pages/theme when files rename.
 *
 * @param {*} db
 * @param {number} siteId
 * @param {{ force?: boolean, preferWebp?: boolean, workspaceId?: number, savePages?: boolean }} [opts]
 */
async function optimizeWebsiteImages(db, siteId, opts = {}) {
  const cfg = mergeOpts(opts);
  const id = Number(siteId);
  if (!Number.isInteger(id) || id < 1) {
    throw fail('INVALID_ID', 'siteId must be a positive integer.');
  }

  const dirs = websiteImageDirs(db, id, opts);
  const allRenames = [];
  const dirResults = [];
  let bytesBefore = 0;
  let bytesAfter = 0;
  let changed = 0;

  for (const dir of dirs) {
    const result = await optimizeDirectory(dir, cfg);
    dirResults.push(result);
    bytesBefore += result.bytesBefore;
    bytesAfter += result.bytesAfter;
    changed += result.changed;
    for (const r of result.renamed) allRenames.push(r);
  }

  let pagesUpdated = false;
  let htmlFilesTouched = 0;
  let pages = null;
  let theme = null;

  if (allRenames.length && opts.savePages !== false) {
    try {
      const engine = require('./websiteEngine');
      const site = engine.getWebsite(db, id);
      pages = typeof site.pages === 'string' ? JSON.parse(site.pages || '[]') : (site.pages || []);
      theme = typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : (site.theme || {});
      pages = applyRenamesToPages(pages, allRenames);
      theme = applyRenamesToTheme(theme, allRenames);
      engine.saveSite(db, id, pages, theme, opts.note || 'Optimize site images');
      pagesUpdated = true;
    } catch (e) {
      console.warn('[imageOptimize] save pages after rename:', e.message || e);
    }
  }

  // Rewrite materialized HTML next to each images/ dir.
  for (const dir of dirs) {
    const exportDir = path.dirname(dir);
    htmlFilesTouched += rewriteExportHtmlFiles(exportDir, allRenames);
  }

  return {
    siteId: id,
    dirs: dirResults.map((d) => ({
      dir: d.dir,
      changed: d.changed,
      files: d.files.length,
      bytesBefore: d.bytesBefore,
      bytesAfter: d.bytesAfter,
      renamed: d.renamed,
    })),
    changed,
    renamed: allRenames,
    bytesBefore,
    bytesAfter,
    savedBytes: Math.max(0, bytesBefore - bytesAfter),
    pagesUpdated,
    htmlFilesTouched,
    force: !!cfg.force,
  };
}

module.exports = {
  optimizeBuffer,
  optimizeFile,
  optimizeDirectory,
  optimizeWebsiteImages,
  websiteImageDirs,
  applyRenamesToPages,
  applyRenamesToTheme,
  rewriteExportHtmlFiles,
  replaceSrcDeep,
  DEFAULTS,
  extForMime,
  mimeForExt,
};
