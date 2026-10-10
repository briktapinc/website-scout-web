'use strict';

/**
 * Browser client for /api/v1. Every method resolves to the full envelope
 * `{ ok: true, data }`; callers read `res.data`. Errors throw (err.status, err.data).
 */
window.ScoutApi = (() => {
  let workspaceId = null;

  function setWorkspaceId(id) {
    workspaceId = id ? Number(id) : null;
    if (workspaceId) localStorage.setItem('scout.workspaceId', String(workspaceId));
  }

  function getWorkspaceId() {
    if (workspaceId) return workspaceId;
    const saved = localStorage.getItem('scout.workspaceId');
    return saved ? Number(saved) : null;
  }

  async function request(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const ws = getWorkspaceId();
    if (ws) headers['X-Workspace-Id'] = String(ws);
    const res = await fetch(path, Object.assign({}, opts, {
      credentials: 'include',
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error((data && data.error) || res.statusText || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** Build `?a=1&b=2` from an object (skips null/undefined/''). Strings pass through. */
  function qs(params) {
    if (!params) return '';
    if (typeof params === 'string') return params;
    const sp = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    });
    const s = sp.toString();
    return s ? '?' + s : '';
  }

  const V = '/api/v1';
  const get = (p, q) => request(V + p + qs(q));
  const post = (p, body) => request(V + p, { method: 'POST', body: body == null ? {} : body });
  const put = (p, body) => request(V + p, { method: 'PUT', body: body == null ? {} : body });
  const patch = (p, body) => request(V + p, { method: 'PATCH', body: body == null ? {} : body });
  const del = (p, body) => request(V + p, { method: 'DELETE', body });

  return {
    request, qs, setWorkspaceId, getWorkspaceId,

    // ---- auth ----
    me: () => get('/auth/me'),
    login: (body) => post('/auth/login', body),
    register: (body) => post('/auth/register', body),
    logout: () => post('/auth/logout', {}),
    selectWorkspace: (id) => post('/auth/workspace', { workspaceId: id }),

    // ---- dashboard / activity / AI ----
    stats: () => get('/dashboard/stats'),
    activity: (q) => get('/activity', q),
    aiUsage: (days) => get('/ai/usage', { days }),
    aiStatus: () => get('/ai/status'),

    // ---- leads ----
    leads: (q) => get('/leads', q),
    leadFacets: () => get('/leads/facets'),
    leadGet: (id) => get('/leads/' + id),
    createLead: (body) => post('/leads', body),
    patchLead: (id, body) => patch('/leads/' + id, body),
    deleteLead: (id) => del('/leads/' + id),
    scoreLead: (id) => post('/leads/' + id + '/score', {}),
    qualifyLead: (id, note) => post('/leads/' + id + '/qualify', { note }),
    researchLead: (id) => post('/leads/' + id + '/research', {}),
    leadFacts: (id, fact) => post('/leads/' + id + '/facts', fact),
    leadTimeline: (id, limit) => get('/leads/' + id + '/timeline', { limit }),
    leadProspectScore: (id) => get('/leads/' + id + '/prospect-score'),
    leadDuplicates: (id) => get('/leads/' + id + '/duplicates'),
    mergeLeads: (keepId, dropIds) => post('/leads/merge', { keepId, dropIds }),
    importLeads: (text, opts) => post('/leads/import', Object.assign({}, opts || {}, { text })),
    bulkLeads: (action, ids, value) => post('/leads/bulk', { action, ids, value }),
    discover: (body) => post('/leads/discover', body),

    // ---- providers / discovery schedule ----
    providers: () => get('/providers'),
    providersSearch: (body) => post('/providers/search', body),
    discoveryGet: () => get('/discovery/schedule'),
    discoverySet: (body) => put('/discovery/schedule', body),
    discoveryRun: () => post('/discovery/run', {}),

    // ---- design jobs ----
    designList: (q) => get('/design', q),
    designPending: () => get('/design/pending'),
    designGet: (id) => get('/design/' + id),
    designCreate: (body) => post('/design', body),
    designUpdate: (id, body) => patch('/design/' + id, body),
    designDelete: (id) => del('/design/' + id),
    designNext: () => post('/design/next', {}),
    designDeliver: (id, body) => post('/design/' + id + '/deliver', body),
    designAsk: (id, question) => post('/design/' + id + '/ask', { question }),
    designAnswers: (id) => get('/design/' + id + '/answers'),
    designAnswer: (questionId, answer, fromEmail) => post('/design/answer', { questionId, answer, fromEmail }),
    designContact: (id, email) => post('/design/' + id + '/contact', { email }),
    designEmailQuestions: (id) => post('/design/' + id + '/email-questions', {}),
    designEmailDelivery: (id) => post('/design/' + id + '/email-delivery', {}),
    designReply: (id, reply, fromEmail) => post('/design/' + id + '/reply', { reply, fromEmail }),
    designReview: (id, body) => post('/design/' + id + '/review', body),
    designRedesign: (id, body) => post('/design/' + id + '/redesign', body),
    designImprove: (id, body) => post('/design/' + id + '/improve', body),
    designPreview: (id, open) => post('/design/' + id + '/preview', { open: !!open }),
    designImages: (id, body) => post('/design/' + id + '/images', body),
    designGenerateImages: (id, body) => post('/design/' + id + '/generate-images', body),
    designRender: (id, body) => post('/design/' + id + '/render', body),
    designRenderPages: (body) => post('/design/render', body),
    designSaveWebsite: (id, pages, theme) => put('/design/' + id + '/website', { pages, theme }),
    designRemoveDelivery: (id, path) => post('/design/' + id + '/remove-delivery', { path }),
    designAssetBase: (id) => get('/design/' + id + '/asset-base'),
    designDefaultInstructions: () => get('/design/default-instructions'),

    // ---- design: inbound email redesign requests ----
    emailRedesignList: (q) => get('/design/email-redesign', q),
    emailRedesignGet: (id) => get('/design/email-redesign/' + id),
    emailRedesignIngest: (body) => post('/design/email-redesign/ingest', body),
    emailRedesignSubmit: (id, body) => post('/design/email-redesign/' + id + '/submit', body),
    emailRedesignDismiss: (id) => post('/design/email-redesign/' + id + '/dismiss', {}),
    emailRedesignScan: () => post('/design/email-redesign/scan', {}),

    // ---- design: learning playbook ----
    learningStatus: () => get('/design/learning/status'),
    learningPlaybook: () => get('/design/learning/playbook'),
    learningEvents: (q) => get('/design/learning/events', q),
    learningClear: (what) => post('/design/learning/clear', { what }),
    learningDistill: (force) => post('/design/learning/distill', { force: !!force }),

    // ---- websites ----
    websites: (q) => get('/websites', q),
    websiteGet: (id) => get('/websites/' + id),
    websiteByLead: (leadId) => get('/websites/by-lead/' + leadId),
    generateSite: (body) => post('/websites/generate', body),
    websiteSave: (id, body) => put('/websites/' + id, body),
    websiteRender: (id, body) => post('/websites/' + id + '/render', body),
    websiteRenderPages: (body) => post('/websites/render', body),
    websitePreview: (id, open) => post('/websites/' + id + '/preview', { open: !!open }),
    websiteQa: (id) => post('/websites/' + id + '/qa', {}),
    websiteExport: (id) => post('/websites/' + id + '/export', {}),
    websiteVersions: (id, q) => get('/websites/' + id + '/versions', q),
    websiteRestore: (versionId) => post('/websites/restore', { versionId }),
    websiteImages: (id, body) => post('/websites/' + id + '/images', body),

    // ---- Cloudflare Pages ----
    cfGet: () => get('/cloudflare'),
    cfSave: (body) => put('/cloudflare', body),
    cfTest: () => post('/cloudflare/test', {}),
    cfPublish: (websiteId, dir) => post('/cloudflare/publish', { websiteId, dir }),

    // ---- outreach ----
    templates: () => get('/templates'),
    saveTemplate: (body) => post('/templates', body),
    deleteTemplate: (id) => del('/templates/' + id),
    campaigns: (q) => get('/campaigns', q),
    createCampaign: (body) => post('/campaigns', body),
    campaignStatus: (id, status) => post('/campaigns/' + id + '/status', { status }),
    campaignMessages: (id, q) => get('/campaigns/' + id + '/messages', q),
    processQueue: () => post('/outreach/process', {}),
    outreachStats: () => get('/outreach/stats'),
    suppression: (q) => get('/suppression', q),
    suppressionAdd: (email, reason) => post('/suppression', { email, reason }),
    suppressionRemove: (id) => del('/suppression/' + id),
    emailCompose: (leadId, templateId, queue) => post('/email/compose', { leadId, templateId, queue: !!queue }),
    emailSend: (messageId) => post('/email/send', { messageId }),
    pipeline: (q) => get('/pipeline', q),
    intentGet: (leadId) => get('/intent/' + leadId),
    intentRecord: (leadId, event, note) => post('/intent/' + leadId, { event, note }),

    // ---- settings / prompts ----
    settingsGet: () => get('/settings'),
    settingsSet: (key, value) => put('/settings', { key, value }),
    settingsSecret: (key, value) => put('/settings/secret', { key, value }),
    automation: (paused) => post('/settings/automation', { paused }),
    prompts: () => get('/prompts'),
    promptSave: (key, body) => put('/prompts/' + encodeURIComponent(key), { body }),
    promptReset: (key) => post('/prompts/' + encodeURIComponent(key) + '/reset', {}),

    // ---- jobs (scheduled) ----
    jobsList: () => get('/jobs'),
    jobsCreate: (body) => post('/jobs', body),
    jobsUpdate: (id, body) => patch('/jobs/' + id, body),
    jobsDelete: (id) => del('/jobs/' + id),
    jobsRun: (id) => post('/jobs/' + id + '/run', {}),

    // ---- MCP ----
    mcpStatus: () => get('/mcp/status'),
    mcpToken: (name) => post('/mcp/token', { name }),
    mcpRevoke: (id) => del('/mcp/token/' + id),
  };
})();
