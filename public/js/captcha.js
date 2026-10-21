'use strict';

/**
 * Shared Cloudflare Turnstile helper for public forms.
 * Renders Turnstile inside a same-origin iframe on APP_URL (/embed/captcha.html)
 * so customer sites (CF Pages / custom domains) do not need Turnstile hostname allowlisting.
 *
 * window.ScoutCaptcha.mount(el, { apiBase }) → { enabled, getToken, reset }
 */
window.ScoutCaptcha = (() => {
  function resolveApiBase(explicit) {
    const raw = explicit
      || window.BitpypeApiBase
      || (document.documentElement && document.documentElement.getAttribute('data-bitpype-api'))
      || '';
    if (raw) return String(raw).replace(/\/$/, '');
    try {
      const src = document.querySelector(
        'script[data-bitpype-form-script],script[src*="form-embed.js"],script[src*="captcha.js"]'
      );
      if (src && src.src) {
        const origin = new URL(src.src).origin;
        if (origin && origin !== 'null') return origin;
      }
    } catch { /* ignore */ }
    return '';
  }

  function loadConfig(apiBase) {
    const base = resolveApiBase(apiBase);
    const url = `${base}/api/v1/captcha/config`;
    return fetch(url, { credentials: 'omit' })
      .then((r) => r.json())
      .then((d) => (d && d.ok && d.data) || { enabled: false, siteKey: '' })
      .catch(() => ({ enabled: false, siteKey: '' }));
  }

  async function mount(container, opts = {}) {
    const base = resolveApiBase(opts.apiBase);
    if (!container) return { enabled: false, getToken: async () => '', reset: () => {} };

    container.innerHTML = '';
    const cfg = await loadConfig(base);
    if (!cfg.enabled || !cfg.siteKey || !base) {
      container.hidden = true;
      return { enabled: false, getToken: async () => '', reset: () => {} };
    }

    container.hidden = false;
    let token = '';
    let ready = false;
    let lastError = '';
    let expectedOrigin = '';
    try { expectedOrigin = new URL(base).origin; } catch { expectedOrigin = ''; }

    const iframe = document.createElement('iframe');
    iframe.src = `${base}/embed/captcha.html?theme=${encodeURIComponent(opts.theme || 'light')}`;
    iframe.title = 'Captcha';
    iframe.setAttribute('aria-label', 'Captcha');
    iframe.loading = 'eager';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    iframe.style.cssText = 'border:0;width:100%;max-width:320px;height:78px;overflow:hidden;background:transparent;';
    container.appendChild(iframe);

    function onMessage(ev) {
      // A sandboxed preview makes its nested captcha frame opaque too.
      if (expectedOrigin && ev.origin !== expectedOrigin && !(window.origin === 'null' && ev.origin === 'null')) return;
      if (ev.source !== iframe.contentWindow) return;
      const data = ev && ev.data;
      if (!data || data.type !== 'bitpype-captcha') return;
      if (data.event === 'ready' || data.event === 'pong') ready = true;
      if (data.event === 'token') {
        token = String(data.token || '');
        lastError = '';
      }
      if (data.event === 'expired') token = '';
      if (data.event === 'disabled') {
        container.hidden = true;
        ready = true;
      }
      if (data.event === 'error') {
        lastError = String(data.message || 'Captcha failed');
        token = '';
      }
      if (data.event === 'resize' && data.height) {
        iframe.style.height = `${Math.max(65, Number(data.height) || 65)}px`;
      }
    }
    window.addEventListener('message', onMessage);

    // Wait briefly for the iframe to come up (non-fatal if slow).
    await new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (ready || Date.now() - t0 > 8000) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });

    return {
      enabled: !container.hidden,
      getToken: async () => {
        if (container.hidden) return '';
        if (token) return token;
        if (lastError) throw new Error(lastError);
        throw new Error('Please complete the captcha');
      },
      reset: () => {
        token = '';
        try {
          iframe.contentWindow.postMessage({ type: 'bitpype-captcha', event: 'reset' }, window.origin === 'null' ? '*' : (expectedOrigin || '*'));
        } catch { /* ignore */ }
      },
      destroy: () => {
        window.removeEventListener('message', onMessage);
        container.innerHTML = '';
      },
    };
  }

  return { loadConfig, mount };
})();
