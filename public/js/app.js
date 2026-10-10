'use strict';

const api = window.ScoutApi;
const authGate = document.getElementById('auth-gate');
const shell = document.getElementById('app-shell');
const view = document.getElementById('view');
const wsSelect = document.getElementById('workspace-select');
const autoPill = document.getElementById('shell-automation');

const ROUTES = ['dashboard', 'leads', 'websites', 'design', 'outreach', 'pipeline', 'jobs', 'mcp', 'settings'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAuth() {
  authGate.classList.remove('hidden');
  shell.classList.add('hidden');
  authGate.innerHTML = `
    <div class="auth-card">
      <h1>Website Scout</h1>
      <p class="sub">Multi-tenant web app — sign in to your workspace.</p>
      <div class="tabs">
        <button type="button" class="active" data-tab="login">Log in</button>
        <button type="button" data-tab="register">Register</button>
      </div>
      <form id="auth-form" class="stack">
        <div>
          <label>Email</label>
          <input name="email" type="email" required autocomplete="username" />
        </div>
        <div>
          <label>Password</label>
          <input name="password" type="password" required minlength="8" autocomplete="current-password" />
        </div>
        <div id="reg-extra" class="hidden">
          <label>Your name</label>
          <input name="name" type="text" />
          <label>Workspace name</label>
          <input name="workspaceName" type="text" placeholder="My agency" />
        </div>
        <button class="btn" type="submit">Continue</button>
        <div class="msg" id="auth-msg"></div>
      </form>
    </div>`;

  let mode = 'login';
  authGate.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.tab;
      authGate.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      authGate.querySelector('#reg-extra').classList.toggle('hidden', mode !== 'register');
    });
  });

  authGate.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    const msg = authGate.querySelector('#auth-msg');
    msg.textContent = 'Working…';
    msg.className = 'msg';
    try {
      const res = mode === 'login' ? await api.login(body) : await api.register(body);
      api.setWorkspaceId(res.data.workspaceId);
      await bootApp(res.data);
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
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
    const paused = !!res.data.automationPaused;
    autoPill.textContent = paused ? 'Automation paused' : 'Automation running';
    autoPill.classList.toggle('is-paused', paused);
    autoPill.classList.toggle('is-running', !paused);
  } catch {
    autoPill.textContent = 'Automation';
  }
}

async function bootApp(meData) {
  authGate.classList.add('hidden');
  shell.classList.remove('hidden');
  fillWorkspaces(meData.workspaces, meData.workspaceId || api.getWorkspaceId());
  await refreshAutomation();
  navigate();
}

