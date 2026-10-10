'use strict';

// Settings page controller. All data access goes through window.api.invoke.
// Secrets are only ever sent via settings:setSecret and are never displayed.

const TASKS = ['research', 'generation', 'scoring', 'email', 'qa', 'editor', 'followup', 'image', 'vision'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function $(id) { return document.getElementById(id); }
function msg(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}
function clearMsg(id) { const el = $(id); el.textContent = ''; el.className = 'msg'; }

async function invoke(channel, arg) {
  try {
    return await window.api.invoke(channel, arg);
  } catch (e) {
    throw new Error((e && e.message) || String(e));
  }
}

// -- Load all settings into [data-setting] fields --------------------------------
async function loadSettings() {
  const s = await invoke('settings:getAll');
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.getAttribute('data-setting');
    const v = s[key];
    if (v === undefined || v === null) return;
    if (el.tagName === 'SELECT') {
      el.value = String(v);
    } else {
      el.value = v;
    }
  });
  // Secrets: only show whether one is stored.
  $('ai-key-status').textContent = s['ai.api_key'] === '***'
    ? 'A key is stored (value hidden). Enter a new one to replace it.'
    : 'No API key stored — AI features will use template fallbacks.';
  $('cf-token-status').textContent = s['cf.api_token'] === '***'
    ? 'A token is stored (value hidden). Enter a new one to replace it.'
    : 'No Cloudflare token stored — preview publishing is unavailable.';
  const tavilyStatus = $('tavily-key-status');
  if (tavilyStatus) {
    tavilyStatus.textContent = s['providers.tavily.api_key'] === '***'
      ? 'Tavily key is saved — Discover can use the tavily provider.'
      : 'No Tavily key stored — Discover fails with PROVIDER_NOT_CONFIGURED until you add one.';
  }
  const falStatus = $('fal-key-status');
  if (falStatus) {
    falStatus.textContent = s['fal.api_key'] === '***'
      ? 'fal.ai key is saved — Research can enhance site photos.'
      : 'No fal.ai key stored (FAL_KEY env also works). Site photos stay as-is.';
  }
  const pexelsStatus = $('pexels-key-status');
  if (pexelsStatus) {
    pexelsStatus.textContent = s['pexels.api_key'] === '***'
      ? 'A Pexels key is stored (value hidden). Enter a new one to replace it.'
      : 'No Pexels key stored. Website builds still work; stock photos stay off until you add one.';
  }
  const paused = s['automation_paused'] === '1';
  $('auto-status').textContent = paused ? '⏸ PAUSED' : '▶ RUNNING';
  $('auto-toggle').textContent = paused ? 'Resume automation' : 'Pause automation';
}

// -- AI spend -------------------------------------------------------------------
async function loadSpend() {
  try {
    const u = await invoke('ai:usage', { days: 30 });
    $('spend').textContent =
      `AI spend — today: $${Number(u.todayUsd).toFixed(4)} · this month: $${Number(u.monthUsd).toFixed(4)}`;
  } catch {
    $('spend').textContent = 'AI spend — unavailable';
  }
}

// -- Generic section saver --------------------------------------------------------
function wireSaver(btnId, msgId, scopeEl) {
  $(btnId).addEventListener('click', async () => {
    clearMsg(msgId);
    const fields = (scopeEl || document).querySelectorAll('[data-setting]');
    try {
      for (const el of fields) {
        const key = el.getAttribute('data-setting');
        await invoke('settings:set', { key, value: el.value });
      }
      msg(msgId, 'Saved.', true);
    } catch (e) {
      msg(msgId, e.message, false);
    }
  });
}

// -- Design learning --------------------------------------------------------------
function formatPlaybookText(playbook) {
  if (!Array.isArray(playbook) || !playbook.length) return '';
  return playbook.map((b, i) => {
    const cat = b.category || 'general';
    return `${i + 1}. [${cat}] ${b.lesson || ''}`;
  }).join('\n');
}

