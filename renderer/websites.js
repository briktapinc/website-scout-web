/* Websites page (Workstream 3). Expects window.api.invoke(channel, ...args).
 * Mounted by the shell router into #view; also self-mounts when opened standalone. */
(function () {
  'use strict';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function api(channel, ...args) {
    if (!window.api || typeof window.api.invoke !== 'function') {
      return Promise.reject(new Error('window.api.invoke is not available'));
    }
    return window.api.invoke(channel, ...args);
  }

  const SECTION_TYPES = [
    'nav', 'hero', 'benefits', 'services', 'about', 'gallery', 'reviews',
    'cta', 'contact_form', 'map_placeholder', 'hours', 'faq', 'footer',
    'booking_button', 'social_links', 'custom',
  ];

  const LOCKED_PATH = /(^|\.)(phone|phone_display|email|address|address_lines|hours|rating|review_count|business_name|href|cta_href|cta_secondary_href|button_href|url|photographer|photographer_url|pexels_url)$/;
  function isLockedPath(path) { return LOCKED_PATH.test(String(path || '')); }

  function defaultContentFor(type) {
    switch (type) {
      case 'hero': return { headline: 'Headline', subheadline: 'Subheadline text.', cta_text: 'Contact Us', cta_href: '#contact' };
      case 'benefits': return { title: 'Why Choose Us', items: [{ title: 'Benefit one', text: 'Short description.' }] };
      case 'services': return { title: 'Our Services', items: [{ name: 'Service name', description: 'Short description.' }] };
      case 'about': return { title: 'About Us', paragraphs: ['About paragraph.'] };
      case 'gallery': return { title: 'Gallery' };
      case 'custom': return { heading: 'Heading', body: 'Body text.', button: { text: 'Learn more', href: '#contact' } };
      case 'reviews': return { title: 'Customer Reviews', reviews: [] };
      case 'cta': return { title: 'Get in touch today', text: '', button_text: 'Contact Us', button_href: '#contact' };
      case 'contact_form': return { title: 'Contact Us', text: '' };
      case 'map_placeholder': return { title: 'Find Us', address_lines: [] };
      case 'hours': return { title: 'Business Hours', hours: [] };
      case 'faq': return { title: 'FAQ', items: [{ q: 'Question?', a: 'Answer.' }] };
      case 'footer': return { business_name: 'Business' };
      case 'booking_button': return { text: 'Call Now', href: '#contact' };
      case 'social_links': return { title: 'Follow Us', links: [] };
      case 'nav': return { business_name: 'Business' };
      default: return {};
    }
  }

  const S = {
    siteId: null, site: null, pages: [], theme: {},
    aiKey: false, pexelsKey: false, previewTimer: null,
    leadPick: null, leadTimer: null,
  };

  function setSelectedLead(lead) {
    S.leadPick = lead || null;
    const hidden = $('ws-gen-lead');
    const sel = $('ws-lead-selected');
    const search = $('ws-lead-search');
    const results = $('ws-lead-results');
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
      <button type="button" class="btn lp-clear" id="ws-lead-clear">Clear</button>`;
    const clear = $('ws-lead-clear');
    if (clear) clear.onclick = () => { setSelectedLead(null); if (search) search.value = ''; search && search.focus(); };
    if (search) search.value = '';
  }

  async function searchLeads(q) {
    const results = $('ws-lead-results');
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
    const search = $('ws-lead-search');
    const results = $('ws-lead-results');
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
      const root = $('ws-lead-picker');
      if (root && !root.contains(e.target)) results.hidden = true;
    });
  }

  function $(id) { return document.getElementById(id); }

  function showList() {
    $('ws-list').hidden = false;
    $('ws-detail').hidden = true;
    S.siteId = null;
    loadSites();
  }

  async function loadSites() {
    const body = $('ws-sites-body');
    body.innerHTML = '<tr><td colspan="5" class="hint">Loading…</td></tr>';
    try {
      const res = await api('sites:list', {});
      if (!res.ok) throw new Error(res.error || 'failed');
      const sites = res.sites || [];
      if (!sites.length) {
        body.innerHTML = '<tr><td colspan="5" class="hint">No websites yet. Generate one from a lead above.</td></tr>';
        return;
      }
      body.innerHTML = sites.map((s) => `<tr class="clickable" data-id="${s.id}">
        <td><strong>${esc(s.business_name || s.name)}</strong><br><span class="hint">${esc(s.category || '')}</span></td>
        <td>${esc(s.industry || '')}${s.origin === 'agent' ? ' <span class="badge">agent</span>' : (s.origin === 'template' ? ' <span class="badge">template</span>' : '')}</td>
        <td><span class="badge b-${esc(s.status)}">${esc(s.status)}</span></td>
        <td>${esc(String(s.version_count ?? ''))}</td>
        <td class="hint">${esc(s.updated_at || '')}</td>
      </tr>`).join('');
      body.querySelectorAll('tr.clickable').forEach((tr) => {
        tr.addEventListener('click', () => showDetail(Number(tr.dataset.id)));
      });
    } catch (e) {
      body.innerHTML = `<tr><td colspan="5" class="hint">Error: ${esc(e.message)}</td></tr>`;
    }
  }

  async function checkAiKey() {
    try {
      const res = await api('settings:getAll');
      const settings = (res && res.settings && typeof res.settings === 'object') ? res.settings : (res || {});
      const v = settings['ai.api_key'];
      S.aiKey = v === '***';
      S.pexelsKey = settings['pexels.api_key'] === '***';
    } catch (e) { S.aiKey = false; S.pexelsKey = false; }
    const btn = $('ws-recopy');
    const hint = $('ws-ai-hint');
    if (S.aiKey) {
      btn.disabled = false;
      hint.textContent = 'AI copy is available. Template fallback can rebuild marketing copy. It will not replace an agent delivery unless you confirm.';
    } else {
      btn.disabled = true;
      btn.title = 'Set ai.api_key in Settings to enable AI copy';
      hint.textContent = 'No AI key stored. Template fallback still builds deterministic copy. The default path is Assign to agent.';
    }
    const photoHint = $('ws-pexels-hint');
    if (photoHint) {
      photoHint.innerHTML = S.pexelsKey
        ? 'Pexels is configured. Add photos searches the lead category.'
        : 'Pexels key missing. <a href="#/settings">Add it in Settings</a> to pull photos. Sites still build without it.';
    }
  }

  async function showDetail(id) {
    S.siteId = id;
    S.editingSec = -1;
    $('ws-list').hidden = true;
    $('ws-detail').hidden = false;
    try {
      const res = await api('sites:get', id);
      if (!res.ok) throw new Error(res.error || 'failed');
      S.site = res.site;
      S.pages = res.site.pages || [];
      S.theme = res.site.theme || {};
      S.pageIdx = 0;
      $('ws-detail-title').textContent = res.site.business_name || res.site.name;
      $('ws-detail-status').innerHTML = `<span class="badge b-${esc(res.site.status)}">${esc(res.site.status)}</span>`;
      renderPreview(); renderPageTabs(); renderSections(); renderTheme(); renderManifest(); loadVersions();
      $('ws-qa-results').innerHTML = '<span class="hint">Not run yet.</span>';
      $('ws-export-path').textContent = res.site.preview_path ? 'Last export: ' + res.site.preview_path : '';
      checkAiKey();
      // Cloudflare publish block (see inlined snippet at the bottom of this file).
      window.__cfWebsiteId = id;
      if (typeof window.initCloudflarePublish === 'function') window.initCloudflarePublish();
    } catch (e) {
      $('ws-detail-title').textContent = 'Error: ' + e.message;
    }
  }

  async function renderPreview() {
    const frame = $('ws-preview');
    if (!S.pages || !S.pages.length) return;
    try {
      const res = await api('sites:renderHtml', { pages: S.pages, theme: S.theme || {}, editable: true });
      if (!res.ok) throw new Error(res.error || 'failed');
      frame.srcdoc = res.html;
    } catch (e) {
      frame.srcdoc = '<p style="font-family:sans-serif;padding:20px">Preview failed: ' + esc(e.message) + '</p>';
    }
  }

  function renderPageTabs() {
    const tabs = $('ws-page-tabs');
    tabs.innerHTML = '';
    S.pages.forEach((p, i) => {
      const b = document.createElement('button');
      b.textContent = p.title || p.slug;
      if (i === S.pageIdx) b.classList.add('active');
      b.addEventListener('click', () => { S.pageIdx = i; S.editingSec = -1; renderPageTabs(); renderSections(); });
      tabs.appendChild(b);
    });
  }

  function renderSections() {
    const wrap = $('ws-sections');
    const page = S.pages[S.pageIdx];
    if (!page) { wrap.innerHTML = '<span class="hint">No pages.</span>'; return; }
    wrap.innerHTML = '';
    (page.sections || []).forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'sec-row';
      row.innerHTML = `<span class="t">${esc(s.type)}</span>
        <button data-a="up" title="Move up">↑</button>
        <button data-a="down" title="Move down">↓</button>
        <button data-a="dup" title="Duplicate">Copy</button>
        <button data-a="edit" title="Edit block">Edit</button>
        <button data-a="del" class="danger" title="Remove">✕</button>`;
      row.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => sectionAction(i, b.dataset.a));
      });
      wrap.appendChild(row);
    });
    const sel = $('ws-add-type');
    if (!sel.options.length) {
      SECTION_TYPES.forEach((t) => sel.add(new Option(t, t)));
    }
    renderSecEditor();
  }

  function sectionAction(i, action) {
    const secs = S.pages[S.pageIdx].sections;
    if (action === 'up' && i > 0) { [secs[i - 1], secs[i]] = [secs[i], secs[i - 1]]; }
    else if (action === 'down' && i < secs.length - 1) { [secs[i + 1], secs[i]] = [secs[i], secs[i + 1]]; }
    else if (action === 'del') {
      if (!window.confirm(`Remove section "${secs[i].type}"?`)) return;
      secs.splice(i, 1);
      if (S.editingSec === i) S.editingSec = -1;
    }
    else if (action === 'dup') {
      secs.splice(i + 1, 0, JSON.parse(JSON.stringify(secs[i])));
      S.editingSec = i + 1;
    }
    else if (action === 'edit') { S.editingSec = i; }
    renderSections();
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

  function fieldInput(path, value, multiline) {
    const locked = isLockedPath(path);
    const tag = multiline ? 'textarea' : 'div';
    if (locked) {
      return `<label class="small">${esc(path)} <span class="hint">Verified fact</span></label><input class="locked-field" readonly value="${esc(value == null ? '' : value)}">`;
    }
    if (multiline) {
      return `<label class="small">${esc(path)}</label><div class="inline-edit" contenteditable="true" data-path="${esc(path)}">${esc(value == null ? '' : value)}</div>`;
    }
    return `<label class="small">${esc(path)}</label><div class="inline-edit" contenteditable="true" data-path="${esc(path)}">${esc(value == null ? '' : value)}</div>`;
  }

  function scalarFields(content) {
    const skip = new Set(['items', 'paragraphs', 'images', 'reviews', 'hours', 'links', 'address_lines', 'button', 'image']);
    return Object.keys(content || {}).filter((k) => !skip.has(k) && (content[k] == null || typeof content[k] !== 'object'));
  }

  function renderSecEditor() {
    const ed = $('ws-sec-editor');
    const secs = (S.pages[S.pageIdx] && S.pages[S.pageIdx].sections) || [];
    if (S.editingSec < 0 || S.editingSec >= secs.length) { ed.hidden = true; return; }
    ed.hidden = false;
    const s = secs[S.editingSec];
    const c = s.content || {};
    $('ws-sec-editor-title').textContent = 'Block: ' + s.type;
    const bits = [];
    if (s.type === 'benefits' || s.type === 'services' || s.type === 'faq') {
      if (c.title != null) bits.push(`<div class="field">${fieldInput('title', c.title, false)}</div>`);
      const items = Array.isArray(c.items) ? c.items : [];
      items.forEach((item, i) => {
        bits.push(`<div class="panel" style="padding:10px;margin-bottom:8px"><strong>Item ${i + 1}</strong>`);
        Object.keys(item || {}).forEach((k) => {
          if (item[k] != null && typeof item[k] === 'object') return;
          bits.push(`<div class="field">${fieldInput(`items.${i}.${k}`, item[k], String(item[k] || '').length > 80)}</div>`);
        });
        bits.push(`<button type="button" class="btn" data-drop-item="${i}">Remove item</button></div>`);
      });
      bits.push('<button type="button" class="btn" id="ws-add-item">Add item</button>');
    } else if (s.type === 'about') {
      if (c.title != null) bits.push(`<div class="field">${fieldInput('title', c.title, false)}</div>`);
      (c.paragraphs || []).forEach((p, i) => {
        bits.push(`<div class="field">${fieldInput(`paragraphs.${i}`, p, true)}</div>`);
      });
    } else if (s.type === 'custom') {
      bits.push(`<div class="field">${fieldInput('heading', c.heading || '', false)}</div>`);
      bits.push(`<div class="field">${fieldInput('body', c.body || '', true)}</div>`);
      bits.push(`<div class="field">${fieldInput('button.text', (c.button && c.button.text) || '', false)}</div>`);
    } else {
      scalarFields(c).forEach((k) => {
        const val = c[k];
        bits.push(`<div class="field">${fieldInput(k, typeof val === 'string' ? val : JSON.stringify(val), String(val || '').length > 80)}</div>`);
      });
    }
    bits.push(`<details style="margin-top:8px"><summary>Advanced JSON</summary><textarea class="json ws-json-box">${esc(JSON.stringify(c, null, 2))}</textarea><div class="row" style="margin-top:6px"><button type="button" class="btn ws-json-apply">Apply JSON</button></div></details>`);
    const host = document.createElement('div');
    host.className = 'block-fields';
    host.innerHTML = bits.join('');
    const old = ed.querySelector('.block-fields');
    if (old) old.remove();
    ed.appendChild(host);
    host.querySelectorAll('.inline-edit').forEach((el) => {
      el.addEventListener('input', () => {
        if (isLockedPath(el.dataset.path)) return;
        setPath(s.content, el.dataset.path, el.innerText);
      });
      el.addEventListener('blur', () => { renderPreview(); });
    });
    host.querySelectorAll('[data-drop-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        s.content.items.splice(Number(btn.dataset.dropItem), 1);
        renderSecEditor();
        renderPreview();
      });
    });
    const addItem = host.querySelector('#ws-add-item');
    if (addItem) {
      addItem.addEventListener('click', () => {
        s.content.items = s.content.items || [];
        if (s.type === 'faq') s.content.items.push({ q: 'Question?', a: 'Answer.' });
        else if (s.type === 'services') s.content.items.push({ name: 'Service', description: 'Description.' });
        else s.content.items.push({ title: 'Title', text: 'Text.' });
        renderSecEditor();
      });
    }
    const apply = host.querySelector('.ws-json-apply');
    if (apply) {
      apply.addEventListener('click', () => {
        const msg = $('ws-sec-msg');
        try {
          const parsed = JSON.parse(host.querySelector('.ws-json-box').value);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('content must be an object');
          const prev = s.content;
          Object.keys(parsed).forEach((k) => {
            if (isLockedPath(k) && prev && Object.prototype.hasOwnProperty.call(prev, k)) parsed[k] = prev[k];
          });
          s.content = parsed;
          msg.textContent = 'Applied. Save changes to persist.';
          renderSecEditor();
          renderPreview();
        } catch (e) { msg.textContent = 'Invalid JSON: ' + e.message; }
      });
    }
    $('ws-sec-msg').textContent = '';
  }

  function renderTheme() {
    const t = S.theme;
    const set = (id, val) => {
      $(id).value = /^#[0-9a-fA-F]{6}$/.test(val || '') ? val : '#000000';
      $(id + '-v').textContent = val || '';
    };
    set('ws-theme-primary', t.primary);
    set('ws-theme-secondary', t.secondary);
    set('ws-theme-bg', t.bg);
    set('ws-theme-text', t.text);
    const fontSel = $('ws-theme-font');
    const fonts = [...fontSel.options].map((o) => o.value);
    fontSel.value = fonts.includes(t.font) ? t.font : fonts[0];
  }

  function readTheme() {
    return {
      primary: $('ws-theme-primary').value,
      secondary: $('ws-theme-secondary').value,
      bg: $('ws-theme-bg').value,
      text: $('ws-theme-text').value,
      font: $('ws-theme-font').value,
    };
  }

  function renderManifest() {
    const box = $('ws-manifest');
    const m = (S.site && S.site.manifest) || [];
    if (!m.length) { box.innerHTML = '<span class="hint">No claim manifest stored.</span>'; return; }
    box.innerHTML = `<table><thead><tr><th>Claim</th><th>Value</th><th>Class</th><th>Source</th></tr></thead><tbody>` +
      m.map((c) => `<tr>
        <td class="mono">${esc(c.claim)}</td>
        <td>${esc(c.value)}</td>
        <td><span class="badge b-${esc(c.class)}">${esc(c.class)}</span></td>
        <td class="hint">${esc(c.source || '')}</td>
      </tr>`).join('') + `</tbody></table>`;
  }

  async function loadVersions() {
    const box = $('ws-versions');
    box.innerHTML = '<span class="hint">Loading…</span>';
    try {
      const res = await api('sites:versions', S.siteId);
      if (!res.ok) throw new Error(res.error || 'failed');
      const vs = res.versions || [];
      if (!vs.length) { box.innerHTML = '<span class="hint">No versions.</span>'; return; }
      box.innerHTML = vs.map((v) => `<div class="sec-row">
        <span class="t">v${v.version_no} <span class="hint">${esc(v.created_at || '')}${v.note ? ' — ' + esc(v.note) : ''}</span></span>
        <button data-v="${v.id}">Restore</button>
      </div>`).join('');
      box.querySelectorAll('button[data-v]').forEach((b) => {
        b.addEventListener('click', async () => {
          if (!window.confirm('Restore this version? Current state is saved as a new version first.')) return;
          const r = await api('sites:restore', Number(b.dataset.v));
          if (!r.ok) { window.alert('Restore failed: ' + r.error); return; }
          showDetail(S.siteId);
        });
      });
    } catch (e) {
      box.innerHTML = `<span class="hint">Error: ${esc(e.message)}</span>`;
    }
  }

  function init(root) {
    // wire static controls
    $('ws-back').addEventListener('click', showList);
    wireLeadPicker();
    $('ws-gen-btn').addEventListener('click', async () => {
      const leadId = Number($('ws-gen-lead').value);
      const msg = $('ws-list-msg');
      if (!Number.isInteger(leadId) || leadId <= 0) { msg.textContent = 'Select a lead.'; return; }
      msg.textContent = 'Assigning to the agent…';
      try {
        const siteShape = ($('ws-site-shape') && $('ws-site-shape').value) || 'multipage';
        const defaults = await api('design:defaultInstructions');
        const instructions = (defaults && defaults.ok && defaults.website)
          ? defaults.website
          : 'Design a complete custom website for this business. Prefer freeform page.html plus theme.customCss (baseCss:false). Use verified facts for contact; marketing glue as AI_COPY.';
        const res = await api('design:create', {
          type: 'website',
          title: 'Website for lead #' + leadId,
          instructions,
          leadId,
          site_shape: siteShape,
        });
        if (!res.ok) throw new Error(res.error || 'failed');
        msg.textContent = `Job #${res.job.id} is ${res.job.status} (${res.job.site_shape || siteShape}). Open Design to answer questions and see the delivery.`;
      } catch (e) { msg.textContent = 'Error: ' + e.message; }
    });
    $('ws-fallback-btn').addEventListener('click', async () => {
      const leadId = Number($('ws-gen-lead').value);
      const msg = $('ws-list-msg');
      if (!Number.isInteger(leadId) || leadId <= 0) { msg.textContent = 'Select a lead.'; return; }
      if (!window.confirm('Build a local template site for this lead? If an agent already delivered a site, this replaces that delivery.')) return;
      msg.textContent = 'Building from the template…';
      try {
        const res = await api('sites:generate', { leadId, force: true, fallback: true });
        if (!res.ok) throw new Error(res.error || 'failed');
        msg.textContent = `Template site #${res.id} (${res.industry || 'template'}).`;
        loadSites();
      } catch (e) { msg.textContent = 'Error: ' + e.message; }
    });

    $('ws-prev-desktop').addEventListener('click', () => {
      $('ws-preview-frame').className = 'preview-frame desktop';
      $('ws-prev-desktop').classList.add('active'); $('ws-prev-mobile').classList.remove('active');
    });
    $('ws-prev-mobile').addEventListener('click', () => {
      $('ws-preview-frame').className = 'preview-frame mobile';
      $('ws-prev-mobile').classList.add('active'); $('ws-prev-desktop').classList.remove('active');
    });

    ['primary', 'secondary', 'bg', 'text'].forEach((k) => {
      $('ws-theme-' + k).addEventListener('input', (e) => { $('ws-theme-' + k + '-v').textContent = e.target.value; });
    });

    $('ws-add-sec').addEventListener('click', () => {
      const page = S.pages[S.pageIdx];
      if (!page) return;
      const type = $('ws-add-type').value;
      page.sections.push({ type, content: defaultContentFor(type) });
      S.editingSec = page.sections.length - 1;
      renderSections();
    });

    const legacyApply = $('ws-sec-apply');
    if (legacyApply) legacyApply.hidden = true;
    const legacyJson = $('ws-sec-json');
    if (legacyJson) legacyJson.hidden = true;

    $('ws-save').addEventListener('click', async () => {
      S.theme = readTheme();
      try {
        const res = await api('sites:save', { id: S.siteId, pages: S.pages, theme: S.theme, note: 'Manual edit from Websites page' });
        if (!res.ok) throw new Error(res.error || 'failed');
        renderPreview(); loadVersions();
        window.alert(`Saved as version ${res.version.version_no}.`);
      } catch (e) { window.alert('Save failed: ' + e.message); }
    });

    $('ws-recopy').addEventListener('click', async () => {
      if (!window.confirm('Rebuild this site with fresh AI marketing copy? Facts stay VERIFIED-only; layout resets to the template.')) return;
      try {
        const leadId = S.site.lead_id;
        const res = await api('sites:generate', { leadId, force: true });
        if (!res.ok) throw new Error(res.error || 'failed');
        showDetail(res.id);
      } catch (e) { window.alert('Regenerate failed: ' + e.message); }
    });

    $('ws-qa').addEventListener('click', async () => {
      const box = $('ws-qa-results');
      box.innerHTML = '<span class="hint">Running QA…</span>';
      try {
        const res = await api('sites:qa', S.siteId);
        if (!res.ok) throw new Error(res.error || 'failed');
        box.innerHTML = `<p><strong class="${res.pass ? 'check-pass' : 'check-fail'}">${res.pass ? 'PASS' : 'FAIL'}</strong></p>` +
          `<table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>` +
          (res.checks || []).map((c) => `<tr>
            <td class="mono">${esc(c.name)}</td>
            <td class="${c.pass ? 'check-pass' : 'check-fail'}">${c.pass ? 'PASS' : 'FAIL'}</td>
            <td class="hint">${esc(c.detail || '')}</td>
          </tr>`).join('') + `</tbody></table>`;
        // refresh status badge after QA (may have moved to approved/ready)
        const g = await api('sites:get', S.siteId);
        if (g.ok) { S.site = g.site; $('ws-detail-status').innerHTML = `<span class="badge b-${esc(g.site.status)}">${esc(g.site.status)}</span>`; }
      } catch (e) { box.innerHTML = `<span class="hint">QA error: ${esc(e.message)}</span>`; }
    });

    $('ws-export').addEventListener('click', async () => {
      const out = $('ws-export-path');
      out.textContent = 'Exporting…';
      try {
        const res = await api('sites:export', S.siteId);
        if (!res.ok) throw new Error(res.error || 'failed');
        out.textContent = 'Exported to: ' + res.path;
      } catch (e) { out.textContent = 'Export failed: ' + e.message; }
    });

    $('ws-browser').addEventListener('click', async () => {
      const out = $('ws-export-path');
      out.textContent = 'Opening in your browser…';
      try {
        const res = await api('sites:openPreview', S.siteId);
        if (!res.ok) throw new Error(res.error || 'failed');
        out.textContent = 'Opened in your browser: ' + res.path;
      } catch (e) { out.textContent = 'Could not open the preview: ' + e.message; }
    });
    $('ws-photos').addEventListener('click', async () => {
      const hint = $('ws-pexels-hint');
      if (!S.pexelsKey) {
        hint.innerHTML = 'Pexels key missing. <a href="#/settings">Add it in Settings</a>.';
        return;
      }
      hint.textContent = 'Pulling photos…';
      try {
        const res = await api('sites:addImages', { id: S.siteId });
        if (!res.ok) throw new Error(res.error || 'failed');
        hint.textContent = `Added ${res.count} photo(s) for “${res.query}”.`;
        showDetail(S.siteId);
      } catch (e) { hint.textContent = e.message; }
    });
    window.addEventListener('message', (e) => {
      const frame = $('ws-preview');
      if (!frame || e.source !== frame.contentWindow) return;
      const data = e.data;
      if (!data || data.source !== 'ws-preview') return;
      const m = String(data.id || '').match(/^(\d+):(\d+):(.+)$/);
      if (!m || isLockedPath(m[3])) return;
      const page = S.pages[Number(m[1])];
      const section = page && page.sections[Number(m[2])];
      if (!section || !section.content) return;
      setPath(section.content, m[3], String(data.text || '').replace(/\s+/g, ' ').trim());
      if (S.pageIdx === Number(m[1]) && S.editingSec === Number(m[2])) renderSecEditor();
    });

    showList();
  }

  window.WebsitesPage = { init };

  // Router convention (renderer/app.js calls window.pageInit after injecting the page).
  window.pageInit = init;

  // Standalone mode: if the shell router is absent, mount into document body.
  if (document.readyState !== 'loading') {
    if (!document.getElementById('view')) init(document.getElementById('ws-root'));
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (!document.getElementById('view')) init(document.getElementById('ws-root'));
    });
  }
})();

