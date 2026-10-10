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

const ROUTES = ['dashboard', 'leads', 'websites', 'design', 'outreach', 'pipeline', 'jobs', 'mcp', 'settings'];
const ROUTE_LABELS = {
  dashboard: 'Dashboard', leads: 'Leads', websites: 'Websites', design: 'Design', outreach: 'Outreach',
  pipeline: 'Pipeline', jobs: 'Jobs', mcp: 'MCP', settings: 'Settings',
};
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

async function safeRun(btn, fn) {
  const isBtn = btn && btn.tagName === 'BUTTON';
  if (isBtn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (err && err.status === 401) { renderAuth(); return undefined; }
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
  host.classList.add('lead-picker');
  host.innerHTML = `<input type="search" class="lp-input" placeholder="${esc(o.placeholder || 'Search leads by name, or type a lead id…')}" autocomplete="off" />
    <ul class="lead-picker-results hidden"></ul><div class="lead-picker-selected hidden"></div>`;
  const input = $('.lp-input', host);
  const ul = $('.lead-picker-results', host);
  const selBox = $('.lead-picker-selected', host);

  function renderSelected() {
    if (!current) { selBox.classList.add('hidden'); input.classList.remove('hidden'); return; }
    selBox.classList.remove('hidden');
    input.classList.add('hidden');
    selBox.innerHTML = `<span><b>${esc(current.name || 'Lead')}</b> <span class="hint">#${esc(current.id)}</span></span>
      <button type="button" class="btn small clear">Change</button>`;
    $('.clear', selBox).onclick = () => { current = null; renderSelected(); if (o.onChange) o.onChange(null); };
  }

  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) { ul.classList.add('hidden'); return; }
    try {
      const r = await api.leads({ q, pageSize: 8 });
      const rows = (r.data && r.data.leads) || [];
      let html = '';
      if (/^\d+$/.test(q)) html += `<li><button type="button" data-id="${esc(q)}" data-name="Lead #${esc(q)}">Use lead id <b>#${esc(q)}</b></button></li>`;
      html += rows.map((l) => `<li><button type="button" data-id="${l.id}" data-name="${esc(l.business_name)}"><b>${esc(l.business_name)}</b> <span class="hint">#${l.id} · ${esc(l.city || l.category || '')}</span></button></li>`).join('');
      ul.innerHTML = html || '<li class="empty">No matches</li>';
      ul.classList.remove('hidden');
    } catch (e) { toast(e.message, 'err'); }
  }, 250);

  input.addEventListener('input', search);
  ul.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    current = { id: Number(b.dataset.id), name: b.dataset.name };
    ul.classList.add('hidden');
    input.value = '';
    renderSelected();
    if (o.onChange) o.onChange(current);
  });
  return {
    get: () => current,
    set(lead) { current = lead || null; renderSelected(); },
    clear() { current = null; renderSelected(); },
  };
}

/** Iframe preview with page select + desktop/mobile toggle. renderFn(slug) -> api envelope with data.html. */
function mountPreview(host, renderFn) {
  host.innerHTML = `<div class="inline">
    <select class="pv-page" style="width:auto"><option value="">All pages</option></select>
    <button type="button" class="btn small primary pv-desktop">Desktop</button>
    <button type="button" class="btn small pv-mobile">Mobile</button>
    <button type="button" class="btn small pv-refresh">Refresh</button>
    <span class="msg pv-msg"></span></div>
    <div class="preview-frame desktop"><iframe class="pv-frame" sandbox="" title="Site preview"></iframe></div>`;
  const sel = $('.pv-page', host);
  const frame = $('.pv-frame', host);
  const box = $('.preview-frame', host);
  const msg = $('.pv-msg', host);
  let populated = false;

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
  load();
  return { reload: load };
}

/* ------------------------------------------------------------------ */
/* Auth + shell                                                        */
/* ------------------------------------------------------------------ */