async function loadDesignLearning() {
  if (!$('sec-design-learning')) return;
  try {
    const res = await invoke('design:learningPlaybook');
    const status = (res && res.status) || {};
    const playbook = (res && res.playbook) || [];
    const meta = $('design-learning-meta');
    if (meta) {
      const last = status.last_learned_at
        ? new Date(status.last_learned_at).toLocaleString()
        : 'never';
      meta.textContent =
        `Last learned: ${last} · Events: ${status.event_count != null ? status.event_count : '—'}` +
        ` · Email msgs: ${status.email_event_count != null ? status.email_event_count : '—'}` +
        ` · Playbook: ${playbook.length}` +
        (status.enabled === false ? ' · (learning off)' : '');
    }
    const ta = $('design-learning-playbook');
    if (ta) ta.value = formatPlaybookText(playbook);
  } catch (e) {
    const meta = $('design-learning-meta');
    if (meta) meta.textContent = `Learning unavailable: ${e.message || e}`;
  }
}

function wireDesignLearning() {
  if (!$('sec-design-learning')) return;
  if ($('design-learning-save')) {
    wireSaver('design-learning-save', 'design-learning-msg', $('sec-design-learning'));
  }
  const bind = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener('click', fn);
  };
  bind('design-learning-refresh', async () => {
    clearMsg('design-learning-msg');
    try {
      await loadDesignLearning();
      msg('design-learning-msg', 'Refreshed.', true);
    } catch (e) {
      msg('design-learning-msg', e.message, false);
    }
  });
  bind('design-learning-distill', async () => {
    clearMsg('design-learning-msg');
    try {
      const res = await invoke('design:learningDistill', { force: true });
      await loadDesignLearning();
      if (res && res.ok === false) {
        msg('design-learning-msg',
          `Distill: ${res.reason || 'failed'} (heuristic playbook still updates on each review/edit).`,
          res.reason === 'ai_not_configured');
      } else {
        const n = res && res.playbook_count != null
          ? res.playbook_count
          : (res && res.status && res.status.playbook_count);
        msg('design-learning-msg',
          `Distilled${res && res.ai_used ? ' (AI)' : ''} — ${n != null ? n : '?'} lessons.`,
          true);
      }
    } catch (e) {
      msg('design-learning-msg', e.message, false);
    }
  });
  bind('design-learning-clear-playbook', async () => {
    clearMsg('design-learning-msg');
    if (!confirm('Clear the design learning playbook? Raw events are kept.')) return;
    try {
      await invoke('design:learningClear', { what: 'playbook' });
      await loadDesignLearning();
      msg('design-learning-msg', 'Playbook cleared.', true);
    } catch (e) {
      msg('design-learning-msg', e.message, false);
    }
  });
  bind('design-learning-clear-all', async () => {
    clearMsg('design-learning-msg');
    if (!confirm('Clear ALL design learning (playbook + event log)?')) return;
    try {
      await invoke('design:learningClear', { what: 'all' });
      await loadDesignLearning();
      msg('design-learning-msg', 'All learning data cleared.', true);
    } catch (e) {
      msg('design-learning-msg', e.message, false);
    }
  });
}

// -- Model routing table -----------------------------------------------------------
function buildModelTable() {
  const table = $('model-table');
  const mkRow = (label, key) => {
    const tr = document.createElement('tr');
    const tdL = document.createElement('td'); tdL.textContent = label;
    const tdI = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text'; input.setAttribute('data-setting', key);
    input.placeholder = '(default)';
    tdI.appendChild(input);
    tr.appendChild(tdL); tr.appendChild(tdI);
    return tr;
  };
  const defRow = mkRow('Default (all tasks)', 'ai.model.default');
  table.appendChild(defRow);
  for (const t of TASKS) {
    const label = t.charAt(0).toUpperCase() + t.slice(1);
    table.appendChild(mkRow(label, `ai.model.${t}`));
  }
  // The AI section saver covers the whole section, including this table.
}

