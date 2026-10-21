'use strict';

(function () {
  const gate = document.getElementById('gate');
  const app = document.getElementById('app');
  const formAccess = document.getElementById('form-access');
  const formLogin = document.getElementById('form-login');
  const tabAccess = document.getElementById('tab-access');
  const tabLogin = document.getElementById('tab-login');

  let captchaAccess = { enabled: false, getToken: async () => '', reset: () => {} };
  let captchaLogin = { enabled: false, getToken: async () => '', reset: () => {} };
  let state = {
    client: null,
    year: null,
    month: null,
    posts: [],
    page: 1,
    pageSize: 6,
    imagePriceUsd: 1,
    imageCredits: 1,
    contentCredits: 1,
    creditsBalance: 0,
    creditsConfigured: false,
    creditsPackLabel: 'Credits pack',
    socialImagesIncluded: false,
    previewUrl: null,
    hasSite: false,
    publishBusy: false,
    siteEditable: false,
    editMode: false,
    editFullscreen: false,
    pendingEdits: new Map(),
    canUndo: false,
    previewFrame: null,
    editableHtml: null,
    imageUploading: false,
    logoUploading: false,
    logo: { mode: 'text', url: null, publicUrl: null, brandName: null },
    aiImageSrc: null,
    entitlements: {},
    plan: 'free',
    themeOpen: false,
    themeSaving: false,
    theme: { primary: '#1a56db', secondary: '#0e2a5c', bg: '#ffffff', text: '#1f2937', font: '', headingFont: '' },
    themeSaved: { primary: '#1a56db', secondary: '#0e2a5c', bg: '#ffffff', text: '#1f2937', font: '', headingFont: '' },
    /** Colors currently painted in the preview iframe (role + palette hexes). */
    themeLive: { primary: '#1a56db', secondary: '#0e2a5c', bg: '#ffffff', text: '#1f2937' },
    /** Extra colors from site CSS: [{ original, current, roles }] */
    themePalette: [],
    selectedEditId: '',
    structureOpen: false,
    structureBusy: false,
    structurePageIdx: 0,
    structureInsertAfter: 0,
    canvasPick: null,
    structure: null,
  };

  const THEME_KEYS = ['primary', 'secondary', 'bg', 'text'];
  const THEME_VAR = { primary: '--ws-primary', secondary: '--ws-secondary', bg: '--ws-bg', text: '--ws-text' };

  const LOCKED_EDIT_PATH = /(^|\.)(phone|phone_display|email|address|address_lines|hours|rating|review_count|business_name|href|cta_href|cta_secondary_href|button_href|url|photographer|photographer_url|pexels_url)$/;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api/v1/portal${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || !data.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.code = data && data.code;
      err.status = res.status;
      if (res.status === 401 && (
        err.code === 'AUTH_REQUIRED'
        || err.code === 'SESSION_IDLE'
        || err.message === 'AUTH_REQUIRED'
      )) {
        showPortalLogin();
        if (err.code === 'SESSION_IDLE') {
          const msg = document.getElementById('msg-login');
          if (msg) {
            msg.className = 'msg err';
            msg.textContent = err.message || 'Signed out after 30 hours of inactivity. Please sign in again.';
          }
        }
      }
      throw err;
    }
    return data.data;
  }

  const PORTAL_PANELS = ['website', 'changes', 'forms', 'modules', 'social', 'referrals', 'mcp', 'billing'];
  const PANEL_ALIASES = {
    website: 'website',
    preview: 'website',
    site: 'website',
    changes: 'changes',
    change: 'changes',
    request: 'changes',
    forms: 'forms',
    form: 'forms',
    submissions: 'forms',
    modules: 'modules',
    module: 'modules',
    blog: 'modules',
    shop: 'modules',
    ecommerce: 'modules',
    courses: 'modules',
    gallery: 'modules',
    directory: 'modules',
    social: 'social',
    calendar: 'social',
    posts: 'social',
    referrals: 'referrals',
    referral: 'referrals',
    refer: 'referrals',
    billing: 'billing',
    plans: 'billing',
    subscribe: 'billing',
    mcp: 'mcp',
    agent: 'mcp',
    muse: 'mcp',
    cursor: 'mcp',
  };

  function resolvePortalPanel(raw) {
    const key = String(raw || '').toLowerCase().trim();
    if (!key) return null;
    if (PANEL_ALIASES[key]) return PANEL_ALIASES[key];
    if (PORTAL_PANELS.includes(key)) return key;
    return null;
  }

  function parsePortalPanelQuery() {
    try {
      const panel = new URLSearchParams(location.search).get('panel');
      if (!panel) return null;
      return resolvePortalPanel(panel);
    } catch {
      return null;
    }
  }

  function parsePortalHash() {
    // Hash wins once set. ?panel= is only a deep-link seed (OAuth / emails).
    // Preferring query over hash made tab clicks snap back after hashchange.
    const raw = String(location.hash || '').replace(/^#\/?/, '').trim().toLowerCase();
    const key = raw.split(/[/?&#]/)[0] || '';
    if (key) return resolvePortalPanel(key);
    return parsePortalPanelQuery();
  }

  function panelHash(panel) {
    return `#/${panel}`;
  }

  function clearPortalPanelQuery() {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has('panel')) return;
      url.searchParams.delete('panel');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch { /* ignore */ }
  }

  let portalAuthed = false;

  function showPortalLogin() {
    portalAuthed = false;
    showGate();
    if (!location.hash) return;
    const panel = parsePortalHash();
    const url = new URL(location.href);
    if (panel && !url.searchParams.get('panel')) url.searchParams.set('panel', panel);
    url.hash = '';
    history.replaceState(null, '', url.pathname + url.search);
  }

  function showPortalPanel(panel, opts = {}) {
    if (!portalAuthed) {
      showPortalLogin();
      return null;
    }
    const next = PORTAL_PANELS.includes(panel) ? panel : 'website';
    if (next !== 'website' && state.editFullscreen) setEditFullscreen(false);

    PORTAL_PANELS.forEach((id) => {
      const sec = document.querySelector(`section.portal-panel[data-panel="${id}"]`);
      const tab = document.querySelector(`#portal-nav [data-panel="${id}"]`);
      const active = id === next;
      if (sec) {
        if (active) sec.removeAttribute('hidden');
        else sec.setAttribute('hidden', '');
      }
      if (tab) {
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
      }
    });

    const wrap = document.querySelector('.wrap');
    if (wrap) wrap.classList.toggle('is-website-wide', next === 'website');

    if (next === 'mcp' && state.mcpPaid) refreshMcpTokens().catch(() => {});
    if (next === 'referrals') loadReferrals().catch(() => {});

    if (opts.updateHash !== false) {
      const want = panelHash(next);
      if (location.hash !== want) {
        if (opts.replaceHash) history.replaceState(null, '', want);
        else location.hash = want;
      }
      // Drop sticky ?panel= so later hashchanges (and bookmarks) follow the tab.
      clearPortalPanelQuery();
    }
    return next;
  }

  function syncPortalPanelFromHash(opts = {}) {
    let panel = parsePortalHash();
    if (!panel && portalCheckoutFlag()) panel = 'billing';
    if (!panel) panel = 'website';
    return showPortalPanel(panel, { updateHash: true, replaceHash: true, ...opts });
  }

  // Register early so a later setup error cannot leave tabs dead.
  const portalNav = document.getElementById('portal-nav');
  if (portalNav) {
    portalNav.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-panel]');
      if (!btn || !portalNav.contains(btn)) return;
      showPortalPanel(btn.getAttribute('data-panel'));
    });
    portalNav.addEventListener('keydown', (ev) => {
      const tabs = [...portalNav.querySelectorAll('[data-panel]')];
      const current = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
      if (current < 0) return;
      let next = -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (current + 1) % tabs.length;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (current - 1 + tabs.length) % tabs.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      ev.preventDefault();
      showPortalPanel(tabs[next].getAttribute('data-panel'));
      tabs[next].focus();
    });
  }
  window.addEventListener('hashchange', () => {
    if (!portalAuthed) {
      showPortalLogin();
      return;
    }
    syncPortalPanelFromHash();
  });

  function showGate() {
    gate.classList.remove('hidden');
    app.classList.add('hidden');
    state.siteEditable = false;
    state.editMode = false;
    state.editableHtml = null;
    state.previewFrame = null;
    state.pendingEdits.clear();
    setEditFullscreen(false);
    const editBtn = document.getElementById('btn-edit-mode');
    if (editBtn) editBtn.classList.add('hidden');
    const themeBtn = document.getElementById('btn-theme-colors');
    if (themeBtn) themeBtn.classList.add('hidden');
    const structBtn = document.getElementById('btn-structure');
    if (structBtn) structBtn.classList.add('hidden');
    state.themeOpen = false;
    state.structureOpen = false;
    state.structure = null;
    const themeBar = document.getElementById('theme-bar');
    if (themeBar) themeBar.hidden = true;
    const structBar = document.getElementById('structure-bar');
    if (structBar) structBar.hidden = true;
    syncFullscreenButtons();
  }

  function showApp() {
    portalAuthed = true;
    gate.classList.add('hidden');
    app.classList.remove('hidden');
    syncPortalPanelFromHash();
  }

  function setTab(which) {
    const access = which === 'access';
    tabAccess.setAttribute('aria-selected', access ? 'true' : 'false');
    tabLogin.setAttribute('aria-selected', access ? 'false' : 'true');
    formAccess.classList.toggle('hidden', !access);
    formLogin.classList.toggle('hidden', access);
  }

  tabAccess.onclick = () => setTab('access');
  tabLogin.onclick = () => setTab('login');

  async function mountCaptchas() {
    if (!window.ScoutCaptcha) return;
    try {
      captchaAccess = await window.ScoutCaptcha.mount(document.getElementById('captcha-access'));
    } catch (e) { console.warn(e); }
    try {
      captchaLogin = await window.ScoutCaptcha.mount(document.getElementById('captcha-login'));
    } catch (e) { console.warn(e); }
  }

  formAccess.onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('msg-access');
    const btn = document.getElementById('btn-access');
    msg.className = 'msg';
    msg.textContent = 'Sending…';
    btn.disabled = true;
    try {
      const captchaToken = await captchaAccess.getToken();
      const email = document.getElementById('access-email').value.trim();
      await api('/access', {
        method: 'POST',
        body: JSON.stringify({ email, captchaToken }),
      });
      msg.className = 'msg ok';
      msg.textContent = 'If that email matches a project, a one-time sign-in link is on its way. Check your inbox — we never invent passwords for unknown emails.';
      try { captchaAccess.reset && captchaAccess.reset(); } catch { /* */ }
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
      try { captchaAccess.reset && captchaAccess.reset(); } catch { /* */ }
    } finally {
      btn.disabled = false;
    }
  };

  formLogin.onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('msg-login');
    const btn = document.getElementById('btn-login');
    msg.className = 'msg';
    msg.textContent = 'Signing in…';
    btn.disabled = true;
    try {
      const captchaToken = await captchaLogin.getToken();
      const data = await api('/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value.trim(),
          password: document.getElementById('login-password').value,
          captchaToken,
        }),
      });
      state.client = data.client;
      document.getElementById('login-password').value = '';
      try { captchaLogin.reset && captchaLogin.reset(); } catch { /* */ }
      await loadDashboard();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message === 'INVALID_CREDENTIALS'
        ? 'Email or password is incorrect.'
        : e.message;
      try { captchaLogin.reset && captchaLogin.reset(); } catch { /* */ }
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('btn-logout').onclick = async () => {
    try { await api('/logout', { method: 'POST', body: '{}' }); } catch { /* */ }
    state.client = null;
    showPortalLogin();
    await mountCaptchas();
  };

  function syncPublishButton() {
    const pubBtn = document.getElementById('btn-publish-site');
    if (!pubBtn) return;
    const show = !!(state.hasSite || state.previewUrl || state.siteEditable);
    pubBtn.classList.toggle('hidden', !show);
  }

  function setOpenPreview(previewUrl) {
    const openBtn = document.getElementById('btn-open-preview');
    if (openBtn) {
      if (!previewUrl) {
        openBtn.classList.add('hidden');
        openBtn.setAttribute('href', '#');
      } else {
        openBtn.href = previewUrl;
        openBtn.classList.remove('hidden');
      }
    }
    syncPublishButton();
  }

  function publishSuccessMessage(data) {
    const via = data && data.via;
    if (via === 'cloudflare') return 'Published. Your public preview is up to date.';
    if (via === 'app_url') return 'Published. Your preview link has been refreshed.';
    if (data && data.publicPreviewUpdated) return 'Published. Preview updated.';
    return 'Published.';
  }

  async function publishSitePreview() {
    const btn = document.getElementById('btn-publish-site');
    const label = document.getElementById('btn-publish-site-label');
    const msg = document.getElementById('msg-publish');
    if (state.publishBusy) return;
    state.publishBusy = true;
    if (btn) btn.disabled = true;
    if (label) label.textContent = 'Publishing…';
    if (msg) { msg.className = 'msg'; msg.textContent = 'Updating your live preview…'; }
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    try {
      const data = await api('/site/publish', { method: 'POST', body: '{}' });
      if (data && data.previewUrl) state.previewUrl = data.previewUrl;
      setOpenPreview(state.previewUrl);
      const okText = publishSuccessMessage(data);
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent = okText;
      }
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: keepMode,
        preserveFullscreen: keepFs,
      });
      if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
      else if (keepFs && state.siteEditable) setEditFullscreen(true);
      setTimeout(() => {
        if (msg && msg.textContent === okText) {
          msg.className = 'msg';
          msg.textContent = '';
        }
      }, 5000);
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = e.message || 'Could not publish preview';
      }
    } finally {
      state.publishBusy = false;
      if (btn) btn.disabled = false;
      if (label) label.textContent = 'Publish';
    }
  }

  function postEditModeToFrame(on) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ source: 'ws-portal', type: 'edit-mode', on: !!on }, '*');
    } catch { /* */ }
  }

  function syncFullscreenButtons() {
    const enter = document.getElementById('btn-enter-fullscreen');
    const exit = document.getElementById('btn-exit-fullscreen');
    const canFs = !!state.siteEditable;
    if (enter) {
      if (canFs && !state.editFullscreen) enter.classList.remove('hidden');
      else enter.classList.add('hidden');
    }
    if (exit) {
      if (canFs && state.editFullscreen) exit.classList.remove('hidden');
      else exit.classList.add('hidden');
    }
  }

  function setEditFullscreen(on) {
    const next = !!(on && state.siteEditable);
    state.editFullscreen = next;
    const sec = document.getElementById('sec-preview');
    if (sec) sec.classList.toggle('is-edit-fullscreen', next);
    document.body.classList.toggle('is-preview-fullscreen', next);
    syncFullscreenButtons();
    if (typeof syncThemeUi === 'function') syncThemeUi();
  }

  function normalizeThemeHex(value) {
    let s = String(value == null ? '' : value).trim();
    if (!s) return null;
    if (s[0] !== '#') s = `#${s}`;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
    return s.toLowerCase();
  }

  function readThemeForm() {
    const out = {};
    for (const key of THEME_KEYS) {
      const hexEl = document.getElementById(`theme-hex-${key}`);
      const pickEl = document.getElementById(`theme-pick-${key}`);
      const raw = (hexEl && hexEl.value) || (pickEl && pickEl.value) || state.theme[key];
      const hex = normalizeThemeHex(raw);
      if (!hex) {
        const err = new Error(`Invalid ${key} color — use #RRGGBB`);
        err.key = key;
        throw err;
      }
      out[key] = hex;
    }
    return out;
  }

  function fillThemeForm(colors) {
    const c = colors || state.theme;
    for (const key of THEME_KEYS) {
      const hex = normalizeThemeHex(c[key]) || state.themeSaved[key] || '#000000';
      const hexEl = document.getElementById(`theme-hex-${key}`);
      const pickEl = document.getElementById(`theme-pick-${key}`);
      if (hexEl) hexEl.value = hex;
      if (pickEl) pickEl.value = hex;
    }
  }

  function setThemeFromServer(theme) {
    if (!theme || typeof theme !== 'object') return;
    const next = { ...state.theme };
    for (const key of THEME_KEYS) {
      const hex = normalizeThemeHex(theme[key]);
      if (hex) next[key] = hex;
    }
    if (theme.font) next.font = String(theme.font);
    if (theme.headingFont != null) next.headingFont = String(theme.headingFont || '');
    state.theme = next;
    state.themeSaved = { ...next };
    state.themeLive = {
      primary: next.primary,
      secondary: next.secondary,
      bg: next.bg,
      text: next.text,
    };
    const roleSet = new Set(THEME_KEYS.map((k) => next[k]));
    const rawPalette = Array.isArray(theme.palette) ? theme.palette : [];
    state.themePalette = rawPalette
      .map((p) => {
        const hex = normalizeThemeHex(p.hex || p);
        if (!hex) return null;
        return {
          original: hex,
          current: hex,
          roles: Array.isArray(p.roles) ? p.roles : [],
          isRole: roleSet.has(hex),
        };
      })
      .filter(Boolean);
    fillThemeForm(next);
    fillFontSelects();
    renderThemePalette();
  }

  function renderThemePalette() {
    const wrap = document.getElementById('theme-palette-wrap');
    const host = document.getElementById('theme-palette');
    if (!wrap || !host) return;
    const extras = state.themePalette.filter((p) => !p.isRole);
    if (!extras.length) {
      wrap.hidden = true;
      host.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    host.innerHTML = extras.map((p, i) => {
      const label = p.roles && p.roles.length ? p.roles.join('/') : `Accent ${i + 1}`;
      return `<div class="theme-palette-item">
        <label>${esc(label)}</label>
        <div class="theme-inputs">
          <input type="color" data-palette-i="${i}" value="${esc(p.current)}" aria-label="${esc(label)} color" />
          <input type="text" data-palette-i="${i}" value="${esc(p.current)}" maxlength="7" spellcheck="false" autocomplete="off" />
        </div>
      </div>`;
    }).join('');
  }

  function rewriteHexInPreviewDoc(doc, fromHex, toHex) {
    if (!doc || !fromHex || !toHex || fromHex === toHex) return;
    const from = String(fromHex);
    const to = String(toHex);
    const re = () => new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const styles = doc.querySelectorAll('style');
    styles.forEach((el) => {
      const text = el.textContent;
      if (!text || text.toLowerCase().indexOf(from.toLowerCase()) < 0) return;
      el.textContent = text.replace(re(), to);
    });
    doc.querySelectorAll('[style]').forEach((el) => {
      const s = el.getAttribute('style');
      if (!s || s.toLowerCase().indexOf(from.toLowerCase()) < 0) return;
      el.setAttribute('style', s.replace(re(), to));
    });
    // SVG fill/stroke attributes
    doc.querySelectorAll('[fill],[stroke]').forEach((el) => {
      ['fill', 'stroke'].forEach((attr) => {
        const v = el.getAttribute(attr);
        if (!v || v.toLowerCase().indexOf(from.toLowerCase()) < 0) return;
        el.setAttribute(attr, v.replace(re(), to));
      });
    });
  }

  function ensureCatalogStyles(doc) {
    const target = doc || document;
    if (!target.head || !window.WsFonts) return;
    if (target.getElementById('ws-font-catalog')) return;
    const link = target.createElement('link');
    link.id = 'ws-font-catalog';
    link.rel = 'stylesheet';
    link.href = window.WsFonts.catalogHref();
    target.head.appendChild(link);
  }

  function ensureFrameFonts(doc, names) {
    if (!doc || !doc.head || !window.WsFonts) return;
    const add = (names || []).filter(Boolean);
    if (!add.length) return;
    let link = doc.querySelector('link[data-ws-fonts="1"]');
    if (!link) {
      link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('data-ws-fonts', '1');
      doc.head.appendChild(link);
    }
    const have = String(link.getAttribute('data-families') || '').split('|').filter(Boolean);
    const all = [...new Set(have.concat(add))];
    link.setAttribute('data-families', all.join('|'));
    link.href = window.WsFonts.hrefFor(all);
  }

  function fillFontSelects() {
    if (!window.WsFonts) return;
    const body = state.theme.font || '';
    const heading = state.theme.headingFont || '';
    window.WsFonts.fillSelect(document.getElementById('theme-font-body'), body, { defaultLabel: 'System' });
    window.WsFonts.fillSelect(document.getElementById('theme-font-heading'), heading, { defaultLabel: 'Same as site font' });
    window.WsFonts.fillSelect(document.getElementById('edit-font-body'), body, { defaultLabel: 'System' });
    window.WsFonts.fillSelect(document.getElementById('edit-font-heading'), heading, { defaultLabel: 'Same as site font' });
    const el = document.getElementById('edit-font-element');
    if (el && !el.options.length) {
      window.WsFonts.fillSelect(el, '', { defaultLabel: 'Site default' });
    }
    if (el) el.disabled = !state.selectedEditId;
  }

  function readThemeFonts() {
    const fonts = window.WsFonts;
    const bodySel = document.getElementById('theme-font-body');
    const headSel = document.getElementById('theme-font-heading');
    let font = state.theme.font || (fonts ? fonts.SYSTEM : '');
    let headingFont = state.theme.headingFont || '';
    if (bodySel && bodySel.value && bodySel.value !== '__custom__' && fonts) font = fonts.stackFor(bodySel.value);
    else if (bodySel && bodySel.value === '' && fonts) font = fonts.SYSTEM;
    if (headSel && headSel.value && headSel.value !== '__custom__' && fonts) headingFont = fonts.stackFor(headSel.value);
    else if (headSel && headSel.value === '') headingFont = '';
    return { font, headingFont };
  }

  function applyFontsLive(fonts, doc) {
    if (!fonts) return;
    const frame = state.previewFrame;
    let target = doc;
    if (!target && frame) {
      try { target = frame.contentDocument; } catch { target = null; }
    }
    if (!target || !target.documentElement) return;
    target.documentElement.style.setProperty('--ws-font', fonts.font || '');
    target.documentElement.style.setProperty('--ws-heading-font', fonts.headingFont || fonts.font || '');
    let style = target.getElementById('ws-font-rules');
    if (!style && target.head) {
      style = target.createElement('style');
      style.id = 'ws-font-rules';
      target.head.appendChild(style);
    }
    if (style) {
      style.textContent = 'body{font-family:var(--ws-font)}h1,h2,h3,h4,h5,h6{font-family:var(--ws-heading-font,var(--ws-font))}';
    }
    if (window.WsFonts) {
      ensureFrameFonts(target, [
        window.WsFonts.matchName(fonts.font),
        window.WsFonts.matchName(fonts.headingFont),
      ]);
    }
  }

  function syncFontSelect(sourceId, peerId) {
    const source = document.getElementById(sourceId);
    const peer = document.getElementById(peerId);
    if (source && peer && peer.value !== source.value) peer.value = source.value;
  }

  function onSiteFontPick(which) {
    if (which === 'body') syncFontSelect('theme-font-body', 'edit-font-body');
    if (which === 'heading') syncFontSelect('theme-font-heading', 'edit-font-heading');
    const fonts = readThemeFonts();
    state.theme = { ...state.theme, font: fonts.font, headingFont: fonts.headingFont };
    applyFontsLive(fonts);
  }

  function postElementFont(name) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow || !window.WsFonts) return;
    let doc = null;
    try { doc = frame.contentDocument; } catch { doc = null; }
    if (name && doc) ensureFrameFonts(doc, [name]);
    frame.contentWindow.postMessage({
      source: 'ws-portal',
      type: 'set-font',
      family: name ? window.WsFonts.stackFor(name) : '',
      name: name || '',
    }, '*');
  }

  async function handleElementFont(data) {
    const id = String((data && data.id) || '');
    if (/^html:\d+:\d+(?::\d+)?$/.test(id) && data.html) {
      await handleListMutate({
        action: 'freeform-save',
        pageIndex: data.pageIndex,
        sectionIndex: data.sectionIndex,
        html: data.html,
      });
      return;
    }
    if (!/^\d+:\d+:/.test(id)) return;
    const msg = document.getElementById('msg-edit');
    if (msg) { msg.className = 'msg'; msg.textContent = 'Saving font…'; }
    await api('/site/theme', {
      method: 'POST',
      body: JSON.stringify({ elementFonts: { [id]: data.font || '' } }),
    });
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    await loadEditablePreview(state.previewUrl);
    if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
    if (msg) { msg.className = 'msg ok'; msg.textContent = 'Font saved on that element.'; }
  }

  function applyThemeLiveToPreview(colors, opts = {}) {
    const frame = state.previewFrame;
    if (!frame) return false;
    let doc;
    try { doc = frame.contentDocument; } catch { return false; }
    if (!doc || !doc.documentElement) return false;
    const root = doc.documentElement;
    const next = colors || {};
    // Rewrite hard-coded hexes currently painted in the iframe (freeform sites).
    for (const key of THEME_KEYS) {
      const hex = normalizeThemeHex(next[key]);
      if (!hex) continue;
      const prev = normalizeThemeHex(state.themeLive[key]) || normalizeThemeHex(state.theme[key]);
      if (prev && prev !== hex) rewriteHexInPreviewDoc(doc, prev, hex);
      root.style.setProperty(THEME_VAR[key], hex);
      state.themeLive[key] = hex;
    }
    if (Array.isArray(opts.paletteRewrites)) {
      opts.paletteRewrites.forEach((pair) => {
        if (pair && pair.from && pair.to && pair.from !== pair.to) {
          rewriteHexInPreviewDoc(doc, pair.from, pair.to);
        }
      });
    }
    applyFontsLive(readThemeFonts(), doc);
    // Refresh :root block inside engine theme style for freeform / customCss consumers.
    const style = doc.querySelector('style[data-ws-theme="1"]');
    if (style && style.textContent) {
      let css = style.textContent;
      const rootBlock = `:root{--ws-primary:${state.themeLive.primary};--ws-secondary:${state.themeLive.secondary};--ws-bg:${state.themeLive.bg};--ws-text:${state.themeLive.text}`;
      if (/:root\s*\{[^}]*--ws-primary/.test(css)) {
        css = css.replace(
          /:root\s*\{[^}]*--ws-primary:[^;]+;--ws-secondary:[^;]+;--ws-bg:[^;]+;--ws-text:[^;]+;?(--ws-font:[^;}]+;?)?\}/,
          (m) => {
            const fontMatch = m.match(/--ws-font:([^;}]+)/);
            const font = fontMatch ? fontMatch[1] : null;
            return font
              ? `${rootBlock};--ws-font:${font}}`
              : `${rootBlock}}`;
          }
        );
        style.textContent = css;
      }
    }
    return true;
  }

  function syncThemeUi() {
    const btn = document.getElementById('btn-theme-colors');
    const label = document.getElementById('btn-theme-colors-label');
    const bar = document.getElementById('theme-bar');
    const can = !!state.siteEditable;
    if (btn) {
      if (can) btn.classList.remove('hidden');
      else btn.classList.add('hidden');
      btn.setAttribute('aria-pressed', state.themeOpen && can ? 'true' : 'false');
    }
    if (label) label.textContent = state.themeOpen && can ? 'Hide theme' : 'Theme';
    if (bar) bar.hidden = !(can && state.themeOpen && !state.editFullscreen);
    const saveBtn = document.getElementById('btn-theme-save');
    if (saveBtn) saveBtn.disabled = !!state.themeSaving;
  }

  function syncStructureUi() {
    const btn = document.getElementById('btn-structure');
    const label = document.getElementById('btn-structure-label');
    const bar = document.getElementById('structure-bar');
    const can = !!state.siteEditable;
    if (btn) {
      if (can) btn.classList.remove('hidden');
      else btn.classList.add('hidden');
      btn.setAttribute('aria-pressed', state.structureOpen && can ? 'true' : 'false');
      btn.classList.toggle('ghost', !!(state.structureOpen && can));
      btn.classList.toggle('soft', !(state.structureOpen && can));
    }
    if (label) label.textContent = state.structureOpen && can ? 'Hide order' : 'Order';
    if (bar) bar.hidden = !(can && state.structureOpen && !state.editFullscreen);
  }

  function setStructureMsg(text, kind) {
    const msg = document.getElementById('msg-structure');
    if (!msg) return;
    msg.className = kind ? `msg ${kind}` : 'msg';
    msg.textContent = text || '';
  }

  function renderStructureLists() {
    const menuEl = document.getElementById('structure-menu');
    const tabsEl = document.getElementById('structure-page-tabs');
    const secsEl = document.getElementById('structure-sections');
    const hintEl = document.getElementById('structure-sections-hint');
    if (!menuEl || !tabsEl || !secsEl) return;
    const data = state.structure;
    if (!data || !Array.isArray(data.menu)) {
      menuEl.innerHTML = '<p class="hint">No menu yet.</p>';
      tabsEl.innerHTML = '';
      secsEl.innerHTML = '';
      if (hintEl) hintEl.hidden = true;
      return;
    }
    const busy = !!state.structureBusy;
    menuEl.innerHTML = data.menu.map((item) => {
      const pinned = !!item.pinned;
      const depth = Number(item.depth) === 1 ? 1 : 0;
      const from = item.index != null ? item.index : item.visualIndex;
      const canUp = !busy && !!item.canUp;
      const canDown = !busy && !!item.canDown;
      const canNest = !busy && !!item.canNest;
      const canUnnest = !busy && !!item.canUnnest;
      const navVisible = item.navVisible !== false;
      const visTitle = navVisible ? 'Hide from menu' : 'Show in menu';
      const meta = pinned ? 'Home' : (depth === 1 ? 'Sub' : (navVisible ? esc(item.slug || '') : 'Hidden'));
      return `<div class="structure-row${pinned ? ' pinned' : ''}${depth === 1 ? ' depth-1' : ''}${navVisible ? '' : ' nav-hidden'}">
        <span class="structure-label">${esc(item.title || item.slug || 'Page')}</span>
        <span class="structure-meta">${meta}</span>
        <button type="button" class="structure-visibility${navVisible ? '' : ' off'}" data-struct="menu" data-from="${from}" data-action="toggleNav" ${pinned || busy ? 'disabled' : ''} aria-label="${visTitle}" aria-pressed="${navVisible ? 'true' : 'false'}" title="${visTitle}">👁</button>
        <button type="button" data-struct="menu" data-from="${from}" data-action="unnest" ${canUnnest ? '' : 'disabled'} aria-label="Move out of submenu">←</button>
        <button type="button" data-struct="menu" data-from="${from}" data-action="nest" ${canNest ? '' : 'disabled'} aria-label="Nest under previous">→</button>
        <button type="button" data-struct="menu" data-from="${from}" data-dir="-1" data-action="move" ${canUp ? '' : 'disabled'} aria-label="Move up">↑</button>
        <button type="button" data-struct="menu" data-from="${from}" data-dir="1" data-action="move" ${canDown ? '' : 'disabled'} aria-label="Move down">↓</button>
      </div>`;
    }).join('') || '<p class="hint">No pages.</p>';

    const pages = Array.isArray(data.pages) ? data.pages : [];
    if (state.structurePageIdx >= pages.length) state.structurePageIdx = Math.max(0, pages.length - 1);
    tabsEl.innerHTML = pages.map((p, i) =>
      `<button type="button" class="${i === state.structurePageIdx ? 'active' : ''}" data-struct-page="${i}">${esc(p.title || p.slug || ('Page ' + (i + 1)))}</button>`
    ).join('');

    const page = pages[state.structurePageIdx];
    const menuMeta = (data.menu || []).find((m) => m && m.index === state.structurePageIdx)
      || data.menu[state.structurePageIdx];
    const freeform = !!(menuMeta && menuMeta.freeform);
    if (hintEl) hintEl.hidden = !freeform;
    const sections = page && Array.isArray(page.sections) ? page.sections : [];
    const insertGap = (afterIndex) =>
      `<div class="structure-insert-row"><button type="button" data-struct-insert="${afterIndex}" `
      + `${busy ? 'disabled' : ''} aria-label="Insert section">+</button></div>`;

    if (freeform && !sections.length) {
      secsEl.innerHTML = `${insertGap(0)}<p class="hint">Legacy freeform page — rebuild to modular sections, or + injects a site module into the HTML.</p>`;
    } else if (!sections.length) {
      secsEl.innerHTML = '<p class="hint">No sections on this page.</p>';
    } else {
      secsEl.innerHTML = sections.map((s, i) => {
        const pinned = !!s.pinned;
        let canUp = !busy && !pinned && i > 0;
        let canDown = !busy && !pinned && i < sections.length - 1;
        if (canUp && sections[i - 1] && sections[i - 1].pinned) canUp = false;
        if (canDown && sections[i + 1] && sections[i + 1].pinned) canDown = false;
        return `<div class="structure-row${pinned ? ' pinned' : ''}">
          <span class="structure-label">${esc(s.label || s.type || ('Section ' + (i + 1)))}</span>
          <span class="structure-meta">${pinned ? 'Fixed' : esc(s.type || '')}</span>
          <button type="button" data-struct="sections" data-from="${i}" data-dir="-1" ${canUp ? '' : 'disabled'} aria-label="Move up">↑</button>
          <button type="button" data-struct="sections" data-from="${i}" data-dir="1" ${canDown ? '' : 'disabled'} aria-label="Move down">↓</button>
        </div>${insertGap(i)}`;
      }).join('');
    }
    const addPageBtn = document.getElementById('btn-structure-add-page');
    if (addPageBtn) addPageBtn.disabled = busy;
  }

  function closeStructureModuleModal() {
    const backdrop = document.getElementById('structure-module-modal');
    if (backdrop) backdrop.hidden = true;
    const msg = document.getElementById('msg-structure-module');
    if (msg) { msg.className = 'msg'; msg.textContent = ''; }
    state.canvasPick = null;
  }

  function closeStructurePageModal() {
    const backdrop = document.getElementById('structure-page-modal');
    if (backdrop) backdrop.hidden = true;
    const msg = document.getElementById('msg-structure-page');
    if (msg) { msg.className = 'msg'; msg.textContent = ''; }
  }

  const CONTENT_BLOCKS = [
    { type: 'heading', label: 'Heading' },
    { type: 'text', label: 'Text' },
    { type: 'image', label: 'Image' },
    { type: 'html', label: 'HTML' },
  ];

  const LAYOUT_BLOCKS = [
    { type: 'columns', label: '1 column', cols: 1 },
    { type: 'columns', label: '2 columns', cols: 2 },
    { type: 'columns', label: '3 columns', cols: 3 },
    { type: 'columns', label: '4 columns', cols: 4 },
    { type: 'columns', label: '5 columns', cols: 5 },
    { type: 'columns', label: '6 columns', cols: 6 },
    { type: 'text_image', label: 'Text + image' },
    { type: 'cards', label: 'Cards' },
  ];

  const LEGACY_SECTION_BLOCKS = [
    { type: 'hero', label: 'Hero' },
    { type: 'services', label: 'Services' },
    { type: 'benefits', label: 'Benefits' },
    { type: 'about', label: 'About' },
    { type: 'faq', label: 'FAQ' },
    { type: 'cta', label: 'CTA' },
    { type: 'reviews', label: 'Reviews' },
    { type: 'gallery', label: 'Gallery' },
  ];

  function resolveStructureCols(btn) {
    if (!btn) return null;
    const fromSel = btn.getAttribute('data-structure-cols-from');
    if (fromSel) {
      const input = document.querySelector(fromSel);
      const n = input ? Number(input.value) : NaN;
      if (Number.isFinite(n)) return Math.max(1, Math.min(12, Math.round(n)));
    }
    const cols = btn.getAttribute('data-structure-cols');
    return cols != null ? Number(cols) : null;
  }

  function renderBlockPickerGroups({
    showLayouts = true,
    showWidgets = true,
    includeLegacy = false,
    canModules = false,
    mods = [],
    forms = [],
  } = {}) {
    let html = '';
    if (showLayouts) {
      html += `<div class="structure-block-group"><p class="hint" style="margin:0 0 8px">Design modules — Content</p>${
        CONTENT_BLOCKS.map((b) =>
          `<button type="button" data-structure-section-type="${esc(b.type)}">${esc(b.label)}</button>`
        ).join('')
      }</div>`;
      html += `<div class="structure-block-group" style="margin-top:14px"><p class="hint" style="margin:0 0 8px">Design modules — Layout</p>${
        LAYOUT_BLOCKS.map((b) =>
          `<button type="button" data-structure-section-type="${esc(b.type)}"${b.cols ? ` data-structure-cols="${b.cols}"` : ''}>${esc(b.label)}</button>`
        ).join('')
      }</div>`;
      if (includeLegacy) {
        html += `<div class="structure-block-group" style="margin-top:14px"><p class="hint" style="margin:0 0 8px">Page sections</p>${
          LEGACY_SECTION_BLOCKS.map((b) =>
            `<button type="button" data-structure-section-type="${esc(b.type)}">${esc(b.label)}</button>`
          ).join('')
        }</div>`;
      }
    }
    if (showWidgets) {
      html += `<div class="structure-block-group" style="margin-top:14px"><p class="hint" style="margin:0 0 8px">Widgets — Forms</p>${
        forms.length
          ? forms.map((f) => {
            const form = f.form || f;
            return `<button type="button" data-structure-form-id="${esc(String(form.id))}">${esc(form.name || form.title || ('Form ' + form.id))}</button>`;
          }).join('')
          : '<p class="hint">No forms yet. Create one in Forms.</p>'
      }</div>`;
      html += canModules
        ? `<div class="structure-block-group" style="margin-top:14px"><p class="hint" style="margin:0 0 8px">Widgets — Site modules</p><p class="hint" style="margin:0 0 8px">Style mounts to match the site (themed card/section + <code>.bitpype-module-embed</code>).</p>${
          (mods || []).map((m) =>
            `<button type="button" data-structure-module-type="${esc(m.type)}">${esc(m.label || m.type)}</button>`
          ).join('') || '<p class="hint">No modules available.</p>'
        }</div>`
        : '<p class="hint" style="margin-top:12px">Site modules require Standard or Premium.</p>';
    }
    return html || '<p class="hint">Nothing to insert.</p>';
  }

  function postInsertBlockToFrame(payload) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({
        source: 'ws-portal',
        type: 'insert-block',
        targetId: payload.targetId,
        html: payload.html || '',
      }, '*');
    } catch { /* */ }
  }

  async function applyCanvasPickLayout(sectionType, cols) {
    const pick = state.canvasPick;
    if (!pick || !pick.targetId) return;
    const msg = document.getElementById('msg-structure-module');
    try {
      const body = { kind: 'layout', type: sectionType };
      if (cols != null) body.cols = Number(cols);
      const data = await api('/site/canvas-block', { method: 'POST', body: JSON.stringify(body) });
      closeStructureModuleModal();
      postInsertBlockToFrame({ targetId: pick.targetId, html: data.html || '' });
    } catch (e) {
      if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not insert block'; }
    }
  }

  async function applyCanvasPickModule(moduleType) {
    const pick = state.canvasPick;
    if (!pick || !pick.targetId) return;
    const msg = document.getElementById('msg-structure-module');
    try {
      const data = await api('/site/canvas-block', {
        method: 'POST',
        body: JSON.stringify({ kind: 'module', type: moduleType }),
      });
      closeStructureModuleModal();
      postInsertBlockToFrame({ targetId: pick.targetId, html: data.html || '' });
    } catch (e) {
      if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not insert widget'; }
    }
  }

  async function applyCanvasPickForm(formId) {
    const pick = state.canvasPick;
    if (!pick || !pick.targetId) return;
    const msg = document.getElementById('msg-structure-module');
    try {
      const data = await api('/site/canvas-block', {
        method: 'POST',
        body: JSON.stringify({ kind: 'form', formId }),
      });
      closeStructureModuleModal();
      postInsertBlockToFrame({ targetId: pick.targetId, html: data.html || '' });
    } catch (e) {
      if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not insert form'; }
    }
  }

  /**
   * @param {number} afterIndex structure sidebar insert index (ignored for canvas)
   * @param {{ mode?: 'all'|'design-module'|'widget', targetId?: string, pageIndex?: number }} opts
   */
  async function openStructureModuleModal(afterIndex, opts = {}) {
    const mode = String(opts.mode || 'all').toLowerCase();
    state.structureInsertAfter = Number(afterIndex);
    state.canvasPick = (mode === 'design-module' || mode === 'widget')
      ? { mode, targetId: opts.targetId || '', pageIndex: opts.pageIndex }
      : null;
    const backdrop = document.getElementById('structure-module-modal');
    const listEl = document.getElementById('structure-module-list');
    const msg = document.getElementById('msg-structure-module');
    const titleEl = document.getElementById('structure-module-modal-title');
    const ledeEl = backdrop ? backdrop.querySelector('.lede') : null;
    if (!backdrop || !listEl) return;
    if (msg) { msg.className = 'msg'; msg.textContent = ''; }
    if (titleEl) {
      titleEl.textContent = mode === 'design-module'
        ? 'Add design module'
        : (mode === 'widget' ? 'Add widget' : 'Insert block');
    }
    if (ledeEl) {
      ledeEl.textContent = mode === 'design-module'
        ? 'Choose a design module (heading, text, image, columns, HTML, …) to place in this section.'
        : (mode === 'widget'
          ? 'Choose a form or site module to place inside this design module. Style embeds (card/section + .bitpype-module-embed / .bitpype-form-embed) so they match the site.'
          : 'Page → Section → Design module → Widget. Add layouts or live widgets. Style module/form mounts — do not leave bare default embeds.');
    }
    listEl.innerHTML = '<p class="hint">Loading…</p>';
    backdrop.hidden = false;
    const showLayouts = mode === 'all' || mode === 'design-module';
    const showWidgets = mode === 'all' || mode === 'widget';
    try {
      let mods = moduleState.summary && Array.isArray(moduleState.summary.modules)
        ? moduleState.summary.modules : null;
      if (!mods && showWidgets) {
        const data = await api('/modules');
        mods = Array.isArray(data.modules) ? data.modules : [];
        moduleState.summary = data;
      }
      const canModules = moduleState.enabled || (moduleState.summary && moduleState.summary.siteModules);
      let formList = [];
      if (showWidgets) {
        try {
          const formData = await api('/forms');
          formList = Array.isArray(formData.forms) ? formData.forms
            : (formData.form ? [formData.form] : []);
        } catch { formList = []; }
      }
      listEl.innerHTML = renderBlockPickerGroups({
        showLayouts,
        showWidgets,
        includeLegacy: mode === 'all',
        canModules,
        mods,
        forms: formList,
      });
    } catch (e) {
      listEl.innerHTML = renderBlockPickerGroups({
        showLayouts,
        showWidgets,
        includeLegacy: mode === 'all',
      });
      if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not load site modules'; }
    }
  }

  function openStructurePageModal() {
    const backdrop = document.getElementById('structure-page-modal');
    const input = document.getElementById('structure-page-title');
    const msg = document.getElementById('msg-structure-page');
    if (!backdrop) return;
    if (input) input.value = '';
    if (msg) { msg.className = 'msg'; msg.textContent = ''; }
    backdrop.hidden = false;
    if (input) input.focus();
  }

  async function postStructureBody(body, okMessage) {
    if (!state.siteEditable || state.structureBusy) return;
    state.structureBusy = true;
    syncStructureUi();
    renderStructureLists();
    setStructureMsg('Saving…', '');
    try {
      const result = await api('/site/structure', { method: 'POST', body: JSON.stringify(body) });
      if (result) {
        state.structure = { menu: result.menu, pages: result.pages };
        if (result.previewUrl) state.previewUrl = result.previewUrl;
        if (Number.isInteger(result.pageIndex)) state.structurePageIdx = result.pageIndex;
      }
      renderStructureLists();
      setStructureMsg(`${okMessage} Refreshing preview…`, 'ok');
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: state.editMode,
        preserveFullscreen: state.editFullscreen,
      });
      setStructureMsg(`${okMessage}`, 'ok');
    } catch (e) {
      setStructureMsg(e.message || 'Could not save', 'err');
      await loadStructure({ quiet: true });
    } finally {
      state.structureBusy = false;
      syncStructureUi();
      renderStructureLists();
    }
  }

  async function applyStructureInsertModule(moduleType) {
    closeStructureModuleModal();
    await postStructureBody({
      scope: 'sections',
      action: 'insertModule',
      pageIndex: state.structurePageIdx,
      afterIndex: state.structureInsertAfter,
      moduleType,
    }, 'Module block saved.');
  }

  async function applyStructureInsertForm(formId) {
    const msg = document.getElementById('msg-structure-module');
    try {
      const data = await api('/site/canvas-block', {
        method: 'POST',
        body: JSON.stringify({ kind: 'form', formId }),
      });
      const wrap = '<section class="ws-page-section" data-ws-page-section="1">'
        + (data && data.html ? data.html : '')
        + '</section>';
      closeStructureModuleModal();
      await postStructureBody({
        scope: 'sections',
        action: 'insertSection',
        pageIndex: state.structurePageIdx,
        afterIndex: state.structureInsertAfter,
        sectionType: 'html',
        html: wrap,
      }, 'Form block saved.');
    } catch (e) {
      if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not insert form'; }
    }
  }

  async function applyStructureInsertSection(sectionType, cols) {
    closeStructureModuleModal();
    const body = {
      scope: 'sections',
      action: 'insertSection',
      pageIndex: state.structurePageIdx,
      afterIndex: state.structureInsertAfter,
      sectionType,
    };
    if (cols != null) body.cols = Number(cols);
    await postStructureBody(body, 'Section saved.');
  }

  async function applyStructureAddPage(title) {
    closeStructurePageModal();
    await postStructureBody({
      scope: 'menu',
      action: 'addPage',
      title,
    }, 'Page created.');
  }

  async function loadStructure(opts = {}) {
    if (!state.siteEditable) return null;
    try {
      const data = await api('/site/structure');
      state.structure = data || null;
      if (!opts.quiet) setStructureMsg('', '');
      renderStructureLists();
      return data;
    } catch (e) {
      if (!opts.quiet) setStructureMsg(e.message || 'Could not load menu order', 'err');
      return null;
    }
  }

  async function applyStructureMove(scope, fromIndex, direction, action) {
    if (!state.siteEditable || state.structureBusy) return;
    state.structureBusy = true;
    syncStructureUi();
    renderStructureLists();
    const act = String(action || 'move').toLowerCase();
    const nesting = act === 'nest' || act === 'unnest';
    const toggleNav = act === 'togglenav';
    setStructureMsg(
      toggleNav ? 'Updating menu visibility…'
        : (nesting ? (act === 'nest' ? 'Nesting…' : 'Unnesting…') : 'Saving order…'),
      ''
    );
    try {
      const body = {
        scope,
        fromIndex: Number(fromIndex),
        action: toggleNav ? 'toggleNav' : (nesting ? act : 'move'),
      };
      if (!nesting && !toggleNav) body.direction = Number(direction);
      if (scope === 'sections') body.pageIndex = state.structurePageIdx;
      const result = await api('/site/structure', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (result) {
        state.structure = {
          menu: result.menu,
          pages: result.pages,
        };
        if (result.previewUrl) state.previewUrl = result.previewUrl;
      }
      renderStructureLists();
      setStructureMsg(toggleNav ? 'Menu updated. Refreshing preview…' : 'Order updated. Refreshing preview…', 'ok');
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: state.editMode,
        preserveFullscreen: state.editFullscreen,
      });
      setStructureMsg(toggleNav ? 'Menu visibility saved.' : 'Order saved on your site.', 'ok');
      setTimeout(() => {
        const msg = document.getElementById('msg-structure');
        if (msg && (msg.textContent.indexOf('Order saved') === 0 || msg.textContent.indexOf('Menu visibility saved') === 0)) {
          msg.className = 'msg';
          msg.textContent = '';
        }
      }, 3500);
    } catch (e) {
      setStructureMsg(e.message || 'Could not reorder', 'err');
      await loadStructure({ quiet: true });
    } finally {
      state.structureBusy = false;
      syncStructureUi();
      renderStructureLists();
    }
  }

  function syncEditModeUi() {
    const btn = document.getElementById('btn-edit-mode');
    const label = document.getElementById('btn-edit-mode-label');
    const box = document.getElementById('preview-box');
    const lede = document.getElementById('preview-lede');
    const on = !!(state.siteEditable && state.editMode);
    if (on || state.themeOpen) ensureCatalogStyles(document);
    syncThemeUi();
    syncStructureUi();

    if (btn) {
      if (state.siteEditable) btn.classList.remove('hidden');
      else btn.classList.add('hidden');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('ghost', on);
      btn.classList.toggle('soft', !on);
    }
    if (label) label.textContent = on ? 'Done' : 'Edit';
    if (box) box.classList.toggle('is-edit-mode', on);
    if (lede && state.siteEditable) {
      lede.textContent = on
        ? 'Edit mode on — click text to edit it, then pick a font for that element or for the whole site.'
        : 'Click Edit to change copy, fonts, images, or list items. Use the Changes tab for bigger updates.';
    }
    if (!state.siteEditable && state.editFullscreen) setEditFullscreen(false);
    else syncFullscreenButtons();
    postEditModeToFrame(on);
    const elementFont = document.getElementById('edit-font-element');
    if (elementFont) elementFont.disabled = !on || !state.selectedEditId;
    updateEditBar();
  }

  function setEditMode(on, opts = {}) {
    if (!state.siteEditable) {
      state.editMode = false;
      setEditFullscreen(false);
      syncEditModeUi();
      return;
    }
    state.editMode = !!on;
    if (opts.fullscreen === true) setEditFullscreen(true);
    else if (opts.fullscreen === false) setEditFullscreen(false);
    else if (on) setEditFullscreen(true);
    else setEditFullscreen(false);
    syncEditModeUi();
  }

  function updateEditBar() {
    const bar = document.getElementById('edit-bar');
    const hint = document.getElementById('edit-hint');
    const saveBtn = document.getElementById('btn-edit-save');
    const logoBar = document.getElementById('logo-bar');
    const n = state.pendingEdits.size;
    if (!bar) return;
    const show = state.siteEditable && (state.editMode || n > 0);
    bar.hidden = !show;
    if (logoBar) logoBar.hidden = !(state.siteEditable && state.editMode);
    if (!show) return;
    if (hint) {
      if (state.imageUploading || state.logoUploading) {
        hint.innerHTML = '<strong>Uploading…</strong> — hang tight while we resize and save it.';
      } else if (n > 0) {
        hint.innerHTML = `<strong>${n} unsaved edit${n === 1 ? '' : 's'}</strong> — Save to update your live preview, or Cancel to discard.`;
      } else {
        hint.innerHTML = '<strong>Edit mode</strong> — click text to change it. Delete section removes a block. Forms and other modules on the page have Delete module. Undo reverses the last add or delete.';
      }
    }
    if (saveBtn) saveBtn.disabled = n === 0 || state.imageUploading || state.logoUploading;
    const undoBtn = document.getElementById('btn-edit-undo');
    if (undoBtn) undoBtn.disabled = !state.canUndo || !state.editMode;
    syncLogoUi();
  }

  function syncLogoUi() {
    const logo = state.logo || { mode: 'text' };
    const modeImage = logo.mode === 'image' && !!(logo.publicUrl || logo.url);
    const textRadio = document.getElementById('logo-mode-text');
    const imageRadio = document.getElementById('logo-mode-image');
    const previewText = document.getElementById('logo-preview-text');
    const previewImg = document.getElementById('logo-preview-img');
    const removeBtn = document.getElementById('btn-logo-remove');
    const uploadBtn = document.getElementById('btn-logo-upload');
    if (textRadio) textRadio.checked = !modeImage;
    if (imageRadio) imageRadio.checked = modeImage;
    if (previewText) {
      previewText.textContent = logo.brandName
        || (state.client && state.client.business_name)
        || 'Business';
      previewText.hidden = modeImage;
    }
    if (previewImg) {
      if (modeImage) {
        previewImg.src = logo.publicUrl || logo.url;
        previewImg.hidden = false;
      } else {
        previewImg.removeAttribute('src');
        previewImg.hidden = true;
      }
    }
    if (removeBtn) removeBtn.hidden = !modeImage;
    if (uploadBtn) uploadBtn.disabled = !!state.logoUploading;
    if (removeBtn) removeBtn.disabled = !!state.logoUploading;
  }

  async function resizeLogoForUpload(file) {
    // Keep PNG when possible so transparency survives client resize.
    if (!/^image\/(jpeg|jpg|png|webp|gif)$/.test(file.type || '')) {
      throw new Error('Please choose a JPEG, PNG, WebP, or GIF image');
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('Could not read that image');
    }
    const maxW = 1280;
    let w = bitmap.width;
    let h = bitmap.height;
    if (w > maxW) {
      h = Math.round((h * maxW) / w);
      w = maxW;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not resize logo');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    try { bitmap.close(); } catch { /* */ }
    const mime = file.type === 'image/png' || file.type === 'image/webp' ? 'image/png' : (file.type || 'image/png');
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress logo'))), mime, 0.92);
    });
    if (blob.size > 5.2 * 1024 * 1024) {
      throw new Error('Logo is still too large after resize');
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(new Error('Could not read logo'));
      reader.readAsDataURL(blob);
    });
    return { data, mimeType: mime, bytes: blob.size };
  }

  async function applyLogoMode(mode, file) {
    if (!state.siteEditable || state.logoUploading) return;
    const msg = document.getElementById('msg-logo');
    state.logoUploading = true;
    updateEditBar();
    try {
      let body;
      if (mode === 'text') {
        body = { mode: 'text' };
        if (msg) { msg.className = 'msg'; msg.textContent = 'Switching to text logo…'; }
      } else {
        const prepared = file
          ? await resizeLogoForUpload(file)
          : null;
        if (!prepared) throw new Error('Choose a logo image');
        body = { mode: 'image', data: prepared.data, mimeType: prepared.mimeType };
        if (msg) { msg.className = 'msg'; msg.textContent = 'Uploading logo…'; }
      }
      const result = await api('/site/logo', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      state.logo = {
        mode: result.mode || mode,
        url: result.logoUrl || null,
        publicUrl: result.publicUrl || null,
        brandName: result.brandName || state.logo.brandName,
      };
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent = mode === 'text' ? 'Using text logo again.' : 'Logo updated on your preview.';
      }
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: true,
        preserveFullscreen: state.editFullscreen,
      });
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = e.message || 'Could not update logo';
      }
      syncLogoUi();
    } finally {
      state.logoUploading = false;
      updateEditBar();
    }
  }

  function clearPendingEdits() {
    state.pendingEdits.clear();
    const msg = document.getElementById('msg-edit');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = '';
    }
    updateEditBar();
  }

  function renderStaticPreview(previewUrl) {
    const box = document.getElementById('preview-box');
    state.previewFrame = null;
    state.siteEditable = false;
    state.editMode = false;
    state.editableHtml = null;
    clearPendingEdits();
    setEditFullscreen(false);
    setOpenPreview(previewUrl);
    syncEditModeUi();
    const lede = document.getElementById('preview-lede');
    if (!previewUrl) {
      box.innerHTML = '<div class="preview-empty" id="preview-empty">No preview is available yet. We’ll notify you when it’s ready.</div>';
      if (lede) lede.textContent = 'Live look at the current site we built for you.';
      return;
    }
    if (lede) {
      lede.textContent = 'Live look at your site. Use the Changes tab for updates — this preview is view-only.';
    }
    box.innerHTML = `
      <iframe title="Website preview" src="${esc(previewUrl)}" sandbox="allow-scripts allow-forms" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
  }

  function getPreviewScroll() {
    const parentY = window.scrollY || window.pageYOffset || 0;
    const parentX = window.scrollX || window.pageXOffset || 0;
    try {
      const win = state.previewFrame && state.previewFrame.contentWindow;
      if (!win) return { x: 0, y: 0, parentX, parentY };
      return {
        x: win.scrollX || win.pageXOffset || 0,
        y: win.scrollY || win.pageYOffset || 0,
        parentX,
        parentY,
      };
    } catch {
      return { x: 0, y: 0, parentX, parentY };
    }
  }

  function restorePreviewScroll(pos) {
    if (!pos) return;
    try {
      window.scrollTo(pos.parentX || 0, pos.parentY || 0);
    } catch { /* */ }
    const apply = () => {
      try {
        const win = state.previewFrame && state.previewFrame.contentWindow;
        if (win) win.scrollTo(pos.x || 0, pos.y || 0);
      } catch { /* */ }
      try {
        window.scrollTo(pos.parentX || 0, pos.parentY || 0);
      } catch { /* */ }
    };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 40);
    setTimeout(apply, 160);
    setTimeout(apply, 400);
  }

  function renderEditableHtml(html, previewUrl, opts = {}) {
    const box = document.getElementById('preview-box');
    const lede = document.getElementById('preview-lede');
    const keepEdit = !!opts.preserveEditMode;
    const keepFs = !!opts.preserveFullscreen;
    const scrollPos = opts.restoreScroll || null;
    state.siteEditable = true;
    state.editableHtml = html || '';
    state.canUndo = false;
    if (!keepEdit) state.editMode = false;
    setOpenPreview(previewUrl);
    if (lede && !keepEdit) {
      lede.textContent = 'Click Edit to change copy or images in the preview. Use the Changes tab for bigger updates.';
    }
    box.innerHTML = `
      <iframe title="Website preview" id="portal-preview-frame"
        sandbox="allow-scripts allow-forms"
        referrerpolicy="no-referrer"></iframe>`;
    const frame = document.getElementById('portal-preview-frame');
    state.previewFrame = frame;
    frame.addEventListener('load', () => {
      if (keepEdit || state.editMode) {
        state.editMode = true;
        if (keepFs) state.editFullscreen = true;
        syncEditModeUi();
        postEditModeToFrame(true);
      }
      if (scrollPos) restorePreviewScroll(scrollPos);
    });
    frame.srcdoc = html || '<p style="font-family:sans-serif;padding:1rem">Empty preview.</p>';
    if (!keepEdit) syncEditModeUi();
    else {
      // Keep chrome in edit mode while iframe loads
      state.editMode = true;
      if (keepFs) {
        state.editFullscreen = true;
        const sec = document.getElementById('sec-preview');
        if (sec) sec.classList.add('is-edit-fullscreen');
        document.body.classList.add('is-preview-fullscreen');
      }
      syncEditModeUi();
    }
  }

  async function loadEditablePreview(fallbackUrl, opts = {}) {
    try {
      const q = new URLSearchParams({ editable: '1' });
      if (opts.pageSlug != null && String(opts.pageSlug).trim() !== '') {
        q.set('pageSlug', String(opts.pageSlug).trim());
      }
      const data = await api('/site/render?' + q.toString());
      if (data && data.previewUrl) state.previewUrl = data.previewUrl;
      if (data && data.logo) {
        state.logo = {
          mode: data.logo.mode || 'text',
          url: data.logo.url || null,
          publicUrl: data.logo.publicUrl || null,
          brandName: data.logo.brandName || null,
        };
      }
      if (data && data.theme) setThemeFromServer(data.theme);
      const url = (data && data.previewUrl) || fallbackUrl || state.previewUrl;
      if (data && data.editable && data.html) {
        renderEditableHtml(data.html, url, opts);
        syncLogoUi();
        syncThemeUi();
        return;
      }
      renderStaticPreview(url || fallbackUrl);
    } catch (e) {
      if (fallbackUrl || state.previewUrl) {
        renderStaticPreview(fallbackUrl || state.previewUrl);
      } else {
        renderStaticPreview(null);
      }
    }
  }

  function previewNavSlug(data) {
    const raw = String((data && (data.slug || data.file)) || '')
      .trim()
      .replace(/^\.\//, '')
      .replace(/^\//, '')
      .replace(/\.html$/i, '');
    if (!raw || raw === 'index' || raw === 'home') return 'home';
    return raw.replace(/[^a-z0-9-_]/gi, '_');
  }

  function handlePreviewNavMessage(data) {
    if (!data) return;
    if (data.external) {
      if (data.href) {
        try { window.open(data.href, '_blank', 'noopener,noreferrer'); } catch { /* */ }
      }
      return;
    }
    const id = previewNavSlug(data);
    const frame = state.previewFrame;
    try {
      const doc = frame && frame.contentDocument;
      const el = doc && id && doc.getElementById(id);
      if (el) {
        try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        catch { el.scrollIntoView(true); }
        return;
      }
    } catch { /* srcdoc should be same-origin */ }
    // Guard found no #anchor (single-page render or unrewritten link) — load that page.
    const pageSlug = id === 'home' ? '/' : id;
    loadEditablePreview(state.previewUrl, {
      pageSlug,
      preserveEditMode: state.editMode,
      preserveFullscreen: state.editFullscreen,
    });
  }

  function postImageBusyToFrame(src, on) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({
        source: 'ws-portal',
        type: 'image-busy',
        src: String(src || ''),
        on: !!on,
      }, '*');
    } catch { /* */ }
  }

  function pickImageFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp,image/gif';
      input.style.display = 'none';
      document.body.appendChild(input);
      let settled = false;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        window.setTimeout(() => { try { input.remove(); } catch { /* */ } }, 0);
        fn(val);
      };
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) finish(reject, new Error('cancelled'));
        else finish(resolve, file);
      });
      input.addEventListener('cancel', () => finish(reject, new Error('cancelled')));
      input.click();
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.readAsDataURL(blob);
    });
  }

  async function resizeImageForUpload(file, maxWidth = 1600) {
    const type = String(file.type || '').toLowerCase();
    if (!/^image\/(jpeg|jpg|png|webp|gif)$/.test(type)) {
      throw new Error('Please choose a JPEG, PNG, WebP, or GIF image');
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('Could not read that image');
    }
    let w = bitmap.width;
    let h = bitmap.height;
    if (!w || !h) {
      try { bitmap.close(); } catch { /* */ }
      throw new Error('Could not read that image');
    }
    if (w > maxWidth) {
      h = Math.max(1, Math.round(h * (maxWidth / w)));
      w = maxWidth;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      try { bitmap.close(); } catch { /* */ }
      throw new Error('Could not resize image');
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    try { bitmap.close(); } catch { /* */ }

    const preferJpeg = type !== 'image/png' || w * h > 800 * 800;
    const mime = preferJpeg ? 'image/jpeg' : 'image/png';
    const quality = preferJpeg ? 0.85 : undefined;
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress image'))), mime, quality);
    });
    // Keep under portal JSON limit after base64 (~33% overhead).
    if (blob.size > 4.5 * 1024 * 1024) {
      const tighter = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Image is still too large after resize'))),
          'image/jpeg',
          0.72
        );
      });
      const data = await blobToBase64(tighter);
      return { data, mimeType: 'image/jpeg', width: w, height: h, bytes: tighter.size };
    }
    const data = await blobToBase64(blob);
    return { data, mimeType: mime, width: w, height: h, bytes: blob.size };
  }

  async function handleImageReplace(replaceSrc) {
    if (!state.siteEditable || !state.editMode || state.imageUploading) return;
    const src = String(replaceSrc || '').trim();
    if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) return;

    const msg = document.getElementById('msg-edit');
    let file;
    try {
      file = await pickImageFile();
    } catch {
      return;
    }

    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    state.imageUploading = true;
    updateEditBar();
    postImageBusyToFrame(src, true);
    if (msg) {
      msg.className = 'msg';
      msg.textContent = 'Resizing and uploading image…';
    }

    try {
      const prepared = await resizeImageForUpload(file, 1600);
      const result = await api('/site/image', {
        method: 'POST',
        body: JSON.stringify({
          replaceSrc: src,
          data: prepared.data,
          mimeType: prepared.mimeType,
        }),
      });
      if (result && result.previewUrl) state.previewUrl = result.previewUrl;
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent = 'Image updated on your live preview.';
      }
      await loadEditablePreview(state.previewUrl);
      if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
      else if (keepFs && state.siteEditable) setEditFullscreen(true);
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = e.message || 'Could not update image';
      }
      postImageBusyToFrame(src, false);
    } finally {
      state.imageUploading = false;
      updateEditBar();
    }
  }

  async function refreshCreditHints() {
    try {
      const b = await api('/billing');
      const credits = (b && b.credits) || {};
      if (credits.balance != null) state.creditsBalance = Number(credits.balance) || 0;
      if (credits.perSocialImage != null) state.imageCredits = Math.max(0, Number(credits.perSocialImage) || 0);
      state.creditsConfigured = !!credits.priceConfigured;
      state.entitlements = (b && b.entitlements) || state.entitlements || {};
      state.plan = (b && b.plan) || state.plan || 'free';
      state.socialImagesIncluded = !!(state.entitlements && state.entitlements.socialImagesIncluded);
    } catch { /* keep last known */ }
  }

  function aiImageCostLabel() {
    if (state.socialImagesIncluded) return 'Included in Premium — no credit charge.';
    const n = Math.max(0, Number(state.imageCredits) || 0);
    return `Costs ${n} credit${n === 1 ? '' : 's'} (balance: ${state.creditsBalance}). Buy packs in Billing if needed.`;
  }

  function closeAiImageModal() {
    const modal = document.getElementById('ai-image-modal');
    if (modal) modal.hidden = true;
    state.aiImageSrc = null;
    const ta = document.getElementById('ai-image-prompt');
    if (ta) ta.value = '';
    const msg = document.getElementById('msg-ai-image');
    if (msg) { msg.className = 'msg'; msg.textContent = ''; }
  }

  async function openAiImageModal(replaceSrc) {
    if (!state.siteEditable || !state.editMode || state.imageUploading) return;
    const src = String(replaceSrc || '').trim();
    if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) return;
    state.aiImageSrc = src;
    await refreshCreditHints();
    const hint = document.getElementById('ai-image-credit-hint');
    if (hint) hint.textContent = aiImageCostLabel();
    const msg = document.getElementById('msg-ai-image');
    if (msg) { msg.className = 'msg'; msg.textContent = ''; }
    const ta = document.getElementById('ai-image-prompt');
    if (ta) ta.value = '';
    const modal = document.getElementById('ai-image-modal');
    if (modal) modal.hidden = false;
    if (ta) setTimeout(() => ta.focus(), 0);
  }

  async function submitAiImageGenerate() {
    const src = String(state.aiImageSrc || '').trim();
    const ta = document.getElementById('ai-image-prompt');
    const prompt = ta ? String(ta.value || '').trim() : '';
    const modalMsg = document.getElementById('msg-ai-image');
    const msg = document.getElementById('msg-edit');
    const genBtn = document.getElementById('btn-ai-image-generate');
    if (!src) { closeAiImageModal(); return; }
    if (!prompt) {
      if (modalMsg) { modalMsg.className = 'msg err'; modalMsg.textContent = 'Enter a description for the image.'; }
      return;
    }
    if (state.imageUploading) return;

    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    state.imageUploading = true;
    updateEditBar();
    if (genBtn) genBtn.disabled = true;
    if (modalMsg) { modalMsg.className = 'msg'; modalMsg.textContent = 'Generating image… this can take a minute.'; }
    postImageBusyToFrame(src, true);

    try {
      const result = await api('/site/image-generate', {
        method: 'POST',
        body: JSON.stringify({ replaceSrc: src, prompt }),
      });
      if (result && result.previewUrl) state.previewUrl = result.previewUrl;
      if (result && result.credits_balance != null) state.creditsBalance = Number(result.credits_balance);
      if (result && result.social_images_included != null) {
        state.socialImagesIncluded = !!result.social_images_included;
      }
      const charged = Number(result && result.credits_charged) || 0;
      closeAiImageModal();
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent = charged > 0
          ? `Image generated. Used ${charged} credit${charged === 1 ? '' : 's'} (${state.creditsBalance} left).`
          : 'Image generated and updated on your live preview.';
      }
      await loadEditablePreview(state.previewUrl);
      if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
      else if (keepFs && state.siteEditable) setEditFullscreen(true);
    } catch (e) {
      const insufficient = e && (e.code === 'INSUFFICIENT_CREDITS' || /not enough credits/i.test(e.message || ''));
      if (modalMsg) {
        modalMsg.className = 'msg err';
        modalMsg.textContent = insufficient
          ? (e.message || 'Not enough credits. Buy more in Billing.')
          : (e.message || 'Could not generate image');
      }
      if (msg && insufficient) {
        msg.className = 'msg err';
        msg.textContent = e.message || 'Not enough credits. Buy more in Billing.';
      }
      postImageBusyToFrame(src, false);
    } finally {
      state.imageUploading = false;
      updateEditBar();
      if (genBtn) genBtn.disabled = false;
    }
  }

  async function handleListMutate(data) {
    const msg = document.getElementById('msg-edit');
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    const action = String(data.action || '');
    const scrollPos = getPreviewScroll();
    if (msg) {
      msg.className = 'msg';
      msg.textContent = action === 'freeform-save'
        ? 'Saving…'
        : action === 'delete'
          ? 'Updating list…'
          : 'Adding item…';
    }
    try {
      // Flush pending text edits first so we don't lose them on reload
      if (state.pendingEdits.size) {
        const edits = [...state.pendingEdits.entries()].map(([id, text]) => ({ id, text }));
        await api('/site/edits', { method: 'POST', body: JSON.stringify({ edits }) });
        clearPendingEdits();
      }
      const body = action === 'freeform-save'
        ? {
          action: 'freeform-save',
          pageIndex: data.pageIndex,
          sectionIndex: data.sectionIndex,
          html: data.html,
          embedRemove: data.embedRemove || null,
          embedRestore: data.embedRestore || null,
        }
        : {
          action: action === 'delete' ? 'delete' : 'add',
          pageIndex: data.pageIndex,
          sectionIndex: data.sectionIndex,
          listKey: data.listKey || 'items',
          index: data.index,
        };
      const out = await api('/site/list-item', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (out && out.previewUrl) state.previewUrl = out.previewUrl;
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent = action === 'delete' ? 'Item removed.' : 'Item added.';
      }
      // Freeform already mutated the live DOM — skip iframe reload (no jump).
      if (action === 'freeform-save') {
        restorePreviewScroll(scrollPos);
        setTimeout(() => {
          if (msg && (msg.textContent === 'Item removed.' || msg.textContent === 'Item added.')) {
            msg.className = 'msg';
            msg.textContent = '';
          }
        }, 2500);
        return;
      }
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: keepMode,
        preserveFullscreen: keepFs,
        restoreScroll: scrollPos,
      });
      setTimeout(() => {
        if (msg && (msg.textContent === 'Item removed.' || msg.textContent === 'Item added.')) {
          msg.className = 'msg';
          msg.textContent = '';
        }
      }, 3000);
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = e.message || 'Could not update list';
      }
      // Freeform DOM already changed — reload to resync if save failed
      if (action === 'freeform-save') {
        try {
          await loadEditablePreview(state.previewUrl, {
            preserveEditMode: keepMode,
            preserveFullscreen: keepFs,
            restoreScroll: scrollPos,
          });
        } catch { /* */ }
      }
    }
  }

  window.addEventListener('message', (ev) => {
    const frame = state.previewFrame;
    if (!frame || ev.source !== frame.contentWindow) return;
    const data = ev.data;
    if (!data) return;
    if (data.source === 'ws-preview-nav') {
      handlePreviewNavMessage(data);
      return;
    }
    if (data.source !== 'ws-preview') return;
    if (!state.siteEditable) return;
    if (data.type === 'ready') {
      if (state.editMode) postEditModeToFrame(true);
      return;
    }
    if (data.type === 'list-error') {
      const msg = document.getElementById('msg-edit');
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = data.message || 'Could not change list';
      }
      return;
    }
    if (data.type === 'undo-state') {
      state.canUndo = !!data.canUndo;
      updateEditBar();
      return;
    }
    if (data.type === 'list-mutate') {
      if (!state.editMode) return;
      handleListMutate(data);
      return;
    }
    if (data.type === 'pick-block') {
      if (!state.editMode) return;
      const mode = String(data.mode || '').toLowerCase();
      if (mode !== 'design-module' && mode !== 'widget') return;
      openStructureModuleModal(-1, {
        mode,
        targetId: data.targetId || '',
        pageIndex: data.pageIndex,
      });
      return;
    }
    if (data.type === 'image-replace') {
      if (!state.editMode) return;
      handleImageReplace(data.src || data.absSrc || '');
      return;
    }
    if (data.type === 'image-ai-generate') {
      if (!state.editMode) return;
      openAiImageModal(data.src || data.absSrc || '');
      return;
    }
    if (data.type === 'element-select') {
      state.selectedEditId = String(data.id || '');
      const sel = document.getElementById('edit-font-element');
      if (sel && window.WsFonts) {
        if (!sel.options.length) window.WsFonts.fillSelect(sel, '', { defaultLabel: 'Site default' });
        sel.disabled = !state.selectedEditId || !state.editMode;
        sel.value = window.WsFonts.matchName(data.fontFamily || '') || '';
      }
      return;
    }
    if (data.type === 'element-font') {
      if (!state.editMode) return;
      handleElementFont(data).catch((e) => {
        const msg = document.getElementById('msg-edit');
        if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not save font'; }
      });
      return;
    }
    const id = String(data.id || '');
    if (!id || !state.editMode) return;
    const text = String(data.text || '').replace(/\s+/g, ' ').trim();
    // Freeform HTML text nodes:
    //   html:pageIndex:nodeIndex (legacy page.html)
    //   html:pageIndex:sectionIndex:nodeIndex (modular section content.html)
    if (/^html:\d+:\d+(?::\d+)?$/.test(id)) {
      state.pendingEdits.set(id, text);
      updateEditBar();
      return;
    }
    const m = id.match(/^(\d+):(\d+):(.+)$/);
    if (!m || LOCKED_EDIT_PATH.test(m[3])) return;
    state.pendingEdits.set(id, text);
    updateEditBar();
  });

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function formatWhen(iso) {
    return esc(String(iso || '').replace('T', ' ').slice(0, 16)) + ' UTC';
  }

  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '$1.00';
    return `$${v.toFixed(2)}`;
  }

  function absoluteUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/')) return `${location.origin}${s}`;
    return s;
  }

  function renderPostPage() {
    const list = document.getElementById('post-list');
    const pager = document.getElementById('post-pager');
    const info = document.getElementById('post-page-info');
    const posts = state.posts;
    if (!posts.length) {
      list.innerHTML = '<p class="hint">No posts this month yet. Generate a week or a month below.</p>';
      pager.hidden = true;
      return;
    }

    const pages = Math.max(1, Math.ceil(posts.length / state.pageSize));
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
    const start = (state.page - 1) * state.pageSize;
    const slice = posts.slice(start, start + state.pageSize);
    const showGenAd = !!state.socialImagesIncluded;

    list.innerHTML = slice.map((p) => {
      const img = absoluteUrl(p.image_url);
      const platforms = (p.platforms || []).map((x) => esc(x)).join(', ');
      const media = img
        ? `<div class="post-media"><img src="${esc(img)}" alt="Post image" loading="lazy" /></div>`
        : `<div class="post-media">No image yet</div>`;
      return `
        <article class="post-card" data-post-id="${esc(p.id)}">
          ${media}
          <div class="post-body">
            <div class="post-meta">
              <span>${formatWhen(p.scheduled_at)}</span>
              <span class="platforms">${platforms || 'facebook, instagram'}</span>
              <span class="status-pill">${esc(p.status || 'draft')}</span>
            </div>
            <div class="post-cap-block">
              <textarea class="post-cap-edit" data-caption-for="${esc(p.id)}" rows="3" aria-label="Post caption">${esc(p.caption || '')}</textarea>
              <button type="button" class="btn ghost small" data-act="save-caption" data-id="${esc(p.id)}">Save caption</button>
            </div>
            <div class="post-actions">
              ${showGenAd
                ? `<button type="button" class="btn soft small" data-act="gen-image" data-id="${esc(p.id)}">Generate AD</button>`
                : ''}
              ${['draft', 'pending_approval', 'approved', 'rejected'].includes(String(p.status || ''))
                ? `<button type="button" class="btn soft small" data-act="approve" data-id="${esc(p.id)}">Approve &amp; schedule</button>`
                : ''}
              <label class="hint" style="display:inline-flex;align-items:center;gap:6px">
                When
                <input type="datetime-local" data-act="sched" data-id="${esc(p.id)}"
                  value="${esc(String(p.scheduled_at || '').slice(0, 16))}"
                  style="font:inherit;padding:6px 10px;border:1.5px solid rgba(28,20,15,.16);border-radius:14px;background:var(--paper);color:var(--ink)" />
              </label>
              <button type="button" class="btn ghost small" data-act="share-native" data-id="${esc(p.id)}">Share</button>
              <button type="button" class="btn ghost small" data-act="share-fb" data-id="${esc(p.id)}">Facebook</button>
              <button type="button" class="btn ghost small" data-act="share-ig" data-id="${esc(p.id)}">Instagram</button>
              <button type="button" class="btn ghost small" data-act="copy" data-id="${esc(p.id)}">Copy caption</button>
            </div>
          </div>
        </article>`;
    }).join('');

    pager.hidden = pages <= 1;
    info.textContent = `Showing ${start + 1}–${Math.min(start + state.pageSize, posts.length)} of ${posts.length}`;
    document.getElementById('post-prev').disabled = state.page <= 1;
    document.getElementById('post-next').disabled = state.page >= pages;
  }

  function findPost(id) {
    return state.posts.find((p) => Number(p.id) === Number(id));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  async function sharePost(post, mode) {
    const msg = document.getElementById('msg-social');
    const caption = String((post && post.caption) || '');
    const img = absoluteUrl(post && post.image_url);
    if (mode === 'copy') {
      const ok = await copyText(caption);
      msg.className = ok ? 'msg ok' : 'msg err';
      msg.textContent = ok ? 'Caption copied.' : 'Could not copy caption.';
      return;
    }
    if (mode === 'native') {
      if (navigator.share) {
        try {
          await navigator.share({
            title: document.getElementById('biz-name').textContent || 'Social post',
            text: caption,
            url: img || location.href,
          });
          msg.className = 'msg ok';
          msg.textContent = 'Share sheet opened.';
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      const ok = await copyText(caption + (img ? `\n${img}` : ''));
      msg.className = ok ? 'msg ok' : 'msg err';
      msg.textContent = ok
        ? 'Copied caption' + (img ? ' and image link' : '') + ' — paste into your app.'
        : 'Sharing is not available in this browser.';
      return;
    }
    if (mode === 'fb') {
      const target = img || location.href;
      window.open(
        `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(target)}&quote=${encodeURIComponent(caption)}`,
        '_blank',
        'noopener,noreferrer'
      );
      msg.className = 'msg ok';
      msg.textContent = 'Facebook share opened. Paste the caption if the quote field is empty.';
      return;
    }
    if (mode === 'ig') {
      await copyText(caption);
      if (img) window.open(img, '_blank', 'noopener,noreferrer');
      window.open('https://www.instagram.com/', '_blank', 'noopener,noreferrer');
      msg.className = 'msg ok';
      msg.textContent = 'Caption copied. Open the image, save it, then create an Instagram post.';
    }
  }

  async function saveCaption(postId) {
    const msg = document.getElementById('msg-social');
    const ta = document.querySelector(`textarea[data-caption-for="${postId}"]`);
    const btn = document.querySelector(`[data-act="save-caption"][data-id="${postId}"]`);
    if (!ta) return;
    const caption = String(ta.value || '');
    msg.className = 'msg';
    msg.textContent = 'Saving caption…';
    if (btn) btn.disabled = true;
    try {
      const data = await api(`/social/posts/${postId}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption }),
      });
      const idx = state.posts.findIndex((p) => Number(p.id) === Number(postId));
      if (idx >= 0) {
        state.posts[idx] = Object.assign({}, state.posts[idx], data && data.post ? data.post : { caption });
      }
      msg.className = 'msg ok';
      msg.textContent = 'Caption saved.';
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function generateBrandedImage(postId) {
    if (!state.socialImagesIncluded) return;
    const msg = document.getElementById('msg-social');
    const btn = document.querySelector(`[data-act="gen-image"][data-id="${postId}"]`);
    msg.className = 'msg';
    msg.textContent = 'Generating AD…';
    if (btn) btn.disabled = true;
    try {
      const data = await api(`/social/posts/${postId}/image`, {
        method: 'POST',
        body: '{}',
      });
      const idx = state.posts.findIndex((p) => Number(p.id) === Number(postId));
      if (idx >= 0 && data.post) {
        state.posts[idx] = Object.assign({}, state.posts[idx], data.post, {
          image_url: data.image_url || data.post.image_url,
          with_image: true,
        });
      } else if (idx >= 0 && data.image_url) {
        state.posts[idx] = Object.assign({}, state.posts[idx], {
          image_url: data.image_url,
          with_image: true,
        });
      }
      if (data.included_in_plan) state.socialImagesIncluded = true;
      else if (data.price_usd != null) state.imagePriceUsd = Number(data.price_usd);
      if (data.credits_balance != null) state.creditsBalance = Number(data.credits_balance);
      renderPostPage();
      msg.className = 'msg ok';
      const charged = Number(data.credits_charged || 0);
      msg.textContent = data.included_in_plan || charged === 0
        ? 'Branded image ready — included in your plan.'
        : `Branded image ready. Used ${charged} credit${charged === 1 ? '' : 's'} (${state.creditsBalance} left).`;
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
      if (btn) btn.disabled = false;
    }
  }

  function renderCalendar(cal) {
    state.year = cal.year;
    state.month = cal.month;
    state.posts = Array.isArray(cal.posts) ? cal.posts.slice() : [];
    state.page = 1;
    if (cal.image_price_usd != null && Number.isFinite(Number(cal.image_price_usd))) {
      state.imagePriceUsd = Number(cal.image_price_usd);
    }
    if (cal.image_credits != null) state.imageCredits = Math.max(0, Number(cal.image_credits) || 0);
    if (cal.content_credits != null) state.contentCredits = Math.max(0, Number(cal.content_credits) || 0);
    if (cal.credits_balance != null) state.creditsBalance = Math.max(0, Number(cal.credits_balance) || 0);
    if (cal.credits_pack_label) state.creditsPackLabel = String(cal.credits_pack_label);
    state.creditsConfigured = !!cal.credits_configured;
    state.socialImagesIncluded = !!cal.social_images_included;
    const label = new Date(Date.UTC(cal.year, cal.month - 1, 1))
      .toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    document.getElementById('cal-label').textContent = label;
    document.getElementById('cal-lede').textContent = `${label} · ${state.posts.length} post(s)`;

    const priceHint = document.getElementById('image-price-hint');
    priceHint.hidden = false;
    if (state.socialImagesIncluded) {
      priceHint.textContent = `Branded image ads included in Premium · Balance: ${state.creditsBalance} credits (content still uses credits).`;
    } else {
      priceHint.textContent = `Balance: ${state.creditsBalance} credits · Images ${state.imageCredits}/ea · Content ${state.contentCredits}/generation. Buy packs in Billing.`;
    }

    const byDay = new Map();
    for (const p of state.posts) {
      const day = Number(String(p.scheduled_at || '').slice(8, 10));
      if (!day) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(p);
    }

    const first = new Date(Date.UTC(cal.year, cal.month - 1, 1));
    const startPad = first.getUTCDay(); // 0 Sun
    const total = daysInMonth(cal.year, cal.month);
    const heads = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .map((h) => `<div class="cal-head">${h}</div>`).join('');
    let cells = '';
    for (let i = 0; i < startPad; i += 1) cells += '<div class="cal-cell muted"></div>';
    for (let d = 1; d <= total; d += 1) {
      const posts = byDay.get(d) || [];
      const dots = posts.slice(0, 2).map((p) =>
        `<span class="dot" title="${esc(p.status)}">${esc((p.caption || '').slice(0, 28))}</span>`
      ).join('');
      const more = posts.length > 2 ? `<span class="dot">+${posts.length - 2}</span>` : '';
      cells += `<div class="cal-cell"><div class="d">${d}</div>${dots}${more}</div>`;
    }
    document.getElementById('cal-grid').innerHTML = heads + cells;
    renderPostPage();
  }

  async function loadCalendar() {
    const now = new Date();
    const data = await api(`/calendar?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`);
    renderCalendar(data);
  }

  function portalCheckoutFlag() {
    try {
      return new URLSearchParams(location.search).get('checkout') || '';
    } catch {
      return '';
    }
  }

  function clearPortalCheckoutQuery() {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has('checkout') && !url.searchParams.has('plan')) return;
      url.searchParams.delete('checkout');
      url.searchParams.delete('plan');
      history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch { /* ignore */ }
  }

  function renderPlanCards(b) {
    const grid = document.getElementById('bill-plan-grid');
    if (!grid) return;
    const currentPlan = String(b.plan || 'free');
    const canSelfServe = !!(b.canSelfServe != null ? b.canSelfServe : b.canManage);
    const selfSubscribed = !!(b.hasActiveSubscription
      || (currentPlan !== 'free' && ['active', 'trialing', 'past_due'].includes(String(b.subscriptionStatus || ''))));
    const cancelAtPeriodEnd = !!b.cancelAtPeriodEnd;
    const plans = Array.isArray(b.plans) && b.plans.length
      ? b.plans
      : [
        { id: 'free', name: 'Free', priceLabel: 'Free', tagline: 'Launch a site and edit it yourself.', features: [], checkout: false, priceConfigured: true },
        { id: 'standard', name: 'Standard', priceLabel: 'Monthly', tagline: 'Monthly support with pay-per-image social ads.', features: [], checkout: true, priceConfigured: false },
        { id: 'premium', name: 'Premium', priceLabel: 'Monthly', tagline: 'Weekly support with social images included.', features: [], checkout: true, priceConfigured: false },
      ];

    grid.innerHTML = plans.map((p) => {
      const isCurrent = p.id === currentPlan;
      let cta = '';
      if (!canSelfServe) {
        cta = isCurrent
          ? '<span class="hint">Current plan</span>'
          : '<span class="hint">Contact Bitpype to change plans</span>';
      } else if (p.id === 'free') {
        if (isCurrent && !selfSubscribed) {
          cta = '<span class="hint">Current plan</span>';
        } else if (cancelAtPeriodEnd && selfSubscribed) {
          cta = '<span class="hint">Cancels at period end</span>'
            + '<button class="btn ghost" type="button" data-resume-plan="1">Keep my plan</button>';
        } else if (selfSubscribed) {
          cta = '<button class="btn ghost" type="button" data-change-plan="free">Downgrade to Free</button>'
            + '<span class="hint">Keeps access until the period ends</span>';
        } else {
          cta = '<span class="hint">Current plan</span>';
        }
      } else if (isCurrent && selfSubscribed) {
        cta = cancelAtPeriodEnd
          ? '<span class="hint">Current — canceling at period end</span>'
            + '<button class="btn" type="button" data-resume-plan="1">Keep this plan</button>'
          : '<span class="hint">Current plan</span>';
      } else if (!p.priceConfigured) {
        cta = '<span class="hint">Price not configured yet</span>';
      } else if (!selfSubscribed) {
        cta = `<button class="btn" type="button" data-change-plan="${esc(p.id)}">Subscribe</button>`;
      } else if (p.id === 'premium' && currentPlan === 'standard') {
        cta = `<button class="btn" type="button" data-change-plan="premium">Upgrade to Premium</button>`;
      } else if (p.id === 'standard' && currentPlan === 'premium') {
        cta = `<button class="btn ghost" type="button" data-change-plan="standard">Switch to Standard</button>`;
      } else {
        cta = `<button class="btn" type="button" data-change-plan="${esc(p.id)}">Switch to ${esc(p.name)}</button>`;
      }
      const featuredNote = p.id === 'premium'
        ? '<p class="plan-tagline" style="color:var(--accent);font-weight:550">Social images included — no per-image charge.</p>'
        : '';
      return `<div class="plan-card${isCurrent ? ' is-current' : ''}${p.id === 'premium' ? ' is-featured' : ''}">
        <div class="plan-card-h">
          <h3>${esc(p.name)}</h3>
          <div class="plan-price">${esc(p.priceLabel || '')}</div>
        </div>
        <p class="plan-tagline">${esc(p.tagline || '')}</p>
        ${featuredNote}
        <ul class="plan-features">${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div class="plan-cta">${cta}</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('[data-change-plan]').forEach((btn) => {
      btn.onclick = () => startPortalChangePlan(btn.getAttribute('data-change-plan'));
    });
    grid.querySelectorAll('[data-resume-plan]').forEach((btn) => {
      btn.onclick = () => startPortalResume();
    });
  }

  function refStatusLabel(status) {
    const s = String(status || 'pending');
    if (s === 'credited') return 'Credited';
    if (s === 'signed_up') return 'Signed up';
    return 'Pending';
  }

  function renderReferrals(data) {
    const totals = (data && data.totals) || {};
    const math = (data && data.creditMath) || {};
    const earnedEl = document.getElementById('ref-earned');
    const potEl = document.getElementById('ref-potential');
    const noteEl = document.getElementById('ref-math-note');
    if (earnedEl) earnedEl.textContent = String(totals.earnedCredits != null ? totals.earnedCredits : 0);
    if (potEl) potEl.textContent = String(totals.estimatedPendingCredits != null ? totals.estimatedPendingCredits : 0);
    if (noteEl) noteEl.textContent = math.note || 'Earn ~10% of a referred client’s paid plan value as social credits.';

    const list = document.getElementById('ref-list');
    if (!list) return;
    const rows = (data && data.referrals) || [];
    if (!rows.length) {
      list.innerHTML = '<p class="hint" style="margin:0">No referrals yet — submit one above.</p>';
      return;
    }
    list.innerHTML = `<div style="overflow-x:auto"><table class="ref-table" style="width:100%;border-collapse:collapse;font-size:0.92rem">
      <thead><tr>
        <th style="text-align:left;padding:8px 6px;border-bottom:1px solid rgba(0,0,0,.08)">Contact</th>
        <th style="text-align:left;padding:8px 6px;border-bottom:1px solid rgba(0,0,0,.08)">Status</th>
        <th style="text-align:right;padding:8px 6px;border-bottom:1px solid rgba(0,0,0,.08)">Credits</th>
      </tr></thead>
      <tbody>${rows.map((r) => {
        const title = esc(r.businessName || r.name || r.email || 'Referral');
        const sub = [r.name && r.businessName ? r.name : '', r.email || '', r.phone || '']
          .filter(Boolean).map(esc).join(' · ');
        const credits = r.status === 'credited'
          ? String(r.creditsAwarded || 0)
          : `~${math.standardEstimateCredits != null ? math.standardEstimateCredits : '—'}`;
        return `<tr>
          <td style="padding:10px 6px;vertical-align:top;border-bottom:1px solid rgba(0,0,0,.06)">
            <strong>${title}</strong>${sub ? `<div class="hint" style="margin:4px 0 0">${sub}</div>` : ''}
          </td>
          <td style="padding:10px 6px;vertical-align:top;border-bottom:1px solid rgba(0,0,0,.06)">
            <span class="status-pill${r.status === 'credited' ? '' : (r.status === 'signed_up' ? ' warn' : '')}">${esc(refStatusLabel(r.status))}</span>
          </td>
          <td style="padding:10px 6px;vertical-align:top;text-align:right;border-bottom:1px solid rgba(0,0,0,.06)">${esc(credits)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  async function loadReferrals() {
    const data = await api('/referrals');
    renderReferrals(data);
    return data;
  }

  async function submitReferral() {
    const msg = document.getElementById('msg-referrals');
    const btn = document.getElementById('btn-ref-submit');
    if (msg) { msg.textContent = ''; msg.className = 'msg'; }
    if (btn) btn.disabled = true;
    try {
      const data = await api('/referrals', {
        method: 'POST',
        body: JSON.stringify({
          name: (document.getElementById('ref-name') || {}).value || '',
          email: (document.getElementById('ref-email') || {}).value || '',
          phone: (document.getElementById('ref-phone') || {}).value || '',
          businessName: (document.getElementById('ref-business') || {}).value || '',
        }),
      });
      ['ref-name', 'ref-email', 'ref-phone', 'ref-business'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      renderReferrals(data);
      if (msg) {
        msg.textContent = 'Referral submitted.';
        msg.className = 'msg ok';
      }
    } catch (e) {
      if (msg) {
        msg.textContent = e.message || String(e);
        msg.className = 'msg err';
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  const btnRefSubmit = document.getElementById('btn-ref-submit');
  if (btnRefSubmit) btnRefSubmit.onclick = () => { submitReferral().catch(() => {}); };

  async function loadBilling() {
    const b = await api('/billing');
    const pill = document.getElementById('bill-status');
    const planId = String(b.plan || 'free');
    const status = String(b.subscriptionStatus || (planId === 'free' ? 'free' : 'none'));
    const planName = b.planName || (planId.charAt(0).toUpperCase() + planId.slice(1));
    pill.textContent = status === 'trialing' ? 'Trialing'
      : status === 'past_due' ? 'Past due'
      : status === 'active' || b.workspaceSubscribed ? 'Active'
      : planId === 'free' ? 'Free' : status;
    pill.className = 'status-pill'
      + (status === 'past_due' ? ' warn' : '')
      + (status === 'canceled' ? ' bad' : '');
    const planEl = document.getElementById('bill-plan-name');
    if (planEl) planEl.textContent = planName + ' plan';

    const end = b.currentPeriodEnd
      ? new Date(String(b.currentPeriodEnd).replace(' ', 'T') + (String(b.currentPeriodEnd).includes('Z') ? '' : 'Z'))
      : null;
    const endLabel = end && Number.isFinite(end.getTime())
      ? end.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
      : '';
    document.getElementById('bill-renewal').textContent = b.cancelAtPeriodEnd && endLabel
      ? `Access continues until ${endLabel}, then you move to Free.`
      : endLabel
        ? `Renews / period ends ${endLabel}.`
        : (planId === 'free'
          ? 'You’re on Free — upgrade anytime for support. Premium includes social images.'
          : 'Your service is currently covered.');
    const noticeEl = document.getElementById('bill-notice');
    noticeEl.textContent = b.notice || '';
    noticeEl.hidden = !b.notice;

    const banner = document.getElementById('bill-checkout-banner');
    const flag = portalCheckoutFlag();
    if (banner) {
      if (flag === 'success') {
        banner.hidden = false;
        banner.className = 'bill-alert ok';
        banner.innerHTML = '<strong>Payment received.</strong> Plan updates when Stripe confirms.';
        clearPortalCheckoutQuery();
      } else if (flag === 'credits_success') {
        banner.hidden = false;
        banner.className = 'bill-alert ok';
        banner.innerHTML = '<strong>Credits payment received.</strong> Balance updates when Stripe confirms.';
        clearPortalCheckoutQuery();
      } else if (flag === 'cancel') {
        banner.hidden = false;
        banner.className = 'bill-alert warn';
        banner.textContent = 'Checkout canceled — no charge was made.';
        clearPortalCheckoutQuery();
      } else {
        banner.hidden = true;
        banner.textContent = '';
      }
    }

    const manage = document.getElementById('btn-manage-billing');
    const canSelfServe = !!(b.canSelfServe != null ? b.canSelfServe : b.canManage);
    if (manage) manage.hidden = !(canSelfServe && b.hasCustomer);

    const credits = b.credits || {};
    state.creditsBalance = Number(credits.balance || 0);
    state.creditsConfigured = !!credits.priceConfigured;
    state.creditsPackLabel = credits.packLabel || state.creditsPackLabel;
    state.imageCredits = Number(credits.perSocialImage != null ? credits.perSocialImage : state.imageCredits);
    state.contentCredits = Number(credits.perSocialContent != null ? credits.perSocialContent : state.contentCredits);
    const balEl = document.getElementById('bill-credits-balance');
    if (balEl) balEl.textContent = `Balance: ${state.creditsBalance} credits`;
    const ratesEl = document.getElementById('bill-credits-rates');
    if (ratesEl) {
      ratesEl.textContent = `Pack: ${credits.packLabel || '—'} · Image ${state.imageCredits} credit(s) · Content ${state.contentCredits} credit(s)`;
    }
    const buyBtn = document.getElementById('btn-buy-credits');
    if (buyBtn) {
      buyBtn.hidden = !(canSelfServe && state.creditsConfigured);
      buyBtn.textContent = `Buy ${credits.packLabel || 'credits'}`;
    }

    state.entitlements = b.entitlements || {};
    state.plan = b.plan || 'free';
    renderPlanCards(b);
    syncMcpPlanAccess(planId);
  }

  const mcpEndpoint = () => `${window.location.origin}/mcp`;
  let mcpLastToken = '';

  function mcpCursorSnippet(endpoint, tokenPlaceholder) {
    return JSON.stringify({
      mcpServers: {
        'website-scout': {
          url: endpoint,
          headers: { Authorization: 'Bearer ' + tokenPlaceholder },
        },
      },
    }, null, 2);
  }

  function fmtMcpDate(v) {
    if (!v) return '—';
    return String(v).replace('T', ' ').slice(0, 16);
  }

  function initMcpEndpointUi() {
    const ep = mcpEndpoint();
    const pre = document.getElementById('mcp-snippet');
    const label = document.getElementById('mcp-endpoint-label');
    if (pre) pre.textContent = mcpCursorSnippet(ep, '<YOUR_MCP_TOKEN>');
    if (label) label.textContent = ep;
  }

  function syncMcpPlanAccess(planId) {
    const paid = planId === 'standard' || planId === 'premium';
    state.mcpPaid = paid;
    const nav = document.getElementById('nav-mcp');
    if (nav) nav.hidden = !paid;
    const upgrade = document.getElementById('mcp-upgrade');
    const app = document.getElementById('mcp-app');
    if (paid) {
      if (upgrade) upgrade.hidden = true;
      if (app) app.hidden = false;
      refreshMcpTokens().catch(() => {});
    } else {
      if (upgrade) upgrade.hidden = false;
      if (app) app.hidden = true;
    }
  }

  async function refreshMcpTokens() {
    const tbody = document.getElementById('mcp-tokens-body');
    const heading = document.getElementById('mcp-tokens-heading');
    if (!tbody || !state.mcpPaid) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Loading…</td></tr>';
    try {
      const data = await api('/mcp/tokens');
      const tokens = data.tokens || [];
      if (heading) heading.textContent = `Your MCP tokens (${tokens.length})`;
      tbody.innerHTML = tokens.map((t) => `
        <tr>
          <td>${esc(t.name || '')}</td>
          <td class="mono">${esc(t.token_prefix || '')}…</td>
          <td>${esc(fmtMcpDate(t.last_used_at))}</td>
          <td>${esc(fmtMcpDate(t.created_at))}</td>
          <td><button type="button" class="btn ghost small" data-mcp-revoke="${t.id}" style="color:var(--err)">Revoke</button></td>
        </tr>`).join('')
        || '<tr><td colspan="5" class="empty-cell">No tokens yet. Create one to connect your agent.</td></tr>';
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">${esc(e.message)}</td></tr>`;
    }
  }

  let formState = {
    fields: [],
    entitlements: {},
    plan: 'free',
    forms: [],
    pages: [],
    editingId: null,
    current: null,
    currentEmbed: null,
  };

  function renderFormFieldsEditor() {
    const box = document.getElementById('form-fields-editor');
    if (!box) return;
    if (!formState.fields.length) {
      box.innerHTML = '<p class="hint">No fields yet.</p>';
      return;
    }
    box.innerHTML = formState.fields.map((f, i) => `
      <div class="row" data-field-i="${i}" style="gap:8px;flex-wrap:wrap;margin:0 0 8px;align-items:flex-end">
        <div class="field" style="flex:1;min-width:120px;margin:0">
          <label>Label</label>
          <input data-fk="label" value="${esc(f.label || '')}" />
        </div>
        <div class="field" style="width:110px;margin:0">
          <label>Type</label>
          <select data-fk="field_type">
            ${['text', 'email', 'tel', 'textarea', 'select', 'checkbox', 'number', 'url'].map((t) =>
              `<option value="${t}"${f.field_type === t ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <label class="hint" style="display:flex;align-items:center;gap:4px;margin-bottom:8px">
          <input type="checkbox" data-fk="required"${f.required ? ' checked' : ''} /> Required
        </label>
        <button type="button" class="btn ghost small" data-fk="remove">Remove</button>
      </div>`).join('');
  }

  function collectFormFieldsFromEditor() {
    const box = document.getElementById('form-fields-editor');
    if (!box) return formState.fields;
    const rows = [...box.querySelectorAll('[data-field-i]')];
    return rows.map((row, i) => {
      const prev = formState.fields[i] || {};
      return {
        field_key: prev.field_key || '',
        label: (row.querySelector('[data-fk="label"]') || {}).value || prev.label || 'Field',
        field_type: (row.querySelector('[data-fk="field_type"]') || {}).value || 'text',
        required: !!(row.querySelector('[data-fk="required"]') || {}).checked,
        placeholder: prev.placeholder || '',
        options: prev.options || null,
        sort_order: i,
      };
    });
  }

  function fillPageSelect(pages, selected) {
    const sel = document.getElementById('form-target-page');
    if (!sel) return;
    const list = Array.isArray(pages) && pages.length
      ? pages
      : [{ slug: 'contact', title: 'Contact' }, { slug: 'home', title: 'Home' }, { slug: 'about', title: 'About' }];
    const want = String(selected || 'contact');
    const slugs = new Set(list.map((p) => String(p.slug)));
    if (!slugs.has('contact')) list.unshift({ slug: 'contact', title: 'Contact' });
    sel.innerHTML = list.map((p) => {
      const slug = esc(p.slug);
      const label = esc(p.title || p.slug);
      return `<option value="${slug}"${String(p.slug) === want ? ' selected' : ''}>${label}</option>`;
    }).join('');
  }

  function showFormsList() {
    formState.editingId = null;
    formState.current = null;
    const listPanel = document.getElementById('forms-list-panel');
    const editor = document.getElementById('forms-editor-panel');
    if (listPanel) listPanel.hidden = false;
    if (editor) editor.hidden = true;
  }

  function showFormEditor() {
    const listPanel = document.getElementById('forms-list-panel');
    const editor = document.getElementById('forms-editor-panel');
    if (listPanel) listPanel.hidden = true;
    if (editor) editor.hidden = false;
    setFormsPane('setup');
  }

  function formLocationLabel(form) {
    const attached = form.embed_enabled !== false && form.embed_on_page !== false;
    if (!attached) return 'Embed URL only';
    const slug = String(form.target_page_slug || 'contact').trim() || 'contact';
    const nice = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return `On the ${nice} page`;
  }

  function renderFormsList() {
    const box = document.getElementById('forms-list');
    if (!box) return;
    const items = formState.forms || [];
    if (!items.length) {
      box.innerHTML = '<p class="hint">No forms yet. Click New form to create one.</p>';
      return;
    }
    box.classList.add('item-list');
    box.innerHTML = items.map((entry) => {
      const f = entry.form || entry;
      const status = f.published ? 'published' : 'draft';
      const pillClass = f.published ? 'status-pill' : 'status-pill draft';
      const kind = f.form_kind ? String(f.form_kind) : '';
      const place = formLocationLabel(f);
      return `<article class="item-card">
        <span class="item-card-mark" aria-hidden="true"></span>
        <div class="item-card-main">
          <p class="item-card-kicker">Form</p>
          <h3 class="item-card-title">${esc(f.name || f.title || 'Form')}</h3>
          <div class="item-card-meta">
            <span class="${pillClass}">${esc(status)}</span>
            ${kind ? `<span class="sep">·</span><span>${esc(kind)}</span>` : ''}
            <span class="sep">·</span>
            <span>${esc(place)}</span>
          </div>
        </div>
        <div class="item-card-actions">
          <button type="button" class="btn soft small" data-edit-form="${f.id}">Edit</button>
        </div>
      </article>`;
    }).join('');
    box.querySelectorAll('[data-edit-form]').forEach((btn) => {
      btn.onclick = () => openFormEditor(Number(btn.getAttribute('data-edit-form')));
    });
  }

  function applyFormToEditor(form, embed) {
    formState.current = form;
    formState.editingId = form.id;
    formState.currentEmbed = embed || null;
    formState.fields = Array.isArray(form.fields) ? form.fields.slice() : [];
    const nameEl = document.getElementById('form-name');
    if (nameEl) nameEl.value = form.name || form.title || '';
    document.getElementById('form-title').value = form.title || '';
    document.getElementById('form-intro').value = form.intro || '';
    document.getElementById('form-submit-label').value = form.submit_label || 'Send Message';
    document.getElementById('form-notify').value = form.notify_email || '';
    document.getElementById('form-success').value = form.success_message || '';
    const embedCb = document.getElementById('form-embed-on-page');
    if (embedCb) embedCb.checked = form.embed_enabled !== false && form.embed_on_page !== false;
    const navCb = document.getElementById('form-add-to-nav');
    if (navCb) navCb.checked = !!(form.add_to_nav || form.nav_visible);
    fillPageSelect(formState.pages, form.target_page_slug || 'contact');
    renderFormFieldsEditor();
    const embedTa = document.getElementById('form-embed-code');
    const hint = document.getElementById('form-embed-hint');
    const onPage = form.embed_enabled !== false && form.embed_on_page !== false;
    if (embed && embed.html) {
      embedTa.hidden = false;
      embedTa.value = embed.html;
      hint.textContent = form.published
        ? (onPage
          ? `Published on your ${form.target_page_slug || 'contact'} page · ${embed.url || ''}`
          : `Published (embed URL only) · ${embed.url || ''}`)
        : 'Save and publish to get an embed snippet.';
    } else {
      embedTa.hidden = true;
      hint.textContent = onPage
        ? 'Publish to show this form on the selected site page (and get an embed URL).'
        : 'Publish to get an embed URL (not added to a site page).';
    }
    showFormEditor();
  }

  async function openFormEditor(formId) {
    const data = await api(`/forms/${formId}`);
    if (data.pages) formState.pages = data.pages;
    applyFormToEditor(data.form || {}, data.embed);
  }

  async function loadFormSubmissions() {
    const sub = await api('/forms/submissions');
    formState.plan = sub.plan || 'free';
    const notice = document.getElementById('form-inbox-notice');
    const list = document.getElementById('form-submissions');
    if (!sub.inbox) {
      notice.textContent = sub.notice || 'Submissions are emailed only on Free.';
      list.innerHTML = '';
    } else {
      notice.textContent = `${(sub.submissions || []).length} recent submission(s).`;
      list.innerHTML = (sub.submissions || []).length
        ? (sub.submissions || []).map((s) => {
          const payload = s.payload || {};
          const preview = Object.entries(payload).slice(0, 3)
            .map(([k, v]) => `${esc(k)}: ${esc(String(v).slice(0, 80))}`).join(' · ');
          return `<article class="post-card" style="margin-bottom:8px">
            <div class="post-body">
              <div class="post-meta">
                <span>${esc(String(s.created_at || '').replace('T', ' ').slice(0, 16))}</span>
                <span class="status-pill">${esc(s.routing || '')}</span>
                ${s.form_id != null ? `<span class="hint">form #${esc(String(s.form_id))}</span>` : ''}
                ${s.encrypted ? '<span class="hint">encrypted</span>' : ''}
              </div>
              <p class="post-cap">${preview || '(empty)'}</p>
            </div>
          </article>`;
        }).join('')
        : '<p class="hint">No submissions yet.</p>';
    }
  }

  async function loadForms() {
    const data = await api('/forms');
    formState.forms = Array.isArray(data.forms) ? data.forms : (data.form ? [{ form: data.form, embed: data.embed }] : []);
    formState.pages = Array.isArray(data.pages) ? data.pages : [];
    renderFormsList();
    if (formState.editingId) {
      const match = formState.forms.find((e) => (e.form || e).id === formState.editingId);
      if (match) applyFormToEditor(match.form || match, match.embed);
      else showFormsList();
    } else {
      showFormsList();
    }
    await loadFormSubmissions();
  }

  async function loadSocialAccounts() {
    const msg = document.getElementById('msg-meta');
    const list = document.getElementById('social-accounts-list');
    const hint = document.getElementById('social-accounts-hint');
    try {
      const data = await api('/social/accounts');
      const accounts = (data && data.accounts) || [];
      if (!data.metaConfigured) {
        hint.textContent = 'Meta is not configured yet — ask Bitpype to set meta.app_id / meta.app_secret.';
      } else {
        hint.textContent = accounts.length
          ? 'Connected accounts for automatic scheduling.'
          : 'Connect a Facebook Page (Instagram Business linked) to schedule posts.';
      }
      list.innerHTML = accounts.length
        ? accounts.map((a) => `
          <div class="row" style="justify-content:space-between;margin:6px 0;gap:8px;flex-wrap:wrap">
            <span><strong>${esc(a.platform)}</strong> · ${esc(a.account_name || a.account_id || '')}
              <span class="status-pill">${esc(a.status || '')}</span></span>
            <button type="button" class="btn ghost small" data-disconnect="${esc(a.id)}">Disconnect</button>
          </div>`).join('')
        : '<p class="hint">No accounts connected.</p>';
      if (msg && /connected=1/.test(location.search)) {
        msg.className = 'msg ok';
        msg.textContent = 'Meta connected.';
      }
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = e.message;
      }
    }
  }

  const MODULE_TYPES = [
    { type: 'blog', label: 'Blog' },
    { type: 'ecommerce', label: 'Shop' },
    { type: 'courses', label: 'Courses' },
    { type: 'gallery', label: 'Gallery' },
    { type: 'directory', label: 'Directory' },
    { type: 'faq', label: 'FAQ' },
    { type: 'testimonials', label: 'Testimonials' },
    { type: 'team', label: 'Team' },
    { type: 'events', label: 'Events' },
    { type: 'bookings', label: 'Bookings' },
    { type: 'chatbot', label: 'Chatbot' },
  ];
  const MODULE_NAV_GROUPS = [
    { id: 'content', label: 'Content', types: ['blog', 'ecommerce', 'gallery', 'courses', 'directory', 'faq'] },
    { id: 'people', label: 'People', types: ['team', 'testimonials'] },
    { id: 'schedule', label: 'Schedule', types: ['events', 'bookings'] },
    { id: 'assist', label: 'Assist', types: ['chatbot'] },
  ];
  const MODULE_ITEM_COPY = {
    blog: { singular: 'post', plural: 'posts', newBtn: 'New post', kicker: 'Blog post' },
    ecommerce: { singular: 'product', plural: 'products', newBtn: 'New product', kicker: 'Product' },
    courses: { singular: 'course', plural: 'courses', newBtn: 'New course', kicker: 'Course' },
    gallery: { singular: 'album', plural: 'albums', newBtn: 'New album', kicker: 'Gallery album' },
    directory: { singular: 'listing', plural: 'listings', newBtn: 'New listing', kicker: 'Listing' },
    faq: { singular: 'question', plural: 'questions', newBtn: 'New question', kicker: 'FAQ' },
    testimonials: { singular: 'testimonial', plural: 'testimonials', newBtn: 'New testimonial', kicker: 'Testimonial' },
    team: { singular: 'member', plural: 'team members', newBtn: 'New team member', kicker: 'Team' },
    events: { singular: 'event', plural: 'events', newBtn: 'New event', kicker: 'Event' },
    bookings: { singular: 'service', plural: 'services', newBtn: 'New service', kicker: 'Booking service' },
    chatbot: { singular: 'knowledge item', plural: 'knowledge items', newBtn: 'Add knowledge', kicker: 'Knowledge' },
  };
  const BOOKING_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MODULE_STORAGE_KEY = 'bp-portal-module';

  function moduleCopy(type) {
    return MODULE_ITEM_COPY[type] || { singular: 'item', plural: 'items', newBtn: 'New item', kicker: 'Item' };
  }

  function readStoredModuleType() {
    try {
      const v = String(sessionStorage.getItem(MODULE_STORAGE_KEY) || '').trim();
      if (MODULE_TYPES.some((m) => m.type === v)) return v;
    } catch { /* ignore */ }
    return '';
  }

  function storeModuleType(type) {
    try { sessionStorage.setItem(MODULE_STORAGE_KEY, String(type || '')); } catch { /* ignore */ }
  }

  let moduleState = {
    enabled: false,
    plan: 'free',
    current: readStoredModuleType() || 'blog',
    pane: 'content',
    summary: null,
    items: [],
    pages: [],
    embed: null,
    editingId: null,
    showArchivedAppointments: false,
  };

  let formsPane = 'setup';

  function moduleMsg(text, ok) {
    const el = document.getElementById('msg-modules');
    if (!el) return;
    el.className = ok ? 'msg ok' : (text ? 'msg err' : 'msg');
    el.textContent = text || '';
  }

  function moduleFieldDefs(type) {
    if (type === 'blog') {
      return [
        { key: 'title', label: 'Title', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'cover_image', label: 'Cover photo', kind: 'image' },
        { key: 'excerpt', label: 'Excerpt (optional — auto from body if empty)', kind: 'textarea' },
        { key: 'body_html', label: 'Body (HTML)', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'ecommerce') {
      return [
        { key: 'name', label: 'Name', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'price', label: 'Price (e.g. 29.99)' },
        { key: 'currency', label: 'Currency', placeholder: 'USD' },
        { key: 'image_url', label: 'Product photo', kind: 'image' },
        { key: 'checkout_url', label: 'Checkout / buy URL' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'courses') {
      return [
        { key: 'title', label: 'Title', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'cover_image', label: 'Cover photo', kind: 'image' },
        { key: 'enrollment_url', label: 'Enrollment URL' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'gallery') {
      return [
        { key: 'title', label: 'Album title', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
        { key: 'image_url', label: 'First photo (optional)', kind: 'image' },
      ];
    }
    if (type === 'faq') {
      return [
        { key: 'question', label: 'Question', required: true },
        { key: 'answer_html', label: 'Answer (HTML)', kind: 'textarea' },
        { key: 'category', label: 'Category' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'testimonials') {
      return [
        { key: 'quote', label: 'Quote', kind: 'textarea', required: true },
        { key: 'author_name', label: 'Author name' },
        { key: 'author_title', label: 'Author title / role' },
        { key: 'author_company', label: 'Company' },
        { key: 'rating', label: 'Rating (1–5)' },
        { key: 'image_url', label: 'Author photo', kind: 'image' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'team') {
      return [
        { key: 'name', label: 'Name', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'role_title', label: 'Role / title' },
        { key: 'bio', label: 'Bio', kind: 'textarea' },
        { key: 'image_url', label: 'Headshot', kind: 'image' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
        { key: 'social_url', label: 'Profile link' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'events') {
      return [
        { key: 'title', label: 'Title', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'starts_at', label: 'Starts (YYYY-MM-DD or datetime)' },
        { key: 'ends_at', label: 'Ends (optional)' },
        { key: 'location', label: 'Location' },
        { key: 'image_url', label: 'Event photo', kind: 'image' },
        { key: 'ticket_url', label: 'Tickets / RSVP URL' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'bookings') {
      return [
        { key: 'name', label: 'Service name', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'duration_minutes', label: 'Duration (minutes)', placeholder: '30' },
        { key: 'buffer_minutes', label: 'Buffer between bookings (minutes)' },
        { key: 'price', label: 'Price (optional, e.g. 49)' },
        { key: 'currency', label: 'Currency', placeholder: 'USD' },
        { key: 'image_url', label: 'Service photo', kind: 'image' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'chatbot') {
      return [
        { key: 'kind', label: 'Type', kind: 'select', options: ['link', 'doc'] },
        { key: 'title', label: 'Title (optional if uploading files)' },
        { key: 'url', label: 'Website URL (for links)' },
        {
          key: 'files',
          label: 'Upload files (PDF, Word, Excel, PowerPoint, images, text)',
          kind: 'files',
          accept: '.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.html,.htm,.json',
          hint: 'Select one or more files. We extract searchable text (OCR for images) for the chat agent. Max 5MB each.',
        },
        { key: 'content_text', label: 'Notes / pasted text for the agent', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['active', 'inactive'] },
      ];
    }
    // directory fallback
    return [
      { key: 'name', label: 'Name', required: true },
      { key: 'category', label: 'Category' },
      { key: 'contact_email', label: 'Email' },
      { key: 'contact_phone', label: 'Phone' },
      { key: 'website_url', label: 'Website / link' },
      { key: 'image_url', label: 'Photo', kind: 'image' },
      { key: 'description', label: 'Description', kind: 'textarea' },
      { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
    ];
  }

  function renderModuleTypeTabs() {
    const box = document.getElementById('modules-type-tabs');
    if (!box) return;
    const byType = new Map(MODULE_TYPES.map((m) => [m.type, m]));
    const summaryList = (moduleState.summary && moduleState.summary.modules) || [];
    box.innerHTML = MODULE_NAV_GROUPS.map((group) => {
      const rows = group.types.map((type) => {
        const meta = byType.get(type);
        if (!meta) return '';
        const summary = summaryList.find((x) => x.type === type);
        const count = summary ? summary.count : 0;
        const emb = summary && summary.embed;
        const live = !!(emb && emb.published && emb.embed_enabled);
        const sel = type === moduleState.current;
        return `<button type="button" class="module-tab${sel ? ' is-active' : ''}" data-module-type="${esc(type)}" role="tab" aria-selected="${sel ? 'true' : 'false'}">
          <span class="module-tab-label">${esc(meta.label)}</span>
          <span class="module-tab-meta">
            ${live ? '<span class="module-tab-live" title="On your site" aria-label="On your site"></span>' : ''}
            <span class="module-tab-count">${count}</span>
          </span>
        </button>`;
      }).join('');
      return `<div class="modules-side-group">${esc(group.label)}</div>${rows}`;
    }).join('');
  }

  function syncModulesPaneTabs() {
    const tabs = document.getElementById('modules-pane-tabs');
    const content = document.getElementById('modules-pane-content');
    const hoursPane = document.getElementById('modules-pane-hours');
    const apptsPane = document.getElementById('modules-pane-appointments');
    const chatSettingsPane = document.getElementById('modules-pane-chat-settings');
    const chatInboxPane = document.getElementById('modules-pane-chat-inbox');
    const results = document.getElementById('modules-pane-results');
    const bookingPanel = document.getElementById('modules-booking-panel');
    const isBookings = moduleState.current === 'bookings';
    const isChatbot = moduleState.current === 'chatbot';
    const showTabs = isBookings || isChatbot;
    if (isBookings) {
      const allowed = new Set(['content', 'hours', 'appointments']);
      if (!allowed.has(moduleState.pane)) moduleState.pane = 'content';
    } else if (isChatbot) {
      const allowed = new Set(['content', 'settings', 'inbox']);
      if (!allowed.has(moduleState.pane)) moduleState.pane = 'content';
    } else {
      moduleState.pane = 'content';
    }
    if (tabs) {
      tabs.hidden = !showTabs;
      tabs.setAttribute('aria-hidden', showTabs ? 'false' : 'true');
      tabs.setAttribute('aria-label', isChatbot ? 'Chatbot sections' : 'Bookings sections');
      tabs.querySelectorAll('[data-modules-pane]').forEach((btn) => {
        const pane = btn.getAttribute('data-modules-pane');
        const forBookings = ['content', 'hours', 'appointments'].includes(pane);
        const forChat = ['content', 'settings', 'inbox'].includes(pane);
        const visible = isBookings ? forBookings
          : isChatbot ? forChat : false;
        // Toggle booking vs chatbot tab buttons via data-for attribute when present.
        const forAttr = btn.getAttribute('data-for');
        const showBtn = forAttr
          ? (isBookings && forAttr === 'bookings') || (isChatbot && forAttr === 'chatbot')
            || (forAttr === 'both' && showTabs)
          : visible;
        btn.hidden = !showBtn;
        if (pane === 'content' && showBtn) {
          btn.textContent = isChatbot ? 'Knowledge' : 'Services';
        }
        const on = pane === moduleState.pane && showBtn;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    if (content) {
      content.hidden = showTabs && moduleState.pane !== 'content';
    }
    if (hoursPane) hoursPane.hidden = !(isBookings && moduleState.pane === 'hours');
    if (apptsPane) apptsPane.hidden = !(isBookings && moduleState.pane === 'appointments');
    if (chatSettingsPane) chatSettingsPane.hidden = !(isChatbot && moduleState.pane === 'settings');
    if (chatInboxPane) chatInboxPane.hidden = !(isChatbot && moduleState.pane === 'inbox');
    if (results) results.hidden = true;
    if (bookingPanel) bookingPanel.hidden = true;
    if (isChatbot && moduleState.pane === 'settings') renderChatbotSettingsPanel();
    if (isChatbot && moduleState.pane === 'inbox') renderChatbotInboxPanel();
  }

  function setFormsPane(pane) {
    formsPane = pane === 'results' ? 'results' : 'setup';
    const setup = document.getElementById('forms-pane-setup');
    const results = document.getElementById('forms-pane-results');
    const tabs = document.getElementById('forms-pane-tabs');
    if (setup) setup.hidden = formsPane !== 'setup';
    if (results) results.hidden = formsPane !== 'results';
    if (tabs) {
      tabs.querySelectorAll('[data-forms-pane]').forEach((btn) => {
        const on = btn.getAttribute('data-forms-pane') === formsPane;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
  }

  function updateModuleContentChrome() {
    const copy = moduleCopy(moduleState.current);
    const meta = MODULE_TYPES.find((m) => m.type === moduleState.current);
    const sub = document.getElementById('modules-items-sub');
    if (sub) sub.textContent = `Manage ${copy.plural} for your ${(meta && meta.label) || 'module'}.`;
    const newBtn = document.getElementById('btn-modules-new');
    if (newBtn) newBtn.textContent = copy.newBtn;
  }

  function fillModulePageSelect(pages, selected) {
    const sel = document.getElementById('modules-target-page');
    if (!sel) return;
    const defaults = {
      blog: 'blog', ecommerce: 'shop', courses: 'courses', gallery: 'gallery', directory: 'directory',
      faq: 'faq', testimonials: 'testimonials', team: 'team', events: 'events', bookings: 'book',
    };
    const want = selected || defaults[moduleState.current] || 'home';
    const opts = Array.isArray(pages) && pages.length
      ? pages
      : [{ slug: want, title: want }];
    const slugs = new Set(opts.map((p) => p.slug));
    if (!slugs.has(want)) opts.unshift({ slug: want, title: want });
    sel.innerHTML = opts.map((p) =>
      `<option value="${esc(p.slug)}"${p.slug === want ? ' selected' : ''}>${esc(p.title || p.slug)}</option>`
    ).join('');
  }

  function renderModuleEmbedBar() {
    const label = document.getElementById('modules-current-label');
    const status = document.getElementById('modules-embed-status');
    const urlEl = document.getElementById('modules-embed-url');
    const bar = document.getElementById('modules-embed-bar');
    const meta = MODULE_TYPES.find((m) => m.type === moduleState.current);
    if (label) label.textContent = meta ? meta.label : moduleState.current;
    const emb = moduleState.embed;
    const onSite = !!(emb && emb.published && emb.embed_enabled);
    if (bar) bar.classList.toggle('is-on-site', onSite);
    const pageLabel = document.querySelector('#modules-embed-bar label.hint');
    const isChatbot = moduleState.current === 'chatbot';
    if (pageLabel) pageLabel.hidden = isChatbot;
    if (status) {
      if (isChatbot) {
        status.innerHTML = onSite
          ? '<span class="status-pill">Live</span> Floating chat bubble on all published pages. Agent replies via your portal MCP token (chatbot.* only — not admin tools).'
          : 'Not on your site yet — click <strong>Add to site</strong> to place the chat bubble on every page.';
      } else {
        status.innerHTML = onSite
          ? `<span class="status-pill">Live</span> Showing on page “${esc(emb.target_page_slug || '—')}”`
          : 'Not on your site yet — pick a page and click <strong>Add to site</strong>.';
      }
    }
    if (urlEl) {
      urlEl.innerHTML = emb && emb.embed_url
        ? `<details class="modules-embed-details"><summary>Embed link (for custom pages)</summary><code>${esc(emb.embed_url)}</code></details>`
        : '';
    }
    fillModulePageSelect(moduleState.pages, emb && emb.target_page_slug);
    updateModuleContentChrome();
  }

  function renderChatbotSettingsPanel() {
    const host = document.getElementById('modules-chat-settings-panel');
    if (!host) return;
    const chat = moduleState.chatbot || {};
    const s = chat.settings || {};
    const boundary = chat.agent_boundary || {};
    host.innerHTML = `
      <div class="row" style="justify-content:flex-start;margin-bottom:12px">
        <button type="button" class="btn ghost small" id="btn-chat-settings-back">← Knowledge</button>
      </div>
      <h3>Chatbot settings</h3>
      <p class="hint">Visitor messages notify your <strong>client MCP agent</strong> (chatbot.pending / chatbot.reply). Do not use admin workspace tools for chat.</p>
      <div class="field"><label>Greeting</label><input id="chat-set-greeting" type="text" value="${esc(s.greeting || '')}" /></div>
      <div class="field"><label>Bubble label</label><input id="chat-set-label" type="text" value="${esc(s.bubble_label || 'Chat')}" /></div>
      <div class="field"><label>Accent color (optional #hex)</label><input id="chat-set-color" type="text" value="${esc(s.primary_color || '')}" placeholder="#0e7a68" /></div>
      <div class="field"><label>Position</label>
        <select id="chat-set-position">
          <option value="bottom-right"${s.position !== 'bottom-left' ? ' selected' : ''}>Bottom right</option>
          <option value="bottom-left"${s.position === 'bottom-left' ? ' selected' : ''}>Bottom left</option>
        </select>
      </div>
      <div class="field"><label>Escalate notify email (optional)</label><input id="chat-set-email" type="email" value="${esc(s.escalate_email || '')}" /></div>
      <label class="hint" style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <input type="checkbox" id="chat-set-portal" ${s.escalate_notify_portal !== false ? 'checked' : ''} />
        Show escalations in portal inbox
      </label>
      <label class="hint" style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <input type="checkbox" id="chat-set-lead" ${s.suggest_lead_capture !== false ? 'checked' : ''} />
        Suggest lead capture when agent is unsure / slow
      </label>
      <div class="field"><label>Wait hint (seconds)</label><input id="chat-set-timeout" type="number" min="15" max="600" value="${esc(s.agent_timeout_hint_sec != null ? s.agent_timeout_hint_sec : 90)}" /></div>
      <p class="hint" style="margin-top:10px">${esc(boundary.forbidden || 'Client MCP only — no workspace ws_ admin tokens for chat sessions.')}</p>
      <button type="button" class="btn" id="btn-chat-settings-save">Save chatbot settings</button>
      <p class="msg" id="msg-chat-settings"></p>`;
    const backBtn = document.getElementById('btn-chat-settings-back');
    if (backBtn) {
      backBtn.onclick = () => {
        moduleState.pane = 'content';
        syncModulesPaneTabs();
      };
    }
    const btn = document.getElementById('btn-chat-settings-save');
    if (btn) {
      btn.onclick = async () => {
        const msg = document.getElementById('msg-chat-settings');
        try {
          const data = await api('/modules/chatbot/settings', {
            method: 'PUT',
            body: JSON.stringify({
              greeting: document.getElementById('chat-set-greeting').value,
              bubble_label: document.getElementById('chat-set-label').value,
              primary_color: document.getElementById('chat-set-color').value,
              position: document.getElementById('chat-set-position').value,
              escalate_email: document.getElementById('chat-set-email').value,
              escalate_notify_portal: document.getElementById('chat-set-portal').checked,
              suggest_lead_capture: document.getElementById('chat-set-lead').checked,
              agent_timeout_hint_sec: Number(document.getElementById('chat-set-timeout').value) || 90,
            }),
          });
          moduleState.chatbot = Object.assign({}, moduleState.chatbot || {}, { settings: data.settings });
          if (msg) { msg.className = 'msg ok'; msg.textContent = 'Saved.'; }
        } catch (e) {
          if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Save failed'; }
        }
      };
    }
  }

  function renderChatbotInboxPanel() {
    const host = document.getElementById('modules-chat-inbox-panel');
    if (!host) return;
    const chat = moduleState.chatbot || {};
    const escalations = Array.isArray(chat.escalations) ? chat.escalations : [];
    const leads = Array.isArray(chat.leads) ? chat.leads : [];
    const escHtml = escalations.length
      ? escalations.map((e) => `
        <div class="row" style="justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8);flex-wrap:wrap">
          <div>
            <strong>${esc(e.reason || 'escalation')}</strong>
            <div class="hint">${esc(e.message || '')}</div>
            <div class="hint">${esc(e.created_at || '')}</div>
          </div>
          <button type="button" class="btn soft small" data-chat-resolve="${e.id}">Resolve</button>
        </div>`).join('')
      : '<p class="hint">No open escalations.</p>';
    const leadHtml = leads.length
      ? leads.map((l) => `
        <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8)">
          <div>
            <strong>${esc(l.name || 'Visitor')}</strong>
            <span class="hint"> · ${esc([l.email, l.phone].filter(Boolean).join(' · '))}</span>
            <div class="hint">${esc(l.message || '')}</div>
          </div>
        </div>`).join('')
      : '<p class="hint">No chatbot leads yet.</p>';
    host.innerHTML = `
      <div class="row" style="justify-content:flex-start;margin-bottom:12px">
        <button type="button" class="btn ghost small" id="btn-chat-inbox-back">← Knowledge</button>
      </div>
      <h3>Escalations &amp; leads</h3>
      <p class="hint">When the agent is unsure it escalates here. Lead capture from the chat widget also appears below.</p>
      <h4 style="margin:12px 0 6px">Open escalations (${esc(String(chat.open_escalations || escalations.length || 0))})</h4>
      ${escHtml}
      <h4 style="margin:16px 0 6px">Lead captures</h4>
      ${leadHtml}`;
    const backBtn = document.getElementById('btn-chat-inbox-back');
    if (backBtn) {
      backBtn.onclick = () => {
        moduleState.pane = 'content';
        syncModulesPaneTabs();
      };
    }
    host.querySelectorAll('[data-chat-resolve]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/modules/chatbot/escalations/${btn.getAttribute('data-chat-resolve')}/resolve`, {
            method: 'POST',
            body: '{}',
          });
          await loadModuleItems();
          renderChatbotInboxPanel();
        } catch (e) {
          moduleMsg(e.message, false);
        }
      };
    });
  }

  function moduleItemTitle(it, type) {
    if (type === 'faq') return it.question || `#${it.id}`;
    if (type === 'testimonials') return it.author_name || it.name || it.title || `#${it.id}`;
    if (type === 'team') return it.name || it.title || `#${it.id}`;
    return it.title || it.name || `#${it.id}`;
  }

  function moduleItemMeta(it, type) {
    const st = it.status || 'draft';
    const pill = st === 'published' ? 'status-pill' : 'status-pill draft';
    const bits = [`<span class="${pill}">${esc(st)}</span>`];
    if (type === 'ecommerce' && it.price_label) bits.push(`<span>${esc(it.price_label)}</span>`);
    if (type === 'courses') bits.push(`<span>${(it.lessons || []).length} lessons</span>`);
    if (type === 'gallery') bits.push(`<span>${(it.images || []).length} photos</span>`);
    if (type === 'directory' && it.category) bits.push(`<span>${esc(it.category)}</span>`);
    if (type === 'faq' && it.category) bits.push(`<span>${esc(it.category)}</span>`);
    if (type === 'testimonials') {
      const role = [it.author_title, it.author_company].filter(Boolean).join(', ');
      if (role) bits.push(`<span>${esc(role)}</span>`);
      else if (it.rating != null && it.rating !== '') bits.push(`<span>${esc(String(it.rating))}★</span>`);
    }
    if (type === 'team' && it.role_title) bits.push(`<span>${esc(it.role_title)}</span>`);
    if (type === 'events') bits.push(`<span>${esc(it.starts_at || it.location || '')}</span>`);
    if (type === 'bookings') {
      bits.push(`<span>${esc(it.duration_label || (it.duration_minutes ? `${it.duration_minutes} min` : ''))}</span>`);
    }
    if (type === 'chatbot') {
      bits.length = 0;
      const st = it.status || 'active';
      bits.push(`<span class="${st === 'active' ? 'status-pill' : 'status-pill draft'}">${esc(st)}</span>`);
      bits.push(`<span>${esc(it.kind || 'link')}</span>`);
      if (it.file_name) bits.push(`<span>${esc(it.file_name)}</span>`);
      else if (it.url) bits.push(`<span>${esc(it.url)}</span>`);
      if (it.has_file) bits.push('<span>file</span>');
      const chars = String(it.content_text || '').trim().length;
      if (chars) bits.push(`<span>${chars.toLocaleString()} chars indexed</span>`);
    }
    return bits.join('<span class="sep">·</span>');
  }

  function renderModuleItems() {
    const box = document.getElementById('modules-items');
    if (!box) return;
    const items = moduleState.items || [];
    const type = moduleState.current;
    const copy = moduleCopy(type);
    if (!items.length) {
      box.classList.remove('item-list');
      box.innerHTML = `<div class="modules-empty">
        <strong>No ${esc(copy.plural)} yet</strong>
        <p class="hint">Create your first ${esc(copy.singular)} — you can publish it when you are ready.</p>
        <button type="button" class="btn soft" id="btn-modules-empty-new">${esc(copy.newBtn)}</button>
      </div>`;
      const emptyBtn = document.getElementById('btn-modules-empty-new');
      if (emptyBtn) emptyBtn.onclick = () => openModuleEditor(null);
      return;
    }
    box.classList.add('item-list');
    const kicker = copy.kicker;
    box.innerHTML = items.map((it) => {
      const title = moduleItemTitle(it, type);
      return `<article class="item-card">
        <span class="item-card-mark" aria-hidden="true"></span>
        <div class="item-card-main">
          <p class="item-card-kicker">${esc(kicker)}</p>
          <h3 class="item-card-title">${esc(title)}</h3>
          <div class="item-card-meta">${moduleItemMeta(it, type)}</div>
        </div>
        <div class="item-card-actions">
          <button type="button" class="btn soft small" data-module-edit="${it.id}">Edit</button>
        </div>
      </article>`;
    }).join('');
  }

  function renderBookingAdminPanel() {
    const hoursHost = document.getElementById('modules-booking-hours-panel');
    const apptsHost = document.getElementById('modules-booking-appts-panel');
    const legacy = document.getElementById('modules-booking-panel');
    if (legacy) {
      legacy.hidden = true;
      legacy.innerHTML = '';
    }
    if (!hoursHost && !apptsHost) return;
    if (moduleState.current !== 'bookings') {
      if (hoursHost) hoursHost.innerHTML = '';
      if (apptsHost) apptsHost.innerHTML = '';
      return;
    }
    const booking = moduleState.booking || {};
    const settings = booking.settings || {};
    const hours = Array.isArray(booking.hours) ? booking.hours : [];
    const appointments = Array.isArray(booking.appointments) ? booking.appointments : [];
    const byDay = {};
    hours.forEach((h) => {
      const d = Number(h.weekday);
      if (!byDay[d]) byDay[d] = [];
      byDay[d].push(`${h.start_time}–${h.end_time}`);
    });
    const hoursHtml = BOOKING_WEEKDAYS.map((label, i) => {
      const ranges = byDay[i] || [];
      return `<label class="booking-hour-row">
        <input type="checkbox" data-bh-day="${i}" ${ranges.length ? 'checked' : ''} />
        <span class="booking-hour-day">${label}</span>
        <input type="text" data-bh-range="${i}" value="${esc(ranges[0] || '09:00–17:00')}" placeholder="09:00–17:00" />
      </label>`;
    }).join('');
    const apptHtml = appointments.length
      ? appointments.slice(0, 40).map((a) => {
        const isArchived = !!(a.archived_at);
        const canArchive = !isArchived && (a.status === 'completed' || a.status === 'cancelled');
        return `
        <div class="row" style="justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8);flex-wrap:wrap">
          <div>
            <strong>${esc(a.customer_name)}</strong>
            <span class="hint"> · ${esc(a.service_name || '')} · ${esc(a.starts_at || '')}</span>
            <div class="hint">${esc(a.customer_email || a.customer_phone || '')} · ${esc(a.status)}${isArchived ? ' · archived' : ''}</div>
          </div>
          <div class="row" style="gap:6px">
            ${!isArchived && a.status === 'pending' ? `<button type="button" class="btn soft small" data-appt-status="${a.id}" data-status="confirmed">Confirm</button>` : ''}
            ${!isArchived && a.status !== 'cancelled' && a.status !== 'completed' ? `<button type="button" class="btn ghost small" data-appt-status="${a.id}" data-status="cancelled">Cancel</button>` : ''}
            ${!isArchived && a.status === 'confirmed' ? `<button type="button" class="btn ghost small" data-appt-status="${a.id}" data-status="completed">Done</button>` : ''}
            ${canArchive ? `<button type="button" class="btn ghost small" data-appt-archive="${a.id}" data-archived="true">Archive</button>` : ''}
            ${isArchived ? `<button type="button" class="btn ghost small" data-appt-archive="${a.id}" data-archived="false">Restore</button>` : ''}
          </div>
        </div>`;
      }).join('')
      : `<p class="hint">${moduleState.showArchivedAppointments ? 'No archived appointments.' : 'No appointments yet. Visitors book from your site calendar.'}</p>`;
    if (hoursHost) {
      hoursHost.innerHTML = `
        <h3>Hours &amp; calendar</h3>
        <p class="hint">Set weekly availability — visitors see open slots on your booking page.</p>
        <div id="modules-booking-hours">${hoursHtml}</div>
        <div class="modules-booking-actions">
          <button type="button" class="btn soft small" id="btn-booking-hours-save">Save hours</button>
          <label class="hint">
            Auto-confirm
            <input type="checkbox" id="booking-auto-confirm" ${settings.auto_confirm ? 'checked' : ''} />
          </label>
          <label class="hint">Min notice (hrs)
            <input type="number" id="booking-min-notice" value="${esc(settings.min_notice_hours != null ? settings.min_notice_hours : 2)}" min="0" max="168" />
          </label>
          <label class="hint">Days ahead
            <input type="number" id="booking-max-ahead" value="${esc(settings.max_days_ahead != null ? settings.max_days_ahead : 60)}" min="1" max="365" />
          </label>
          <button type="button" class="btn soft small" id="btn-booking-settings-save">Save settings</button>
        </div>`;
    }
    if (apptsHost) {
      apptsHost.innerHTML = `
        <h3>Appointments</h3>
        <p class="hint">Confirm, cancel, or complete bookings from your site calendar.</p>
        <label class="hint" style="display:inline-flex;align-items:center;gap:6px;margin:4px 0 8px">
          <input type="checkbox" id="booking-show-archived" ${moduleState.showArchivedAppointments ? 'checked' : ''} />
          Show archived
        </label>
        <div id="modules-booking-appts">${apptHtml}</div>`;
    }
  }

  function moduleModalMsg(text, ok) {
    const el = document.getElementById('msg-modules-modal');
    if (!el) return;
    el.className = ok ? 'msg ok' : (text ? 'msg err' : 'msg');
    el.textContent = text || '';
  }

  function closeModuleModal() {
    moduleState.editingId = null;
    const modal = document.getElementById('modules-item-modal');
    if (modal) modal.hidden = true;
    moduleModalMsg('', true);
  }

  function updateModuleImagePreview(key, url) {
    const fields = document.getElementById('modules-fields');
    if (!fields) return;
    const wrap = fields.querySelector(`[data-mod-image-wrap="${key}"] .mod-image-preview`);
    if (!wrap) return;
    const u = String(url || '').trim();
    wrap.innerHTML = u
      ? `<img src="${esc(u)}" alt="" />`
      : '<span class="hint">No image</span>';
  }

  function renderModuleFieldHtml(d, src) {
    const val = src[d.key] != null ? src[d.key] : '';
    if (d.kind === 'image') {
      const u = String(val || '').trim();
      return `<div class="field mod-image-field" data-mod-image-wrap="${d.key}">
        <label>${esc(d.label)}</label>
        <div class="mod-image-row">
          <div class="mod-image-preview">${u ? `<img src="${esc(u)}" alt="" />` : '<span class="hint">No image</span>'}</div>
          <div class="mod-image-actions">
            <button type="button" class="btn soft small" data-mod-upload="${d.key}">Upload photo</button>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-mod-file="${d.key}" hidden />
            <details class="mod-image-url-fallback">
              <summary class="hint">Or paste image URL</summary>
              <input data-mod-field="${d.key}" type="url" value="${esc(u)}" placeholder="https://…" />
            </details>
          </div>
        </div>
      </div>`;
    }
    if (d.kind === 'files') {
      const existing = src.file_name
        ? `<p class="hint">Current file: ${esc(src.file_name)}${src.has_file ? '' : ''}</p>`
        : '';
      return `<div class="field mod-files-field" data-mod-files-wrap="${d.key}">
        <label>${esc(d.label)}</label>
        ${existing}
        <input type="file" multiple accept="${esc(d.accept || '*/*')}" data-mod-files="${d.key}" />
        <p class="hint" data-mod-files-list="${d.key}">No files selected yet.</p>
        ${d.hint ? `<p class="hint">${esc(d.hint)}</p>` : ''}
      </div>`;
    }
    if (d.kind === 'textarea') {
      return `<div class="field"><label>${esc(d.label)}</label><textarea data-mod-field="${d.key}" rows="4">${esc(val)}</textarea></div>`;
    }
    if (d.kind === 'select') {
      const opts = (d.options || []).map((o) =>
        `<option value="${esc(o)}"${String(val) === o ? ' selected' : ''}>${esc(o)}</option>`
      ).join('');
      return `<div class="field"><label>${esc(d.label)}</label><select data-mod-field="${d.key}">${opts}</select></div>`;
    }
    const req = d.required ? ' required' : '';
    return `<div class="field"><label>${esc(d.label)}</label><input data-mod-field="${d.key}" type="text" value="${esc(val)}" placeholder="${esc(d.placeholder || '')}"${req} /></div>`;
  }

  async function uploadModuleFieldImage(key, file) {
    const prepared = await resizeImageForUpload(file, 1600);
    const result = await api('/modules/upload-image', {
      method: 'POST',
      body: JSON.stringify({ data: prepared.data, mimeType: prepared.mimeType }),
    });
    const url = (result && (result.publicUrl || result.url)) || '';
    const fields = document.getElementById('modules-fields');
    const input = fields && fields.querySelector(`[data-mod-field="${key}"]`);
    if (input) input.value = url;
    updateModuleImagePreview(key, url);
    return url;
  }

  function wireModuleFieldUploads() {
    const fields = document.getElementById('modules-fields');
    if (!fields) return;
    fields.querySelectorAll('[data-mod-upload]').forEach((btn) => {
      btn.onclick = () => {
        const key = btn.getAttribute('data-mod-upload');
        const fileInput = fields.querySelector(`[data-mod-file="${key}"]`);
        if (fileInput) fileInput.click();
      };
    });
    fields.querySelectorAll('[data-mod-file]').forEach((input) => {
      input.onchange = async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        const key = input.getAttribute('data-mod-file');
        moduleModalMsg('Uploading photo…', true);
        try {
          await uploadModuleFieldImage(key, file);
          moduleModalMsg('Photo uploaded.', true);
        } catch (e) {
          moduleModalMsg(e.message || 'Upload failed', false);
        }
      };
    });
    fields.querySelectorAll('[data-mod-files]').forEach((input) => {
      input.onchange = () => {
        const key = input.getAttribute('data-mod-files');
        const list = input.files ? Array.from(input.files) : [];
        moduleState.pendingKnowledgeFiles = list;
        const label = fields.querySelector(`[data-mod-files-list="${key}"]`);
        if (label) {
          label.textContent = list.length
            ? `${list.length} file${list.length === 1 ? '' : 's'} selected: ${list.map((f) => f.name).join(', ')}`
            : 'No files selected yet.';
        }
        const kindSel = fields.querySelector('[data-mod-field="kind"]');
        if (kindSel && list.length) kindSel.value = 'doc';
        const titleInput = fields.querySelector('[data-mod-field="title"]');
        if (titleInput && !String(titleInput.value || '').trim() && list[0]) {
          titleInput.value = list[0].name.replace(/\.[^.]+$/, '');
        }
      };
    });
    fields.querySelectorAll('[data-mod-field]').forEach((el) => {
      if (el.type === 'url' && el.closest('[data-mod-image-wrap]')) {
        el.oninput = () => updateModuleImagePreview(el.getAttribute('data-mod-field'), el.value);
      }
    });
  }

  function openModuleEditor(item) {
    const modal = document.getElementById('modules-item-modal');
    const fields = document.getElementById('modules-fields');
    const titleEl = document.getElementById('modules-modal-title');
    const ledeEl = document.getElementById('modules-modal-lede');
    const delBtn = document.getElementById('btn-modules-delete');
    if (!modal || !fields) return;
    moduleState.editingId = item && item.id ? item.id : null;
    moduleState.pendingKnowledgeFiles = [];
    const copy = moduleCopy(moduleState.current);
    const meta = MODULE_TYPES.find((m) => m.type === moduleState.current);
    if (titleEl) titleEl.textContent = moduleState.editingId ? `Edit ${copy.singular}` : copy.newBtn;
    if (ledeEl) {
      if (moduleState.current === 'chatbot') {
        ledeEl.textContent = moduleState.editingId
          ? 'Update this knowledge item. Re-upload a file to replace extracted text for the agent.'
          : 'Add a link, paste notes, or upload one or more docs (PDF, Word, Excel, PowerPoint, images, text). File text is extracted for the chat agent.';
      } else {
        ledeEl.textContent = moduleState.editingId
          ? `Update this ${copy.singular} for your ${(meta && meta.label) || 'module'}.`
          : `Fill in the details below. You can save as draft and publish when ready.`;
      }
    }
    if (delBtn) delBtn.hidden = !moduleState.editingId;
    const defs = moduleFieldDefs(moduleState.current);
    const src = item || (moduleState.current === 'chatbot' ? { status: 'active', kind: 'doc' } : { status: 'draft' });
    fields.innerHTML = defs.map((d) => renderModuleFieldHtml(d, src)).join('');
    if ((moduleState.current === 'ecommerce' || moduleState.current === 'bookings')
      && item && item.price_cents != null) {
      const priceInput = fields.querySelector('[data-mod-field="price"]');
      if (priceInput) {
        priceInput.value = Number(item.price_cents)
          ? (Number(item.price_cents) / 100).toFixed(2)
          : '';
      }
    }
    wireModuleFieldUploads();
    moduleModalMsg('', true);
    modal.hidden = false;
    const first = fields.querySelector('input, textarea, select');
    if (first) first.focus();
  }

  async function fileToBase64Raw(file) {
    const data = await blobToBase64(file);
    return { data, mimeType: file.type || 'application/octet-stream', fileName: file.name };
  }

  async function uploadChatbotKnowledgeFiles(files, title) {
    const list = Array.from(files || []);
    if (!list.length) return null;
    const prepared = [];
    for (const file of list) {
      if (file.size > 5 * 1024 * 1024) {
        throw new Error(`${file.name} is over 5MB`);
      }
      prepared.push({
        ...(await fileToBase64Raw(file)),
        title: title || file.name.replace(/\.[^.]+$/, ''),
      });
    }
    return api('/modules/chatbot/knowledge/upload', {
      method: 'POST',
      body: JSON.stringify({ files: prepared, title: title || undefined }),
    });
  }

  function collectModuleFields() {
    const fields = document.getElementById('modules-fields');
    const out = {};
    if (!fields) return out;
    fields.querySelectorAll('[data-mod-field]').forEach((el) => {
      const key = el.getAttribute('data-mod-field');
      out[key] = el.value;
    });
    if (moduleState.current === 'ecommerce' && out.price != null && out.price !== '') {
      out.price = Number(out.price);
    }
    if (moduleState.current === 'bookings') {
      if (out.price != null && out.price !== '') out.price = Number(out.price);
      if (out.duration_minutes != null && out.duration_minutes !== '') {
        out.duration_minutes = Number(out.duration_minutes);
      }
      if (out.buffer_minutes != null && out.buffer_minutes !== '') {
        out.buffer_minutes = Number(out.buffer_minutes);
      }
      if (out.rating != null && out.rating !== '') out.rating = Number(out.rating);
    }
    if (moduleState.current === 'testimonials' && out.rating != null && out.rating !== '') {
      out.rating = Number(out.rating);
    }
    if (moduleState.current === 'gallery' && out.image_url && !moduleState.editingId) {
      out.images = [{ image_url: out.image_url }];
      delete out.image_url;
    }
    return out;
  }

  function patchBookingsNavCount(activeCount) {
    const list = moduleState.summary && Array.isArray(moduleState.summary.modules)
      ? moduleState.summary.modules
      : null;
    if (!list) return;
    const row = list.find((x) => x && x.type === 'bookings');
    if (!row) return;
    row.count = Math.max(0, Number(activeCount) || 0);
    renderModuleTypeTabs();
  }

  async function loadModuleItems() {
    const type = moduleState.current;
    storeModuleType(type);
    const qs = (type === 'bookings' && moduleState.showArchivedAppointments)
      ? '?includeArchived=1'
      : '';
    const data = await api(`/modules/${encodeURIComponent(type)}${qs}`);
    moduleState.items = Array.isArray(data.items) ? data.items : [];
    moduleState.pages = Array.isArray(data.pages) ? data.pages : moduleState.pages;
    moduleState.embed = data.embed || null;
    moduleState.booking = data.booking || null;
    moduleState.chatbot = data.chatbot || null;
    if (type === 'bookings') {
      const booking = moduleState.booking || {};
      if (booking.active_appointment_count != null) {
        patchBookingsNavCount(booking.active_appointment_count);
      } else {
        const appts = Array.isArray(booking.appointments) ? booking.appointments : [];
        patchBookingsNavCount(appts.filter((a) => !a.archived_at).length);
      }
    }
    renderModuleItems();
    renderModuleEmbedBar();
    renderBookingAdminPanel();
    syncModulesPaneTabs();
  }

  async function loadModules() {
    const upgrade = document.getElementById('modules-upgrade');
    const app = document.getElementById('modules-app');
    try {
      const data = await api('/modules');
      moduleState.plan = data.plan || 'free';
      moduleState.enabled = !!data.siteModules;
      moduleState.summary = data;
      moduleState.pages = Array.isArray(data.pages) ? data.pages : [];
      if (upgrade) upgrade.hidden = moduleState.enabled;
      if (app) app.hidden = !moduleState.enabled;
      if (!moduleState.enabled) return;
      if (!MODULE_TYPES.some((m) => m.type === moduleState.current)) {
        moduleState.current = 'blog';
      }
      renderModuleTypeTabs();
      await loadModuleItems();
    } catch (e) {
      moduleMsg(e.message, false);
    }
  }

  async function loadDashboard() {
    const me = await api('/me');
    state.client = me.client;
    state.previewUrl = me.previewUrl || null;
    state.hasSite = !!(me.site && me.site.id);
    document.getElementById('biz-name').textContent = (me.lead && me.lead.business_name)
      || me.client.businessName
      || 'Your project';
    const bits = [
      me.client.email,
      me.lead && [me.lead.city, me.lead.state].filter(Boolean).join(', '),
      me.site && me.site.name,
    ].filter(Boolean);
    document.getElementById('biz-meta').textContent = bits.join(' · ');
    showApp();
    await Promise.all([
      loadEditablePreview(me.previewUrl),
      loadCalendar(),
      loadBilling(),
      loadForms().catch(() => {}),
      loadModules().catch(() => {}),
      loadSocialAccounts().catch(() => {}),
    ]);
    scheduleUpsellTip();
  }

  function hideUpsellTip() {
    const modal = document.getElementById('upsell-tip-modal');
    if (modal) modal.hidden = true;
  }

  function showUpsellTip(tip) {
    const modal = document.getElementById('upsell-tip-modal');
    if (!modal || !tip) return;
    const title = document.getElementById('upsell-tip-title');
    const body = document.getElementById('upsell-tip-body');
    const upgrade = document.getElementById('upsell-tip-upgrade');
    if (title) title.textContent = tip.title || 'Did you know?';
    if (body) body.textContent = tip.body || '';
    if (upgrade) upgrade.textContent = tip.cta_label || 'Upgrade';
    modal.hidden = false;
  }

  function scheduleUpsellTip() {
    if (String(state.plan || 'free') !== 'free') return;
    setTimeout(() => {
      maybeShowUpsellTip().catch(() => {});
    }, 12000);
  }

  async function maybeShowUpsellTip() {
    if (String(state.plan || 'free') !== 'free') return;
    if (sessionStorage.getItem('bp_upsell_tip_session') === '1') return;
    const data = await api('/upsell-tips/next');
    if (!data || !data.tip) return;
    sessionStorage.setItem('bp_upsell_tip_session', '1');
    showUpsellTip(data.tip);
  }

  document.getElementById('btn-edit-mode').onclick = () => {
    if (!state.siteEditable) return;
    if (state.editMode) {
      // Done: leave edit mode + fullscreen; keep any unsaved edits in the bar
      setEditMode(false, { fullscreen: false });
    } else {
      setEditMode(true, { fullscreen: true });
    }
  };

  const themeBtn = document.getElementById('btn-theme-colors');
  if (themeBtn) {
    themeBtn.onclick = () => {
      if (!state.siteEditable) return;
      state.themeOpen = !state.themeOpen;
      if (state.themeOpen) {
        fillThemeForm(state.theme);
        ensureCatalogStyles(document);
        fillFontSelects();
      }
      const msg = document.getElementById('msg-theme');
      if (msg && state.themeOpen) { msg.className = 'msg'; msg.textContent = ''; }
      syncThemeUi();
    };
  }

  const structureBtn = document.getElementById('btn-structure');
  if (structureBtn) {
    structureBtn.onclick = async () => {
      if (!state.siteEditable) return;
      state.structureOpen = !state.structureOpen;
      syncStructureUi();
      if (state.structureOpen) {
        setStructureMsg('', '');
        await loadStructure();
      }
    };
  }

  const structureBar = document.getElementById('structure-bar');
  if (structureBar) {
    structureBar.addEventListener('click', (ev) => {
      const t = ev.target && ev.target.closest
        ? ev.target.closest('[data-struct-page],[data-struct],[data-struct-insert]')
        : null;
      if (!t || !structureBar.contains(t)) return;
      if (t.hasAttribute('data-struct-insert')) {
        if (t.disabled) return;
        openStructureModuleModal(Number(t.getAttribute('data-struct-insert')));
        return;
      }
      if (t.hasAttribute('data-struct-page')) {
        state.structurePageIdx = Number(t.getAttribute('data-struct-page')) || 0;
        renderStructureLists();
        return;
      }
      if (t.disabled) return;
      const scope = t.getAttribute('data-struct');
      const from = t.getAttribute('data-from');
      const action = t.getAttribute('data-action') || 'move';
      const dir = t.getAttribute('data-dir');
      if (!scope) return;
      applyStructureMove(scope, from, dir, action);
    });
  }

  const btnStructureAddPage = document.getElementById('btn-structure-add-page');
  if (btnStructureAddPage) btnStructureAddPage.onclick = () => openStructurePageModal();

  const btnStructureModuleCancel = document.getElementById('btn-structure-module-cancel');
  if (btnStructureModuleCancel) btnStructureModuleCancel.onclick = () => closeStructureModuleModal();

  const btnStructurePageCancel = document.getElementById('btn-structure-page-cancel');
  if (btnStructurePageCancel) btnStructurePageCancel.onclick = () => closeStructurePageModal();

  const btnStructurePageSave = document.getElementById('btn-structure-page-save');
  if (btnStructurePageSave) {
    btnStructurePageSave.onclick = async () => {
      const input = document.getElementById('structure-page-title');
      const msg = document.getElementById('msg-structure-page');
      const title = input ? String(input.value || '').trim() : '';
      if (!title) {
        if (msg) { msg.className = 'msg err'; msg.textContent = 'Enter a page title.'; }
        return;
      }
      await applyStructureAddPage(title);
    };
  }

  const structureModuleModal = document.getElementById('structure-module-modal');
  if (structureModuleModal) {
    structureModuleModal.addEventListener('click', (ev) => {
      if (ev.target === structureModuleModal) closeStructureModuleModal();
      const sectionPick = ev.target && ev.target.closest
        ? ev.target.closest('[data-structure-section-type]') : null;
      if (sectionPick) {
        const cols = resolveStructureCols(sectionPick);
        if (state.canvasPick && state.canvasPick.mode === 'design-module') {
          applyCanvasPickLayout(
            sectionPick.getAttribute('data-structure-section-type'),
            cols
          );
        } else if (!state.canvasPick) {
          applyStructureInsertSection(
            sectionPick.getAttribute('data-structure-section-type'),
            cols
          );
        }
        return;
      }
      const formPick = ev.target && ev.target.closest
        ? ev.target.closest('[data-structure-form-id]') : null;
      if (formPick) {
        const formId = Number(formPick.getAttribute('data-structure-form-id'));
        if (state.canvasPick && state.canvasPick.mode === 'widget') {
          applyCanvasPickForm(formId);
        } else if (!state.canvasPick) {
          applyStructureInsertForm(formId);
        }
        return;
      }
      const pick = ev.target && ev.target.closest
        ? ev.target.closest('[data-structure-module-type]') : null;
      if (pick) {
        if (state.canvasPick && state.canvasPick.mode === 'widget') {
          applyCanvasPickModule(pick.getAttribute('data-structure-module-type'));
        } else if (!state.canvasPick) {
          applyStructureInsertModule(pick.getAttribute('data-structure-module-type'));
        }
      }
    });
  }
  const structurePageModal = document.getElementById('structure-page-modal');
  if (structurePageModal) {
    structurePageModal.addEventListener('click', (ev) => {
      if (ev.target === structurePageModal) closeStructurePageModal();
    });
  }

  function onThemeInputChange(ev) {
    const el = ev.target;
    const key = el && el.getAttribute('data-theme-key');
    if (!key || THEME_KEYS.indexOf(key) < 0) return;
    const hex = normalizeThemeHex(el.value);
    if (!hex) return;
    const hexEl = document.getElementById(`theme-hex-${key}`);
    const pickEl = document.getElementById(`theme-pick-${key}`);
    if (hexEl && hexEl !== el) hexEl.value = hex;
    if (pickEl && pickEl !== el) pickEl.value = hex;
    state.theme = { ...state.theme, [key]: hex };
    try {
      const colors = readThemeForm();
      applyThemeLiveToPreview(colors);
    } catch { /* incomplete hex while typing */ }
  }

  function onPaletteInputChange(ev) {
    const el = ev.target;
    if (!el || !el.hasAttribute('data-palette-i')) return;
    const extras = state.themePalette.filter((p) => !p.isRole);
    const i = Number(el.getAttribute('data-palette-i'));
    if (!Number.isInteger(i) || i < 0 || i >= extras.length) return;
    const hex = normalizeThemeHex(el.value);
    if (!hex) return;
    const item = extras[i];
    const from = item.current;
    item.current = hex;
    // Sync sibling input in the same item
    const row = el.closest('.theme-palette-item');
    if (row) {
      row.querySelectorAll('[data-palette-i]').forEach((node) => {
        if (node !== el) node.value = hex;
      });
    }
    // Keep master palette list in sync
    const master = state.themePalette.find((p) => p.original === item.original);
    if (master) master.current = hex;
    applyThemeLiveToPreview(state.theme, {
      paletteRewrites: from && from !== hex ? [{ from, to: hex }] : [],
    });
  }

  for (const key of THEME_KEYS) {
    const hexEl = document.getElementById(`theme-hex-${key}`);
    const pickEl = document.getElementById(`theme-pick-${key}`);
    if (hexEl) {
      hexEl.addEventListener('input', onThemeInputChange);
      hexEl.addEventListener('change', onThemeInputChange);
    }
    if (pickEl) {
      pickEl.addEventListener('input', onThemeInputChange);
      pickEl.addEventListener('change', onThemeInputChange);
    }
  }

  const paletteHost = document.getElementById('theme-palette');
  if (paletteHost) {
    paletteHost.addEventListener('input', onPaletteInputChange);
    paletteHost.addEventListener('change', onPaletteInputChange);
  }

  const btnThemeReset = document.getElementById('btn-theme-reset');
  if (btnThemeReset) {
    btnThemeReset.onclick = () => {
      // Rebuild live from saved by reloading preview (hex rewrites are one-way in the iframe).
      state.theme = { ...state.themeSaved };
      state.themePalette = state.themePalette.map((p) => ({ ...p, current: p.original }));
      fillThemeForm(state.theme);
      fillFontSelects();
      renderThemePalette();
      const msg = document.getElementById('msg-theme');
      if (msg) { msg.className = 'msg'; msg.textContent = 'Resetting preview…'; }
      loadEditablePreview(state.previewUrl, {
        preserveEditMode: state.editMode,
        preserveFullscreen: state.editFullscreen,
      }).then(() => {
        state.themeLive = {
          primary: state.theme.primary,
          secondary: state.theme.secondary,
          bg: state.theme.bg,
          text: state.theme.text,
        };
        if (msg) { msg.className = 'msg'; msg.textContent = 'Reset to the last saved theme.'; }
      });
    };
  }

  function bindPairedFontSelect(id, peerId, which) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      syncFontSelect(id, peerId);
      onSiteFontPick(which);
    });
  }
  bindPairedFontSelect('theme-font-body', 'edit-font-body', 'body');
  bindPairedFontSelect('edit-font-body', 'theme-font-body', 'body');
  bindPairedFontSelect('theme-font-heading', 'edit-font-heading', 'heading');
  bindPairedFontSelect('edit-font-heading', 'theme-font-heading', 'heading');
  const elementFont = document.getElementById('edit-font-element');
  if (elementFont) {
    if (window.WsFonts) window.WsFonts.fillSelect(elementFont, '', { defaultLabel: 'Site default' });
    elementFont.disabled = true;
    elementFont.addEventListener('change', () => {
      postElementFont(window.WsFonts ? window.WsFonts.selectedName(elementFont) : '');
    });
  }
  if (window.WsFonts) {
    ensureCatalogStyles(document);
    fillFontSelects();
  }

  const btnThemeSave = document.getElementById('btn-theme-save');
  if (btnThemeSave) {
    btnThemeSave.onclick = async () => {
      if (!state.siteEditable || state.themeSaving) return;
      const msg = document.getElementById('msg-theme');
      let colors;
      try {
        colors = { ...readThemeForm(), ...readThemeFonts() };
      } catch (e) {
        if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Invalid color'; }
        return;
      }
      const replacements = state.themePalette
        .filter((p) => p.current && p.original && p.current !== p.original)
        .map((p) => ({ from: p.original, to: p.current }));
      // Also include role changes relative to saved (server builds map from old theme).
      state.themeSaving = true;
      syncThemeUi();
      if (msg) { msg.className = 'msg'; msg.textContent = 'Saving theme…'; }
      try {
        const result = await api('/site/theme', {
          method: 'POST',
          body: JSON.stringify({ ...colors, replacements }),
        });
        if (result && result.theme) setThemeFromServer(result.theme);
        else {
          state.theme = colors;
          state.themeSaved = { ...colors };
        }
        if (result && result.previewUrl) state.previewUrl = result.previewUrl;
        if (msg) {
          msg.className = 'msg ok';
          msg.textContent = result && result.publicPreviewUpdated
            ? 'Theme saved. Your public preview is up to date.'
            : 'Theme saved. Updating preview…';
        }
        await loadEditablePreview(state.previewUrl, {
          preserveEditMode: state.editMode,
          preserveFullscreen: state.editFullscreen,
        });
        if (msg) {
          msg.className = 'msg ok';
          msg.textContent = 'Colors saved on your site.';
          setTimeout(() => {
            if (msg.textContent.indexOf('Colors saved') === 0) {
              msg.className = 'msg';
              msg.textContent = '';
            }
          }, 4000);
        }
      } catch (e) {
        if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not save colors'; }
      } finally {
        state.themeSaving = false;
        syncThemeUi();
      }
    };
  }

  const btnPublishSite = document.getElementById('btn-publish-site');
  if (btnPublishSite) btnPublishSite.onclick = () => publishSitePreview();

  document.getElementById('btn-enter-fullscreen').onclick = () => {
    if (!state.siteEditable) return;
    if (!state.editMode) setEditMode(true, { fullscreen: true });
    else setEditFullscreen(true);
  };

  document.getElementById('btn-exit-fullscreen').onclick = () => {
    // Close / Esc: exit overlay only — do not discard pending edits
    setEditFullscreen(false);
  };

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!state.editFullscreen) return;
    ev.preventDefault();
    setEditFullscreen(false);
  });

  const undoBtn = document.getElementById('btn-edit-undo');
  if (undoBtn) {
    undoBtn.onclick = () => {
      const frame = state.previewFrame;
      if (!frame || !frame.contentWindow || !state.canUndo) return;
      frame.contentWindow.postMessage({ source: 'ws-portal', type: 'undo' }, '*');
    };
  }

  document.getElementById('btn-edit-cancel').onclick = async () => {
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    clearPendingEdits();
    await loadEditablePreview(state.previewUrl);
    if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
    else if (keepFs && state.siteEditable) setEditFullscreen(true);
  };

  const logoUploadBtn = document.getElementById('btn-logo-upload');
  const logoRemoveBtn = document.getElementById('btn-logo-remove');
  const logoModeText = document.getElementById('logo-mode-text');
  const logoModeImage = document.getElementById('logo-mode-image');
  if (logoUploadBtn) {
    logoUploadBtn.onclick = async () => {
      try {
        const file = await pickImageFile();
        if (!file) return;
        await applyLogoMode('image', file);
      } catch (e) {
        if (e && e.message === 'cancelled') return;
        const msg = document.getElementById('msg-logo');
        if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not upload logo'; }
      }
    };
  }
  if (logoRemoveBtn) {
    logoRemoveBtn.onclick = () => applyLogoMode('text');
  }
  if (logoModeText) {
    logoModeText.onchange = () => {
      if (logoModeText.checked && state.logo && state.logo.mode === 'image') applyLogoMode('text');
    };
  }
  if (logoModeImage) {
    logoModeImage.onchange = async () => {
      if (!logoModeImage.checked) return;
      if (state.logo && state.logo.mode === 'image') return;
      try {
        const file = await pickImageFile();
        if (!file) { syncLogoUi(); return; }
        await applyLogoMode('image', file);
      } catch (e) {
        syncLogoUi();
        if (e && e.message === 'cancelled') return;
        const msg = document.getElementById('msg-logo');
        if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not upload logo'; }
      }
    };
  }

  const btnAiCancel = document.getElementById('btn-ai-image-cancel');
  const btnAiGenerate = document.getElementById('btn-ai-image-generate');
  const aiModal = document.getElementById('ai-image-modal');
  if (btnAiCancel) btnAiCancel.onclick = () => closeAiImageModal();
  if (btnAiGenerate) btnAiGenerate.onclick = () => submitAiImageGenerate();
  if (aiModal) {
    aiModal.addEventListener('click', (ev) => {
      if (ev.target === aiModal && !state.imageUploading) closeAiImageModal();
    });
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && aiModal && !aiModal.hidden && !state.imageUploading) {
      closeAiImageModal();
    }
  });

  document.getElementById('btn-edit-save').onclick = async () => {
    const msg = document.getElementById('msg-edit');
    const btn = document.getElementById('btn-edit-save');
    const cancel = document.getElementById('btn-edit-cancel');
    if (!state.pendingEdits.size) return;
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    msg.className = 'msg';
    msg.textContent = 'Saving…';
    btn.disabled = true;
    cancel.disabled = true;
    try {
      const edits = [...state.pendingEdits.entries()].map(([id, text]) => ({ id, text }));
      const data = await api('/site/edits', {
        method: 'POST',
        body: JSON.stringify({ edits }),
      });
      if (data && data.previewUrl) state.previewUrl = data.previewUrl;
      clearPendingEdits();
      msg.className = 'msg ok';
      msg.textContent = `Saved ${data.applied || edits.length} change${(data.applied || edits.length) === 1 ? '' : 's'}. Updating preview…`;
      await loadEditablePreview(state.previewUrl);
      if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
      else if (keepFs && state.siteEditable) setEditFullscreen(true);
      msg.className = 'msg ok';
      msg.textContent = data.publicPreviewUpdated
        ? 'Saved. Your public preview is up to date.'
        : 'Saved locally. Public Cloudflare preview will update on the next successful publish.';
      if (data.previewUrl) state.previewUrl = data.previewUrl;
      setTimeout(() => {
        if (msg.textContent.indexOf('Saved') === 0) {
          msg.className = 'msg';
          msg.textContent = '';
        }
      }, 4000);
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    } finally {
      btn.disabled = false;
      cancel.disabled = false;
      updateEditBar();
    }
  };

  document.getElementById('form-changes').onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('msg-changes');
    const btn = document.getElementById('btn-changes');
    msg.className = 'msg';
    msg.textContent = 'Sending…';
    btn.disabled = true;
    try {
      await api('/changes', {
        method: 'POST',
        body: JSON.stringify({
          kind: document.getElementById('change-kind').value,
          message: document.getElementById('change-message').value.trim(),
        }),
      });
      msg.className = 'msg ok';
      msg.textContent = 'Request received — we’ll take it from here.';
      document.getElementById('change-message').value = '';
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };

  async function generate(period) {
    const msg = document.getElementById('msg-social');
    const weekBtn = document.getElementById('gen-week');
    const monthBtn = document.getElementById('gen-month');
    msg.className = 'msg';
    const cost = state.contentCredits;
    msg.textContent = (period === 'week' ? 'Generating a week' : 'Generating a month')
      + (cost > 0 ? ` (${cost} credit${cost === 1 ? '' : 's'})…` : '…');
    weekBtn.disabled = true;
    monthBtn.disabled = true;
    try {
      const data = await api('/social/generate', {
        method: 'POST',
        body: JSON.stringify({ period }),
      });
      if (data && data.credits_balance != null) state.creditsBalance = Number(data.credits_balance);
      msg.className = 'msg ok';
      msg.textContent = 'Content queued. Refreshing calendar…';
      await loadCalendar();
      const charged = Number(data && data.credits_charged || 0);
      msg.textContent = charged > 0
        ? `New posts added. Used ${charged} credit${charged === 1 ? '' : 's'} (${state.creditsBalance} left).`
        : 'New posts added to your calendar.';
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    } finally {
      weekBtn.disabled = false;
      monthBtn.disabled = false;
    }
  }

  document.getElementById('gen-week').onclick = () => generate('week');
  document.getElementById('gen-month').onclick = () => generate('month');

  document.getElementById('post-prev').onclick = () => {
    if (state.page > 1) {
      state.page -= 1;
      renderPostPage();
    }
  };
  document.getElementById('post-next').onclick = () => {
    const pages = Math.max(1, Math.ceil(state.posts.length / state.pageSize));
    if (state.page < pages) {
      state.page += 1;
      renderPostPage();
    }
  };

  document.getElementById('post-list').onclick = async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const post = findPost(id);
    if (!post) return;
    const act = btn.getAttribute('data-act');
    if (act === 'gen-image') return generateBrandedImage(id);
    if (act === 'save-caption') return saveCaption(id);
    if (act === 'approve') {
      const msg = document.getElementById('msg-social');
      try {
        await api('/social/posts/approve', {
          method: 'POST',
          body: JSON.stringify({ postIds: [Number(id)] }),
        });
        msg.className = 'msg ok';
        msg.textContent = 'Post approved and scheduled.';
        await loadCalendar();
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = e.message;
      }
      return;
    }
    if (act === 'share-native') return sharePost(post, 'native');
    if (act === 'share-fb') return sharePost(post, 'fb');
    if (act === 'share-ig') return sharePost(post, 'ig');
    if (act === 'copy') return sharePost(post, 'copy');
  };

  document.getElementById('post-list').onchange = async (ev) => {
    const input = ev.target.closest('input[data-act="sched"]');
    if (!input) return;
    const id = input.getAttribute('data-id');
    const msg = document.getElementById('msg-social');
    const val = String(input.value || '').trim();
    if (!val) return;
    try {
      const scheduled_at = val.length === 16 ? `${val}:00` : val;
      await api(`/social/posts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at, status: 'scheduled' }),
      });
      msg.className = 'msg ok';
      msg.textContent = 'Schedule updated.';
      await loadCalendar();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    }
  };

  const btnMeta = document.getElementById('btn-meta-connect');
  if (btnMeta) {
    btnMeta.onclick = async () => {
      const msg = document.getElementById('msg-meta');
      msg.className = 'msg';
      msg.textContent = 'Starting Meta OAuth…';
      try {
        const data = await api('/social/oauth/start?returnTo=' + encodeURIComponent('/portal?connected=1#/social'));
        if (data && data.url) location.href = data.url;
        else throw new Error('No OAuth URL');
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = e.message;
      }
    };
  }

  const accountsList = document.getElementById('social-accounts-list');
  if (accountsList) {
    accountsList.onclick = async (ev) => {
      const btn = ev.target.closest('[data-disconnect]');
      if (!btn) return;
      const msg = document.getElementById('msg-meta');
      try {
        await api(`/social/accounts/${btn.getAttribute('data-disconnect')}`, { method: 'DELETE' });
        msg.className = 'msg ok';
        msg.textContent = 'Disconnected.';
        await loadSocialAccounts();
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = e.message;
      }
    };
  }

  const btnFormAdd = document.getElementById('btn-form-add-field');
  if (btnFormAdd) {
    btnFormAdd.onclick = () => {
      formState.fields = collectFormFieldsFromEditor();
      formState.fields.push({
        field_key: '',
        label: 'New field',
        field_type: 'text',
        required: false,
        placeholder: '',
        sort_order: formState.fields.length,
      });
      renderFormFieldsEditor();
    };
  }

  const fieldsEditor = document.getElementById('form-fields-editor');
  if (fieldsEditor) {
    fieldsEditor.onclick = (ev) => {
      const btn = ev.target.closest('[data-fk="remove"]');
      if (!btn) return;
      const row = btn.closest('[data-field-i]');
      const i = Number(row && row.getAttribute('data-field-i'));
      formState.fields = collectFormFieldsFromEditor().filter((_, idx) => idx !== i);
      renderFormFieldsEditor();
    };
  }

  function collectFormMeta() {
    const embedCb = document.getElementById('form-embed-on-page');
    const navCb = document.getElementById('form-add-to-nav');
    const pageSel = document.getElementById('form-target-page');
    const nameEl = document.getElementById('form-name');
    return {
      name: nameEl ? nameEl.value.trim() : '',
      title: document.getElementById('form-title').value.trim(),
      intro: document.getElementById('form-intro').value.trim(),
      submit_label: document.getElementById('form-submit-label').value.trim(),
      notify_email: document.getElementById('form-notify').value.trim(),
      success_message: document.getElementById('form-success').value.trim(),
      embed_on_page: !!(embedCb && embedCb.checked),
      embed_enabled: !!(embedCb && embedCb.checked),
      add_to_nav: !!(navCb && navCb.checked),
      nav_visible: !!(navCb && navCb.checked),
      target_page_slug: pageSel ? pageSel.value : 'contact',
      fields: formState.fields,
    };
  }

  async function saveFormBuilder() {
    const msg = document.getElementById('msg-forms');
    msg.className = 'msg';
    msg.textContent = 'Saving…';
    formState.fields = collectFormFieldsFromEditor();
    if (!formState.editingId) {
      msg.className = 'msg err';
      msg.textContent = 'No form selected.';
      return null;
    }
    try {
      const data = await api(`/forms/${formState.editingId}`, {
        method: 'PUT',
        body: JSON.stringify(collectFormMeta()),
      });
      msg.className = 'msg ok';
      msg.textContent = 'Form saved.';
      if (data.form) applyFormToEditor(data.form, data.embed);
      await loadForms();
      return data;
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
      return null;
    }
  }

  const btnFormSave = document.getElementById('btn-form-save');
  if (btnFormSave) btnFormSave.onclick = () => saveFormBuilder();

  async function publishForm() {
    const msg = document.getElementById('msg-forms');
    msg.className = 'msg';
    msg.textContent = 'Publishing…';
    try {
      const saved = await saveFormBuilder();
      if (!saved && !formState.editingId) return;
      const meta = collectFormMeta();
      const data = await api(`/forms/${formState.editingId}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          embed_on_page: meta.embed_on_page,
          embed_enabled: meta.embed_enabled,
          target_page_slug: meta.target_page_slug,
        }),
      });
      msg.className = 'msg ok';
      msg.textContent = meta.embed_enabled
        ? `Published on your ${meta.target_page_slug || 'contact'} page.`
        : 'Published — embed URL ready (not added to a page).';
      if (data.form) applyFormToEditor(data.form, data.embed);
      await loadForms();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    }
  }

  const btnPublish = document.getElementById('btn-form-publish');
  if (btnPublish) btnPublish.onclick = () => publishForm();

  const btnFormNew = document.getElementById('btn-form-new');
  if (btnFormNew) {
    btnFormNew.onclick = async () => {
      const msg = document.getElementById('msg-forms-list') || document.getElementById('msg-forms');
      if (msg) {
        msg.className = 'msg';
        msg.textContent = 'Creating…';
      }
      try {
        const data = await api('/forms', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Contact form',
            embed_on_page: true,
            embed_enabled: true,
            add_to_nav: false,
            target_page_slug: 'contact',
          }),
        });
        if (data.pages) formState.pages = data.pages;
        applyFormToEditor(data.form || {}, data.embed);
        await loadForms();
        if (msg) {
          msg.className = 'msg ok';
          msg.textContent = 'Form created.';
        }
      } catch (e) {
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = e.message;
        }
      }
    };
  }

  const btnFormBack = document.getElementById('btn-form-back');
  if (btnFormBack) {
    btnFormBack.onclick = () => {
      showFormsList();
      loadForms().catch(() => {});
    };
  }

  const btnFormDelete = document.getElementById('btn-form-delete');
  if (btnFormDelete) {
    btnFormDelete.onclick = async () => {
      if (!formState.editingId) return;
      if (!window.confirm('Delete this form? Submissions for it will be removed.')) return;
      const msg = document.getElementById('msg-forms');
      msg.className = 'msg';
      msg.textContent = 'Deleting…';
      try {
        await api(`/forms/${formState.editingId}`, { method: 'DELETE' });
        formState.editingId = null;
        showFormsList();
        await loadForms();
        msg.className = 'msg ok';
        msg.textContent = 'Form deleted.';
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = e.message;
      }
    };
  }

  initMcpEndpointUi();

  const btnMcpCopyConfig = document.getElementById('btn-mcp-copy-config');
  if (btnMcpCopyConfig) {
    btnMcpCopyConfig.onclick = () => copyText(mcpCursorSnippet(mcpEndpoint(), '<YOUR_MCP_TOKEN>'));
  }
  const btnMcpCopyUrl = document.getElementById('btn-mcp-copy-url');
  if (btnMcpCopyUrl) {
    btnMcpCopyUrl.onclick = () => copyText(mcpEndpoint());
  }
  const btnMcpCopyToken = document.getElementById('btn-mcp-copy-token');
  if (btnMcpCopyToken) {
    btnMcpCopyToken.onclick = () => {
      if (!mcpLastToken) return;
      copyText(mcpLastToken);
    };
  }
  const btnMcpCopyFilled = document.getElementById('btn-mcp-copy-filled');
  if (btnMcpCopyFilled) {
    btnMcpCopyFilled.onclick = () => {
      if (!mcpLastToken) return;
      copyText(mcpCursorSnippet(mcpEndpoint(), mcpLastToken));
    };
  }
  const mcpTokensBody = document.getElementById('mcp-tokens-body');
  if (mcpTokensBody) {
    mcpTokensBody.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-mcp-revoke]');
      if (!btn) return;
      const id = btn.getAttribute('data-mcp-revoke');
      if (!window.confirm('Revoke this token? Agents using it will lose access.')) return;
      btn.disabled = true;
      try {
        await api(`/mcp/token/${id}`, { method: 'DELETE' });
        await refreshMcpTokens();
      } catch (e) {
        btn.disabled = false;
        const msg = document.getElementById('msg-mcp');
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = e.message;
        }
      }
    });
  }
  const btnMcp = document.getElementById('btn-mcp-token');
  if (btnMcp) {
    btnMcp.onclick = async () => {
      const msg = document.getElementById('msg-mcp');
      const reveal = document.getElementById('mcp-token-reveal');
      const out = document.getElementById('mcp-token-out');
      const nameEl = document.getElementById('mcp-token-name');
      msg.className = 'msg';
      msg.textContent = 'Creating token…';
      try {
        const name = nameEl ? nameEl.value.trim() : '';
        const data = await api('/mcp/token', {
          method: 'POST',
          body: JSON.stringify({ name: name || undefined }),
        });
        mcpLastToken = data.token || '';
        if (out) out.textContent = mcpLastToken;
        if (reveal) reveal.hidden = !mcpLastToken;
        msg.className = 'msg ok';
        msg.textContent = data.hint || 'Copy now — shown only once.';
        await refreshMcpTokens();
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = e.message;
      }
    };
  }
  const btnMcpUpgrade = document.getElementById('btn-mcp-upgrade');
  if (btnMcpUpgrade) {
    btnMcpUpgrade.onclick = () => showPortalPanel('billing');
  }

  const modulesTypeTabs = document.getElementById('modules-type-tabs');
  if (modulesTypeTabs) {
    modulesTypeTabs.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-module-type]');
      if (!btn) return;
      moduleState.current = btn.getAttribute('data-module-type');
      moduleState.pane = 'content';
      storeModuleType(moduleState.current);
      closeModuleModal();
      renderModuleTypeTabs();
      syncModulesPaneTabs();
      moduleMsg('', true);
      try { await loadModuleItems(); } catch (e) { moduleMsg(e.message, false); }
    });
  }

  const modulesPaneTabs = document.getElementById('modules-pane-tabs');
  if (modulesPaneTabs) {
    modulesPaneTabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-modules-pane]');
      if (!btn) return;
      const isBookings = moduleState.current === 'bookings';
      const isChatbot = moduleState.current === 'chatbot';
      if (!isBookings && !isChatbot) return;
      const next = btn.getAttribute('data-modules-pane') || 'content';
      const allowed = isChatbot
        ? new Set(['content', 'settings', 'inbox'])
        : new Set(['content', 'hours', 'appointments']);
      moduleState.pane = allowed.has(next) ? next : 'content';
      syncModulesPaneTabs();
    });
  }

  const formsPaneTabs = document.getElementById('forms-pane-tabs');
  if (formsPaneTabs) {
    formsPaneTabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-forms-pane]');
      if (!btn) return;
      setFormsPane(btn.getAttribute('data-forms-pane'));
    });
    setFormsPane('setup');
  }

  const modulesItems = document.getElementById('modules-items');
  if (modulesItems) {
    modulesItems.addEventListener('click', async (ev) => {
      const editBtn = ev.target.closest('[data-module-edit]');
      if (editBtn) {
        const id = Number(editBtn.getAttribute('data-module-edit'));
        const item = (moduleState.items || []).find((x) => Number(x.id) === id);
        if (item) openModuleEditor(item);
      }
    });
  }

  const modulesBookingRoot = document.querySelector('.modules-admin-main')
    || document.getElementById('modules-pane-hours')
    || document.getElementById('modules-booking-panel');
  if (modulesBookingRoot) {
    modulesBookingRoot.addEventListener('change', async (ev) => {
      if (ev.target && ev.target.id === 'booking-show-archived') {
        moduleState.showArchivedAppointments = !!ev.target.checked;
        moduleMsg(moduleState.showArchivedAppointments ? 'Showing archived…' : 'Hiding archived…', true);
        try {
          await loadModuleItems();
          moduleMsg('', true);
        } catch (e) {
          moduleMsg(e.message, false);
        }
      }
    });
    modulesBookingRoot.addEventListener('click', async (ev) => {
      const archiveBtn = ev.target.closest('[data-appt-archive]');
      if (archiveBtn) {
        const id = Number(archiveBtn.getAttribute('data-appt-archive'));
        const archived = archiveBtn.getAttribute('data-archived') === 'true';
        moduleMsg(archived ? 'Archiving…' : 'Restoring…', true);
        try {
          await api(`/modules/bookings/appointments/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ archived }),
          });
          moduleMsg(archived ? 'Appointment archived.' : 'Appointment restored.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(e.message, false);
        }
        return;
      }
      const apptBtn = ev.target.closest('[data-appt-status]');
      if (apptBtn) {
        const id = Number(apptBtn.getAttribute('data-appt-status'));
        const status = apptBtn.getAttribute('data-status');
        moduleMsg('Updating appointment…', true);
        try {
          await api(`/modules/bookings/appointments/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
          });
          moduleMsg('Appointment updated.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(e.message, false);
        }
        return;
      }
      if (ev.target && ev.target.id === 'btn-booking-hours-save') {
        const hoursRoot = document.getElementById('modules-pane-hours') || modulesBookingRoot;
        const hours = [];
        BOOKING_WEEKDAYS.forEach((_, i) => {
          const on = hoursRoot.querySelector(`[data-bh-day="${i}"]`);
          const range = hoursRoot.querySelector(`[data-bh-range="${i}"]`);
          if (!on || !on.checked || !range) return;
          const parts = String(range.value || '').split(/[–-]/).map((s) => s.trim());
          if (parts.length >= 2) {
            hours.push({ weekday: i, start_time: parts[0], end_time: parts[1] });
          }
        });
        moduleMsg('Saving hours…', true);
        try {
          await api('/modules/bookings/hours', {
            method: 'PUT',
            body: JSON.stringify({ hours }),
          });
          moduleMsg('Hours saved.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(e.message, false);
        }
        return;
      }
      if (ev.target && ev.target.id === 'btn-booking-settings-save') {
        const auto = document.getElementById('booking-auto-confirm');
        const notice = document.getElementById('booking-min-notice');
        const ahead = document.getElementById('booking-max-ahead');
        moduleMsg('Saving settings…', true);
        try {
          await api('/modules/bookings/settings', {
            method: 'PUT',
            body: JSON.stringify({
              auto_confirm: !!(auto && auto.checked),
              min_notice_hours: notice ? Number(notice.value) : undefined,
              max_days_ahead: ahead ? Number(ahead.value) : undefined,
            }),
          });
          moduleMsg('Settings saved.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(e.message, false);
        }
      }
    });
  }

  const btnModulesNew = document.getElementById('btn-modules-new');
  if (btnModulesNew) {
    btnModulesNew.onclick = () => openModuleEditor(null);
  }

  const modulesItemModal = document.getElementById('modules-item-modal');
  if (modulesItemModal) {
    modulesItemModal.addEventListener('click', (ev) => {
      if (ev.target === modulesItemModal) closeModuleModal();
    });
  }

  const btnModulesCancel = document.getElementById('btn-modules-cancel');
  if (btnModulesCancel) btnModulesCancel.onclick = () => closeModuleModal();

  const btnModulesSave = document.getElementById('btn-modules-save');
  if (btnModulesSave) {
    btnModulesSave.onclick = async () => {
      moduleModalMsg('Saving…', true);
      const body = collectModuleFields();
      const type = moduleState.current;
      try {
        if (type === 'chatbot') {
          const pending = moduleState.pendingKnowledgeFiles || [];
          if (pending.length) {
            moduleModalMsg(`Uploading & extracting ${pending.length} file${pending.length === 1 ? '' : 's'}…`, true);
            const up = await uploadChatbotKnowledgeFiles(pending, body.title);
            const uploaded = (up && up.items) || (up && up.item ? [up.item] : []);
            // Editing with a new file: remove the old row after successful upload.
            if (moduleState.editingId && uploaded.length) {
              try {
                await api(`/modules/chatbot/${moduleState.editingId}`, { method: 'DELETE' });
              } catch { /* keep new uploads even if old delete fails */ }
            }
            // Also persist link/notes fields if they filled those without relying only on files.
            const hasLinkOrNotes = String(body.url || '').trim() || String(body.content_text || '').trim();
            if (hasLinkOrNotes && !moduleState.editingId) {
              await api('/modules/chatbot', {
                method: 'POST',
                body: JSON.stringify({
                  kind: body.kind || (body.url ? 'link' : 'doc'),
                  title: body.title || 'Notes',
                  url: body.url || '',
                  content_text: body.content_text || '',
                  status: body.status || 'active',
                }),
              });
            }
            moduleState.pendingKnowledgeFiles = [];
            closeModuleModal();
            const n = uploaded.length || pending.length;
            moduleMsg(`Uploaded ${n} knowledge file${n === 1 ? '' : 's'} (text extracted for the agent).`, true);
            await loadModules();
            return;
          }
        }
        if (moduleState.editingId) {
          await api(`/modules/${encodeURIComponent(type)}/${moduleState.editingId}`, {
            method: 'PUT',
            body: JSON.stringify(body),
          });
        } else {
          await api(`/modules/${encodeURIComponent(type)}`, {
            method: 'POST',
            body: JSON.stringify(body),
          });
        }
        closeModuleModal();
        moduleMsg('Saved.', true);
        await loadModules();
      } catch (e) {
        moduleModalMsg(e.message, false);
      }
    };
  }

  const btnModulesDelete = document.getElementById('btn-modules-delete');
  if (btnModulesDelete) {
    btnModulesDelete.onclick = async () => {
      if (!moduleState.editingId) return;
      if (!window.confirm('Delete this item?')) return;
      moduleModalMsg('Deleting…', true);
      try {
        await api(`/modules/${encodeURIComponent(moduleState.current)}/${moduleState.editingId}`, {
          method: 'DELETE',
        });
        closeModuleModal();
        moduleMsg('Deleted.', true);
        await loadModules();
      } catch (e) {
        moduleModalMsg(e.message, false);
      }
    };
  }

  const btnModulesAttach = document.getElementById('btn-modules-attach');
  if (btnModulesAttach) {
    btnModulesAttach.onclick = async () => {
      moduleMsg('Adding to site…', true);
      const pageSel = document.getElementById('modules-target-page');
      try {
        await api(`/modules/${encodeURIComponent(moduleState.current)}/attach`, {
          method: 'POST',
          body: JSON.stringify({
            target_page_slug: pageSel ? pageSel.value : undefined,
            toSite: true,
          }),
        });
        moduleMsg('Module embedded on your site.', true);
        await loadModules();
        if (state.previewUrl) loadEditablePreview(state.previewUrl).catch(() => {});
      } catch (e) {
        moduleMsg(e.message, false);
      }
    };
  }

  const btnModulesDetach = document.getElementById('btn-modules-detach');
  if (btnModulesDetach) {
    btnModulesDetach.onclick = async () => {
      moduleMsg('Removing from site…', true);
      try {
        await api(`/modules/${encodeURIComponent(moduleState.current)}/detach`, {
          method: 'POST',
          body: '{}',
        });
        moduleMsg('Removed from site.', true);
        await loadModules();
        if (state.previewUrl) loadEditablePreview(state.previewUrl).catch(() => {});
      } catch (e) {
        moduleMsg(e.message, false);
      }
    };
  }

  const btnModulesUpgrade = document.getElementById('btn-modules-upgrade');
  if (btnModulesUpgrade) {
    btnModulesUpgrade.onclick = () => showPortalPanel('billing');
  }

  const upsellClose = document.getElementById('upsell-tip-close');
  if (upsellClose) upsellClose.onclick = () => hideUpsellTip();
  const upsellUpgrade = document.getElementById('upsell-tip-upgrade');
  if (upsellUpgrade) {
    upsellUpgrade.onclick = () => {
      hideUpsellTip();
      showPortalPanel('billing');
    };
  }

  document.getElementById('btn-manage-billing').onclick = async () => {
    const msg = document.getElementById('msg-billing');
    msg.className = 'msg';
    msg.textContent = 'Opening billing…';
    try {
      const data = await api('/billing/portal', { method: 'POST', body: '{}' });
      if (data.url) location.href = data.url;
      else throw new Error('No portal URL returned');
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    }
  };

  const buyCreditsBtn = document.getElementById('btn-buy-credits');
  if (buyCreditsBtn) {
    buyCreditsBtn.onclick = async () => {
      const msg = document.getElementById('msg-billing');
      msg.className = 'msg';
      msg.textContent = 'Opening credits checkout…';
      try {
        const data = await api('/billing/credits/checkout', {
          method: 'POST',
          body: JSON.stringify({ quantity: 1 }),
        });
        if (data.url) location.href = data.url;
        else throw new Error('No checkout URL returned');
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = e.message;
      }
    };
  }

  async function startPortalCheckout(plan) {
    return startPortalChangePlan(plan);
  }

  async function startPortalChangePlan(plan) {
    const msg = document.getElementById('msg-billing');
    const target = String(plan || '');
    const isFree = target === 'free';
    if (isFree) {
      const ok = window.confirm(
        'Downgrade to Free?\n\nYour paid plan stays active until the end of the current billing period. After that you move to Free — no further charges.'
      );
      if (!ok) return;
    }
    msg.className = 'msg';
    msg.textContent = isFree
      ? 'Scheduling downgrade…'
      : (target === 'premium' ? 'Upgrading…' : 'Updating plan…');
    try {
      const data = await api('/billing/change-plan', {
        method: 'POST',
        body: JSON.stringify({ plan: target }),
      });
      if (data.url) {
        location.href = data.url;
        return;
      }
      msg.className = 'msg ok';
      msg.textContent = data.message
        || (data.action === 'cancel_at_period_end'
          ? 'Cancellation scheduled — you keep access until the period ends.'
          : data.action === 'updated'
            ? 'Plan updated.'
            : 'Done.');
      await loadBilling();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    }
  }

  async function startPortalResume() {
    const msg = document.getElementById('msg-billing');
    msg.className = 'msg';
    msg.textContent = 'Keeping your plan…';
    try {
      const data = await api('/billing/resume', { method: 'POST', body: '{}' });
      msg.className = 'msg ok';
      msg.textContent = data.message || 'Cancellation withdrawn — your plan will renew.';
      await loadBilling();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    }
  }

  async function tryMagicLogin() {
    let magic = '';
    try {
      magic = new URLSearchParams(window.location.search).get('magic') || '';
    } catch { /* ignore */ }
    if (!magic) return false;
    const msg = document.getElementById('msg-login');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = 'Signing in with your link…';
    }
    setTab('login');
    try {
      await api('/magic-login', {
        method: 'POST',
        body: JSON.stringify({ token: magic }),
      });
      // Strip token from the address bar without reloading.
      try {
        const u = new URL(window.location.href);
        u.searchParams.delete('magic');
        window.history.replaceState({}, '', u.pathname + u.search + u.hash);
      } catch { /* ignore */ }
      return true;
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = e.message || 'That sign-in link is invalid or expired.';
      }
      return false;
    }
  }

  (async function boot() {
    await mountCaptchas();
    try {
      const usedMagic = await tryMagicLogin();
      if (usedMagic) {
        await loadDashboard();
        return;
      }
      await loadDashboard();
    } catch (err) {
      showPortalLogin();
      const authFail = err && (
        err.code === 'AUTH_REQUIRED'
        || err.code === 'SESSION_IDLE'
        || err.message === 'AUTH_REQUIRED'
      );
      const msg = document.getElementById('msg-login');
      if (msg && err && err.code === 'SESSION_IDLE') {
        msg.className = 'msg err';
        msg.textContent = err.message || 'Signed out after 30 hours of inactivity. Please sign in again.';
      } else if (!authFail && err && err.message && msg) {
        msg.className = 'msg err';
        msg.textContent = /unavailable|failed|network|fetch/i.test(err.message)
          ? 'Could not restore your session — check your connection and refresh.'
          : err.message;
      }
    }
  })();
})();
