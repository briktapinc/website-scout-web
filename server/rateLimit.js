'use strict';

/** Simple in-memory sliding window rate limiter (per-process). */
function rateLimit({ windowMs = 15 * 60 * 1000, max = 30, keyFn } = {}) {
  const hits = new Map();

  function prune(now) {
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (!kept.length) hits.delete(k);
      else hits.set(k, kept);
    }
  }

  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5000) prune(now);
    const key = (keyFn ? keyFn(req) : null)
      || req.ip
      || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || 'unknown';
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (arr.length > max) {
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED' });
    }
    next();
  };
}

module.exports = { rateLimit };