// -- Secrets -----------------------------------------------------------------------
function wireSecrets() {
  $('ai-key-save').addEventListener('click', async () => {
    clearMsg('ai-key-msg');
    const v = $('ai-key').value;
    if (!v) { msg('ai-key-msg', 'Enter a key first.', false); return; }
    try {
      await invoke('settings:setSecret', { key: 'ai.api_key', value: v });
      $('ai-key').value = '';
      msg('ai-key-msg', 'Key saved (value hidden).', true);
      await loadSettings();
    } catch (e) { msg('ai-key-msg', e.message, false); }
  });
  $('smtp-pass-save').addEventListener('click', async () => {
    clearMsg('smtp-msg');
    const v = $('smtp-pass').value;
    if (!v) { msg('smtp-msg', 'Enter a password first.', false); return; }
    try {
      await invoke('settings:setSecret', { key: 'smtp.pass', value: v });
      $('smtp-pass').value = '';
      msg('smtp-msg', 'Password saved (value hidden).', true);
    } catch (e) { msg('smtp-msg', e.message, false); }
  });
  const tavilySave = $('tavily-key-save');
  if (tavilySave) {
    tavilySave.addEventListener('click', async () => {
      clearMsg('tavily-key-msg');
      const v = $('tavily-key').value;
      if (!v) { msg('tavily-key-msg', 'Enter a key first.', false); return; }
      try {
        await invoke('settings:setSecret', { key: 'providers.tavily.api_key', value: v });
        $('tavily-key').value = '';
        msg('tavily-key-msg', 'Key saved (value hidden).', true);
        await loadSettings();
      } catch (e) { msg('tavily-key-msg', e.message, false); }
    });
  }
  const tavilyDepthSave = $('tavily-depth-save');
  if (tavilyDepthSave) {
    tavilyDepthSave.addEventListener('click', async () => {
      clearMsg('tavily-depth-msg');
      const el = $('tavily-search-depth');
      if (!el) return;
      try {
        await invoke('settings:set', { key: 'providers.tavily.search_depth', value: el.value });
        msg('tavily-depth-msg', 'Search depth saved.', true);
      } catch (e) { msg('tavily-depth-msg', e.message, false); }
    });
  }
}

// -- Prompt library -----------------------------------------------------------------
let promptCache = [];

async function loadPrompts() {
  promptCache = await invoke('prompts:list');
  const sel = $('prompt-select');
  sel.innerHTML = '';
  for (const p of promptCache) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = p.name || p.key;
    sel.appendChild(opt);
  }
  if (promptCache.length) {
    sel.value = promptCache[0].key;
    $('prompt-body').value = promptCache[0].body || '';
  }
}

function wirePrompts() {
  $('prompt-select').addEventListener('change', () => {
    const p = promptCache.find((x) => x.key === $('prompt-select').value);
    $('prompt-body').value = p ? p.body || '' : '';
    clearMsg('prompt-msg');
  });
  $('prompt-save').addEventListener('click', async () => {
    clearMsg('prompt-msg');
    try {
      await invoke('prompts:save', { key: $('prompt-select').value, body: $('prompt-body').value });
      msg('prompt-msg', 'Prompt saved.', true);
      await loadPrompts();
    } catch (e) { msg('prompt-msg', e.message, false); }
  });
  $('prompt-reset').addEventListener('click', async () => {
    if (!confirm('Restore this prompt to its shipped default? Your edits will be lost.')) return;
    clearMsg('prompt-msg');
    try {
      await invoke('prompts:reset', $('prompt-select').value);
      msg('prompt-msg', 'Restored to default.', true);
      await loadPrompts();
    } catch (e) { msg('prompt-msg', e.message, false); }
  });
}

// -- Automation ----------------------------------------------------------------------
function wireAutomation() {
  $('auto-toggle').addEventListener('click', async () => {
    clearMsg('auto-msg');
    try {
      const paused = $('auto-status').textContent.includes('PAUSED');
      await invoke(paused ? 'automation:resume' : 'automation:pause');
      msg('auto-msg', paused ? 'Automation resumed.' : 'Automation paused.', true);
      await loadSettings();
    } catch (e) { msg('auto-msg', e.message, false); }
  });
  $('emergency-stop').addEventListener('click', async () => {
    if (!confirm('EMERGENCY STOP: pause ALL automation now? (scanning, generation, campaigns, follow-ups, scheduled discovery, AI actions)')) return;
    if (!confirm('Confirm again — this halts everything until you resume it.')) return;
    clearMsg('auto-msg');
    try {
      await invoke('automation:pause');
      msg('auto-msg', '⛔ All automation stopped.', true);
      await loadSettings();
    } catch (e) { msg('auto-msg', e.message, false); }
  });
}

