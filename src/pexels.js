'use strict';

// Pexels photo search + local storage. The API key is read by callers from
// settings and is never logged. Image bytes are downloaded into app export
// storage (EXPORT_ROOT / design-*/images or site-*/images) — never left as
// hotlinks to images.pexels.com in published HTML.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const HOST = 'api.pexels.com';
const REMOTE_IMAGE_HOST_RE = /^https:\/\/(?:images\.pexels\.com|images\.unsplash\.com)\//i;

function cleanQuery(q) {
  return String(q || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function clampCount(n, fallback = 5) {
  const x = Number(n);
  if (!Number.isInteger(x)) return fallback;
  return Math.min(6, Math.max(1, x));
}

function buildSearchRequest(apiKey, query, count) {
  const q = cleanQuery(query);
  if (!q) {
    const e = new Error('Pexels search query is empty.');
    e.code = 'PEXELS_QUERY';
    throw e;
  }
  const key = String(apiKey || '').trim();
  if (!key) {
    const e = new Error('Pexels API key is not set. Add it in Settings.');
    e.code = 'PEXELS_NOT_CONFIGURED';
    throw e;
  }
  const perPage = clampCount(count);
  return {
    host: HOST,
    path: `/v1/search?query=${encodeURIComponent(q)}&per_page=${perPage}`,
    method: 'GET',
    headers: { Authorization: key, Accept: 'application/json' },
    query: q,
    perPage,
  };
}

function normalizePhoto(photo, alt) {
  if (!photo || typeof photo !== 'object') return null;
  const src = photo.src && typeof photo.src === 'object' ? photo.src : {};
  const url = src.large || src.medium || '';
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  const photographer = String(photo.photographer || '').trim();
  const photographerUrl = typeof photo.photographer_url === 'string' && photo.photographer_url.startsWith('https://')
    ? photo.photographer_url : '';
  const pexelsUrl = typeof photo.url === 'string' && photo.url.startsWith('https://') ? photo.url : '';
  if (!photographer || !pexelsUrl) return null;
  return {
    url,
    photographer: photographer.slice(0, 120),
    photographer_url: photographerUrl,
    pexels_url: pexelsUrl,
    alt: cleanQuery(alt).slice(0, 140) || 'Photo',
  };
}

function httpsGet(reqOptions) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: reqOptions.host,
        path: reqOptions.path,
        method: 'GET',
        timeout: 20000,
        headers: reqOptions.headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ statusCode: res.statusCode, json });
        });
      }
    );
    req.on('timeout', () => {
      const e = new Error('Pexels request timed out.');
      e.code = 'PEXELS_TIMEOUT';
      req.destroy(e);
    });
    req.on('error', () => {
      const e = new Error('Pexels request failed.');
      e.code = 'PEXELS_NETWORK';
      reject(e);
    });
    req.end();
  });
}

async function searchPhotos(apiKey, query, count, transport) {
  const req = buildSearchRequest(apiKey, query, count);
  const get = transport || httpsGet;
  const res = await get(req);
  if (!res || res.statusCode !== 200 || !res.json || !Array.isArray(res.json.photos)) {
    const e = new Error(`Pexels search failed (HTTP ${res && res.statusCode ? res.statusCode : 'unknown'}).`);
    e.code = 'PEXELS_HTTP';
    throw e;
  }
  const out = [];
  for (const photo of res.json.photos) {
    const normalized = normalizePhoto(photo, req.query);
    if (normalized) out.push(normalized);
    if (out.length >= req.perPage) break;
  }
  return out;
}

function isRemoteStockImageUrl(url) {
  return REMOTE_IMAGE_HOST_RE.test(String(url || '').trim());
}

function extFromUrlOrType(url, contentType) {
  const pathPart = String(url || '').split('?')[0];
  const m = pathPart.match(/\.(jpe?g|png|webp|gif)(?:$)/i);
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return 'jpg';
}

function downloadBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const raw = String(url || '').trim();
    if (!/^https:\/\//i.test(raw)) {
      const e = new Error('Only https image URLs can be stored locally.');
      e.code = 'PEXELS_BAD_URL';
      return reject(e);
    }
    const lib = raw.startsWith('https') ? https : http;
    const req = lib.get(raw, {
      timeout: 45000,
      headers: {
        'User-Agent': 'BitPypeWebsiteScout/1.0',
        Accept: 'image/*,*/*',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, raw).href;
        resolve(downloadBuffer(next, redirects + 1));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        const e = new Error(`Image download failed (HTTP ${res.statusCode || 'unknown'}).`);
        e.code = 'PEXELS_DOWNLOAD';
        reject(e);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!buf.length) {
          const e = new Error('Image download returned empty body.');
          e.code = 'PEXELS_DOWNLOAD';
          return reject(e);
        }
        resolve({ buffer: buf, contentType: res.headers['content-type'] || '' });
      });
    });
    req.on('error', () => {
      const e = new Error('Image download failed.');
      e.code = 'PEXELS_NETWORK';
      reject(e);
    });
    req.on('timeout', () => {
      req.destroy();
      const e = new Error('Image download timed out.');
      e.code = 'PEXELS_TIMEOUT';
      reject(e);
    });
  });
}

function safeImageName(prefix, url, contentType) {
  const ext = extFromUrlOrType(url, contentType);
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 10);
  const base = String(prefix || 'pexels').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'pexels';
  return `${base}-${hash}.${ext}`;
}

/**
 * Download a remote stock photo into imgDir (app export storage).
 * Returns { name, path, url: 'images/<name>', remoteUrl }.
 */
async function storeRemoteImage(url, imgDir, opts = {}) {
  const remoteUrl = String(url || '').trim();
  if (!isRemoteStockImageUrl(remoteUrl)) {
    const e = new Error('Not a supported stock image URL.');
    e.code = 'PEXELS_BAD_URL';
    throw e;
  }
  fs.mkdirSync(imgDir, { recursive: true });
  // Prefer exports.downloadBuffer so tests can stub without network.
  const fetchFn = (module.exports && module.exports.downloadBuffer) || downloadBuffer;
  let { buffer, contentType } = await fetchFn(remoteUrl);
  let name = safeImageName(opts.prefix || 'pexels', remoteUrl, contentType);
  try {
    const imageOptimize = require('./imageOptimize');
    const opt = await imageOptimize.optimizeBuffer(buffer, {
      fileName: name,
      role: 'photo',
      preferWebp: true,
    });
    if (!opt.skipped && opt.buffer && opt.buffer.length) {
      buffer = opt.buffer;
      if (opt.ext) {
        const base = name.replace(/\.[^.]+$/, '');
        name = `${base}${opt.ext}`;
        contentType = opt.mime || contentType;
      }
    }
  } catch (e) {
    console.warn('[pexels] optimize skip:', e.message || e);
  }
  const dest = path.join(imgDir, name);
  if (!(fs.existsSync(dest) && fs.statSync(dest).isFile())) {
    fs.writeFileSync(dest, buffer);
  }
  return {
    name,
    path: dest,
    url: `images/${name}`,
    remoteUrl,
  };
}

/**
 * Download search results into imgDir; rewrite each photo.url to images/….
 * Keeps photographer credit fields; adds path + source for export copy.
 */
async function localizePhotos(photos, imgDir, opts = {}) {
  const list = Array.isArray(photos) ? photos : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const photo = list[i];
    if (!photo || !photo.url) continue;
    if (!/^https:\/\//i.test(photo.url)) {
      out.push(photo);
      continue;
    }
    try {
      const stored = await storeRemoteImage(photo.url, imgDir, {
        prefix: opts.prefix || `pexels-${i + 1}`,
      });
      out.push(Object.assign({}, photo, {
        url: stored.url,
        path: stored.path,
        name: stored.name,
        source: 'pexels',
        remote_url: stored.remoteUrl,
      }));
    } catch (e) {
      // Skip failed downloads rather than leaving a hotlink.
      console.warn('[pexels] localize skip:', e.message || e);
    }
  }
  return out;
}

