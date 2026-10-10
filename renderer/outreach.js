'use strict';
/* outreach.js — companion to outreach.html. Wires the four tabs via window.api.invoke.
   Runs when the shell injects the fragment into #view. */
(function () {
  const api = () => window.api;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function openModal(html) {
    const m = $('#outreach-modal');
    $('#outreach-modal-box').innerHTML = html;
    m.classList.remove('hidden');
  }
  function closeModal() {
    $('#outreach-modal').classList.add('hidden');
    $('#outreach-modal-box').innerHTML = '';
  }

  async function invoke(channel, ...args) {
    try {
      return await api().invoke(channel, ...args);
    } catch (err) {
      alert('Error: ' + (err && err.message ? err.message : err));
      throw err;
    }
  }

  /* ---------------- Campaigns ---------------- */

  async function loadCampaigns() {
    const rows = await invoke('campaigns:list');
    const tb = $('#campaigns-table tbody');
    tb.innerHTML = rows.map((c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td><span class="pill">${esc(c.status)}</span></td>
        <td>${esc(c.rate_per_hour)}</td>
        <td>${c.queued}</td><td>${c.sent}</td><td>${c.failed}</td><td>${c.suppressed}</td>
        <td>${esc(c.created_at || '')}</td>
        <td class="actions">
          <button class="btn small" data-view="${c.id}">View</button>
          ${c.status === 'active' ? `<button class="btn small" data-pause="${c.id}">Pause</button>` : ''}
          ${c.status === 'paused' || c.status === 'draft' ? `<button class="btn small" data-resume="${c.id}">Resume</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="9" class="muted">No campaigns yet.</td></tr>';
    $('#campaigns-summary').textContent = `${rows.length} campaign(s)`;
    $$('#campaigns-table [data-view]').forEach((b) => b.onclick = () => viewCampaign(Number(b.dataset.view)));
    $$('#campaigns-table [data-pause]').forEach((b) => b.onclick = async () => { await invoke('campaigns:setStatus', { id: Number(b.dataset.pause), status: 'paused' }); loadCampaigns(); });
    $$('#campaigns-table [data-resume]').forEach((b) => b.onclick = async () => { await invoke('campaigns:setStatus', { id: Number(b.dataset.resume), status: 'active' }); loadCampaigns(); });
  }

  async function viewCampaign(id) {
    const rows = await invoke('campaigns:messages', { id });
    const detail = $('#campaign-detail');
    detail.classList.remove('hidden');
    $('#campaign-detail-title').textContent = `Messages (${rows.length})`;
    $('#campaign-messages-table tbody').innerHTML = rows.map((m) => `
      <tr>
        <td>${esc(m.to_email)}</td>
        <td>${esc(m.business_name || '')}</td>
        <td>${esc(m.subject)}</td>
        <td><span class="pill">${esc(m.status)}</span></td>
        <td>${esc(m.scheduled_at || '')}</td>
        <td>${esc(m.sent_at || '')}</td>
        <td class="muted">${esc(m.error || '')}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">No messages.</td></tr>';
    detail.scrollIntoView();
  }

  // Create wizard: name -> template -> leads -> rate -> launch
  const wizard = { step: 0, name: '', templateId: null, leadIds: new Set(), rate: 30, templates: [], leads: [] };

  async function startWizard() {
    wizard.step = 0; wizard.name = ''; wizard.templateId = null; wizard.leadIds = new Set(); wizard.rate = 30;
    wizard.templates = await invoke('templates:list');
    if (!wizard.templates.length) { alert('Create an email template first (Templates tab).'); return; }
    renderWizard();
  }

  function renderWizard() {
    let body = '';
    if (wizard.step === 0) {
      body = `<h3>New campaign — 1/4: Name</h3>
        <input id="wiz-name" placeholder="Campaign name" value="${esc(wizard.name)}" style="width:100%" />`;
    } else if (wizard.step === 1) {
      body = `<h3>2/4: Template</h3>
        <select id="wiz-template" style="width:100%">${wizard.templates.map((t) =>
          `<option value="${t.id}" ${t.id === wizard.templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`;
    } else if (wizard.step === 2) {
      body = `<h3>3/4: Leads</h3>
        <input id="wiz-search" placeholder="Search leads…" style="width:100%;margin-bottom:8px" />
        <div id="wiz-leads" class="lead-pick"></div>
        <p class="muted">${wizard.leadIds.size} selected. Leads without email or on the suppression list are queued as suppressed.</p>`;
    } else {
      body = `<h3>4/4: Rate &amp; launch</h3>
        <label>Emails per hour: <input id="wiz-rate" type="number" min="1" max="1000" value="${wizard.rate}" /></label>
        <p class="muted">Campaign "<b>${esc(wizard.name)}</b>" with <b>${wizard.leadIds.size}</b> lead(s) at <b>${wizard.rate}</b>/hour. Respects the daily outreach cap and suppression list.</p>`;
    }
    openModal(`${body}
      <div class="modal-actions">
        <button class="btn" id="wiz-cancel">Cancel</button>
        ${wizard.step > 0 ? '<button class="btn" id="wiz-back">Back</button>' : ''}
        ${wizard.step < 3 ? '<button class="btn primary" id="wiz-next">Next</button>'
          : '<button class="btn primary" id="wiz-launch">Launch campaign</button>'}
      </div>`);
    $('#wiz-cancel').onclick = closeModal;
    const back = $('#wiz-back'); if (back) back.onclick = () => { wizard.step--; renderWizard(); };
    const next = $('#wiz-next'); if (next) next.onclick = onWizardNext;
    const launch = $('#wiz-launch'); if (launch) launch.onclick = onWizardLaunch;
    if (wizard.step === 2) wireLeadPicker();
  }

  function onWizardNext() {
    if (wizard.step === 0) {
      const v = $('#wiz-name').value.trim();
      if (!v) { alert('Name is required'); return; }
      wizard.name = v;
    } else if (wizard.step === 1) {
      wizard.templateId = Number($('#wiz-template').value);
    } else if (wizard.step === 2) {
      if (!wizard.leadIds.size) { alert('Select at least one lead'); return; }
    }
    wizard.step++; renderWizard();
  }

  async function onWizardLaunch() {
    wizard.rate = Math.max(1, Math.min(1000, Number($('#wiz-rate').value) || 30));
    const res = await invoke('campaigns:create', {
      name: wizard.name, templateId: wizard.templateId,
      leadIds: Array.from(wizard.leadIds), ratePerHour: wizard.rate,
    });
    closeModal();
    alert(`Campaign launched: ${res.queued} queued, ${res.suppressed} suppressed.`);
    loadCampaigns();
  }

  async function wireLeadPicker() {
    if (!wizard.leads.length) {
      try { wizard.leads = await invoke('leads:list', { pageSize: 500 }); }
      catch (e) { wizard.leads = (e && e.items) || []; }
      if (!Array.isArray(wizard.leads)) wizard.leads = wizard.leads.items || [];
    }
    const draw = (q) => {
      const query = (q || '').toLowerCase();
      const list = wizard.leads.filter((l) =>
        !query || (l.business_name || '').toLowerCase().includes(query) ||
        (l.email || '').toLowerCase().includes(query));
      $('#wiz-leads').innerHTML = list.slice(0, 200).map((l) => `
        <label class="lead-row"><input type="checkbox" data-lead="${l.id}" ${wizard.leadIds.has(l.id) ? 'checked' : ''} />
        <b>${esc(l.business_name)}</b> <span class="muted">${esc(l.email || 'no email')} · ${esc(l.status || '')}</span></label>`
      ).join('') || '<p class="muted">No leads found.</p>';
      $$('#wiz-leads [data-lead]').forEach((cb) => cb.onchange = () => {
        const id = Number(cb.dataset.lead);
        if (cb.checked) wizard.leadIds.add(id); else wizard.leadIds.delete(id);
      });
    };
    draw('');
    $('#wiz-search').oninput = (e) => draw(e.target.value);
  }

  /* ---------------- Templates ---------------- */

  async function loadTemplates() {
    const rows = await invoke('templates:list');
    $('#templates-table tbody').innerHTML = rows.map((t) => `
      <tr><td>${esc(t.name)}</td><td>${esc(t.subject)}</td><td>${esc(t.created_at || '')}</td>
      <td class="actions">
        <button class="btn small" data-edit="${t.id}">Edit</button>
        <button class="btn small danger" data-del="${t.id}">Delete</button>
      </td></tr>`).join('') || '<tr><td colspan="4" class="muted">No templates yet.</td></tr>';
    $$('#templates-table [data-edit]').forEach((b) => b.onclick = () => editTemplate(rows.find((t) => t.id === Number(b.dataset.edit))));
    $$('#templates-table [data-del]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this template?')) return;
      await invoke('templates:delete', Number(b.dataset.del));
      loadTemplates();
    });
  }

  function editTemplate(t) {
    const isNew = !t;
    openModal(`<h3>${isNew ? 'New' : 'Edit'} template</h3>
      <label>Name<br/><input id="tpl-name" style="width:100%" value="${esc(t ? t.name : '')}" /></label><br/><br/>
      <label>Subject<br/><input id="tpl-subject" style="width:100%" value="${esc(t ? t.subject : '')}" /></label><br/><br/>
      <label>Body (HTML allowed)<br/><textarea id="tpl-body" rows="10" style="width:100%">${esc(t ? t.body : '')}</textarea></label>
      <p class="muted">Variables: {{business_name}} {{category}} {{phone}} {{email}} {{preview_path}} … — only verified facts are substituted; unknown values render empty.</p>
      <div class="modal-actions">
        <button class="btn" id="tpl-cancel">Cancel</button>
        <button class="btn primary" id="tpl-save">Save</button>
      </div>`);
    $('#tpl-cancel').onclick = closeModal;
    $('#tpl-save').onclick = async () => {
      const payload = { name: $('#tpl-name').value, subject: $('#tpl-subject').value, body: $('#tpl-body').value };
      if (t) payload.id = t.id;
      await invoke('templates:save', payload);
      closeModal(); loadTemplates();
    };
  }

  /* ---------------- Queue ---------------- */

  async function loadQueueStats() {
    const s = await invoke('outreach:stats');
    const m = s.messagesByStatus || {};
    const cards = [
      ['Active campaigns', s.activeCampaigns], ['Queued', m.queued || 0],
      ['Sent', m.sent || 0], ['Failed', m.failed || 0],
      ['Suppressed', m.suppressed || 0], ['Sent today', `${s.sentToday} / ${s.dailyCap}`],
      ['Suppression list', s.suppressionCount], ['Templates', s.templates],
    ];
    $('#queue-stats').innerHTML = cards.map(([k, v]) =>
      `<div class="stat-card"><div class="stat-num">${esc(v)}</div><div class="stat-label">${esc(k)}</div></div>`).join('');
  }

  async function processQueue() {
    $('#queue-result').textContent = 'Processing…';
    const r = await invoke('outreach:processQueue');
    $('#queue-result').textContent = r.aborted
      ? `Stopped (${r.aborted}): ${r.sent} sent, ${r.failed} failed, ${r.suppressed} suppressed.`
      : `Done: ${r.sent} sent, ${r.failed} failed, ${r.suppressed} suppressed.`;
    loadQueueStats(); loadCampaigns();
  }

  /* ---------------- Compliance ---------------- */

  async function loadSuppressions() {
    const rows = await invoke('suppression:list');
    $('#suppression-table tbody').innerHTML = rows.map((s) => `
      <tr><td>${esc(s.email)}</td><td>${esc(s.reason)}</td><td>${esc(s.created_at || '')}</td>
      <td><button class="btn small" data-unsup="${s.id}">Remove</button></td></tr>`
    ).join('') || '<tr><td colspan="4" class="muted">Suppression list is empty.</td></tr>';
    $$('#suppression-table [data-unsup]').forEach((b) => b.onclick = async () => {
      if (!confirm('Remove this address from the suppression list? It may receive emails again.')) return;
      await invoke('suppression:remove', Number(b.dataset.unsup));
      loadSuppressions();
    });
  }

  async function loadFooter() {
    const settings = await invoke('settings:getAll');
    $('#mail-footer').value = settings['mail.footer'] || '';
  }

  /* ---------------- init ---------------- */

  function init() {
    const root = $('#outreach-root');
    if (!root) return;
    if (root.dataset.wired) return;
    root.dataset.wired = '1';

    $$('.tab', root).forEach((tab) => tab.onclick = () => {
      $$('.tab', root).forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.tab-panel', root).forEach((p) => p.classList.add('hidden'));
      const panel = $('#tab-' + tab.dataset.tab, root);
      panel.classList.remove('hidden');
      if (tab.dataset.tab === 'queue') loadQueueStats();
      if (tab.dataset.tab === 'compliance') { loadSuppressions(); loadFooter(); }
    });

    $('#btn-new-campaign').onclick = startWizard;
    $('#btn-new-template').onclick = () => editTemplate(null);
    $('#btn-process-queue').onclick = processQueue;
    $('#btn-sup-add').onclick = async () => {
      const email = $('#sup-email').value.trim();
      if (!email) { alert('Enter an email address'); return; }
      await invoke('suppression:add', { email, reason: $('#sup-reason').value });
      $('#sup-email').value = '';
      loadSuppressions();
    };
    $('#btn-footer-save').onclick = async () => {
      await invoke('settings:set', { key: 'mail.footer', value: $('#mail-footer').value });
      $('#footer-status').textContent = 'Saved.';
      setTimeout(() => { $('#footer-status').textContent = ''; }, 2000);
    };
    $('#outreach-modal').addEventListener('click', (e) => {
      if (e.target.id === 'outreach-modal') closeModal();
    });

    loadCampaigns();
    loadTemplates();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  // Re-run when the shell re-injects the fragment.
  new MutationObserver(init).observe(document.documentElement, { childList: true, subtree: true });
})();
