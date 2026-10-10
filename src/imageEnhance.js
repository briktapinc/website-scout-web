'use strict';

/**
 * Optional AI image enhancement for researched site photos (fal.ai).
 * Uses settings fal.api_key or process.env.FAL_KEY. Failures are soft —
 * research continues with original URLs.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DEFAULT_MODEL = 'fal-ai/nano-banana-pro/edit';
const MAX_IMAGES = 4;

function getFalKey(db) {
  if (process.env.FAL_KEY && String(process.env.FAL_KEY).trim()) {
    return String(process.env.FAL_KEY).trim();
  }
  if (!db) return '';
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('fal.api_key');
    return row && row.value && row.value !== '***' ? String(row.value).trim() : '';
  } catch {
    return '';
  }
}

function falConfigured(db) {
  return !!getFalKey(db);
}

function outDirFor(db) {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'enhanced-images');
  } catch {
    const base = process.env.WS_DB_PATH
      ? path.dirname(process.env.WS_DB_PATH)
      : path.join(process.env.APPDATA || process.cwd(), 'website-scout');
    return path.join(base, 'enhanced-images');
  }
}

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 45000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        resolve(fetchBuffer(res.headers.location, redirects + 1));
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function falRun(key, modelId, input) {
  const res = await fetch(`https://fal.run/${modelId}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.detail || data.error || data.message)) || text.slice(0, 200);
    throw new Error(`fal ${res.status}: ${msg}`);
  }
  return data;
}

function pickResultUrl(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.image && data.image.url) return data.image.url;
  if (Array.isArray(data.images) && data.images[0] && data.images[0].url) return data.images[0].url;
  if (data.output && data.output.url) return data.output.url;
  if (typeof data.url === 'string') return data.url;
  return null;
}

/**
 * Enhance up to MAX_IMAGES remote URLs. Returns
 * [{ source, enhanced_url, local_path?, model, error? }]
 */
async function enhanceImages(db, urls, { leadId = null, limit = MAX_IMAGES } = {}) {
  const key = getFalKey(db);
  const list = (urls || []).filter((u) => /^https?:\/\//i.test(String(u))).slice(0, Math.max(0, limit));
  if (!key || !list.length) {
    return list.map((source) => ({ source, enhanced_url: null, skipped: true, reason: key ? 'empty' : 'no_fal_key' }));
  }

  const dir = path.join(outDirFor(db), leadId != null ? `lead-${leadId}` : 'misc');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];

  for (let i = 0; i < list.length; i++) {
    const source = list[i];
    try {
      const data = await falRun(key, DEFAULT_MODEL, {
        image_urls: [source],
        num_images: 1,
        aspect_ratio: 'auto',
        output_format: 'jpeg',
        resolution: '1K',
        prompt: 'Enhance for a professional local business website: sharper detail, balanced lighting, natural colors, remove compression noise. Keep the same subject and framing — do not change branding text in the image.',
      });
      const enhancedUrl = pickResultUrl(data);
      if (!enhancedUrl) throw new Error('no image url in fal response');

      let local_path = null;
      try {
        const buf = await fetchBuffer(enhancedUrl);
        const ext = /\.jpe?g/i.test(enhancedUrl) ? '.jpg' : '.png';
        local_path = path.join(dir, `img_${i + 1}_v1${ext}`);
        fs.writeFileSync(local_path, buf);
      } catch { /* keep remote url */ }

      out.push({
        source,
        enhanced_url: enhancedUrl,
        local_path,
        model: DEFAULT_MODEL,
      });
    } catch (err) {
      out.push({
        source,
        enhanced_url: null,
        error: String(err && err.message || err).slice(0, 300),
        model: DEFAULT_MODEL,
      });
    }
  }
  return out;
}

module.exports = {
  DEFAULT_MODEL,
  MAX_IMAGES,
  falConfigured,
  getFalKey,
  enhanceImages,
};
