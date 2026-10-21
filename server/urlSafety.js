'use strict';

/**
 * Shared SSRF guard: public http(s) URLs only, every redirect hop validated,
 * DNS resolved and pinned for the actual connection (reduces DNS rebinding).
 */

const dns = require('dns').promises;
const net = require('net');
// Keep fetch and its dispatcher on the same undici version. A newer Agent is
// not necessarily compatible with the undici embedded in Node's global fetch.
const { Agent, fetch } = require('undici');

const DEFAULT_MAX_REDIRECTS = 5;

/** Unwrap IPv4-mapped IPv6 (::ffff:10.0.0.1 / ::ffff:a00:1). */
function normalizeIp(ip) {
  const v = String(ip || '').toLowerCase().trim();
  const dotted = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return v;
}

function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const v = normalizeIp(ip);
  if (v === '::1' || v === '0:0:0:0:0:0:0:1') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true;
  if (net.isIPv4(v)) {
    const parts = v.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(v)) {
    // Unique-local / link-local already handled; treat unspecified as private.
    if (v === '::' || v.startsWith('::')) return true;
    return false;
  }
  return true;
}

/**
 * Validate a URL is safe to fetch from this host.
 * @returns {{ href: string, hostname: string, connectIp: string, addresses: string[] }}
 */
async function assertPublicUrl(rawUrl, opts = {}) {
  const allowHttpLocal = opts.allowHttpLocal === true
    && String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
  let u;
  try {
    u = new URL(String(rawUrl || ''));
  } catch {
    const err = new Error('Invalid URL');
    err.code = 'URL_INVALID';
    throw err;
  }

  const hostname = (u.hostname || '').toLowerCase();
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowHttpLocal && isLocal)) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      const err = new Error('URL scheme not allowed');
      err.code = 'URL_SCHEME';
      throw err;
    }
    // http to non-local public hosts is allowed for lead-site ingest (many small
    // businesses still lack TLS). Private destinations are still blocked below.
    if (u.protocol === 'http:' && isLocal && !allowHttpLocal) {
      const err = new Error('Localhost URLs are not allowed');
      err.code = 'URL_LOCAL';
      throw err;
    }
  }
  if (u.username || u.password) {
    const err = new Error('URL must not include credentials');
    err.code = 'URL_CREDENTIALS';
    throw err;
  }
  if (!hostname) {
    const err = new Error('URL host missing');
    err.code = 'URL_HOST';
    throw err;
  }

  let addresses = [];
  if (net.isIP(hostname)) {
    addresses = [normalizeIp(hostname)];
  } else if (isLocal) {
    addresses = ['127.0.0.1'];
  } else {
    try {
      const looked = await dns.lookup(hostname, { all: true, verbatim: true });
      addresses = (looked || []).map((a) => normalizeIp(a.address)).filter(Boolean);
    } catch {
      const err = new Error('URL host could not be resolved');
      err.code = 'URL_DNS';
      throw err;
    }
  }
  if (!addresses.length || addresses.some((a) => isPrivateIp(a))) {
    const err = new Error('URL resolves to a private or disallowed address');
    err.code = 'URL_PRIVATE';
    throw err;
  }

  // Prefer IPv4 for broader undici compatibility when both exist.
  const connectIp = addresses.find((a) => net.isIPv4(a)) || addresses[0];
  return {
    href: u.toString(),
    hostname,
    connectIp,
    addresses,
  };
}

function pinnedAgent(connectIp) {
  const family = net.isIPv6(connectIp) ? 6 : 4;
  return new Agent({
    connect: {
      lookup(hostname, options, cb) {
        if (options && options.all) {
          return cb(null, [{ address: connectIp, family }]);
        }
        cb(null, connectIp, family);
      },
    },
  });
}

/**
 * Fetch a public URL with per-hop SSRF checks and DNS pinned to the resolved IP.
 * Does not follow redirects automatically — validates each Location target.
 */
async function fetchPublic(rawUrl, opts = {}) {
  const maxRedirects = Number.isFinite(opts.maxRedirects)
    ? Math.max(0, Math.min(10, Math.floor(opts.maxRedirects))) : DEFAULT_MAX_REDIRECTS;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Math.min(Number(opts.timeoutMs), 60000) : 15000;
  const maxBytes = Number.isSafeInteger(opts.maxBytes) && opts.maxBytes > 0
    ? Math.min(opts.maxBytes, 8 * 1024 * 1024) : 2 * 1024 * 1024;
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error('Public URL request timed out'), { code: 'URL_TIMEOUT' });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const bounded = async (promise) => {
    let listener;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        listener = () => reject(timeoutError);
        controller.signal.addEventListener('abort', listener, { once: true });
        if (controller.signal.aborted) listener();
      })]);
    } finally { controller.signal.removeEventListener('abort', listener); }
  };
  let current = String(rawUrl || '');
  let method = opts.method || 'GET';
  let body = opts.body;
  const headers = { ...(opts.headers || {}) };
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const checked = await bounded(assertPublicUrl(current, opts));
      const dispatcher = pinnedAgent(checked.connectIp);
      let res;
      try {
        res = await bounded(fetch(checked.href, {
          method, headers, body, redirect: 'manual', dispatcher, signal: controller.signal,
        }));
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          // Cancel redirect bodies instead of downloading potentially unbounded data.
          if (res.body) await bounded(res.body.cancel());
          if (hop >= maxRedirects) {
            throw Object.assign(new Error('Too many redirects'), { code: 'URL_REDIRECTS' });
          }
          const loc = res.headers.get('location');
          if (!loc) throw Object.assign(new Error('Redirect without Location'), { code: 'URL_REDIRECT' });
          if ((method === 'POST' && [301, 302].includes(res.status)) || (res.status === 303 && method !== 'HEAD')) {
            method = 'GET'; body = undefined;
          }
          current = new URL(loc, checked.href).toString();
          continue;
        }
        const chunks = [];
        let size = 0;
        if (res.body) {
          const reader = res.body.getReader();
          try {
            while (true) {
              const { done, value } = await bounded(reader.read());
              if (done) break;
              size += value.byteLength;
              if (size > maxBytes) {
                throw Object.assign(new Error('Public URL response exceeds size limit'), { code: 'URL_BODY_TOO_LARGE' });
              }
              chunks.push(Buffer.from(value));
            }
          } finally {
            try { await bounded(reader.cancel()); } catch { /* dispatcher is destroyed below */ }
            reader.releaseLock();
          }
        }
        // Return a fully consumed bounded response so callers cannot retain a live dispatcher.
        const responseHeaders = new Headers(res.headers);
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
        const result = new Response([204, 205, 304].includes(res.status) ? null : Buffer.concat(chunks, size), {
          status: res.status, statusText: res.statusText, headers: responseHeaders,
        });
        Object.defineProperty(result, 'url', { value: res.url || checked.href });
        return result;
      } finally {
        await dispatcher.destroy();
      }
    }
  } finally { clearTimeout(timer); }
}

module.exports = {
  normalizeIp,
  isPrivateIp,
  assertPublicUrl,
  fetchPublic,
};