async function pageDashboard() {
  const res = await api.stats();
  const d = res.data;
  view.innerHTML = `
    <h2 class="page-title">${esc(d.workspace.name)}</h2>
    <p class="page-sub">Workspace overview · role ${esc(d.workspace.role)}</p>
    <div class="grid">
      <div class="stat"><div class="n">${d.leadsTotal}</div><div class="l">Leads</div></div>
      <div class="stat"><div class="n">${d.designJobsWaitingOnAgent}</div><div class="l">Design waiting</div></div>
      <div class="stat"><div class="n">${d.jobsEnabled}</div><div class="l">Jobs enabled</div></div>
      <div class="stat"><div class="n">$${Number(d.aiSpendTodayUsd || 0).toFixed(2)}</div><div class="l">AI spend today</div></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Recent activity</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>When</th><th>Area</th><th>Message</th></tr></thead>
        <tbody>
          ${(d.activity || []).map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.area)}</td><td>${esc(a.message)}</td></tr>`).join('') || '<tr><td colspan="3">No activity yet</td></tr>'}
        </tbody></table>
      </div>
    </div>`;
}

async function pageLeads() {
  view.innerHTML = `
    <h2 class="page-title">Leads</h2>
    <p class="page-sub">Create, discover, score, and research prospects.</p>
    <div class="panel">
      <div class="panel-h"><h3>Discover</h3></div>
      <div class="panel-b">
        <form id="discover-form" class="stack">
          <div class="row">
            <div><label>Category</label><input name="category" value="Plumber" /></div>
            <div><label>Location</label><input name="location" value="Springfield" /></div>
            <div><label>Limit</label><input name="limit" type="number" value="8" min="1" max="50" /></div>
          </div>
          <div class="row actions"><button class="btn" type="submit">Run discovery</button></div>
          <div class="msg" id="discover-msg"></div>
        </form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Add lead</h3></div>
      <div class="panel-b">
        <form id="lead-form" class="stack">
          <div class="row">
            <div><label>Business name</label><input name="business_name" required /></div>
            <div><label>Category</label><input name="category" /></div>
          </div>
          <div class="row">
            <div><label>Email</label><input name="email" type="email" /></div>
            <div><label>Phone</label><input name="phone" /></div>
            <div><label>City</label><input name="city" /></div>
          </div>
          <div class="row actions"><button class="btn" type="submit">Create</button></div>
          <div class="msg" id="lead-msg"></div>
        </form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h">
        <h3>All leads</h3>
        <input id="lead-q" placeholder="Search…" style="max-width:220px" />
      </div>
      <div class="panel-b" id="lead-table">Loading…</div>
    </div>`;

  async function load(q = '') {
    const res = await api.leads(q ? `?q=${encodeURIComponent(q)}` : '');
    const rows = res.data.leads || res.data.rows || [];
    document.getElementById('lead-table').innerHTML = `
      <table><thead><tr><th>Name</th><th>City</th><th>Status</th><th>Score</th><th></th></tr></thead>
      <tbody>
        ${rows.map((l) => `<tr>
          <td>${esc(l.business_name)}<div class="msg">${esc(l.email || '')}</div></td>
          <td>${esc(l.city || '')}</td>
          <td>${esc(l.status)}</td>
          <td>${esc(l.score)}</td>
          <td class="row actions">
            <button class="btn ghost" data-score="${l.id}">Score</button>
            <button class="btn ghost" data-research="${l.id}">Research</button>
            <button class="btn ghost" data-qualify="${l.id}">Qualify</button>
            <button class="btn danger" data-del="${l.id}">Delete</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="5">No leads yet</td></tr>'}
      </tbody></table>`;

    document.querySelectorAll('[data-score]').forEach((b) => b.onclick = async () => { await api.scoreLead(b.dataset.score); load(document.getElementById('lead-q').value); });
    document.querySelectorAll('[data-research]').forEach((b) => b.onclick = async () => { b.disabled = true; try { await api.researchLead(b.dataset.research); load(document.getElementById('lead-q').value); } catch (e) { alert(e.message); } finally { b.disabled = false; } });
    document.querySelectorAll('[data-qualify]').forEach((b) => b.onclick = async () => { await api.qualifyLead(b.dataset.qualify); load(document.getElementById('lead-q').value); });
    document.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('Delete lead?')) { await api.deleteLead(b.dataset.del); load(document.getElementById('lead-q').value); } });
  }

  document.getElementById('discover-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.limit = Number(body.limit) || 8;
    const msg = document.getElementById('discover-msg');
    msg.textContent = 'Discovering…';
    try {
      const res = await api.discover(body);
      msg.textContent = `Done: ${JSON.stringify(res.data).slice(0, 180)}…`;
      msg.className = 'msg ok';
      load();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  };

  document.getElementById('lead-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    const msg = document.getElementById('lead-msg');
    try {
      await api.createLead(body);
      msg.textContent = 'Created';
      msg.className = 'msg ok';
      e.target.reset();
      load();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  };
  let t;
  document.getElementById('lead-q').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => load(e.target.value), 250);
  };
  await load();
}

