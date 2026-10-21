'use strict';

/* Website Scout web UI — hash router, Electron-parity pages.
 * All data via window.ScoutApi (public/js/api.js). Always esc() user content before innerHTML. */

const api = window.ScoutApi;
const authGate = document.getElementById('auth-gate');
const shell = document.getElementById('app-shell');
const view = document.getElementById('view');
const wsSelect = document.getElementById('workspace-select');
const autoEl = document.getElementById('shell-automation');
const topTitle = document.getElementById('top-title');
const toastHost = document.getElementById('toast-host');

const ROUTES = ['dashboard', 'leads', 'websites', 'domains', 'design', 'social', 'outreach', 'pipeline', 'jobs', 'mcp', 'settings', 'billing', 'admin'];
const ROUTE_LABELS = {
  dashboard: 'Dashboard', leads: 'Leads', websites: 'Websites', design: 'Design', social: 'Social', outreach: 'Outreach',
  pipeline: 'Pipeline', jobs: 'Jobs', mcp: 'MCP', settings: 'Settings', billing: 'Billing', admin: 'Admin',
};
let currentUserIsSuperAdmin = false;
let currentUserId = null;
let requireSubscription = false;
let userSubscribed = true;
let productAccess = true;
let subscriptionStatus = 'none';
const LEAD_STATUSES = ['new', 'researching', 'qualified', 'building', 'qa_pending', 'ready', 'outreach_pending',
  'contacted', 'engaged', 'claimed', 'trial', 'customer', 'lost'];
const DESIGN_STATUSES = ['draft', 'waiting_on_agent', 'questions_pending', 'in_progress', 'delivered'];
const DESIGN_TYPES = ['website', 'logo', 'social', 'flyer', 'brand', 'other'];
const INTENT_EVENTS = ['email.opened', 'email.clicked', 'preview.viewed', 'preview.viewed_twice', 'editor.opened',
  'text.changed', 'logo.uploaded', 'site.claimed', 'pricing.viewed', 'domain.searched', 'domain.purchased', 'trial.activated'];
const CLAIM_CLASSES = ['VERIFIED', 'AI_COPY', 'OWNER_PROVIDED', 'UNKNOWN'];
const SUPPRESSION_REASONS = ['do-not-contact', 'unsubscribed', 'bounced', 'complaint'];
const MODEL_TASKS = ['research', 'generation', 'scoring', 'email', 'qa', 'editor', 'followup', 'image', 'vision'];

let automationPaused = false;
let leadsReload = null;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const pretty = (s) => String(s == null ? '' : s).replace(/_/g, ' ');
const fmtDate = (s) => String(s || '').slice(0, 16).replace('T', ' ');
const money = (n) => '$' + (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '0.00');
const statusBadge = (s) => `<span class="badge status-${esc(s)}">${esc(pretty(s) || '—')}</span>`;

function scorePill(score) {
  const n = Number(score) || 0;
  const band = n >= 70 ? 'hot' : n >= 50 ? 'warm' : n > 0 ? 'cool' : 'none';
  return `<span class="score-pill score-${band}">${esc(n)}</span>`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function toast(text, kind) {
  if (String(text) === 'AUTH_REQUIRED') return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = String(text);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3800);
}

function setMsg(el, text, kind) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function optionList(values, selected, labelFn) {
  return values.map((v) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(labelFn ? labelFn(v) : pretty(v))}</option>`).join('');
}

function kv(k, v, raw) {
  const val = v == null || v === '' ? '—' : (raw ? v : esc(v));
  return `<div class="kv"><span class="k">${esc(k)}</span><span>${val}</span></div>`;
}

function jsonPre(obj) {
  return `<pre class="out">${esc(JSON.stringify(obj, null, 2))}</pre>`;
}

function formObject(form) {
  const out = {};
  new FormData(form).forEach((v, k) => { out[k] = typeof v === 'string' ? v.trim() : v; });
  return out;
}

function dropEmpty(obj) {
  const out = {};
  Object.keys(obj).forEach((k) => { if (obj[k] !== '' && obj[k] != null) out[k] = obj[k]; });
  return out;
}

/**
 * Normalize list payloads from /api/v1. Accepts a bare array, or an object that
 * may nest the array under common keys (and one level of accidental double-wrap).
 */
function asList(value, keys) {
  const prefer = keys || ['rows', 'jobs', 'sites', 'leads', 'templates', 'tokens', 'items', 'requests', 'versions', 'prompts'];
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (let i = 0; i < prefer.length; i++) {
    const k = prefer[i];
    if (Array.isArray(value[k])) return value[k];
  }
  for (let i = 0; i < prefer.length; i++) {
    const inner = value[prefer[i]];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const nested = asList(inner, prefer);
      if (nested.length || Array.isArray(inner.rows) || Array.isArray(inner.jobs)) return nested;
    }
  }
  return [];
}

function dataOf(res) {
  return res && res.data != null ? res.data : {};
}

function pager(host, { page, pages, total }, onPage) {
  host.innerHTML = `<button class="btn small" data-p="prev" ${page <= 1 ? 'disabled' : ''}>Prev</button>
    <span>Page ${page} of ${Math.max(1, pages || 1)} (${total || 0} total)</span>
    <button class="btn small" data-p="next" ${page >= (pages || 1) ? 'disabled' : ''}>Next</button>`;
  host.onclick = (e) => {
    const b = e.target.closest('[data-p]');
    if (!b || b.disabled) return;
    onPage(b.dataset.p === 'prev' ? page - 1 : page + 1);
  };
}

function isAuthRequired(err) {
  return !!(err && err.status === 401 && (
    err.code === 'AUTH_REQUIRED'
    || (err.data && err.data.error === 'AUTH_REQUIRED')
    || err.message === 'AUTH_REQUIRED'
  ));
}

async function safeRun(btn, fn) {
  const isBtn = btn && btn.tagName === 'BUTTON';
  if (isBtn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (isAuthRequired(err)) { goToLogin(); return undefined; }
    toast(err && err.message ? err.message : String(err), 'err');
    return undefined;
  } finally {
    if (isBtn && btn.isConnected) btn.disabled = false;
  }
}

/** data-act delegation: handlers[act](element, event). */
function delegate(root, handlers) {
  root.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    const fn = handlers[t.dataset.act];
    if (!fn) return;
    e.preventDefault();
    safeRun(t, () => fn(t, e));
  };
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => toast('Copied', 'ok'), () => toast('Copy failed', 'err'));
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('Copied', 'ok'); } catch { toast('Copy failed', 'err'); }
  ta.remove();
  return Promise.resolve();
}

const overlays = new Set();

function openModal({ title, body, wide, buttons }) {
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <h2>${esc(title)}</h2><div class="modal-body">${body || ''}</div><div class="modal-actions"></div></div>`;
  const onKey = (e) => { if (e.key === 'Escape') m.close(); };
  const m = {
    el: bd.firstElementChild,
    body: $('.modal-body', bd),
    close() { bd.remove(); document.removeEventListener('keydown', onKey); overlays.delete(m); },
  };
  overlays.add(m);
  const actions = $('.modal-actions', bd);
  (buttons || [{ label: 'Close' }]).forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + (b.cls || '');
    btn.textContent = b.label;
    btn.onclick = () => (b.onClick ? safeRun(btn, () => b.onClick(m, btn)) : m.close());
    actions.appendChild(btn);
  });
  bd.addEventListener('mousedown', (e) => { if (e.target === bd) m.close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bd);
  return m;
}

function openDrawer({ title, html, actionsHtml }) {
  const el = document.createElement('div');
  el.className = 'drawer';
  el.innerHTML = `<div class="drawer-card" role="dialog" aria-modal="true">
    <div class="drawer-header"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">&times;</button></div>
    <div class="drawer-body">${html || ''}</div>
    ${actionsHtml ? `<div class="drawer-actions">${actionsHtml}</div>` : ''}</div>`;
  const onKey = (e) => { if (e.key === 'Escape') d.close(); };
  const d = {
    el,
    body: $('.drawer-body', el),
    title: $('.drawer-header h2', el),
    close() { el.remove(); document.removeEventListener('keydown', onKey); overlays.delete(d); },
  };
  overlays.add(d);
  el.addEventListener('mousedown', (e) => { if (e.target === el) d.close(); });
  $('[data-close]', el).onclick = () => d.close();
  document.addEventListener('keydown', onKey);
  document.body.appendChild(el);
  return d;
}

/** Single-lead typeahead picker. Returns { get(), set(lead), clear() }. */
function mountLeadPicker(host, opts) {
  const o = opts || {};
  let current = null;
  let lastRows = [];
  host.classList.add('lead-picker');
  host.innerHTML = `<input type="search" class="lp-input" placeholder="${esc(o.placeholder || 'Search by name, business, or email…')}" autocomplete="off" />
    <ul class="lead-picker-results hidden"></ul><div class="lead-picker-selected hidden"></div>`;
  const input = $('.lp-input', host);
  const ul = $('.lead-picker-results', host);
  const selBox = $('.lead-picker-selected', host);

  function leadTitle(l) {
    return (l && (l.business_name || l.name)) || 'Lead';
  }
  function leadMeta(l) {
    if (!l) return '';
    return [l.email, l.city, l.phone, l.category].filter(Boolean).join(' · ');
  }
  function normalizeLead(l) {
    if (!l) return null;
    return Object.assign({}, l, {
      id: Number(l.id),
      name: leadTitle(l),
      business_name: l.business_name || l.name || null,
      meta: leadMeta(l),
    });
  }

  function renderSelected() {
    if (!current) { selBox.classList.add('hidden'); input.classList.remove('hidden'); return; }
    selBox.classList.remove('hidden');
    input.classList.add('hidden');
    const meta = leadMeta(current) || current.meta || '';
    selBox.innerHTML = `<span class="lp-selected-copy"><b>${esc(leadTitle(current))}</b> <span class="hint">#${esc(current.id)}</span>
      ${meta ? `<div class="hint">${esc(meta)}</div>` : ''}</span>
      <button type="button" class="btn small clear">Clear</button>`;
    $('.clear', selBox).onclick = () => { current = null; renderSelected(); if (o.onChange) o.onChange(null); };
  }

  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) { ul.classList.add('hidden'); lastRows = []; return; }
    try {
      const r = await api.leads({ q, pageSize: 8 });
      const rows = (r.data && r.data.leads) || [];
      lastRows = rows;
      let html = '';
      if (/^\d+$/.test(q)) {
        html += `<li><button type="button" data-id="${esc(q)}" data-fetch="1">Use lead id <b>#${esc(q)}</b></button></li>`;
      }
      html += rows.map((l) => {
        const meta = leadMeta(l);
        return `<li><button type="button" data-id="${l.id}"><b>${esc(l.business_name)}</b> <span class="hint">#${l.id}${meta ? ` · ${esc(meta)}` : ''}</span></button></li>`;
      }).join('');
      ul.innerHTML = html || '<li class="empty">No matches</li>';
      ul.classList.remove('hidden');
    } catch (e) { toast(e.message, 'err'); }
  }, 250);

  input.addEventListener('input', search);
  ul.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (!Number.isInteger(id) || id <= 0) return;
    let next = lastRows.find((r) => Number(r.id) === id) || null;
    if (!next || b.dataset.fetch === '1') {
      try {
        const r = await api.leadGet(id);
        next = (r.data && r.data.lead) || r.data || next;
      } catch (err) {
        if (!next) { toast(err.message || 'Lead not found', 'err'); return; }
      }
    }
    current = normalizeLead(next || { id, name: `Lead #${id}` });
    ul.classList.add('hidden');
    input.value = '';
    renderSelected();
    if (o.onChange) o.onChange(current);
  });
  return {
    get: () => current,
    set(lead) { current = normalizeLead(lead); renderSelected(); },
    clear() { current = null; renderSelected(); if (o.onChange) o.onChange(null); },
  };
}

