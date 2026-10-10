'use strict';
/* pipeline.js — companion to pipeline.html. Renders the kanban from pipeline:board.
   Lead cards show intent score/label; a status dropdown moves leads between columns;
   clicking a card opens the lead detail; "+ intent" records a prospect event. */
(function () {
  const api = () => window.api;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function invoke(channel, ...args) {
    try {
      return await api().invoke(channel, ...args);
    } catch (err) {
      alert('Error: ' + (err && err.message ? err.message : err));
      throw err;
    }
  }

  const LEAD_STATUSES = ['new', 'researching', 'qualified', 'building', 'qa_pending', 'ready',
    'outreach_pending', 'contacted', 'engaged', 'claimed', 'trial', 'customer', 'lost'];

  const INTENT_TYPES = [
    'email.opened', 'email.clicked', 'preview.viewed', 'preview.viewed_twice',
    'editor.opened', 'text.changed', 'logo.uploaded', 'site.claimed',
    'pricing.viewed', 'domain.searched', 'domain.purchased', 'trial.activated',
  ];

  function labelClass(label) {
    return 'intent-' + String(label || 'cold').toLowerCase();
  }

  async function loadBoard() {
    const board = await invoke('pipeline:board');
    const host = $('#pipeline-board');
    const total = board.columns.reduce((n, c) => n + c.leads.length, 0);
    $('#pipeline-summary').textContent = `${total} lead(s) across ${board.columns.length} stages`;
    host.innerHTML = board.columns.map((col) => `
      <div class="kanban-col" data-col="${esc(col.key)}">
        <div class="kanban-head">${esc(col.title)} <span class="count">${col.leads.length}</span></div>
        <div class="kanban-cards">
          ${col.leads.map((l) => `
            <div class="lead-card" data-lead="${l.id}">
              <div class="lead-card-title">${esc(l.business_name)}</div>
              <div class="lead-card-sub muted">${esc(l.category || '')}</div>
              <div class="lead-card-meta">
                <span class="pill ${labelClass(l.intent_label)}">${esc(l.intent_label)} · ${l.intent_score}</span>
                ${l.score ? `<span class="muted">q:${l.score}</span>` : ''}
              </div>
              <div class="lead-card-actions">
                <select data-status="${l.id}" title="Move to stage">
                  ${LEAD_STATUSES.map((s) => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${esc(s.replace(/_/g, ' '))}</option>`).join('')}
                </select>
                <button class="btn small" data-intent="${l.id}" title="Record intent event">+ intent</button>
              </div>
            </div>`).join('') || '<div class="muted empty-col">—</div>'}
        </div>
      </div>`).join('');

    $$('.lead-card', host).forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('select') || e.target.closest('button')) return;
        openLead(Number(card.dataset.lead));
      });
    });
    $$('[data-status]', host).forEach((sel) => sel.onchange = async () => {
      await invoke('leads:update', { id: Number(sel.dataset.status), obj: { status: sel.value } });
      loadBoard();
    });
    $$('[data-intent]', host).forEach((b) => b.onclick = () => intentModal(Number(b.dataset.intent)));
  }

  function openLead(id) {
    // Router convention: leads page honours #/leads?id=<id>. Fall back to intent/timeline view.
    try {
      window.location.hash = '#/leads?id=' + id;
    } catch { /* ignore */ }
  }

  async function intentModal(leadId) {
    const current = await invoke('intent:get', leadId).catch(() => ({ score: 0, label: 'Cold' }));
    const box = $('#pipeline-modal-box');
    box.innerHTML = `
      <h3>Record intent event</h3>
      <p class="muted">Current: <b>${esc(current.label)}</b> (${current.score} pts). Tracking is best-effort — events are recorded manually here.</p>
      <label>Event<br/><select id="intent-type" style="width:100%">
        ${INTENT_TYPES.map((t) => `<option value="${t}">${esc(t)}</option>`).join('')}
      </select></label><br/><br/>
      <label>Detail (optional)<br/><input id="intent-detail" style="width:100%" placeholder="e.g. opened pricing page twice" /></label>
      <div class="modal-actions">
        <button class="btn" id="intent-cancel">Cancel</button>
        <button class="btn primary" id="intent-save">Record</button>
      </div>`;
    $('#pipeline-modal').classList.remove('hidden');
    $('#intent-cancel').onclick = () => $('#pipeline-modal').classList.add('hidden');
    $('#intent-save').onclick = async () => {
      const res = await invoke('intent:record', {
        leadId, type: $('#intent-type').value, detail: $('#intent-detail').value.trim(),
      });
      $('#pipeline-modal').classList.add('hidden');
      alert(`Intent recorded. Score: ${res.score} (${res.label})`);
      loadBoard();
    };
  }

  function init() {
    const root = $('#pipeline-root');
    if (!root || root.dataset.wired) return;
    root.dataset.wired = '1';
    $('#pipeline-modal').addEventListener('click', (e) => {
      if (e.target.id === 'pipeline-modal') $('#pipeline-modal').classList.add('hidden');
    });
    loadBoard();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  new MutationObserver(init).observe(document.documentElement, { childList: true, subtree: true });
})();