// -- Discovery schedule --------------------------------------------------------------
function syncDiscoveryModeFields() {
  const mode = $('disc-mode') && $('disc-mode').value;
  const intervalWrap = $('disc-interval-wrap');
  const dailyWrap = $('disc-daily-wrap');
  if (!intervalWrap || !dailyWrap) return;
  const daily = mode === 'daily';
  intervalWrap.hidden = daily;
  dailyWrap.hidden = !daily;
}

function formatDiscoveryStatus(s) {
  if (!s) return 'Schedule unavailable.';
  const lines = [];
  lines.push(s.enabled ? 'Schedule is ON (runs while the app is open).' : 'Schedule is OFF.');
  if (s.mode === 'daily') {
    lines.push(`Frequency: daily at ${s.daily_time || '09:00'} (local).`);
  } else {
    lines.push(`Frequency: every ${s.interval_hours || 6} hour(s).`);
  }
  const wpLabel = s.websitePresence === 'has' ? 'has website'
    : s.websitePresence === 'no' ? 'no website' : 'any website';
  lines.push(`Query: ${s.category || '?'} · ${s.location || '?'} via ${s.provider || '?'} (limit ${s.limit || 8}, ${wpLabel}).`);
  if (s.next_run) lines.push(`Next run: ${s.next_run}`);
  else if (s.enabled) lines.push('Next run: pending (will be set after save or first tick).');
  if (s.last_run) lines.push(`Last run: ${s.last_run}`);
  if (s.last_status) {
    let status = `Last status: ${s.last_status}`;
    if (s.last_status === 'ok' && s.last_result) {
      try {
        const r = JSON.parse(s.last_result);
        status += ` — created ${r.created}, skipped ${r.skipped}`;
      } catch { /* ignore */ }
    }
    if (s.last_error && s.last_status !== 'ok') status += ` — ${s.last_error}`;
    lines.push(status);
  }
  if (s.running) lines.push('A discovery run is in progress…');
  return lines.join(' ');
}

async function loadDiscoverySchedule() {
  const statusEl = $('disc-status');
  if (!statusEl) return;
  try {
    const res = await invoke('discovery:getSchedule');
    if (res && res.ok === false) throw new Error(res.error || 'Failed to load schedule');
    const s = res || {};
    if ($('disc-enabled')) $('disc-enabled').value = s.enabled ? '1' : '0';
    if ($('disc-mode')) $('disc-mode').value = s.mode === 'daily' ? 'daily' : 'interval';
    if ($('disc-interval')) $('disc-interval').value = String(s.interval_hours || 6);
    if ($('disc-daily')) $('disc-daily').value = s.daily_time || '09:00';
    if ($('disc-category')) $('disc-category').value = s.category || '';
    if ($('disc-location')) $('disc-location').value = s.location || '';
    if ($('disc-limit')) $('disc-limit').value = String(s.limit || 8);
    if ($('disc-group')) $('disc-group').value = s.group || '';
    if ($('disc-score')) $('disc-score').value = s.score === false ? '0' : '1';
    if ($('disc-website')) {
      const wp = s.websitePresence === 'has' || s.websitePresence === 'no' ? s.websitePresence : '';
      $('disc-website').value = wp;
    }
    await fillDiscoveryProviders(s.provider);
    syncDiscoveryModeFields();
    statusEl.textContent = formatDiscoveryStatus(s);
  } catch (e) {
    statusEl.textContent = 'Could not load schedule: ' + e.message;
  }
}

