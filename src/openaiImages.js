'use strict';

/**
 * OpenAI Images API (POST /v1/images/generations) using the same ai.api_key /
 * ai.base_url as chat. Model from ai.model.image (default gpt-image-1).
 *
 * Never returns giant base64 to callers for storage in deliverables — files are
 * written to disk; callers should keep path / relative URL only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_MODEL = 'gpt-image-1';
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_QUALITY = 'low';
const MAX_N = 4;

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function getSetting(db, key, def = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value != null && String(row.value) !== '') return String(row.value);
  } catch { /* ignore */ }
  return def;
}

function apiKey(db) {
  const key = getSetting(db, 'ai.api_key', '');
  return key && key !== '***' ? key.trim() : '';
}

function imageConfigured(db) {
  return !!apiKey(db);
}

function todaySpendUsd(db) {
  try {
    const row = db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage WHERE date(at) = date('now')"
    ).get();
    return Number(row.spent) || 0;
  } catch {
    return 0;
  }
}

function outDirFor(db, jobId) {
  let base;
  try {
    if (process.env.WS_DB_PATH) base = path.dirname(path.resolve(process.env.WS_DB_PATH));
  } catch { /* ignore */ }
  if (!base) {
    try {
      const electron = require('electron');
      if (electron && electron.app && typeof electron.app.getPath === 'function') {
        base = electron.app.getPath('userData');
      }
    } catch { /* MCP / node */ }
  }
  if (!base) {
    base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'website-scout');
  }
  const dir = path.join(base, 'generated-images', jobId != null ? `job-${jobId}` : 'misc');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isGptImageModel(model) {
  return /^gpt-image/i.test(String(model || ''));
}

function normalizeSize(raw, model) {
  const s = String(raw || DEFAULT_SIZE).trim();
  if (isGptImageModel(model)) {
    // gpt-image-* : no 256/512; allow auto + standard trio
    if (/^(auto|1024x1024|1024x1536|1536x1024)$/.test(s)) return s;
    return DEFAULT_SIZE;
  }
  if (/^(1024x1024|1024x1536|1536x1024|1792x1024|1024x1792|512x512|256x256)$/.test(s)) return s;
  return DEFAULT_SIZE;
}

function normalizeQuality(raw, model) {
  const q = String(raw || DEFAULT_QUALITY).trim().toLowerCase();
  if (isGptImageModel(model)) {
    if (/^(auto|low|medium|high)$/.test(q)) return q;
    return DEFAULT_QUALITY;
  }
  if (/^(standard|hd)$/.test(q)) return q;
  return 'standard';
}

/**
 * Generate n images from a text prompt. Writes PNG/JPEG files to disk.
 * @returns {Promise<{ model, prompt, size, quality, images: Array<{ path, mime, revised_prompt? }> }>}
 */
async function generateImages(db, prompt, opts = {}) {
  const key = apiKey(db);
  if (!key) throw fail('AI_NOT_CONFIGURED', 'AI is not configured: set ai.api_key in Settings.');

  if (String(getSetting(db, 'automation_paused', '0')) === '1') {
    throw fail('AUTOMATION_PAUSED', 'Automation is paused; image generation is blocked.');
  }

  const budget = parseFloat(getSetting(db, 'cost.daily_budget_usd', '10'));
  if (budget > 0 && todaySpendUsd(db) >= budget) {
    throw fail('BUDGET_EXCEEDED', 'Daily AI budget exceeded.');
  }

  const text = String(prompt || '').trim();
  if (!text) throw fail('INVALID_ARGS', 'prompt is required.');
  if (text.length > 32000) throw fail('INVALID_ARGS', 'prompt is too long.');

  const n = Math.min(MAX_N, Math.max(1, Number(opts.n) || 1));
  let model = String(opts.model || getSetting(db, 'ai.model.image', '') || DEFAULT_MODEL).trim()
    || DEFAULT_MODEL;
  const size = normalizeSize(opts.size, model);
  const quality = opts.quality != null && String(opts.quality).trim() !== ''
    ? normalizeQuality(opts.quality, model)
    : (isGptImageModel(model) ? DEFAULT_QUALITY : undefined);

  const baseUrl = String(getSetting(db, 'ai.base_url', 'https://api.openai.com/v1') || '')
    .trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw fail('INVALID_BASE_URL', 'ai.base_url must be an http(s) URL.');
  }

  const body = {
    model,
    prompt: text,
    n,
    size,
  };
  if (/^dall-e/i.test(model)) {
    body.response_format = 'b64_json';
  } else if (quality) {
    body.quality = quality;
  }

  let res;
  try {
    res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    throw fail('AI_NETWORK_ERROR', `Image generation failed to reach the provider (${e.message || 'network error'}).`);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    throw fail('AI_BAD_RESPONSE', `Image provider returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const providerMsg = data && data.error && data.error.message
      ? String(data.error.message).slice(0, 240)
      : `HTTP ${res.status}`;
    throw fail('AI_REQUEST_FAILED', `Image generation failed: ${providerMsg}`, { status: res.status });
  }

  const list = Array.isArray(data.data) ? data.data : [];
  if (!list.length) throw fail('AI_EMPTY', 'Image provider returned no images.');

  const dir = outDirFor(db, opts.jobId);
  const stamp = Date.now();
  const images = [];

  for (let i = 0; i < list.length; i++) {
    const row = list[i] || {};
    let buf = null;
    let mime = 'image/png';
    if (row.b64_json) {
      buf = Buffer.from(String(row.b64_json), 'base64');
    } else if (row.url && /^https?:\/\//i.test(row.url)) {
      const imgRes = await fetch(row.url, { signal: AbortSignal.timeout(60000) });
      if (!imgRes.ok) throw fail('AI_DOWNLOAD_FAILED', `Could not download generated image (HTTP ${imgRes.status}).`);
      const ab = await imgRes.arrayBuffer();
      buf = Buffer.from(ab);
      const ct = imgRes.headers.get('content-type') || '';
      if (/jpeg|jpg/i.test(ct)) mime = 'image/jpeg';
      else if (/webp/i.test(ct)) mime = 'image/webp';
    } else {
      continue;
    }
    const ext = mime === 'image/jpeg' ? 'jpg' : (mime === 'image/webp' ? 'webp' : 'png');
    const filePath = path.join(dir, `gen-${stamp}-${i + 1}.${ext}`);
    fs.writeFileSync(filePath, buf);
    images.push({
      path: filePath,
      mime,
      revised_prompt: row.revised_prompt || null,
      // Intentionally omit dataUrl / b64 — keep deliverables and IPC small.
    });
  }

  if (!images.length) throw fail('AI_EMPTY', 'Image provider returned no usable image data.');

  try {
    const usage = data.usage || {};
    const est = usage.output_tokens
      ? Number(usage.output_tokens) * 0.00004
      : 0.02 * images.length;
    db.prepare(
      `INSERT INTO ai_usage (task, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'image',
      model,
      Number(usage.input_tokens) || 0,
      Number(usage.output_tokens) || 0,
      est,
      opts.leadId != null ? Number(opts.leadId) : null,
      `images/generations n=${images.length} size=${size} q=${quality || ''} ${(opts.note || '').slice(0, 160)}`
    );
  } catch { /* logging optional */ }

  return { model, prompt: text, size, quality: quality || null, images };
}

/** Read a generated file as a data URL (UI preview only — do not persist). */
function fileToDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

module.exports = {
  generateImages,
  imageConfigured,
  fileToDataUrl,
  DEFAULT_MODEL,
  DEFAULT_SIZE,
  DEFAULT_QUALITY,
  MAX_N,
  outDirFor,
};