/** Iframe preview with page select + desktop/mobile toggle. renderFn(slug) -> api envelope with data.html. */
function mountPreview(host, renderFn, hooks) {
  host.innerHTML = `<div class="preview-toolbar">
    <select class="pv-page" aria-label="Preview page"><option value="">All pages</option></select>
    <div class="pv-actions">
      <div class="pv-device" role="group" aria-label="Preview size">
        <button type="button" class="btn small primary pv-desktop">Desktop</button>
        <button type="button" class="btn small pv-mobile">Mobile</button>
      </div>
      <button type="button" class="btn small pv-refresh">Refresh</button>
      <span class="msg pv-msg"></span>
    </div>
  </div>
  <div class="preview-frame desktop"><iframe class="pv-frame" sandbox="allow-scripts allow-forms" title="Site preview"></iframe></div>`;
  const sel = $('.pv-page', host);
  const frame = $('.pv-frame', host);
  const box = $('.preview-frame', host);
  const msg = $('.pv-msg', host);
  let populated = false;

  function matchPageOption(slugOrFile) {
    const want = String(slugOrFile || '').trim().replace(/^\//, '').replace(/\.html$/i, '');
    if (!want || want === 'index' || want === 'home') {
      const home = [...sel.options].find((o) => o.value && (o.value === '/' || o.value === 'home' || o.value === 'index'));
      return home || null;
    }
    return [...sel.options].find((o) => {
      if (!o.value) return false;
      const v = String(o.value).replace(/^\//, '').replace(/\.html$/i, '');
      return v === want || o.value === slugOrFile;
    }) || null;
  }

  async function load() {
    setMsg(msg, 'Rendering…');
    try {
      const r = await renderFn(sel.value || undefined);
      frame.srcdoc = (r.data && r.data.html) || '<p style="font-family:sans-serif;padding:1rem">Empty render.</p>';
      const pages = (r.data && r.data.pages) || [];
      if (!populated && pages.length) {
        populated = true;
        sel.innerHTML = '<option value="">All pages</option>' + pages.map((p) => `<option value="${esc(p.slug)}">${esc(p.title || p.slug)}</option>`).join('');
      }
      setMsg(msg, '');
    } catch (e) { setMsg(msg, e.message, 'err'); }
  }
  sel.onchange = load;
  $('.pv-refresh', host).onclick = load;
  $('.pv-desktop', host).onclick = () => {
    box.className = 'preview-frame desktop';
    $('.pv-desktop', host).classList.add('primary');
    $('.pv-mobile', host).classList.remove('primary');
  };
  $('.pv-mobile', host).onclick = () => {
    box.className = 'preview-frame mobile';
    $('.pv-mobile', host).classList.add('primary');
    $('.pv-desktop', host).classList.remove('primary');
  };
  // In-preview nav posts here when a relative link has no #anchor in the stacked doc.
  const onPreviewNav = (ev) => {
    if (!ev.data || ev.data.source !== 'ws-preview-nav') return;
    if (ev.source !== frame.contentWindow || ev.origin !== 'null') return;
    if (ev.data.external) return;
    const opt = matchPageOption(ev.data.slug || ev.data.file || '');
    if (!opt || opt.value === sel.value) return;
    sel.value = opt.value;
    load();
  };
  window.addEventListener('message', onPreviewNav);
  const onPreviewMsg = (ev) => {
    if (!frame.contentWindow || ev.source !== frame.contentWindow || ev.origin !== 'null') return;
    if (!ev.data || ev.data.source !== 'ws-preview' || !['ready','element-select','element-font'].includes(ev.data.type)) return;
    if (hooks && typeof hooks.onPreview === 'function') hooks.onPreview(ev.data);
  };
  window.addEventListener('message', onPreviewMsg);
  load();
  return {
    reload: load,
    post(msg) {
      if (frame.contentWindow) frame.contentWindow.postMessage(msg, '*');
    },
    destroy() {
      window.removeEventListener('message', onPreviewNav);
      window.removeEventListener('message', onPreviewMsg);
    },
  };
}

function mergePageInnerHtml(original, inner) {
  const src = String(original || '');
  const body = String(inner || '');
  const split = src.match(/(<body\b[^>]*>)([\s\S]*)(<\/body\s*>)/i);
  if (split) return src.replace(split[0], split[1] + body + split[3]);
  return body;
}

/**
 * Sitewide Google fonts plus a per-element font, shared by design and website screens.
 * save(pages, theme) persists. preview is a mountPreview handle rendered with editable:true.
 */
function bindFontToolbar(prefix, preview, getPages, getTheme, save) {
  const fonts = window.WsFonts;
  if (!fonts) return;
  if (!document.getElementById('ws-font-catalog')) {
    const link = document.createElement('link');
    link.id = 'ws-font-catalog';
    link.rel = 'stylesheet';
    link.href = fonts.catalogHref();
    document.head.appendChild(link);
  }
  const theme = getTheme() || {};
  fonts.fillSelect($('#' + prefix + '-font-body'), theme.font || '', { defaultLabel: 'System' });
  fonts.fillSelect($('#' + prefix + '-font-heading'), theme.headingFont || '', { defaultLabel: 'Same as site font' });
  const elementSel = $('#' + prefix + '-font-element');
  fonts.fillSelect(elementSel, '', { defaultLabel: 'Site default' });
  if (elementSel) elementSel.disabled = true;
  const msg = $('#' + prefix + '-font-msg');
  let styling = false;
  let selectedId = '';



  function applyLive() {
    const picked = readFonts();
    if (preview) preview.post({source:'ws-portal', type:'site-fonts', ...picked, fontHref:fonts.hrefFor([fonts.matchName(picked.font), fonts.matchName(picked.headingFont)].filter(Boolean))});
  }

  function readFonts() {
    const body = $('#' + prefix + '-font-body');
    const head = $('#' + prefix + '-font-heading');
    let font = theme.font || fonts.SYSTEM;
    let headingFont = theme.headingFont || '';
    if (body && body.value && body.value !== '__custom__') font = fonts.stackFor(body.value);
    else if (body && body.value === '') font = fonts.SYSTEM;
    if (head && head.value && head.value !== '__custom__') headingFont = fonts.stackFor(head.value);
    else if (head && head.value === '') headingFont = '';
    return { font, headingFont };
  }

  async function persist(pages, nextTheme, okText) {
    setMsg(msg, 'Saving fonts…');
    try {
      await save(pages, nextTheme);
      Object.assign(theme, nextTheme);
      setMsg(msg, okText || 'Fonts saved.', 'ok');
      if (preview) preview.reload();
    } catch (e) {
      setMsg(msg, e.message || 'Could not save fonts', 'err');
    }
  }

  const saveBtn = $('#' + prefix + '-font-save');
  if (saveBtn) {
    saveBtn.onclick = () => {
      const picked = readFonts();
      const next = Object.assign({}, getTheme() || {}, picked);
      persist(getPages(), next, 'Site fonts saved.');
    };
  }
  ['body', 'heading'].forEach((which) => {
    const sel = $('#' + prefix + '-font-' + which);
    if (sel) sel.addEventListener('change', () => applyLive());
  });
  const editBtn = $('#' + prefix + '-font-edit');
  if (editBtn) {
    editBtn.onclick = () => {
      styling = !styling;
      editBtn.classList.toggle('primary', styling);
      editBtn.textContent = styling ? 'Done styling' : 'Style an element';
      if (elementSel) elementSel.disabled = !styling || !selectedId;
      if (preview) preview.post({ source: 'ws-portal', type: 'edit-mode', on: styling, fontsOnly: true });
      setMsg(msg, styling ? 'Click text in the preview, then choose its font.' : '');
    };
  }
  if (elementSel) {
    elementSel.addEventListener('change', () => {
      if (!preview) return;
      const name = fonts.selectedName(elementSel);

      preview.post({
        source: 'ws-portal',
        type: 'set-font',
        fontHref: name ? fonts.hrefFor([name]) : '',
        family: name ? fonts.stackFor(name) : '',
        name: name || '',
      });
    });
  }

  return {
    onPreview(data) {
      if (!data) return;
      if (data.type === 'ready') {
        applyLive();
        if (styling && preview) preview.post({ source: 'ws-portal', type: 'edit-mode', on: true, fontsOnly: true });
      }
      if (data.type === 'element-select') {
        selectedId = String(data.id || '');
        if (elementSel) {
          elementSel.disabled = !styling || !selectedId;
          elementSel.value = fonts.matchName(data.fontFamily || '') || '';
        }
      }
      if (data.type === 'element-font') {
        if (!styling || !selectedId || data.id !== selectedId || (data.html && (typeof data.html !== 'string' || data.html.length > 800000))) return;
        const id = String(data.id || '');
        const pages = getPages();
        const nextTheme = Object.assign({}, getTheme() || {});
        if (/^html:\d+:\d+$/.test(id) && data.html) {
          const pi = Number(data.pageIndex) || 0;
          const page = pages[pi];
          if (!page || typeof page.html !== 'string') {
            setMsg(msg, 'This page is not freeform HTML.', 'err');
            return;
          }
          page.html = mergePageInnerHtml(page.html, data.html);
          persist(pages, nextTheme, 'Element font saved.');
          return;
        }
        if (/^\d+:\d+:/.test(id)) {
          const map = Object.assign({}, nextTheme.elementFonts || {});
          if (!data.font) delete map[id];
          else map[id] = data.font;
          nextTheme.elementFonts = map;
          persist(pages, nextTheme, 'Element font saved.');
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Auth + shell                                                        */
/* ------------------------------------------------------------------ */

const PUBLIC_ROUTES = new Set(['login', 'register', 'forgot', 'reset', 'invite']);
let signedIn = false;

function authHashMode() {
  const { route, param } = parseHash();
  if (route === 'reset' && param) return { mode: 'reset', token: param, inviteToken: '' };
  if (route === 'invite' && param) return { mode: 'login', token: '', inviteToken: param };
  if (route === 'forgot') return { mode: 'forgot', token: '', inviteToken: '' };
  if (route === 'register') return { mode: 'register', token: '', inviteToken: '' };
  return { mode: 'login', token: '', inviteToken: '' };
}

function rememberReturnHash() {
  const hash = window.location.hash || '';
  const m = hash.match(/^#\/([a-z-]+)/);
  if (!m || PUBLIC_ROUTES.has(m[1])) return;
  try { sessionStorage.setItem('scout.returnHash', hash); } catch { /* ignore */ }
}

function consumeReturnHash() {
  let hash = '';
  try {
    hash = sessionStorage.getItem('scout.returnHash') || '';
    sessionStorage.removeItem('scout.returnHash');
  } catch { /* ignore */ }
  const m = hash.match(/^#\/([a-z-]+)/);
  if (!m || PUBLIC_ROUTES.has(m[1]) || !ROUTES.includes(m[1])) return '#/dashboard';
  return hash;
}

function goToLogin(opts) {
  signedIn = false;
  shell.classList.add('hidden');
  const forget = !!(opts && opts.forgetReturn);
  if (forget) {
    try { sessionStorage.removeItem('scout.returnHash'); } catch { /* ignore */ }
  }
  const { route } = parseHash();
  const onPublic = PUBLIC_ROUTES.has(route);
  if (!onPublic && !forget) rememberReturnHash();
  if (!onPublic && window.location.hash !== '#/login') {
    history.replaceState(null, '', window.location.pathname + window.location.search + '#/login');
  }
  const modeNow = authHashMode().mode;
  if (
    authGate
    && !authGate.classList.contains('hidden')
    && document.getElementById('auth-form')
    && authGate.dataset.mode === modeNow
  ) {
    return;
  }
  renderAuth();
}

function renderAuth(forcedMode) {
  authGate.classList.remove('hidden');
  shell.classList.add('hidden');
  const hashMode = authHashMode();
  let mode = forcedMode || hashMode.mode;
  authGate.dataset.mode = mode;
  const resetToken = hashMode.token;
  const inviteToken = hashMode.inviteToken || '';

  const inviteNote = inviteToken
    ? '<p class="hint">You were invited — sign in or register with the <strong>same email</strong> the invite was sent to, then we will join you to the workspace.</p>'
    : '';

  authGate.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand"><span class="brand-mark" style="background:#171512;color:#f3ead8">BP</span><h1>Bitpype</h1></div>
      <p class="sub">Local business desk — sign in to your workspace.</p>
      ${inviteNote}
      <div class="tabs" id="auth-tabs">
        <button type="button" class="active" data-tab="login">Log in</button>
        <button type="button" data-tab="register">Register</button>
      </div>
      <form id="auth-form">
        <div id="auth-login-fields">
          <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="username" /></div>
          <div class="field" id="pass-field"><label for="a-pass">Password</label><input id="a-pass" name="password" type="password" minlength="8" autocomplete="current-password" /></div>
        </div>
        <div id="reg-extra" class="hidden">
          <div class="field"><label for="a-name">Your name</label><input id="a-name" name="name" type="text" /></div>
          <div class="field"><label for="a-ws">Workspace name</label><input id="a-ws" name="workspaceName" type="text" placeholder="My agency" /></div>
          <label class="terms-row">
            <input type="checkbox" name="acceptTerms" id="a-terms" value="1" />
            <span>I agree to the <a href="/legal/terms.html" target="_blank" rel="noopener">Terms of Service</a> and <a href="/legal/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span>
          </label>
        </div>
        <div id="reset-extra" class="hidden">
          <div class="field"><label for="a-pass2">New password</label><input id="a-pass2" name="password2" type="password" minlength="8" autocomplete="new-password" /></div>
        </div>
        <div id="auth-captcha" class="field" style="margin:12px 0"></div>
        <button class="btn primary" type="submit" id="auth-submit" style="width:100%">Continue</button>
        <div class="msg" id="auth-msg"></div>
      </form>
      <div class="auth-links" id="auth-links">
        <button type="button" data-goto="forgot">Forgot password?</button>
        <a href="/legal/terms.html" target="_blank" rel="noopener">Terms</a>
      </div>
    </div>`;

  const tabs = $('#auth-tabs', authGate);
  const regExtra = $('#reg-extra', authGate);
  const resetExtra = $('#reset-extra', authGate);
  const passField = $('#pass-field', authGate);
  const submitBtn = $('#auth-submit', authGate);
  const links = $('#auth-links', authGate);
  const emailInput = $('#a-email', authGate);
  const passInput = $('#a-pass', authGate);

  function paintMode() {
    const isForgot = mode === 'forgot';
    const isReset = mode === 'reset';
    const isReg = mode === 'register';
    tabs.classList.toggle('hidden', isForgot || isReset);
    regExtra.classList.toggle('hidden', !isReg);
    resetExtra.classList.toggle('hidden', !isReset);
    passField.classList.toggle('hidden', isForgot);
    emailInput.required = !isReset;
    passInput.required = !isForgot && !isReset;
    if (isReset) {
      passInput.name = 'password';
      passInput.required = true;
      passInput.autocomplete = 'new-password';
      $('#a-pass2', authGate).required = true;
    }
    submitBtn.textContent = isForgot ? 'Send reset link' : isReset ? 'Set new password' : 'Continue';
    links.innerHTML = isForgot || isReset
      ? '<button type="button" data-goto="login">Back to log in</button>'
      : '<button type="button" data-goto="forgot">Forgot password?</button><a href="/legal/terms.html" target="_blank" rel="noopener">Terms</a>';
    $$('[data-tab]', authGate).forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
    $$('[data-goto]', links).forEach((btn) => {
      btn.onclick = () => {
        mode = btn.dataset.goto;
        if (mode === 'login') window.location.hash = '#/login';
        else if (mode === 'forgot') window.location.hash = '#/forgot';
        paintMode();
      };
    });
  }

  paintMode();

  let authCaptcha = { enabled: false, getToken: async () => '', reset: () => {} };
  (async () => {
    try {
      if (window.ScoutCaptcha) {
        authCaptcha = await window.ScoutCaptcha.mount($('#auth-captcha', authGate));
      }
    } catch (err) {
      console.warn('captcha mount failed', err);
    }
  })();

  $$('[data-tab]', authGate).forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.tab;
      paintMode();
      try { authCaptcha.reset && authCaptcha.reset(); } catch { /* ignore */ }
    });
  });

  $('#auth-form', authGate).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = formObject(e.target);
    const msg = $('#auth-msg', authGate);
    setMsg(msg, 'Working…');
    try {
      body.captchaToken = await authCaptcha.getToken();
      if (mode === 'forgot') {
        const r = await api.forgotPassword(body.email, body.captchaToken);
        const data = r.data || {};
        setMsg(msg, 'If that email exists, a reset link was sent.', 'ok');
        try { authCaptcha.reset && authCaptcha.reset(); } catch { /* ignore */ }
        return;
      }
      if (mode === 'reset') {
        if (body.password !== body.password2) throw new Error('Passwords do not match');
        await api.resetPassword(resetToken, body.password, body.captchaToken);
        setMsg(msg, 'Password updated. You can log in.', 'ok');
        mode = 'login';
        window.location.hash = '#/';
        paintMode();
        return;
      }
      if (mode === 'register') {
        if (!$('#a-terms', authGate).checked) throw new Error('Accept the Terms and Privacy Policy to continue');
        body.acceptTerms = true;
      }
      const res = mode === 'login' ? await api.login(body) : await api.register(body);
      signedIn = true;
      api.setWorkspaceId(res.data.workspaceId);
      if (inviteToken) {
        try {
          const inv = await api.acceptInvite(inviteToken);
          if (inv.data && inv.data.workspaceId) {
            api.setWorkspaceId(inv.data.workspaceId);
            res.data.workspaceId = inv.data.workspaceId;
            if (inv.data.workspaces) res.data.workspaces = inv.data.workspaces;
          }
          toast('Invite accepted', 'ok');
          window.location.hash = '#/dashboard';
        } catch (invErr) {
          toast(invErr.message || 'Invite failed', 'err');
        }
      }
      await bootApp(res.data);
    } catch (err) {
      try { authCaptcha.reset && authCaptcha.reset(); } catch { /* ignore */ }
      setMsg(msg, err.message, 'error');
    }
  });
}

function updateBillingBanner() {
  const el = document.getElementById('billing-banner');
  if (!el) return;
  if (subscriptionStatus === 'past_due') {
    el.classList.remove('hidden');
    el.innerHTML = `<strong>Payment past due.</strong> Update your card to keep access.
      <a href="#/billing">Open Billing</a>`;
    return;
  }
  // Core Free access always has productAccess; this banner is only for paid gates.
  if (requireSubscription && !productAccess && !currentUserIsSuperAdmin) {
    el.classList.remove('hidden');
    el.innerHTML = `<strong>Paid plan required for this feature.</strong> Upgrade to unlock Standard/Premium entitlements.
      <a href="#/billing">Go to Billing</a>`;
    return;
  }
  el.classList.add('hidden');
  el.innerHTML = '';
}

function fillWorkspaces(workspaces, currentId) {
  if (!wsSelect) return;
  wsSelect.innerHTML = asList(workspaces).map((w) =>
    `<option value="${w.id}" ${Number(w.id) === Number(currentId) ? 'selected' : ''}>${esc(w.name)} (${esc(w.role)})</option>`
  ).join('');
}

async function refreshAutomation() {
  if (!autoEl) return;
  try {
    const res = await api.stats();
    automationPaused = !!res.data.automationPaused;
    autoEl.textContent = automationPaused ? 'Automation paused' : 'Automation running';
    autoEl.classList.toggle('is-paused', automationPaused);
    autoEl.classList.toggle('is-running', !automationPaused);
  } catch {
    autoEl.textContent = 'Automation status unavailable';
    autoEl.classList.remove('is-paused', 'is-running');
  }
}

async function setAutomation(paused) {
  await api.automation(paused);
  await refreshAutomation();
  toast(paused ? 'Automation paused' : 'Automation resumed', 'ok');
}

async function bootApp(meData) {
  signedIn = true;
  authGate.classList.add('hidden');
  authGate.dataset.mode = '';
  shell.classList.remove('hidden');
  currentUserIsSuperAdmin = !!(meData.isSuperAdmin || (meData.user && meData.user.isSuperAdmin));
  currentUserId = meData.user && meData.user.id != null ? Number(meData.user.id) : null;
  requireSubscription = !!meData.requireSubscription;
  userSubscribed = meData.subscribed != null
    ? !!meData.subscribed
    : !!(meData.user && meData.user.subscribed);
  productAccess = meData.productAccess != null
    ? !!meData.productAccess
    : (userSubscribed || !!meData.workspaceSubscribed || currentUserIsSuperAdmin);
  subscriptionStatus = (meData.user && meData.user.subscriptionStatus) || 'none';
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.classList.toggle('hidden', !currentUserIsSuperAdmin);
  fillWorkspaces(meData.workspaces, meData.workspaceId || api.getWorkspaceId());
  updateBillingBanner();

  const { route, param } = parseHash();
  if (route === 'invite' && param) {
    try {
      const inv = await api.acceptInvite(param);
      if (inv.data && inv.data.workspaceId) {
        api.setWorkspaceId(inv.data.workspaceId);
        if (inv.data.workspaces) fillWorkspaces(inv.data.workspaces, inv.data.workspaceId);
      }
      toast('Invite accepted', 'ok');
      window.location.hash = '#/dashboard';
    } catch (err) {
      toast(err.message || 'Invite failed', 'err');
    }
  }

  try { await refreshAutomation(); } catch { /* paywalled */ }
  navigate();
}

function closeNav() {
  shell.classList.remove('nav-open');
  $('#sidebar-backdrop').hidden = true;
}
function openNav() {
  shell.classList.add('nav-open');
  $('#sidebar-backdrop').hidden = false;
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

async function pageDashboard() {
  const [st, act] = await Promise.all([api.stats(), api.activity({ limit: 15 }).catch(() => null)]);
  const d = st.data;
  const paused = !!d.automationPaused;
  automationPaused = paused;
  const activity = asList(act && act.data, ['rows']).length
    ? asList(act.data, ['rows'])
    : asList(d.activity);
  const byStatus = d.byStatus || {};

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="lede">${esc(d.workspace.name)} · role ${esc(d.workspace.role)}</p></div>
      <div class="page-actions" id="dash-auto"></div>
    </div>
    <div class="alert warn" id="dash-banner" ${paused ? '' : 'hidden'}>
      <strong>Automation is paused.</strong> Discovery, research, generation, scheduled jobs and outreach will not run.
      <button class="btn small" data-act="resume">Resume</button>
    </div>
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-label">Leads</div><div class="stat-value">${esc(d.leadsTotal)}</div></div>
      <div class="stat-card"><div class="stat-label">Websites</div><div class="stat-value">${esc(d.websites)}</div></div>
      <div class="stat-card"><div class="stat-label">Design waiting</div><div class="stat-value">${esc(d.designJobsWaitingOnAgent)}</div></div>
      <div class="stat-card"><div class="stat-label">Questions pending</div><div class="stat-value">${esc(d.designJobsQuestionsPending)}</div></div>
      <div class="stat-card"><div class="stat-label">Emails sent today</div><div class="stat-value">${esc(d.outreachSentToday == null ? '—' : d.outreachSentToday)}</div></div>
      <div class="stat-card"><div class="stat-label">AI spend today</div><div class="stat-value">${money(d.aiSpendTodayUsd)}</div></div>
      <div class="stat-card ${paused ? 'is-paused' : 'is-running'}"><div class="stat-label">Automation</div><div class="stat-value">${paused ? 'Paused' : 'Running'}</div></div>
    </div>
    <div class="card">
      <div class="panel-h"><h3>Leads by status</h3><a href="#/leads" class="btn small">Open leads</a></div>
      <div class="chips">${Object.keys(byStatus).length
        ? Object.keys(byStatus).map((s) => `<a class="chip" href="#/leads?status=${encodeURIComponent(s)}" style="text-decoration:none;color:inherit">${esc(pretty(s))}<span>${esc(byStatus[s])}</span></a>`).join('')
        : '<span class="hint">No leads yet — run Discover on the Leads page.</span>'}</div>
    </div>
    <div class="card">
      <div class="panel-h"><h3>Recent activity</h3></div>
      <ul class="list">${activity.length
        ? activity.map((a) => `<li>${esc(a.message)}<div class="timestamp">${esc(a.area)} · ${esc(fmtDate(a.at))}</div></li>`).join('')
        : '<li class="hint">No activity yet.</li>'}</ul>
    </div>
    <div class="card">
      <h3>Emergency stop</h3>
      <p class="hint">Immediately pauses every automated job (discovery, research, generation, outreach) and writes an audit entry.</p>
      <button class="big-danger" data-act="stop">Emergency stop</button>
    </div>`;

  $('#dash-auto').innerHTML = paused
    ? '<button class="btn primary" data-act="resume">Resume automation</button>'
    : '<button class="btn" data-act="pause">Pause automation</button>';

  delegate(view, {
    pause: async () => { await setAutomation(true); pageDashboard(); },
    resume: async () => { await setAutomation(false); pageDashboard(); },
    stop: async () => {
      if (!window.confirm('Pause ALL automation now: discovery, research, generation and outreach?')) return;
      await setAutomation(true);
      pageDashboard();
    },
  });
}

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

const leadsState = {
  q: '', status: '', minScore: '', group: '', category: '', page: 1, pageSize: 25, total: 0,
  selected: new Set(), facets: { groups: [], categories: [], tags: [] },
};

async function pageLeads(param, query) {
  if (query && query.status !== undefined) { leadsState.status = query.status; leadsState.page = 1; }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Leads</h1><p class="lede">Discover, import, score, research and qualify local businesses.</p></div>
      <div class="page-actions">
        <button class="btn primary" data-act="discover">Discover</button>
        <button class="btn" data-act="add">Add lead</button>
        <button class="btn" data-act="import">Import CSV</button>
      </div>
    </div>
    <div class="chips" id="l-chips"></div>
    <div class="toolbar">
      <input id="l-q" type="search" class="grow" placeholder="Search name, city, category, email, group…" value="${esc(leadsState.q)}" />
      <select id="l-status"><option value="">All statuses</option>${optionList(LEAD_STATUSES, leadsState.status)}</select>
      <input id="l-min" type="number" min="0" max="100" placeholder="Min score" style="width:110px" value="${esc(leadsState.minScore)}" />
      <select id="l-group"></select>
      <select id="l-cat"></select>
      <button class="btn" data-act="clear">Clear</button>
    </div>
    <div class="bulk-bar" id="l-bulk" hidden>
      <strong id="l-selcount">0 selected</strong>
      <select id="l-bulk-status"><option value="">Set status…</option>${optionList(LEAD_STATUSES, '')}</select>
      <input id="l-bulk-val" type="text" placeholder="Group or tag" style="width:150px" />
      <button class="btn small" data-act="b-group">Set group</button>
      <button class="btn small" data-act="b-tag">Add tag</button>
      <button class="btn small" data-act="b-untag">Remove tag</button>
      <button class="btn small" data-act="b-research">Research</button>
      <button class="btn small" data-act="b-campaign">Create campaign</button>
      <button class="btn small danger" data-act="b-delete">Delete</button>
      <button class="btn small" data-act="b-clear">Clear selection</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:34px"><input type="checkbox" id="l-all" aria-label="Select all" /></th><th>Business</th><th>Group</th><th>Category</th><th>Tags</th><th>Score</th><th>Status</th><th>Source</th><th>Updated</th></tr></thead>
      <tbody id="l-body"><tr><td colspan="9" class="empty">Loading…</td></tr></tbody>
    </table></div>
    <div class="pagination" id="l-pager"></div>`;

  function updateBulk() {
    const n = leadsState.selected.size;
    $('#l-bulk').hidden = n === 0;
    $('#l-selcount').textContent = n + ' selected';
  }

  async function loadFacets() {
    try { leadsState.facets = (await api.leadFacets()).data.facets || leadsState.facets; } catch { /* optional */ }
    const g = $('#l-group');
    if (!g) return;
    const f = leadsState.facets;
    const usable = (items) => (items || []).filter((i) => i.name && !String(i.name).startsWith('('));
    const opts = (items, all, cur) => `<option value="">${all}</option>` + usable(items).map((i) =>
      `<option value="${esc(i.name)}" ${i.name === cur ? 'selected' : ''}>${esc(i.name)} (${i.count})</option>`).join('');
    g.innerHTML = opts(f.groups, 'All groups', leadsState.group);
    $('#l-cat').innerHTML = opts(f.categories, 'All categories', leadsState.category);
    const chips = usable(f.groups).slice(0, 8);
    $('#l-chips').innerHTML = chips.length
      ? '<span class="hint">Hunts</span>' + chips.map((c) => `<button class="chip ${leadsState.group === c.name ? 'active' : ''}" data-act="chip" data-group="${esc(c.name)}">${esc(c.name)}<span>${c.count}</span></button>`).join('')
      : '<span class="hint">No hunt groups yet — Discover or set a group on selected leads.</span>';
  }

  async function load() {
    const body = $('#l-body');
    if (!body) return;
    const r = await api.leads({
      q: leadsState.q, status: leadsState.status, minScore: leadsState.minScore,
      group: leadsState.group, category: leadsState.category,
      page: leadsState.page, pageSize: leadsState.pageSize,
    });
    if (!$('#l-body')) return;
    const rows = asList(r.data, ['leads', 'rows']);
    leadsState.total = r.data.total || rows.length;
    body.innerHTML = rows.map((l) => `<tr>
      <td><input type="checkbox" class="row-check" data-id="${l.id}" ${leadsState.selected.has(l.id) ? 'checked' : ''} aria-label="Select lead" /></td>
      <td><button class="link-btn" data-act="open" data-id="${l.id}">${esc(l.business_name)}</button>${l.qualified ? ' <span class="badge ok">qualified</span>' : ''}<div class="hint">${esc(l.email || '')}</div></td>
      <td>${esc(l.lead_group || '—')}</td>
      <td>${esc(l.category || '—')}</td>
      <td>${(l.tags || []).slice(0, 3).map((t) => `<span class="tag-pill">${esc(t)}</span>`).join('') || '—'}</td>
      <td>${scorePill(l.score)}</td>
      <td>${statusBadge(l.status)}</td>
      <td>${esc(l.source || '—')}</td>
      <td>${esc(fmtDate(l.updated_at))}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="empty">No leads match these filters.</td></tr>';
    const pages = Math.max(1, Math.ceil(leadsState.total / leadsState.pageSize));
    pager($('#l-pager'), { page: leadsState.page, pages, total: leadsState.total }, (p) => { leadsState.page = p; load(); });
    updateBulk();
  }
  leadsReload = () => { if ($('#l-body')) { load().catch((e) => toast(e.message, 'err')); loadFacets(); } };

  const applyFilters = () => {
    leadsState.q = $('#l-q').value.trim();
    leadsState.status = $('#l-status').value;
    leadsState.minScore = $('#l-min').value;
    leadsState.group = $('#l-group').value;
    leadsState.category = $('#l-cat').value;
    leadsState.page = 1;
    load().catch((e) => toast(e.message, 'err'));
    loadFacets();
  };
  $('#l-q').addEventListener('input', debounce(applyFilters, 300));
  $('#l-min').addEventListener('input', debounce(applyFilters, 300));
  ['#l-status', '#l-group', '#l-cat'].forEach((s) => $(s).addEventListener('change', applyFilters));

  $('#l-body').addEventListener('change', (e) => {
    const cb = e.target.closest('.row-check');
    if (!cb) return;
    const id = Number(cb.dataset.id);
    if (cb.checked) leadsState.selected.add(id); else leadsState.selected.delete(id);
    updateBulk();
  });
  $('#l-all').addEventListener('change', (e) => {
    $$('.row-check', $('#l-body')).forEach((cb) => {
      cb.checked = e.target.checked;
      const id = Number(cb.dataset.id);
      if (e.target.checked) leadsState.selected.add(id); else leadsState.selected.delete(id);
    });
    updateBulk();
  });
  $('#l-bulk-status').addEventListener('change', (e) => {
    if (e.target.value) safeRun(null, () => bulk('status', e.target.value));
    e.target.value = '';
  });

  async function bulk(action, value) {
    const ids = Array.from(leadsState.selected);
    if (!ids.length) return;
    if (action === 'delete' && !window.confirm(`Delete ${ids.length} lead(s)? This cannot be undone.`)) return;
    if (['set_group', 'tag', 'untag'].includes(action) && !value) { toast('Enter a value first.', 'err'); return; }
    const r = await api.bulkLeads(action, ids, value);
    const b = r.data.bulk || {};
    toast(`Bulk ${action}: ${b.processed || 0} ok, ${b.failed || 0} failed`, b.failed ? 'err' : 'ok');
    if (action === 'delete' || action === 'status') leadsState.selected.clear();
    $('#l-all').checked = false;
    await load();
    loadFacets();
  }

  delegate(view, {
    open: (t) => openLeadDrawer(Number(t.dataset.id)),
    chip: (t) => { leadsState.group = leadsState.group === t.dataset.group ? '' : t.dataset.group; leadsState.page = 1; load(); loadFacets(); },
    clear: () => {
      Object.assign(leadsState, { q: '', status: '', minScore: '', group: '', category: '', page: 1 });
      $('#l-q').value = ''; $('#l-status').value = ''; $('#l-min').value = '';
      load(); loadFacets();
    },
    discover: () => openDiscoverModal(),
    add: () => openAddLeadModal(),
    import: () => openImportModal(),
    'b-group': () => bulk('set_group', $('#l-bulk-val').value.trim()),
    'b-tag': () => bulk('tag', $('#l-bulk-val').value.trim()),
    'b-untag': () => bulk('untag', $('#l-bulk-val').value.trim()),
    'b-research': () => bulk('research'),
    'b-delete': () => bulk('delete'),
    'b-clear': () => { leadsState.selected.clear(); $('#l-all').checked = false; load(); },
    'b-campaign': () => {
      sessionStorage.setItem('scout.campaignLeadIds', JSON.stringify(Array.from(leadsState.selected)));
      outreachTab = 'campaigns';
      window.location.hash = '#/outreach?new=1';
    },
  });

  await Promise.all([load(), loadFacets()]);
  if (query && query.id) openLeadDrawer(Number(query.id));
}

async function openDiscoverModal() {
  let providers = [];
  try { providers = ((await api.providers()).data.providers || []).filter((p) => p.name !== 'csv' && p.name !== 'manual'); } catch { /* ignore */ }
  const preferred = providers.find((p) => p.configured) || providers[0];
  const m = openModal({
    title: 'Discover leads',
    body: `<p class="hint">Searches a provider for local businesses and adds new leads. Requires a provider key (Settings → Lead discovery).</p>
      <div class="row">
        <div class="field"><label for="d-prov">Provider</label><select id="d-prov">${providers.map((p) => `<option value="${esc(p.name)}" ${preferred && preferred.name === p.name ? 'selected' : ''}>${esc(p.name)}${p.configured ? '' : ' (not configured)'}</option>`).join('') || '<option value="tavily">tavily</option>'}</select></div>
        <div class="field"><label for="d-limit">Limit</label><input id="d-limit" type="number" min="1" max="50" value="8" /></div>
      </div>
      <div class="row">
        <div class="field"><label for="d-cat">Category</label><input id="d-cat" type="text" value="Plumber" /></div>
        <div class="field"><label for="d-loc">Location</label><input id="d-loc" type="text" value="Springfield" /></div>
      </div>
      <div class="row">
        <div class="field"><label for="d-group">Hunt group (optional)</label><input id="d-group" type="text" placeholder="auto from category · location" /></div>
        <div class="field"><label for="d-web">Website</label><select id="d-web"><option value="">Any</option><option value="has">Has website</option><option value="no">No website</option></select></div>
      </div>
      <label><input id="d-score" type="checkbox" checked /> Score new leads</label>
      <div class="msg" id="d-msg"></div>`,
    buttons: [
      { label: 'Close' },
      {
        label: 'Run discovery', cls: 'primary',
        onClick: async (mm, btn) => {
          const category = $('#d-cat', mm.el).value.trim();
          const location = $('#d-loc', mm.el).value.trim();
          const msg = $('#d-msg', mm.el);
          if (!category || !location) { setMsg(msg, 'Category and location are required.', 'err'); return; }
          setMsg(msg, 'Discovering… this can take a minute.');
          btn.textContent = 'Discovering…';
          try {
            const r = await api.discover(dropEmpty({
              provider: $('#d-prov', mm.el).value,
              category, location,
              group: $('#d-group', mm.el).value.trim(),
              limit: Number($('#d-limit', mm.el).value) || 8,
              score: $('#d-score', mm.el).checked,
              websitePresence: $('#d-web', mm.el).value,
            }));
            const x = r.data;
            const names = (x.leads || []).slice(0, 8).map((l) => `#${l.id} ${esc(l.business_name)}${l.score != null ? ` (score ${esc(l.score)})` : ''}`).join('<br>');
            msg.className = 'msg ok';
            msg.innerHTML = `Provider <b>${esc(x.provider)}</b>: created <b>${esc(x.created)}</b>, skipped <b>${esc(x.skipped)}</b>, scored <b>${esc(x.scored)}</b>, queried <b>${esc(x.queried)}</b>.${x.warning ? `<br>${esc(x.warning)}` : ''}${names ? `<br><span class="hint">${names}</span>` : ''}`;
            if (leadsReload) leadsReload();
          } catch (err) { setMsg(msg, err.message, 'err'); } finally { btn.textContent = 'Run discovery'; }
        },
      },
    ],
  });
  return m;
}

function openAddLeadModal() {
  openModal({
    title: 'Add lead',
    body: `<form id="al-form">
      <div class="field"><label>Business name *</label><input name="business_name" required /></div>
      <div class="row">
        <div class="field"><label>Category</label><input name="category" /></div>
        <div class="field"><label>Hunt group</label><input name="group" /></div>
      </div>
      <div class="row">
        <div class="field"><label>Email</label><input name="email" type="email" /></div>
        <div class="field"><label>Phone</label><input name="phone" /></div>
      </div>
      <div class="row">
        <div class="field"><label>Website</label><input name="website" /></div>
        <div class="field"><label>City</label><input name="city" /></div>
        <div class="field"><label>State</label><input name="state" /></div>
      </div>
      <div class="field"><label>Tags (comma separated)</label><input name="tags" /></div>
      <div class="field"><label>Notes</label><textarea name="notes" style="min-height:60px"></textarea></div>
      <div class="msg" id="al-msg"></div></form>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create lead', cls: 'primary',
        onClick: async (m) => {
          const obj = dropEmpty(formObject($('#al-form', m.el)));
          if (!obj.business_name) { setMsg($('#al-msg', m.el), 'Business name is required.', 'err'); return; }
          if (obj.tags) obj.tags = obj.tags.split(',').map((t) => t.trim()).filter(Boolean);
          await api.createLead(obj);
          toast('Lead created', 'ok');
          m.close();
          if (leadsReload) leadsReload();
        },
      },
    ],
  });
}

function openImportModal() {
  openModal({
    title: 'Import leads from CSV',
    wide: true,
    body: `<p class="hint">Header row required. Common columns: business_name, category, email, phone, website, address, city, state, tags, group. Also accepts GapScout CSV (project, business, profile_url, location, score, opportunity, signal_evidence, platform, …).</p>
      <div class="field"><input id="im-file" type="file" accept=".csv,text/csv,text/plain" style="padding:6px" /></div>
      <div class="field"><textarea id="im-text" class="mono" placeholder="business_name,category,email,city&#10;Acme Plumbing,Plumber,hi@acme.test,Springfield"></textarea></div>
      <div class="field"><label>Hunt group (optional)</label><input id="im-group" type="text" /></div>
      <div class="msg" id="im-msg"></div>`,
    buttons: [
      { label: 'Close' },
      {
        label: 'Import', cls: 'primary',
        onClick: async (m) => {
          const text = $('#im-text', m.el).value;
          const msg = $('#im-msg', m.el);
          if (!text.trim()) { setMsg(msg, 'Paste CSV text or choose a file first.', 'err'); return; }
          const group = $('#im-group', m.el).value.trim();
          const r = await api.importLeads(text, group ? { group } : {});
          const x = r.data;
          const errs = (x.errors || []).slice(0, 8).map((e) => `line ${esc(e.line)}: ${esc(e.error)}`).join('<br>');
          msg.className = 'msg ok';
          msg.innerHTML = `Imported <b>${esc(x.created)}</b>, skipped <b>${esc(x.skipped)}</b>.${errs ? `<br><span class="hint">${errs}</span>` : ''}`;
          if (leadsReload) leadsReload();
        },
      },
    ],
  });
  const f = $('#im-file');
  f.addEventListener('change', () => {
    const file = f.files && f.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $('#im-text').value = String(reader.result || ''); };
    reader.onerror = () => toast('Could not read file.', 'err');
    reader.readAsText(file);
  });
}

async function openLeadDrawer(id) {
  const dr = openDrawer({ title: 'Lead #' + id, html: '<p class="hint">Loading…</p>' });

  async function reload() {
    const [leadR, tlR, psR, intR, siteR] = await Promise.allSettled([
      api.leadGet(id), api.leadTimeline(id, 60), api.leadProspectScore(id), api.intentGet(id), api.websiteByLead(id),
    ]);
    if (leadR.status !== 'fulfilled') {
      dr.body.innerHTML = `<p class="error">${esc(leadR.reason && leadR.reason.message)}</p>`;
      return;
    }
    const data = leadR.value.data;
    const lead = data.lead || {};
    const facts = data.facts || [];
    const timeline = tlR.status === 'fulfilled' ? (tlR.value.data.timeline || []) : (data.events || []);
    const ps = psR.status === 'fulfilled' ? psR.value.data : null;
    const intent = intR.status === 'fulfilled' ? intR.value.data : null;
    const site = siteR.status === 'fulfilled' ? siteR.value.data.site : null;
    const breakdown = ps && ps.latest ? parseJson(ps.latest.breakdown, {}) : {};

    dr.title.textContent = lead.business_name || ('Lead #' + id);
    dr.body.innerHTML = `
      <div class="inline" style="margin:10px 0 0">
        <button class="btn small" data-act="score">Score</button>
        <button class="btn small" data-act="qualify">Qualify</button>
        <button class="btn small" data-act="research">Research</button>
        <button class="btn small" data-act="dupes">Find duplicates</button>
        <button class="btn small" data-act="pipeline">Record intent</button>
        <button class="btn small danger" data-act="delete">Delete</button>
      </div>
      <div id="ld-merge"></div>
      <section><h3>Details</h3>
        <form id="ld-form">
          <div class="row">
            <div class="field"><label>Status</label><select name="status">${optionList(LEAD_STATUSES, lead.status)}</select></div>
            <div class="field"><label>Category</label><input name="category" value="${esc(lead.category || '')}" /></div>
          </div>
          <div class="row">
            <div class="field"><label>Email</label><input name="email" value="${esc(lead.email || '')}" /></div>
            <div class="field"><label>Phone</label><input name="phone" value="${esc(lead.phone || '')}" /></div>
          </div>
          <div class="row">
            <div class="field"><label>Website</label><input name="website" value="${esc(lead.website || '')}" /></div>
            <div class="field"><label>City</label><input name="city" value="${esc(lead.city || '')}" /></div>
          </div>
          <div class="field"><label>Notes</label><textarea name="notes" style="min-height:60px">${esc(lead.notes || '')}</textarea></div>
          <div class="inline"><button class="btn primary small" type="submit">Save changes</button><span class="msg" id="ld-msg"></span></div>
        </form>
        ${kv('Group', lead.lead_group)}${kv('Source', lead.source)}${kv('Tags', (lead.tags || []).join(', '))}
        ${kv('Address', [lead.address, lead.city, lead.state, lead.postal_code].filter(Boolean).join(', '))}
        ${kv('Rating', lead.rating != null ? `${lead.rating} (${lead.review_count || 0} reviews)` : '')}
        ${lead.description ? kv('Description', lead.description) : ''}
        ${lead.qualification_note ? kv('Qualification', lead.qualification_note) : ''}
      </section>
      <section><h3>Score &amp; intent</h3>
        ${kv('Score', ps ? `${ps.score} · ${ps.label}` : lead.score)}
        ${kv('Qualified', lead.qualified ? 'Yes' : 'No')}
        ${kv('Intent', intent ? `${intent.score} · ${intent.label}` : '')}
        ${Object.keys(breakdown).map((k) => kv(k, '+' + breakdown[k])).join('')}
      </section>
      <section><h3>Website</h3>
        ${site
    ? `<p><a href="#/websites/${site.id}">${esc(site.name)}</a> ${statusBadge(site.status)}</p>
           <div class="inline" style="margin-top:8px">
             <button class="btn small" data-act="postcard">Postcard / QR</button>
           </div>
           <div id="ld-claim-kit" class="hint" style="margin-top:8px"></div>`
    : `<p class="hint">No website yet.</p><button class="btn small" data-act="gen">Build template site</button>`}
      </section>
      <section><h3>Social (Facebook / Instagram)</h3>
        <p class="hint">Generate a month of posts, weekly client approval, then schedule to Meta. Images optional.</p>
        <a class="btn small" href="#/social?leadId=${esc(id)}">Open Social for this lead</a>
      </section>
      <section><h3>Facts &amp; provenance (${facts.length})</h3>
        ${facts.map((f) => `<div class="kv"><span class="k">${esc(f.fact_key)}</span><span>${esc(String(f.value).slice(0, 400))} <span class="badge claim-${esc(f.claim_class)}">${esc(f.claim_class)}</span></span>
          <span class="sub-line">source: ${esc(f.source)}${f.source_url ? ` · <a href="${esc(f.source_url)}" target="_blank" rel="noopener">link</a>` : ''} · ${esc(f.confidence)} · ${esc(fmtDate(f.fetched_at))}</span></div>`).join('') || '<p class="hint">No facts yet. Run Research.</p>'}
        <details style="margin-top:10px"><summary>Add a fact</summary>
          <form id="ld-fact">
            <div class="row">
              <div class="field"><label>Key</label><input name="fact_key" placeholder="phone" required /></div>
              <div class="field"><label>Claim class</label><select name="claim_class">${optionList(CLAIM_CLASSES, 'OWNER_PROVIDED')}</select></div>
            </div>
            <div class="field"><label>Value</label><input name="value" required /></div>
            <div class="row">
              <div class="field"><label>Source</label><input name="source" value="manual" required /></div>
              <div class="field"><label>Confidence</label><select name="confidence">${optionList(['high', 'medium', 'low'], 'medium')}</select></div>
            </div>
            <button class="btn small" type="submit">Add fact</button>
          </form>
        </details>
      </section>
      <section><h3>Timeline</h3>
        ${timeline.map((ev) => `<div class="kv"><span class="k">${esc(ev.type)}</span><span>${esc(ev.detail || '')}</span><span class="sub-line">${esc(ev.kind || '')} · ${esc(fmtDate(ev.at))}</span></div>`).join('') || '<p class="hint">No events yet.</p>'}
      </section>`;

    $('#ld-form', dr.el).onsubmit = async (e) => {
      e.preventDefault();
      const msg = $('#ld-msg', dr.el);
      try {
        await api.patchLead(id, formObject(e.target));
        setMsg(msg, 'Saved', 'ok');
        if (leadsReload) leadsReload();
      } catch (err) { setMsg(msg, err.message, 'err'); }
    };
    $('#ld-fact', dr.el).onsubmit = async (e) => {
      e.preventDefault();
      await safeRun(null, async () => {
        await api.leadFacts(id, formObject(e.target));
        toast('Fact added', 'ok');
        await reload();
      });
    };
  }

  delegate(dr.el, {
    score: async () => { const r = await api.scoreLead(id); toast('Score: ' + r.data.score, 'ok'); await reload(); if (leadsReload) leadsReload(); },
    qualify: async () => {
      const r = await api.qualifyLead(id);
      const q = r.data.lead || {};
      toast(q.qualified ? 'QUALIFIED' : 'Not qualified — ' + (q.note || 'see qualification note'), q.qualified ? 'ok' : '');
      await reload(); if (leadsReload) leadsReload();
    },
    research: async () => {
      toast('Researching…');
      const r = await api.researchLead(id);
      toast(`Research complete${r.data && r.data.facts != null ? ': ' + (r.data.facts.length != null ? r.data.facts.length : r.data.facts) + ' facts' : ''}`, 'ok');
      await reload(); if (leadsReload) leadsReload();
    },
    dupes: async () => {
      const box = $('#ld-merge', dr.el);
      const r = await api.leadDuplicates(id);
      const dups = r.data.duplicates || [];
      if (!dups.length) { box.innerHTML = '<p class="hint">No duplicate candidates found.</p>'; return; }
      box.innerHTML = `<h3 style="margin-top:14px">Merge into this lead (keeps this record)</h3>` + dups.map((d) =>
        `<label class="pick-row"><input type="checkbox" class="merge-check" value="${d.id}" /><span><b>${esc(d.business_name)}</b> (#${d.id}) — matched on ${esc((d.matched_on || []).join(', '))}</span></label>`).join('') +
        '<button class="btn danger small" data-act="merge" style="margin-top:8px">Merge selected</button>';
    },
    merge: async () => {
      const dropIds = $$('.merge-check:checked', dr.el).map((c) => Number(c.value));
      if (!dropIds.length) { toast('Select at least one duplicate.', 'err'); return; }
      if (!window.confirm(`Merge ${dropIds.length} lead(s) into #${id}? Merged records are deleted.`)) return;
      await api.mergeLeads(id, dropIds);
      toast('Merged', 'ok');
      await reload(); if (leadsReload) leadsReload();
    },
    pipeline: () => openIntentModal(id, reload),
    postcard: async () => {
      const box = $('#ld-claim-kit', dr.el);
      if (box) box.innerHTML = '<span class="hint">Loading…</span>';
      try {
        const kit = (await api.leadClaimKit(id)).data || {};
        if (box) {
          box.innerHTML = `
            ${kit.siteUrl ? `<div class="kv"><span class="k">Site</span><span><a href="${esc(kit.siteUrl)}" target="_blank" rel="noopener">${esc(kit.siteUrl)}</a></span></div>` : '<p class="hint">No site URL yet.</p>'}
            ${kit.claimUrl ? `<div class="kv"><span class="k">Claim</span><span><a href="${esc(kit.claimUrl)}" target="_blank" rel="noopener">${esc(kit.claimUrl)}</a></span></div>` : ''}
            <div class="inline" style="gap:12px;margin-top:8px;flex-wrap:wrap">
              ${kit.siteQrDataUrl ? `<img src="${esc(kit.siteQrDataUrl)}" alt="Site QR" width="96" height="96" />` : ''}
              ${kit.claimQrDataUrl ? `<img src="${esc(kit.claimQrDataUrl)}" alt="Claim QR" width="96" height="96" />` : ''}
            </div>`;
        }
        await api.leadPostcard(id);
        toast('Postcard downloaded', 'ok');
      } catch (e) {
        if (box) box.innerHTML = `<span class="error">${esc(e.message || String(e))}</span>`;
        toast(e.message || 'Postcard failed', 'err');
      }
    },
    gen: async () => {
      toast('Building template site…');
      await api.generateSite({ leadId: id, force: true, fallback: true });
      toast('Site built', 'ok');
      await reload();
    },
    delete: async () => {
      if (!window.confirm('Delete this lead?')) return;
      await api.deleteLead(id);
      toast('Lead deleted', 'ok');
      dr.close();
      if (leadsReload) leadsReload();
    },
  });
  await reload();
}

async function openIntentModal(leadId, onDone) {
  let cur = null;
  try { cur = (await api.intentGet(leadId)).data; } catch { /* optional */ }
  openModal({
    title: 'Record intent event',
    body: `<p class="hint">Current intent: <b>${esc(cur ? `${cur.score} · ${cur.label}` : '—')}</b></p>
      <div class="field"><label>Event</label><select id="in-ev">${optionList(INTENT_EVENTS, 'email.opened', (v) => v)}</select></div>
      <div class="field"><label>Note (optional)</label><input id="in-note" type="text" /></div>
      <div class="msg" id="in-msg"></div>`,
    buttons: [
      { label: 'Close' },
      {
        label: 'Record', cls: 'primary',
        onClick: async (m) => {
          const r = await api.intentRecord(leadId, $('#in-ev', m.el).value, $('#in-note', m.el).value.trim() || undefined);
          setMsg($('#in-msg', m.el), `Intent now ${r.data.score} · ${r.data.label}`, 'ok');
          if (onDone) onDone();
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Websites                                                            */
/* ------------------------------------------------------------------ */

const sitesState = { page: 1, status: '' };

async function assignDesignJob(leadId, shape) {
  let instructions = 'Design a complete custom website for this business. Use verified facts for contact details; marketing glue as AI_COPY.';
  try {
    const d = await api.designDefaultInstructions();
    if (d.data && d.data.website) instructions = d.data.website;
  } catch { /* use fallback */ }
  const r = await api.designCreate({
    type: 'website', title: 'Website for lead #' + leadId, instructions, leadId, site_shape: shape || 'multipage',
  });
  return r.data.job;
}

async function pageWebsites(param) {
  if (param) return pageWebsiteDetail(Number(param));

  view.innerHTML = `
    <div class="page-head"><div><h1>Websites</h1><p class="lede">Agent-delivered and template sites for this workspace. Open one to preview, run QA, export, restore versions or publish.</p></div></div>
    <div class="card">
      <h3>Build a website for a lead</h3>
      <div class="row end">
        <div class="field" style="flex:2"><label class="lbl">Lead</label><div id="w-lead"></div></div>
        <div class="field" style="max-width:200px"><label class="lbl" for="w-shape">Site shape</label>
          <select id="w-shape"><option value="multipage">Multi-page</option><option value="landing">Landing page</option></select></div>
      </div>
      <div class="inline">
        <button class="btn primary" data-act="assign">Assign to design agent</button>
        <button class="btn" data-act="template">Build template site</button>
        <span class="msg" id="w-msg"></span>
      </div>
    </div>
    <div class="toolbar">
      <select id="w-status"><option value="">All statuses</option>${optionList(['draft', 'qa_pending', 'approved', 'ready', 'published'], sitesState.status)}</select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Lead</th><th>Status</th><th>Origin</th><th>Updated</th><th></th></tr></thead>
      <tbody id="w-body"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
    </table></div>
    <div class="pagination" id="w-pager"></div>`;

  const picker = mountLeadPicker($('#w-lead'));

  async function load() {
    const r = await api.websites({ page: sitesState.page, pageSize: 25, status: sitesState.status });
    const body = $('#w-body');
    if (!body) return;
    const d = r.data || {};
    const sites = asList(d, ['sites', 'rows']);
    body.innerHTML = sites.map((s) => `<tr>
      <td><button class="link-btn" data-act="open" data-id="${s.id}">${esc(s.name)}</button></td>
      <td>${esc(s.business_name || ('#' + s.lead_id))}</td>
      <td>${statusBadge(s.status)}</td><td>${esc(s.origin || '—')}</td><td>${esc(fmtDate(s.updated_at))}</td>
      <td class="actions"><button type="button" class="btn small danger" data-act="delete" data-id="${s.id}" data-name="${esc(s.name)}">Delete</button></td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">No websites yet. Build one for a lead above.</td></tr>';
    pager($('#w-pager'), { page: d.page || 1, pages: d.pages || 1, total: d.total || sites.length }, (p) => { sitesState.page = p; load(); });
  }
  $('#w-status').addEventListener('change', (e) => { sitesState.status = e.target.value; sitesState.page = 1; load(); });

  delegate(view, {
    open: (t) => { window.location.hash = '#/websites/' + t.dataset.id; },
    delete: async (t) => {
      const id = Number(t.dataset.id);
      const name = t.dataset.name || ('#' + id);
      if (!window.confirm(
        `Delete website "${name}"?\n\nThis permanently removes the site record and all of its files/code from storage (export folders, previews, images, screenshots). This cannot be undone.`
      )) return;
      try {
        await api.websiteDelete(id);
        toast(`Website #${id} deleted`, 'ok');
        setMsg($('#w-msg'), `Deleted website #${id}.`, 'ok');
        await load();
      } catch (e) {
        setMsg($('#w-msg'), e.message || 'Delete failed.', 'err');
        toast(e.message || 'Delete failed', 'err');
      }
    },
    assign: async () => {
      const lead = picker.get();
      if (!lead) { setMsg($('#w-msg'), 'Select a lead first.', 'err'); return; }
      setMsg($('#w-msg'), 'Assigning to the agent…');
      const job = await assignDesignJob(lead.id, $('#w-shape').value);
      setMsg($('#w-msg'), `Design job #${job.id} is ${pretty(job.status)}.`, 'ok');
      toast(`Design job #${job.id} queued`, 'ok');
    },
    template: async () => {
      const lead = picker.get();
      if (!lead) { setMsg($('#w-msg'), 'Select a lead first.', 'err'); return; }
      if (!window.confirm('Build a local template site? This replaces an agent delivery for that lead.')) return;
      setMsg($('#w-msg'), 'Building from the template…');
      const r = await api.generateSite({ leadId: lead.id, force: true, fallback: true });
      setMsg($('#w-msg'), `Template site #${r.data.id} built.`, 'ok');
      load();
    },
  });
  await load();
}

async function pageWebsiteDetail(id) {
  const [siteR, verR, cfR] = await Promise.all([
    api.websiteGet(id), api.websiteVersions(id, { pageSize: 30 }).catch(() => null), api.cfGet().catch(() => null),
  ]);
  const site = siteR.data.site || {};
  let manifest = null;
  try { manifest = (await api.websiteByLead(site.lead_id)).data.site; } catch { /* optional */ }
  let pages = parseJson(site.pages, []);
  const theme = parseJson(site.theme, {});
  const versions = verR ? asList(verR.data, ['versions', 'rows']) : [];
  const cf = cfR ? cfR.data : null;
  let structPageIdx = 0;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/websites" class="btn small">&larr; All websites</a>
        <h1 style="margin-top:10px">${esc(site.name || 'Website #' + id)}</h1>
        <p class="lede">${statusBadge(site.status)} <span class="badge">${esc(site.origin || 'template')}</span>
          · Lead <a href="#/leads?id=${esc(site.lead_id)}">#${esc(site.lead_id)}</a> · updated ${esc(fmtDate(site.updated_at))}</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-act="qa">Run QA</button>
        <button class="btn" data-act="export">Export</button>
        <button class="btn" data-act="download-zip">Download ZIP</button>
        <button class="btn" data-act="postcard">Postcard / QR</button>
        <button class="btn" data-act="url">Preview URL</button>
        <button class="btn" data-act="photos">Add photos</button>
        <button class="btn" data-act="optimize">Optimize images</button>
        <button class="btn" data-act="regen">Regenerate</button>
        <button class="btn" data-act="assign">Assign design job</button>
        <button class="btn primary" data-act="publish">Publish to Cloudflare</button>
        <button class="btn danger" data-act="delete">Delete</button>
      </div>
    </div>
    <div class="detail-grid website-detail">
      <div>
        <div class="card"><h3>Preview</h3><div id="wd-preview"></div></div>
        <div class="card"><h3>Fonts</h3>
          <div class="font-toolbar">
            <p class="hint">Pick site fonts for a live preview update. Save to keep them, or style one element in the preview.</p>
            <div class="font-toolbar-row">
              <div class="field"><label class="lbl" for="wd-font-body">Site</label><select id="wd-font-body"></select></div>
              <div class="field"><label class="lbl" for="wd-font-heading">Headings</label><select id="wd-font-heading"></select></div>
              <button type="button" class="btn small" id="wd-font-save">Save site fonts</button>
            </div>
            <hr class="font-toolbar-divider" />
            <div class="font-toolbar-row is-actions">
              <button type="button" class="btn small" id="wd-font-edit">Style an element</button>
              <div class="field"><label class="lbl" for="wd-font-element">This element</label><select id="wd-font-element" disabled></select></div>
              <span class="msg" id="wd-font-msg"></span>
            </div>
          </div>
        </div>
      </div>
      <div>
        <div class="card"><h3>Actions &amp; results</h3>
          <div id="wd-out" class="hint">Run QA, export, or publish to see results here.</div>
          ${cf && !cf.configured ? '<p class="hint">Cloudflare is not configured. <a href="#/settings/cloudflare">Add credentials in Settings</a> to publish.</p>' : ''}
        </div>
        <div class="card"><h3>Postcard &amp; claim QR</h3>
          <p class="hint">Printable 4×6 postcard with a site QR and a claim QR (Yes / No). Claim uses the same interest path as outreach links.</p>
          <div id="wd-claim-kit" class="hint">Open Postcard / QR to load links.</div>
        </div>
        <div class="card"><h3>Preview screenshots</h3>
          <p class="hint">Desktop/mobile captures of home + services for outreach. Email uses a JPEG ≤1200px; SMS/MMS uses a &lt;900KB JPEG. Each lead gets their own site’s shots via {{site_screenshot}}.</p>
          <div id="wd-shots" class="hint">Loading…</div>
          <div class="inline" style="margin-top:8px">
            <button type="button" class="btn small" data-act="shots-regen">Regenerate screenshots</button>
            <span class="msg" id="wd-shots-msg"></span>
          </div>
        </div>
        <div class="card"><h3>Versions (${versions.length})</h3>
          <div class="shell-log shell-log-lines" tabindex="0">
            ${versions.map((v) => `<div class="shell-log-line">
              <span class="shell-dim">v${esc(v.version_no)}</span><span class="shell-main">${esc(v.note || '—')}</span>
              <span class="shell-meta">${esc(fmtDate(v.created_at))} · <button type="button" class="shell-link" data-act="restore" data-v="${v.id}">Restore</button></span>
            </div>`).join('') || '<p class="shell-empty">No versions saved yet.</p>'}
          </div>
        </div>
        <div class="card" id="wd-structure-card"><h3>Menu &amp; sections</h3>
          <p class="hint">Reorder (↑↓), nest submenu (→), or unnest (←). Home stays first; banner / hero / nav stay fixed.</p>
          <div id="wd-structure"></div>
          <span class="msg" id="wd-struct-msg"></span>
          <div class="swatches" style="margin-top:10px">${['primary', 'secondary', 'bg', 'text'].filter((k) => theme[k]).map((k) => `<span class="swatch" title="${esc(k)} ${esc(theme[k])}" style="background:${esc(theme[k])}"></span>`).join('')}</div>
        </div>
        <div class="card"><h3>Logo</h3>
          <p class="hint">Text brand name (default) or an uploaded image logo (transparent PNG, header-sized).</p>
          <div class="inline" style="align-items:center;gap:12px;margin:8px 0">
            <label><input type="radio" name="wd-logo-mode" value="text" ${theme.logoMode === 'image' && theme.logoUrl ? '' : 'checked'} /> Text</label>
            <label><input type="radio" name="wd-logo-mode" value="image" ${theme.logoMode === 'image' && theme.logoUrl ? 'checked' : ''} /> Image</label>
          </div>
          <div id="wd-logo-preview" style="min-height:48px;margin:8px 0;display:flex;align-items:center">
            ${theme.logoMode === 'image' && theme.logoUrl
    ? `<img src="${esc(theme.logoUrl)}" alt="Logo" style="max-height:44px;max-width:200px;object-fit:contain;background:repeating-conic-gradient(#eee 0% 25%,#fff 0% 50%) 50%/12px 12px" />`
    : `<strong>${esc(theme.brandName || site.name || 'Business')}</strong>`}
          </div>
          <div class="inline" style="margin-top:8px">
            <button class="btn small" data-act="logo-upload" type="button">Upload logo</button>
            <button class="btn small" data-act="logo-text" type="button">Use text logo</button>
            <span class="msg" id="wd-logo-msg"></span>
          </div>
        </div>
        <div class="card"><h3>Edit JSON</h3>
          <p class="hint">Advanced: edit pages + theme directly. Saving creates a new version.</p>
          <textarea id="wd-json" class="json" spellcheck="false">${esc(JSON.stringify({ pages, theme }, null, 2))}</textarea>
          <div class="inline" style="margin-top:8px"><button class="btn primary small" data-act="save">Save as new version</button><span class="msg" id="wd-save-msg"></span></div>
        </div>
        ${manifest && manifest.manifest ? `<div class="card"><details><summary>Claim manifest</summary>${jsonPre(manifest.manifest)}</details></div>` : ''}
      </div>
    </div>`;

  let fontHooks = null;
  const preview = mountPreview($('#wd-preview'), (slug) => api.websiteRender(id, { editable: true, pageSlug: slug }), {
    onPreview: (data) => { if (fontHooks) fontHooks.onPreview(data); },
  });
  fontHooks = bindFontToolbar('wd', preview, () => pages, () => theme, (nextPages, nextTheme) =>
    api.websiteSave(id, { pages: nextPages, theme: nextTheme, note: 'Site fonts' }));
  const out = $('#wd-out');
  const PINNED_SEC = new Set(['nav', 'hero', 'banner']);
  function isHomeLikeAdmin(p, list) {
    const slug = String((p && p.slug) || '').toLowerCase().replace(/\.html$/i, '');
    if (slug === '' || slug === '/' || slug === 'home' || slug === 'index') return true;
    return Array.isArray(list) && list[0] === p;
  }
  function sectionLabelAdmin(s, i) {
    const t = String((s && s.type) || 'block');
    const c = (s && s.content) || {};
    const title = c.title || c.heading || c.label || '';
    return title ? `${t}: ${String(title).slice(0, 40)}` : `${t} #${i + 1}`;
  }
  let structMenu = null;
  async function loadWdStructureSummary() {
    try {
      const r = await api.websiteStructure(id);
      const data = r && r.data ? r.data : r;
      structMenu = (data && data.menu) || null;
    } catch {
      structMenu = null;
    }
  }
  function renderWdStructure() {
    const host = $('#wd-structure');
    if (!host) return;
    if (!pages.length) {
      host.innerHTML = '<p class="hint">No pages.</p>';
      return;
    }
    if (structPageIdx >= pages.length) structPageIdx = Math.max(0, pages.length - 1);
    const menuItems = Array.isArray(structMenu) && structMenu.length
      ? structMenu
      : pages.map((p, i) => ({
        index: i,
        depth: (p.menuParent || p.menu_parent) ? 1 : 0,
        slug: p.slug,
        title: p.title || p.slug,
        pinned: isHomeLikeAdmin(p, pages) && i === 0,
        canUp: i > 0 && !(isHomeLikeAdmin(pages[i - 1], pages) && (i - 1) === 0),
        canDown: i < pages.length - 1 && !isHomeLikeAdmin(p, pages),
        canNest: i > 0 && !(p.menuParent || p.menu_parent) && !isHomeLikeAdmin(p, pages),
        canUnnest: !!(p.menuParent || p.menu_parent),
      }));
    const menuHtml = menuItems.map((item) => {
      const pinned = !!item.pinned;
      const depth = Number(item.depth) === 1 ? 1 : 0;
      const from = item.index != null ? item.index : 0;
      const canUp = !!item.canUp;
      const canDown = !!item.canDown;
      const canNest = !!item.canNest;
      const canUnnest = !!item.canUnnest;
      return `<div class="struct-row${pinned ? ' pinned' : ''}${depth === 1 ? ' depth-1' : ''}">
        <span class="struct-label"><strong>${esc(item.title || item.slug)}</strong> <span class="mono hint">${esc(item.slug || '')}${depth === 1 ? ' · sub' : ''}</span></span>
        <button type="button" class="btn small" data-act="menu-unnest" data-i="${from}" ${canUnnest ? '' : 'disabled'} title="Unnest">←</button>
        <button type="button" class="btn small" data-act="menu-nest" data-i="${from}" ${canNest ? '' : 'disabled'} title="Nest">→</button>
        <button type="button" class="btn small" data-act="menu-up" data-i="${from}" ${canUp ? '' : 'disabled'}>↑</button>
        <button type="button" class="btn small" data-act="menu-down" data-i="${from}" ${canDown ? '' : 'disabled'}>↓</button>
      </div>`;
    }).join('');
    const tabsHtml = pages.map((p, i) =>
      `<button type="button" class="btn small${i === structPageIdx ? ' primary' : ''}" data-act="struct-page" data-i="${i}">${esc(p.title || p.slug)}</button>`
    ).join(' ');
    const page = pages[structPageIdx];
    const secs = (page && page.sections) || [];
    const freeform = page && typeof page.html === 'string' && page.html.trim();
    let secsHtml;
    if (freeform && !secs.length) {
      secsHtml = '<p class="hint">Freeform HTML page — reorder via Menu above.</p>';
    } else {
      secsHtml = secs.map((s, i) => {
        const pinned = PINNED_SEC.has(String(s.type || '').toLowerCase());
        let canUp = !pinned && i > 0 && !PINNED_SEC.has(String(secs[i - 1].type || '').toLowerCase());
        let canDown = !pinned && i < secs.length - 1 && !PINNED_SEC.has(String(secs[i + 1].type || '').toLowerCase());
        return `<div class="struct-row${pinned ? ' pinned' : ''}">
          <span class="struct-label">${esc(sectionLabelAdmin(s, i))}${pinned ? ' <span class="hint">fixed</span>' : ''}</span>
          <button type="button" class="btn small" data-act="sec-up" data-i="${i}" ${canUp ? '' : 'disabled'}>↑</button>
          <button type="button" class="btn small" data-act="sec-down" data-i="${i}" ${canDown ? '' : 'disabled'}>↓</button>
        </div>`;
      }).join('') || '<p class="hint">No sections.</p>';
    }
    host.innerHTML = `<h4 style="margin:8px 0 6px;font-size:13px">Menu</h4>${menuHtml}
      <h4 style="margin:14px 0 6px;font-size:13px">Sections</h4>
      <div class="inline" style="flex-wrap:wrap;gap:4px;margin-bottom:8px">${tabsHtml}</div>
      ${secsHtml}`;
  }
  loadWdStructureSummary().then(() => renderWdStructure());
  renderWdStructure();

  async function loadWdShots() {
    const host = $('#wd-shots');
    if (!host) return;
    try {
      const r = await api.websiteScreenshots(id, { ready: '1' });
      const shots = (r.data && r.data.screenshots) || [];
      const captures = shots.filter((s) => s.kind === 'capture' || !s.kind);
      const renditions = shots.filter((s) => s.kind === 'email' || s.kind === 'mms');
      if (!shots.length) {
        host.innerHTML = '<p class="hint">No screenshots yet. Publish a preview, then Regenerate.</p>';
        return;
      }
      const thumb = (s) => `<div class="shot-card" style="border:1px solid var(--border);border-radius:10px;padding:8px;min-width:140px;max-width:180px">
        <a href="${esc(s.publicUrl)}" target="_blank" rel="noopener"><img src="${esc(s.publicUrl)}" alt="" style="width:100%;height:90px;object-fit:cover;border-radius:6px;background:#eee" /></a>
        <div class="hint" style="margin-top:6px">${esc(s.page)} · ${esc(s.viewport)}${s.kind && s.kind !== 'capture' ? ' · ' + esc(s.kind) : ''}</div>
        <div class="hint">${esc(fmtDate(s.capturedAt))}${s.ready === false ? ' · <span class="error">not ready</span>' : ''}</div>
        <div class="inline" style="margin-top:4px;gap:4px">
          <button type="button" class="btn small" data-act="shot-copy" data-url="${esc(s.publicUrl)}">Copy URL</button>
          <a class="btn small" href="${esc(s.publicUrl)}" target="_blank" rel="noopener">View</a>
        </div>
      </div>`;
      host.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px">${captures.map(thumb).join('')}</div>
        ${renditions.length ? `<p class="hint" style="margin-top:10px">Campaign renditions</p><div style="display:flex;flex-wrap:wrap;gap:10px">${renditions.map(thumb).join('')}</div>` : ''}`;
    } catch (e) {
      host.innerHTML = `<span class="error">${esc(e.message || 'Could not load screenshots')}</span>`;
    }
  }
  loadWdShots();

  async function wdReorder(scope, fromIndex, direction, action) {
    const msg = $('#wd-struct-msg');
    const act = String(action || 'move').toLowerCase();
    const nesting = act === 'nest' || act === 'unnest';
    setMsg(msg, nesting ? (act === 'nest' ? 'Nesting…' : 'Unnesting…') : 'Saving order…', '');
    try {
      const body = {
        scope,
        fromIndex,
        action: nesting ? act : 'move',
        pageIndex: structPageIdx,
      };
      if (!nesting) body.direction = direction;
      const r = await api.websiteReorderStructure(id, body);
      if (r && r.data && Array.isArray(r.data.pages)) pages = r.data.pages;
      else {
        const refreshed = await api.websiteGet(id);
        pages = parseJson((refreshed.data.site || {}).pages, pages);
      }
      if (r && r.data && Array.isArray(r.data.menu)) structMenu = r.data.menu;
      else await loadWdStructureSummary();
      renderWdStructure();
      const jsonEl = $('#wd-json');
      if (jsonEl) {
        try {
          const cur = JSON.parse(jsonEl.value);
          jsonEl.value = JSON.stringify({ pages, theme: cur.theme != null ? cur.theme : theme }, null, 2);
        } catch {
          jsonEl.value = JSON.stringify({ pages, theme }, null, 2);
        }
      }
      setMsg(msg, 'Order saved', 'ok');
      preview.reload();
    } catch (e) {
      setMsg(msg, e.message || 'Reorder failed', 'err');
    }
  }

  delegate(view, {
    'menu-up': async (t) => { await wdReorder('menu', Number(t.dataset.i), -1, 'move'); },
    'menu-down': async (t) => { await wdReorder('menu', Number(t.dataset.i), 1, 'move'); },
    'menu-nest': async (t) => { await wdReorder('menu', Number(t.dataset.i), 0, 'nest'); },
    'menu-unnest': async (t) => { await wdReorder('menu', Number(t.dataset.i), 0, 'unnest'); },
    'sec-up': async (t) => { await wdReorder('sections', Number(t.dataset.i), -1, 'move'); },
    'sec-down': async (t) => { await wdReorder('sections', Number(t.dataset.i), 1, 'move'); },
    'struct-page': (t) => { structPageIdx = Number(t.dataset.i) || 0; renderWdStructure(); },
    'shots-regen': async () => {
      const msg = $('#wd-shots-msg');
      setMsg(msg, 'Capturing (this can take a minute)…', '');
      try {
        await api.websiteScreenshotsCapture(id, { forcePreview: true });
        setMsg(msg, 'Screenshots updated', 'ok');
        await loadWdShots();
      } catch (e) {
        setMsg(msg, e.message || 'Capture failed', 'err');
      }
    },
    'shot-copy': async (t) => {
      const url = t.dataset.url;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        toast('URL copied', 'ok');
      } catch {
        toast(url, 'ok');
      }
    },
    qa: async () => {
      out.innerHTML = '<span class="hint">Running QA…</span>';
      const r = (await api.websiteQa(id)).data;
      out.innerHTML = `<p><strong class="${r.pass ? 'check-pass' : 'check-fail'}">${r.pass ? 'PASS' : 'FAIL'}</strong></p>
        <table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${(r.checks || []).map((c) =>
    `<tr><td class="mono">${esc(c.name)}</td><td class="${c.pass ? 'check-pass' : 'check-fail'}">${c.pass ? 'PASS' : 'FAIL'}</td><td class="hint">${esc(c.detail || '')}</td></tr>`).join('')}</tbody></table>`;
    },
    export: async () => {
      out.textContent = 'Exporting…';
      const r = (await api.websiteExport(id)).data;
      out.innerHTML = `Exported on the server to: <span class="mono">${esc(r.path)}</span>`;
    },
    'download-zip': async () => {
      out.textContent = 'Building ZIP…';
      try {
        const r = await api.websiteExportZip(id);
        out.innerHTML = `Downloaded <span class="mono">${esc(r.filename)}</span>${r.bytes != null ? ` (${esc(String(r.bytes))} bytes)` : ''}.`;
      } catch (e) {
        out.innerHTML = `<span class="error">ZIP failed: ${esc(e.message || String(e))}</span>`;
      }
    },
    postcard: async () => {
      const box = $('#wd-claim-kit');
      out.textContent = 'Building postcard…';
      if (box) box.innerHTML = '<span class="hint">Loading claim kit…</span>';
      try {
        const kit = (await api.websiteClaimKit(id)).data || {};
        if (box) {
          box.innerHTML = `
            <div class="row" style="gap:16px;align-items:flex-start;flex-wrap:wrap">
              <div style="flex:1;min-width:160px">
                <div class="hint">View your site</div>
                ${kit.siteUrl ? `<a href="${esc(kit.siteUrl)}" target="_blank" rel="noopener" class="mono" style="word-break:break-all;font-size:0.85rem">${esc(kit.siteUrl)}</a>` : '<span class="hint">No preview URL yet — use Preview URL / Publish first.</span>'}
                ${kit.siteQrDataUrl ? `<div style="margin-top:8px"><img src="${esc(kit.siteQrDataUrl)}" alt="Site QR" width="120" height="120" style="image-rendering:pixelated" /></div>` : ''}
              </div>
              <div style="flex:1;min-width:160px">
                <div class="hint">Scan to claim (Yes / No)</div>
                ${kit.claimUrl ? `<a href="${esc(kit.claimUrl)}" target="_blank" rel="noopener" class="mono" style="word-break:break-all;font-size:0.85rem">${esc(kit.claimUrl)}</a>` : '<span class="error">Claim URL unavailable</span>'}
                ${kit.claimQrDataUrl ? `<div style="margin-top:8px"><img src="${esc(kit.claimQrDataUrl)}" alt="Claim QR" width="120" height="120" style="image-rendering:pixelated" /></div>` : ''}
              </div>
            </div>`;
        }
        const r = await api.websitePostcard(id);
        out.innerHTML = `Downloaded postcard <span class="mono">${esc(r.filename)}</span>${r.bytes != null ? ` (${esc(String(r.bytes))} bytes)` : ''}.`;
        toast('Postcard downloaded', 'ok');
      } catch (e) {
        out.innerHTML = `<span class="error">Postcard failed: ${esc(e.message || String(e))}</span>`;
        if (box && !box.querySelector('img')) {
          box.innerHTML = `<span class="error">${esc(e.message || String(e))}</span>`;
        }
      }
    },
    url: async () => {
      out.textContent = 'Publishing preview…';
      const r = (await api.websitePreview(id, false, { force: true })).data;
      const link = r.url
        ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>`
        : esc(r.path || '');
      out.innerHTML = `Public preview: ${link}${r.via ? `<div class="hint">via ${esc(r.via)}${r.project ? ` · project ${esc(r.project)}` : ''}</div>` : ''}`;
    },
    photos: async () => {
      out.textContent = 'Pulling photos…';
      const r = (await api.websiteImages(id, {})).data;
      out.textContent = `Added ${r.count} photo(s) for “${r.query}”.`;
      preview.reload();
    },
    optimize: async () => {
      out.textContent = 'Optimizing images (resize/compress; may take a minute)…';
      try {
        const r = (await api.websiteOptimizeImages(id, {})).data || {};
        const n = r.changed != null ? r.changed : (r.optimized != null ? r.optimized : r.count);
        const saved = r.savedBytes != null ? r.savedBytes : (r.bytesSaved != null ? r.bytesSaved : r.saved_bytes);
        out.innerHTML = `Image optimize finished${n != null ? `: <strong>${esc(String(n))}</strong> file(s) changed` : ''}${saved != null ? ` · saved ${esc(String(saved))} bytes` : ''}.`
          + (r.pagesUpdated != null ? `<div class="hint">Pages updated: ${esc(String(r.pagesUpdated))}</div>` : '');
        preview.reload();
      } catch (e) {
        out.innerHTML = `<span class="error">${esc(e.message || 'Optimize failed')}</span>`;
      }
    },
    regen: async () => {
      if (!window.confirm('Rebuild this site with fresh AI marketing copy? Layout resets to the template.')) return;
      out.textContent = 'Regenerating…';
      await api.generateSite({ leadId: site.lead_id, force: true });
      pageWebsiteDetail(id);
    },
    assign: async () => {
      const job = await assignDesignJob(site.lead_id, 'multipage');
      out.innerHTML = `Design job <a href="#/design/${job.id}">#${esc(job.id)}</a> is ${esc(pretty(job.status))}.`;
    },
    publish: async () => {
      out.textContent = 'Exporting and publishing…';
      const r = (await api.cfPublish(id)).data;
      if (r.ok === false) {
        out.innerHTML = `<span class="error">Publish failed: ${esc(r.error)}</span>${r.hint || r.detail ? `<div class="hint">${esc(r.hint || r.detail)}</div>` : ''}`;
        return;
      }
      out.innerHTML = `Published${r.url ? `: <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>` : ''}${r.project ? `<div class="hint">Project ${esc(r.project)}</div>` : ''}`;
    },
    delete: async () => {
      const name = site.name || ('#' + id);
      if (!window.confirm(
        `Delete website "${name}"?\n\nThis permanently removes the site record and all of its files/code from storage (export folders, previews, images, screenshots). This cannot be undone.`
      )) return;
      out.textContent = 'Deleting…';
      try {
        await api.websiteDelete(id);
        toast(`Website #${id} deleted`, 'ok');
        window.location.hash = '#/websites';
      } catch (e) {
        out.innerHTML = `<span class="error">${esc(e.message || 'Delete failed')}</span>`;
      }
    },
    restore: async (t) => {
      if (!window.confirm('Restore this version? The current state is saved as a new version first.')) return;
      await api.websiteRestore(Number(t.dataset.v));
      toast('Version restored', 'ok');
      pageWebsiteDetail(id);
    },
    save: async () => {
      const msg = $('#wd-save-msg');
      let parsed;
      try { parsed = JSON.parse($('#wd-json').value); } catch (e) { setMsg(msg, 'Invalid JSON: ' + e.message, 'err'); return; }
      const r = await api.websiteSave(id, { pages: parsed.pages, theme: parsed.theme, note: 'Manual edit from web UI' });
      setMsg(msg, `Saved as version ${r.data.version.version_no}`, 'ok');
      preview.reload();
    },
    'logo-text': async () => {
      const msg = $('#wd-logo-msg');
      setMsg(msg, 'Switching to text logo…', '');
      try {
        await api.websiteLogo(id, { mode: 'text' });
        toast('Using text logo', 'ok');
        pageWebsiteDetail(id);
      } catch (e) {
        setMsg(msg, e.message || 'Failed', 'err');
      }
    },
    'logo-upload': async () => {
      const msg = $('#wd-logo-msg');
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp,image/gif';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        setMsg(msg, 'Uploading logo…', '');
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Could not read file'));
            reader.readAsDataURL(file);
          });
          const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          await api.websiteLogo(id, { mode: 'image', data: b64, mimeType: file.type });
          toast('Logo uploaded', 'ok');
          pageWebsiteDetail(id);
        } catch (e) {
          setMsg(msg, e.message || 'Upload failed', 'err');
        }
      };
      input.click();
    },
  });
}

/* ------------------------------------------------------------------ */
/* Design                                                              */
/* ------------------------------------------------------------------ */

const designState = { page: 1, status: '' };

function erRowHtml(r, withJob) {
  return `<div class="q-card">
    <div><b>${esc(r.subject || '(no subject)')}</b> <span class="badge">${esc(r.request_kind)}</span> ${statusBadge(r.status)}</div>
    <div class="hint">from ${esc(r.from_email || 'unknown')} · ${esc(fmtDate(r.received_at))}${withJob ? ` · job ${r.design_job_id ? `<a href="#/design/${r.design_job_id}">#${esc(r.design_job_id)}</a>` : 'unlinked'}` : ''}</div>
    <p style="white-space:pre-wrap;margin:6px 0">${esc(r.body_excerpt || r.body || '')}</p>
    <div class="inline">
      ${r.status !== 'submitted' && r.status !== 'dismissed' ? `<button class="btn small primary" data-act="er-submit" data-id="${r.id}" data-job="${esc(r.design_job_id || '')}">Submit to agent</button>
      <button class="btn small" data-act="er-use" data-id="${r.id}">Use as instructions</button>
      <button class="btn small danger" data-act="er-dismiss" data-id="${r.id}">Dismiss</button>` : ''}
    </div></div>`;
}

/** Pull change-request body from merged job.instructions (headers written by requestAgentChange / client form). */
function extractQueuedChangeText(instructions, kind) {
  const text = String(instructions || '');
  if (!text.trim()) return '';
  const headers = kind === 'improvements'
    ? ['=== IMPROVEMENTS REQUEST ===', '=== CLIENT CHANGE REQUEST ===']
    : ['=== REDESIGN REQUEST ===', '=== CLIENT CHANGE REQUEST ==='];
  for (const header of headers) {
    const start = text.indexOf(header);
    if (start < 0) continue;
    let body = text.slice(start + header.length).replace(/^\s*\n/, '');
    const next = body.search(/\n=== [A-Z]/);
    if (next >= 0) body = body.slice(0, next);
    // Strip trailing scope notes appended by the queue helpers.
    body = body
      .replace(/\n\(Visual review used[\s\S]*$/i, '')
      .replace(/\nScope:[\s\S]*$/i, '')
      .trim();
    if (body) return body.slice(0, 6000);
  }
  return '';
}

/**
 * Resolve text for the redesign / improvement instruction boxes.
 * Prefer: pending inbound email → queued job instructions → latest review suggestions.
 */
function resolveChangeBoxText(job, kind) {
  const review = job && job.review;
  const reviewText = kind === 'improvements'
    ? String((review && review.improvement_instructions) || '').trim()
    : String((review && review.redesign_instructions) || '').trim();

  const pending = (job && Array.isArray(job.email_redesigns) ? job.email_redesigns : [])
    .filter((r) => r && (r.request_kind === kind || (!r.request_kind && kind === 'redesign'))
      && r.status !== 'submitted' && r.status !== 'dismissed');
  if (pending.length) {
    const latest = pending[0];
    const body = String(latest.body || latest.body_excerpt || '').trim();
    if (body) return body.slice(0, 6000);
  }

  const queued = extractQueuedChangeText(job && job.instructions, kind);
  if (queued && (!job.request_kind || job.request_kind === kind)) return queued;

  // After a client/operator queue, review.*_instructions may hold the same text.
  return reviewText.slice(0, 6000);
}

function fillChangeInstructionBoxes(job, reviewOverride) {
  const review = reviewOverride || (job && job.review) || null;
  const viewJob = review && review !== (job && job.review)
    ? Object.assign({}, job || {}, { review })
    : job;
  const redesignEl = $('#dd-redesign');
  const improveEl = $('#dd-improve');
  if (redesignEl) redesignEl.value = resolveChangeBoxText(viewJob, 'redesign');
  if (improveEl) improveEl.value = resolveChangeBoxText(viewJob, 'improvements');
}

/** Design learning panel (status, playbook, distill/clear). Used on Design + Settings. */
async function mountLearning(host) {
  async function load() {
    host.innerHTML = '<p class="hint">Loading learning status…</p>';
    let res;
    try { res = (await api.learningPlaybook()).data; } catch (e) { host.innerHTML = `<p class="error">Learning unavailable: ${esc(e.message)}</p>`; return; }
    const st = res.status || {};
    const pb = res.playbook || [];
    host.innerHTML = `
      <p class="hint">Last learned: ${esc(st.last_learned_at ? new Date(st.last_learned_at).toLocaleString() : 'never')} · Events: ${esc(st.event_count == null ? '—' : st.event_count)}
        · Email msgs: ${esc(st.email_event_count == null ? '—' : st.email_event_count)} · Playbook: ${pb.length}${st.enabled === false ? ' · (learning off)' : ''}</p>
      <textarea readonly class="mono" placeholder="No lessons yet — run a review or redesign to start learning.">${esc(pb.map((b, i) => `${i + 1}. [${b.category || 'general'}] ${b.lesson || ''}`).join('\n'))}</textarea>
      <div class="inline" style="margin-top:8px">
        <button class="btn small" data-lr="refresh">Refresh</button>
        <button class="btn small primary" data-lr="distill">Distill now</button>
        <button class="btn small" data-lr="clear-playbook">Clear playbook</button>
        <button class="btn small danger" data-lr="clear-all">Clear all learning</button>
        <span class="msg" data-lr-msg></span>
      </div>`;
  }
  host.onclick = (e) => {
    const b = e.target.closest('[data-lr]');
    if (!b) return;
    const msg = () => $('[data-lr-msg]', host);
    safeRun(b, async () => {
      const act = b.dataset.lr;
      if (act === 'refresh') { await load(); return; }
      if (act === 'distill') {
        const r = (await api.learningDistill(true)).data;
        await load();
        const m = msg();
        if (r && r.ok === false) setMsg(m, `Distill: ${r.reason || 'failed'} (heuristic playbook still updates on each review/edit).`, 'err');
        else setMsg(m, `Distilled${r && r.ai_used ? ' (AI)' : ''} — ${r && r.playbook_count != null ? r.playbook_count : '?'} lessons.`, 'ok');
        return;
      }
      if (act === 'clear-playbook') { await api.learningClear('playbook'); await load(); return; }
      if (act === 'clear-all') {
        if (!window.confirm('Clear all design learning events and the playbook?')) return;
        await api.learningClear('all');
        await load();
      }
    });
  };
  await load();
}

async function pageDomains() {
  const [cfRes, linkedRes, sitesRes, leadsRes] = await Promise.all([
    api.cfGet().catch(() => null),
    api.domainsList().catch(() => null),
    api.websites({ pageSize: 100 }).catch(() => null),
    api.leads({ pageSize: 200 }).catch(() => null),
  ]);
  const cf = (cfRes && cfRes.data) || {};
  const linked = asList((linkedRes && linkedRes.data) || {}, ['domains', 'rows']);
  const sites = asList((sitesRes && sitesRes.data) || {}, ['websites', 'sites', 'rows']);
  const leads = asList((leadsRes && leadsRes.data) || {}, ['leads', 'rows']);
  const siteOpts = sites.map((s) =>
    `<option value="${esc(s.id)}">#${esc(s.id)} · ${esc(s.name || 'Site')}${s.lead_id ? ` · lead ${esc(s.lead_id)}` : ''}</option>`
  ).join('');
  const leadOpts = leads.map((l) => {
    const name = l.business_name || l.name || ('Lead #' + l.id);
    const city = l.city ? ` · ${l.city}` : '';
    return `<option value="${esc(l.id)}">${esc(name)}${esc(city)}</option>`;
  }).join('');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Domains</h1>
        <p class="lede">Search and buy domains via Cloudflare Registrar, then link them to a published site (Pages custom domain). Purchase bills your Cloudflare payment method.</p>
      </div>
    </div>
    ${!cf.configured ? `<div class="card"><p class="error">Cloudflare is not configured. <a href="#/settings/cloudflare">Add token + Account ID in Settings</a> (permissions: Account · Registrar · Edit, Account · Cloudflare Pages · Edit).</p></div>` : ''}
    <div class="card">
      <h3>Search domains</h3>
      <form id="dom-search-form" class="row end">
        <div class="field" style="flex:2;min-width:200px"><label>Keyword or name</label>
          <input name="q" required placeholder="acme plumbing" autocomplete="off" /></div>
        <div class="field" style="flex:1;min-width:180px"><label>Lead (optional)</label>
          <select name="leadId"><option value="">None</option>${leadOpts}</select></div>
        <div class="field" style="flex:0 0 auto"><label>&nbsp;</label>
          <button class="btn primary" type="submit">Search</button></div>
      </form>
      <span class="msg" id="dom-search-msg"></span>
      <div id="dom-search-results" style="margin-top:12px"></div>
    </div>
    <div class="card">
      <h3>Link a domain to a site</h3>
      <p class="hint">Use a domain you just bought, or one already on this Cloudflare account. The site is published to Pages if needed, then the hostname is attached.</p>
      <form id="dom-link-form" class="row end">
        <div class="field"><label>Domain</label><input name="domain" required placeholder="example.com" /></div>
        <div class="field"><label>Website</label><select name="websiteId" required><option value="">Select…</option>${siteOpts}</select></div>
        <div class="field" style="flex:0 0 auto"><label>&nbsp;</label><button class="btn primary" type="submit">Link domain</button></div>
      </form>
      <div class="inline" style="margin-top:8px">
        <button type="button" class="btn small" id="dom-refresh-owned">Load owned CF domains</button>
        <span class="msg" id="dom-link-msg"></span>
      </div>
      <div id="dom-owned" style="margin-top:10px"></div>
    </div>
    <div class="card">
      <h3>Linked &amp; registered</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Domain</th><th>Status</th><th>Website</th><th>Price</th><th></th></tr></thead>
        <tbody id="dom-linked-body">${linked.map((d) => `
          <tr>
            <td><a href="${esc(d.publicUrl || ('https://' + d.domain))}" target="_blank" rel="noopener">${esc(d.domain)}</a>
              <div class="hint">${esc(d.pagesProject || '')}</div></td>
            <td>${esc(d.status)}${d.registrationState ? `<div class="hint">${esc(d.registrationState)}</div>` : ''}</td>
            <td>${d.websiteId ? `<a href="#/websites/${esc(d.websiteId)}">#${esc(d.websiteId)}</a>` : '—'}</td>
            <td class="mono">${d.price != null ? esc(String(d.price)) + (d.currency ? ' ' + esc(d.currency) : '') : '—'}</td>
            <td class="actions">
              ${d.status === 'registering' ? `<button class="btn small" data-act="dom-poll" data-domain="${esc(d.domain)}">Refresh status</button>` : ''}
              ${d.status === 'registered' && d.websiteId ? `<button class="btn small" data-act="dom-link-row" data-domain="${esc(d.domain)}" data-site="${esc(d.websiteId)}">Link to site</button>` : ''}
              ${d.status === 'linked' ? `<button class="btn small danger" data-act="dom-unlink" data-domain="${esc(d.domain)}">Unlink</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="5" class="empty">No domains yet — search above to get started.</td></tr>'}
        </tbody>
      </table></div>
    </div>`;

  const resultsEl = $('#dom-search-results');
  const searchMsg = $('#dom-search-msg');

  function priceLabel(d) {
    if (d.registrationCost == null) return '';
    return `${d.registrationCost}${d.currency ? ' ' + d.currency : ''}/yr`;
  }

  function renderSearchResults(domains) {
    if (!domains.length) {
      resultsEl.innerHTML = '<p class="hint">No suggestions. Try another keyword, then Check a full name like brand.com.</p>';
      return;
    }
    resultsEl.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Domain</th><th>Available</th><th>Price</th><th></th></tr></thead>
      <tbody>${domains.map((d) => `<tr>
        <td class="mono">${esc(d.domain)}</td>
        <td class="${d.registrable ? 'check-pass' : 'check-fail'}">${d.registrable ? 'Yes' : 'No'}${d.reason ? `<div class="hint">${esc(d.reason)}</div>` : ''}</td>
        <td>${esc(priceLabel(d) || '—')}</td>
        <td class="actions">
          <button type="button" class="btn small" data-act="dom-check" data-domain="${esc(d.domain)}">Check</button>
          <button type="button" class="btn small primary" data-act="dom-buy" data-domain="${esc(d.domain)}" ${d.registrable ? '' : 'disabled'}>Buy</button>
          <button type="button" class="btn small" data-act="dom-use-link" data-domain="${esc(d.domain)}">Use to link</button>
        </td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('#dom-search-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = formObject(e.target);
    setMsg(searchMsg, 'Searching…', '');
    try {
      const r = await api.domainsSearch(body.q, body.leadId ? { leadId: Number(body.leadId) } : {});
      const domains = ((r.data && r.data.domains) || []);
      setMsg(searchMsg, `${domains.length} suggestion(s)`, 'ok');
      renderSearchResults(domains);
    } catch (err) {
      setMsg(searchMsg, err.message || 'Search failed', 'err');
    }
  };

  $('#dom-link-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = formObject(e.target);
    const msg = $('#dom-link-msg');
    setMsg(msg, 'Linking (may publish preview first)…', '');
    try {
      const r = await api.domainsLink({
        domain: body.domain,
        websiteId: Number(body.websiteId),
        forcePublish: true,
      });
      setMsg(msg, `Linked — ${((r.data && r.data.publicUrl) || body.domain)}`, 'ok');
      pageDomains();
    } catch (err) {
      setMsg(msg, err.message || 'Link failed', 'err');
    }
  };

  $('#dom-refresh-owned').onclick = async () => {
    const host = $('#dom-owned');
    const msg = $('#dom-link-msg');
    setMsg(msg, 'Loading owned domains…', '');
    try {
      const r = await api.domainsOwned();
      const domains = (r.data && r.data.domains) || [];
      setMsg(msg, `${domains.length} on Cloudflare Registrar`, 'ok');
      host.innerHTML = domains.length
        ? `<div class="table-wrap"><table><thead><tr><th>Domain</th><th>Status</th><th></th></tr></thead><tbody>${
          domains.map((d) => `<tr>
            <td class="mono">${esc(d.domain)}</td>
            <td>${esc(d.status || '—')}${d.expiresAt ? `<div class="hint">expires ${esc(d.expiresAt)}</div>` : ''}</td>
            <td><button type="button" class="btn small" data-act="dom-use-link" data-domain="${esc(d.domain)}">Use to link</button></td>
          </tr>`).join('')
        }</tbody></table></div>`
        : '<p class="hint">No domains on this Cloudflare account yet.</p>';
    } catch (err) {
      setMsg(msg, err.message || 'Could not list owned domains', 'err');
    }
  };

  delegate(view, {
    'dom-check': async (t) => {
      setMsg(searchMsg, 'Checking live availability…', '');
      try {
        const r = await api.domainsCheck([t.dataset.domain]);
        const d = ((r.data && r.data.domains) || [])[0];
        if (!d) { setMsg(searchMsg, 'No check result', 'err'); return; }
        setMsg(searchMsg, d.registrable
          ? `${d.domain} is registrable${d.registrationCost != null ? ` · ${d.registrationCost} ${d.currency || ''}/yr` : ''}`
          : `${d.domain} not registrable${d.reason ? ': ' + d.reason : ''}`,
        d.registrable ? 'ok' : 'err');
      } catch (err) { setMsg(searchMsg, err.message, 'err'); }
    },
    'dom-buy': async (t) => {
      const domain = t.dataset.domain;
      const form = $('#dom-search-form');
      const leadId = form && form.leadId ? Number(form.leadId.value) : null;
      const siteSel = document.querySelector('#dom-link-form select[name="websiteId"]');
      const websiteId = siteSel && siteSel.value ? Number(siteSel.value) : null;
      if (!window.confirm(`Purchase ${domain} for 1 year on Cloudflare Registrar?\n\nThis bills the payment method on your Cloudflare account and is non-refundable.`)) return;
      setMsg(searchMsg, 'Registering…', '');
      try {
        const r = await api.domainsRegister({ domain, years: 1, leadId: leadId || undefined, websiteId: websiteId || undefined });
        const st = (r.data && r.data.status) || 'registering';
        setMsg(searchMsg, `Registration ${st} for ${domain}`, 'ok');
        if (websiteId && st === 'registered') {
          await api.domainsLink({ domain, websiteId, forcePublish: true });
        }
        pageDomains();
      } catch (err) { setMsg(searchMsg, err.message || 'Purchase failed', 'err'); }
    },
    'dom-use-link': (t) => {
      const input = document.querySelector('#dom-link-form input[name="domain"]');
      if (input) input.value = t.dataset.domain || '';
      input && input.focus();
    },
    'dom-poll': async (t) => {
      try {
        await api.domainsStatus(t.dataset.domain);
        pageDomains();
      } catch (err) { toast(err.message, 'err'); }
    },
    'dom-link-row': async (t) => {
      try {
        await api.domainsLink({ domain: t.dataset.domain, websiteId: Number(t.dataset.site), forcePublish: true });
        toast('Domain linked', 'ok');
        pageDomains();
      } catch (err) { toast(err.message, 'err'); }
    },
    'dom-unlink': async (t) => {
      if (!window.confirm(`Unlink ${t.dataset.domain} from its site?`)) return;
      try {
        await api.domainsUnlink({ domain: t.dataset.domain });
        toast('Unlinked', 'ok');
        pageDomains();
      } catch (err) { toast(err.message, 'err'); }
    },
  });
}

async function pageDesign(param) {
  if (param) return pageDesignDetail(Number(param));
  const [pend, list, er] = await Promise.all([
    api.designPending().catch(() => null),
    api.designList({ page: designState.page, pageSize: 25, status: designState.status }),
    api.emailRedesignList({ pendingOnly: 1 }).catch(() => null),
  ]);
  const counts = pend ? (pend.data.counts || { waiting_on_agent: 0, questions_pending: 0 }) : { waiting_on_agent: 0, questions_pending: 0 };
  const jobs = asList(list.data, ['jobs', 'rows']);
  const ers = er ? asList(er.data, ['requests', 'rows']) : [];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Design</h1><p class="lede">${esc(counts.waiting_on_agent)} waiting on agent · ${esc(counts.questions_pending)} questions pending. Jobs are picked up by an MCP agent (<code>design.next</code>).</p></div>
      <div class="page-actions"><button class="btn primary" data-act="new">New design job</button></div>
    </div>
    <div class="toolbar">
      <select id="dj-status"><option value="">All statuses</option>${optionList(DESIGN_STATUSES, designState.status)}</select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Title</th><th>Type</th><th>Shape</th><th>Status</th><th>Questions</th><th>Updated</th><th></th></tr></thead>
      <tbody>${jobs.map((j) => `<tr>
        <td>${j.id}</td>
        <td><button class="link-btn" data-act="open" data-id="${j.id}">${esc(j.title)}</button>${j.lead_id ? `<div class="hint">lead #${esc(j.lead_id)}</div>` : ''}</td>
        <td>${esc(j.type)}</td><td>${esc(j.site_shape || '—')}</td><td>${statusBadge(j.status)}</td>
        <td>${j.pending_questions ? `<span class="badge warn">${esc(j.pending_questions)} pending</span>` : '—'}</td>
        <td>${esc(fmtDate(j.updated_at))}</td>
        <td class="actions"><button class="btn small danger" data-act="delete" data-id="${j.id}">Delete</button></td></tr>`).join('')
    || '<tr><td colspan="8" class="empty">No design jobs yet.</td></tr>'}</tbody>
    </table></div>
    <div class="pagination" id="dj-pager"></div>
    <div class="card">
      <div class="panel-h"><h3>Email change requests</h3>
        <div class="inline">
          <button class="btn small" data-act="imap">Poll IMAP inbox</button>
          <button class="btn small" data-act="scan">Scan drop folder</button>
        </div></div>
      <p class="hint">Client replies with <code>[Job #N]</code> in the subject are matched when IMAP is on. OpenAI turns the email into agent instructions before the job is queued (needs AI key in Settings). ${er && er.data.dropDir ? `Drop folder: <span class="mono">${esc(er.data.dropDir)}</span>` : ''}</p>
      <div id="dj-er">${ers.map((r) => erRowHtml(r, true)).join('') || '<p class="hint">No pending email requests.</p>'}</div>
    </div>
    <div class="card"><details><summary>Design learning</summary><div id="dj-learning" style="margin-top:8px"></div></details></div>`;

  pager($('#dj-pager'), { page: list.data.page || 1, pages: list.data.pages || 1, total: list.data.total || 0 }, (p) => { designState.page = p; pageDesign(); });
  $('#dj-status').addEventListener('change', (e) => { designState.status = e.target.value; designState.page = 1; pageDesign(); });
  mountLearning($('#dj-learning'));

  delegate(view, {
    open: (t) => { window.location.hash = '#/design/' + t.dataset.id; },
    new: () => openNewDesignModal(),
    delete: async (t) => {
      if (!window.confirm('Delete design job #' + t.dataset.id + '?')) return;
      await api.designDelete(Number(t.dataset.id));
      toast('Deleted', 'ok');
      pageDesign();
    },
    scan: async () => {
      const r = (await api.emailRedesignScan()).data;
      toast(`Scanned ${r.scanned || 0} file(s).`, 'ok');
      pageDesign();
    },
    imap: async () => {
      const r = (await api.emailImapPoll({ force: true })).data;
      if (r.skipped) toast(r.reason === 'imap_not_configured' || r.reason === 'imap_disabled'
        ? 'Enable IMAP under Settings → Email first.'
        : (r.reason || 'IMAP skipped'), 'err');
      else toast(`IMAP: fetched ${r.fetched || 0}, processed ${r.processed || 0}.`, 'ok');
      pageDesign();
    },
    'er-submit': async (t) => {
      let jobId = t.dataset.job ? Number(t.dataset.job) : null;
      if (!jobId) {
        const v = window.prompt('Design job id to apply this request to:');
        if (!v) return;
        jobId = Number(v);
      }
      await api.emailRedesignSubmit(Number(t.dataset.id), { designJobId: jobId });
      toast('Submitted to the agent queue', 'ok');
      pageDesign();
    },
    'er-use': (t) => {
      const r = ers.find((x) => String(x.id) === t.dataset.id);
      if (r && r.design_job_id) window.location.hash = '#/design/' + r.design_job_id;
      else toast('Link this request to a job first (submit with a job id).');
    },
    'er-dismiss': async (t) => { await api.emailRedesignDismiss(Number(t.dataset.id)); pageDesign(); },
  });
}

async function openNewDesignModal() {
  let defaults = '';
  try { defaults = (await api.designDefaultInstructions()).data.website || ''; } catch { /* optional */ }
  const m = openModal({
    title: 'New design job',
    wide: true,
    body: `<div class="row">
        <div class="field"><label>Type</label><select id="nd-type">${optionList(DESIGN_TYPES, 'website')}</select></div>
        <div class="field" id="nd-shape-wrap"><label>Site shape</label><select id="nd-shape"><option value="multipage">Multi-page</option><option value="landing">Landing page</option></select></div>
      </div>
      <div class="field"><label>Title *</label><input id="nd-title" type="text" /></div>
      <div class="row">
        <div class="field" style="flex:2"><label>Lead (optional)</label><div id="nd-lead"></div></div>
        <div class="field"><label>Contact email (optional)</label><input id="nd-email" type="email" /></div>
      </div>
      <div class="field"><label>Instructions *</label><textarea id="nd-instr" style="min-height:160px">${esc(defaults)}</textarea></div>
      <div class="msg" id="nd-msg"></div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Queue for agent', cls: 'primary',
        onClick: async (mm) => {
          const type = $('#nd-type', mm.el).value;
          const title = $('#nd-title', mm.el).value.trim();
          const instructions = $('#nd-instr', mm.el).value.trim();
          if (!title || !instructions) { setMsg($('#nd-msg', mm.el), 'Title and instructions are required.', 'err'); return; }
          const lead = picker.get();
          const r = await api.designCreate(dropEmpty({
            type, title, instructions, leadId: lead ? lead.id : undefined,
            contactEmail: $('#nd-email', mm.el).value.trim(),
            site_shape: type === 'website' ? $('#nd-shape', mm.el).value : undefined,
          }));
          toast(`Job #${r.data.job.id} queued`, 'ok');
          mm.close();
          window.location.hash = '#/design/' + r.data.job.id;
        },
      },
    ],
  });
  const picker = mountLeadPicker($('#nd-lead', m.el));
  $('#nd-type', m.el).addEventListener('change', (e) => {
    $('#nd-shape-wrap', m.el).classList.toggle('hidden', e.target.value !== 'website');
    if (e.target.value !== 'website' && $('#nd-instr', m.el).value === defaults) $('#nd-instr', m.el).value = '';
    else if (e.target.value === 'website' && !$('#nd-instr', m.el).value.trim()) $('#nd-instr', m.el).value = defaults;
  });
}

function reviewHtml(r) {
  if (!r) return '<p class="hint">No review yet. Run a review to get QA notes on the delivered site.</p>';
  const items = [];
  ['issues', 'findings', 'problems', 'notes', 'suggestions', 'recommendations'].forEach((k) => {
    if (Array.isArray(r[k])) r[k].forEach((x) => items.push(typeof x === 'string' ? x : (x.message || x.text || x.issue || JSON.stringify(x))));
  });
  return `<p>${r.pass === true ? '<span class="check-pass">PASS</span>' : r.pass === false ? '<span class="check-fail">NEEDS WORK</span>' : ''} <span class="hint">${esc(fmtDate(r.at))}</span></p>
    ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
    ${items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
    <details><summary>Raw review</summary>${jsonPre(r)}</details>`;
}

/** Instruction-review layer (SAFE / BETTER_PATH / PUSH_BACK) from brief.change_request_review. */
function changeRequestReviewHtml(crr) {
  if (!crr || typeof crr !== 'object') return '';
  const cls = String(crr.classification || crr.class || '').toUpperCase();
  const badge = cls === 'SAFE' ? 'check-pass'
    : (cls === 'PUSH_BACK' || cls === 'PUSHBACK') ? 'check-fail'
      : cls ? 'badge warn' : 'hint';
  const plan = crr.plan || crr.agent_plan || '';
  const msg = crr.clientMessage || crr.client_message || '';
  return `<div class="card" style="margin:0 0 10px;padding:10px 12px;background:var(--surface-2,transparent)">
      <p style="margin:0 0 6px"><strong>Change-request review</strong>
        ${cls ? ` <span class="${badge}">${esc(cls)}</span>` : ''}
        ${crr.at ? `<span class="hint"> · ${esc(fmtDate(crr.at))}</span>` : ''}</p>
      ${msg ? `<p style="margin:0 0 6px">${esc(msg)}</p>` : ''}
      ${plan ? `<p class="hint" style="margin:0;white-space:pre-wrap">${esc(typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2))}</p>` : ''}
      <details style="margin-top:6px"><summary>Raw classification</summary>${jsonPre(crr)}</details>
    </div>`;
}

async function pageDesignDetail(id) {
  const r = await api.designGet(id);
  const job = r.data.job;
  const questions = job.questions || [];
  const deliverable = job.deliverable;
  const hasSite = !!(deliverable && Array.isArray(deliverable.pages) && deliverable.pages.length);
  const ers = job.email_redesigns || [];
  const brief = job.brief;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/design" class="btn small">&larr; All design jobs</a>
        <h1 style="margin-top:10px">#${esc(job.id)} ${esc(job.title)}</h1>
        <p class="lede">${statusBadge(job.status)} <span class="badge">${esc(job.type)}</span>
          ${job.site_shape ? `<span class="badge">${esc(job.site_shape)}</span>` : ''}
          ${job.request_kind ? `<span class="badge warn">${esc(job.request_kind)}</span>` : ''}
          ${job.lead_id ? ` · Lead <a href="#/leads?id=${esc(job.lead_id)}">#${esc(job.lead_id)}</a>` : ''}
          · updated ${esc(fmtDate(job.updated_at))}</p>
      </div>
      <div class="page-actions"><button class="btn danger" data-act="delete">Delete job</button></div>
    </div>
    <div class="detail-grid">
      <div>
        <div class="card"><h3>Instructions</h3>
          <pre class="shell-log" tabindex="0">${esc(job.instructions || '') || '<span class="shell-empty">(no instructions)</span>'}</pre>
          ${job.type === 'website' ? `<div class="shell-actions"><label class="lbl" for="dd-shape">Site shape</label>
            <select id="dd-shape">${optionList(['multipage', 'landing'], job.site_shape || 'multipage')}</select>
            <button type="button" class="shell-link" data-act="shape">Update shape</button></div>` : ''}
        </div>

        <div class="card"><h3>Questions from the agent (${questions.length})</h3>
          ${questions.map((q) => `<div class="q-card ${q.answer == null ? 'pending' : ''}">
            <div><b>Q${esc(q.id)}:</b> ${esc(q.question)}</div>
            ${q.answer != null
    ? `<div class="hint" style="margin-top:4px">Answer${q.from_email ? ' from ' + esc(q.from_email) : ''} · ${esc(fmtDate(q.answered_at))}</div><div style="white-space:pre-wrap">${esc(q.answer)}</div>`
    : `<textarea id="qa-${q.id}" placeholder="Your answer…"></textarea><button class="btn small primary" data-act="answer" data-q="${q.id}" style="margin-top:6px">Send answer</button>`}
          </div>`).join('') || '<p class="hint">No questions.</p>'}
        </div>

        <div class="card"><h3>Client contact</h3>
          <div class="row end">
            <div class="field"><label class="lbl" for="dd-contact">Contact email</label><input id="dd-contact" type="email" value="${esc(job.contact_email || '')}" /></div>
            <div class="field"><label class="lbl" for="dd-contact-phone">Contact phone</label><input id="dd-contact-phone" type="tel" value="${esc(job.contact_phone || '')}" placeholder="+1 555 555 5555" /></div>
            <div class="field" style="flex:0 0 auto"><button class="btn" data-act="contact">Save contact</button></div>
          </div>
          <div class="inline">
            <button class="btn small" data-act="email-q">Email questions</button>
            <button class="btn small" data-act="email-d" ${deliverable && job.type !== 'website' ? '' : 'disabled'} title="${job.type === 'website' ? 'Use preview/export for websites' : ''}">Email delivery</button>
            <button class="btn small" data-act="client-form">Client form link</button>
            <span class="hint">${job.questions_emailed_at ? 'Questions emailed ' + esc(fmtDate(job.questions_emailed_at)) + '. ' : ''}${job.delivery_emailed_at ? 'Delivery emailed ' + esc(fmtDate(job.delivery_emailed_at)) + '.' : ''}</span>
          </div>
          <p class="hint" style="margin-top:8px">Emails include a public form link so clients can answer questions or request changes without IMAP.</p>
          <div id="dd-form-link" class="hint mono" style="margin-top:6px;word-break:break-all"></div>
          <details style="margin-top:10px"><summary>Record a client reply</summary>
            <div class="field"><label class="lbl">From email (optional)</label><input id="dd-rfrom" type="email" /></div>
            <div class="field"><label class="lbl">Reply text</label><textarea id="dd-reply" placeholder="Paste the reply. For multiple questions use 1. … 2. … or Q12: …"></textarea></div>
            <button class="btn small primary" data-act="reply">Record reply</button>
          </details>
          <div id="dd-email-out" class="hint" style="margin-top:8px"></div>
        </div>

        <div class="card"><h3>Review &amp; changes</h3>
          ${changeRequestReviewHtml(brief && brief.change_request_review)}
          <div id="dd-review">${reviewHtml(job.review)}</div>
          <div class="inline" style="margin:8px 0"><button class="btn" data-act="review" ${hasSite ? '' : 'disabled'}>Run review</button>${hasSite ? '' : '<span class="hint">Needs a delivered website.</span>'}</div>
          <div class="field"><label class="lbl">Redesign instructions</label><textarea id="dd-redesign" placeholder="Bigger changes: new look, structure, tone…"></textarea>
            <button class="btn small" data-act="redesign" style="margin-top:6px" ${hasSite ? '' : 'disabled'}>Queue redesign</button></div>
          <div class="field"><label class="lbl">Improvement instructions</label><textarea id="dd-improve" placeholder="Polish and fixes only…"></textarea>
            <button class="btn small" data-act="improve" style="margin-top:6px" ${hasSite ? '' : 'disabled'}>Queue improvements</button></div>
          <div id="dd-change-out" class="hint"></div>
        </div>
      </div>

      <div>
        <div class="card"><h3>Delivery</h3>
          ${deliverable
    ? `${hasSite ? `<div class="font-toolbar">
               <p class="hint">Google fonts for this design. Preview updates as you pick; Save keeps site fonts. Style one element in the preview when needed.</p>
               <div class="font-toolbar-row">
                 <div class="field"><label class="lbl" for="dd-font-body">Site</label><select id="dd-font-body"></select></div>
                 <div class="field"><label class="lbl" for="dd-font-heading">Headings</label><select id="dd-font-heading"></select></div>
                 <button type="button" class="btn small" id="dd-font-save">Save site fonts</button>
               </div>
               <hr class="font-toolbar-divider" />
               <div class="font-toolbar-row is-actions">
                 <button type="button" class="btn small" id="dd-font-edit">Style an element</button>
                 <div class="field"><label class="lbl" for="dd-font-element">This element</label><select id="dd-font-element" disabled></select></div>
                 <span class="msg" id="dd-font-msg"></span>
               </div>
             </div><div id="dd-preview"></div>` : ''}
               <div class="inline" style="margin-top:8px">
                 ${job.type === 'website' ? '<button class="btn small" data-act="url">Preview URL</button>' : ''}
                 <button class="btn small" data-act="photos">Add Pexels photos</button>
                 <button class="btn small" data-act="genimg">Generate image</button>
                 ${job.website_id ? `<a class="btn small" href="#/websites/${esc(job.website_id)}">Open website</a>` : ''}
               </div>
               <div id="dd-delivery-out" class="hint" style="margin-top:6px"></div>
               ${(job.claims || []).length ? `<details style="margin-top:8px"><summary>Claims (${job.claims.length})</summary>${jsonPre(job.claims)}</details>` : ''}
               <details style="margin-top:8px"><summary>Raw delivery</summary>${jsonPre(deliverable)}</details>`
    : '<p class="hint">Nothing delivered yet. The MCP agent will deliver here.</p>'}
        </div>

        <div class="card"><h3>Email change requests</h3>
          <div id="dd-er">${ers.map((x) => erRowHtml(x, false)).join('') || '<p class="hint">No pending requests for this job.</p>'}</div>
          <details style="margin-top:10px"><summary>Paste a client email</summary>
            <div class="row"><div class="field"><label class="lbl">From</label><input id="er-from" type="email" /></div>
              <div class="field"><label class="lbl">Kind</label><select id="er-kind"><option value="">Auto-detect</option><option value="redesign">Redesign</option><option value="improvements">Improvements</option></select></div></div>
            <div class="field"><label class="lbl">Subject</label><input id="er-subject" type="text" /></div>
            <div class="field"><label class="lbl">Body</label><textarea id="er-body"></textarea></div>
            <button class="btn small primary" data-act="er-save">Save request</button>
          </details>
        </div>

        ${brief ? `<div class="card"><details><summary>Design brief</summary>${jsonPre(brief)}</details></div>` : ''}
      </div>
    </div>`;

  let designFontHooks = null;
  if (hasSite) {
    const designPreview = mountPreview($('#dd-preview'), (slug) => api.designRender(id, { editable: true, pageSlug: slug }), {
      onPreview: (data) => { if (designFontHooks) designFontHooks.onPreview(data); },
    });
    const designPages = deliverable.pages;
    const designTheme = deliverable.theme && typeof deliverable.theme === 'object' ? deliverable.theme : {};
    designFontHooks = bindFontToolbar('dd', designPreview, () => designPages, () => designTheme, (nextPages, nextTheme) =>
      api.designSaveWebsite(id, nextPages, nextTheme));
  }
  fillChangeInstructionBoxes(job);

  const changeBody = (kind) => {
    const instr = $(kind === 'improvements' ? '#dd-improve' : '#dd-redesign').value.trim();
    return { instructions: instr || undefined, refresh: !instr, forceReview: !instr && !(job.review && job.review.at) };
  };

  delegate(view, {
    delete: async () => {
      if (!window.confirm('Delete this design job?')) return;
      await api.designDelete(id);
      window.location.hash = '#/design';
    },
    shape: async () => { await api.designUpdate(id, { site_shape: $('#dd-shape').value }); toast('Shape updated', 'ok'); pageDesignDetail(id); },
    answer: async (t) => {
      const text = $('#qa-' + t.dataset.q).value.trim();
      if (!text) { toast('Write an answer first.', 'err'); return; }
      await api.designAnswer(Number(t.dataset.q), text);
      toast('Answer recorded', 'ok');
      pageDesignDetail(id);
    },
    contact: async () => {
      await api.designContact(id, {
        email: $('#dd-contact').value.trim(),
        phone: ($('#dd-contact-phone') && $('#dd-contact-phone').value.trim()) || '',
      });
      toast('Contact saved', 'ok');
    },
    'email-q': async () => {
      const x = (await api.designEmailQuestions(id)).data;
      const msg = x && x.error
        ? x.error
        : (x && x.sent ? `Sent to ${x.to}` : (x && (x.message || 'Questions email processed.')));
      $('#dd-email-out').textContent = msg;
      toast(x && x.sent ? `Questions emailed to ${x.to}` : (x && x.code === 'SMTP_NOT_CONFIGURED' ? 'SMTP not configured' : 'Questions email processed'), x && x.sent ? 'ok' : '');
    },
    'email-d': async () => {
      const x = (await api.designEmailDelivery(id)).data;
      const msg = x && x.error
        ? x.error
        : (x && x.sent ? `Sent to ${x.to}` : (x && (x.message || 'Delivery email processed.')));
      $('#dd-email-out').textContent = msg;
      toast(x && x.sent ? `Delivery emailed to ${x.to}` : (x && x.code === 'SMTP_NOT_CONFIGURED' ? 'SMTP not configured' : 'Delivery email processed'), x && x.sent ? 'ok' : '');
    },
    reply: async () => {
      const reply = $('#dd-reply').value.trim();
      if (!reply) { toast('Paste the reply text.', 'err'); return; }
      await api.designReply(id, reply, $('#dd-rfrom').value.trim() || undefined);
      toast('Reply recorded', 'ok');
      pageDesignDetail(id);
    },
    'client-form': async () => {
      const x = (await api.designClientForm(id)).data;
      const el = $('#dd-form-link');
      if (el) el.innerHTML = `Client form: <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a>`;
      try {
        if (navigator.clipboard && x.url) {
          await navigator.clipboard.writeText(x.url);
          toast('Client form link copied', 'ok');
        } else toast('Client form link ready', 'ok');
      } catch { toast('Client form link ready', 'ok'); }
    },
    review: async () => {
      $('#dd-review').innerHTML = '<p class="hint">Reviewing…</p>';
      const x = (await api.designReview(id, {})).data;
      const review = (x && x.review) || (x && x.job && x.job.review) || x;
      $('#dd-review').innerHTML = reviewHtml(review);
      fillChangeInstructionBoxes(job, review);
    },
    redesign: async () => {
      await api.designRedesign(id, changeBody('redesign'));
      toast('Redesign queued for the agent', 'ok');
      pageDesignDetail(id);
    },
    improve: async () => {
      await api.designImprove(id, changeBody('improvements'));
      toast('Improvements queued for the agent', 'ok');
      pageDesignDetail(id);
    },
    url: async () => {
      $('#dd-delivery-out').textContent = 'Publishing preview…';
      const x = (await api.designPreview(id, false)).data;
      const link = x.url
        ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a>`
        : esc(x.path || '');
      $('#dd-delivery-out').innerHTML = `Public preview: ${link}${x.via ? `<div class="hint">via ${esc(x.via)}</div>` : ''}`;
    },
    photos: async () => {
      const x = (await api.designImages(id, {})).data;
      $('#dd-delivery-out').textContent = `Added ${x.count != null ? x.count : '?'} photo(s).`;
      pageDesignDetail(id);
    },
    genimg: async () => {
      const prompt = window.prompt('Image prompt (leave blank for a lead-aware default):', '');
      if (prompt === null) return;
      $('#dd-delivery-out').textContent = 'Generating image…';
      const x = (await api.designGenerateImages(id, { prompt: prompt.trim() || undefined, n: 1, quality: 'low' })).data;
      $('#dd-delivery-out').textContent = `Generated ${x.count != null ? x.count : '?'} image(s)${x.model ? ' with ' + x.model : ''}.`;
      pageDesignDetail(id);
    },
    'er-save': async () => {
      const body = $('#er-body').value.trim();
      if (!body) { toast('Paste the email body.', 'err'); return; }
      const x = (await api.emailRedesignIngest(dropEmpty({
        designJobId: id, fromEmail: $('#er-from').value.trim(), subject: $('#er-subject').value.trim(),
        body, source: 'paste', force: true, requestKind: $('#er-kind').value,
      }))).data;
      if (x.skipped) { toast(x.error || 'Not detected as a change request.', 'err'); return; }
      toast('Request saved', 'ok');
      pageDesignDetail(id);
    },
    'er-submit': async (t) => {
      await api.emailRedesignSubmit(Number(t.dataset.id), { designJobId: id });
      toast('Submitted to the agent queue', 'ok');
      pageDesignDetail(id);
    },
    'er-dismiss': async (t) => { await api.emailRedesignDismiss(Number(t.dataset.id)); pageDesignDetail(id); },
    'er-use': (t) => {
      const x = ers.find((e) => String(e.id) === t.dataset.id);
      if (!x) return;
      const area = $(x.request_kind === 'improvements' ? '#dd-improve' : '#dd-redesign');
      area.value = x.body || x.body_excerpt || '';
      toast('Copied into ' + x.request_kind + ' instructions.', 'ok');
    },
  });
}

/* ------------------------------------------------------------------ */
/* Outreach                                                            */
/* ------------------------------------------------------------------ */

let outreachTab = 'campaigns';

async function pageOutreach(param, query) {
  const st = (await api.outreachStats()).data;
  const mbs = st.messagesByStatus || {};
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Outreach</h1><p class="lede">Email and SMS templates, campaigns, the send queue and the suppression list. SMS credentials are in Settings → SMS (or Admin → SMS).</p></div>
      <div class="page-actions"><button class="btn primary" data-act="process">Process queue now</button></div>
    </div>
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-label">Sent today</div><div class="stat-value">${esc(st.sentToday)} / ${esc(st.dailyCap)}</div></div>
      <div class="stat-card"><div class="stat-label">Queued</div><div class="stat-value">${esc(mbs.queued || 0)}</div></div>
      <div class="stat-card"><div class="stat-label">Campaigns</div><div class="stat-value">${esc(st.activeCampaigns)} / ${esc(st.campaigns)}</div></div>
      <div class="stat-card"><div class="stat-label">Templates</div><div class="stat-value">${esc(st.templates)}</div></div>
      <div class="stat-card"><div class="stat-label">Suppressed</div><div class="stat-value">${esc(st.suppressionCount)}</div></div>
    </div>
    <div class="tabs" id="o-tabs">
      ${['campaigns', 'templates', 'suppression'].map((t) => `<button data-tab="${t}" class="${outreachTab === t ? 'active' : ''}">${esc(t[0].toUpperCase() + t.slice(1))}</button>`).join('')}
    </div>
    <div id="o-tab"></div>`;

  $('#o-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    outreachTab = b.dataset.tab;
    $$('#o-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    loadTab();
  };
  delegate($('.page-actions', view), {
    process: async () => {
      const r = (await api.processQueue()).data;
      toast('Queue processed' + (r && r.sent != null ? `: ${r.sent} sent` : ''), 'ok');
      pageOutreach();
    },
  });

  async function loadTab() {
    const host = $('#o-tab');
    if (!host) return;
    if (outreachTab === 'campaigns') await tabCampaigns(host);
    else if (outreachTab === 'templates') await tabTemplates(host);
    else await tabSuppression(host);
  }
  await loadTab();
  if (query && query.new) openCampaignModal();
}

function confirmCampaignAction({ title, body, confirmLabel, danger }, onConfirm) {
  openModal({
    title,
    body: `<p>${body}</p>`,
    buttons: [
      { label: 'Keep', onClick: (m) => m.close() },
      {
        label: confirmLabel,
        cls: danger ? 'danger' : 'primary',
        onClick: async (m) => {
          await onConfirm();
          m.close();
        },
      },
    ],
  });
}

async function tabCampaigns(host) {
  const r = (await api.campaigns({ pageSize: 50 })).data || {};
  const rows = asList(r, ['rows', 'campaigns']);
  const canCancel = (s) => s === 'active' || s === 'paused' || s === 'draft';
  host.innerHTML = `
    <div class="toolbar">
      <button class="btn primary" data-act="new">New campaign</button>
      <button class="btn" data-act="compose">Compose email</button>
      <button class="btn" data-act="compose-sms">Compose SMS</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Status</th><th>Queued</th><th>Sent</th><th>Failed</th><th>Suppressed</th><th>Rate/h</th><th></th></tr></thead>
      <tbody>${rows.map((c) => `<tr>
        <td>${esc(c.name)}<div class="hint">#${esc(c.id)} · ${esc(fmtDate(c.created_at))}</div></td>
        <td>${statusBadge(c.status)}</td><td>${esc(c.queued)}</td><td>${esc(c.sent)}</td><td>${esc(c.failed)}</td><td>${esc(c.suppressed)}</td><td>${esc(c.rate_per_hour || '—')}</td>
        <td class="actions">
          <button class="btn small" data-act="messages" data-id="${c.id}" data-name="${esc(c.name)}">Messages</button>
          ${c.status === 'active' ? `<button class="btn small" data-act="pause" data-id="${c.id}">Pause</button>` : ''}
          ${c.status === 'paused' || c.status === 'draft' ? `<button class="btn small" data-act="resume" data-id="${c.id}">Resume</button>` : ''}
          ${canCancel(c.status) ? `<button class="btn small" data-act="cancel" data-id="${c.id}" data-name="${esc(c.name)}">Cancel</button>` : ''}
          <button class="btn small danger" data-act="delete" data-id="${c.id}" data-name="${esc(c.name)}">Delete</button>
        </td></tr>`).join('') || '<tr><td colspan="8" class="empty">No campaigns yet.</td></tr>'}</tbody>
    </table></div>`;
  delegate(host, {
    new: () => openCampaignModal(),
    compose: () => openComposeModal('email'),
    'compose-sms': () => openComposeModal('sms'),
    messages: (t) => openMessagesModal(Number(t.dataset.id), t.dataset.name),
    pause: async (t) => { await api.campaignStatus(Number(t.dataset.id), 'paused'); tabCampaigns(host); },
    resume: async (t) => { await api.campaignStatus(Number(t.dataset.id), 'active'); tabCampaigns(host); },
    cancel: (t) => {
      const id = Number(t.dataset.id);
      const name = t.dataset.name || ('#' + id);
      confirmCampaignAction({
        title: 'Cancel campaign',
        body: `Cancel <strong>${esc(name)}</strong>? This permanently stops the campaign. Queued messages will not send. You cannot resume afterwards (unlike Pause).`,
        confirmLabel: 'Cancel campaign',
        danger: true,
      }, async () => {
        const res = await api.campaignCancel(id);
        const n = (res.data && res.data.cancelledQueued) || 0;
        toast(n ? `Campaign cancelled (${n} queued stopped)` : 'Campaign cancelled', 'ok');
        tabCampaigns(host);
      });
    },
    delete: (t) => {
      const id = Number(t.dataset.id);
      const name = t.dataset.name || ('#' + id);
      confirmCampaignAction({
        title: 'Delete campaign',
        body: `Permanently delete <strong>${esc(name)}</strong> and all of its messages? This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      }, async () => {
        await api.campaignDelete(id);
        toast('Campaign deleted', 'ok');
        tabCampaigns(host);
      });
    },
  });
}

async function openMessagesModal(campaignId, name) {
  const m = openModal({ title: 'Messages — ' + name, wide: true, body: '<div id="cm-body"><p class="hint">Loading…</p></div>' });
  let page = 1;
  let status = '';
  async function load() {
    const r = (await api.campaignMessages(campaignId, { page, pageSize: 25, status })).data;
    const body = $('#cm-body', m.el);
    if (!body) return;
    body.innerHTML = `<div class="toolbar"><select id="cm-status"><option value="">All statuses</option>${optionList(['queued', 'sent', 'failed', 'suppressed'], status)}</select></div>
      <div class="table-wrap"><table><thead><tr><th>To</th><th>Channel</th><th>Subject / preview</th><th>Status</th><th>Scheduled</th><th>Sent</th><th></th></tr></thead>
      <tbody>${(r.rows || []).map((x) => {
        const ch = (x.channel || 'email') === 'sms' ? 'sms' : 'email';
        const to = ch === 'sms' ? (x.to_phone || x.to_email) : x.to_email;
        const preview = ch === 'sms' ? String(x.body || '').slice(0, 80) : x.subject;
        return `<tr>
        <td>${esc(to)}<div class="hint">${esc(x.business_name || '')}</div></td>
        <td>${statusBadge(ch)}</td>
        <td>${esc(preview)}${x.error ? `<div class="error hint">${esc(x.error)}</div>` : ''}</td>
        <td>${statusBadge(x.status)}</td><td>${esc(fmtDate(x.scheduled_at))}</td><td>${esc(fmtDate(x.sent_at))}</td>
        <td>${x.status === 'queued' ? `<button class="btn small" data-act="send" data-id="${x.id}">Send now</button>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="7" class="empty">No messages.</td></tr>'}</tbody></table></div>
      <div class="pagination" id="cm-pager"></div>`;
    $('#cm-status', m.el).value = status;
    $('#cm-status', m.el).onchange = (e) => { status = e.target.value; page = 1; load(); };
    pager($('#cm-pager', m.el), { page: r.page || 1, pages: r.pages || 1, total: r.total || 0 }, (p) => { page = p; load(); });
  }
  delegate(m.el, {
    send: async (t) => {
      const x = (await api.emailSend(Number(t.dataset.id))).data;
      const label = x.channel === 'sms' ? 'SMS' : 'Email';
      toast(x.sent ? `${label} sent to ${x.to}` : 'Not sent (suppressed)', x.sent ? 'ok' : '');
      load();
    },
  });
  await load();
}

async function openCampaignModal() {
  const tplR = await api.templates();
  let templates = tplR.data.templates || [];
  const selected = new Set();
  try { (JSON.parse(sessionStorage.getItem('scout.campaignLeadIds') || '[]') || []).forEach((i) => selected.add(Number(i))); } catch { /* ignore */ }
  sessionStorage.removeItem('scout.campaignLeadIds');
  let results = [];

  const m = openModal({
    title: 'New campaign',
    wide: true,
    body: `<div class="row">
        <div class="field"><label>Name *</label><input id="cp-name" type="text" /></div>
        <div class="field"><label>Template *</label><select id="cp-tpl"></select></div>
        <div class="field"><label>Send via</label>
          <select id="cp-channel">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="both">Email + SMS</option>
          </select>
        </div>
        <div class="field" style="max-width:130px"><label id="cp-rate-label">Per hour</label><input id="cp-rate" type="number" min="1" max="1000" value="30" /></div>
      </div>
      <div class="field"><label>Find leads</label>
        <div class="inline"><input id="cp-q" type="search" placeholder="Search leads…" class="grow" style="flex:1" />
          <select id="cp-status" style="width:auto"><option value="">Any status</option>${optionList(LEAD_STATUSES, '')}</select>
          <button class="btn small" data-act="addall">Add all results</button></div></div>
      <div class="pick-list" id="cp-results"><div class="empty">Search or filter to list leads.</div></div>
      <p class="hint"><b id="cp-count">0</b> lead(s) selected. <span id="cp-elig-hint">Leads without an email, or on the suppression list, are never sent.</span>
        <button class="link-btn" data-act="clearsel">Clear</button></p>
      <div class="msg" id="cp-msg"></div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create campaign', cls: 'primary',
        onClick: async (mm) => {
          const name = $('#cp-name', mm.el).value.trim();
          const templateId = Number($('#cp-tpl', mm.el).value);
          const channel = $('#cp-channel', mm.el).value || 'email';
          const msg = $('#cp-msg', mm.el);
          if (!name) { setMsg(msg, 'Name is required.', 'err'); return; }
          if (!templateId) { setMsg(msg, 'Choose a template.', 'err'); return; }
          if (!selected.size) { setMsg(msg, 'Select at least one lead.', 'err'); return; }
          const r = (await api.createCampaign({
            name, templateId, channel, leadIds: Array.from(selected),
            ratePerHour: Number($('#cp-rate', mm.el).value) || 30,
          })).data;
          toast('Campaign created' + (r && r.queued != null ? `: ${r.queued} queued` : ''), 'ok');
          mm.close();
          pageOutreach();
        },
      },
    ],
  });

  function tplHasEmail(t) {
    return !!(String(t.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }
  function tplHasSms(t) {
    return !!(String(t.sms_body || '').trim()
      || ((t.channel || '') === 'sms' && String(t.body || '').trim()));
  }
  function fillTemplates() {
    const ch = $('#cp-channel', m.el).value;
    const list = templates.filter((t) => {
      if (ch === 'sms') return tplHasSms(t);
      if (ch === 'both') return tplHasEmail(t) && tplHasSms(t);
      return tplHasEmail(t);
    });
    $('#cp-tpl', m.el).innerHTML = list.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')
      || `<option value="">(no templates with ${ch === 'both' ? 'email + SMS' : ch} content)</option>`;
    const hint = $('#cp-elig-hint', m.el);
    if (hint) {
      hint.textContent = ch === 'sms'
        ? 'Leads without a phone number are never texted.'
        : ch === 'both'
          ? 'Email needs a non-suppressed address; SMS needs a phone. Missing either channel is suppressed for that channel only.'
          : 'Leads without an email, or on the suppression list, are never sent.';
    }
    $('#cp-rate-label', m.el).textContent = ch === 'sms' ? 'Texts / hour' : (ch === 'both' ? 'Messages / hour' : 'Emails / hour');
  }
  fillTemplates();
  $('#cp-channel', m.el).onchange = fillTemplates;

  const count = () => { $('#cp-count', m.el).textContent = selected.size; };
  function renderResults() {
    const ch = $('#cp-channel', m.el).value;
    $('#cp-results', m.el).innerHTML = results.map((l) => {
      const contact = ch === 'sms' ? (l.phone || 'no phone') : (l.email || 'no email');
      return `<label class="pick-row"><input type="checkbox" data-lead="${l.id}" ${selected.has(l.id) ? 'checked' : ''} />
      <span><b>${esc(l.business_name)}</b> <span class="hint">#${l.id} · ${esc(contact)} · ${esc(l.status)}</span></span></label>`;
    }).join('') || '<div class="empty">No leads found.</div>';
  }
  const search = async () => {
    const r = (await api.leads({ q: $('#cp-q', m.el).value.trim(), status: $('#cp-status', m.el).value, pageSize: 100 })).data;
    results = r.leads || [];
    renderResults();
  };
  $('#cp-q', m.el).addEventListener('input', debounce(() => safeRun(null, search), 300));
  $('#cp-status', m.el).addEventListener('change', () => safeRun(null, search));
  $('#cp-results', m.el).addEventListener('change', (e) => {
    const cb = e.target.closest('[data-lead]');
    if (!cb) return;
    const id = Number(cb.dataset.lead);
    if (cb.checked) selected.add(id); else selected.delete(id);
    count();
  });
  delegate(m.el, {
    addall: () => { results.forEach((l) => selected.add(l.id)); renderResults(); count(); },
    clearsel: () => { selected.clear(); renderResults(); count(); },
  });
  count();
  if (selected.size) setMsg($('#cp-msg', m.el), `${selected.size} lead(s) preselected from the Leads page.`);
  await search();
}

function looksLikeHtmlClient(s) {
  return typeof s === 'string' && /<\/?[a-z][\s\S]*>/i.test(s);
}

function plainToEditorHtml(text) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '<p>Hi {{business_name}},</p><p>…</p>';
  if (looksLikeHtmlClient(t)) return t;
  return t.split(/\n{2,}/).map((block) => {
    const inner = esc(block).replace(/\n/g, '<br>');
    return `<p>${inner}</p>`;
  }).join('');
}

