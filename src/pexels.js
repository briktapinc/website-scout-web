'use strict';

// Pexels photo search. The API key is read by callers from settings and is
// never logged, never put in an error message, and never written next to the
// photos we store on a site.

const https = require('node:https');

const HOST = 'api.pexels.com';

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

module.exports = {
  HOST,
  buildSearchRequest,
  normalizePhoto,
  searchPhotos,
  cleanQuery,
  clampCount,
};
