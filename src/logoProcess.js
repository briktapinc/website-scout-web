'use strict';

/**
 * Logo image pipeline: cover-fit into a consistent header box and emit PNG
 * with transparency. Near-white / near-black solid plates are stripped to alpha
 * when the source looks opaque (common for AI-generated marks).
 */

const sharp = require('sharp');

const LOGO_WIDTH = 640;
const LOGO_HEIGHT = 160;
const NEAR_WHITE = 248;
const NEAR_BLACK = 12;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * @param {Buffer} inputBuffer
 * @param {{ width?: number, height?: number, stripBackground?: boolean }} [opts]
 * @returns {Promise<{ buffer: Buffer, mime: string, width: number, height: number, filename: string }>}
 */
async function processLogoBuffer(inputBuffer, opts = {}) {
  if (!Buffer.isBuffer(inputBuffer) || !inputBuffer.length) {
    throw fail('INVALID_IMAGE', 'Logo image data is empty.');
  }
  const width = Math.min(1280, Math.max(64, Number(opts.width) || LOGO_WIDTH));
  const height = Math.min(640, Math.max(32, Number(opts.height) || LOGO_HEIGHT));
  const stripBackground = opts.stripBackground !== false;

  let pipeline;
  try {
    pipeline = sharp(inputBuffer, { failOn: 'none' }).rotate();
  } catch {
    throw fail('INVALID_IMAGE', 'Could not read logo image.');
  }

  let meta;
  try {
    meta = await pipeline.metadata();
  } catch {
    throw fail('INVALID_IMAGE', 'Could not read logo image metadata.');
  }
  if (!meta || !meta.width || !meta.height) {
    throw fail('INVALID_IMAGE', 'Logo image has no dimensions.');
  }

  // Cover-crop into the target box so every site header gets a consistent size.
  const { data, info } = await sharp(inputBuffer, { failOn: 'none' })
    .rotate()
    .ensureAlpha()
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (stripBackground) {
    let opaqueCount = 0;
    let whiteish = 0;
    let blackish = 0;
    const total = info.width * info.height;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a > 200) opaqueCount += 1;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE) whiteish += 1;
      if (r <= NEAR_BLACK && g <= NEAR_BLACK && b <= NEAR_BLACK) blackish += 1;
    }
    const mostlyOpaque = opaqueCount / total > 0.92;
    const plateIsWhite = whiteish / total > 0.18;
    const plateIsBlack = blackish / total > 0.18;
    if (mostlyOpaque && (plateIsWhite || plateIsBlack)) {
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (plateIsWhite && r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE) {
          data[i + 3] = 0;
        } else if (plateIsBlack && r <= NEAR_BLACK && g <= NEAR_BLACK && b <= NEAR_BLACK) {
          data[i + 3] = 0;
        }
      }
    }
  }

  // Trim empty alpha, then contain back into the same header box with transparent pad.
  let png;
  try {
    png = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .trim({ threshold: 8 })
      .resize(width, height, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } catch {
    png = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  return {
    buffer: png,
    mime: 'image/png',
    width,
    height,
    filename: 'logo.png',
  };
}

/**
 * Patch freeform / section pages so image logos show in headers.
 * - Updates existing data-ws-logo / class*=logo images
 * - Replaces .brand / .logo / [data-ws-brand] link text with an <img>
 * - Leaves pages untouched when mode is text (caller clears theme.logoUrl)
 */
function patchLogoInHtmlFragment(html, imgTag) {
  let out = String(html || '');
  let touched = false;
  out = out.replace(
    /<img\b([^>]*\b(?:data-ws-logo|class=["'][^"']*\b(?:brand-logo|logo)\b[^"']*["'])[^>]*)>/gi,
    () => {
      touched = true;
      return imgTag;
    }
  );
  out = out.replace(
    /<(a|div|span)\b([^>]*\b(?:class=["'][^"']*\b(?:brand|logo|site-logo|navbar-brand)\b[^"']*["']|data-ws-brand)[^>]*)>([\s\S]*?)<\/\1>/gi,
    (m, tag, attrs) => {
      touched = true;
      return `<${tag}${attrs}>${imgTag}</${tag}>`;
    }
  );
  return { html: out, touched };
}

function applyLogoMarkupToPages(pages, logoUrl, brandName) {
  const list = Array.isArray(pages) ? pages : [];
  if (!logoUrl) return list;
  const alt = String(brandName || 'Logo').replace(/"/g, '&quot;');
  const imgTag = `<img data-ws-logo="1" class="brand-logo" src="${logoUrl}" alt="${alt}" />`;

  return list.map((page) => {
    if (!page || typeof page !== 'object') return page;
    const next = Object.assign({}, page);

    if (Array.isArray(next.sections)) {
      next.sections = next.sections.map((sec) => {
        if (!sec || !sec.content || typeof sec.content !== 'object') return sec;
        let content = Object.assign({}, sec.content);
        if (sec.type === 'nav') content.logo_url = logoUrl;
        // Freestyle nav/header chrome stores the brand mark inside content.html.
        if (typeof content.html === 'string' && content.html.trim()
          && (sec.type === 'nav' || sec.type === 'html' || /brand|logo|header/i.test(content.html.slice(0, 800)))) {
          const patched = patchLogoInHtmlFragment(content.html, imgTag);
          if (patched.touched) content = Object.assign({}, content, { html: patched.html });
        }
        return Object.assign({}, sec, { content });
      });
    }

    if (typeof next.html === 'string' && next.html.trim()) {
      const patched = patchLogoInHtmlFragment(next.html, imgTag);
      if (patched.touched) next.html = patched.html;
    }

    return next;
  });
}

function clearLogoMarkupFromPages(pages) {
  const list = Array.isArray(pages) ? pages : [];
  return list.map((page) => {
    if (!page || typeof page !== 'object') return page;
    const next = Object.assign({}, page);
    if (Array.isArray(next.sections)) {
      next.sections = next.sections.map((sec) => {
        if (!sec || !sec.content || typeof sec.content !== 'object') return sec;
        if (sec.content.logo_url == null) return sec;
        const content = Object.assign({}, sec.content);
        delete content.logo_url;
        return Object.assign({}, sec, { content });
      });
    }
    return next;
  });
}

module.exports = {
  processLogoBuffer,
  applyLogoMarkupToPages,
  clearLogoMarkupFromPages,
  LOGO_WIDTH,
  LOGO_HEIGHT,
};