async function fillDiscoveryProviders(selected) {
  const sel = $('disc-provider');
  if (!sel) return;
  try {
    const res = await invoke('providers:list');
    const providers = ((res && res.providers) || []).filter((p) => p.name !== 'csv' && p.name !== 'manual');
    const names = providers.length ? providers : [{ name: 'stub-search', configured: true }];
    const want = selected || sel.value || 'tavily';
    sel.innerHTML = names.map((p) =>
      `<option value="${esc(p.name)}">${esc(p.name)}${p.configured ? '' : ' (not configured)'}</option>`
    ).join('') || '<option value="tavily">tavily</option>';
    if ([...sel.options].some((o) => o.value === want)) sel.value = want;
  } catch {
    sel.innerHTML = '<option value="tavily">tavily</option>';
    if (selected) sel.value = selected;
  }
}

function wireDiscoverySchedule() {
  if (!$('disc-save')) return;
  $('disc-mode').addEventListener('change', syncDiscoveryModeFields);
  $('disc-save').addEventListener('click', async () => {
    clearMsg('disc-msg');
    try {
      const res = await invoke('discovery:setSchedule', {
        enabled: $('disc-enabled').value === '1',
        mode: $('disc-mode').value,
        interval_hours: Number($('disc-interval').value) || 6,
        daily_time: $('disc-daily').value || '09:00',
        provider: $('disc-provider').value,
        category: $('disc-category').value.trim(),
        location: $('disc-location').value.trim(),
        limit: Number($('disc-limit').value) || 8,
        score: $('disc-score').value !== '0',
        group: $('disc-group').value.trim(),
        websitePresence: ($('disc-website') && $('disc-website').value) || '',
      });
      if (res && res.ok === false) throw new Error(res.error || 'Save failed');
      msg('disc-msg', 'Schedule saved.', true);
      $('disc-status').textContent = formatDiscoveryStatus((res && res.schedule) || res);
      await loadDiscoverySchedule();
    } catch (e) { msg('disc-msg', e.message, false); }
  });
  $('disc-run-now').addEventListener('click', async () => {
    clearMsg('disc-msg');
    const btn = $('disc-run-now');
    btn.disabled = true;
    btn.textContent = 'Running…';
    try {
      // Persist current form first so Run now uses what the user sees.
      const saveRes = await invoke('discovery:setSchedule', {
        enabled: $('disc-enabled').value === '1',
        mode: $('disc-mode').value,
        interval_hours: Number($('disc-interval').value) || 6,
        daily_time: $('disc-daily').value || '09:00',
        provider: $('disc-provider').value,
        category: $('disc-category').value.trim(),
        location: $('disc-location').value.trim(),
        limit: Number($('disc-limit').value) || 8,
        score: $('disc-score').value !== '0',
        group: $('disc-group').value.trim(),
        websitePresence: ($('disc-website') && $('disc-website').value) || '',
      });
      if (saveRes && saveRes.ok === false) throw new Error(saveRes.error || 'Save failed');
      const res = await invoke('discovery:runNow');
      if (res && res.ok === false) throw new Error(res.error || 'Run failed');
      const r = res.result || {};
      msg('disc-msg', `Done — created ${r.created || 0}, skipped ${r.skipped || 0}.`, true);
      await loadDiscoverySchedule();
    } catch (e) { msg('disc-msg', e.message, false); }
    finally {
      btn.disabled = false;
      btn.textContent = 'Run now';
    }
  });
}

