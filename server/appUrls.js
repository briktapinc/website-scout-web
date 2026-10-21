'use strict';

function staffPath(route = 'dashboard', params = {}) {
  const text = String(route || 'dashboard').replace(/^\/?#\/?/, '').replace(/^\/+/, '');
  const split = text.indexOf('?');
  const path = split < 0 ? text : text.slice(0, split);
  const query = new URLSearchParams(split < 0 ? '' : text.slice(split + 1));
  for (const [key, value] of new URLSearchParams(params)) if (!query.has(key)) query.set(key, value);
  return `/app#/${path || 'dashboard'}${query.size ? '?' + query.toString() : ''}`;
}

function staffUrl(route, params) {
  const base = new URL(require('./stripeClient').appUrl());
  return base.origin + staffPath(route, params);
}

function socialReturnPath(raw, params) {
  const fallback = () => staffPath('social', params);
  if (!String(raw || '').trim()) return fallback();
  try {
    const base = new URL(require('./stripeClient').appUrl());
    const url = new URL(String(raw).trim(), base);
    if (url.origin !== base.origin) return fallback();
    const pathname = url.pathname.replace(/\/$/, '');
    if (pathname === '/portal' || pathname === '/client') {
      url.searchParams.set('connected', '1');
      if (!url.searchParams.has('panel')) url.searchParams.set('panel', 'social');
      return url.pathname + url.search + url.hash;
    }
    if ((pathname === '/app' || pathname === '') && (!url.hash || url.hash.startsWith('#/'))) {
      const query = new URLSearchParams(url.search);
      for (const [key, value] of new URLSearchParams(params)) if (!query.has(key)) query.set(key, value);
      return staffPath(url.hash.slice(2) || 'social', query);
    }
  } catch { /* Invalid or off-site destinations use the staff social screen. */ }
  return fallback();
}

module.exports = { staffPath, staffUrl, socialReturnPath };
