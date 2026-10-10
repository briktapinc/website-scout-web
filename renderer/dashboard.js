'use strict';

// Dashboard page. Loads stat cards from dashboard:stats, recent activity,
// AI cost figures, and automation pause state. All DOM is built with
// textContent — no unescaped innerHTML.

function escMoney(v) {
  const n = Number(v);
  return '$' + (Number.isFinite(n) ? n.toFixed(2) : '0.00');
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function confirmModal({ title, message, confirmLabel }) {
  return new Promise((resolve) => {
    const backdrop = el('div', null, 'modal-backdrop');
    const modal = el('div', null, 'modal');
    modal.appendChild(el('h2', title));
    modal.appendChild(el('p', message));
    const actions = el('div', null, 'modal-actions');
    const cancel = el('button', 'Cancel', 'btn');
    const ok = el('button', confirmLabel, 'btn danger');
    actions.append(cancel, ok);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const done = (val) => {
      backdrop.remove();
      resolve(val);
    };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) done(false);
    });
  });
}

async function refresh(view) {
  const stats = await window.api.invoke('dashboard:stats');
  view.querySelector('#stat-leads').textContent = stats.leadsTotal;
  view.querySelector('#stat-qualified').textContent = stats.qualified;
  view.querySelector('#stat-websites').textContent = stats.websitesGenerated;
  view.querySelector('#stat-emails').textContent = stats.emailsSent;
  view.querySelector('#stat-hot').textContent = stats.hotLeads;
  view.querySelector('#stat-cost-today').textContent = escMoney(stats.aiCostToday);
  view.querySelector('#stat-cost-month').textContent = escMoney(stats.aiCostMonth);
  const autoEl = view.querySelector('#stat-automation');
  autoEl.textContent = stats.automationPaused ? 'Paused' : 'Running';
  const autoCard = autoEl.closest('.stat-card');
  if (autoCard) {
    autoCard.classList.toggle('is-paused', !!stats.automationPaused);
    autoCard.classList.toggle('is-running', !stats.automationPaused);
  }
  if (typeof window.refreshShellStatus === 'function') window.refreshShellStatus();

  const banner = view.querySelector('#automation-banner');
  banner.style.display = stats.automationPaused ? '' : 'none';
  const pauseBtn = view.querySelector('#pause-btn');
  const resumeBtns = [view.querySelector('#resume-btn'), view.querySelector('#resume-btn-2')];
  pauseBtn.disabled = stats.automationPaused;
  resumeBtns.forEach((b) => { b.disabled = !stats.automationPaused; });
  view.querySelector('#automation-status').textContent = stats.automationPaused
    ? 'Automation is paused. Background AI work and outreach will not run.'
    : 'Automation is running.';

  const activityRes = await window.api.invoke('activity:recent', { limit: 15 });
  const activity = Array.isArray(activityRes)
    ? activityRes
    : ((activityRes && activityRes.rows) || []);
  const list = view.querySelector('#activity-list');
  list.innerHTML = '';
  if (activity.length === 0) {
    list.appendChild(el('li', 'No activity yet.', 'muted'));
  } else {
    for (const row of activity) {
      const li = el('li');
      const msg = el('span', String(row.message));
      const meta = el('div', null, 'timestamp');
      meta.textContent = String(row.area) + ' · ' + String(row.at);
      li.append(msg, meta);
      list.appendChild(li);
    }
  }
}

window.pageInit = async function init(view) {
  await refresh(view);

  view.querySelector('#pause-btn').addEventListener('click', async () => {
    await window.api.invoke('automation:pause');
    await refresh(view);
  });

  const resume = async () => {
    await window.api.invoke('automation:resume');
    await refresh(view);
  };
  view.querySelector('#resume-btn').addEventListener('click', resume);
  view.querySelector('#resume-btn-2').addEventListener('click', resume);

  view.querySelector('#emergency-stop').addEventListener('click', async () => {
    const confirmed = await confirmModal({
      title: 'Emergency stop',
      message: 'This immediately pauses ALL automation: discovery, research, scoring, website generation, and outreach. Are you sure?',
      confirmLabel: 'Stop everything',
    });
    if (confirmed) {
      await window.api.invoke('automation:pause');
      await refresh(view);
    }
  });
};
