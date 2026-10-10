'use strict';
/* Leads inbox page. All data via window.api.invoke(...). User content is
 * escaped before innerHTML. Exposes initLeadsPage(); auto-runs when the
 * fragment is present (works standalone and under the app router). */

function initLeadsPage() {
  const root = document.getElementById('page-leads');
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = '1';

  const api = window.api && window.api.invoke
    ? window.api.invoke.bind(window.api)
    : null;

  /* ---------- helpers ---------- */

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function call(channel, ...args) {
    if (!api) throw new Error('API bridge not available (window.api.invoke missing)');
    const res = await api(channel, ...args);
    if (!res || !res.ok) throw new Error((res && res.error) || 'request failed');
    return res;
  }

  const $ = (id) => document.getElementById(id);
  const tbody = $('leads-tbody');

  const state = {
    q: '', status: '', minScore: '', tag: '', category: '', group: '',
    websitePresence: '',
    view: 'group',
    sort: 'updated', order: 'desc',
    page: 1, pageSize: 25, total: 0,
    selected: new Set(),
    drawerLeadId: null,
    facets: { groups: [], categories: [], tags: [] },
  };

  const STATUSES = ['new', 'researching', 'qualified', 'building', 'qa_pending',
    'ready', 'outreach_pending', 'contacted', 'engaged', 'claimed', 'trial',
    'customer', 'lost'];
  const COLSPAN = 9;

  function fillStatusSelects() {
    for (const id of ['leads-status-filter', 'leads-bulk-status']) {
      const sel = $(id);
      STATUSES.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s.replace(/_/g, ' ');
        sel.appendChild(opt);
      });
    }
  }

  function fillSelectOptions(sel, items, allLabel, valueKey = 'name') {
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">${esc(allLabel)}</option>` +
      (items || []).map((it) => {
        const name = typeof it === 'string' ? it : it[valueKey];
        const count = typeof it === 'object' && it.count != null ? ` (${it.count})` : '';
        return `<option value="${esc(name)}">${esc(name)}${esc(count)}</option>`;
      }).join('');
    if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  }

  function fillDatalist(id, items) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = (items || []).map((it) => {
      const name = typeof it === 'string' ? it : it.name;
      if (!name || name.startsWith('(')) return '';
      return `<option value="${esc(name)}"></option>`;
    }).join('');
  }

  async function loadFacets() {
    try {
      const res = await call('leads:facets');
      state.facets = res.facets || { groups: [], categories: [], tags: [] };
    } catch {
      state.facets = { groups: [], categories: [], tags: [] };
    }
    fillSelectOptions($('leads-group-filter'), state.facets.groups, 'All groups');
    fillSelectOptions($('leads-category-filter'), state.facets.categories, 'All categories');
    fillSelectOptions($('leads-tag-filter'), state.facets.tags, 'All tags');
    fillDatalist('leads-group-suggestions', state.facets.groups);
    fillDatalist('leads-category-suggestions', state.facets.categories);
    fillDatalist('leads-tag-suggestions', state.facets.tags);
    renderFacetChips();
    // restore filter values after rebuild
    if (state.group) $('leads-group-filter').value = state.group;
    if (state.category) $('leads-category-filter').value = state.category;
    if (state.tag) $('leads-tag-filter').value = state.tag;
  }

  function renderFacetChips() {
    const box = $('leads-facet-chips');
    if (!box) return;
    const chips = [];
    for (const g of (state.facets.groups || []).slice(0, 8)) {
      const active = state.group === g.name ? ' active' : '';
      chips.push(`<button type="button" class="facet-chip${active}" data-facet="group" data-value="${esc(g.name)}">${esc(g.name)} <span>${g.count}</span></button>`);
    }
    box.innerHTML = chips.length
      ? `<span class="facet-label">Hunts</span>${chips.join('')}`
      : '<span class="note">No hunt groups yet — Discover or Set group on selected leads.</span>';
  }

  /* ---------- list ---------- */

  async function loadLeads() {
    tbody.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty">Loading…</td></tr>`;
    const filters = {
      q: state.q || undefined,
      status: state.status || undefined,
      minScore: state.minScore === '' ? undefined : Number(state.minScore),
      tag: state.tag || undefined,
      category: state.category || undefined,
      group: state.group || undefined,
      websitePresence: state.websitePresence || undefined,
      view: state.view || 'flat',
      sort: state.sort, order: state.order,
      page: state.page, pageSize: state.pageSize,
    };
    const res = await call('leads:list', filters).catch(err => {
      tbody.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty error">Error: ${esc(err.message)}</td></tr>`;
      throw err;
    });
    state.total = res.total;
    renderRows(res.rows || []);
    renderPagination();
    updateBulkBar();
  }

  function prettyStatus(status) {
    return String(status || '').replace(/_/g, ' ');
  }

  function groupKeyFor(row) {
    if (state.view === 'category') {
      return (row.category && String(row.category).trim()) || '(uncategorized)';
    }
    return (row.lead_group && String(row.lead_group).trim()) || '(ungrouped)';
  }

  function renderTagPills(tags) {
    const list = Array.isArray(tags) ? tags : [];
    if (!list.length) return '—';
    return list.slice(0, 4).map((t) => `<span class="tag-pill">${esc(t)}</span>`).join(' ') +
      (list.length > 4 ? ` <span class="note">+${list.length - 4}</span>` : '');
  }

  function renderLeadRow(r) {
    const checked = state.selected.has(r.id) ? 'checked' : '';
    const qual = r.qualified ? ' <span class="badge badge-qualified">qualified</span>' : '';
    return `<tr data-id="${r.id}">
      <td><input type="checkbox" class="row-check" data-id="${r.id}" ${checked} aria-label="Select lead" /></td>
      <td><button class="link-btn row-open" data-id="${r.id}" type="button">${esc(r.business_name)}</button>${qual}</td>
      <td><button type="button" class="link-btn filter-group" data-group="${esc(r.lead_group || '(ungrouped)')}">${esc(r.lead_group || '—')}</button></td>
      <td><button type="button" class="link-btn filter-category" data-category="${esc(r.category || '(uncategorized)')}">${esc(r.category || '—')}</button></td>
      <td class="tags-cell">${renderTagPills(r.tags)}</td>
      <td><span class="score-pill score-${scoreBand(r.score)}">${esc(r.score)}</span></td>
      <td><span class="badge status-${esc(r.status)}">${esc(prettyStatus(r.status))}</span></td>
      <td>${esc(r.source || '—')}</td>
      <td>${esc((r.updated_at || '').slice(0, 16).replace('T', ' '))}</td>
    </tr>`;
  }

  function renderRows(rows) {
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty">No leads match these filters.</td></tr>`;
      return;
    }
    if (state.view === 'flat') {
      tbody.innerHTML = rows.map(renderLeadRow).join('');
      return;
    }
    const parts = [];
    let lastKey = null;
    let bucket = [];
    const flush = () => {
      if (!bucket.length) return;
      const ids = bucket.map((r) => r.id);
      const allSelected = ids.every((id) => state.selected.has(id));
      parts.push(`<tr class="group-header-row" data-group-key="${esc(lastKey)}">
        <td><input type="checkbox" class="group-check" data-ids="${ids.join(',')}" ${allSelected ? 'checked' : ''} aria-label="Select group" /></td>
        <td colspan="${COLSPAN - 1}"><strong>${esc(lastKey)}</strong> <span class="note">${ids.length} on this page</span>
          <button type="button" class="btn tiny filter-jump" data-filter-key="${esc(lastKey)}">Filter to this</button>
        </td>
      </tr>`);
      parts.push(...bucket.map(renderLeadRow));
      bucket = [];
    };
    for (const r of rows) {
      const key = groupKeyFor(r);
      if (lastKey !== null && key !== lastKey) flush();
      lastKey = key;
      bucket.push(r);
    }
    flush();
    tbody.innerHTML = parts.join('');
  }

  function scoreBand(score) {
    if (score >= 70) return 'hot';
    if (score >= 50) return 'warm';
    if (score > 0) return 'cool';
    return 'none';
  }

  function renderPagination() {
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $('leads-page-info').textContent = `Page ${state.page} of ${pages} (${state.total} leads)`;
    $('leads-prev').disabled = state.page <= 1;
    $('leads-next').disabled = state.page >= pages;
    document.querySelectorAll('#page-leads .sort-btn').forEach(btn => {
      const active = btn.dataset.sort === state.sort;
      btn.classList.toggle('sort-active', active);
      btn.textContent = btn.textContent.replace(/[ ▲▼]/g, '');
      if (active) btn.textContent += state.order === 'asc' ? ' ▲' : ' ▼';
    });
  }

  /* ---------- selection + bulk bar ---------- */

  function updateBulkBar() {
    const n = state.selected.size;
    $('leads-bulk-bar').hidden = n === 0;
    $('leads-selected-count').textContent = `${n} selected`;
  }

  tbody.addEventListener('change', (e) => {
    const cb = e.target.closest('.row-check');
    if (!cb) return;
    const id = Number(cb.dataset.id);
    if (cb.checked) state.selected.add(id); else state.selected.delete(id);
    updateBulkBar();
  });

  $('leads-select-all').addEventListener('change', (e) => {
    const on = e.target.checked;
    tbody.querySelectorAll('.row-check').forEach(cb => {
      cb.checked = on;
      const id = Number(cb.dataset.id);
      if (on) state.selected.add(id); else state.selected.delete(id);
    });
    updateBulkBar();
  });

  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.row-open');
    if (btn) openDrawer(Number(btn.dataset.id));
  });

  async function bulkAction(action, value) {
    const ids = [...state.selected];
    if (!ids.length) return;
    const payload = { action, ids };
    if (value !== undefined) payload.value = value;
    if (action === 'delete' && !confirm(`Delete ${ids.length} lead(s)? This cannot be undone.`)) return;
    const res = await call('leads:bulk', payload).catch(err => alert('Bulk action failed: ' + err.message));
    if (!res) return;
    const b = res.bulk || {};
    state.selected.clear();
    $('leads-select-all').checked = false;
    await loadLeads();
    if (b.failed) alert(`Bulk ${action}: ${b.processed} ok, ${b.failed} failed.`);
  }

  $('leads-bulk-status').addEventListener('change', (e) => {
    if (e.target.value) bulkAction('status', e.target.value);
    e.target.value = '';
  });
  $('leads-bulk-addtag').addEventListener('click', () => {
    const t = $('leads-bulk-tag').value.trim();
    if (!t) { alert('Enter a tag name.'); return; }
    bulkAction('tag', t);
  });
  $('leads-bulk-untag').addEventListener('click', () => {
    const t = $('leads-bulk-tag').value.trim();
    if (!t) { alert('Enter a tag name.'); return; }
    bulkAction('untag', t);
  });
  $('leads-bulk-research').addEventListener('click', () => bulkAction('research'));
  $('leads-bulk-delete').addEventListener('click', () => bulkAction('delete'));
  $('leads-bulk-clear').addEventListener('click', () => {
    state.selected.clear();
    $('leads-select-all').checked = false;
    loadLeads();
  });

  /* ---------- filters / sort / pagination ---------- */

  let searchTimer = null;
  $('leads-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      state.page = 1;
      loadLeads();
    }, 300);
  });

  function applyFilters() {
    state.status = $('leads-status-filter').value;
    state.minScore = $('leads-minscore').value;
    state.tag = $('leads-tag-filter').value.trim();
    state.websitePresence = ($('leads-website-filter') && $('leads-website-filter').value) || '';
    state.page = 1;
    loadLeads();
  }
  $('leads-filter-btn').addEventListener('click', applyFilters);
  $('leads-clear-btn').addEventListener('click', () => {
    $('leads-search').value = '';
    $('leads-status-filter').value = '';
    $('leads-minscore').value = '';
    $('leads-tag-filter').value = '';
    if ($('leads-website-filter')) $('leads-website-filter').value = '';
    Object.assign(state, { q: '', status: '', minScore: '', tag: '', websitePresence: '', page: 1 });
    loadLeads();
  });

  document.querySelectorAll('#page-leads .sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      if (state.sort === key) {
        state.order = state.order === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort = key;
        state.order = key === 'name' ? 'asc' : 'desc';
      }
      state.page = 1;
      loadLeads();
    });
  });

  $('leads-prev').addEventListener('click', () => {
    if (state.page > 1) { state.page--; loadLeads(); }
  });
  $('leads-next').addEventListener('click', () => {
    state.page++; loadLeads();
  });
  $('leads-pagesize').addEventListener('change', (e) => {
    state.pageSize = Number(e.target.value);
    state.page = 1;
    loadLeads();
  });

  /* ---------- modals ---------- */

  function openModal(id) { $(id).hidden = false; }
  function closeModals() {
    document.querySelectorAll('#page-leads .modal').forEach(m => { m.hidden = true; });
  }
  document.querySelectorAll('#page-leads .modal-close').forEach(btn => {
    btn.addEventListener('click', closeModals);
  });
  document.querySelectorAll('#page-leads .modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m) closeModals(); });
  });

  $('leads-add-btn').addEventListener('click', () => {
    $('leads-add-error').hidden = true;
    openModal('leads-add-modal');
  });

  $('leads-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errBox = $('leads-add-error');
    errBox.hidden = true;
    const fd = new FormData(form);
    const obj = {};
    for (const [k, v] of fd.entries()) {
      const t = String(v).trim();
      if (t !== '') obj[k] = t;
    }
    if (!obj.business_name) {
      errBox.textContent = 'Business name is required.';
      errBox.hidden = false;
      return;
    }
    if (obj.rating !== undefined) obj.rating = Number(obj.rating);
    if (obj.review_count !== undefined) obj.review_count = parseInt(obj.review_count, 10);
    if (obj.tags) obj.tags = obj.tags.split(',').map(t => t.trim()).filter(Boolean);
    try {
      await call('leads:create', obj);
      form.reset();
      closeModals();
      state.page = 1;
      await loadLeads();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  async function fillDiscoverProviders() {
    const sel = $('leads-discover-provider');
    if (!sel) return;
    try {
      const res = await call('providers:list');
      const providers = (res.providers || []).filter((p) => p.name !== 'csv' && p.name !== 'manual');
      const preferred = providers.find((p) => p.configured) || providers[0];
      sel.innerHTML = providers.map((p) =>
        `<option value="${esc(p.name)}" ${preferred && p.name === preferred.name ? 'selected' : ''}>${esc(p.name)}${p.configured ? '' : ' (not configured)'}</option>`
      ).join('') || '<option value="" disabled selected>No discovery providers</option>';
    } catch {
      sel.innerHTML = '<option value="tavily">tavily (not configured)</option>';
    }
  }

  $('leads-discover-btn').addEventListener('click', async () => {
    $('leads-discover-error').hidden = true;
    $('leads-discover-result').hidden = true;
    await fillDiscoverProviders();
    if (!$('leads-discover-category').value) $('leads-discover-category').value = 'Plumber';
    if (!$('leads-discover-location').value) $('leads-discover-location').value = 'Springfield';
    openModal('leads-discover-modal');
  });

  $('leads-discover-submit').addEventListener('click', async () => {
    const errBox = $('leads-discover-error');
    const resBox = $('leads-discover-result');
    errBox.hidden = true;
    resBox.hidden = true;
    const category = $('leads-discover-category').value.trim();
    const location = $('leads-discover-location').value.trim();
    if (!category || !location) {
      errBox.textContent = 'Category and location are required.';
      errBox.hidden = false;
      return;
    }
    const btn = $('leads-discover-submit');
    btn.disabled = true;
    btn.textContent = 'Discovering…';
    try {
      const websitePresence = ($('leads-discover-website') && $('leads-discover-website').value) || '';
      const res = await call('leads:discover', {
        provider: $('leads-discover-provider').value,
        category,
        location,
        group: ($('leads-discover-group') && $('leads-discover-group').value.trim()) || undefined,
        limit: Number($('leads-discover-limit').value) || 8,
        score: $('leads-discover-score').checked,
        websitePresence: websitePresence || undefined,
      });
      const names = (res.leads || []).slice(0, 8).map((l) =>
        `#${l.id} ${esc(l.business_name)}${l.score != null ? ` (score ${l.score})` : ''}`
      ).join('<br>');
      resBox.innerHTML =
        `Provider <b>${esc(res.provider)}</b>: created <b>${res.created}</b>, skipped <b>${res.skipped}</b>, scored <b>${res.scored}</b>` +
        (res.queried != null ? `, queried <b>${res.queried}</b>` : '') +
        '.' +
        (res.warning ? `<br><span class="note">${esc(res.warning)}</span>` : '') +
        (names ? `<br><span class="note">${names}</span>` : '');
      resBox.hidden = false;
      state.page = 1;
      await loadLeads();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run discovery';
    }
  });

  $('leads-import-btn').addEventListener('click', () => {
    $('leads-import-error').hidden = true;
    $('leads-import-result').hidden = true;
    openModal('leads-import-modal');
  });

  $('leads-csv-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { $('leads-csv-text').value = String(reader.result || ''); };
    reader.onerror = () => alert('Could not read file.');
    reader.readAsText(f);
  });

  $('leads-import-submit').addEventListener('click', async () => {
    const text = $('leads-csv-text').value;
    const errBox = $('leads-import-error');
    const resBox = $('leads-import-result');
    errBox.hidden = true; resBox.hidden = true;
    if (!text.trim()) {
      errBox.textContent = 'Paste CSV text or choose a file first.';
      errBox.hidden = false;
      return;
    }
    const btn = $('leads-import-submit');
    btn.disabled = true;
    try {
      const res = await call('leads:importCsv', text);
      const r = res.result || {};
      const errLines = (r.errors || []).slice(0, 10)
        .map(x => `line ${x.line}: ${esc(x.error)}`).join('<br>');
      resBox.innerHTML = `Imported <b>${r.created}</b>, skipped <b>${r.skipped}</b>.` +
        (errLines ? `<br><span class="note">${errLines}</span>` : '');
      resBox.hidden = false;
      state.page = 1;
      await loadLeads();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- detail drawer ---------- */

  const CLAIM_BADGE = {
    VERIFIED: 'badge-verified',
    AI_COPY: 'badge-aicopy',
    OWNER_PROVIDED: 'badge-owner',
    UNKNOWN: 'badge-unknown',
  };

  async function openDrawer(id) {
    state.drawerLeadId = id;
    $('leads-drawer').hidden = false;
    $('leads-drawer-body').innerHTML = '<p class="note">Loading…</p>';
    $('leads-drawer-merge-list').hidden = true;
    try {
      const [leadRes, factsRes, eventsRes] = await Promise.all([
        call('leads:get', id),
        call('leads:facts', id),
        call('leads:events', id),
      ]);
      renderDrawer(leadRes.lead, leadRes.scoreBreakdown, factsRes.facts || [], eventsRes.events || []);
    } catch (err) {
      $('leads-drawer-body').innerHTML = `<p class="error">Error: ${esc(err.message)}</p>`;
    }
  }

  function closeDrawer() {
    $('leads-drawer').hidden = true;
    state.drawerLeadId = null;
  }
  $('leads-drawer-close').addEventListener('click', closeDrawer);

  function renderDrawer(lead, scoreBreakdown, facts, events) {
    $('leads-drawer-title').textContent = lead.business_name;
    const contactRows = [
      ['Category', lead.category], ['Phone', lead.phone], ['Email', lead.email],
      ['Website', lead.website], ['Address', [lead.address, lead.city, lead.state, lead.postal_code].filter(Boolean).join(', ')],
      ['Rating', lead.rating != null ? `${lead.rating} (${lead.review_count || 0} reviews)` : ''],
      ['Status', lead.status], ['Score', lead.score],
      ['Qualified', lead.qualified ? 'Yes' : 'No'],
      ['Source', lead.source], ['Tags', (lead.tags || []).join(', ')],
    ].filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => `<div class="fact-row"><span class="fact-key">${esc(k)}</span><span>${esc(v)}</span></div>`)
      .join('');

    const factsHtml = facts.length ? facts.map(f => `
      <div class="fact-row fact-card">
        <span class="fact-key">${esc(f.fact_key)}</span>
        <span class="fact-val">${esc(f.value)}</span>
        <span class="badge ${CLAIM_BADGE[f.claim_class] || ''}">${esc(f.claim_class)}</span>
        <div class="provenance">source: ${esc(f.source)}${f.source_url ? ` · <a href="${esc(f.source_url)}" target="_blank" rel="noopener">link</a>` : ''} · confidence: ${esc(f.confidence)} · ${esc((f.fetched_at || '').slice(0, 16).replace('T', ' '))}</div>
      </div>`).join('')
      : '<p class="note">No researched facts yet. Run Research.</p>';

    const breakdownHtml = scoreBreakdown && scoreBreakdown.breakdown
      ? Object.entries(scoreBreakdown.breakdown)
        .map(([k, v]) => `<div class="fact-row"><span class="fact-key">${esc(k)}</span><span>+${esc(v)}</span></div>`).join('') +
        `<div class="fact-row total"><span class="fact-key">Total</span><span>${esc(scoreBreakdown.score)}</span></div>`
      : '<p class="note">Not scored yet. Click Score.</p>';

    const eventsHtml = events.length ? events.map(ev => `
      <div class="event-row">
        <span class="event-type">${esc(ev.type)}</span>
        <span class="event-at">${esc((ev.at || '').slice(0, 16).replace('T', ' '))}</span>
        <div class="event-detail">${esc(ev.detail || '')}</div>
      </div>`).join('')
      : '<p class="note">No events yet.</p>';

    const notesHtml = lead.qualification_note
      ? `<p class="note">${esc(lead.qualification_note)}</p>` : '';
    const descHtml = lead.description ? `<p>${esc(lead.description)}</p>` : '';

    $('leads-drawer-body').innerHTML = `
      <section><h3>Details</h3>${contactRows}${descHtml}${notesHtml}</section>
      <section><h3>Score breakdown</h3>${breakdownHtml}</section>
      <section><h3>Facts &amp; provenance (${facts.length})</h3>${factsHtml}</section>
      <section><h3>Events</h3><div class="timeline">${eventsHtml}</div></section>`;
  }

  async function refreshDrawer() {
    if (state.drawerLeadId) await openDrawer(state.drawerLeadId);
  }

  $('leads-drawer-score').addEventListener('click', async () => {
    if (!state.drawerLeadId) return;
    try {
      const res = await call('leads:score', state.drawerLeadId);
      alert(`Score: ${res.result.score}`);
      await Promise.all([refreshDrawer(), loadLeads()]);
    } catch (err) { alert('Scoring failed: ' + err.message); }
  });

  $('leads-drawer-qualify').addEventListener('click', async () => {
    if (!state.drawerLeadId) return;
    try {
      const res = await call('leads:qualify', state.drawerLeadId);
      const q = res.result;
      alert(q.qualified ? 'QUALIFIED' : 'Not qualified — see qualification note.');
      await Promise.all([refreshDrawer(), loadLeads()]);
    } catch (err) { alert('Qualification failed: ' + err.message); }
  });

  $('leads-drawer-research').addEventListener('click', async () => {
    if (!state.drawerLeadId) return;
    const btn = $('leads-drawer-research');
    btn.disabled = true;
    try {
      const res = await call('leads:research', state.drawerLeadId);
      alert(`Research complete: ${res.result.facts} facts stored via ${res.result.provider}.`);
      await Promise.all([refreshDrawer(), loadLeads()]);
    } catch (err) { alert('Research failed: ' + err.message); }
    finally { btn.disabled = false; }
  });

  $('leads-drawer-merge').addEventListener('click', async () => {
    if (!state.drawerLeadId) return;
    const box = $('leads-drawer-merge-list');
    box.hidden = false;
    box.innerHTML = '<p class="note">Checking for duplicates…</p>';
    try {
      const res = await call('leads:duplicates', state.drawerLeadId);
      const dups = res.duplicates || [];
      if (!dups.length) {
        box.innerHTML = '<p class="note">No duplicate candidates found.</p>';
        return;
      }
      box.innerHTML = `<h4>Merge into this lead (keeps this record):</h4>` + dups.map(d => `
        <label class="merge-row">
          <input type="checkbox" class="merge-check" value="${d.id}" />
          <span><b>${esc(d.business_name)}</b> (#${d.id}) — matched on ${esc(d.matched_on.join(', '))}</span>
        </label>`).join('') +
        `<button id="leads-merge-confirm" type="button" class="btn danger">Merge selected</button>`;
      $('leads-merge-confirm').addEventListener('click', async () => {
        const dropIds = [...box.querySelectorAll('.merge-check:checked')].map(c => Number(c.value));
        if (!dropIds.length) { alert('Select at least one duplicate.'); return; }
        if (!confirm(`Merge ${dropIds.length} lead(s) into #${state.drawerLeadId}? The merged records will be deleted.`)) return;
        try {
          await call('leads:merge', { keepId: state.drawerLeadId, dropIds });
          box.hidden = true;
          await Promise.all([refreshDrawer(), loadLeads()]);
        } catch (err) { alert('Merge failed: ' + err.message); }
      });
    } catch (err) {
      box.innerHTML = `<p class="error">Error: ${esc(err.message)}</p>`;
    }
  });

  /* ---------- init ---------- */

  fillStatusSelects();
  const hashLead = (window.location.hash.match(/[?&]id=(\d+)/) || [])[1];
  loadLeads()
    .then(() => { if (hashLead) openDrawer(Number(hashLead)); })
    .catch(() => { /* error already rendered */ });
}

window.initLeadsPage = initLeadsPage;

// Router convention (renderer/app.js calls window.pageInit after injecting the page).
window.pageInit = function () { initLeadsPage(); };

// Standalone fallback (page opened outside the shell router).
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (document.getElementById('page-leads')) initLeadsPage();
    });
  } else if (document.getElementById('page-leads') && !document.getElementById('view')) {
    initLeadsPage();
  }
}