/* ============================================================================
 * Inlined from renderer/cloudflare-publish-snippet.js (Workstream 6).
 * Wires the #cf-publish-block in websites.html. Host page (showDetail above)
 * sets window.__cfWebsiteId before calling window.initCloudflarePublish().
 * ========================================================================== */
(function cloudflarePublishSnippet() {
  'use strict';

  function currentWebsiteId() {
    const v = window.__cfWebsiteId;
    return Number.isInteger(v) && v > 0 ? v : null;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(msg) {
    const n = el('cf-publish-status');
    if (n) n.textContent = msg || '';
  }

  function showResult(url) {
    const box = el('cf-publish-result');
    const input = el('cf-public-url');
    const link = el('cf-public-link');
    if (!box || !input) return;
    box.hidden = false;
    input.value = url;
    if (link) link.href = url;
  }

  async function refreshConfiguredState() {
    const warn = el('cf-not-configured');
    const btn = el('btn-cf-publish');
    try {
      const cfg = await window.api.invoke('cloudflare:getConfig');
      const ok = !!(cfg && cfg.configured);
      if (warn) warn.hidden = ok;
      if (btn) btn.disabled = !ok;
      return ok;
    } catch (err) {
      if (warn) warn.hidden = false;
      if (btn) btn.disabled = true;
      return false;
    }
  }

  async function onPublishClick() {
    const websiteId = currentWebsiteId();
    if (!websiteId) {
      setStatus('Select a website first.');
      return;
    }
    const ok = await refreshConfiguredState();
    if (!ok) {
      setStatus('Cloudflare is not configured.');
      return;
    }
    setStatus('Publishing…');
    const btn = el('btn-cf-publish');
    if (btn) btn.disabled = true;
    try {
      let dir;
      try {
        const exported = await window.api.invoke('sites:export', websiteId);
        dir =
          (exported && typeof exported === 'object' &&
            (exported.dir || exported.path || exported.preview_path)) ||
          (typeof exported === 'string' ? exported : undefined);
      } catch (err) {
        dir = undefined; // main process will try its own export path
      }
      const args = { websiteId };
      if (typeof dir === 'string' && dir) args.dir = dir;
      const res = await window.api.invoke('cloudflare:publish', args);
      if (res && res.ok) {
        setStatus('Published.');
        showResult(res.url);
      } else if (res && res.error === 'NEEDS_EXPORT') {
        setStatus('Export the site first, then publish.');
      } else {
        setStatus('Publish failed: ' + esc((res && (res.error || res.detail)) || 'unknown error'));
      }
    } catch (err) {
      setStatus('Publish failed: ' + esc(err && err.message ? err.message : 'unknown error'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function onCopyClick() {
    const input = el('cf-public-url');
    if (!input || !input.value) return;
    const url = input.value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        input.select();
        document.execCommand('copy');
      }
      setStatus('Copied.');
    } catch (err) {
      setStatus('Copy failed — select the URL manually.');
    }
  }

  function initCloudflarePublish() {
    const btn = el('btn-cf-publish');
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = '1';
      btn.addEventListener('click', onPublishClick);
    }
    const copy = el('btn-cf-copy');
    if (copy && !copy.dataset.wired) {
      copy.dataset.wired = '1';
      copy.addEventListener('click', onCopyClick);
    }
    refreshConfiguredState();
  }

  window.initCloudflarePublish = initCloudflarePublish;
  window.cfPublishCurrentSite = onPublishClick;
})();