async function pageWebsites() {
  const res = await api.websites();
  const sites = res.data.sites || [];
  view.innerHTML = `
    <h2 class="page-title">Websites</h2>
    <p class="page-sub">Template sites and agent-delivered sites for this workspace.</p>
    <div class="panel">
      <div class="panel-h"><h3>Generate for lead</h3></div>
      <div class="panel-b">
        <form id="gen-form" class="row actions">
          <input name="leadId" type="number" min="1" placeholder="Lead id" required style="max-width:140px" />
          <button class="btn" type="submit">Generate</button>
        </form>
        <div class="msg" id="gen-msg"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Sites</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>Name</th><th>Lead</th><th>Status</th><th>Origin</th><th>Updated</th></tr></thead>
        <tbody>
          ${sites.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.business_name || s.lead_id || '')}</td><td>${esc(s.status)}</td><td>${esc(s.origin || '')}</td><td>${esc(s.updated_at)}</td></tr>`).join('') || '<tr><td colspan="5">No websites yet</td></tr>'}
        </tbody></table>
      </div>
    </div>`;
  document.getElementById('gen-form').onsubmit = async (e) => {
    e.preventDefault();
    const leadId = Number(new FormData(e.target).get('leadId'));
    const msg = document.getElementById('gen-msg');
    msg.textContent = 'Generating…';
    try {
      await api.generateSite({ leadId, force: true });
      msg.textContent = 'Generated';
      msg.className = 'msg ok';
      pageWebsites();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  };
}

async function pageOutreach() {
  const [tpl, camps, stats] = await Promise.all([api.templates(), api.campaigns(), api.outreachStats()]);
  const templates = tpl.data.templates || [];
  const campaigns = camps.data.rows || camps.data.campaigns || (Array.isArray(camps.data) ? camps.data : []);
  view.innerHTML = `
    <h2 class="page-title">Outreach</h2>
    <p class="page-sub">Templates, campaigns, and queue processing.</p>
    <div class="grid">
      <div class="stat"><div class="n">${esc((stats.data && (stats.data.queued ?? stats.data.queuedToday)) ?? '—')}</div><div class="l">Queued / stats</div></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Save template</h3></div>
      <div class="panel-b">
        <form id="tpl-form" class="stack">
          <div class="row"><div><label>Name</label><input name="name" required /></div><div><label>Subject</label><input name="subject" required /></div></div>
          <div><label>Body</label><textarea name="body" required>Hi {{business_name}}, …</textarea></div>
          <div class="row actions"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" id="process-q">Process queue</button></div>
          <div class="msg" id="tpl-msg"></div>
        </form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Templates</h3></div>
      <div class="panel-b"><table><thead><tr><th>ID</th><th>Name</th><th>Subject</th></tr></thead>
        <tbody>${templates.map((t) => `<tr><td>${t.id}</td><td>${esc(t.name)}</td><td>${esc(t.subject)}</td></tr>`).join('') || '<tr><td colspan="3">None</td></tr>'}</tbody></table></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Campaigns</h3></div>
      <div class="panel-b"><table><thead><tr><th>Name</th><th>Status</th></tr></thead>
        <tbody>${(campaigns.items || campaigns || []).map ? '' : ''}
          ${([].concat(campaigns.items || campaigns || [])).map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.status)}</td></tr>`).join('') || '<tr><td colspan="2">None yet — create via API/MCP with leadIds + templateId</td></tr>'}
        </tbody></table></div>
    </div>`;
  document.getElementById('tpl-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try { await api.saveTemplate(body); document.getElementById('tpl-msg').textContent = 'Saved'; pageOutreach(); }
    catch (err) { document.getElementById('tpl-msg').textContent = err.message; document.getElementById('tpl-msg').className = 'msg error'; }
  };
  document.getElementById('process-q').onclick = async () => {
    try { await api.processQueue(); alert('Queue processed'); pageOutreach(); }
    catch (e) { alert(e.message); }
  };
}

async function pagePipeline() {
  const res = await api.pipeline();
  const columns = (res.data && res.data.columns) || [];
  view.innerHTML = `
    <h2 class="page-title">Pipeline</h2>
    <p class="page-sub">Lead stages for this workspace.</p>
    <div class="grid">
      ${columns.map((col) => `
        <div class="panel" style="margin:0">
          <div class="panel-h"><h3>${esc(col.label || col.status || col.id)}</h3><span class="msg">${esc(col.total ?? (col.leads || []).length)}</span></div>
          <div class="panel-b">
            ${(col.leads || []).slice(0, 12).map((l) => `<div style="padding:0.35rem 0;border-bottom:1px solid var(--line)">${esc(l.business_name)} <span class="msg">${esc(l.score ?? '')}</span></div>`).join('') || '<div class="msg">Empty</div>'}
          </div>
        </div>`).join('') || '<p class="msg">No pipeline columns</p>'}
    </div>`;
}

