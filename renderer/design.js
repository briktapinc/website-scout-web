(function () {
  'use strict';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function api(channel, arg) {
    if (!window.api || typeof window.api.invoke !== 'function') {
      return Promise.reject(new Error('window.api.invoke is not available'));
    }
    return window.api.invoke(channel, arg);
  }
  function $(id) { return document.getElementById(id); }

  const LOCKED = /(^|\.)(phone|phone_display|email|address|address_lines|hours|rating|review_count|business_name|href|cta_href|button_href|url|photographer|photographer_url|pexels_url)$/;
  const SUGGESTED_TYPES = ['website', 'logo', 'social', 'flyer', 'brand', 'other'];
  const S = {
    job: null,
    pexels: false,
    aiKey: false,
    imageModel: 'gpt-image-1',
    assetBase: '',
    leadPick: null,
    leadTimer: null,
    kinds: ['website'],
    defaultWebsiteInstructions: '',
    instructionsTouched: false,
  };

  function secretIsSet(bag, key) {
    const v = bag && bag[key];
    if (v === '***') return true;
    if (typeof v === 'string' && v.trim() && v !== '0') return true;
    return false;
  }

  async function refreshAiStatus() {
    try {
      const st = await api('ai:status');
      if (st && st.ok !== false && typeof st.configured === 'boolean') {
        S.aiKey = !!st.configured;
        if (st.modelImage) S.imageModel = st.modelImage;
        return S.aiKey;
      }
    } catch { /* fall through */ }
    try {
      const settings = await api('settings:getAll');
      const bag = (settings && settings.settings && typeof settings.settings === 'object')
        ? settings.settings
        : (settings || {});
      S.aiKey = secretIsSet(bag, 'ai.api_key');
      S.imageModel = bag['ai.model.image'] || S.imageModel || 'gpt-image-1';
    } catch {
      S.aiKey = false;
    }
    return S.aiKey;
  }

  function normalizeKind(raw) {
    return String(raw || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
  }

  function renderKindToggles() {
    const box = $('dj-kind-toggles');
    if (!box) return;
    box.innerHTML = SUGGESTED_TYPES.map((k) => {
      const on = S.kinds.includes(k);
      return `<button type="button" class="kind-toggle" data-kind="${esc(k)}" aria-pressed="${on ? 'true' : 'false'}">${esc(k)}</button>`;
    }).join('');
    box.querySelectorAll('.kind-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind;
        const idx = S.kinds.indexOf(kind);
        if (idx >= 0) S.kinds.splice(idx, 1);
        else S.kinds.push(kind);
        renderKindsUI();
      });
    });
  }

  function renderKindPriority() {
    const list = $('dj-kind-priority');
    if (!list) return;
    if (!S.kinds.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = S.kinds.map((k, i) => `<li data-kind="${esc(k)}">
      <span class="kp-rank">${i + 1}</span>
      <span class="kp-name">${esc(k)}</span>
      <span class="kp-actions">
        <button type="button" class="btn small kp-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button type="button" class="btn small kp-down" data-i="${i}" ${i === S.kinds.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button type="button" class="btn small kp-remove" data-i="${i}" aria-label="Remove">×</button>
      </span>
    </li>`).join('');
    list.querySelectorAll('.kp-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        if (i < 1) return;
        const tmp = S.kinds[i - 1];
        S.kinds[i - 1] = S.kinds[i];
        S.kinds[i] = tmp;
        renderKindsUI();
      });
    });
    list.querySelectorAll('.kp-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        if (i >= S.kinds.length - 1) return;
        const tmp = S.kinds[i + 1];
        S.kinds[i + 1] = S.kinds[i];
        S.kinds[i] = tmp;
        renderKindsUI();
      });
    });
    list.querySelectorAll('.kp-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        S.kinds.splice(i, 1);
        renderKindsUI();
      });
    });
  }

  function instructionsEl() {
    return $('dj-instructions');
  }

  function isDefaultWebsiteInstructions(text) {
    const def = S.defaultWebsiteInstructions;
    if (!def) return false;
    return String(text || '').trim() === def.trim();
  }

  function syncInstructionsForKinds() {
    const el = instructionsEl();
    if (!el || !S.defaultWebsiteInstructions) return;
    const hasWebsite = S.kinds.includes('website');
    const cur = el.value;
    const empty = !String(cur).trim();
    const isDefault = isDefaultWebsiteInstructions(cur);
    if (hasWebsite && (empty || isDefault) && !S.instructionsTouched) {
      el.value = S.defaultWebsiteInstructions;
      el.placeholder = 'Edit these instructions for this job, or leave the default.';
    } else if (!hasWebsite && isDefault) {
      el.value = '';
      el.placeholder = 'Describe the work — layout, style, deliverable. Ask only if needed.';
      S.instructionsTouched = false;
    } else if (!hasWebsite && empty) {
      el.placeholder = 'Describe the work — layout, style, deliverable. Ask only if needed.';
    }
  }

  function wireInstructionsField() {
    const el = instructionsEl();
    if (!el) return;
    el.addEventListener('input', () => {
      S.instructionsTouched = !isDefaultWebsiteInstructions(el.value) && !!String(el.value).trim();
    });
  }

  async function loadDefaultInstructions() {
    try {
      const res = await api('design:defaultInstructions');
      if (res && res.ok && res.website) {
        S.defaultWebsiteInstructions = String(res.website);
      }
    } catch { /* keep empty; user can type */ }
    syncInstructionsForKinds();
  }

  function renderKindsUI() {
    renderKindToggles();
    renderKindPriority();
    syncShapeFieldVisibility();
    syncInstructionsForKinds();
  }

  function addCustomKind() {
    const input = $('dj-type-custom');
    if (!input) return;
    const kind = normalizeKind(input.value);
    if (!kind) return;
    if (!S.kinds.includes(kind)) S.kinds.push(kind);
    input.value = '';
    renderKindsUI();
  }

  function wireKindPicker() {
    renderKindsUI();
    const addBtn = $('dj-kind-add');
    if (addBtn) addBtn.addEventListener('click', addCustomKind);
    const input = $('dj-type-custom');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addCustomKind();
        }
      });
    }
  }

  function setPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
      if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      cur = cur[key];
    }
    const last = parts[parts.length - 1];
    cur[/^\d+$/.test(last) ? Number(last) : last] = value;
  }

  async function loadList() {
    const body = $('dj-body');
    body.innerHTML = '<tr><td colspan="6" class="hint">Loading…</td></tr>';
    try {
      const res = await api('design:list', {});
      if (!res.ok) throw new Error(res.error || 'failed');
      const jobs = res.jobs || [];
      if (!jobs.length) {
        body.innerHTML = '<tr><td colspan="6" class="hint">No design jobs yet.</td></tr>';
        return;
      }
      body.innerHTML = jobs.map((j) => {
        const briefLead = j.brief && j.brief.lead;
        const leadBit = briefLead
          ? `<div class="hint">${esc(briefLead.business_name || '')}${briefLead.city ? ` · ${esc(briefLead.city)}` : ''}</div>`
          : (j.lead_id ? `<div class="hint">Lead #${esc(j.lead_id)}</div>` : '');
        return `<tr class="clickable" data-id="${j.id}">
        <td><strong>${esc(j.title)}</strong>${leadBit}</td>
        <td>${esc(j.type)}</td>
        <td><span class="badge">${esc(j.status)}</span></td>
        <td>${esc(String(j.pending_questions || 0))} open</td>
        <td class="hint">${esc(j.updated_at || '')}</td>
        <td><button type="button" class="btn danger dj-delete" data-id="${j.id}">Delete</button></td>
      </tr>`;
      }).join('');
      body.querySelectorAll('tr.clickable').forEach((tr) => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('.dj-delete')) return;
          openJob(Number(tr.dataset.id));
        });
      });
      body.querySelectorAll('.dj-delete').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = Number(btn.dataset.id);
          const job = jobs.find((x) => x.id === id);
          const title = (job && job.title) || `Job #${id}`;
          if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
          const res = await api('design:delete', id);
          if (!res.ok) {
            const msg = $('dj-create-msg');
            if (msg) msg.textContent = res.error || 'Delete failed.';
            return;
          }
          if (S.job && S.job.id === id) showList();
          else loadList();
        });
      });
    } catch (e) {
      body.innerHTML = `<tr><td colspan="6" class="hint">${esc(e.message)}</td></tr>`;
    }
  }

  function showList() {
    $('dj-list').hidden = false;
    $('dj-detail').hidden = true;
    S.job = null;
    loadList();
  }

  function leadLabel(lead) {
    if (!lead) return '';
    const bits = [lead.business_name || `Lead #${lead.id}`];
    const place = [lead.city, lead.state].filter(Boolean).join(', ');
    if (place) bits.push(place);
    if (lead.category) bits.push(lead.category);
    if (lead.lead_group) bits.push(lead.lead_group);
    return bits.join(' · ');
  }

  function setSelectedLead(lead) {
    S.leadPick = lead || null;
    const hidden = $('dj-lead');
    const sel = $('dj-lead-selected');
    const search = $('dj-lead-search');
    const results = $('dj-lead-results');
    if (hidden) hidden.value = lead ? String(lead.id) : '';
    if (results) { results.hidden = true; results.innerHTML = ''; }
    if (!sel) return;
    if (!lead) {
      sel.hidden = true;
      sel.innerHTML = '';
      return;
    }
    sel.hidden = false;
    sel.innerHTML = `<div><strong>${esc(lead.business_name || 'Lead')}</strong>
      <div class="hint">#${lead.id}${lead.category ? ` · ${esc(lead.category)}` : ''}${lead.city ? ` · ${esc(lead.city)}` : ''}${lead.lead_group ? ` · ${esc(lead.lead_group)}` : ''}</div></div>
      <button type="button" class="btn lp-clear" id="dj-lead-clear">Clear</button>`;
    const clear = $('dj-lead-clear');
    if (clear) clear.onclick = () => { setSelectedLead(null); if (search) search.value = ''; search && search.focus(); };
    if (search) search.value = '';
  }

  async function searchLeads(q) {
    const results = $('dj-lead-results');
    if (!results) return;
    const query = String(q || '').trim();
    results.hidden = false;
    results.innerHTML = '<li><span class="hint" style="display:block;padding:10px">Searching…</span></li>';
    try {
      const res = await api('leads:list', {
        q: query || undefined,
        page: 1,
        pageSize: 12,
        sort: 'updated',
        order: 'desc',
        view: 'flat',
      });
      if (!res.ok) throw new Error(res.error || 'search failed');
      const rows = res.rows || [];
      if (!rows.length) {
        results.innerHTML = '<li><span class="hint" style="display:block;padding:10px">No leads match.</span></li>';
        return;
      }
      results.innerHTML = rows.map((r) => {
        const meta = [
          r.category || '',
          [r.city, r.state].filter(Boolean).join(', '),
          r.lead_group || '',
          r.score != null ? `score ${r.score}` : '',
        ].filter(Boolean).join(' · ');
        return `<li><button type="button" data-lead-id="${r.id}">
          <span class="lp-name">${esc(r.business_name || 'Untitled')}</span>
          <span class="lp-meta">#${r.id}${meta ? ` · ${esc(meta)}` : ''}</span>
        </button></li>`;
      }).join('');
      results.querySelectorAll('[data-lead-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = Number(btn.dataset.leadId);
          const lead = rows.find((x) => x.id === id);
          setSelectedLead(lead || { id, business_name: btn.querySelector('.lp-name')?.textContent });
        });
      });
    } catch (e) {
      results.innerHTML = `<li><span class="hint" style="display:block;padding:10px">${esc(e.message)}</span></li>`;
    }
  }

  function wireLeadPicker() {
    const search = $('dj-lead-search');
    const results = $('dj-lead-results');
    if (!search || !results) return;
    search.addEventListener('focus', () => {
      if (!S.leadPick) searchLeads(search.value);
    });
    search.addEventListener('input', () => {
      clearTimeout(S.leadTimer);
      S.leadTimer = setTimeout(() => searchLeads(search.value), 220);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        results.hidden = true;
        search.blur();
      }
    });
    document.addEventListener('click', (e) => {
      const root = $('dj-lead-picker');
      if (root && !root.contains(e.target)) results.hidden = true;
    });
  }

  function siteShapeLabel(shape) {
    if (shape === 'landing') return 'Landing page';
    if (shape === 'multipage') return 'Multi-page site';
    return shape || 'Multi-page site';
  }

  function syncShapeFieldVisibility() {
    const field = $('dj-shape-field');
    if (field) field.hidden = !S.kinds.includes('website');
  }

  function titleForKind(baseTitle, type, multi) {
    if (baseTitle) return multi ? `${baseTitle} (${type})` : baseTitle;
    if (S.leadPick && S.leadPick.business_name) return `${S.leadPick.business_name} ${type}`;
    return type;
  }

  function renderBrief(job) {
    const b = job.brief || {};
    const shape = job.site_shape || (b && b.site_shape) || 'multipage';
    const shapeHtml = job.type === 'website'
      ? `<p><strong>Site shape</strong> ${esc(siteShapeLabel(shape))} <span class="mono">(${esc(shape)})</span></p>`
      : '';
    const lead = b.lead || null;
    const leadHtml = lead
      ? `<p><strong>Lead</strong><br>${esc(leadLabel(lead))} <span class="hint">#${lead.id}</span>${lead.website ? `<br><a href="${esc(lead.website)}" target="_blank" rel="noopener">${esc(lead.website)}</a>` : ''}</p>`
      : (job.lead_id ? `<p><strong>Lead</strong> #${esc(job.lead_id)}</p>` : '<p class="hint">No lead attached.</p>');
    const facts = (b.verified_facts || []).map((f) => `<li><span class="mono">${esc(f.fact_key)}</span> ${esc(f.value)} <span class="badge">${esc(f.claim_class)}</span></li>`).join('');
    const content = b.content;
    const contentHtml = content ? `<p><strong>Content pack</strong></p><ul>
      ${content.about ? `<li><span class="mono">about</span> ${esc(String(content.about).slice(0, 280))}</li>` : ''}
      ${(content.services || []).slice(0, 8).map((s) => `<li><span class="mono">service</span> ${esc(s)}</li>`).join('')}
      ${content.phone ? `<li><span class="mono">phone</span> ${esc(content.phone)}</li>` : ''}
      ${content.email ? `<li><span class="mono">email</span> ${esc(content.email)}</li>` : ''}
    </ul>` : '';
    const sg = b.style_guide;
    const styleHtml = sg ? `<p><strong>Style guide (from research)</strong></p>
      <div class="style-guide-swatches">${(sg.palette || [sg.primary, sg.secondary].filter(Boolean)).slice(0, 8).map((c) =>
        `<span class="swatch" title="${esc(c)}" style="background:${esc(c)}"></span>`).join('')}</div>
      <ul>
        ${sg.primary ? `<li><span class="mono">primary</span> ${esc(sg.primary)}</li>` : ''}
        ${sg.secondary ? `<li><span class="mono">secondary</span> ${esc(sg.secondary)}</li>` : ''}
        ${(sg.fonts || []).length ? `<li><span class="mono">fonts</span> ${esc(sg.fonts.join(', '))}</li>` : ''}
        ${sg.logo ? `<li><span class="mono">logo</span> <a href="${esc(sg.logo)}" target="_blank" rel="noopener">link</a></li>` : ''}
        ${sg.direction ? `<li><span class="mono">direction</span> ${esc(sg.direction)}</li>` : ''}
      </ul>` : '<p class="hint">No style guide yet — run Research on a lead with a website.</p>';
    const struct = b.source_structure || [];
    const structHtml = struct.length ? `<p><strong>Source structure &amp; copy (reuse)</strong></p><ul>${
      struct.slice(0, 10).map((p) => `<li><span class="mono">${esc(p.role || 'page')}</span> ${esc(p.title || p.slug || '')}
        <ul>${(p.sections || []).slice(0, 4).map((s) =>
          `<li><strong>${esc(s.heading || '')}</strong> — ${esc(String(s.body || '').slice(0, 140))}</li>`
        ).join('')}</ul></li>`).join('')
    }</ul>` : '';
    const map = b.site_map || {};
    const rec = map.recommended_pages || (content && content.recommended_pages) || [];
    const mapHtml = (map.services || rec.length) ? `<p><strong>Site map (from research)</strong></p>
      <ul>
        ${map.sitemap_count != null ? `<li><span class="mono">sitemap</span> ${esc(map.sitemap_count)} URLs · fetched ${(map.fetched_pages || []).length || struct.length}</li>` : ''}
        ${(map.areas || []).length ? `<li><span class="mono">areas</span> ${esc(map.areas.join(', '))}</li>` : ''}
        ${(map.services || []).length ? `<li><span class="mono">services</span> ${esc(map.services.map((s) => s.title || s.slug).join(' · '))}</li>` : ''}
        ${rec.length ? `<li><span class="mono">recommended pages</span> ${esc(rec.map((p) => p.slug || p.title).join(', '))}</li>` : ''}
        ${(map.faq || (content && content.faq) || []).length ? `<li><span class="mono">faq</span> ${(map.faq || content.faq).length} items</li>` : ''}
      </ul>` : '';
    $('dj-brief').innerHTML = leadHtml +
      shapeHtml +
      `<p>${esc(job.instructions || '')}</p>` +
      (b.owner_notes ? `<p><strong>Owner notes</strong><br>${esc(b.owner_notes)}</p>` : '') +
      styleHtml +
      mapHtml +
      structHtml +
      contentHtml +
      `<p><strong>Verified facts</strong></p>` +
      (facts ? `<ul>${facts}</ul>` : '<p>No verified facts on this job.</p>') +
      `<p class="hint">${esc((b.constraints || []).join(' '))}</p>`;
  }

  function renderQuestions(job) {
    const box = $('dj-questions');
    const qs = job.questions || [];
    if (!qs.length) { box.innerHTML = '<span class="hint">The agent has not asked anything.</span>'; return; }
    box.innerHTML = qs.map((q) => `<div class="panel" style="padding:10px;margin-bottom:8px">
      <p><strong>Q.</strong> ${esc(q.question)}</p>
      ${q.answer ? `<p><strong>A.</strong> ${esc(q.answer)}${q.from_email ? ` <span class="hint">from ${esc(q.from_email)}</span>` : ''}${q.answered_at ? ` <span class="hint">${esc(q.answered_at)}</span>` : ''}</p>` : `<div class="field"><textarea data-qid="${q.id}" rows="2" placeholder="Your answer"></textarea></div><button class="btn" data-answer="${q.id}">Send answer</button>`}
    </div>`).join('');
    box.querySelectorAll('[data-answer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const qid = Number(btn.dataset.answer);
        const area = box.querySelector(`textarea[data-qid="${qid}"]`);
        const res = await api('design:answer', { questionId: qid, answer: area ? area.value : '' });
        if (!res.ok) { $('dj-action-msg').textContent = res.error || 'Could not save the answer.'; return; }
        S.job = res.job;
        renderQuestions(res.job);
        $('dj-status').textContent = res.job.status;
      });
    });
  }

  const ITEM_ARRAY_KEYS = [
    'days', 'posts', 'items', 'variants', 'cards', 'assets', 'slogans',
    'options', 'creatives', 'captions', 'concepts', 'slides', 'entries',
  ];
  const PRIMARY_TEXT_KEYS = [
    'caption', 'copy', 'text', 'body', 'description', 'content', 'post', 'script', 'message',
  ];
  const TITLE_KEYS = ['headline', 'title', 'theme', 'name', 'label', 'day', 'platform', 'kind'];

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function pickFirstString(obj, keys) {
    if (!isPlainObject(obj)) return '';
    for (const k of keys) {
      if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
      if (typeof obj[k] === 'number') return String(obj[k]);
    }
    return '';
  }

  function looksLikeSvgMarkup(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (/^data:image\/svg\+xml/i.test(t)) return true;
    if (/^<\?xml\b/i.test(t) && /<svg[\s>]/i.test(t)) return true;
    if (/^<svg[\s>]/i.test(t)) return true;
    return false;
  }

  function extractSvgMarkup(item) {
    if (typeof item === 'string' && looksLikeSvgMarkup(item)) return item.trim();
    if (!isPlainObject(item)) return '';
    for (const key of ['svg', 'markup', 'xml', 'content', 'data', 'source', 'code']) {
      if (typeof item[key] === 'string' && looksLikeSvgMarkup(item[key])) {
        return item[key].trim();
      }
    }
    // Any string field that is SVG markup
    for (const v of Object.values(item)) {
      if (typeof v === 'string' && looksLikeSvgMarkup(v)) return v.trim();
    }
    return '';
  }

  /** Safe img src for SVG markup or data URIs (never inject raw SVG into DOM). */
  function svgToImageSrc(svgOrData) {
    const raw = String(svgOrData || '').trim();
    if (!raw) return '';
    if (/^data:image\/svg\+xml/i.test(raw)) return raw;
    // Strip XML declaration noise for more reliable encoding
    const svg = raw.replace(/^\uFEFF/, '');
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function itemImageSrc(item) {
    if (!item) return '';
    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item) && /\.(svg|png|jpe?g|gif|webp)(\?|$)/i.test(item)) return item;
      if (looksLikeSvgMarkup(item)) return svgToImageSrc(item);
      return '';
    }
    if (!isPlainObject(item)) return '';
    if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) return item.url;
    if (typeof item.src === 'string' && /^https?:\/\//i.test(item.src)) return item.src;
    if (typeof item.url === 'string' && /^data:image\//i.test(item.url)) return item.url;
    if (typeof item.dataUrl === 'string' && /^data:image\//i.test(item.dataUrl)) return item.dataUrl;
    // Relative export paths (images/foo.png) → localhost preview server
    if (typeof item.url === 'string' && /^images\//i.test(item.url) && S.assetBase) {
      return `${S.assetBase}/${item.url.replace(/^\/+/, '')}`;
    }
    if (typeof item.path === 'string' && /\.(png|jpe?g|webp|gif)$/i.test(item.path) && S.assetBase) {
      const name = item.name || String(item.path).split(/[/\\]/).pop();
      if (name) return `${S.assetBase}/images/${name}`;
    }
    const svg = extractSvgMarkup(item);
    if (svg) return svgToImageSrc(svg);
    return '';
  }

  function itemTitle(item, index) {
    if (typeof item === 'string') {
      if (looksLikeSvgMarkup(item)) return `SVG ${index + 1}`;
      return `Item ${index + 1}`;
    }
    const t = pickFirstString(item, [...TITLE_KEYS, 'name', 'filename', 'file']);
    if (t) {
      if (item.day != null && !/day/i.test(String(t))) return `Day ${item.day} · ${t}`;
      return t;
    }
    if (item.day != null) return `Day ${item.day}`;
    if (extractSvgMarkup(item)) return `SVG ${index + 1}`;
    return `Item ${index + 1}`;
  }

  /** Title + description only (for the single copy button). Never copies raw SVG markup. */
  function itemCopyText(item, index) {
    const title = itemTitle(item, index == null ? 0 : index);
    const description = itemDescription(item);
    if (title && description && description !== title) return `${title}\n\n${description}`;
    return (description || title || '').trim();
  }

  function findItemArrays(payload) {
    if (!isPlainObject(payload)) return [];
    const found = [];
    for (const key of ITEM_ARRAY_KEYS) {
      const arr = payload[key];
      if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === 'string' || isPlainObject(x))) {
        found.push({ key, items: arr });
      }
    }
    if (found.length) return found;
    // Any array of objects with a primary text field
    for (const [key, val] of Object.entries(payload)) {
      if (!Array.isArray(val) || !val.length) continue;
      if (!val.every(isPlainObject)) continue;
      const useful = val.some((it) => itemCopyText(it).length >= 12);
      if (useful) found.push({ key, items: val });
    }
    return found;
  }

  function copyBtnHtml(text) {
    const payload = String(text || '');
    if (!payload.trim()) return '';
    return `<button type="button" class="delivery-copy-btn" title="Copy title and description" aria-label="Copy title and description" data-copy="${esc(encodeURIComponent(payload))}">` +
      `<span class="delivery-copy-icon" aria-hidden="true">⧉</span></button>`;
  }

  function deleteBtnHtml(path) {
    if (!path) return '';
    return `<button type="button" class="delivery-delete-btn" title="Delete" aria-label="Delete card" data-path="${esc(path)}">` +
      `<span aria-hidden="true">×</span></button>`;
  }

  function itemDescription(item) {
    if (typeof item === 'string') {
      return looksLikeSvgMarkup(item) ? '' : item.trim();
    }
    if (!isPlainObject(item)) return '';
    let description = pickFirstString(item, PRIMARY_TEXT_KEYS);
    if (description && looksLikeSvgMarkup(description)) description = '';
    if (!description) {
      let best = '';
      for (const [k, v] of Object.entries(item)) {
        if (k === 'claims' || k === 'id' || TITLE_KEYS.includes(k)) continue;
        if (/^(svg|markup|xml|path|url|src|dataUrl|data_url)$/i.test(k)) continue;
        if (typeof v === 'string' && v.trim() && !looksLikeSvgMarkup(v) && v.trim().length > best.length) {
          best = v.trim();
        }
      }
      description = best;
    }
    // Prefer a short usage note over a file path
    if (isPlainObject(item) && typeof item.usage === 'string' && item.usage.trim() && !description) {
      description = item.usage.trim();
    }
    return description;
  }

  function renderDeliveryCard(item, index, groupLabel, path) {
    const title = itemTitle(item, index);
    const description = itemDescription(item);
    const copyText = itemCopyText(item, index);
    const imageSrc = itemImageSrc(item);
    const metaBits = [];
    if (isPlainObject(item)) {
      if (Array.isArray(item.platform_fit) && item.platform_fit.length) {
        metaBits.push(`<span class="delivery-chip">${esc(item.platform_fit.join(' · '))}</span>`);
      }
      if (Array.isArray(item.hashtags) && item.hashtags.length) {
        metaBits.push(`<span class="delivery-chip">${esc(item.hashtags.join(' '))}</span>`);
      }
      if (typeof item.format === 'string' && item.format.trim()) {
        metaBits.push(`<span class="delivery-chip">${esc(item.format)}</span>`);
      }
    }
    const group = groupLabel ? `<span class="hint">${esc(groupLabel)}</span>` : '';
    const media = imageSrc
      ? `<div class="delivery-svg-wrap"><img class="delivery-svg" src="${esc(imageSrc)}" alt="${esc(title)}" loading="lazy"></div>`
      : '';
    const bodyText = description
      ? `<div class="delivery-field-val delivery-primary">${esc(description)}</div>`
      : (media ? '' : '<p class="hint">No description</p>');
    return (
      `<article class="delivery-card" data-path="${esc(path || '')}">` +
        `<header class="delivery-card-head">` +
          `<div><h4 class="delivery-card-title">${esc(title)}</h4>${group}</div>` +
          `<div class="delivery-card-actions">` +
            copyBtnHtml(copyText) +
            deleteBtnHtml(path) +
          `</div>` +
        `</header>` +
        `<div class="delivery-card-body">` +
          (metaBits.length ? `<div class="delivery-meta">${metaBits.join(' ')}</div>` : '') +
          media +
          bodyText +
        `</div>` +
      `</article>`
    );
  }

  function renderMetaCards(payload, usedArrayKeys) {
    const cards = [];
    const skipTop = new Set(usedArrayKeys);
    for (const key of ['notes', 'copy', 'text', 'summary', 'description']) {
      const v = payload[key];
      if (typeof v === 'string' && v.trim()) {
        cards.push(renderDeliveryCard({ title: key, copy: v }, 0, 'overview', key));
        skipTop.add(key);
      } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        v.forEach((line, i) => {
          if (line && String(line).trim()) {
            cards.push(renderDeliveryCard({ title: `${key} ${i + 1}`, copy: String(line) }, i, key, `${key}.${i}`));
          }
        });
        skipTop.add(key);
      }
    }
    if (isPlainObject(payload.contact) || payload.business || payload.market) {
      const bits = [];
      if (payload.business) bits.push(String(payload.business));
      if (payload.market) bits.push(String(payload.market));
      if (isPlainObject(payload.contact)) {
        for (const [k, v] of Object.entries(payload.contact)) {
          if (v != null && String(v).trim()) bits.push(`${k}: ${v}`);
        }
      }
      // Overview contact card is not deletable as a single path (compound) — skip delete path
      if (bits.length) {
        cards.push(renderDeliveryCard({ title: 'Business / contact', copy: bits.join('\n') }, 0, 'overview', ''));
      }
      skipTop.add('contact');
      skipTop.add('business');
      skipTop.add('market');
    }
    if (Array.isArray(payload.channels) && payload.channels.length) {
      cards.push(renderDeliveryCard({
        title: 'Channels',
        copy: payload.channels.map(String).join(', '),
      }, 0, 'overview', 'channels'));
      skipTop.add('channels');
    }
    for (const [k, v] of Object.entries(payload)) {
      if (skipTop.has(k) || ITEM_ARRAY_KEYS.includes(k)) continue;
      if (typeof v === 'string' && v.trim().length >= 8) {
        cards.push(renderDeliveryCard({ title: k, copy: v }, 0, 'field', k));
      }
    }
    return cards;
  }

  function wireDeliveryActions(root) {
    if (!root || root._deliveryWired) return;
    root._deliveryWired = true;
    root.addEventListener('click', async (e) => {
      const del = e.target.closest('.delivery-delete-btn');
      if (del && root.contains(del)) {
        const path = del.getAttribute('data-path') || '';
        if (!path || !S.job) return;
        if (!confirm('Delete this card from the delivery?')) return;
        const msg = $('dj-action-msg');
        if (msg) msg.textContent = 'Deleting…';
        const res = await api('design:removeDeliveryItem', { id: S.job.id, path });
        if (!res.ok) {
          if (msg) msg.textContent = res.error || 'Could not delete.';
          return;
        }
        S.job = res.job;
        if (msg) msg.textContent = 'Card deleted.';
        if (S.job.deliverable) renderGeneric(S.job.deliverable);
        else renderGeneric(null);
        return;
      }
      const btn = e.target.closest('.delivery-copy-btn');
      if (!btn || !root.contains(btn)) return;
      let text = btn.getAttribute('data-copy') || '';
      if (!text) return;
      try { text = decodeURIComponent(text); } catch { /* use raw */ }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1200);
      } catch { /* ignore */ }
    });
  }

  function renderGeneric(payload) {
    const host = $('dj-delivery-body');
    if (!host) return;
    if (!payload || typeof payload !== 'object') {
      host.innerHTML = '<p class="hint">Waiting on the agent.</p>';
      return;
    }
    const arrays = findItemArrays(payload);
    const usedKeys = arrays.map((a) => a.key);
    const cards = [];
    cards.push(...renderMetaCards(payload, usedKeys));
    for (const group of arrays) {
      group.items.forEach((item, i) => {
        cards.push(renderDeliveryCard(item, i, group.key, `${group.key}.${i}`));
      });
    }
    const media = [];
    (payload.links || []).forEach((link) => {
      if (link && typeof link.url === 'string' && /^https?:\/\//i.test(link.url)) {
        media.push(`<p><a href="${esc(link.url)}" target="_blank" rel="noopener">${esc(link.label || link.url)}</a></p>`);
      }
    });
    (payload.images || []).forEach((im) => {
      const imgSrc = itemImageSrc(im);
      if (imgSrc) {
        media.push(
          `<figure class="photo delivery-media">` +
            `<img src="${esc(imgSrc)}" alt="${esc((im && im.alt) || '')}">` +
            `<figcaption class="hint">${esc((im && (im.photographer || im.source || im.alt)) || '')}</figcaption>` +
          `</figure>`
        );
      }
    });
    // files with inline SVG are already rendered as cards via ITEM_ARRAY_KEYS;
    // only add external https file links here when not already in cards.
    if (!usedKeys.includes('files')) {
      (payload.files || []).forEach((file) => {
        if (!file) return;
        const src = itemImageSrc(file);
        if (src) {
          media.push(
            `<figure class="photo delivery-media">` +
              `<img class="delivery-svg" src="${esc(src)}" alt="${esc(file.name || file.title || 'file')}">` +
              `<figcaption class="hint">${esc(file.name || file.title || '')}</figcaption>` +
            `</figure>`
          );
        } else if (typeof file.url === 'string' && /^https?:\/\//i.test(file.url)) {
          media.push(`<p><a href="${esc(file.url)}" target="_blank" rel="noopener">${esc(file.name || file.url)}</a></p>`);
        }
      });
    }

    if (!cards.length && !media.length) {
      const json = JSON.stringify(payload, null, 2);
      host.innerHTML =
        `<div class="delivery-cards">` +
          renderDeliveryCard({ title: 'Delivery', copy: json }, 0, 'raw', '') +
        `</div>`;
      wireDeliveryActions(host);
      return;
    }

    host.innerHTML = [
      cards.length ? `<div class="delivery-cards">${cards.join('')}</div>` : '',
      media.length ? `<div class="delivery-media-list">${media.join('')}</div>` : '',
      `<details class="delivery-raw"><summary>Raw JSON</summary><pre class="mono">${esc(JSON.stringify(payload, null, 2))}</pre></details>`,
    ].join('');
    wireDeliveryActions(host);
  }

  function renderBlocks(pages) {
    const host = $('dj-blocks');
    const freeform = pages.some((p) => typeof p.html === 'string' && p.html.trim());
    if (freeform) {
      host.innerHTML = `<p class="hint">Freeform multipage site (${pages.length} pages). Edit in the preview or open in your browser — no template blocks.</p>` +
        pages.map((p) => `<div class="sec-row"><span class="t">${esc(p.title || p.slug)}</span> <span class="hint">${esc(p.slug)} · ${(p.html || '').length} chars</span></div>`).join('');
      return;
    }
    host.innerHTML = pages.map((page, pi) => {
      const rows = (page.sections || []).map((section, si) => {
        const c = section.content || {};
        const fields = ['headline', 'subheadline', 'heading', 'title', 'body', 'text', 'cta_text', 'button_text']
          .filter((k) => typeof c[k] === 'string')
          .map((k) => `<div class="field"><label class="small">${esc(k)}</label><div class="inline-edit" contenteditable="true" data-path="${pi}:${si}:${esc(k)}">${esc(c[k])}</div></div>`)
          .join('');
        return `<div class="sec-row"><span class="t">${esc(section.type)}</span></div>${fields}`;
      }).join('');
      return `<h3>${esc(page.title || page.slug)}</h3>${rows}`;
    }).join('');
    host.querySelectorAll('.inline-edit').forEach((el) => {
      el.addEventListener('input', () => {
        const [pi, si, path] = el.dataset.path.split(':');
        if (LOCKED.test(path)) return;
        const section = S.job.deliverable.pages[Number(pi)].sections[Number(si)];
        setPath(section.content, path, el.innerText);
      });
      el.addEventListener('blur', () => renderPreview());
    });
  }

  function renderPageTabs(pages) {
    const host = $('dj-page-tabs');
    if (!host || !pages || !pages.length) return;
    if (S.pageIdx == null || S.pageIdx < 0 || S.pageIdx >= pages.length) S.pageIdx = 0;
    host.innerHTML = pages.map((p, i) =>
      `<button type="button" class="btn ${i === S.pageIdx ? 'primary' : ''}" data-pi="${i}">${esc(p.title || p.slug)}</button>`
    ).join('');
    host.querySelectorAll('[data-pi]').forEach((btn) => {
      btn.onclick = () => { S.pageIdx = Number(btn.dataset.pi); renderPageTabs(pages); renderPreview(); };
    });
  }

  async function renderPreview() {
    const frame = $('dj-preview');
    const payload = S.job && S.job.deliverable;
    if (!frame || !payload || !payload.pages) return;
    const res = await api('design:renderHtml', {
      pages: payload.pages,
      theme: payload.theme || {},
      editable: true,
      pageIndex: S.pageIdx == null ? 0 : S.pageIdx,
    });
    if (res.ok) frame.srcdoc = res.html;
  }

  function renderReviewShots(review) {
    const box = $('dj-review-shots');
    if (!box) return;
    const previews = (review && review.screenshot_previews) || [];
    if (!previews.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = previews.map((s) => {
      const label = `${esc(s.page || 'page')} · ${esc(s.viewport || '')}`;
      return `<figure class="review-shot"><img src="${esc(s.dataUrl)}" alt="${label}" loading="lazy" /><figcaption>${label}</figcaption></figure>`;
    }).join('');
  }

  function fillInstrArea(el, text, reviewAt) {
    if (!el || !text) return;
    if (!String(el.value || '').trim() || S._reviewStamp !== reviewAt) {
      el.value = text;
    }
  }

  function renderReview(job) {
    const panel = $('dj-review-panel');
    const toolbarReview = $('dj-review');
    const toolbarRedesign = $('dj-redesign');
    const toolbarImprove = $('dj-improve');
    const payload = job && job.deliverable;
    const can = job && job.type === 'website' && payload && Array.isArray(payload.pages) && payload.pages.length;
    if (panel) panel.hidden = !can;
    if (toolbarReview) toolbarReview.hidden = !can;
    if (toolbarRedesign) toolbarRedesign.hidden = !can;
    if (toolbarImprove) toolbarImprove.hidden = !can;
    if (!can) return;
    const review = job.review || {};
    const summary = $('dj-review-summary');
    const list = $('dj-review-issues');
    const redesignArea = $('dj-redesign-instructions');
    const improveArea = $('dj-improve-instructions');
    renderReviewShots(review);
    if (summary) {
      const bits = [];
      if (review.vision_used) bits.push('vision');
      else if (review.ai_used) bits.push('AI');
      if (review.screenshots && review.screenshots.length) bits.push(`${review.screenshots.length} shots`);
      if (job.request_kind) bits.push(`last queue: ${job.request_kind}`);
      summary.innerHTML = review.at
        ? `<strong>${review.pass ? 'Review OK' : 'Needs work'}</strong> · ${esc(review.summary || '')} <span class="hint">(${esc(review.at)}${bits.length ? ` · ${bits.join(' · ')}` : ''})</span>`
        : 'No review yet. Run <strong>Review site</strong> to capture screenshots and generate redesign + improvements instructions.';
    }
    if (list) {
      const issues = review.issues || [];
      list.innerHTML = issues.length
        ? issues.map((i) => `<li>${esc(i)}</li>`).join('')
        : '';
    }
    fillInstrArea(redesignArea, review.redesign_instructions, review.at);
    fillInstrArea(improveArea, review.improvement_instructions, review.at);
    if (review.at) S._reviewStamp = review.at;
    renderEmailRedesigns(job);
  }

  function renderEmailRedesigns(job) {
    const box = $('dj-email-redesign-list');
    if (!box) return;
    const items = (job && Array.isArray(job.email_redesigns)) ? job.email_redesigns : [];
    if (!items.length) {
      box.className = 'hint';
      box.innerHTML = 'No pending email change requests.';
      return;
    }
    box.className = '';
    box.innerHTML = items.map((r) => {
      const from = r.from_email ? esc(r.from_email) : 'unknown sender';
      const when = r.received_at ? esc(r.received_at) : '';
      const kind = r.request_kind === 'improvements' ? 'improvements' : 'redesign';
      const sub = r.subject ? `<div class="hint">${esc(r.subject)}</div>` : '';
      return `<div class="email-redesign-item" data-er-id="${r.id}" style="margin:10px 0;padding:8px 0;border-top:1px solid var(--border, #ddd)">
        <div><strong>#${r.id}</strong> · <span class="badge">${esc(kind)}</span> · ${from}${when ? ` · ${when}` : ''} · <span class="hint">${esc(r.source || 'paste')}</span></div>
        ${sub}
        <p style="white-space:pre-wrap;margin:6px 0">${esc(r.body_excerpt || r.body || '')}</p>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button class="btn primary" type="button" data-er-submit="${r.id}">Submit to agent</button>
          <button class="btn" type="button" data-er-dismiss="${r.id}">Dismiss</button>
          <button class="btn" type="button" data-er-use="${r.id}">Copy into instructions</button>
        </div>
      </div>`;
    }).join('');
  }

  async function openJob(id) {
    const res = await api('design:get', id);
    if (!res.ok) { $('dj-action-msg').textContent = res.error || 'Could not load the job.'; return; }
    S.job = res.job;
    $('dj-list').hidden = true;
    $('dj-detail').hidden = false;
    $('dj-title').textContent = res.job.title;
    $('dj-status').innerHTML = `<span class="badge">${esc(res.job.status)}</span> <span class="hint">${esc(res.job.type)}</span>`;
    const built = res.job.built_by === 'agent'
      ? 'Built by the agent. The app did not rewrite this with a template.'
      : 'Waiting on the agent. Nothing has been generated locally.';
    $('dj-built').textContent = built;
    $('dj-contact').value = res.job.contact_email || '';
    $('dj-emailed').textContent = res.job.questions_emailed_at
      ? `Questions for project #${res.job.id} last queued ${res.job.questions_emailed_at}. This does not email any other job.`
      : `Not emailed yet. Email questions sends only project #${res.job.id}.`;
    $('dj-photos').hidden = res.job.type !== 'website';
    if ($('dj-gen-image')) $('dj-gen-image').hidden = !res.job.deliverable;
    $('dj-browser').hidden = res.job.type !== 'website';
    $('dj-save').hidden = res.job.type !== 'website';
    const shapeField = $('dj-detail-shape-field');
    if (shapeField) {
      shapeField.hidden = res.job.type !== 'website';
      const sel = $('dj-detail-site-shape');
      if (sel) sel.value = res.job.site_shape === 'landing' ? 'landing' : 'multipage';
    }
    renderBrief(res.job);
    renderQuestions(res.job);
    const payload = res.job.deliverable;
    const isSite = res.job.type === 'website' && payload && Array.isArray(payload.pages);
    $('dj-site').hidden = !isSite;
    $('dj-delivery').hidden = isSite;
    renderReview(res.job);
    if (isSite) {
      S.pageIdx = 0;
      renderPageTabs(payload.pages);
      renderBlocks(payload.pages);
      renderPreview();
    } else if (payload) {
      renderGeneric(payload);
    } else {
      $('dj-delivery-body').textContent = 'Waiting on the agent.';
    }
    try {
      const erMeta = await api('design:listEmailRedesigns', { jobId: res.job.id, pendingOnly: true });
      if (erMeta && erMeta.ok && erMeta.dropDir && $('dj-er-drop')) {
        $('dj-er-drop').textContent = `Drop folder: ${erMeta.dropDir}`;
      }
    } catch { /* optional */ }
    try {
      const settings = await api('settings:getAll');
      const bag = (settings && settings.settings && typeof settings.settings === 'object') ? settings.settings : (settings || {});
      S.pexels = secretIsSet(bag, 'pexels.api_key');
    } catch { S.pexels = false; }
    await refreshAiStatus();
    try {
      const base = await api('design:assetBase', { id: res.job.id });
      S.assetBase = (base && (base.baseUrl || (base.url && String(base.url).replace(/\/+$/, '')))) || '';
    } catch { S.assetBase = ''; }
    // Re-render delivery cards now that assetBase is known (relative images/).
    if (!isSite && payload) renderGeneric(payload);
    const pexelsHint = S.pexels
      ? 'Pexels is optional. Add photos uses the lead category when this delivery is a website.'
      : 'Pexels key missing. <a href="#/settings">Add it in Settings</a> if you want stock photos.';
    const aiHint = S.aiKey
      ? `Generate image uses OpenAI (${esc(S.imageModel || 'gpt-image-1')}) with your AI key.`
      : 'Generate image needs an <a href="#/settings">OpenAI API key</a> in Settings.';
    $('dj-pexels').innerHTML = `${pexelsHint} ${aiHint}`;
  }

  function openNewJobModal() {
    const modal = $('dj-new-modal');
    if (!modal) return;
    const msg = $('dj-create-msg');
    if (msg) msg.textContent = '';
    modal.hidden = false;
    const focusEl = $('dj-title') || $('dj-lead-search');
    if (focusEl && typeof focusEl.focus === 'function') {
      try { focusEl.focus(); } catch { /* ignore */ }
    }
  }

  function closeNewJobModal() {
    const modal = $('dj-new-modal');
    if (modal) modal.hidden = true;
  }

  function init() {
    wireLeadPicker();
    wireKindPicker();
    wireInstructionsField();
    loadDefaultInstructions();
    if ($('dj-new-open')) $('dj-new-open').addEventListener('click', openNewJobModal);
    if ($('dj-new-close')) $('dj-new-close').addEventListener('click', closeNewJobModal);
    const newModal = $('dj-new-modal');
    if (newModal) {
      newModal.addEventListener('click', (e) => {
        if (e.target === newModal) closeNewJobModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const modal = $('dj-new-modal');
      if (modal && !modal.hidden) closeNewJobModal();
    });
    $('dj-create').addEventListener('click', async () => {
      const msg = $('dj-create-msg');
      // Flush a typed custom kind into the priority list before create.
      const pendingCustom = normalizeKind(($('dj-type-custom') && $('dj-type-custom').value) || '');
      if (pendingCustom && !S.kinds.includes(pendingCustom)) {
        S.kinds.push(pendingCustom);
        if ($('dj-type-custom')) $('dj-type-custom').value = '';
        renderKindsUI();
      }
      const kinds = S.kinds.slice();
      if (!kinds.length) {
        msg.textContent = 'Select at least one kind.';
        return;
      }
      const leadRaw = $('dj-lead').value.trim();
      const leadId = leadRaw ? Number(leadRaw) : undefined;
      if (leadRaw && (!Number.isInteger(leadId) || leadId < 1)) {
        msg.textContent = 'Pick a lead from the search results, or clear the selection.';
        return;
      }
      const baseTitle = $('dj-title').value.trim();
      const instructions = $('dj-instructions').value.trim();
      const multi = kinds.length > 1;
      msg.textContent = multi ? `Assigning ${kinds.length} jobs…` : 'Assigning…';
      try {
        const created = [];
        for (const type of kinds) {
          const payload = {
            type,
            title: titleForKind(baseTitle, type, multi),
            instructions,
            leadId: leadId || undefined,
          };
          if (type === 'website') {
            payload.site_shape = ($('dj-site-shape') && $('dj-site-shape').value) || 'multipage';
          }
          const res = await api('design:create', payload);
          if (!res.ok) throw new Error(res.error || `failed creating ${type}`);
          created.push(res.job);
        }
        const summary = created.map((j, i) => `${i + 1}. #${j.id} ${j.type}`).join(' · ');
        msg.textContent = created.length === 1
          ? `Job #${created[0].id} (${created[0].type}) is waiting on the agent. MCP: design.next or design.pending (see MCP page).`
          : `Created ${created.length} jobs in priority order: ${summary}. MCP: design.next or design.pending (see MCP page).`;
        setSelectedLead(null);
        S.instructionsTouched = false;
        if (instructionsEl() && S.defaultWebsiteInstructions && S.kinds.includes('website')) {
          instructionsEl().value = S.defaultWebsiteInstructions;
        }
        closeNewJobModal();
        if (created.length === 1) openJob(created[0].id);
        else {
          S.kinds = ['website'];
          renderKindsUI();
          loadList();
        }
      } catch (e) { msg.textContent = e.message; }
    });
    if ($('dj-save-shape')) {
      $('dj-save-shape').addEventListener('click', async () => {
        if (!S.job) return;
        const shape = ($('dj-detail-site-shape') && $('dj-detail-site-shape').value) || 'multipage';
        const res = await api('design:update', { id: S.job.id, site_shape: shape });
        if (!res.ok) {
          $('dj-action-msg').textContent = res.error || 'Could not save site shape.';
          return;
        }
        S.job = res.job;
        $('dj-action-msg').textContent = `Site shape set to ${siteShapeLabel(res.job.site_shape)}.`;
        renderBrief(res.job);
      });
    }
    $('dj-back').addEventListener('click', showList);
    $('dj-save-contact').addEventListener('click', async () => {
      if (!S.job) return;
      const res = await api('design:setContact', { id: S.job.id, email: $('dj-contact').value });
      $('dj-action-msg').textContent = res.ok ? 'Contact saved for this project.' : (res.error || 'Could not save the contact.');
      if (res.ok) S.job = res.job;
    });
    $('dj-email-q').addEventListener('click', async () => {
      if (!S.job) return;
      $('dj-action-msg').textContent = 'Composing questions for this project…';
      const res = await api('design:emailQuestions', { jobId: S.job.id });
      if (!res.ok) { $('dj-action-msg').textContent = res.error || 'Could not email questions.'; return; }
      if (res.queued) {
        $('dj-action-msg').textContent = `Queued for ${res.to}. Not sent yet. Subject: ${res.subject}`;
      } else {
        $('dj-action-msg').textContent = res.error || 'Questions were not emailed.';
      }
      const fresh = await api('design:get', S.job.id);
      if (fresh.ok) {
        S.job = fresh.job;
        $('dj-emailed').textContent = fresh.job.questions_emailed_at
          ? `Questions for project #${fresh.job.id} last queued ${fresh.job.questions_emailed_at}.`
          : $('dj-action-msg').textContent;
      }
    });
    $('dj-reply-save').addEventListener('click', async () => {
      if (!S.job) return;
      const res = await api('design:recordReply', {
        id: S.job.id,
        reply: $('dj-reply').value,
        fromEmail: $('dj-reply-from').value,
      });
      $('dj-action-msg').textContent = res.ok ? 'Reply stored on this job.' : (res.error || 'Could not store the reply.');
      if (res.ok) {
        S.job = res.job;
        $('dj-reply').value = '';
        renderQuestions(res.job);
        $('dj-status').innerHTML = `<span class="badge">${esc(res.job.status)}</span> <span class="hint">${esc(res.job.type)}</span>`;
      }
    });
    $('dj-save').addEventListener('click', async () => {
      if (!S.job) return;
      const res = await api('design:saveWebsite', {
        id: S.job.id,
        pages: S.job.deliverable.pages,
        theme: S.job.deliverable.theme || {},
      });
      $('dj-action-msg').textContent = res.ok ? 'Saved. The agent delivery was kept.' : (res.error || 'Save failed.');
      if (res.ok) S.job = res.job;
    });
    $('dj-browser').addEventListener('click', async () => {
      if (!S.job) return;
      $('dj-action-msg').textContent = 'Opening in your browser…';
      const res = await api('design:openPreview', S.job.id);
      $('dj-action-msg').textContent = res.ok ? ('Opened ' + res.path) : ('Could not open the preview: ' + (res.error || 'failed'));
    });
    async function runReview() {
      if (!S.job) return;
      $('dj-action-msg').textContent = 'Capturing screenshots and reviewing…';
      const res = await api('design:review', { id: S.job.id });
      if (!res.ok) {
        $('dj-action-msg').textContent = res.error || 'Review failed.';
        return;
      }
      S.job = res.job || S.job;
      if (res.review) S.job.review = res.review;
      S._reviewStamp = null;
      renderReview(S.job);
      const n = (res.review && res.review.screenshots && res.review.screenshots.length) || 0;
      const shotBit = n ? ` (${n} screenshot${n === 1 ? '' : 's'})` : '';
      $('dj-action-msg').textContent = res.review && res.review.pass
        ? `Review finished${shotBit} — looks OK; you can still request redesign or improvements.`
        : `Review finished${shotBit} — edit either instruction bucket, then request redesign or improvements.`;
    }
    async function sendChange(kind) {
      if (!S.job) return;
      const isImprove = kind === 'improvements';
      const areaId = isImprove ? 'dj-improve-instructions' : 'dj-redesign-instructions';
      const channel = isImprove ? 'design:improve' : 'design:redesign';
      const label = isImprove ? 'improvements' : 'redesign';
      const instructions = ($(areaId) && $(areaId).value) || '';
      $('dj-action-msg').textContent = `Queuing ${label} for the MCP agent…`;
      const res = await api(channel, {
        id: S.job.id,
        instructions: String(instructions).trim() || undefined,
        refresh: !String(instructions).trim(),
        forceReview: !String(instructions).trim() && !(S.job.review && S.job.review.at),
      });
      if (!res.ok) {
        $('dj-action-msg').textContent = res.error || `Could not queue ${label}.`;
        return;
      }
      S.job = res.job;
      renderReview(S.job);
      $('dj-status').innerHTML = `<span class="badge">${esc(S.job.status)}</span> <span class="hint">${esc(S.job.type)}</span>`;
      $('dj-action-msg').textContent = `${isImprove ? 'Improvements' : 'Redesign'} queued (job #${S.job.id} → waiting_on_agent, reason: ${label}). Trigger file + notify/command fired if configured. MCP: design.next.`;
    }
    const sendRedesign = () => sendChange('redesign');
    const sendImprove = () => sendChange('improvements');
    const reviewBtn = $('dj-review');
    const redesignBtn = $('dj-redesign');
    const improveBtn = $('dj-improve');
    const reviewRun = $('dj-review-run');
    const redesignSend = $('dj-redesign-send');
    const improveSend = $('dj-improve-send');
    if (reviewBtn) reviewBtn.addEventListener('click', runReview);
    if (reviewRun) reviewRun.addEventListener('click', runReview);
    if (redesignBtn) redesignBtn.addEventListener('click', sendRedesign);
    if (redesignSend) redesignSend.addEventListener('click', sendRedesign);
    if (improveBtn) improveBtn.addEventListener('click', sendImprove);
    if (improveSend) improveSend.addEventListener('click', sendImprove);
    const erList = $('dj-email-redesign-list');
    if (erList) {
      erList.addEventListener('click', async (e) => {
        const t = e.target;
        if (!t || !S.job) return;
        const submitId = t.getAttribute && t.getAttribute('data-er-submit');
        const dismissId = t.getAttribute && t.getAttribute('data-er-dismiss');
        const useId = t.getAttribute && t.getAttribute('data-er-use');
        if (submitId) {
          $('dj-action-msg').textContent = 'Submitting email request to the agent queue…';
          const res = await api('design:submitEmailRedesign', {
            id: Number(submitId),
            designJobId: S.job.id,
          });
          if (!res.ok) {
            $('dj-action-msg').textContent = res.error || 'Could not submit email request.';
            return;
          }
          S.job = res.job;
          renderReview(S.job);
          $('dj-status').innerHTML = `<span class="badge">${esc(S.job.status)}</span> <span class="hint">${esc(S.job.type)}</span>`;
          const kind = (res.request && res.request.request_kind) || S.job.request_kind || 'redesign';
          $('dj-action-msg').textContent = `Email ${kind} #${submitId} queued (job #${S.job.id} → waiting_on_agent).`;
          return;
        }
        if (dismissId) {
          const res = await api('design:dismissEmailRedesign', { id: Number(dismissId) });
          $('dj-action-msg').textContent = res.ok ? 'Email request dismissed.' : (res.error || 'Dismiss failed.');
          if (res.ok) openJob(S.job.id);
          return;
        }
        if (useId) {
          const item = (S.job.email_redesigns || []).find((r) => String(r.id) === String(useId));
          if (!item) return;
          const kind = item.request_kind === 'improvements' ? 'improvements' : 'redesign';
          const area = $(kind === 'improvements' ? 'dj-improve-instructions' : 'dj-redesign-instructions');
          if (area) {
            area.value = item.body || item.body_excerpt || '';
            $('dj-action-msg').textContent = `Copied email notes into ${kind} instructions.`;
          }
        }
      });
    }
    const erSave = $('dj-er-save');
    if (erSave) {
      erSave.addEventListener('click', async () => {
        if (!S.job) return;
        const kindSel = $('dj-er-kind');
        const requestKind = kindSel && kindSel.value ? kindSel.value : undefined;
        const res = await api('design:ingestEmailRedesign', {
          id: S.job.id,
          fromEmail: ($('dj-er-from') && $('dj-er-from').value) || '',
          subject: ($('dj-er-subject') && $('dj-er-subject').value) || '',
          body: ($('dj-er-body') && $('dj-er-body').value) || '',
          source: 'paste',
          force: true,
          requestKind,
        });
        if (!res.ok) {
          $('dj-action-msg').textContent = res.error || 'Could not save email request.';
          return;
        }
        if ($('dj-er-body')) $('dj-er-body').value = '';
        const kind = (res.request && res.request.request_kind) || 'redesign';
        $('dj-action-msg').textContent = `Saved email ${kind} request #${res.request && res.request.id}. Submit when ready.`;
        if (res.job) {
          S.job = res.job;
          renderEmailRedesigns(S.job);
        } else {
          openJob(S.job.id);
        }
      });
    }
    const erScan = $('dj-er-scan');
    if (erScan) {
      erScan.addEventListener('click', async () => {
        if (!S.job) return;
        $('dj-action-msg').textContent = 'Scanning inbound drop folder…';
        const res = await api('design:scanInboundEmail');
        if (!res.ok) {
          $('dj-action-msg').textContent = res.error || 'Scan failed.';
          return;
        }
        if (res.dropDir && $('dj-er-drop')) $('dj-er-drop').textContent = `Drop folder: ${res.dropDir}`;
        const n = (res.results || []).filter((r) => r.ok && !r.skipped).length;
        $('dj-action-msg').textContent = `Scanned ${res.scanned || 0} file(s); saved ${n} change request(s).`;
        openJob(S.job.id);
      });
    }
    $('dj-photos').addEventListener('click', async () => {
      if (!S.job) return;
      if (!S.pexels) {
        $('dj-pexels').innerHTML = 'Pexels key missing. <a href="#/settings">Add it in Settings</a>.';
        return;
      }
      $('dj-action-msg').textContent = 'Pulling photos…';
      const res = await api('design:addImages', { id: S.job.id });
      $('dj-action-msg').textContent = res.ok ? `Added ${res.count} photo(s).` : (res.error || 'failed');
      if (res.ok) openJob(S.job.id);
    });
    if ($('dj-gen-image')) {
      $('dj-gen-image').addEventListener('click', async () => {
        if (!S.job) return;
        await refreshAiStatus();
        if (!S.aiKey) {
          $('dj-action-msg').textContent = 'Set an OpenAI API key in Settings first.';
          return;
        }
        const custom = window.prompt('Image prompt (leave blank for a lead-aware default):', '');
        if (custom === null) return;
        $('dj-action-msg').textContent = 'Generating image with OpenAI…';
        const res = await api('design:generateImages', {
          id: S.job.id,
          prompt: custom.trim() || undefined,
          n: 1,
          quality: 'low',
        });
        if (!res.ok) {
          $('dj-action-msg').textContent = res.error || 'Image generation failed.';
          return;
        }
        $('dj-action-msg').textContent = `Generated ${res.count} image(s) with ${res.model || 'OpenAI'}.`;
        openJob(S.job.id);
      });
    }
    window.addEventListener('message', (e) => {
      const frame = $('dj-preview');
      if (!frame || e.source !== frame.contentWindow || !S.job || !S.job.deliverable) return;
      const data = e.data;
      if (!data || data.source !== 'ws-preview') return;
      const m = String(data.id || '').match(/^(\d+):(\d+):(.+)$/);
      if (!m || LOCKED.test(m[3])) return;
      const section = S.job.deliverable.pages[Number(m[1])] && S.job.deliverable.pages[Number(m[1])].sections[Number(m[2])];
      if (!section) return;
      setPath(section.content, m[3], String(data.text || '').replace(/\s+/g, ' ').trim());
    });
    loadList();
  }

  window.pageInit = init;
  if (document.readyState !== 'loading') {
    if (!document.getElementById('view')) init();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (!document.getElementById('view')) init();
    });
  }
})();