/**
 * Lightweight contenteditable email body editor (bold / links / lists / images).
 * Stores HTML in a hidden textarea named "body" for form submit.
 */
function mountEmailBodyEditor(host, { initialHtml } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'email-rte';
  wrap.innerHTML = `
    <div class="email-rte-toolbar" role="toolbar" aria-label="Formatting">
      <button type="button" class="btn small" data-cmd="bold" title="Bold"><b>B</b></button>
      <button type="button" class="btn small" data-cmd="italic" title="Italic"><i>I</i></button>
      <button type="button" class="btn small" data-cmd="insertUnorderedList" title="Bullet list">• List</button>
      <button type="button" class="btn small" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
      <button type="button" class="btn small" data-cmd="link" title="Insert link">Link</button>
      <button type="button" class="btn small" data-cmd="image" title="Upload image">Image</button>
      <button type="button" class="btn small" data-cmd="site-shot" title="Insert site screenshot merge field">Site screenshot</button>
    </div>
    <div class="email-rte-surface" contenteditable="true" role="textbox" aria-multiline="true"></div>
    <textarea name="body" class="email-rte-hidden" required hidden></textarea>
    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="email-rte-file" hidden />`;
  host.appendChild(wrap);
  const surface = $('.email-rte-surface', wrap);
  const hidden = $('.email-rte-hidden', wrap);
  const fileInput = $('.email-rte-file', wrap);

  const sync = () => { hidden.value = surface.innerHTML.trim(); };
  const setHtml = (html) => {
    surface.innerHTML = plainToEditorHtml(html);
    sync();
  };
  setHtml(initialHtml || '<p>Hi {{business_name}},</p><p>…</p>');
  surface.addEventListener('input', sync);
  surface.addEventListener('blur', sync);

  const insertHtml = (html) => {
    surface.focus();
    try {
      document.execCommand('insertHTML', false, html);
    } catch {
      surface.insertAdjacentHTML('beforeend', html);
    }
    sync();
  };

  $('.email-rte-toolbar', wrap).onclick = async (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    const cmd = btn.dataset.cmd;
    surface.focus();
    if (cmd === 'link') {
      const url = window.prompt('Link URL (https://… or mailto:…)', 'https://');
      if (!url) return;
      const safe = String(url).trim();
      if (!/^(https?:\/\/|mailto:|tel:)/i.test(safe)) {
        toast('Links must start with https://, mailto:, or tel:', 'err');
        return;
      }
      document.execCommand('createLink', false, safe);
      sync();
      return;
    }
    if (cmd === 'image') {
      fileInput.value = '';
      fileInput.click();
      return;
    }
    if (cmd === 'site-shot') {
      // Per-recipient merge field — resolved at campaign create to each lead's email JPEG.
      insertHtml('<p>{{site_screenshot}}</p>');
      toast('Inserted {{site_screenshot}} — each recipient gets their own site preview image.', 'ok');
      return;
    }
    document.execCommand(cmd, false, null);
    sync();
  };

  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('Image must be 5 MB or smaller.', 'err');
      return;
    }
    try {
      toast('Uploading image…');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
      });
      const r = (await api.emailUploadAsset({ data: dataUrl, mimeType: file.type })).data;
      insertHtml(`<p><img src="${esc(r.url)}" alt="" style="max-width:100%;height:auto;"></p>`);
      toast('Image added', 'ok');
    } catch (err) {
      toast(err.message || 'Upload failed', 'err');
    }
  };

  return {
    getHtml: () => { sync(); return hidden.value; },
    setHtml,
    el: wrap,
  };
}

