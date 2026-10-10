/* ============================================================================
 * CLOUDFLARE PUBLISH SNIPPET (WORKSTREAM 6) — NOT a standalone page.
 *
 * The coordinator splices the HTML fragment below into the Websites page
 * (e.g. renderer/websites.html, next to the site detail actions) and the JS
 * fragment into the matching renderer script (e.g. renderer/websites.js).
 *
 * Plain JS, framework-free. All data access via window.api.invoke().
 * Escape user content before innerHTML (per CONTRACT renderer conventions).
 * ========================================================================== */

/* ---- HTML FRAGMENT (splice into the site detail / actions area) ------------
 *
 * <div id="cf-publish-block" class="card">
 *   <h3>Public preview</h3>
 *   <p class="muted">Publish this site to Cloudflare Pages for a real public URL.</p>
 *   <button id="btn-cf-publish">Publish preview</button>
 *   <span id="cf-publish-status" class="muted"></span>
 *   <div id="cf-publish-result" hidden>
 *     <input id="cf-public-url" readonly size="48" />
 *     <button id="btn-cf-copy">Copy</button>
 *     <a id="cf-public-link" href="#" target="_blank" rel="noopener">Open</a>
 *   </div>
 *   <div id="cf-not-configured" hidden>
 *     Cloudflare is not configured.
 *     <a href="#/settings">Add your API token in Settings</a>.
 *   </div>
 * </div>
 *
 * -------------------------------------------------------------------------- */

/* ---- JS FRAGMENT (splice into the Websites page script) ------------------ */

(function cloudflarePublishSnippet() {
  'use strict';

  // The host page must set this before wiring the button, e.g. when a site
  // is selected: window.__cfWebsiteId = site.id
  function currentWebsiteId() {
    const v = window.__cfWebsiteId;
    return Number.isInteger(v) && v > 0 ? v : null;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(msg) {
    const n = el('cf-publish-status');
    if (n) n.textContent = msg || '';
  }

  function showResult(url) {
    const box = el('cf-publish-result');
    const input = el('cf-public-url');
    const link = el('cf-public-link');
    if (!box || !input) return;
    box.hidden = false;
    input.value = url;
    if (link) link.href = url;
  }

  async function refreshConfiguredState() {
    const warn = el('cf-not-configured');
    const btn = el('btn-cf-publish');
    try {
      const cfg = await window.api.invoke('cloudflare:getConfig');
      const ok = !!(cfg && cfg.configured);
      if (warn) warn.hidden = ok;
      if (btn) btn.disabled = !ok;
      return ok;
    } catch (err) {
      if (warn) warn.hidden = false;
      if (btn) btn.disabled = true;
      return false;
    }
  }

  async function onPublishClick() {
    const websiteId = currentWebsiteId();
    if (!websiteId) {
      setStatus('Select a website first.');
      return;
    }
    const ok = await refreshConfiguredState();
    if (!ok) {
      setStatus('Cloudflare is not configured.');
      return;
    }
    setStatus('Publishing…');
    const btn = el('btn-cf-publish');
    if (btn) btn.disabled = true;
    try {
      // Export first (Website Engine workstream channel), then publish the
      // exported folder. If sites:export is unavailable or returns no folder,
      // cloudflare:publish falls back to websiteEngine.exportStatic in main.
      let dir;
      try {
        const exported = await window.api.invoke('sites:export', websiteId);
        dir =
          (exported && typeof exported === 'object' &&
            (exported.dir || exported.path || exported.preview_path)) ||
          (typeof exported === 'string' ? exported : undefined);
      } catch (err) {
        dir = undefined; // main process will try its own export path
      }
      const args = { websiteId };
      if (typeof dir === 'string' && dir) args.dir = dir;
      const res = await window.api.invoke('cloudflare:publish', args);
      if (res && res.ok) {
        setStatus('Published.');
        showResult(res.url);
      } else if (res && res.error === 'NEEDS_EXPORT') {
        setStatus('Export the site first, then publish.');
      } else {
        setStatus('Publish failed: ' + esc((res && (res.error || res.detail)) || 'unknown error'));
      }
    } catch (err) {
      setStatus('Publish failed: ' + esc(err && err.message ? err.message : 'unknown error'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function onCopyClick() {
    const input = el('cf-public-url');
    if (!input || !input.value) return;
    const url = input.value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        input.select();
        document.execCommand('copy');
      }
      setStatus('Copied.');
    } catch (err) {
      setStatus('Copy failed — select the URL manually.');
    }
  }

  // Wire up when the fragment's elements exist (call after the page renders).
  function initCloudflarePublish() {
    const btn = el('btn-cf-publish');
    if (btn) btn.addEventListener('click', onPublishClick);
    const copy = el('btn-cf-copy');
    if (copy) copy.addEventListener('click', onCopyClick);
    refreshConfiguredState();
  }

  // Export for the host page script.
  window.initCloudflarePublish = initCloudflarePublish;
  window.cfPublishCurrentSite = onPublishClick;
})();