// -- Cloudflare ----------------------------------------------------------------------
function wireCloudflare() {
  $('cf-token-save').addEventListener('click', async () => {
    clearMsg('cf-msg');
    const v = $('cf-token').value;
    if (!v) { msg('cf-msg', 'Enter a token first.', false); return; }
    try {
      await invoke('settings:setSecret', { key: 'cf.api_token', value: v });
      $('cf-token').value = '';
      msg('cf-msg', 'Token saved (value hidden).', true);
      await loadSettings();
    } catch (e) { msg('cf-msg', e.message, false); }
  });
  $('cf-test').addEventListener('click', async () => {
    clearMsg('cf-msg');
    msg('cf-msg', 'Testing…', true);
    try {
      const res = await invoke('cloudflare:testConnection');
      if (res && res.ok) {
        const n = Array.isArray(res.projects) ? res.projects.length : 0;
        msg('cf-msg', `Connected. ${n} Pages project(s) visible to this token.`, true);
      } else {
        msg('cf-msg', 'Failed: ' + ((res && (res.error || res.hint)) || 'unknown error'), false);
      }
    } catch (e) { msg('cf-msg', 'Failed: ' + e.message, false); }
  });
  const pexelsSave = $('pexels-key-save');
  if (pexelsSave) {
    pexelsSave.addEventListener('click', async () => {
      clearMsg('pexels-key-msg');
      const v = $('pexels-key').value;
      if (!v) { msg('pexels-key-msg', 'Enter a key first.', false); return; }
      try {
        await invoke('settings:setSecret', { key: 'pexels.api_key', value: v });
        $('pexels-key').value = '';
        msg('pexels-key-msg', 'Key saved (value hidden).', true);
        await loadSettings();
      } catch (e) { msg('pexels-key-msg', e.message, false); }
    });
  }
  const falSave = $('fal-key-save');
  if (falSave) {
    falSave.addEventListener('click', async () => {
      clearMsg('fal-key-msg');
      const v = $('fal-key').value;
      if (!v) { msg('fal-key-msg', 'Enter a key first.', false); return; }
      try {
        await invoke('settings:setSecret', { key: 'fal.api_key', value: v });
        $('fal-key').value = '';
        msg('fal-key-msg', 'Key saved (value hidden).', true);
        await loadSettings();
      } catch (e) { msg('fal-key-msg', e.message, false); }
    });
  }
}

// Jump links are #sec-* anchors. Assigning that hash replaces #/settings and the
// router treats it as an unknown route. Scroll in place and leave the route hash alone.
function wireSectionJumps(root) {
  const nav = root.querySelector('.settings-nav');
  if (!nav || nav.dataset.wired) return;
  nav.dataset.wired = '1';
  nav.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link || !nav.contains(link)) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = link.getAttribute('href') || '';
    // #/mcp and other hash routes must still reach the router.
    if (!/^#sec-[A-Za-z0-9-]+$/.test(href)) return;
    event.preventDefault();
    const section = document.getElementById(href.slice(1));
    if (!section || !root.contains(section)) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!section.hasAttribute('tabindex')) section.setAttribute('tabindex', '-1');
    section.focus({ preventScroll: true });
  });
}

// -- Boot ------------------------------------------------------------------------------
function bootSettings() {
  const root = document.querySelector('.settings');
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';
  wireSectionJumps(root);
  buildModelTable();
  wireSaver('ai-save', 'ai-msg', $('sec-ai'));
  wireSaver('cost-save', 'cost-msg', $('sec-cost'));
  wireSaver('smtp-save', 'smtp-msg', $('sec-smtp'));
  wireSaver('cf-save', 'cf-save-msg', $('sec-cloudflare'));
  wireSaver('mail-save', 'mail-msg', $('sec-mail'));
  if ($('design-agent-save') && $('sec-design-agent')) {
    wireSaver('design-agent-save', 'design-agent-msg', $('sec-design-agent'));
  }
  wireDesignLearning();
  wireSecrets();
  wirePrompts();
  wireAutomation();
  wireDiscoverySchedule();
  wireCloudflare();
  loadSettings().catch(() => {});
  loadSpend().catch(() => {});
  loadDiscoverySchedule().catch(() => {});
  loadDesignLearning().catch(() => {});
  loadPrompts().catch((e) => {
    document.querySelector('.settings').insertAdjacentHTML('afterbegin',
      `<div class="msg err">Failed to load settings: ${esc(e.message)}</div>`);
  });
}

// Router convention (renderer/app.js calls window.pageInit after injecting the page).
window.pageInit = bootSettings;
// Standalone fallback (page opened outside the shell router).
document.addEventListener('DOMContentLoaded', bootSettings);