function renderAuth() {
  authGate.classList.remove('hidden');
  shell.classList.add('hidden');
  authGate.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand"><span class="brand-mark" style="background:#171512;color:#f3ead8">WS</span><h1>Website Scout</h1></div>
      <p class="sub">Local business desk — sign in to your workspace.</p>
      <div class="tabs">
        <button type="button" class="active" data-tab="login">Log in</button>
        <button type="button" data-tab="register">Register</button>
      </div>
      <form id="auth-form">
        <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" required autocomplete="username" /></div>
        <div class="field"><label for="a-pass">Password</label><input id="a-pass" name="password" type="password" required minlength="8" autocomplete="current-password" /></div>
        <div id="reg-extra" class="hidden">
          <div class="field"><label for="a-name">Your name</label><input id="a-name" name="name" type="text" /></div>
          <div class="field"><label for="a-ws">Workspace name</label><input id="a-ws" name="workspaceName" type="text" placeholder="My agency" /></div>
        </div>
        <button class="btn primary" type="submit" style="width:100%">Continue</button>
        <div class="msg" id="auth-msg"></div>
      </form>
    </div>`;

  let mode = 'login';
  $$('[data-tab]', authGate).forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.tab;
      $$('[data-tab]', authGate).forEach((b) => b.classList.toggle('active', b === btn));
      $('#reg-extra', authGate).classList.toggle('hidden', mode !== 'register');
    });
  });

  $('#auth-form', authGate).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = formObject(e.target);
    const msg = $('#auth-msg', authGate);
    setMsg(msg, 'Working…');
    try {
      const res = mode === 'login' ? await api.login(body) : await api.register(body);
      api.setWorkspaceId(res.data.workspaceId);
      await bootApp(res.data);
    } catch (err) {
      setMsg(msg, err.message, 'error');
    }
  });
}

function fillWorkspaces(workspaces, currentId) {
  wsSelect.innerHTML = (workspaces || []).map((w) =>
    `<option value="${w.id}" ${Number(w.id) === Number(currentId) ? 'selected' : ''}>${esc(w.name)} (${esc(w.role)})</option>`
  ).join('');
}

async function refreshAutomation() {
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
  authGate.classList.add('hidden');
  shell.classList.remove('hidden');
  fillWorkspaces(meData.workspaces, meData.workspaceId || api.getWorkspaceId());
  await refreshAutomation();
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
  const activity = (act && act.data && act.data.rows) || d.activity || [];
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
    const rows = r.data.leads || [];
    leadsState.total = r.data.total || 0;
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
    body: `<p class="hint">Header row required. Common columns: business_name, category, email, phone, website, address, city, state, tags, group.</p>
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
    ? `<p><a href="#/websites/${site.id}">${esc(site.name)}</a> ${statusBadge(site.status)}</p>`
    : `<p class="hint">No website yet.</p><button class="btn small" data-act="gen">Build template site</button>`}
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
      <thead><tr><th>Name</th><th>Lead</th><th>Status</th><th>Origin</th><th>Updated</th></tr></thead>
      <tbody id="w-body"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody>
    </table></div>
    <div class="pagination" id="w-pager"></div>`;

  const picker = mountLeadPicker($('#w-lead'));

  async function load() {
    const r = await api.websites({ page: sitesState.page, pageSize: 25, status: sitesState.status });
    const body = $('#w-body');
    if (!body) return;
    const d = r.data;
    body.innerHTML = (d.sites || []).map((s) => `<tr>
      <td><button class="link-btn" data-act="open" data-id="${s.id}">${esc(s.name)}</button></td>
      <td>${esc(s.business_name || ('#' + s.lead_id))}</td>
      <td>${statusBadge(s.status)}</td><td>${esc(s.origin || '—')}</td><td>${esc(fmtDate(s.updated_at))}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">No websites yet. Build one for a lead above.</td></tr>';
    pager($('#w-pager'), { page: d.page || 1, pages: d.pages || 1, total: d.total || 0 }, (p) => { sitesState.page = p; load(); });
  }
  $('#w-status').addEventListener('change', (e) => { sitesState.status = e.target.value; sitesState.page = 1; load(); });

  delegate(view, {
    open: (t) => { window.location.hash = '#/websites/' + t.dataset.id; },
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
  const pages = parseJson(site.pages, []);
  const theme = parseJson(site.theme, {});
  const versions = verR ? (verR.data.versions || []) : [];
  const cf = cfR ? cfR.data : null;

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
        <button class="btn" data-act="url">Preview URL</button>
        <button class="btn" data-act="photos">Add photos</button>
        <button class="btn" data-act="regen">Regenerate</button>
        <button class="btn" data-act="assign">Assign design job</button>
        <button class="btn primary" data-act="publish">Publish to Cloudflare</button>
      </div>
    </div>
    <div class="detail-grid">
      <div>
        <div class="card"><h3>Preview</h3><div id="wd-preview"></div></div>
      </div>
      <div>
        <div class="card"><h3>Actions &amp; results</h3>
          <div id="wd-out" class="hint">Run QA, export, or publish to see results here.</div>
          ${cf && !cf.configured ? '<p class="hint">Cloudflare is not configured. <a href="#/settings">Add credentials in Settings</a> to publish.</p>' : ''}
        </div>
        <div class="card"><h3>Versions (${versions.length})</h3>
          ${versions.map((v) => `<div class="kv"><span class="k">v${esc(v.version_no)}</span><span>${esc(v.note || '—')}</span><span class="sub-line">${esc(fmtDate(v.created_at))} · <button class="link-btn" data-act="restore" data-v="${v.id}">Restore</button></span></div>`).join('') || '<p class="hint">No versions saved yet.</p>'}
        </div>
        <div class="card"><h3>Pages (${pages.length})</h3>
          ${pages.map((p) => kv(p.slug, `${p.title || ''} — ${(p.sections || []).length} sections`)).join('') || '<p class="hint">No pages.</p>'}
          <div class="swatches">${['primary', 'secondary', 'bg', 'text'].filter((k) => theme[k]).map((k) => `<span class="swatch" title="${esc(k)} ${esc(theme[k])}" style="background:${esc(theme[k])}"></span>`).join('')}</div>
        </div>
        <div class="card"><h3>Edit JSON</h3>
          <p class="hint">Advanced: edit pages + theme directly. Saving creates a new version.</p>
          <textarea id="wd-json" class="json" spellcheck="false">${esc(JSON.stringify({ pages, theme }, null, 2))}</textarea>
          <div class="inline" style="margin-top:8px"><button class="btn primary small" data-act="save">Save as new version</button><span class="msg" id="wd-save-msg"></span></div>
        </div>
        ${manifest && manifest.manifest ? `<div class="card"><details><summary>Claim manifest</summary>${jsonPre(manifest.manifest)}</details></div>` : ''}
      </div>
    </div>`;

  const preview = mountPreview($('#wd-preview'), (slug) => api.websiteRender(id, { editable: false, pageSlug: slug }));
  const out = $('#wd-out');

  delegate(view, {
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
    url: async () => {
      out.textContent = 'Building preview…';
      const r = (await api.websitePreview(id, false)).data;
      out.innerHTML = `Server preview: <span class="mono">${esc(r.url || r.path)}</span><div class="hint">This URL is served from the server's loopback. Use the inline preview on the left for remote access.</div>`;
    },
    photos: async () => {
      out.textContent = 'Pulling photos…';
      const r = (await api.websiteImages(id, {})).data;
      out.textContent = `Added ${r.count} photo(s) for “${r.query}”.`;
      preview.reload();
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

async function pageDesign(param) {
  if (param) return pageDesignDetail(Number(param));
  const [pend, list, er] = await Promise.all([
    api.designPending().catch(() => null),
    api.designList({ page: designState.page, pageSize: 25, status: designState.status }),
    api.emailRedesignList({ pendingOnly: 1 }).catch(() => null),
  ]);
  const counts = pend ? pend.data.counts : { waiting_on_agent: 0, questions_pending: 0 };
  const jobs = list.data.jobs || [];
  const ers = er ? (er.data.requests || []) : [];

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
        <button class="btn small" data-act="scan">Scan drop folder</button></div>
      <p class="hint">Client replies asking for a redesign or improvements. ${er && er.data.dropDir ? `Drop folder: <span class="mono">${esc(er.data.dropDir)}</span>` : ''}</p>
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
        <div class="card"><h3>Instructions</h3><p style="white-space:pre-wrap;margin:0">${esc(job.instructions)}</p>
          ${job.type === 'website' ? `<div class="inline" style="margin-top:10px"><label class="lbl" style="margin:0">Site shape</label>
            <select id="dd-shape" style="width:auto">${optionList(['multipage', 'landing'], job.site_shape || 'multipage')}</select>
            <button class="btn small" data-act="shape">Update shape</button></div>` : ''}
        </div>

        <div class="card"><h3>Questions from the agent (${questions.length})</h3>
          ${questions.map((q) => `<div class="q-card ${q.answer == null ? 'pending' : ''}">
            <div><b>Q${esc(q.id)}:</b> ${esc(q.question)}</div>
            ${q.answer != null
    ? `<div class="hint" style="margin-top:4px">Answer${q.from_email ? ' from ' + esc(q.from_email) : ''} · ${esc(fmtDate(q.answered_at))}</div><div style="white-space:pre-wrap">${esc(q.answer)}</div>`
    : `<textarea id="qa-${q.id}" placeholder="Your answer…"></textarea><button class="btn small primary" data-act="answer" data-q="${q.id}" style="margin-top:6px">Send answer</button>`}
          </div>`).join('') || '<p class="hint">No questions.</p>'}
        </div>

        <div class="card"><h3>Client email</h3>
          <div class="row end">
            <div class="field"><label class="lbl" for="dd-contact">Contact email</label><input id="dd-contact" type="email" value="${esc(job.contact_email || '')}" /></div>
            <div class="field" style="flex:0 0 auto"><button class="btn" data-act="contact">Save contact</button></div>
          </div>
          <div class="inline">
            <button class="btn small" data-act="email-q">Email questions</button>
            <button class="btn small" data-act="email-d" ${deliverable ? '' : 'disabled'}>Email delivery</button>
            <span class="hint">${job.questions_emailed_at ? 'Questions emailed ' + esc(fmtDate(job.questions_emailed_at)) + '. ' : ''}${job.delivery_emailed_at ? 'Delivery emailed ' + esc(fmtDate(job.delivery_emailed_at)) + '.' : ''}</span>
          </div>
          <details style="margin-top:10px"><summary>Record a client reply</summary>
            <div class="field"><label class="lbl">From email (optional)</label><input id="dd-rfrom" type="email" /></div>
            <div class="field"><label class="lbl">Reply text</label><textarea id="dd-reply" placeholder="Paste the reply — answers are matched to open questions."></textarea></div>
            <button class="btn small primary" data-act="reply">Record reply</button>
          </details>
          <div id="dd-email-out" class="hint" style="margin-top:8px"></div>
        </div>

        <div class="card"><h3>Review &amp; changes</h3>
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
    ? `${hasSite ? '<div id="dd-preview"></div>' : ''}
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

  if (hasSite) mountPreview($('#dd-preview'), (slug) => api.designRender(id, { editable: false, pageSlug: slug }));

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
    contact: async () => { await api.designContact(id, $('#dd-contact').value.trim()); toast('Contact saved', 'ok'); },
    'email-q': async () => {
      const x = (await api.designEmailQuestions(id)).data;
      $('#dd-email-out').textContent = x && (x.message || x.error) ? (x.message || x.error) : 'Questions email processed.';
      toast('Questions email processed', 'ok');
    },
    'email-d': async () => {
      const x = (await api.designEmailDelivery(id)).data;
      $('#dd-email-out').textContent = x && (x.message || x.error) ? (x.message || x.error) : 'Delivery email processed.';
      toast('Delivery email processed', 'ok');
    },
    reply: async () => {
      const reply = $('#dd-reply').value.trim();
      if (!reply) { toast('Paste the reply text.', 'err'); return; }
      await api.designReply(id, reply, $('#dd-rfrom').value.trim() || undefined);
      toast('Reply recorded', 'ok');
      pageDesignDetail(id);
    },
    review: async () => {
      $('#dd-review').innerHTML = '<p class="hint">Reviewing…</p>';
      const x = (await api.designReview(id, {})).data;
      const review = (x && x.review) || (x && x.job && x.job.review) || x;
      $('#dd-review').innerHTML = reviewHtml(review);
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
      const x = (await api.designPreview(id, false)).data;
      $('#dd-delivery-out').innerHTML = `Server preview: <span class="mono">${esc(x.url || x.path || '')}</span>`;
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
      <div><h1>Outreach</h1><p class="lede">Templates, campaigns, the send queue and the suppression list. Footer and daily caps are in Settings.</p></div>
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

async function tabCampaigns(host) {
  const r = (await api.campaigns({ pageSize: 50 })).data;
  const rows = r.rows || [];
  host.innerHTML = `
    <div class="toolbar"><button class="btn primary" data-act="new">New campaign</button><button class="btn" data-act="compose">Compose single email</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Status</th><th>Queued</th><th>Sent</th><th>Failed</th><th>Suppressed</th><th>Rate/h</th><th></th></tr></thead>
      <tbody>${rows.map((c) => `<tr>
        <td>${esc(c.name)}<div class="hint">#${esc(c.id)} · ${esc(fmtDate(c.created_at))}</div></td>
        <td>${statusBadge(c.status)}</td><td>${esc(c.queued)}</td><td>${esc(c.sent)}</td><td>${esc(c.failed)}</td><td>${esc(c.suppressed)}</td><td>${esc(c.rate_per_hour || '—')}</td>
        <td class="actions">
          <button class="btn small" data-act="messages" data-id="${c.id}" data-name="${esc(c.name)}">Messages</button>
          ${c.status === 'active' ? `<button class="btn small" data-act="pause" data-id="${c.id}">Pause</button>` : ''}
          ${c.status === 'paused' || c.status === 'draft' ? `<button class="btn small" data-act="resume" data-id="${c.id}">Resume</button>` : ''}
        </td></tr>`).join('') || '<tr><td colspan="8" class="empty">No campaigns yet.</td></tr>'}</tbody>
    </table></div>`;
  delegate(host, {
    new: () => openCampaignModal(),
    compose: () => openComposeModal(),
    messages: (t) => openMessagesModal(Number(t.dataset.id), t.dataset.name),
    pause: async (t) => { await api.campaignStatus(Number(t.dataset.id), 'paused'); tabCampaigns(host); },
    resume: async (t) => { await api.campaignStatus(Number(t.dataset.id), 'active'); tabCampaigns(host); },
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
      <div class="table-wrap"><table><thead><tr><th>To</th><th>Subject</th><th>Status</th><th>Scheduled</th><th>Sent</th><th></th></tr></thead>
      <tbody>${(r.rows || []).map((x) => `<tr>
        <td>${esc(x.to_email)}<div class="hint">${esc(x.business_name || '')}</div></td>
        <td>${esc(x.subject)}${x.error ? `<div class="error hint">${esc(x.error)}</div>` : ''}</td>
        <td>${statusBadge(x.status)}</td><td>${esc(fmtDate(x.scheduled_at))}</td><td>${esc(fmtDate(x.sent_at))}</td>
        <td>${x.status === 'queued' ? `<button class="btn small" data-act="send" data-id="${x.id}">Send now</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No messages.</td></tr>'}</tbody></table></div>
      <div class="pagination" id="cm-pager"></div>`;
    $('#cm-status', m.el).value = status;
    $('#cm-status', m.el).onchange = (e) => { status = e.target.value; page = 1; load(); };
    pager($('#cm-pager', m.el), { page: r.page || 1, pages: r.pages || 1, total: r.total || 0 }, (p) => { page = p; load(); });
  }
  delegate(m.el, {
    send: async (t) => { const x = (await api.emailSend(Number(t.dataset.id))).data; toast(x.sent ? 'Sent to ' + x.to : 'Not sent (suppressed)', x.sent ? 'ok' : ''); load(); },
  });
  await load();
}

async function openCampaignModal() {
  const tplR = await api.templates();
  const templates = tplR.data.templates || [];
  const selected = new Set();
  try { (JSON.parse(sessionStorage.getItem('scout.campaignLeadIds') || '[]') || []).forEach((i) => selected.add(Number(i))); } catch { /* ignore */ }
  sessionStorage.removeItem('scout.campaignLeadIds');
  let results = [];

  const m = openModal({
    title: 'New campaign',
    wide: true,
    body: `<div class="row">
        <div class="field"><label>Name *</label><input id="cp-name" type="text" /></div>
        <div class="field"><label>Template *</label><select id="cp-tpl">${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('') || '<option value="">(create a template first)</option>'}</select></div>
        <div class="field" style="max-width:130px"><label>Emails / hour</label><input id="cp-rate" type="number" min="1" max="1000" value="30" /></div>
      </div>
      <div class="field"><label>Find leads</label>
        <div class="inline"><input id="cp-q" type="search" placeholder="Search leads…" class="grow" style="flex:1" />
          <select id="cp-status" style="width:auto"><option value="">Any status</option>${optionList(LEAD_STATUSES, '')}</select>
          <button class="btn small" data-act="addall">Add all results</button></div></div>
      <div class="pick-list" id="cp-results"><div class="empty">Search or filter to list leads.</div></div>
      <p class="hint"><b id="cp-count">0</b> lead(s) selected. Leads without an email, or on the suppression list, are never sent.
        <button class="link-btn" data-act="clearsel">Clear</button></p>
      <div class="msg" id="cp-msg"></div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create campaign', cls: 'primary',
        onClick: async (mm) => {
          const name = $('#cp-name', mm.el).value.trim();
          const templateId = Number($('#cp-tpl', mm.el).value);
          const msg = $('#cp-msg', mm.el);
          if (!name) { setMsg(msg, 'Name is required.', 'err'); return; }
          if (!templateId) { setMsg(msg, 'Choose a template.', 'err'); return; }
          if (!selected.size) { setMsg(msg, 'Select at least one lead.', 'err'); return; }
          const r = (await api.createCampaign({ name, templateId, leadIds: Array.from(selected), ratePerHour: Number($('#cp-rate', mm.el).value) || 30 })).data;
          toast('Campaign created' + (r && r.queued != null ? `: ${r.queued} queued` : ''), 'ok');
          mm.close();
          pageOutreach();
        },
      },
    ],
  });

  const count = () => { $('#cp-count', m.el).textContent = selected.size; };
  function renderResults() {
    $('#cp-results', m.el).innerHTML = results.map((l) => `<label class="pick-row"><input type="checkbox" data-lead="${l.id}" ${selected.has(l.id) ? 'checked' : ''} />
      <span><b>${esc(l.business_name)}</b> <span class="hint">#${l.id} · ${esc(l.email || 'no email')} · ${esc(l.status)}</span></span></label>`).join('') || '<div class="empty">No leads found.</div>';
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

async function openComposeModal() {
  const templates = (await api.templates()).data.templates || [];
  const m = openModal({
    title: 'Compose a single email',
    wide: true,
    body: `<div class="field"><label>Lead</label><div id="cx-lead"></div></div>
      <div class="field"><label>Template</label><select id="cx-tpl">${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
      <div id="cx-prev" class="hint">Preview shows the personalized subject and body. Only VERIFIED / OWNER_PROVIDED facts are filled in.</div>`,
    buttons: [
      { label: 'Close' },
      {
        label: 'Preview',
        onClick: async (mm) => {
          const lead = picker.get();
          if (!lead) { toast('Select a lead.', 'err'); return; }
          const r = (await api.emailCompose(lead.id, Number($('#cx-tpl', mm.el).value), false)).data;
          $('#cx-prev', mm.el).innerHTML = `<div class="q-card"><b>${esc(r.subject)}</b><p style="white-space:pre-wrap">${esc(r.body)}</p>${(r.missing || []).length ? `<div class="hint">Missing: ${esc(r.missing.join(', '))}</div>` : ''}</div>`;
        },
      },
      {
        label: 'Queue & send now', cls: 'primary',
        onClick: async (mm) => {
          const lead = picker.get();
          if (!lead) { toast('Select a lead.', 'err'); return; }
          if (!window.confirm('Send this email now?')) return;
          const q = (await api.emailCompose(lead.id, Number($('#cx-tpl', mm.el).value), true)).data;
          const s = (await api.emailSend(q.messageId)).data;
          toast(s.sent ? 'Sent to ' + s.to : 'Not sent (suppressed)', s.sent ? 'ok' : 'err');
          mm.close();
        },
      },
    ],
  });
  const picker = mountLeadPicker($('#cx-lead', m.el));
}

async function tabTemplates(host) {
  const templates = (await api.templates()).data.templates || [];
  host.innerHTML = `
    <div class="grid cols-2" style="align-items:start">
      <div class="card"><h3 id="tp-title">New template</h3>
        <form id="tp-form">
          <input type="hidden" name="id" />
          <div class="field"><label>Name</label><input name="name" required /></div>
          <div class="field"><label>Subject</label><input name="subject" required /></div>
          <div class="field"><label>Body</label><textarea name="body" required style="min-height:200px">Hi {{business_name}},\n\n…</textarea>
            <div class="hint">Variables: <code>{{business_name}}</code> <code>{{city}}</code> <code>{{category}}</code> <code>{{phone}}</code> and other lead columns. Unknown values render empty.</div></div>
          <div class="inline"><button class="btn primary" type="submit">Save template</button><button class="btn" type="button" data-act="reset">Reset</button><span class="msg" id="tp-msg"></span></div>
        </form>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Subject</th><th></th></tr></thead>
        <tbody>${templates.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.subject)}</td>
          <td class="actions"><button class="btn small" data-act="edit" data-id="${t.id}">Edit</button> <button class="btn small danger" data-act="delete" data-id="${t.id}">Delete</button></td></tr>`).join('')
    || '<tr><td colspan="3" class="empty">No templates yet.</td></tr>'}</tbody></table></div>
    </div>`;
  const form = $('#tp-form', host);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = formObject(form);
    if (!body.id) delete body.id; else body.id = Number(body.id);
    try {
      await api.saveTemplate(body);
      toast('Template saved', 'ok');
      tabTemplates(host);
    } catch (err) { setMsg($('#tp-msg', host), err.message, 'err'); }
  };
  delegate(host, {
    reset: () => tabTemplates(host),
    edit: (t) => {
      const tpl = templates.find((x) => String(x.id) === t.dataset.id);
      if (!tpl) return;
      form.id.value = tpl.id;
      form.name.value = tpl.name;
      form.subject.value = tpl.subject;
      form.body.value = tpl.body;
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
  const columns = (res.data && res.data.columns) || [];
  view.innerHTML = `
    <div class="page-head"><div><h1>Pipeline</h1><p class="lede">Move leads between stages and record intent events (opens, clicks, claims).</p></div>
      <div class="page-actions"><button class="btn" data-act="refresh">Refresh</button></div></div>
    <div class="kanban">${columns.map((col) => `
      <div class="kanban-col" data-col="${esc(col.key)}">
        <div class="kanban-head"><span>${esc(col.title)}</span><span class="count">${esc(col.total)}</span></div>
        ${(col.leads || []).map((l) => `
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
/* Jobs (web-only scheduled jobs)                                      */
/* ------------------------------------------------------------------ */

async function pageJobs() {
  const res = await api.jobsList();
  const jobs = res.data.jobs || [];
  view.innerHTML = `
    <div class="page-head"><div><h1>Jobs</h1><p class="lede">Schedule discovery, outreach processing and custom work — also available via MCP <code>jobs.*</code>. Jobs honor the automation kill switch.</p></div></div>
    <div class="card"><h3>Create job</h3>
      <form id="job-form">
        <div class="row">
          <div class="field"><label>Name</label><input name="name" required placeholder="Nightly discovery" /></div>
          <div class="field"><label>Type</label><select name="type">${(res.data.types || []).map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>
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
  const tokens = d.tokens || [];
  const toolCount = d.toolCount != null ? d.toolCount : (d.tools || []).length;
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

async function pageSettings() {
  const safe = (p) => p.then((r) => r.data, () => null);
  const [setR, promptsR, schedR, provR, usageR, aiR, cfR] = await Promise.all([
    api.settingsGet(), safe(api.prompts()), safe(api.discoveryGet()), safe(api.providers()),
    safe(api.aiUsage(30)), safe(api.aiStatus()), safe(api.cfGet()),
  ]);
  const s = setR.data.settings || {};
  const prompts = (promptsR && promptsR.prompts) || [];
  const sched = schedR || {};
  const providers = ((provR && provR.providers) || []).filter((p) => p.name !== 'csv' && p.name !== 'manual');
  const paused = s.automation_paused === '1';
  automationPaused = paused;

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
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        ${[['sec-ai', 'AI'], ['sec-cost', 'Cost'], ['sec-prompts', 'Prompts'], ['sec-automation', 'Automation'], ['sec-agent', 'Design agent'], ['sec-learning', 'Design learning'], ['sec-discovery', 'Discovery'], ['sec-smtp', 'Email'], ['sec-cf', 'Cloudflare'], ['sec-keys', 'Provider keys'], ['sec-mail', 'Footer & scoring']].map(([id, l]) => `<button data-act="goto" data-id="${id}">${esc(l)}</button>`).join('')}
      </nav>
      <div class="settings-main">

        <section class="card" id="sec-ai"><h2>AI provider</h2>
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

        <section class="card" id="sec-cost"><h2>Cost controls</h2>
          <p class="hint">Hard stops for AI spend and daily production.</p>
          <div class="row">${f('cost.daily_budget_usd', 'Daily AI budget (USD)', { type: 'number', step: '0.5', min: 0 })}${f('cost.max_websites_per_day', 'Max websites / day', { type: 'number', min: 0 })}${f('cost.max_outreach_per_day', 'Max outreach emails / day', { type: 'number', min: 0 })}</div>
          <div class="row">${f('cost.per_1k_prompt', 'Cost / 1k prompt tokens (USD)', { type: 'number', step: '0.0001', min: 0 })}${f('cost.per_1k_completion', 'Cost / 1k completion tokens (USD)', { type: 'number', step: '0.0001', min: 0 })}</div>
          ${save('sec-cost', 'Save cost controls')}
        </section>

        <section class="card" id="sec-prompts"><h2>Prompt library</h2>
          <p class="hint">System prompts for each AI task. Restore brings back the shipped default.</p>
          <div class="field" style="max-width:320px"><label for="pr-sel">Prompt</label><select id="pr-sel">${prompts.map((p) => `<option value="${esc(p.key)}">${esc(p.name || p.key)}</option>`).join('')}</select></div>
          <div class="field"><label for="pr-body">Body</label><textarea id="pr-body" rows="10" class="mono"></textarea></div>
          <div class="inline"><button class="btn primary" data-act="prompt-save">Save prompt</button><button class="btn" data-act="prompt-reset">Restore default</button><span class="msg" id="pr-msg"></span></div>
        </section>

        <section class="card" id="sec-automation"><h2>Automation</h2>
          <p class="hint">Pause stops scanning, generation, campaigns, scheduled jobs and AI actions.</p>
          <p>Status: <strong id="auto-status">${paused ? 'Paused' : 'Running'}</strong></p>
          <div class="inline"><button class="btn" data-act="auto-toggle" id="auto-toggle">${paused ? 'Resume automation' : 'Pause automation'}</button></div>
          <div style="margin-top:16px"><button class="big-danger" data-act="auto-stop">Emergency stop</button></div>
        </section>

        <section class="card" id="sec-agent"><h2>Design agent trigger</h2>
          <p class="hint">When a design job becomes <code>waiting_on_agent</code> the server writes a trigger file and can run a command or POST a webhook (redesign / improvements). Failures never block the queue.</p>
          ${f('design.agent_notify', 'Notify', { options: onOff })}
          ${f('design.agent_trigger_command', 'Trigger command (optional)', { hint: 'Placeholders: <code>{{job_id}}</code>, <code>{{reason}}</code>, <code>{{status}}</code>, <code>{{message}}</code>. Runs on the server.' })}
          ${f('design.agent_webhook_url', 'Webhook URL (optional)', { type: 'url', placeholder: 'https://example.com/hooks/design-agent', hint: 'POSTed as JSON when redesign or improvements is queued.' })}
          ${f('design.agent_webhook_secret', 'Webhook secret (optional)', { type: 'password', hint: 'Sent as <code>Authorization: Bearer …</code> and <code>X-Webhook-Secret</code>.' })}
          ${f('design.agent_trigger_file', 'Trigger file path (optional)', { hint: 'Default: <code>design-agent-trigger.json</code> beside the workspace database.' })}
          ${save('sec-agent', 'Save design agent trigger')}
        </section>

        <section class="card" id="sec-learning"><h2>Design learning</h2>
          <p class="hint">Reviews, redesign requests and client emails feed a short playbook that is added to new design briefs.</p>
          <div class="row">${f('design.learning.enabled', 'Learning', { options: onOff })}${f('design.learning.max_playbook', 'Max playbook lessons', { type: 'number', min: 4, def: '24' })}</div>
          ${save('sec-learning', 'Save learning settings')}
          <div id="st-learning" style="margin-top:12px"></div>
        </section>

        <section class="card" id="sec-discovery"><h2>Discovery schedule</h2>
          <p class="hint">Runs lead discovery on the server on a schedule. Honors the automation pause switch.</p>
          <div class="row">
            <div class="field"><label>Schedule</label><select id="ds-enabled"><option value="0" ${sched.enabled ? '' : 'selected'}>Off</option><option value="1" ${sched.enabled ? 'selected' : ''}>On</option></select></div>
            <div class="field"><label>Frequency</label><select id="ds-mode"><option value="interval" ${sched.mode === 'daily' ? '' : 'selected'}>Every N hours</option><option value="daily" ${sched.mode === 'daily' ? 'selected' : ''}>Daily at a time</option></select></div>
            <div class="field"><label>Interval (hours)</label><input id="ds-interval" type="number" min="1" max="168" value="${esc(sched.interval_hours || 6)}" /></div>
            <div class="field"><label>Daily time</label><input id="ds-daily" type="time" value="${esc(sched.daily_time || '09:00')}" /></div>
          </div>
          <div class="row">
            <div class="field"><label>Provider</label><select id="ds-provider">${(providers.length ? providers : [{ name: sched.provider || 'tavily' }]).map((p) => `<option value="${esc(p.name)}" ${p.name === sched.provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
            <div class="field"><label>Category / niche</label><input id="ds-category" value="${esc(sched.category || '')}" placeholder="Plumber" /></div>
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

        <section class="card" id="sec-smtp"><h2>SMTP / outreach email</h2>
          <p class="hint">Use a real provider for deliverability. Outbound only; client replies are pasted on a Design job or dropped as .eml/.txt files into the inbound folder below.</p>
          ${f('mail.inbound_drop_dir', 'Inbound email drop folder (optional)', { placeholder: '(default: workspace data / inbound-email)' })}
          <div class="row">${f('smtp.host', 'Host', { placeholder: 'mail.example.com' })}${f('smtp.port', 'Port', { type: 'number', min: 1 })}${f('smtp.secure', 'Use TLS (port 465)', { options: [['0', 'No (STARTTLS / plain)'], ['1', 'Yes']] })}</div>
          <div class="row">${f('smtp.user', 'Username')}${secret('smtp.pass', 'Password')}</div>
          <div class="row">${f('smtp.from_name', 'From name')}${f('smtp.from_email', 'From email')}</div>
          ${save('sec-smtp', 'Save SMTP settings')}
        </section>

        <section class="card" id="sec-cf"><h2>Cloudflare Pages</h2>
          <p class="hint">Optional. Publish generated sites for a public preview URL. Token needs Account → Cloudflare Pages → Edit. ${cfR ? (cfR.configured ? '<span class="badge ok">configured</span>' : '<span class="badge warn">not configured</span>') : ''}</p>
          <div class="row">${f('cf.account_id', 'Account ID', { placeholder: '32-character hex ID' })}${f('cf.project', 'Pages project', { placeholder: 'my-preview-sites' })}</div>
          ${f('cf.preview_domain', 'Custom preview domain (optional)', { placeholder: 'previews.example.com' })}
          ${secret('cf.api_token', 'API token')}
          <div class="inline"><button class="btn primary" data-act="save" data-sec="sec-cf">Save Cloudflare settings</button><button class="btn" data-act="cf-test">Test connection</button><span class="msg" data-msg="sec-cf"></span></div>
          <div id="cf-out" class="hint" style="margin-top:8px"></div>
        </section>

        <section class="card" id="sec-keys"><h2>Provider keys</h2>
          <p class="hint">Write-only. Leave blank to keep the current value.</p>
          ${secret('providers.tavily.api_key', 'Tavily (lead discovery)', 'Required for Leads → Discover with the <code>tavily</code> provider.')}
          ${f('providers.tavily.search_depth', 'Tavily search depth', { options: [['advanced', 'advanced (better relevance)'], ['basic', 'basic (faster / cheaper)']] })}
          ${secret('pexels.api_key', 'Pexels (stock photos)')}
          ${secret('fal.api_key', 'fal.ai (image enhance)')}
          ${save('sec-keys', 'Save provider keys')}
        </section>

        <section class="card" id="sec-mail"><h2>Footer &amp; scoring</h2>
          ${f('mail.footer', 'Legal footer appended to every outreach email', { area: true })}
          <div class="row">${f('score.threshold_qualified', 'Qualified threshold (0–100)', { type: 'number', min: 0 })}${f('score.threshold_hot', 'Hot threshold (0–100)', { type: 'number', min: 0 })}${f('app.name', 'App name')}</div>
          ${save('sec-mail', 'Save')}
        </section>
      </div>
    </div>`;

  mountLearning($('#st-learning'));

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
    goto: (t) => { const el = document.getElementById(t.dataset.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
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
    'auto-toggle': async () => { await setAutomation(!automationPaused); pageSettings(); },
    'auto-stop': async () => {
      if (!window.confirm('Pause ALL automation now?')) return;
      await setAutomation(true);
      pageSettings();
    },
    'cf-test': async () => {
      const out = $('#cf-out');
      out.textContent = 'Testing connection…';
      const r = (await api.cfTest()).data;
      if (r.ok === false) out.innerHTML = `<span class="error">${esc(r.error)}</span>${r.hint || r.detail ? ' — ' + esc(r.hint || r.detail) : ''}`;
      else out.innerHTML = `<span class="check-pass">Connected.</span> Projects: ${esc((r.projects || []).join(', ') || 'none')}`;
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

const PAGES = {
  dashboard: pageDashboard, leads: pageLeads, websites: pageWebsites, design: pageDesign,
  outreach: pageOutreach, pipeline: pagePipeline, jobs: pageJobs, mcp: pageMcp, settings: pageSettings,
};

async function navigate() {
  closeNav();
  Array.from(overlays).forEach((o) => o.close());
  const { route, param, query } = parseHash();
  $$('.nav-links a').forEach((a) => {
    const on = a.dataset.route === route;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  topTitle.textContent = ROUTE_LABELS[route] || '';
  view.onclick = null;
  view.onchange = null;
  view.classList.toggle('wide', route === 'pipeline');
  leadsReload = null;

  if (!PAGES[route]) {
    view.innerHTML = '<div class="card error-card"><h2>Page not found</h2><p>Choose a page from the navigation.</p></div>';
    return;
  }
  view.innerHTML = '<p class="hint">Loading…</p>';
  try {
    await PAGES[route](param, query);
    window.scrollTo(0, 0);
    const main = $('.app-main');
    if (main) main.scrollTop = 0;
  } catch (err) {
    if (err.status === 401) return renderAuth();
    view.innerHTML = `<div class="card error-card"><h2>Page failed to load</h2><p>${esc(err.message)}</p></div>`;
  }
}

wsSelect.addEventListener('change', async () => {
  const id = Number(wsSelect.value);
  api.setWorkspaceId(id);
  try { await api.selectWorkspace(id); } catch (err) { toast(err.message, 'err'); }
  leadsState.selected.clear();
  await refreshAutomation();
  navigate();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  try { await api.logout(); } catch { /* ignore */ }
  localStorage.removeItem('scout.workspaceId');
  renderAuth();
});

autoEl.addEventListener('click', (e) => {
  e.preventDefault();
  if (e.shiftKey || e.ctrlKey || e.metaKey) { window.location.hash = '#/settings'; return; }
  const next = !automationPaused;
  if (!window.confirm(next ? 'Pause all automation (discovery, jobs, outreach, AI)?' : 'Resume automation?')) return;
  safeRun(null, async () => {
    await setAutomation(next);
    const { route } = parseHash();
    if (route === 'dashboard' || route === 'settings') navigate();
  });
});

document.getElementById('menu-btn').addEventListener('click', openNav);
document.getElementById('sidebar-close').addEventListener('click', closeNav);
document.getElementById('sidebar-backdrop').addEventListener('click', closeNav);
window.addEventListener('hashchange', navigate);

(async function init() {
  try {
    const me = await api.me();
    if (me.data.workspaceId) api.setWorkspaceId(me.data.workspaceId);
    else if (api.getWorkspaceId()) await api.selectWorkspace(api.getWorkspaceId());
    await bootApp(me.data);
  } catch {
    renderAuth();
  }
})();
