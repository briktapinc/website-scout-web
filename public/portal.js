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

  const PORTAL_PANELS = ['website', 'changes', 'forms', 'modules', 'social', 'billing'];
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
    billing: 'billing',
    plans: 'billing',
    subscribe: 'billing',
  };

  function parsePortalPanelQuery() {
    try {
      const panel = new URLSearchParams(location.search).get('panel');
      if (!panel) return null;
      return PANEL_ALIASES[String(panel).toLowerCase()] || null;
    } catch {
      return null;
    }
  }

  function parsePortalHash() {
    // Hash wins once set. ?panel= is only a deep-link seed (OAuth / emails).
    // Preferring query over hash made tab clicks snap back after hashchange.
    const raw = String(location.hash || '').replace(/^#\/?/, '').trim().toLowerCase();
    const key = raw.split(/[/?&#]/)[0] || '';
    if (key) return PANEL_ALIASES[key] || null;
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
      msg.textContent = 'If we have a project for that email, a password is on its way. Check your inbox, then log in.';
      document.getElementById('login-email').value = email;
      setTab('login');
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
    if (/^html:\d+:\d+$/.test(id) && data.html) {
      await handleListMutate({
        action: 'freeform-save',
        pageIndex: data.pageIndex,
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
    const menuMeta = data.menu[state.structurePageIdx];
    const freeform = !!(menuMeta && menuMeta.freeform);
    if (hintEl) hintEl.hidden = !freeform;
    const sections = page && Array.isArray(page.sections) ? page.sections : [];
    const insertGap = (afterIndex) =>
      `<div class="structure-insert-row"><button type="button" data-struct-insert="${afterIndex}" `
      + `${busy ? 'disabled' : ''} aria-label="Insert module section">+</button></div>`;

    if (freeform && !sections.length) {
      secsEl.innerHTML = `${insertGap(0)}<p class="hint">Freeform page — + adds a module block in the page HTML.</p>`;
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
  }

  function closeStructurePageModal() {
    const backdrop = document.getElementById('structure-page-modal');
    if (backdrop) backdrop.hidden = true;
    const msg = document.getElementById('msg-structure-page');
    if (msg) { msg.className = 'msg'; msg.textContent = ''; }
  }

  async function openStructureModuleModal(afterIndex) {
    state.structureInsertAfter = Number(afterIndex);
    const backdrop = document.getElementById('structure-module-modal');
    const listEl = document.getElementById('structure-module-list');
    const msg = document.getElementById('msg-structure-module');
    if (!backdrop || !listEl) return;
    if (msg) { msg.className = 'msg'; msg.textContent = ''; }
    listEl.innerHTML = '<p class="hint">Loading modules…</p>';
    backdrop.hidden = false;
    try {
      let mods = moduleState.summary && Array.isArray(moduleState.summary.modules)
        ? moduleState.summary.modules : null;
      if (!mods) {
        const data = await api('/modules');
        mods = Array.isArray(data.modules) ? data.modules : [];
        moduleState.summary = data;
      }
      if (!moduleState.enabled && moduleState.summary && !moduleState.summary.siteModules) {
        listEl.innerHTML = '<p class="hint">Site modules require Standard or Premium.</p>';
        return;
      }
      listEl.innerHTML = mods.map((m) =>
        `<button type="button" data-structure-module-type="${esc(m.type)}">${esc(m.label || m.type)}</button>`
      ).join('') || '<p class="hint">No modules available.</p>';
    } catch (e) {
      listEl.innerHTML = '';
      if (msg) { msg.className = 'msg err'; msg.textContent = e.message || 'Could not load modules'; }
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
    }, 'Module section saved.');
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
        hint.innerHTML = '<strong>Edit mode</strong> — edit text, choose fonts, replace images (click) or ★ AI generate, set your logo, or + Add / × on lists and cards.';
      }
    }
    if (saveBtn) saveBtn.disabled = n === 0 || state.imageUploading || state.logoUploading;
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
      <iframe title="Website preview" src="${esc(previewUrl)}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
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
    if (!keepEdit) state.editMode = false;
    setOpenPreview(previewUrl);
    if (lede && !keepEdit) {
      lede.textContent = 'Click Edit to change copy or images in the preview. Use the Changes tab for bigger updates.';
    }
    box.innerHTML = `
      <iframe title="Website preview" id="portal-preview-frame"
        sandbox="allow-scripts allow-same-origin"
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
        ? { action: 'freeform-save', pageIndex: data.pageIndex, html: data.html }
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
    if (data.type === 'list-mutate') {
      if (!state.editMode) return;
      handleListMutate(data);
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
    // Freeform HTML text nodes: html:pageIndex:nodeIndex
    if (/^html:\d+:\d+$/.test(id)) {
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
    const priceLabel = state.socialImagesIncluded
      ? 'included'
      : `${state.imageCredits} credit${state.imageCredits === 1 ? '' : 's'}`;

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
            <p class="post-cap">${esc(p.caption || '')}</p>
            <div class="post-actions">
              <button type="button" class="btn soft small" data-act="gen-image" data-id="${esc(p.id)}">
                Generate branded image ad (${priceLabel})
              </button>
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

  async function generateBrandedImage(postId) {
    const msg = document.getElementById('msg-social');
    const btn = document.querySelector(`[data-act="gen-image"][data-id="${postId}"]`);
    msg.className = 'msg';
    const chargeHint = state.socialImagesIncluded
      ? 'included in Premium'
      : `${state.imageCredits} credit${state.imageCredits === 1 ? '' : 's'}`;
    msg.textContent = `Generating branded image ad (${chargeHint})…`;
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
    const mcpBox = document.getElementById('mcp-agent-box');
    if (mcpBox) {
      mcpBox.hidden = !(planId === 'standard' || planId === 'premium');
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
  ];
  const MODULE_NAV_GROUPS = [
    { id: 'content', label: 'Content', types: ['blog', 'ecommerce', 'gallery', 'courses', 'directory', 'faq'] },
    { id: 'people', label: 'People', types: ['team', 'testimonials'] },
    { id: 'schedule', label: 'Schedule', types: ['events', 'bookings'] },
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
    const results = document.getElementById('modules-pane-results');
    const bookingPanel = document.getElementById('modules-booking-panel');
    const isBookings = moduleState.current === 'bookings';
    if (!isBookings) moduleState.pane = 'content';
    if (tabs) {
      tabs.hidden = !isBookings;
      tabs.setAttribute('aria-hidden', isBookings ? 'false' : 'true');
      tabs.querySelectorAll('[data-modules-pane]').forEach((btn) => {
        const on = btn.getAttribute('data-modules-pane') === moduleState.pane;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    if (content) content.hidden = isBookings && moduleState.pane === 'results';
    if (results) results.hidden = !(isBookings && moduleState.pane === 'results');
    if (bookingPanel && !isBookings) bookingPanel.hidden = true;
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
    if (status) {
      status.innerHTML = onSite
        ? `<span class="status-pill">Live</span> Showing on page “${esc(emb.target_page_slug || '—')}”`
        : 'Not on your site yet — pick a page and click <strong>Add to site</strong>.';
    }
    if (urlEl) {
      urlEl.innerHTML = emb && emb.embed_url
        ? `<details class="modules-embed-details"><summary>Embed link (for custom pages)</summary><code>${esc(emb.embed_url)}</code></details>`
        : '';
    }
    fillModulePageSelect(moduleState.pages, emb && emb.target_page_slug);
    updateModuleContentChrome();
  }

  function moduleItemTitle(it, type) {
    if (type === 'faq') return it.question || `#${it.id}`;
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
    if (type === 'testimonials' && it.author_name) bits.push(`<span>${esc(it.author_name)}</span>`);
    if (type === 'team' && it.role_title) bits.push(`<span>${esc(it.role_title)}</span>`);
    if (type === 'events') bits.push(`<span>${esc(it.starts_at || it.location || '')}</span>`);
    if (type === 'bookings') {
      bits.push(`<span>${esc(it.duration_label || (it.duration_minutes ? `${it.duration_minutes} min` : ''))}</span>`);
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
    const panel = document.getElementById('modules-booking-panel');
    if (!panel) return;
    if (moduleState.current !== 'bookings') {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }
    panel.hidden = false;
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
      ? appointments.slice(0, 40).map((a) => `
        <div class="row" style="justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8);flex-wrap:wrap">
          <div>
            <strong>${esc(a.customer_name)}</strong>
            <span class="hint"> · ${esc(a.service_name || '')} · ${esc(a.starts_at || '')}</span>
            <div class="hint">${esc(a.customer_email || a.customer_phone || '')} · ${esc(a.status)}</div>
          </div>
          <div class="row" style="gap:6px">
            ${a.status === 'pending' ? `<button type="button" class="btn soft small" data-appt-status="${a.id}" data-status="confirmed">Confirm</button>` : ''}
            ${a.status !== 'cancelled' && a.status !== 'completed' ? `<button type="button" class="btn ghost small" data-appt-status="${a.id}" data-status="cancelled">Cancel</button>` : ''}
            ${a.status === 'confirmed' ? `<button type="button" class="btn ghost small" data-appt-status="${a.id}" data-status="completed">Done</button>` : ''}
          </div>
        </div>`).join('')
      : '<p class="hint">No appointments yet. Visitors book from your site calendar.</p>';
    panel.innerHTML = `
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
        </div>
        <h3 style="margin:1.25rem 0 0.5rem">Appointments</h3>
        <div id="modules-booking-appts">${apptHtml}</div>`;
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
    const copy = moduleCopy(moduleState.current);
    const meta = MODULE_TYPES.find((m) => m.type === moduleState.current);
    if (titleEl) titleEl.textContent = moduleState.editingId ? `Edit ${copy.singular}` : copy.newBtn;
    if (ledeEl) {
      ledeEl.textContent = moduleState.editingId
        ? `Update this ${copy.singular} for your ${(meta && meta.label) || 'module'}.`
        : `Fill in the details below. You can save as draft and publish when ready.`;
    }
    if (delBtn) delBtn.hidden = !moduleState.editingId;
    const defs = moduleFieldDefs(moduleState.current);
    const src = item || { status: 'draft' };
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

  async function loadModuleItems() {
    const type = moduleState.current;
    storeModuleType(type);
    const data = await api(`/modules/${encodeURIComponent(type)}`);
    moduleState.items = Array.isArray(data.items) ? data.items : [];
    moduleState.pages = Array.isArray(data.pages) ? data.pages : moduleState.pages;
    moduleState.embed = data.embed || null;
    moduleState.booking = data.booking || null;
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
      const pick = ev.target && ev.target.closest
        ? ev.target.closest('[data-structure-module-type]') : null;
      if (pick) applyStructureInsertModule(pick.getAttribute('data-structure-module-type'));
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

  const btnMcp = document.getElementById('btn-mcp-token');
  if (btnMcp) {
    btnMcp.onclick = async () => {
      const msg = document.getElementById('msg-mcp');
      msg.className = 'msg';
      msg.textContent = 'Creating token…';
      try {
        const data = await api('/mcp/token', { method: 'POST', body: '{}' });
        msg.className = 'msg ok';
        msg.textContent = `${data.hint || 'Copy now (shown once).'} Token: ${data.token}`;
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = e.message;
      }
    };
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
      if (!btn || moduleState.current !== 'bookings') return;
      moduleState.pane = btn.getAttribute('data-modules-pane') === 'results' ? 'results' : 'content';
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

  const modulesBookingPanel = document.getElementById('modules-booking-panel');
  if (modulesBookingPanel) {
    modulesBookingPanel.addEventListener('click', async (ev) => {
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
        const hours = [];
        BOOKING_WEEKDAYS.forEach((_, i) => {
          const on = modulesBookingPanel.querySelector(`[data-bh-day="${i}"]`);
          const range = modulesBookingPanel.querySelector(`[data-bh-range="${i}"]`);
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

  (async function boot() {
    await mountCaptchas();
    try {
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