async function pageDesign() {
  const pending = await api.designPending();
  const list = await api.designList();
  view.innerHTML = `
    <h2 class="page-title">Design</h2>
    <p class="page-sub">${pending.data.counts.waiting_on_agent} waiting on agent · ${pending.data.counts.questions_pending} questions pending</p>
    <div class="panel">
      <div class="panel-h"><h3>New design job</h3></div>
      <div class="panel-b">
        <form id="design-form" class="stack">
          <div class="row">
            <div><label>Type</label><input name="type" value="website" /></div>
            <div><label>Title</label><input name="title" required /></div>
          </div>
          <div><label>Instructions</label><textarea name="instructions" required></textarea></div>
          <div class="row actions"><button class="btn" type="submit">Queue for agent</button></div>
          <div class="msg" id="design-msg"></div>
        </form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Jobs</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Updated</th></tr></thead>
        <tbody>
          ${(list.data.jobs || []).map((j) => `<tr><td>${esc(j.title)}</td><td>${esc(j.type)}</td><td>${esc(j.status)}</td><td>${esc(j.updated_at)}</td></tr>`).join('') || '<tr><td colspan="4">No design jobs</td></tr>'}
        </tbody></table>
      </div>
    </div>`;

  document.getElementById('design-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    const msg = document.getElementById('design-msg');
    try {
      await api.designCreate(body);
      msg.textContent = 'Queued';
      msg.className = 'msg ok';
      pageDesign();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  };
}

async function pageJobs() {
  const res = await api.jobsList();
  view.innerHTML = `
    <h2 class="page-title">Jobs</h2>
    <p class="page-sub">Schedule discovery, outreach processing, and custom work — also available via MCP <span class="mono">jobs.*</span>.</p>
    <div class="panel">
      <div class="panel-h"><h3>Create job</h3></div>
      <div class="panel-b">
        <form id="job-form" class="stack">
          <div class="row">
            <div><label>Name</label><input name="name" required placeholder="Nightly discovery" /></div>
            <div><label>Type</label>
              <select name="type">
                ${(res.data.types || []).map((t) => `<option value="${t}">${t}</option>`).join('')}
              </select>
            </div>
            <div><label>Interval (minutes)</label><input name="interval_minutes" type="number" min="1" value="360" /></div>
          </div>
          <div><label>Payload JSON (optional)</label><textarea name="payload">{"category":"Plumber","location":"Springfield","limit":8}</textarea></div>
          <div class="row actions"><button class="btn" type="submit">Create</button></div>
          <div class="msg" id="job-msg"></div>
        </form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Scheduled jobs</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>Name</th><th>Type</th><th>Next</th><th>Last</th><th></th></tr></thead>
        <tbody>
          ${(res.data.jobs || []).map((j) => `<tr>
            <td>${esc(j.name)}<div class="msg">${j.enabled ? 'enabled' : 'disabled'}</div></td>
            <td>${esc(j.type)}</td>
            <td>${esc(j.next_run_at || '—')}</td>
            <td>${esc(j.last_status || '—')}<div class="msg">${esc(j.last_run_at || '')}</div></td>
            <td class="row actions">
              <button class="btn ghost" data-run="${j.id}">Run now</button>
              <button class="btn ghost" data-tog="${j.id}" data-en="${j.enabled ? 0 : 1}">${j.enabled ? 'Disable' : 'Enable'}</button>
              <button class="btn danger" data-del="${j.id}">Delete</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="5">No jobs yet</td></tr>'}
        </tbody></table>
      </div>
    </div>`;

  document.getElementById('job-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.interval_minutes = Number(body.interval_minutes) || null;
    try { body.payload = JSON.parse(body.payload || '{}'); } catch { body.payload = {}; }
    const msg = document.getElementById('job-msg');
    try {
      await api.jobsCreate(body);
      msg.textContent = 'Created';
      msg.className = 'msg ok';
      pageJobs();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  };

  document.querySelectorAll('[data-run]').forEach((b) => b.onclick = async () => { await api.jobsRun(b.dataset.run); pageJobs(); });
  document.querySelectorAll('[data-tog]').forEach((b) => b.onclick = async () => { await api.jobsUpdate(b.dataset.tog, { enabled: Number(b.dataset.en) === 1 }); pageJobs(); });
  document.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('Delete job?')) { await api.jobsDelete(b.dataset.del); pageJobs(); } });
}

async function pageMcp() {
  const res = await api.mcpStatus();
  const origin = window.location.origin;
  view.innerHTML = `
    <h2 class="page-title">MCP</h2>
    <p class="page-sub">Connect Cursor / agents with a workspace Bearer token.</p>
    <div class="panel">
      <div class="panel-h"><h3>Endpoint</h3></div>
      <div class="panel-b">
        <p class="mono">${esc(origin)}/mcp</p>
        <p class="msg">Auth header: <span class="mono">Authorization: Bearer &lt;token&gt;</span></p>
        <p class="msg">Tools: ${esc((res.data.tools || []).join(', '))}</p>
        <div class="row actions" style="margin-top:1rem">
          <button class="btn" id="mint-token" type="button">Create MCP token</button>
        </div>
        <div class="msg" id="mcp-msg"></div>
        <pre class="mono" id="mcp-token-out" style="white-space:pre-wrap"></pre>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Tokens</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th>Created</th></tr></thead>
        <tbody>
          ${(res.data.tokens || []).map((t) => `<tr><td>${esc(t.name)}</td><td class="mono">${esc(t.token_prefix)}…</td><td>${esc(t.last_used_at || '—')}</td><td>${esc(t.created_at)}</td></tr>`).join('') || '<tr><td colspan="4">No tokens yet</td></tr>'}
        </tbody></table>
      </div>
    </div>`;

  document.getElementById('mint-token').onclick = async () => {
    const out = await api.mcpToken('MCP');
    document.getElementById('mcp-token-out').textContent = out.data.token;
    document.getElementById('mcp-msg').textContent = out.data.hint;
    document.getElementById('mcp-msg').className = 'msg ok';
  };
}

async function pageSettings() {
  const res = await api.settingsGet();
  const s = res.data.settings || {};
  const keys = [
    'app.name', 'ai.base_url', 'ai.model.default', 'ai.model.image',
    'smtp.host', 'smtp.port', 'smtp.user', 'smtp.from_email', 'smtp.from_name',
    'cost.daily_budget_usd', 'cost.max_outreach_per_day',
    'score.threshold_qualified', 'score.threshold_hot',
  ];
  view.innerHTML = `
    <h2 class="page-title">Settings</h2>
    <p class="page-sub">Per-workspace configuration. Secrets are write-only.</p>
    <div class="panel">
      <div class="panel-h"><h3>Automation</h3>
        <button class="btn ghost" id="toggle-auto" type="button">${s.automation_paused === '1' ? 'Resume' : 'Pause'}</button>
      </div>
      <div class="panel-b"><p class="msg">Kill switch for discovery, outreach jobs, and AI actions.</p></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>General</h3></div>
      <div class="panel-b">
        <form id="settings-form" class="stack">
          ${keys.map((k) => `<div><label>${esc(k)}</label><input name="${esc(k)}" value="${esc(s[k] || '')}" /></div>`).join('')}
          <div class="row actions"><button class="btn" type="submit">Save settings</button></div>
          <div class="msg" id="set-msg"></div>
        </form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Secrets</h3></div>
      <div class="panel-b">
        <form id="secret-form" class="stack">
          <div><label>ai.api_key ${s['ai.api_key'] === '***' ? '(set)' : '(empty)'}</label><input name="ai.api_key" type="password" placeholder="Paste new key" /></div>
          <div><label>smtp.pass</label><input name="smtp.pass" type="password" placeholder="Paste SMTP password" /></div>
          <div><label>providers.tavily.api_key (needed for Discover)</label><input name="providers.tavily.api_key" type="password" /></div>
          <div><label>pexels.api_key</label><input name="pexels.api_key" type="password" /></div>
          <div><label>cf.api_token</label><input name="cf.api_token" type="password" /></div>
          <div class="row actions"><button class="btn" type="submit">Save secrets</button></div>
          <div class="msg" id="sec-msg"></div>
        </form>
      </div>
    </div>`;

  document.getElementById('toggle-auto').onclick = async () => {
    await api.automation(!(s.automation_paused === '1'));
    await refreshAutomation();
    pageSettings();
  };

  document.getElementById('settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const msg = document.getElementById('set-msg');
    try {
      for (const [key, value] of fd.entries()) await api.settingsSet(key, value);
      msg.textContent = 'Saved';
      msg.className = 'msg ok';
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  };

  document.getElementById('secret-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const msg = document.getElementById('sec-msg');
    try {
      for (const [key, value] of fd.entries()) {
        if (String(value).trim()) await api.settingsSecret(key, value);
      }
      msg.textContent = 'Secrets updated';
      msg.className = 'msg ok';
      e.target.reset();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  };
}

async function navigate() {
  const hash = window.location.hash || '#/dashboard';
  const match = hash.match(/^#\/([a-z-]+)/);
  const route = match ? match[1] : 'dashboard';
  document.querySelectorAll('.nav-links a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });
  if (!ROUTES.includes(route)) {
    view.innerHTML = `<div class="panel"><div class="panel-b">Unknown route</div></div>`;
    return;
  }
  view.innerHTML = `<p class="msg">Loading…</p>`;
  try {
    if (route === 'dashboard') await pageDashboard();
    else if (route === 'leads') await pageLeads();
    else if (route === 'websites') await pageWebsites();
    else if (route === 'design') await pageDesign();
    else if (route === 'outreach') await pageOutreach();
    else if (route === 'pipeline') await pagePipeline();
    else if (route === 'jobs') await pageJobs();
    else if (route === 'mcp') await pageMcp();
    else if (route === 'settings') await pageSettings();
  } catch (err) {
    if (err.status === 401) return renderAuth();
    view.innerHTML = `<div class="panel"><div class="panel-b msg error">${esc(err.message)}</div></div>`;
  }
}

wsSelect.addEventListener('change', async () => {
  const id = Number(wsSelect.value);
  api.setWorkspaceId(id);
  await api.selectWorkspace(id);
  await refreshAutomation();
  navigate();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  try { await api.logout(); } catch { /* ignore */ }
  localStorage.removeItem('scout.workspaceId');
  renderAuth();
});

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