async function openComposeModal(channel = 'email') {
  const ch = channel === 'sms' ? 'sms' : 'email';
  const tplRes = await api.templates();
  const all = (tplRes.data && tplRes.data.templates) || [];
  const templates = all.filter((t) => {
    if (ch === 'sms') {
      return !!(String(t.sms_body || '').trim()
        || ((t.channel || '') === 'sms' && String(t.body || '').trim()));
    }
    return !!(String(t.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  });
  const m = openModal({
    title: ch === 'sms' ? 'Compose a single SMS' : 'Compose a single email',
    wide: true,
    body: `<div class="field"><label>Lead</label><div id="cx-lead"></div></div>
      <div class="field"><label>Template</label><select id="cx-tpl">${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('') || '<option value="">(create a template with ' + (ch === 'sms' ? 'SMS' : 'email') + ' content first)</option>'}</select></div>
      <div id="cx-prev" class="hint">${ch === 'sms'
        ? 'Uses the template’s SMS body. {{website_link}} is the live preview URL. {{site_screenshot}} attaches that lead’s MMS JPEG when captured (falls back to text+link). The lead must have a phone number.'
        : 'Uses the template’s email subject/body. {{website_link}} is the live preview URL. {{site_screenshot}} inserts that lead’s hosted preview image. {{interested}} / {{uninterested}} become signed response links.'}</div>`,
    buttons: [
      { label: 'Close' },
      {
        label: 'Preview',
        onClick: async (mm) => {
          const lead = picker.get();
          if (!lead) { toast('Select a lead.', 'err'); return; }
          const tid = Number($('#cx-tpl', mm.el).value);
          if (!tid) { toast('Choose a template.', 'err'); return; }
          if (ch === 'sms' && !lead.phone) { toast('This lead has no phone number.', 'err'); return; }
          const r = (await api.emailCompose(lead.id, tid, false, ch)).data;
          const bodyHtml = ch === 'sms' || !looksLikeHtmlClient(r.body)
            ? `<p style="white-space:pre-wrap">${esc(r.body)}</p>`
            : `<div class="email-preview-body">${r.body}</div>`;
          $('#cx-prev', mm.el).innerHTML = `<div class="q-card"><b>${esc(ch === 'sms' ? 'SMS' : r.subject)}</b>${bodyHtml}${(r.missing || []).length ? `<div class="hint">Missing: ${esc(r.missing.join(', '))}</div>` : ''}</div>`;
        },
      },
      {
        label: 'Queue & send now', cls: 'primary',
        onClick: async (mm) => {
          const lead = picker.get();
          if (!lead) { toast('Select a lead.', 'err'); return; }
          const tid = Number($('#cx-tpl', mm.el).value);
          if (!tid) { toast('Choose a template.', 'err'); return; }
          if (ch === 'sms' && !lead.phone) { toast('This lead has no phone number.', 'err'); return; }
          if (!window.confirm(ch === 'sms' ? 'Send this SMS now?' : 'Send this email now?')) return;
          const q = (await api.emailCompose(lead.id, tid, true, ch)).data;
          const s = (await api.emailSend(q.messageId)).data;
          const label = s.channel === 'sms' ? 'SMS' : 'Email';
          toast(s.sent ? `${label} sent to ${s.to}` : 'Not sent (suppressed)', s.sent ? 'ok' : 'err');
          mm.close();
        },
      },
    ],
  });
  const picker = mountLeadPicker($('#cx-lead', m.el));
}

/** In-app AI draft for Outreach templates (no window.prompt). Fills email + SMS together. */
function openAiWriteModal({ existingSubject, existingBody, onApplied }) {
  const m = openModal({
    title: 'Help me write with AI',
    body: `
      <div class="field">
        <label for="ai-brief">Writing brief</label>
        <textarea id="ai-brief" rows="4" placeholder="Tone, offer, angle — e.g. friendly intro for a new local website preview"></textarea>
        <div class="hint">Optional. Generates an email draft plus a companion SMS with {{website_link}}.</div>
      </div>
      <div class="field">
        <label>Lead for context <span class="hint">(optional)</span></label>
        <div id="ai-lead"></div>
        <div class="hint">Search by name, business, or email. Clear the selection for a reusable template.</div>
      </div>
      <p class="msg" id="ai-msg"></p>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Generate',
        cls: 'primary',
        onClick: async (mm, btn) => {
          const brief = ($('#ai-brief', mm.el).value || '').trim();
          const lead = picker.get();
          const leadId = lead && lead.id ? Number(lead.id) : undefined;
          const msg = $('#ai-msg', mm.el);
          setMsg(msg, 'Generating with AI…');
          btn.textContent = 'Generating…';
          try {
            const r = (await api.emailDraft({
              prompt: brief || undefined,
              leadId,
              existingSubject,
              existingBody: existingBody || '',
            })).data;
            if (typeof onApplied === 'function') onApplied(r, leadId || null);
            mm.close();
          } catch (err) {
            setMsg(msg, err.message || 'AI draft failed', 'err');
            btn.textContent = 'Generate';
          }
        },
      },
    ],
  });
  const picker = mountLeadPicker($('#ai-lead', m.el), {
    placeholder: 'Search by name, business, or email…',
  });
  const briefEl = $('#ai-brief', m.el);
  if (briefEl) briefEl.focus();
  return m;
}

async function tabTemplates(host) {
  const templates = asList((await api.templates()).data, ['templates', 'rows']);
  const emailVarChips = ['business_name', 'city', 'category', 'phone', 'website_link', 'site_screenshot', 'interested', 'uninterested']
    .map((v) => `<code class="var-chip" data-var="{{${v}}}" data-target="email">{{${v}}}</code>`)
    .join(' ');
  const smsVarChips = ['business_name', 'city', 'category', 'phone', 'website_link', 'site_screenshot']
    .map((v) => `<code class="var-chip" data-var="{{${v}}}" data-target="sms">{{${v}}}</code>`)
    .join(' ');
  host.innerHTML = `
    <div class="grid cols-2" style="align-items:start">
      <div class="card"><h3 id="tp-title">New template</h3>
        <form id="tp-form">
          <input type="hidden" name="id" />
          <div class="field"><label>Name</label><input name="name" required /></div>
          <div class="field" id="tp-subject-wrap"><label>Email subject</label><input name="subject" id="tp-subject" /></div>
          <div class="field" id="tp-email-body-wrap">
            <div class="field-head">
              <label for="tp-body-host">Email body</label>
              <button type="button" class="btn small" data-act="ai-write">Help me write with AI</button>
            </div>
            <div id="tp-body-host"></div>
            <div class="hint">Variables: ${emailVarChips}. <code>{{website_link}}</code> is the active published site URL.</div>
          </div>
          <div class="field" id="tp-sms-body-wrap">
            <div class="field-head">
              <label for="tp-sms-body">SMS body (plain text)</label>
            </div>
            <textarea id="tp-sms-body" name="sms_body" rows="4" maxlength="1600" placeholder="Hi {{business_name}} — preview: {{website_link}}"></textarea>
            <div class="hint">Saved with this template. Keep it short (≤160 ideal). Variables: ${smsVarChips}. Include <code>{{website_link}}</code>. <code>{{site_screenshot}}</code> sends as MMS (media URL) when available, else plain SMS with the preview link.</div>
            <div class="hint" id="tp-sms-count">0 characters</div>
            <div class="inline" style="margin-top:8px">
              <button type="button" class="btn small" data-act="queue-sms">Queue SMS to lead</button>
              <span class="hint" id="tp-sms-hint"></span>
            </div>
          </div>
          <div class="inline"><button class="btn primary" type="submit">Save template</button><button class="btn" type="button" data-act="reset">Reset</button><span class="msg" id="tp-msg"></span></div>
        </form>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>SMS</th><th></th></tr></thead>
        <tbody>${templates.map((t) => {
          const hasEmail = !!(String(t.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
          const hasSms = !!(String(t.sms_body || '').trim()
            || ((t.channel || '') === 'sms' && String(t.body || '').trim()));
          const smsPrev = String(t.sms_body || ((t.channel || '') === 'sms' ? t.body : '') || '').slice(0, 40);
          return `<tr><td>${esc(t.name)}<div class="hint">${esc(t.subject || '')}</div></td>
            <td>${hasEmail ? statusBadge('email') : '<span class="hint">—</span>'}</td>
            <td>${hasSms ? `${statusBadge('sms')}<div class="hint">${esc(smsPrev)}</div>` : '<span class="hint">—</span>'}</td>
          <td class="actions"><button class="btn small" data-act="edit" data-id="${t.id}">Edit</button> <button class="btn small danger" data-act="delete" data-id="${t.id}">Delete</button></td></tr>`;
        }).join('')
    || '<tr><td colspan="4" class="empty">No templates yet.</td></tr>'}</tbody></table></div>
    </div>`;
  const form = $('#tp-form', host);
  const editor = mountEmailBodyEditor($('#tp-body-host', host), {
    initialHtml: '<p>Hi {{business_name}},</p><p>…</p>',
  });
  let draftLeadId = null;

  function updateSmsCount() {
    const el = $('#tp-sms-body', host);
    const c = $('#tp-sms-count', host);
    if (el && c) c.textContent = `${el.value.length} characters`;
  }
  $('#tp-sms-body', host).addEventListener('input', updateSmsCount);
  updateSmsCount();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = formObject(form);
    body.body = editor.getHtml();
    body.sms_body = ($('#tp-sms-body', host).value || '').trim();
    const hasEmail = !!String(body.body || '').replace(/<[^>]+>/g, '').trim();
    const hasSms = !!body.sms_body;
    if (!hasEmail && !hasSms) {
      setMsg($('#tp-msg', host), 'Provide an email body and/or SMS body.', 'err');
      return;
    }
    if (hasEmail && !String(body.subject || '').trim()) {
      setMsg($('#tp-msg', host), 'Email subject is required when saving an email body.', 'err');
      return;
    }
    delete body.channel;
    if (!body.id) delete body.id; else body.id = Number(body.id);
    try {
      await api.saveTemplate(body);
      toast('Template saved', 'ok');
      tabTemplates(host);
    } catch (err) { setMsg($('#tp-msg', host), err.message, 'err'); }
  };

  host.querySelectorAll('.var-chip').forEach((chip) => {
    chip.style.cursor = 'pointer';
    chip.title = 'Click to insert';
    chip.onclick = () => {
      const v = chip.dataset.var;
      if (chip.dataset.target === 'sms') {
        const ta = $('#tp-sms-body', host);
        const start = ta.selectionStart || ta.value.length;
        ta.value = ta.value.slice(0, start) + v + ta.value.slice(ta.selectionEnd || start);
        updateSmsCount();
        ta.focus();
        return;
      }
      editor.el.querySelector('.email-rte-surface').focus();
      try { document.execCommand('insertText', false, v); }
      catch { editor.setHtml(editor.getHtml() + ' ' + v); }
    };
  });

  delegate(host, {
    reset: () => tabTemplates(host),
    'queue-sms': async () => {
      const sms = ($('#tp-sms-body', host).value || '').trim();
      if (!sms) { toast('Add an SMS body first.', 'err'); return; }
      if (!draftLeadId) { toast('Use “Help me write with AI” with a lead selected, or compose SMS from Campaigns.', 'err'); return; }
      try {
        const q = (await api.smsQueue({ leadId: draftLeadId, body: sms })).data;
        openModal({
          title: 'Send SMS now?',
          body: `<p>Queued for <b>${esc(q.to)}</b>. Send it immediately, or leave it queued.</p>
            <p class="hint" id="qs-msg"></p>`,
          buttons: [
            {
              label: 'Keep queued',
              onClick: (mm) => { toast('SMS queued', 'ok'); mm.close(); },
            },
            {
              label: 'Send now',
              cls: 'primary',
              onClick: async (mm, btn) => {
                setMsg($('#qs-msg', mm.el), 'Sending…');
                btn.textContent = 'Sending…';
                try {
                  const s = (await api.emailSend(q.messageId)).data;
                  toast(s.sent ? `SMS sent to ${s.to}` : 'Queued but not sent', s.sent ? 'ok' : 'err');
                  mm.close();
                } catch (err) {
                  setMsg($('#qs-msg', mm.el), err.message || 'Send failed', 'err');
                  btn.textContent = 'Send now';
                }
              },
            },
          ],
        });
      } catch (err) {
        toast(err.message || 'Could not queue SMS', 'err');
      }
    },
    'ai-write': () => {
      openAiWriteModal({
        existingSubject: form.subject.value,
        existingBody: editor.getHtml(),
        onApplied: (r, leadId) => {
          draftLeadId = leadId || null;
          if (r.subject) form.subject.value = r.subject;
          if (r.body) editor.setHtml(r.body);
          if (r.sms_body) {
            $('#tp-sms-body', host).value = r.sms_body;
            updateSmsCount();
          }
          const hint = $('#tp-sms-hint', host);
          if (hint) {
            hint.textContent = r.has_phone
              ? `Lead has phone (${r.lead_phone || 'on file'}).`
              : (leadId
                ? 'Lead has no phone — queue SMS will fail until a phone is added.'
                : '');
          }
          setMsg($('#tp-msg', host), 'Draft ready — review email + SMS and save.', 'ok');
          toast(r.sms_body ? 'AI draft + SMS ready' : 'AI draft applied', 'ok');
        },
      });
    },
    edit: (t) => {
      const tpl = templates.find((x) => String(x.id) === t.dataset.id);
      if (!tpl) return;
      form.id.value = tpl.id;
      form.name.value = tpl.name;
      form.subject.value = tpl.subject === '(SMS)' ? '' : (tpl.subject || '');
      const legacySms = (tpl.channel || '') === 'sms' && !String(tpl.sms_body || '').trim();
      editor.setHtml(legacySms ? '<p></p>' : (tpl.body || '<p></p>'));
      $('#tp-sms-body', host).value = legacySms ? (tpl.body || '') : (tpl.sms_body || '');
      updateSmsCount();
      $('#tp-title', host).textContent = 'Edit template #' + tpl.id;
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    delete: async (t) => {
      if (!window.confirm('Delete this template?')) return;
      await api.deleteTemplate(Number(t.dataset.id));
      toast('Template deleted', 'ok');
      tabTemplates(host);
    },
  });
}

async function tabSuppression(host) {
  const r = (await api.suppression({ pageSize: 100 })).data;
  const rows = r.rows || [];
  host.innerHTML = `
    <div class="card"><h3>Add to suppression list</h3>
      <form class="inline" id="sp-form">
        <input name="email" type="email" placeholder="name@example.com" required style="min-width:240px" />
        <select name="reason">${optionList(SUPPRESSION_REASONS, 'do-not-contact')}</select>
        <button class="btn primary" type="submit">Suppress</button><span class="msg" id="sp-msg"></span>
      </form>
      <p class="hint">Suppressed addresses are never emailed; queued messages to them are cancelled.</p>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Email</th><th>Reason</th><th>Added</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr><td>${esc(s.email)}</td><td>${esc(s.reason)}</td><td>${esc(fmtDate(s.created_at))}</td>
        <td><button class="btn small" data-act="remove" data-id="${s.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Suppression list is empty.</td></tr>'}</tbody></table></div>`;
  $('#sp-form', host).onsubmit = async (e) => {
    e.preventDefault();
    const f = formObject(e.target);
    try { await api.suppressionAdd(f.email, f.reason); toast('Added', 'ok'); tabSuppression(host); }
    catch (err) { setMsg($('#sp-msg', host), err.message, 'err'); }
  };
  delegate(host, {
    remove: async (t) => { await api.suppressionRemove(Number(t.dataset.id)); tabSuppression(host); },
  });
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

async function pagePipeline() {
  view.classList.add('wide');
  const res = await api.pipeline();
  const columns = asList(res.data && res.data.columns);
  view.innerHTML = `
    <div class="page-head"><div><h1>Pipeline</h1><p class="lede">Move leads between stages and record intent events (opens, clicks, claims).</p></div>
      <div class="page-actions"><button class="btn" data-act="refresh">Refresh</button></div></div>
    <div class="kanban">${columns.map((col) => `
      <div class="kanban-col" data-col="${esc(col.key)}">
        <div class="kanban-head"><span>${esc(col.title)}</span><span class="count">${esc(col.total)}</span></div>
        ${asList(col.leads).map((l) => `
          <div class="kanban-card">
            <div class="title"><button class="link-btn" data-act="open" data-id="${l.id}">${esc(l.business_name)}</button></div>
            <div class="hint">${esc(l.category || '')}${l.email ? ' · ' + esc(l.email) : ''}</div>
            <div class="meta">${scorePill(l.score)}<span class="badge intent-${esc(String(l.intent_label || 'Cold').toLowerCase())}">${esc(l.intent_label || 'Cold')} ${esc(l.intent_score || 0)}</span></div>
            <div class="meta"><select data-status="${l.id}" aria-label="Status">${optionList(LEAD_STATUSES, l.status)}</select>
              <button class="btn small" data-act="intent" data-id="${l.id}">Intent</button></div>
          </div>`).join('') || '<div class="hint" style="padding:8px">Empty</div>'}
        ${col.hasMore ? `<div class="hint">Showing ${esc(col.shown)} of ${esc(col.total)}.</div>` : ''}
      </div>`).join('') || '<p class="hint">No pipeline columns.</p>'}</div>`;

  view.onchange = (e) => {
    const sel = e.target.closest('[data-status]');
    if (!sel) return;
    safeRun(null, async () => {
      await api.patchLead(Number(sel.dataset.status), { status: sel.value });
      toast('Status updated', 'ok');
      pagePipeline();
    });
  };
  delegate(view, {
    refresh: () => pagePipeline(),
    open: (t) => { window.location.hash = '#/leads?id=' + t.dataset.id; },
    intent: (t) => openIntentModal(Number(t.dataset.id), () => pagePipeline()),
  });
}

/* ------------------------------------------------------------------ */
/* Social (Facebook + Instagram)                                       */
/* ------------------------------------------------------------------ */

async function pageSocial(_param, query = {}) {
  const leadIdQ = query.leadId ? Number(query.leadId) : null;
  const ov = (await api.socialOverview()).data;
  let leads = [];
  try {
    const lr = await api.leads({ pageSize: 200 });
    leads = asList(lr.data, ['leads', 'rows']);
  } catch { /* ignore */ }

  let detail = null;
  let selectedLeadId = leadIdQ;
  if (query.campaignId) {
    detail = (await api.socialCampaignGet(Number(query.campaignId))).data;
    selectedLeadId = detail.campaign && detail.campaign.lead_id;
  } else if (selectedLeadId) {
    const camps = (await api.socialCampaigns({ leadId: selectedLeadId })).data.campaigns || [];
    if (camps[0]) detail = (await api.socialCampaignGet(camps[0].id)).data;
  }

  if (query.connected === '1') {
    toast(`Meta connected: ${query.fb || 0} Facebook, ${query.ig || 0} Instagram`, 'ok');
  }

  const accounts = detail && detail.accounts
    ? detail.accounts
    : (selectedLeadId ? ((await api.socialAccounts(selectedLeadId)).data.accounts || []) : []);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Social</h1>
        <p class="lede">Facebook + Instagram for website clients. Generate a month of captions (photos optional), send a week for approval, then schedule posts.</p>
      </div>
    </div>
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-label">Meta app</div><div class="stat-value">${ov.metaConfigured ? 'Ready' : 'Setup'}</div></div>
      <div class="stat-card"><div class="stat-label">Accounts</div><div class="stat-value">${esc(ov.counts.accounts)}</div></div>
      <div class="stat-card"><div class="stat-label">Pending approval</div><div class="stat-value">${esc(ov.counts.pendingApproval)}</div></div>
      <div class="stat-card"><div class="stat-label">Scheduled</div><div class="stat-value">${esc(ov.counts.scheduled)}</div></div>
      <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value">${esc(ov.counts.failed)}</div></div>
    </div>
    ${!ov.metaConfigured ? '<div class="alert warn">Add <strong>Meta App ID</strong> and secret under <a href="#/settings/social">Settings → Social</a>, then connect a Page.</div>' : ''}

    <div class="card">
      <h3>Client / lead</h3>
      <div class="row">
        <div class="field"><label>Lead</label>
          <select id="soc-lead">
            <option value="">Select a lead…</option>
            ${leads.map((l) => `<option value="${esc(l.id)}" ${Number(l.id) === selectedLeadId ? 'selected' : ''}>${esc(l.business_name || ('#' + l.id))}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="inline" style="margin-top:8px">
        <button class="btn primary" type="button" data-act="connect" ${selectedLeadId ? '' : 'disabled'}>Connect Facebook / Instagram</button>
        <button class="btn" type="button" data-act="refresh">Refresh</button>
      </div>
      <div style="margin-top:12px">
        ${(accounts || []).map((a) => `
          <div class="kv"><span class="k">${esc(a.platform)}</span>
            <span>${esc(a.account_name || a.account_id)} ${statusBadge(a.status)}
              <button class="btn small danger" type="button" data-act="disconnect" data-id="${esc(a.id)}">Disconnect</button>
            </span></div>`).join('') || (selectedLeadId ? '<p class="hint">No accounts connected yet.</p>' : '<p class="hint">Pick a lead to connect accounts.</p>')}
      </div>
    </div>

    <div class="card">
      <h3>Generate month</h3>
      <p class="hint">Creates ~30 draft posts from the lead brief. Images stay off unless you opt in (Instagram needs a photo to publish).</p>
      <form id="soc-gen">
        <div class="row">
          <div class="field"><label>Month start</label><input name="monthStart" type="date" value="${esc(new Date().toISOString().slice(0, 10))}" required /></div>
          <div class="field"><label>Days</label><input name="days" type="number" min="7" max="60" value="30" /></div>
          <div class="field"><label>Client email (approval)</label><input name="clientEmail" type="email" placeholder="client@example.com" value="${esc((detail && detail.campaign && detail.campaign.client_email) || '')}" /></div>
        </div>
        <div class="row">
          <div class="field"><label>Require client approval</label>
            <select name="requireClientApproval"><option value="1" selected>Yes — weekly email</option><option value="0">No — schedule immediately</option></select>
          </div>
          <div class="field"><label>Include images</label>
            <select name="withImages"><option value="0" selected>No (text OK; IG skipped without photo)</option><option value="1">Yes (Pexels when configured)</option></select>
          </div>
        </div>
        <div class="field"><label>Brief (optional)</label><textarea name="brief" placeholder="Promo Tuesdays, keep tone friendly, no politics…"></textarea></div>
        <div class="inline"><button class="btn primary" type="submit" ${selectedLeadId ? '' : 'disabled'}>Generate month</button><span class="msg" id="soc-gen-msg"></span></div>
      </form>
    </div>

    <div class="card">
      <div class="panel-h"><h3>Campaigns</h3>
        <div class="inline">
          <button class="btn small" type="button" data-act="weekly-tick">Run weekly send now</button>
          <button class="btn small" type="button" data-act="publish-due">Publish due now</button>
        </div>
      </div>
      <table class="data">
        <thead><tr><th>Campaign</th><th>Lead</th><th>Status</th><th>Images</th><th></th></tr></thead>
        <tbody>
          ${(ov.campaigns || []).map((c) => `<tr>
            <td>${esc(c.title || ('#' + c.id))}<div class="sub-line">${esc(c.month_start)}</div></td>
            <td>${esc(c.business_name || c.lead_id)}</td>
            <td>${statusBadge(c.status)}</td>
            <td>${c.with_images ? 'Yes' : 'Optional/off'}</td>
            <td><button class="btn small" type="button" data-act="open-camp" data-id="${esc(c.id)}">Open</button></td>
          </tr>`).join('') || '<tr><td colspan="5">No campaigns yet</td></tr>'}
        </tbody>
      </table>
    </div>

    ${detail ? renderSocialCampaignDetail(detail) : ''}`;

  $('#soc-lead').onchange = () => {
    const id = Number($('#soc-lead').value);
    window.location.hash = id ? `#/social?leadId=${id}` : '#/social';
  };

  const gen = $('#soc-gen');
  if (gen) {
    gen.onsubmit = async (e) => {
      e.preventDefault();
      if (!selectedLeadId) return;
      const msg = $('#soc-gen-msg');
      setMsg(msg, 'Generating…');
      try {
        const fd = formObject(gen);
        const r = await api.socialGenerateMonth({
          leadId: selectedLeadId,
          monthStart: fd.monthStart,
          days: Number(fd.days) || 30,
          withImages: fd.withImages === '1' || fd.withImages === 1,
          brief: fd.brief || '',
          clientEmail: fd.clientEmail || '',
          requireClientApproval: fd.requireClientApproval !== '0',
        });
        setMsg(msg, `Created campaign #${r.data.campaign.id} with ${r.data.posts.length} posts.`, 'ok');
        window.location.hash = `#/social?campaignId=${r.data.campaign.id}`;
      } catch (err) { setMsg(msg, err.message, 'err'); }
    };
  }

  delegate(view, {
    refresh: () => pageSocial(_param, query),
    connect: async () => {
      if (!selectedLeadId) return;
      const r = await api.socialOauthStart(selectedLeadId, `#/social?leadId=${selectedLeadId}`);
      window.location.href = r.data.url;
    },
    disconnect: async (t) => {
      if (!confirm('Disconnect this account?')) return;
      await api.socialDisconnect(Number(t.dataset.id));
      toast('Disconnected', 'ok');
      pageSocial(_param, query);
    },
    'open-camp': (t) => { window.location.hash = `#/social?campaignId=${t.dataset.id}`; },
    'weekly-tick': async () => {
      const r = await api.socialWeeklyTick();
      toast(`Weekly tick: ${r.data.campaigns || 0} campaign(s)`, 'ok');
      pageSocial(_param, query);
    },
    'publish-due': async () => {
      const r = await api.socialPublishDue({});
      toast(`Publish due: ${r.data.published || 0}`, 'ok');
      pageSocial(_param, query);
    },
    'send-week': async (t) => {
      const r = await api.socialSendWeek(Number(t.dataset.id), true);
      if (r.data.approveUrl) toast('Week packed — check email / copy link from response', 'ok');
      else toast(r.data.reason || 'Done', 'ok');
      if (r.data.approveUrl) {
        openModal({
          title: 'Weekly batch',
          body: `<p>${r.data.sent ? 'Email sent to ' + esc(r.data.to) : 'Email not sent (SMTP?). Share this link:'}</p>
            <p class="mono" style="word-break:break-all">${esc(r.data.approveUrl || '')}</p>
            ${r.data.sendError ? `<p class="error">${esc(r.data.sendError)}</p>` : ''}`,
          buttons: [{ label: 'Close' }],
        });
      }
      pageSocial(_param, { campaignId: String(t.dataset.id) });
    },
    'camp-status': async (t) => {
      await api.socialCampaignStatus(Number(t.dataset.id), t.dataset.status);
      toast('Campaign updated', 'ok');
      pageSocial(_param, { campaignId: String(t.dataset.id) });
    },
    'approve-posts': async (t) => {
      const ids = [...view.querySelectorAll('.soc-post-pick:checked')].map((el) => Number(el.value));
      if (!ids.length) { toast('Select posts', 'err'); return; }
      await api.socialApprovePosts(ids);
      toast('Scheduled ' + ids.length + ' posts', 'ok');
      pageSocial(_param, { campaignId: t.dataset.camp });
    },
    'publish-one': async (t) => {
      const r = await api.socialPublishPost(Number(t.dataset.id));
      toast(`Publish: ${r.data.status}`, r.data.status === 'posted' ? 'ok' : 'err');
      pageSocial(_param, { campaignId: t.dataset.camp });
    },
    'save-post': async (t) => {
      const id = Number(t.dataset.id);
      const card = t.closest('.soc-post');
      const caption = $('.soc-cap', card).value;
      const scheduled_at = $('.soc-when', card).value
        ? new Date($('.soc-when', card).value).toISOString()
        : null;
      await api.socialUpdatePost(id, { caption, scheduled_at });
      toast('Post saved', 'ok');
    },
  });
}

function renderSocialCampaignDetail(detail) {
  const c = detail.campaign;
  const posts = detail.posts || [];
  return `
    <div class="card">
      <div class="panel-h">
        <h3>${esc(c.title || ('Campaign #' + c.id))}</h3>
        <div class="inline">
          <button class="btn small primary" type="button" data-act="send-week" data-id="${esc(c.id)}">Send this week</button>
          <button class="btn small" type="button" data-act="approve-posts" data-camp="${esc(c.id)}">Approve selected → schedule</button>
          ${c.status === 'active'
    ? `<button class="btn small" type="button" data-act="camp-status" data-id="${esc(c.id)}" data-status="paused">Pause</button>`
    : `<button class="btn small" type="button" data-act="camp-status" data-id="${esc(c.id)}" data-status="active">Activate</button>`}
        </div>
      </div>
      <p class="hint">${statusBadge(c.status)} · approval ${c.require_client_approval ? 'on' : 'off'} · images ${c.with_images ? 'on' : 'optional/off'} · ${esc(c.client_email || 'no client email')}</p>
      <div class="soc-posts">
        ${posts.map((p) => `
          <div class="card soc-post" style="margin:10px 0">
            <label class="inline"><input type="checkbox" class="soc-post-pick" value="${esc(p.id)}" /> <strong>#${esc(p.day_index)}</strong> ${statusBadge(p.status)}</label>
            <div class="meta hint">${esc((p.platforms || []).join(', '))} · ${p.with_image ? 'photo' : 'text only'}${p.publish_error ? ` · <span class="error">${esc(p.publish_error)}</span>` : ''}</div>
            <div class="field"><label>When (local)</label>
              <input class="soc-when" type="datetime-local" value="${esc(toLocalInput(p.scheduled_at))}" /></div>
            <div class="field"><label>Caption</label><textarea class="soc-cap" rows="3">${esc(p.caption || '')}</textarea></div>
            ${p.image_url ? `<img src="${esc(p.image_url)}" alt="" style="max-width:180px;border-radius:8px" />` : ''}
            <div class="inline">
              <button class="btn small" type="button" data-act="save-post" data-id="${esc(p.id)}">Save</button>
              <button class="btn small" type="button" data-act="publish-one" data-id="${esc(p.id)}" data-camp="${esc(c.id)}">Publish now</button>
            </div>
          </div>`).join('') || '<p class="hint">No posts</p>'}
      </div>
    </div>`;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* Jobs (web-only scheduled jobs)                                      */
/* ------------------------------------------------------------------ */

async function pageJobs() {
  const res = await api.jobsList();
  const d = res.data || {};
  const jobs = asList(d, ['jobs', 'rows']);
  const types = (Array.isArray(d.types) && d.types.length)
    ? d.types
    : ['discovery', 'outreach_process', 'imap_poll', 'design_poll_notify', 'social_weekly', 'social_publish', 'hands_off', 'hands_off_digest', 'custom'];
  view.innerHTML = `
    <div class="page-head"><div><h1>Jobs</h1><p class="lede">Schedule discovery, outreach, IMAP, social weekly send / publish, and custom work — also available via MCP <code>jobs.*</code>. Jobs honor the automation kill switch.</p></div></div>
    <div class="card"><h3>Create job</h3>
      <form id="job-form">
        <div class="row">
          <div class="field"><label>Name</label><input name="name" required placeholder="Nightly discovery" /></div>
          <div class="field"><label>Type</label><select name="type">${types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>
          <div class="field"><label>Interval (minutes)</label><input name="interval_minutes" type="number" min="1" value="360" /></div>
        </div>
        <div class="field"><label>Payload JSON (optional)</label><textarea name="payload" class="mono">{"category":"Plumber","location":"Springfield","limit":8}</textarea></div>
        <div class="inline"><button class="btn primary" type="submit">Create</button><span class="msg" id="job-msg"></span></div>
      </form>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Next run</th><th>Last run</th><th></th></tr></thead>
      <tbody>${jobs.map((j) => `<tr>
        <td>${esc(j.name)}<div class="hint">${j.enabled ? 'enabled' : 'disabled'} · every ${esc(j.interval_minutes || '—')} min</div></td>
        <td>${esc(j.type)}</td><td>${esc(j.next_run_at || '—')}</td>
        <td>${esc(j.last_status || '—')}<div class="hint">${esc(j.last_run_at || '')}</div></td>
        <td class="actions">
          <button class="btn small" data-act="run" data-id="${j.id}">Run now</button>
          <button class="btn small" data-act="toggle" data-id="${j.id}" data-en="${j.enabled ? 0 : 1}">${j.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn small danger" data-act="delete" data-id="${j.id}">Delete</button>
        </td></tr>`).join('') || '<tr><td colspan="5" class="empty">No jobs yet.</td></tr>'}</tbody>
    </table></div>`;

  $('#job-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = formObject(e.target);
    body.interval_minutes = Number(body.interval_minutes) || null;
    try { body.payload = JSON.parse(body.payload || '{}'); } catch { body.payload = {}; }
    try { await api.jobsCreate(body); toast('Job created', 'ok'); pageJobs(); }
    catch (err) { setMsg($('#job-msg'), err.message, 'err'); }
  };
  delegate(view, {
    run: async (t) => { await api.jobsRun(t.dataset.id); toast('Job executed', 'ok'); pageJobs(); },
    toggle: async (t) => { await api.jobsUpdate(t.dataset.id, { enabled: Number(t.dataset.en) === 1 }); pageJobs(); },
    delete: async (t) => { if (window.confirm('Delete job?')) { await api.jobsDelete(t.dataset.id); pageJobs(); } },
  });
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

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

function mcpGroupTools(data) {
  const groups = data.groups && typeof data.groups === 'object' ? data.groups : null;
  if (groups && Object.keys(groups).length) {
    return Object.keys(groups).sort().map((key) => ({
      key,
      names: groups[key] || [],
    }));
  }
  const names = data.tools || (data.catalog || []).map((t) => t.name);
  const map = {};
  for (const name of names) {
    const key = String(name).includes('.') ? String(name).split('.')[0] : 'other';
    if (!map[key]) map[key] = [];
    map[key].push(name);
  }
  return Object.keys(map).sort().map((key) => ({ key, names: map[key] }));
}

async function pageMcp() {
  const res = await api.mcpStatus();
  const d = res.data || {};
  const origin = window.location.origin;
  const endpoint = origin + '/mcp';
  const tokens = asList(d, ['tokens', 'rows']);
  const toolCount = d.toolCount != null ? d.toolCount : asList(d, ['tools']).length;
  const serverLabel = d.server
    ? `${d.server.name || 'website-scout-web-mcp'} ${d.server.version || ''}`.trim()
    : 'website-scout-web-mcp';
  const snippet = mcpCursorSnippet(endpoint, '<YOUR_WORKSPACE_TOKEN>');
  const grouped = mcpGroupTools(d);
  const catalogByName = {};
  (d.catalog || []).forEach((t) => { catalogByName[t.name] = t.description || ''; });

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>MCP</h1>
        <p class="lede">Streamable HTTP MCP for this workspace. Point Cursor (or any MCP client) at the URL below with a Bearer token — no local port, Tailscale, or desktop bind.</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" data-act="copy-endpoint">Copy endpoint</button>
        <button class="btn primary" type="button" data-act="copy-config">Copy Cursor config</button>
      </div>
    </div>

    <div class="grid cols-2" style="align-items:start">
      <div class="card">
        <h3>Endpoint</h3>
        <p class="mono" id="mcp-endpoint">${esc(endpoint)}</p>
        <p class="hint" style="margin-top:8px">
          Auth: <code>Authorization: Bearer &lt;token&gt;</code>
          · ${esc(serverLabel)}
          ${d.protocolVersion ? ` · protocol ${esc(d.protocolVersion)}` : ''}
          · ${esc(String(toolCount))} tools
        </p>
        <h3 style="margin-top:16px">Cursor <code>mcp.json</code></h3>
        <p class="hint">Paste into <code>~/.cursor/mcp.json</code> or project <code>.cursor/mcp.json</code>, then replace <code>&lt;YOUR_WORKSPACE_TOKEN&gt;</code> with a token you mint below.</p>
        <pre class="out" id="mcp-snippet">${esc(snippet)}</pre>
        <div class="inline" style="margin-top:8px">
          <button class="btn small" type="button" data-act="copy-config">Copy config</button>
          <button class="btn small" type="button" data-act="copy-endpoint">Copy URL</button>
        </div>
      </div>

      <div class="card">
        <h3>Create token</h3>
        <p class="hint">Tokens are scoped to the current workspace. The full secret is shown once.</p>
        <div class="row end">
          <div class="field"><label class="lbl" for="mcp-name">Name</label>
            <input id="mcp-name" type="text" maxlength="80" value="Cursor" placeholder="e.g. Cursor laptop" autocomplete="off" />
          </div>
          <div class="field" style="flex:0 0 auto">
            <button class="btn primary" type="button" data-act="mint">Create MCP token</button>
          </div>
        </div>
        <div class="msg" id="mcp-msg"></div>
        <div id="mcp-token-panel" class="hidden" style="margin-top:10px">
          <p class="hint">Raw token (copy now — it will not be shown again):</p>
          <pre class="out" id="mcp-token-out"></pre>
          <div class="inline" style="margin-top:8px">
            <button class="btn small primary" type="button" data-act="copy-token">Copy token</button>
            <button class="btn small" type="button" data-act="copy-filled">Copy config with token</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="panel-h">
        <h3>Workspace tokens (${tokens.length})</h3>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th>Created</th><th></th></tr></thead>
        <tbody>${tokens.map((t) => `<tr>
          <td>${esc(t.name)}</td>
          <td class="mono">${esc(t.token_prefix)}…</td>
          <td>${esc(fmtDate(t.last_used_at) || '—')}</td>
          <td>${esc(fmtDate(t.created_at) || '—')}</td>
          <td class="actions"><button class="btn small danger" type="button" data-act="revoke" data-id="${esc(t.id)}">Revoke</button></td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">No tokens yet. Create one to connect Cursor.</td></tr>'}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="panel-h">
        <h3>Tool catalog (${toolCount})</h3>
        <span class="hint">Same names <code>tools/list</code> returns over MCP</span>
      </div>
      <div class="mcp-tool-groups">
        ${grouped.map((g) => `
          <details class="mcp-tool-group"${g.names.length <= 12 ? ' open' : ''}>
            <summary><strong>${esc(g.key)}</strong> <span class="hint">${g.names.length}</span></summary>
            <ul class="mcp-tool-list">
              ${g.names.map((name) => {
                const desc = catalogByName[name];
                return `<li><code>${esc(name)}</code>${desc ? ` <span class="hint">— ${esc(desc)}</span>` : ''}</li>`;
              }).join('')}
            </ul>
          </details>`).join('') || '<p class="hint">No tools reported.</p>'}
      </div>
    </div>`;

  let lastToken = '';
  delegate(view, {
    'copy-endpoint': () => copyText(endpoint),
    'copy-config': () => copyText(snippet),
    'copy-token': () => {
      if (!lastToken) { toast('Mint a token first', 'err'); return; }
      return copyText(lastToken);
    },
    'copy-filled': () => {
      if (!lastToken) { toast('Mint a token first', 'err'); return; }
      return copyText(mcpCursorSnippet(endpoint, lastToken));
    },
    mint: async () => {
      const out = (await api.mcpToken($('#mcp-name').value.trim() || 'MCP')).data;
      lastToken = out.token;
      const pre = $('#mcp-token-out');
      pre.textContent = out.token;
      $('#mcp-token-panel').classList.remove('hidden');
      setMsg($('#mcp-msg'), out.hint || 'Copy now — shown only once.', 'ok');
      toast('Token created — copy it now', 'ok');
    },
    revoke: async (t) => {
      if (!window.confirm('Revoke this token? Agents using it will lose access.')) return;
      await api.mcpRevoke(Number(t.dataset.id));
      toast('Token revoked', 'ok');
      pageMcp();
    },
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

let settingsTab = 'team';

const SETTINGS_TABS = [
  ['team', 'Team', 'sec-team'],
  ['ai', 'AI', 'sec-ai'],
  ['cost', 'Cost', 'sec-cost'],
  ['prompts', 'Prompts', 'sec-prompts'],
  ['automation', 'Automation', 'sec-automation'],
  ['handsoff', 'Hands-off', 'sec-hands-off'],
  ['agent', 'Design agent', 'sec-agent'],
  ['learning', 'Design learning', 'sec-learning'],
  ['discovery', 'Discovery', 'sec-discovery'],
  ['email', 'Email', 'sec-smtp'],
  ['sms', 'SMS', 'sec-sms'],
  ['social', 'Social', 'sec-meta'],
  ['cloudflare', 'Cloudflare', 'sec-cf'],
  ['keys', 'Provider keys', 'sec-keys'],
  ['footer', 'Footer & scoring', 'sec-mail'],
];

async function pageSettings(param) {
  const safe = (p) => p.then((r) => r.data, () => null);
  const [setR, promptsR, schedR, provR, usageR, aiR, cfR, hoR] = await Promise.all([
    api.settingsGet(), safe(api.prompts()), safe(api.discoveryGet()), safe(api.providers()),
    safe(api.aiUsage(30)), safe(api.aiStatus()), safe(api.cfGet()), safe(api.handsOffStatus()),
  ]);
  const s = (setR.data && setR.data.settings) || {};
  const prompts = asList(promptsR, ['prompts', 'rows']);
  const sched = schedR || {};
  const ho = hoR || {};
  const providers = asList(provR, ['providers']).filter((p) => p.name !== 'csv' && p.name !== 'manual');
  const paused = s.automation_paused === '1';
  automationPaused = paused;

  const requested = (param && String(param).split('/')[0]) || settingsTab || 'team';
  settingsTab = SETTINGS_TABS.some(([k]) => k === requested) ? requested : 'team';
  const activeSec = (SETTINGS_TABS.find(([k]) => k === settingsTab) || SETTINGS_TABS[0])[2];
  const showSec = (id) => (id === activeSec ? '' : ' hidden');

  const f = (key, label, o) => {
    const opt = o || {};
    const val = s[key] == null ? (opt.def == null ? '' : opt.def) : s[key];
    let input;
    if (opt.options) input = `<select data-key="${esc(key)}">${opt.options.map(([v, l]) => `<option value="${esc(v)}" ${String(val) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    else if (opt.area) input = `<textarea data-key="${esc(key)}" rows="3">${esc(val)}</textarea>`;
    else input = `<input data-key="${esc(key)}" type="${opt.type || 'text'}" value="${esc(val)}" ${opt.step ? `step="${opt.step}"` : ''} ${opt.min != null ? `min="${opt.min}"` : ''} ${opt.placeholder ? `placeholder="${esc(opt.placeholder)}"` : ''} autocomplete="off" />`;
    return `<div class="field"><label>${esc(label)}</label>${input}${opt.hint ? `<div class="hint">${opt.hint}</div>` : ''}</div>`;
  };
  const secret = (key, label, hint) => `<div class="field"><label>${esc(label)} <span class="badge ${s[key] === '***' ? 'ok' : ''}">${s[key] === '***' ? 'set' : 'not set'}</span></label>
    <input data-secret="${esc(key)}" type="password" autocomplete="new-password" placeholder="${s[key] === '***' ? '(saved — enter to replace)' : 'Paste key'}" />${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const save = (id, label) => `<div class="inline"><button class="btn primary" data-act="save" data-sec="${id}">${esc(label)}</button><span class="msg" data-msg="${id}"></span></div>`;
  const onOff = [['1', 'On'], ['0', 'Off']];

  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p class="lede">Provider keys, spend limits, prompts, email, publishing and the kill switch for this workspace. Secrets are write-only: they are never shown again after saving. Changing settings requires an owner or admin role.</p></div></div>
    <div class="tabs settings-tabs" id="settings-tabs" role="tablist" aria-label="Settings sections">${SETTINGS_TABS.map(([k, l]) =>
      `<button type="button" role="tab" data-tab="${k}" class="${k === settingsTab ? 'active' : ''}" aria-selected="${k === settingsTab ? 'true' : 'false'}">${esc(l)}</button>`).join('')}</div>
    <div class="settings-main">

        <section class="card" id="sec-team"${showSec('sec-team')}><h2>Team invites</h2>
          <p class="hint">Invite teammates by email. They must register or sign in with that exact address. Owners and admins can invite.</p>
          <form id="invite-form" class="row" style="align-items:flex-end">
            <div class="field" style="flex:2"><label for="inv-email">Email</label><input id="inv-email" name="email" type="email" required placeholder="teammate@example.com" /></div>
            <div class="field"><label for="inv-role">Role</label>
              <select id="inv-role" name="role"><option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option></select>
            </div>
            <button class="btn primary" type="submit">Send invite</button>
          </form>
          <div class="msg" id="inv-msg"></div>
          <div id="inv-list" style="margin-top:14px"><p class="hint">Loading invites…</p></div>
        </section>

        <section class="card" id="sec-ai"${showSec('sec-ai')}><h2>AI provider</h2>
          <p class="hint">Each task can use its own model; a blank row uses the default.</p>
          <div class="spend">AI spend — today: ${money(usageR && usageR.todayUsd)} · this month: ${money(usageR && usageR.monthUsd)} · ${aiR && aiR.configured ? 'API key configured' : 'no API key'}</div>
          ${secret('ai.api_key', 'API key', 'Stored on the server; never displayed again.')}
          ${f('ai.base_url', 'Base URL')}
          <div class="field"><label>Model routing</label>
            <table><thead><tr><th>Task</th><th>Model (blank = default)</th></tr></thead><tbody>
              <tr><td>default</td><td><input data-key="ai.model.default" value="${esc(s['ai.model.default'] || '')}" /></td></tr>
              ${MODEL_TASKS.map((t) => `<tr><td>${esc(t)}</td><td><input data-key="ai.model.${t}" value="${esc(s['ai.model.' + t] || '')}" /></td></tr>`).join('')}
            </tbody></table></div>
          ${save('sec-ai', 'Save AI settings')}
        </section>

        <section class="card" id="sec-cost"${showSec('sec-cost')}><h2>Cost controls</h2>
          <p class="hint">Hard stops for AI spend and daily production.</p>
          <div class="row">${f('cost.daily_budget_usd', 'Daily AI budget (USD)', { type: 'number', step: '0.5', min: 0 })}${f('cost.max_websites_per_day', 'Max websites / day', { type: 'number', min: 0 })}${f('cost.max_outreach_per_day', 'Max outreach / day (email + SMS)', { type: 'number', min: 0 })}</div>
          <div class="row">${f('cost.per_1k_prompt', 'Cost / 1k prompt tokens (USD)', { type: 'number', step: '0.0001', min: 0 })}${f('cost.per_1k_completion', 'Cost / 1k completion tokens (USD)', { type: 'number', step: '0.0001', min: 0 })}</div>
          ${save('sec-cost', 'Save cost controls')}
        </section>

        <section class="card" id="sec-prompts"${showSec('sec-prompts')}><h2>Prompt library</h2>
          <p class="hint">System prompts for each AI task. Restore brings back the shipped default.</p>
          <div class="field" style="max-width:320px"><label for="pr-sel">Prompt</label><select id="pr-sel">${prompts.map((p) => `<option value="${esc(p.key)}">${esc(p.name || p.key)}</option>`).join('')}</select></div>
          <div class="field"><label for="pr-body">Body</label><textarea id="pr-body" rows="10" class="mono"></textarea></div>
          <div class="inline"><button class="btn primary" data-act="prompt-save">Save prompt</button><button class="btn" data-act="prompt-reset">Restore default</button><span class="msg" id="pr-msg"></span></div>
        </section>

        <section class="card" id="sec-automation"${showSec('sec-automation')}><h2>Automation</h2>
          <p class="hint">Pause stops scanning, generation, campaigns, scheduled jobs and AI actions.</p>
          <p>Status: <strong id="auto-status">${paused ? 'Paused' : 'Running'}</strong></p>
          <div class="inline"><button class="btn" data-act="auto-toggle" id="auto-toggle">${paused ? 'Resume automation' : 'Pause automation'}</button></div>
          <div style="margin-top:16px"><button class="big-danger" data-act="auto-stop">Emergency stop</button></div>
        </section>

        <section class="card" id="sec-hands-off"${showSec('sec-hands-off')}><h2>Hands-off mode</h2>
          <p class="hint">Unattended pipeline: discover → score → Meta Muse builds via tools → publish → email/SMS → follow-up → owner digest. Requires platform Meta Muse Model API key (<code>muse.model_*</code> in Admin). Honors the automation pause switch.</p>
          <p class="hint">Muse: <strong>${ho.museConfigured ? 'configured' : 'not configured'}</strong>${ho.museModel ? ' · ' + esc(ho.museModel) : ''} · Last run: ${esc(ho.lastRunAt || s['hands_off.last_run_at'] || '—')} · Last digest: ${esc(ho.lastDigestAt || s['hands_off.last_digest_at'] || '—')}</p>
          <div class="row">
            ${f('hands_off.enabled', 'Hands-off', { options: onOff })}
            ${f('hands_off.min_score', 'Min score to build', { type: 'number', min: 0, def: '50' })}
            ${f('hands_off.max_sites_per_day', 'Max sites / day', { type: 'number', min: 0, def: '5' })}
            ${f('hands_off.followup_days', 'Follow-up days', { type: 'number', min: 1, def: '3' })}
          </div>
          <div class="row">
            ${f('hands_off.channel', 'Outreach channel', { options: [['both', 'Email + SMS'], ['email', 'Email only'], ['sms', 'SMS only']] })}
            ${f('hands_off.template_id', 'Template id (optional)', { placeholder: 'first dual-channel template' })}
            ${f('hands_off.report_email', 'Digest email', { type: 'email', placeholder: 'falls back to support.email' })}
          </div>
          <div class="inline">
            ${save('sec-hands-off', 'Save Hands-off')}
            <button class="btn" type="button" data-act="hands-off-run">Run tick now</button>
            <span class="msg" data-msg="hands-off-run"></span>
          </div>
        </section>

        <section class="card" id="sec-agent"${showSec('sec-agent')}><h2>Design agent trigger</h2>
          <p class="hint">When a design job becomes <code>waiting_on_agent</code> the server writes a trigger file and can run a command or POST a webhook (redesign / improvements). Failures never block the queue.</p>
          ${f('design.agent_notify', 'Notify', { options: onOff })}
          ${f('design.agent_trigger_command', 'Trigger command (optional)', { hint: 'Placeholders: <code>{{job_id}}</code>, <code>{{reason}}</code>, <code>{{status}}</code>, <code>{{message}}</code>. Runs on the server.' })}
          ${f('design.agent_webhook_url', 'Webhook URL (optional)', { type: 'url', placeholder: 'https://example.com/hooks/design-agent', hint: 'POSTed as JSON when redesign or improvements is queued.' })}
          ${f('design.agent_webhook_secret', 'Webhook secret (optional)', { type: 'password', hint: 'Sent as <code>Authorization: Bearer …</code> and <code>X-Webhook-Secret</code>.' })}
          ${f('design.agent_trigger_file', 'Trigger file path (optional)', { hint: 'Default: <code>design-agent-trigger.json</code> beside the workspace database.' })}
          ${save('sec-agent', 'Save design agent trigger')}
        </section>

        <section class="card" id="sec-learning"${showSec('sec-learning')}><h2>Design learning</h2>
          <p class="hint">Reviews, redesign requests and client emails feed a short playbook that is added to new design briefs.</p>
          <div class="row">${f('design.learning.enabled', 'Learning', { options: onOff })}${f('design.learning.max_playbook', 'Max playbook lessons', { type: 'number', min: 4, def: '24' })}</div>
          ${save('sec-learning', 'Save learning settings')}
          <div id="st-learning" style="margin-top:12px"></div>
        </section>

        <section class="card" id="sec-discovery"${showSec('sec-discovery')}><h2>Discovery schedule</h2>
          <p class="hint">Runs lead discovery on the server on a schedule. Honors the automation pause switch.</p>
          <div class="row">
            <div class="field"><label>Schedule</label><select id="ds-enabled"><option value="0" ${sched.enabled ? '' : 'selected'}>Off</option><option value="1" ${sched.enabled ? 'selected' : ''}>On</option></select></div>
            <div class="field"><label>Frequency</label><select id="ds-mode"><option value="interval" ${sched.mode === 'daily' ? '' : 'selected'}>Every N hours</option><option value="daily" ${sched.mode === 'daily' ? 'selected' : ''}>Daily at a time</option></select></div>
            <div class="field"><label>Interval (hours)</label><input id="ds-interval" type="number" min="1" max="168" value="${esc(sched.interval_hours || 6)}" /></div>
            <div class="field"><label>Daily time</label><input id="ds-daily" type="time" value="${esc(sched.daily_time || '09:00')}" /></div>
          </div>
          <div class="row">
            <div class="field"><label>Provider</label><select id="ds-provider">${(providers.length ? providers : [{ name: sched.provider || 'tavily' }]).map((p) => `<option value="${esc(p.name)}" ${p.name === sched.provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
            <div class="field"><label>Category / niche</label><input id="ds-category" value="${esc(sched.category || '')}" placeholder="Plumber or * for any" /><div class="hint">Use <code>*</code> or <code>any</code> for all niches.</div></div>
            <div class="field"><label>Location</label><input id="ds-location" value="${esc(sched.location || '')}" placeholder="Springfield" /></div>
          </div>
          <div class="row">
            <div class="field"><label>Limit per run</label><input id="ds-limit" type="number" min="1" max="50" value="${esc(sched.limit || 8)}" /></div>
            <div class="field"><label>Lead group (optional)</label><input id="ds-group" value="${esc(sched.group || '')}" /></div>
            <div class="field"><label>Score new leads</label><select id="ds-score"><option value="1" ${sched.score === false ? '' : 'selected'}>Yes</option><option value="0" ${sched.score === false ? 'selected' : ''}>No</option></select></div>
            <div class="field"><label>Website</label><select id="ds-web"><option value="">Any</option><option value="has" ${sched.websitePresence === 'has' ? 'selected' : ''}>Has website</option><option value="no" ${sched.websitePresence === 'no' ? 'selected' : ''}>No website</option></select></div>
          </div>
          <div class="inline"><button class="btn primary" data-act="disc-save">Save schedule</button><button class="btn" data-act="disc-run">Run now</button><span class="msg" id="ds-msg"></span></div>
          <p class="hint" id="ds-status" style="margin-top:10px">${esc(sched.enabled ? 'Enabled' : 'Disabled')} · next: ${esc(sched.next_run || '—')} · last: ${esc(sched.last_run || '—')} ${esc(sched.last_status || '')} ${esc(sched.last_error || '')}</p>
        </section>

        <section class="card" id="sec-sms"${showSec('sec-sms')}><h2>SMS (Twilio)</h2>
          <p class="hint">Text-message outreach. When <code>sms.enabled</code> is off or credentials are missing, queued SMS is stub-sent (logged, marked sent) so drafts still work. Platform Admin → SMS can seed defaults for new workspaces.</p>
          <div class="row">${f('sms.enabled', 'SMS enabled', { options: onOff })}${f('sms.provider', 'Provider', { options: [['twilio', 'Twilio'], ['vonage', 'Vonage (not implemented)'], ['custom', 'Custom → Twilio API']] })}</div>
          <div class="row">${f('sms.account_sid', 'Account SID')}${f('sms.from_number', 'From number', { placeholder: '+15551234567' })}</div>
          ${secret('sms.auth_token', 'Auth token')}
          ${f('sms.webhook_url', 'Inbound webhook URL (optional)', { placeholder: 'https://…' })}
          ${save('sec-sms', 'Save SMS settings')}
        </section>

        <section class="card" id="sec-smtp"${showSec('sec-smtp')}><h2>Email (SMTP + IMAP)</h2>
          <p class="hint">SMTP sends design/outreach mail. Each job email also includes a public <strong>client form</strong> link for answers and change requests (works without IMAP). Optional IMAP still polls replies with <code>[Job #N]</code>.</p>
          <h3 style="margin:12px 0 8px;font-size:15px">SMTP (outbound)</h3>
          <div class="row">${f('smtp.host', 'Host', { placeholder: 'mail.example.com' })}${f('smtp.port', 'Port', { type: 'number', min: 1 })}${f('smtp.secure', 'Use TLS (port 465)', { options: [['0', 'No (STARTTLS / plain)'], ['1', 'Yes']] })}</div>
          <div class="row">${f('smtp.user', 'Username')}${secret('smtp.pass', 'Password')}</div>
          <div class="row">${f('smtp.from_name', 'From name')}${f('smtp.from_email', 'From email')}</div>
          <h3 style="margin:18px 0 8px;font-size:15px">IMAP (inbound replies)</h3>
          <div class="row">${f('mail.imap.enabled', 'IMAP polling', { options: onOff })}${f('mail.imap.auto_submit', 'Auto-queue change requests', { options: onOff, hint: 'When on, redesign/improve replies are submitted to waiting_on_agent.' })}</div>
          <div class="row">${f('mail.imap.host', 'IMAP host', { placeholder: '(defaults to SMTP host)' })}${f('mail.imap.port', 'Port', { type: 'number', min: 1, def: '993' })}${f('mail.imap.secure', 'TLS', { options: [['1', 'Yes (993)'], ['0', 'No']] })}</div>
          <div class="row">${f('mail.imap.user', 'IMAP username', { placeholder: '(defaults to SMTP user)' })}${secret('mail.imap.pass', 'IMAP password', 'Leave blank to reuse the SMTP password.')}</div>
          <div class="row">${f('mail.imap.mailbox', 'Mailbox', { def: 'INBOX' })}${f('mail.inbound_drop_dir', 'Drop folder (optional)', { placeholder: '(default: workspace data / inbound-email)' })}</div>
          <div class="inline">${save('sec-smtp', 'Save email settings')}<button class="btn" type="button" data-act="imap-test">Poll inbox now</button><span class="msg" data-msg="imap-test"></span></div>
        </section>

        <section class="card" id="sec-meta"${showSec('sec-meta')}><h2>Social (Meta)</h2>
          <p class="hint">Facebook + Instagram posting. Create a Meta app, add the OAuth redirect
            <code>${esc((window.location.origin || '') + '/api/v1/social/meta/callback')}</code>,
            and request Page + Instagram publishing permissions. Images are optional — Instagram skips caption-only posts.</p>
          ${f('meta.app_id', 'Meta App ID')}
          ${secret('meta.app_secret', 'Meta App Secret')}
          ${f('social.image_price_usd', 'Branded image ad price (USD)', { type: 'number', step: '0.01', min: 0, hint: 'Charged per image for Free/Standard. Premium includes social images at $0. Falls back to the platform admin default when blank.' })}
          ${save('sec-meta', 'Save Meta settings')}
        </section>

        <section class="card" id="sec-cf"${showSec('sec-cf')}><h2>Cloudflare Pages &amp; Domains</h2>
          <p class="hint">Publish previews and buy/link domains (Domains page). Token needs Account → Cloudflare Pages → Edit and Account → Registrar → Edit. Set a default payment method on Cloudflare before purchasing. ${cfR ? (cfR.configured ? '<span class="badge ok">configured</span>' : '<span class="badge warn">not configured</span>') : ''}</p>
          <div class="row">${f('cf.account_id', 'Account ID', { placeholder: '32-character hex ID' })}${f('cf.project', 'Pages project', { placeholder: 'my-preview-sites' })}</div>
          ${f('cf.preview_domain', 'Custom preview domain (optional)', { placeholder: 'previews.example.com' })}
          ${secret('cf.api_token', 'API token')}
          <div class="inline"><button class="btn primary" data-act="save" data-sec="sec-cf">Save Cloudflare settings</button><button class="btn" data-act="cf-test">Test connection</button><span class="msg" data-msg="sec-cf"></span></div>
          <div id="cf-out" class="hint" style="margin-top:8px"></div>
        </section>

        <section class="card" id="sec-keys"${showSec('sec-keys')}><h2>Provider keys</h2>
          <p class="hint">Write-only. Leave blank to keep the current value.</p>
          ${secret('providers.tavily.api_key', 'Tavily (lead discovery)', 'Required for Leads → Discover with the <code>tavily</code> provider.')}
          ${f('providers.tavily.search_depth', 'Tavily search depth', { options: [['advanced', 'advanced (better relevance)'], ['basic', 'basic (faster / cheaper)']] })}
          ${secret('pexels.api_key', 'Pexels (stock photos)')}
          ${secret('fal.api_key', 'fal.ai (image enhance)')}
          ${save('sec-keys', 'Save provider keys')}
        </section>

        <section class="card" id="sec-mail"${showSec('sec-mail')}><h2>Footer &amp; scoring</h2>
          ${f('mail.footer', 'Legal footer appended to every outreach email', { area: true })}
          <div class="row">${f('score.threshold_qualified', 'Qualified threshold (0–100)', { type: 'number', min: 0 })}${f('score.threshold_hot', 'Hot threshold (0–100)', { type: 'number', min: 0 })}${f('app.name', 'App name')}</div>
          ${save('sec-mail', 'Save')}
        </section>
    </div>`;

  $('#settings-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    window.location.hash = '#/settings/' + b.dataset.tab;
  };

  mountLearning($('#st-learning'));

  async function refreshInvites() {
    const host = $('#inv-list');
    if (!host) return;
    try {
      const rows = asList((await api.invitesList()).data, ['invites', 'rows']);
      host.innerHTML = `<table><thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Status</th></tr></thead><tbody>
        ${rows.map((r) => `<tr>
          <td>${esc(r.email)}</td><td>${esc(r.role)}</td><td>${esc(fmtDate(r.expires_at))}</td>
          <td>${r.accepted_at ? '<span class="badge ok">accepted</span>' : '<span class="badge">pending</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="4">No invites yet</td></tr>'}
      </tbody></table>`;
    } catch (err) {
      host.innerHTML = `<p class="hint">${esc(err.message || 'Could not load invites')}</p>`;
    }
  }
  refreshInvites();
  const invForm = $('#invite-form');
  if (invForm) {
    invForm.onsubmit = async (e) => {
      e.preventDefault();
      const msg = $('#inv-msg');
      setMsg(msg, 'Sending…');
      try {
        const body = formObject(e.target);
        const r = await api.invitesCreate(body);
        const data = r.data || {};
        if (data.link) setMsg(msg, 'Invite created (email not sent). Link: ' + data.link, 'ok');
        else setMsg(msg, data.emailed ? 'Invite emailed.' : 'Invite created.', 'ok');
        e.target.reset();
        refreshInvites();
      } catch (err) { setMsg(msg, err.message, 'err'); }
    };
  }

  const loadPrompt = () => {
    const p = prompts.find((x) => x.key === $('#pr-sel').value);
    $('#pr-body').value = p ? p.body : '';
  };
  $('#pr-sel').addEventListener('change', loadPrompt);
  loadPrompt();

  async function saveSection(secId, btn) {
    const sec = document.getElementById(secId);
    const msg = $(`[data-msg="${secId}"]`, sec);
    setMsg(msg, 'Saving…');
    try {
      for (const el of $$('[data-key]', sec)) await api.settingsSet(el.dataset.key, el.value);
      for (const el of $$('[data-secret]', sec)) {
        if (el.value.trim()) { await api.settingsSecret(el.dataset.secret, el.value.trim()); el.value = ''; }
      }
      setMsg(msg, 'Saved', 'ok');
      toast('Settings saved', 'ok');
    } catch (err) { setMsg(msg, err.message, 'err'); }
    return btn;
  }

  delegate(view, {
    save: (t) => saveSection(t.dataset.sec, t),
    'prompt-save': async () => {
      await api.promptSave($('#pr-sel').value, $('#pr-body').value);
      const p = prompts.find((x) => x.key === $('#pr-sel').value);
      if (p) p.body = $('#pr-body').value;
      setMsg($('#pr-msg'), 'Saved', 'ok');
    },
    'prompt-reset': async () => {
      if (!window.confirm('Restore the shipped default for this prompt?')) return;
      const r = (await api.promptReset($('#pr-sel').value)).data;
      const p = prompts.find((x) => x.key === r.key);
      if (p) p.body = r.body;
      $('#pr-body').value = r.body;
      setMsg($('#pr-msg'), 'Restored', 'ok');
    },
    'auto-toggle': async () => {
      await setAutomation(!automationPaused);
      settingsTab = 'automation';
      if (window.location.hash === '#/settings/automation') pageSettings('automation');
      else window.location.hash = '#/settings/automation';
    },
    'auto-stop': async () => {
      if (!window.confirm('Pause ALL automation now?')) return;
      await setAutomation(true);
      settingsTab = 'automation';
      if (window.location.hash === '#/settings/automation') pageSettings('automation');
      else window.location.hash = '#/settings/automation';
    },
    'cf-test': async () => {
      const out = $('#cf-out');
      out.textContent = 'Testing connection…';
      const r = (await api.cfTest()).data;
      if (r.ok === false) out.innerHTML = `<span class="error">${esc(r.error)}</span>${r.hint || r.detail ? ' — ' + esc(r.hint || r.detail) : ''}`;
      else out.innerHTML = `<span class="check-pass">Connected.</span> Projects: ${esc((r.projects || []).join(', ') || 'none')}`;
    },
    'imap-test': async () => {
      const msg = $('[data-msg="imap-test"]');
      setMsg(msg, 'Polling…');
      try {
        const r = (await api.emailImapPoll({ force: true })).data;
        if (r.skipped) setMsg(msg, r.reason || 'skipped', 'err');
        else setMsg(msg, `Fetched ${r.fetched || 0}, processed ${r.processed || 0}`, 'ok');
      } catch (err) { setMsg(msg, err.message, 'err'); }
    },
    'disc-save': async () => {
      const msg = $('#ds-msg');
      try {
        const r = (await api.discoverySet({
          enabled: $('#ds-enabled').value === '1', mode: $('#ds-mode').value,
          interval_hours: Number($('#ds-interval').value) || 6, daily_time: $('#ds-daily').value || '09:00',
          provider: $('#ds-provider').value, category: $('#ds-category').value.trim(), location: $('#ds-location').value.trim(),
          limit: Number($('#ds-limit').value) || 8, score: $('#ds-score').value === '1',
          group: $('#ds-group').value.trim(), websitePresence: $('#ds-web').value,
        })).data.schedule || {};
        setMsg(msg, 'Saved', 'ok');
        $('#ds-status').textContent = `${r.enabled ? 'Enabled' : 'Disabled'} · next: ${r.next_run || '—'} · last: ${r.last_run || '—'}`;
      } catch (err) { setMsg(msg, err.message, 'err'); }
    },
    'disc-run': async () => {
      const msg = $('#ds-msg');
      setMsg(msg, 'Running discovery…');
      const r = (await api.discoveryRun()).data;
      setMsg(msg, r && r.skipped ? `Skipped: ${r.reason}` : `Done${r && r.created != null ? ': ' + r.created + ' created' : ''}.`, 'ok');
    },
    'hands-off-run': async () => {
      const msg = $('[data-msg="hands-off-run"]');
      setMsg(msg, 'Running Hands-off tick…');
      try {
        const r = (await api.handsOffRun(false)).data;
        if (r && r.skipped) setMsg(msg, `Skipped: ${r.reason}`, 'err');
        else setMsg(msg, `Done — discovered ${r.discovered || 0}, scored ${r.scored || 0}, delivered ${r.delivered || 0}.`, 'ok');
      } catch (err) { setMsg(msg, err.message, 'err'); }
    },
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function parseHash() {
  const m = (window.location.hash || '#/dashboard').match(/^#\/([a-z-]+)(?:\/([^?]*))?(?:\?(.*))?$/);
  if (!m) return { route: 'dashboard', param: '', query: {} };
  const query = {};
  new URLSearchParams(m[3] || '').forEach((v, k) => { query[k] = v; });
  return { route: m[1], param: m[2] || '', query };
}

/* ------------------------------------------------------------------ */
/* Platform super admin                                                */
/* ------------------------------------------------------------------ */

let adminTab = 'overview';

async function pageAdmin(param) {
  if (!currentUserIsSuperAdmin) {
    view.innerHTML = '<div class="card error-card"><h2>Super admin only</h2><p>Your account is not a platform administrator.</p></div>';
    return;
  }
  const tab = (param && String(param).split('/')[0]) || adminTab || 'overview';
  adminTab = tab;
  const tabs = [
    ['overview', 'Overview'],
    ['users', 'Users'],
    ['workspaces', 'Workspaces'],
    ['payments', 'Payments'],
    ['upsell', 'Upsell tips'],
    ['email', 'Email'],
    // SMS admin tab hidden until a send path exists (settings still accept sms.* keys).
    ['keys', 'API keys'],
    ['billing', 'Stripe'],
    ['general', 'General'],
    ['audit', 'Audit'],
  ];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Platform admin</h1><p class="lede">Manage users, workspaces, and platform-wide defaults.</p></div>
    </div>
    <div class="tabs" id="admin-tabs">${tabs.map(([k, l]) =>
      `<button type="button" class="${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="admin-body"><p class="hint">Loading…</p></div>`;

  $('#admin-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    window.location.hash = '#/admin/' + b.dataset.tab;
  };

  const body = $('#admin-body');
  try {
    if (tab === 'overview') await renderAdminOverview(body);
    else if (tab === 'users') await renderAdminUsers(body);
    else if (tab === 'workspaces') await renderAdminWorkspaces(body);
    else if (tab === 'payments') await renderAdminPayments(body);
    else if (tab === 'upsell') await renderAdminUpsellTips(body);
    else if (tab === 'email' || tab === 'sms' || tab === 'keys' || tab === 'general' || tab === 'billing') await renderAdminSettings(body, tab);
    else if (tab === 'audit') await renderAdminAudit(body);
    else body.innerHTML = '<p class="hint">Unknown tab</p>';
  } catch (err) {
    body.innerHTML = `<div class="card error-card"><p>${esc(err.message)}</p></div>`;
  }
}

async function renderAdminOverview(el) {
  const ov = (await api.adminOverview()).data;
  el.innerHTML = `
    <div class="stats-cards">
      <div class="stat-card"><div class="n">${ov.users}</div><div class="l">Users</div></div>
      <div class="stat-card"><div class="n">${ov.usersActive}</div><div class="l">Active</div></div>
      <div class="stat-card"><div class="n">${ov.workspaces}</div><div class="l">Workspaces</div></div>
      <div class="stat-card"><div class="n">${ov.superAdmins}</div><div class="l">Super admins</div></div>
      <div class="stat-card"><div class="n">${ov.mcpTokens}</div><div class="l">MCP tokens</div></div>
      <div class="stat-card"><div class="n">${ov.scheduledJobs}</div><div class="l">Scheduled jobs</div></div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-b">
        <p>Registration: <strong>${ov.registrationOpen ? 'open' : 'closed'}</strong> ·
           Maintenance: <strong>${ov.maintenanceMode ? 'on' : 'off'}</strong></p>
        <div class="row actions" style="margin-top:0.75rem">
          <button class="btn" type="button" id="admin-push">Push defaults to all workspaces (fill empty)</button>
          <button class="btn ghost" type="button" id="admin-push-force">Force overwrite defaults</button>
        </div>
        <div class="msg" id="admin-ov-msg"></div>
      </div>
    </div>`;
  $('#admin-push').onclick = () => safeRun($('#admin-ov-msg'), async () => {
    const r = await api.adminPushDefaults({ force: false });
    $('#admin-ov-msg').textContent = `Updated ${r.data.cellsUpdated} setting cells across ${r.data.workspaces} workspaces.`;
    $('#admin-ov-msg').className = 'msg ok';
  });
  $('#admin-push-force').onclick = () => {
    if (!confirm('Overwrite workspace settings with platform defaults?')) return;
    safeRun($('#admin-ov-msg'), async () => {
      const r = await api.adminPushDefaults({ force: true });
      $('#admin-ov-msg').textContent = `Force-updated ${r.data.cellsUpdated} cells across ${r.data.workspaces} workspaces.`;
      $('#admin-ov-msg').className = 'msg ok';
    });
  };
}

function adminUserStatusLabel(status) {
  return String(status || 'active') === 'disabled' ? 'blocked' : 'active';
}

function openAdminEditUser(u) {
  const m = openModal({
    title: 'Edit user',
    body: `<form id="admin-edit-user-form" class="stack">
      <div><label>Email</label><input name="email" type="email" required value="${esc(u.email || '')}" /></div>
      <div><label>Name</label><input name="name" value="${esc(u.name || '')}" /></div>
      <div><label>New password <span class="hint">(optional)</span></label>
        <input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="Leave blank to keep" /></div>
      <div class="msg" id="admin-edit-user-msg"></div>
    </form>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save',
        cls: 'primary',
        onClick: async (modal) => {
          const form = $('#admin-edit-user-form', modal.el);
          const fd = new FormData(form);
          const body = {
            email: String(fd.get('email') || '').trim(),
            name: String(fd.get('name') || '').trim(),
          };
          const password = String(fd.get('password') || '');
          if (password) body.password = password;
          const msg = $('#admin-edit-user-msg', modal.el);
          try {
            await api.adminUpdateUser(u.id, body);
            setMsg(msg, 'Saved', 'ok');
            modal.close();
            toast('User updated', 'ok');
            pageAdmin('users');
          } catch (err) {
            setMsg(msg, err.message || String(err), 'error');
            throw err;
          }
        },
      },
    ],
  });
  return m;
}

async function renderAdminUsers(el) {
  const users = asList((await api.adminUsers()).data, ['users']);
  const selfId = currentUserId;
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Create user</h3></div>
      <div class="panel-b">
        <form id="admin-user-form" class="stack">
          <div class="row">
            <div><label>Email</label><input name="email" type="email" required /></div>
            <div><label>Name</label><input name="name" /></div>
            <div><label>Password</label><input name="password" type="password" minlength="8" required /></div>
          </div>
          <div class="row">
            <div><label>Workspace name</label><input name="workspaceName" placeholder="Optional" /></div>
            <div><label><input name="superAdmin" type="checkbox" /> Super admin</label></div>
          </div>
          <div class="row actions"><button class="btn" type="submit">Create</button></div>
          <div class="msg" id="admin-user-msg"></div>
        </form>
      </div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-h"><h3>Users</h3></div>
      <div class="panel-b">
        <p class="hint" style="margin-bottom:0.75rem">Blocked users cannot sign in (stored as status <code>disabled</code>). Delete soft-removes the account and memberships; workspaces remain.</p>
        <table><thead><tr><th>Email</th><th>Name</th><th>Status</th><th>WS</th><th>Role</th><th></th></tr></thead>
        <tbody>
          ${users.map((u) => {
            const blocked = String(u.status || 'active') === 'disabled';
            const isSelf = selfId != null && Number(u.id) === Number(selfId);
            return `<tr>
            <td>${esc(u.email)}${isSelf ? ' <span class="hint">(you)</span>' : ''}</td><td>${esc(u.name)}</td>
            <td>${esc(adminUserStatusLabel(u.status))}</td><td>${esc(u.workspace_count)}</td>
            <td>${Number(u.is_super_admin) ? 'super' : 'user'}</td>
            <td class="row actions">
              <button class="btn ghost small" data-edit="${u.id}">Edit</button>
              ${isSelf ? '' : `<button class="btn ghost small" data-toggle-sa="${u.id}" data-on="${Number(u.is_super_admin) ? 0 : 1}">${Number(u.is_super_admin) ? 'Demote' : 'Make super'}</button>`}
              ${isSelf ? '' : `<button class="btn ghost small" data-toggle-st="${u.id}" data-st="${blocked ? 'active' : 'disabled'}">${blocked ? 'Unblock' : 'Block'}</button>`}
              <button class="btn ghost small" data-reset="${u.id}">Reset pw</button>
              ${isSelf ? '' : `<button class="btn danger small" data-del="${u.id}">Delete</button>`}
            </td>
          </tr>`;
          }).join('') || '<tr><td colspan="6">No users</td></tr>'}
        </tbody></table>
      </div>
    </div>`;

  $('#admin-user-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.superAdmin = !!fd.get('superAdmin');
    const msg = $('#admin-user-msg');
    try {
      await api.adminCreateUser(body);
      msg.textContent = 'Created';
      msg.className = 'msg ok';
      pageAdmin('users');
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  };
  $$('[data-edit]').forEach((b) => {
    b.onclick = () => {
      const u = users.find((x) => Number(x.id) === Number(b.dataset.edit));
      if (u) openAdminEditUser(u);
    };
  });
  $$('[data-toggle-sa]').forEach((b) => b.onclick = async () => {
    await safeRun(b, async () => {
      await api.adminUpdateUser(b.dataset.toggleSa, { is_super_admin: Number(b.dataset.on) === 1 });
      pageAdmin('users');
    });
  });
  $$('[data-toggle-st]').forEach((b) => b.onclick = async () => {
    const next = b.dataset.st;
    const label = next === 'disabled' ? 'block' : 'unblock';
    if (!confirm(`${label === 'block' ? 'Block' : 'Unblock'} this user? ${next === 'disabled' ? 'They will not be able to sign in.' : 'They will be able to sign in again.'}`)) return;
    await safeRun(b, async () => {
      await api.adminUpdateUser(b.dataset.toggleSt, { status: next });
      toast(next === 'disabled' ? 'User blocked' : 'User unblocked', 'ok');
      pageAdmin('users');
    });
  });
  $$('[data-reset]').forEach((b) => b.onclick = async () => {
    const password = prompt('New password (min 8 chars)');
    if (!password) return;
    try {
      await api.adminUpdateUser(b.dataset.reset, { password });
      toast('Password updated', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });
  $$('[data-del]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => Number(x.id) === Number(b.dataset.del));
    const email = u ? u.email : b.dataset.del;
    const wsNote = u && Number(u.workspace_count) > 0
      ? ` They belong to ${u.workspace_count} workspace(s); memberships will be removed and sole-owned workspaces will have no owner (workspaces are kept).`
      : '';
    if (!confirm(`Delete user ${email}? This soft-deletes the account and cannot be undone from the UI.${wsNote}`)) return;
    if (prompt('Type DELETE to confirm') !== 'DELETE') return;
    await safeRun(b, async () => {
      const r = await api.adminDeleteUser(b.dataset.del);
      const sole = (r.data && r.data.soleOwnedWorkspaces) || [];
      toast(
        sole.length
          ? `User deleted. ${sole.length} workspace(s) left without an owner.`
          : 'User deleted',
        'ok'
      );
      pageAdmin('users');
    });
  });
}

async function renderAdminWorkspaces(el) {
  const workspaces = asList((await api.adminWorkspaces()).data, ['workspaces']);
  const users = asList((await api.adminUsers({ limit: 200 })).data, ['users']);
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Create workspace</h3></div>
      <div class="panel-b">
        <form id="admin-ws-form" class="row actions">
          <input name="name" placeholder="Workspace name" required style="min-width:200px" />
          <select name="ownerUserId"><option value="">No owner</option>
            ${users.map((u) => `<option value="${u.id}">${esc(u.email)}</option>`).join('')}
          </select>
          <button class="btn" type="submit">Create</button>
        </form>
        <div class="msg" id="admin-ws-msg"></div>
      </div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-h"><h3>Workspaces</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>Name</th><th>Slug</th><th>Members</th><th>Tokens</th><th></th></tr></thead>
        <tbody>
          ${workspaces.map((w) => `<tr>
            <td>${esc(w.name)}</td><td class="mono">${esc(w.slug)}</td>
            <td>${esc(w.member_count)}</td><td>${esc(w.token_count)}</td>
            <td class="row actions">
              <button class="btn ghost small" data-ws-view="${w.id}">Members</button>
              <button class="btn danger small" data-ws-del="${w.id}">Delete</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="5">None</td></tr>'}
        </tbody></table>
        <div id="admin-ws-detail" style="margin-top:1rem"></div>
      </div>
    </div>`;

  $('#admin-ws-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { name: fd.get('name'), ownerUserId: fd.get('ownerUserId') ? Number(fd.get('ownerUserId')) : undefined };
    try {
      await api.adminCreateWorkspace(body);
      pageAdmin('workspaces');
    } catch (err) {
      $('#admin-ws-msg').textContent = err.message;
      $('#admin-ws-msg').className = 'msg error';
    }
  };
  $$('[data-ws-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this workspace and all its MySQL data?')) return;
    await api.adminDeleteWorkspace(b.dataset.wsDel);
    pageAdmin('workspaces');
  });
  $$('[data-ws-view]').forEach((b) => b.onclick = async () => {
    const d = (await api.adminWorkspace(b.dataset.wsView)).data;
    const detail = $('#admin-ws-detail');
    detail.innerHTML = `
      <h4>${esc(d.workspace.name)} members</h4>
      <table><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
      <tbody>${(d.members || []).map((m) => `<tr>
        <td>${esc(m.email)}</td><td>${esc(m.role)}</td>
        <td><button class="btn ghost small" data-rm="${m.user_id}">Remove</button></td>
      </tr>`).join('') || '<tr><td colspan="3">No members</td></tr>'}</tbody></table>
      <form id="admin-add-member" class="row actions" style="margin-top:0.75rem">
        <select name="userId" required>${users.map((u) => `<option value="${u.id}">${esc(u.email)}</option>`).join('')}</select>
        <select name="role"><option value="member">member</option><option value="admin">admin</option><option value="owner">owner</option></select>
        <button class="btn" type="submit">Add member</button>
      </form>`;
    $$('[data-rm]', detail).forEach((btn) => btn.onclick = async () => {
      await api.adminRemoveMember(d.workspace.id, btn.dataset.rm);
      b.click();
    });
    $('#admin-add-member').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      await api.adminAddMember(d.workspace.id, Number(f.get('userId')), f.get('role'));
      b.click();
    };
  });
}

async function renderAdminPayments(el) {
  const [payRes, refRes] = await Promise.all([api.adminPayments(), api.adminRefunds()]);
  const payments = asList(payRes.data, ['payments']);
  const refunds = asList(refRes.data, ['refunds']);
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Payments</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>When</th><th>User</th><th>Amount</th><th>Status</th><th>Invoice</th><th></th></tr></thead>
        <tbody>
          ${payments.map((p) => `<tr>
            <td>${esc(fmtDate(p.created_at))}</td>
            <td>${esc(p.user_email || p.user_id || '—')}</td>
            <td>${esc((Number(p.amount_cents || 0) / 100).toFixed(2))} ${esc(String(p.currency || '').toUpperCase())}</td>
            <td>${esc(p.status)}</td>
            <td class="mono">${esc(p.stripe_invoice_id || '')}</td>
            <td>${p.status === 'succeeded' ? `<button class="btn ghost small" data-refund="${p.id}">Refund</button>` : ''}</td>
          </tr>`).join('') || '<tr><td colspan="6">No payments yet</td></tr>'}
        </tbody></table>
      </div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-h"><h3>Refunds</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>When</th><th>User</th><th>Amount</th><th>Status</th><th>Refund ID</th></tr></thead>
        <tbody>
          ${refunds.map((r) => `<tr>
            <td>${esc(fmtDate(r.created_at))}</td>
            <td>${esc(r.user_email || r.user_id || '—')}</td>
            <td>${esc((Number(r.amount_cents || 0) / 100).toFixed(2))} ${esc(String(r.currency || '').toUpperCase())}</td>
            <td>${esc(r.status)}</td>
            <td class="mono">${esc(r.stripe_refund_id || '')}</td>
          </tr>`).join('') || '<tr><td colspan="5">No refunds yet</td></tr>'}
        </tbody></table>
      </div>
    </div>`;
  $$('[data-refund]').forEach((b) => b.onclick = async () => {
    if (!confirm('Refund this payment in Stripe?')) return;
    try {
      await api.adminRefundPayment(b.dataset.refund, {});
      toast('Refund created', 'ok');
      pageAdmin('payments');
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function renderAdminSettings(el, group) {
  const res = await api.adminSettings();
  const settings = res.data.settings || {};
  const defs = (res.data.defs || []).filter((d) => d.group === group);
  const title = {
    email: 'Email / SMTP', sms: 'SMS', keys: 'Default API keys', general: 'General',
    billing: 'Stripe & subscription',
  }[group] || group;
  const webhookHint = group === 'billing'
    ? `<p class="hint">Webhook endpoint: <span class="mono">${esc(window.location.origin)}/api/v1/billing/webhook</span><br/>
       Events: <span class="mono">checkout.session.completed, checkout.session.async_payment_succeeded, customer.subscription.*, invoice.paid, invoice.payment_failed, charge.refunded, charge.dispute.created, radar.early_fraud_warning.created</span><br/>
       Credits: create a one-time Stripe Price, paste into <span class="mono">stripe.price_id_credits</span>, set pack size + per-image/content rates below.<br/>
       Create <strong>two Products</strong> in Stripe (Standard + Premium), each with one monthly Price. Paste <span class="mono">price_…</span> ids into the Standard/Premium fields. Leave keys empty until you paste real Dashboard values. Prefer a restricted API key (rk_…).</p>`
    : '<span class="hint">Defaults apply to new workspaces. Secrets are write-only.</span>';
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>${esc(title)}</h3></div>
      <div class="panel-b" style="padding-bottom:0">${webhookHint}</div>
      <div class="panel-b">
        <form id="admin-set-form" class="stack">
          ${defs.map((d) => {
            const isSecret = d.secret;
            const val = settings[d.key] || '';
            return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              ${isSecret
                ? `<input name="${esc(d.key)}" type="password" placeholder="${val === '***' ? 'Set (currently configured)' : 'Not set'}" autocomplete="new-password" />`
                : `<input name="${esc(d.key)}" value="${esc(val)}" />`}
            </div>`;
          }).join('') || '<p class="hint">No settings in this group</p>'}
          <div class="row actions"><button class="btn" type="submit">Save</button></div>
          <div class="msg" id="admin-set-msg"></div>
        </form>
      </div>
    </div>`;

  $('#admin-set-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const plain = {};
    const secrets = [];
    for (const d of defs) {
      const v = fd.get(d.key);
      if (d.secret) {
        if (v && String(v).trim()) secrets.push([d.key, String(v)]);
      } else {
        plain[d.key] = v == null ? '' : String(v);
      }
    }
    const msg = $('#admin-set-msg');
    try {
      if (Object.keys(plain).length) await api.adminSettingsSave(plain);
      for (const [k, v] of secrets) await api.adminSettingsSecret(k, v);
      msg.textContent = 'Saved';
      msg.className = 'msg ok';
      toast('Platform settings saved', 'ok');
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  };
}

let billingTab = 'subscription';

async function pageBilling(param, query) {
  const summary = (await api.billingSummary()).data;
  const checkoutFlag = (query && query.checkout) || '';
  const billTabs = [
    ['subscription', 'Plans'],
    ['credits', 'Credits'],
    ['payments', 'Payment history'],
    ['account', 'Delete account'],
  ];
  const requested = (param && String(param).split('/')[0]) || billingTab || 'subscription';
  billingTab = billTabs.some(([k]) => k === requested) ? requested : 'subscription';
  // Checkout return URLs land on #/billing?checkout=… — keep Plans/Credits tab.
  if (checkoutFlag === 'credits_success') billingTab = 'credits';
  else if (checkoutFlag) billingTab = 'subscription';

  const currentPlan = String(summary.plan || 'free');
  const plans = Array.isArray(summary.plans) ? summary.plans : [];
  const planCards = plans.map((p) => {
    const isCurrent = p.id === currentPlan;
    const canCheckout = p.checkout && p.priceConfigured && !summary.isSuperAdmin
      && (!summary.subscribed || currentPlan !== p.id);
    let cta = '';
    if (p.id === 'free') {
      cta = isCurrent
        ? '<span class="hint">Current plan</span>'
        : '<span class="hint">Downgrade via Manage billing after cancel</span>';
    } else if (isCurrent && summary.subscribed) {
      cta = '<span class="hint">Current plan</span>';
    } else if (!p.priceConfigured) {
      cta = '<span class="hint">Price not configured yet</span>';
    } else if (canCheckout) {
      cta = `<button class="btn" type="button" data-checkout-plan="${esc(p.id)}">Subscribe</button>`;
    } else {
      cta = '<span class="hint">Use Manage billing to change plans</span>';
    }
    return `<div class="plan-card${isCurrent ? ' is-current' : ''}${p.id === 'premium' ? ' is-featured' : ''}">
      <div class="plan-card-h">
        <h3>${esc(p.name)}</h3>
        <div class="plan-price">${esc(p.priceLabel || '')}</div>
      </div>
      <p class="hint plan-tagline">${esc(p.tagline || '')}</p>
      <ul class="plan-features">${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      <div class="plan-cta">${cta}</div>
    </div>`;
  }).join('');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Billing &amp; plans</h1>
        <p class="lede">${esc(summary.amountLabel || 'Bitpype plans')} · ${esc(summary.email)}</p>
      </div>
    </div>
    ${checkoutFlag === 'success' ? '<div class="alert ok"><strong>Payment received.</strong> Plan updates when Stripe confirms via webhook.</div>' : ''}
    ${checkoutFlag === 'credits_success' ? '<div class="alert ok"><strong>Credits payment received.</strong> Balance updates when Stripe confirms via webhook.</div>' : ''}
    ${checkoutFlag === 'cancel' ? '<div class="alert warn">Checkout canceled — no charge was made.</div>' : ''}
    ${summary.subscriptionStatus === 'past_due' ? '<div class="alert danger"><strong>Payment failed.</strong> Update your payment method in the customer portal to avoid losing paid features.</div>' : ''}
    <div class="stats-cards">
      <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(summary.planName || pretty(currentPlan))}</div><div class="l">Plan</div></div>
      <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(pretty(summary.subscriptionStatus || (currentPlan === 'free' ? 'free' : 'none')))}</div><div class="l">Status</div></div>
      <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(String((summary.credits && summary.credits.balance) != null ? summary.credits.balance : 0))}</div><div class="l">Credits</div></div>
      <div class="stat-card"><div class="n" style="font-size:1.05rem">${esc(fmtDate(summary.currentPeriodEnd) || '—')}</div><div class="l">Current period end</div></div>
    </div>
    <div class="tabs" id="billing-tabs" role="tablist" aria-label="Billing sections">${billTabs.map(([k, l]) =>
      `<button type="button" role="tab" data-tab="${k}" class="${k === billingTab ? 'active' : ''}" aria-selected="${k === billingTab ? 'true' : 'false'}">${esc(l)}</button>`).join('')}</div>
    <div class="panel" id="bill-panel-subscription"${billingTab === 'subscription' ? '' : ' hidden'}>
      <div class="panel-h"><h3>Choose a plan</h3>
        ${summary.hasCustomer ? '<button class="btn ghost" type="button" id="bill-portal">Manage billing</button>' : ''}
      </div>
      <div class="panel-b">
        <p class="hint">${summary.isSuperAdmin
          ? 'Super admins have Premium entitlements without a paid Stripe plan.'
          : 'Free includes website + inline edits. Upgrade for support cadence and included social images. Card and cancel live in the Stripe customer portal.'}</p>
        <div class="plan-grid">${planCards || '<p class="hint">Plans unavailable</p>'}</div>
        <div class="msg" id="bill-msg"></div>
      </div>
    </div>
    <div class="panel" id="bill-panel-credits"${billingTab === 'credits' ? '' : ' hidden'}>
      <div class="panel-h"><h3>Social credits</h3>
        ${(summary.credits && summary.credits.priceConfigured && !summary.isSuperAdmin)
          ? '<button class="btn" type="button" id="bill-buy-credits">Buy credits</button>'
          : ''}
      </div>
      <div class="panel-b">
        <p class="hint">Credits power branded social image ads and caption generation for the current workspace.
          Premium includes images (no credit charge for images). Set pack Price ID and rates in Admin → Stripe.</p>
        <div class="stats-cards" style="margin:12px 0">
          <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(String((summary.credits && summary.credits.balance) != null ? summary.credits.balance : 0))}</div><div class="l">Balance</div></div>
          <div class="stat-card"><div class="n" style="font-size:1.05rem">${esc((summary.credits && summary.credits.packLabel) || '—')}</div><div class="l">Pack</div></div>
          <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(String((summary.credits && summary.credits.perSocialImage) != null ? summary.credits.perSocialImage : 1))}</div><div class="l">Per image</div></div>
          <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(String((summary.credits && summary.credits.perSocialContent) != null ? summary.credits.perSocialContent : 1))}</div><div class="l">Per content gen</div></div>
        </div>
        ${!(summary.credits && summary.credits.priceConfigured)
          ? '<p class="msg warn">Credits checkout is not configured yet (missing <span class="mono">stripe.price_id_credits</span>).</p>'
          : ''}
        <div class="msg" id="bill-credits-msg"></div>
        <table><thead><tr><th>When</th><th>Change</th><th>Balance</th><th>Reason</th></tr></thead>
        <tbody>
          ${((summary.credits && summary.credits.recent) || []).map((r) => `<tr>
            <td>${esc(fmtDate(r.created_at))}</td>
            <td>${Number(r.delta) > 0 ? '+' : ''}${esc(String(r.delta))}</td>
            <td>${esc(String(r.balance_after))}</td>
            <td>${esc(r.reason || '')}</td>
          </tr>`).join('') || '<tr><td colspan="4">No credit activity yet</td></tr>'}
        </tbody></table>
      </div>
    </div>
    <div class="panel" id="bill-panel-payments"${billingTab === 'payments' ? '' : ' hidden'}>
      <div class="panel-h"><h3>Payment history</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>When</th><th>Amount</th><th>Status</th><th>Description</th></tr></thead>
        <tbody>
          ${(summary.payments || []).map((p) => `<tr>
            <td>${esc(fmtDate(p.created_at))}</td>
            <td>${esc((Number(p.amount_cents || 0) / 100).toFixed(2))} ${esc(String(p.currency || '').toUpperCase())}</td>
            <td>${esc(p.status)}</td>
            <td>${esc(p.description || '')}</td>
          </tr>`).join('') || '<tr><td colspan="4">No payments yet</td></tr>'}
        </tbody></table>
      </div>
    </div>
    <div class="panel" id="bill-panel-account"${billingTab === 'account' ? '' : ' hidden'}>
      <div class="panel-h"><h3>Delete account</h3></div>
      <div class="panel-b">
        <p class="hint">Cancels your Stripe subscription (if any), disables login, and removes workspace memberships. Payment records are kept for the platform.</p>
        <button class="btn danger" type="button" id="bill-delete">Delete my account</button>
      </div>
    </div>`;

  $('#billing-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    window.location.hash = '#/billing/' + b.dataset.tab;
  };

  const msg = $('#bill-msg');
  $$('[data-checkout-plan]').forEach((btn) => {
    btn.onclick = () => safeRun(btn, async () => {
      const plan = btn.getAttribute('data-checkout-plan');
      const r = await api.billingCheckout(plan);
      if (r.data && r.data.url) window.location.href = r.data.url;
      else throw new Error('No checkout URL returned');
    });
  });
  const buyCredits = $('#bill-buy-credits');
  if (buyCredits) {
    buyCredits.onclick = () => safeRun(buyCredits, async () => {
      const r = await api.billingCreditsCheckout(1);
      if (r.data && r.data.url) window.location.href = r.data.url;
      else throw new Error('No checkout URL returned');
    });
  }
  const portalBtn = $('#bill-portal');
  if (portalBtn) {
    portalBtn.onclick = () => safeRun(portalBtn, async () => {
      const r = await api.billingPortal();
      if (r.data && r.data.url) window.location.href = r.data.url;
      else throw new Error('No portal URL returned');
    });
  }
  const delBtn = $('#bill-delete');
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!confirm('Permanently delete your account? This cannot be undone.')) return;
      if (prompt('Type DELETE to confirm') !== 'DELETE') return;
      try {
        await api.deleteAccount();
        localStorage.removeItem('scout.workspaceId');
        toast('Account deleted', 'ok');
        renderAuth();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }
  const prices = summary.priceIds || {};
  if (msg && !summary.isSuperAdmin && !prices.standard && !prices.premium && !summary.priceId) {
    msg.textContent = 'Paid plans are not configured yet (missing Stripe price IDs). Ask your admin — Free still works.';
    msg.className = 'msg warn';
  }
  requireSubscription = !!summary.requireSubscription || requireSubscription;
  userSubscribed = !!summary.subscribed;
  if (summary.productAccess != null) productAccess = !!summary.productAccess;
  else productAccess = true;
  subscriptionStatus = summary.subscriptionStatus || subscriptionStatus;
  updateBillingBanner();
}

async function renderAdminUpsellTips(el) {
  const data = (await api.adminUpsellTips()).data || {};
  const tips = Array.isArray(data.tips) ? data.tips : [];
  const features = Array.isArray(data.features) ? data.features : [];
  const featureOpts = features.map((f) =>
    `<option value="${esc(f.key)}">${esc(f.label)} → ${esc(f.minPlan)}</option>`
  ).join('');

  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Did you know? tips</h3></div>
      <div class="panel-b">
        <p class="hint">Popups shown to Free (basic) portal users for features they don’t have. Each tip has its own frequency (hours between shows per user). A 6-hour global cooldown applies between any tip. Every popup includes an Upgrade button.</p>
        <div class="msg" id="admin-upsell-msg"></div>
        <table>
          <thead><tr>
            <th>On</th><th>Title / body</th><th>Feature</th><th>Every (hrs)</th><th>Weight</th><th>Shows</th><th></th>
          </tr></thead>
          <tbody id="admin-upsell-rows">
            ${tips.map((t) => `
              <tr data-tip-id="${t.id}">
                <td><input type="checkbox" data-tip-enabled ${t.enabled ? 'checked' : ''} title="Enabled" /></td>
                <td>
                  <input type="text" data-tip-title value="${esc(t.title)}" style="width:100%;margin-bottom:4px" />
                  <textarea data-tip-body rows="2" style="width:100%">${esc(t.body)}</textarea>
                </td>
                <td>
                  <select data-tip-feature style="max-width:11rem">
                    <option value="">(general)</option>
                    ${features.map((f) =>
                      `<option value="${esc(f.key)}" ${t.feature_key === f.key ? 'selected' : ''}>${esc(f.label)}</option>`
                    ).join('')}
                  </select>
                  <div class="hint" style="margin-top:4px">Plans: ${esc((t.target_plans || ['free']).join(', '))}</div>
                </td>
                <td><input type="number" data-tip-freq min="1" max="8760" value="${esc(t.frequency_hours)}" style="width:4.5rem" /></td>
                <td><input type="number" data-tip-weight min="1" max="100" value="${esc(t.weight)}" style="width:3.5rem" title="Relative how often among eligible tips" /></td>
                <td class="hint">${esc((t.stats && t.stats.shows) || 0)} <span title="unique viewers">/ ${esc((t.stats && t.stats.viewers) || 0)}</span></td>
                <td class="row actions" style="gap:4px">
                  <button type="button" class="btn soft small" data-tip-save>Save</button>
                  <button type="button" class="btn ghost small" data-tip-del>Delete</button>
                </td>
              </tr>`).join('') || '<tr><td colspan="7" class="hint">No tips yet — add one below.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-h"><h3>Add tip</h3></div>
      <div class="panel-b">
        <form id="admin-upsell-add" class="stack">
          <div><label>Title</label><input name="title" required value="Did you know?" maxlength="200" /></div>
          <div><label>Body</label><textarea name="body" required rows="3" maxlength="2000" placeholder="Short upsell copy…"></textarea></div>
          <div class="row" style="gap:12px;flex-wrap:wrap">
            <div><label>Feature (skip if they already have it)</label>
              <select name="feature_key"><option value="">(general)</option>${featureOpts}</select></div>
            <div><label>Frequency (hours)</label><input name="frequency_hours" type="number" min="1" value="72" /></div>
            <div><label>Weight</label><input name="weight" type="number" min="1" value="1" /></div>
            <div><label>CTA label</label><input name="cta_label" value="Upgrade" maxlength="80" /></div>
          </div>
          <input type="hidden" name="target_plans" value="free" />
          <button type="submit" class="btn primary">Add tip</button>
        </form>
      </div>
    </div>`;

  const msg = $('#admin-upsell-msg');
  const flash = (text, ok) => {
    if (!msg) return;
    msg.textContent = text || '';
    msg.className = ok ? 'msg ok' : (text ? 'msg err' : 'msg');
  };

  const rows = $('#admin-upsell-rows');
  if (rows) {
    rows.onclick = (e) => {
      const tr = e.target.closest('tr[data-tip-id]');
      if (!tr) return;
      const id = Number(tr.getAttribute('data-tip-id'));
      if (e.target.closest('[data-tip-save]')) {
        safeRun(msg, async () => {
          await api.adminUpsellTipUpdate(id, {
            title: tr.querySelector('[data-tip-title]').value,
            body: tr.querySelector('[data-tip-body]').value,
            feature_key: tr.querySelector('[data-tip-feature]').value,
            enabled: tr.querySelector('[data-tip-enabled]').checked,
            frequency_hours: Number(tr.querySelector('[data-tip-freq]').value) || 72,
            weight: Number(tr.querySelector('[data-tip-weight]').value) || 1,
            target_plans: 'free',
          });
          flash('Saved.', true);
          await renderAdminUpsellTips(el);
        });
      }
      if (e.target.closest('[data-tip-del]')) {
        if (!confirm('Delete this tip?')) return;
        safeRun(msg, async () => {
          await api.adminUpsellTipDelete(id);
          flash('Deleted.', true);
          await renderAdminUpsellTips(el);
        });
      }
    };
  }

  const form = $('#admin-upsell-add');
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      safeRun(msg, async () => {
        await api.adminUpsellTipCreate({
          title: fd.get('title'),
          body: fd.get('body'),
          feature_key: fd.get('feature_key'),
          frequency_hours: Number(fd.get('frequency_hours')) || 72,
          weight: Number(fd.get('weight')) || 1,
          cta_label: fd.get('cta_label') || 'Upgrade',
          target_plans: 'free',
          enabled: true,
        });
        flash('Tip added.', true);
        await renderAdminUpsellTips(el);
      });
    };
  }
}

async function renderAdminAudit(el) {
  const rows = asList((await api.adminAudit({ limit: 80 })).data, ['rows']);
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Audit log</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td>${esc(fmtDate(r.at))}</td>
            <td>${esc(r.actor_email || r.actor_user_id || '—')}</td>
            <td>${esc(r.action)}</td>
            <td class="mono">${esc(r.detail || '')}</td>
          </tr>`).join('') || '<tr><td colspan="4">No audit events yet</td></tr>'}
        </tbody></table>
      </div>
    </div>`;
}

const PAGES = {
  dashboard: pageDashboard, leads: pageLeads, websites: pageWebsites, domains: pageDomains, design: pageDesign,
  social: pageSocial, outreach: pageOutreach, pipeline: pagePipeline, jobs: pageJobs, mcp: pageMcp,
  settings: pageSettings, billing: pageBilling, admin: pageAdmin,
};

async function navigate() {
  closeNav();
  Array.from(overlays).forEach((o) => o.close());
  let { route, param, query } = parseHash();

  if (!signedIn) {
    if (!PUBLIC_ROUTES.has(route)) return goToLogin();
    return renderAuth();
  }
  if (route === 'login' || route === 'register') {
    const next = consumeReturnHash();
    if (window.location.hash !== next) {
      history.replaceState(null, '', window.location.pathname + window.location.search + next);
    }
    ({ route, param, query } = parseHash());
    if (PUBLIC_ROUTES.has(route) || !PAGES[route]) {
      route = 'dashboard';
      param = '';
      query = {};
      if (window.location.hash !== '#/dashboard') {
        history.replaceState(null, '', window.location.pathname + window.location.search + '#/dashboard');
      }
    }
  }
  if (route === 'forgot' || route === 'reset') {
    return renderAuth();
  }
  if (route === 'invite' && param) {
    if (shell.classList.contains('hidden')) return renderAuth();
    try {
      const inv = await api.acceptInvite(param);
      if (inv.data && inv.data.workspaceId) {
        api.setWorkspaceId(inv.data.workspaceId);
        if (inv.data.workspaces) fillWorkspaces(inv.data.workspaces, inv.data.workspaceId);
      }
      if (inv.data && inv.data.productAccess != null) productAccess = !!inv.data.productAccess;
      toast('Invite accepted', 'ok');
    } catch (err) { toast(err.message || 'Invite failed', 'err'); }
    window.location.hash = '#/dashboard';
    return;
  }

  const paywalled = requireSubscription && !productAccess && !currentUserIsSuperAdmin;
  if (paywalled && route !== 'billing' && route !== 'admin') {
    window.location.hash = '#/billing';
    return;
  }
  updateBillingBanner();

  $$('.nav-links a').forEach((a) => {
    const on = a.dataset.route === route;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  topTitle.textContent = ROUTE_LABELS[route] || '';
  view.onclick = null;
  view.onchange = null;
  // Pipeline + Design/Website detail need the full main column (preview panes).
  view.classList.toggle('wide', route === 'pipeline' || ((route === 'design' || route === 'websites') && !!param));
  leadsReload = null;

  if (!PAGES[route]) {
    view.innerHTML = '<div class="card error-card"><h2>Page not found</h2><p>Choose a page from the navigation.</p></div>';
    return;
  }
  if (route === 'admin' && !currentUserIsSuperAdmin) {
    view.innerHTML = '<div class="card error-card"><h2>Super admin only</h2><p>Your account is not a platform administrator.</p></div>';
    return;
  }
  view.innerHTML = '<p class="hint">Loading…</p>';
  try {
    await PAGES[route](param, query);
    window.scrollTo(0, 0);
    const main = $('.app-main');
    if (main) main.scrollTop = 0;
  } catch (err) {
    if (isAuthRequired(err)) return goToLogin();
    if (err.status === 402) {
      window.location.hash = '#/billing';
      return;
    }
    view.innerHTML = `<div class="card error-card"><h2>Page failed to load</h2><p>${esc(err.message)}</p></div>`;
  }
}

if (wsSelect) {
  wsSelect.addEventListener('change', async () => {
    const id = Number(wsSelect.value);
    api.setWorkspaceId(id);
    try {
      const r = await api.selectWorkspace(id);
      if (r.data && r.data.productAccess != null) productAccess = !!r.data.productAccess;
      if (r.data && r.data.subscribed != null) userSubscribed = !!r.data.subscribed;
    } catch (err) { toast(err.message, 'err'); }
    leadsState.selected.clear();
    try { await refreshAutomation(); } catch { /* paywalled */ }
    navigate();
  });
}

const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try { await api.logout(); } catch { /* ignore */ }
    localStorage.removeItem('scout.workspaceId');
    goToLogin({ forgetReturn: true });
  });
}

if (autoEl) {
  autoEl.addEventListener('click', (e) => {
    e.preventDefault();
    if (e.shiftKey || e.ctrlKey || e.metaKey) { window.location.hash = '#/settings/automation'; return; }
    const next = !automationPaused;
    if (!window.confirm(next ? 'Pause all automation (discovery, jobs, outreach, AI)?' : 'Resume automation?')) return;
    safeRun(null, async () => {
      await setAutomation(next);
      const { route } = parseHash();
      if (route === 'dashboard' || route === 'settings') navigate();
    });
  });
}

const menuBtn = document.getElementById('menu-btn');
const sidebarClose = document.getElementById('sidebar-close');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
if (menuBtn) menuBtn.addEventListener('click', openNav);
if (sidebarClose) sidebarClose.addEventListener('click', closeNav);
if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeNav);
window.addEventListener('hashchange', navigate);

(async function init() {
  if (typeof api.setOnAuthRequired === 'function') api.setOnAuthRequired(() => goToLogin());
  const { route } = parseHash();
  try {
    const me = await api.me();
    signedIn = true;
    if (me.data.workspaceId) api.setWorkspaceId(me.data.workspaceId);
    else if (api.getWorkspaceId()) await api.selectWorkspace(api.getWorkspaceId());
    if (route === 'forgot' || route === 'reset') return renderAuth();
    await bootApp(me.data);
  } catch (err) {
    signedIn = false;
    // AUTH_REQUIRED → login page. Other failures keep the session cookie;
    // tell the user to retry instead of implying they were signed out.
    if (isAuthRequired(err)) {
      goToLogin();
      return;
    }
    renderAuth();
    if (err && err.status === 403) {
      toast(err.message || 'Account unavailable', 'err');
      return;
    }
    if (err && err.status >= 500) {
      toast('Server temporarily unavailable — refresh in a moment.', 'err');
      return;
    }
    toast((err && err.message) || 'Could not restore session — try refreshing.', 'err');
  }
})();