/**
 * Find remote Pexels/Unsplash src= URLs in freeform page HTML / section JSON,
 * download into imgDir, rewrite to images/<file>. Returns { pages, assets }.
 */
async function localizeUrlsInPages(pages, imgDir, opts = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const assets = [];
  const cache = new Map(); // remote -> local url

  async function mapUrl(remote) {
    const key = String(remote || '').trim();
    if (!key) return key;
    if (!isRemoteStockImageUrl(key) && !/^https:\/\/images\.pexels\.com\//i.test(key)) return key;
    if (cache.has(key)) return cache.get(key);
    const stored = await storeRemoteImage(key, imgDir, { prefix: opts.prefix || 'pexels' });
    cache.set(key, stored.url);
    assets.push({
      name: stored.name,
      path: stored.path,
      url: stored.url,
      source: 'pexels',
      remote_url: stored.remoteUrl,
      alt: 'Photo',
      photographer: 'Pexels',
    });
    return stored.url;
  }

  async function rewriteText(text) {
    let s = String(text || '');
    const re = /\b(src|href)=(["'])(https:\/\/(?:images\.pexels\.com|images\.unsplash\.com)\/[^"']+)\2/gi;
    const matches = [...s.matchAll(re)];
    for (const m of matches) {
      const remote = m[3];
      try {
        const local = await mapUrl(remote);
        if (local && local !== remote) {
          s = s.split(remote).join(local);
        }
      } catch (e) {
        console.warn('[pexels] page url localize skip:', e.message || e);
      }
    }
    // CSS url(...)
    const cssRe = /url\(\s*(["']?)(https:\/\/(?:images\.pexels\.com|images\.unsplash\.com)\/[^"')]+)\1\s*\)/gi;
    const cssMatches = [...s.matchAll(cssRe)];
    for (const m of cssMatches) {
      const remote = m[2];
      try {
        const local = await mapUrl(remote);
        if (local && local !== remote) s = s.split(remote).join(local);
      } catch (e) {
        console.warn('[pexels] css url localize skip:', e.message || e);
      }
    }
    return s;
  }

  const next = [];
  for (const page of list) {
    if (!page || typeof page !== 'object') { next.push(page); continue; }
    const copy = Object.assign({}, page);
    if (typeof copy.html === 'string' && copy.html.trim()) {
      copy.html = await rewriteText(copy.html);
    }
    if (Array.isArray(copy.sections)) {
      copy.sections = await Promise.all(copy.sections.map(async (sec) => {
        if (!sec || typeof sec !== 'object') return sec;
        const sc = Object.assign({}, sec);
        if (sc.content && typeof sc.content === 'object') {
          const content = Object.assign({}, sc.content);
          if (content.image && typeof content.image === 'object' && content.image.url) {
            const u = await mapUrl(content.image.url);
            content.image = Object.assign({}, content.image, { url: u });
          }
          if (typeof content.backgroundImage === 'string') {
            content.backgroundImage = await mapUrl(content.backgroundImage);
          }
          if (typeof content.background_image === 'string') {
            content.background_image = await mapUrl(content.background_image);
          }
          if (content.background && typeof content.background === 'object') {
            const bg = Object.assign({}, content.background);
            if (typeof bg.url === 'string') bg.url = await mapUrl(bg.url);
            if (typeof bg.src === 'string') bg.src = await mapUrl(bg.src);
            content.background = bg;
          }
          if (Array.isArray(content.images)) {
            content.images = await Promise.all(content.images.map(async (im) => {
              if (!im || typeof im !== 'object' || !im.url) return im;
              const u = await mapUrl(im.url);
              return Object.assign({}, im, { url: u });
            }));
          }
          sc.content = content;
        }
        return sc;
      }));
    }
    next.push(copy);
  }
  return { pages: next, assets };
}

module.exports = {
  HOST,
  buildSearchRequest,
  normalizePhoto,
  searchPhotos,
  cleanQuery,
  clampCount,
  isRemoteStockImageUrl,
  downloadBuffer,
  storeRemoteImage,
  localizePhotos,
  localizeUrlsInPages,
};
