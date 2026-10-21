'use strict';

/**
 * Simple in-memory sliding window rate limiter (per-process).
 *
 * Durability note: this repo does not wire Redis (or another shared store) for
 * rate limits. Counters live in the process heap only — they reset on deploy/
 * restart and are not shared across multiple Node workers/instances. Prefer a
 * durable store (Redis/MySQL) before scaling horizontally if tight global caps
 * matter. OAuth DCR/auth-code durability is handled separately in mcpOAuth.js.
 */

let _loggedStoreMode = false;

function rateLimit({ windowMs = 15 * 60 * 1000, max = 30, keyFn, name = 'default' } = {}) {
  const hits = new Map();

  if (!_loggedStoreMode) {
    _loggedStoreMode = true;
    const hint = process.env.RATE_LIMIT_REDIS_URL
      ? 'RATE_LIMIT_REDIS_URL is set but unused — still in-memory per-process'
      : 'no Redis configured — in-memory per-process only';
    try {
      console.info(`[rateLimit] ${hint}`);
    } catch { /* ignore */ }
  }

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
    // Prefer Express req.ip (respects trust proxy). Do not trust leftmost XFF alone.
    const key = (keyFn ? keyFn(req) : null)
      || req.ip
      || 'unknown';
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (arr.length > max) {
      try {
        console.warn(
          `[rateLimit] 429 name=${name} key=${String(key).slice(0, 80)} count=${arr.length} max=${max} windowMs=${windowMs}`
        );
      } catch { /* ignore */ }
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED' });
    }
    next();
  };
}

module.exports = { rateLimit };
