'use strict';

/**
 * Browser client for /api/v1. Every method resolves to the full envelope
 * `{ ok: true, data }`; callers read `res.data`. Errors throw (err.status, err.data).
 */
window.ScoutApi = (() => {
  let workspaceId = null;
  let onAuthRequired = null;

  function responseError(res, data) {
    const detail = data && data.error;
    const nested = detail && typeof detail === 'object' ? detail : null;
    const code = (nested && typeof nested.code === 'string' && nested.code)
      || (data && typeof data.code === 'string' && data.code)
      || (typeof detail === 'string' && /^[A-Z][A-Z0-9_]+$/.test(detail) && detail) || undefined;
    const message = (typeof detail === 'string' && detail)
      || (nested && typeof nested.message === 'string' && nested.message)
      || res.statusText || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    err.code = code;
    if (res.status === 401 && code === 'AUTH_REQUIRED' && typeof onAuthRequired === 'function') {
      try { onAuthRequired(); } catch { /* ignore callback errors */ }
    }
    if (code === 'SUBSCRIPTION_REQUIRED') {
      try {
        if (!String(window.location.hash || '').startsWith('#/billing')) window.location.hash = '#/billing';
      } catch { /* ignore navigation errors */ }
    }
    return err;
  }

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
    if (!res.ok || (data && data.ok === false)) {
      throw responseError(res, data);
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
    setOnAuthRequired: (fn) => { onAuthRequired = fn; },

    // ---- auth ----
    me: () => get('/auth/me'),
    login: (body) => post('/auth/login', body),
    register: (body) => post('/auth/register', body),
    logout: () => post('/auth/logout', {}),
    selectWorkspace: (id) => post('/auth/workspace', { workspaceId: id }),
    forgotPassword: (email, captchaToken) => post('/auth/forgot-password', { email, captchaToken }),
    resetPassword: (token, password, captchaToken) => post('/auth/reset-password', { token, password, captchaToken }),
    captchaConfig: () => get('/captcha/config'),
    acceptInvite: (token) => post('/auth/accept-invite', { token }),

    // ---- workspace invites ----
    invitesList: () => get('/invites'),
    invitesCreate: (body) => post('/invites', body),

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
    designContact: (id, emailOrBody, phone) => {
      const body = (emailOrBody != null && typeof emailOrBody === 'object')
        ? emailOrBody
        : { email: emailOrBody, phone };
      return post('/design/' + id + '/contact', body || {});
    },
    designEmailQuestions: (id) => post('/design/' + id + '/email-questions', {}),
    designEmailDelivery: (id) => post('/design/' + id + '/email-delivery', {}),
    designClientForm: (id) => get('/design/' + id + '/client-form'),
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
    emailImapPoll: (body) => post('/design/email-redesign/imap-poll', body || {}),

    // ---- design: learning playbook ----
    learningStatus: () => get('/design/learning/status'),
    learningPlaybook: () => get('/design/learning/playbook'),
    learningEvents: (q) => get('/design/learning/events', q),
    learningClear: (what) => post('/design/learning/clear', { what }),
    learningDistill: (force) => post('/design/learning/distill', { force: !!force }),

    // ---- websites ----
    websites: (q) => get('/websites', q),
    websiteGet: (id) => get('/websites/' + id),
    websiteDelete: (id) => del('/websites/' + id),
    websiteByLead: (leadId) => get('/websites/by-lead/' + leadId),
    generateSite: (body) => post('/websites/generate', body),
    websiteSave: (id, body) => put('/websites/' + id, body),
    websiteStructure: (id) => get('/websites/' + id + '/structure'),
    websiteReorderStructure: (id, body) => post('/websites/' + id + '/structure', body),
    websiteScreenshots: (id, q) => get('/websites/' + id + '/screenshots', q),
    websiteScreenshotsCapture: (id, body) => post('/websites/' + id + '/screenshots/capture', body || {}),
    screenshots: (q) => get('/screenshots', q),
    websiteRender: (id, body) => post('/websites/' + id + '/render', body),
    websiteRenderPages: (body) => post('/websites/render', body),
    websitePreview: (id, open, opts = {}) => post('/websites/' + id + '/preview', {
      open: !!open,
      force: !!(opts && opts.force),
    }),
    websiteQa: (id) => post('/websites/' + id + '/qa', {}),
    websiteExport: (id) => post('/websites/' + id + '/export', {}),
    /** Site + claim URLs with QR data-URLs. */
    websiteClaimKit: (id) => get('/websites/' + id + '/claim-kit'),
    /** Download 4×6 postcard PDF (site + claim QRs). */
    websitePostcard: async (id) => {
      const headers = {};
      const ws = getWorkspaceId();
      if (ws) headers['X-Workspace-Id'] = String(ws);
      const res = await fetch(V + '/websites/' + id + '/postcard', {
        method: 'GET',
        credentials: 'include',
        headers,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw responseError(res, data);
      }
      const cd = res.headers.get('Content-Disposition') || '';
      let filename = 'bitpype-postcard.pdf';
      const m = /filename="([^"]+)"/i.exec(cd) || /filename=([^;]+)/i.exec(cd);
      if (m && m[1]) filename = m[1].trim().replace(/^["']|["']$/g, '');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      return { filename, bytes: blob.size };
    },
    leadClaimKit: (leadId, q) => get('/leads/' + leadId + '/claim-kit', q),
    leadPostcard: async (leadId) => {
      const headers = {};
      const ws = getWorkspaceId();
      if (ws) headers['X-Workspace-Id'] = String(ws);
      const res = await fetch(V + '/leads/' + leadId + '/claim-kit?pdf=1', {
        method: 'GET',
        credentials: 'include',
        headers,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw responseError(res, data);
      }
      const cd = res.headers.get('Content-Disposition') || '';
      let filename = 'bitpype-postcard.pdf';
      const m = /filename="([^"]+)"/i.exec(cd) || /filename=([^;]+)/i.exec(cd);
      if (m && m[1]) filename = m[1].trim().replace(/^["']|["']$/g, '');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      return { filename, bytes: blob.size };
    },
    /** Download materialized site as application/zip (triggers browser save). */
    websiteExportZip: async (id) => {
      const headers = {};
      const ws = getWorkspaceId();
      if (ws) headers['X-Workspace-Id'] = String(ws);
      const res = await fetch(V + '/websites/' + id + '/export-zip', {
        method: 'GET',
        credentials: 'include',
        headers,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw responseError(res, data);
      }
      const cd = res.headers.get('Content-Disposition') || '';
      let filename = 'website.zip';
      const m = /filename="([^"]+)"/i.exec(cd) || /filename=([^;]+)/i.exec(cd);
      if (m && m[1]) filename = m[1].trim().replace(/^["']|["']$/g, '');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      return { filename, bytes: blob.size };
    },
    websiteVersions: (id, q) => get('/websites/' + id + '/versions', q),
    websiteRestore: (versionId) => post('/websites/restore', { versionId }),
    websiteOptimizeImages: (id, body) => post('/websites/' + id + '/optimize-images', body || {}),
    websiteImages: (id, body) => post('/websites/' + id + '/images', body),
    websiteLogo: (id, body) => post('/websites/' + id + '/logo', body),
    designGenerateLogo: (id, body) => post('/design/' + id + '/generate-logo', body || {}),

    // ---- Cloudflare Pages ----
    cfGet: () => get('/cloudflare'),
    cfSave: (body) => put('/cloudflare', body),
    cfTest: () => post('/cloudflare/test', {}),
    cfPublish: (websiteId, dir) => post('/cloudflare/publish', { websiteId, dir }),

    // ---- Domains (CF Registrar + Pages link) ----
    domainsList: (q) => get('/domains', q),
    domainsOwned: () => get('/domains/owned'),
    domainsSearch: (q, opts) => get('/domains/search', Object.assign({ q }, opts || {})),
    domainsCheck: (domains) => post('/domains/check', { domains }),
    domainsRegister: (body) => post('/domains/register', body || {}),
    domainsStatus: (domain) => get('/domains/' + encodeURIComponent(domain) + '/status'),
    domainsLink: (body) => post('/domains/link', body || {}),
    domainsUnlink: (body) => post('/domains/unlink', body || {}),

    // ---- outreach ----
    templates: () => get('/templates'),
    saveTemplate: (body) => post('/templates', body),
    deleteTemplate: (id) => del('/templates/' + id),
    campaigns: (q) => get('/campaigns', q),
    createCampaign: (body) => post('/campaigns', body),
    campaignStatus: (id, status) => post('/campaigns/' + id + '/status', { status }),
    campaignCancel: (id) => post('/campaigns/' + id + '/cancel', {}),
    campaignDelete: (id) => del('/campaigns/' + id),
    campaignMessages: (id, q) => get('/campaigns/' + id + '/messages', q),
    processQueue: () => post('/outreach/process', {}),
    outreachStats: () => get('/outreach/stats'),
    suppression: (q) => get('/suppression', q),
    suppressionAdd: (email, reason) => post('/suppression', { email, reason }),
    suppressionRemove: (id) => del('/suppression/' + id),
    emailCompose: (leadId, templateId, queue, channel) => post('/email/compose', {
      leadId, templateId, queue: !!queue, ...(channel ? { channel } : {}),
    }),
    emailSend: (messageId) => post('/email/send', { messageId }),
    emailDraft: (body) => post('/email/draft', body || {}),
    emailUploadAsset: (body) => post('/email/assets', body || {}),
    smsQueue: (body) => post('/sms/queue', body || {}),
    templatesByChannel: (channel) => get('/templates', channel ? { channel } : {}),
    pipeline: (q) => get('/pipeline', q),
    intentGet: (leadId) => get('/intent/' + leadId),
    intentRecord: (leadId, event, note) => post('/intent/' + leadId, { event, note }),

    // ---- settings / prompts ----
    settingsGet: () => get('/settings'),
    settingsSet: (key, value) => put('/settings', { key, value }),
    settingsSecret: (key, value) => put('/settings/secret', { key, value }),
    automation: (paused) => post('/settings/automation', { paused }),
    handsOffStatus: () => get('/hands-off'),
    handsOffRun: (force) => post('/hands-off/run', { force: !!force }),
    handsOffDigest: (force) => post('/hands-off/digest', { force: !!force }),
    prompts: () => get('/prompts'),
    promptSave: (key, body) => put('/prompts/' + encodeURIComponent(key), { body }),
    promptReset: (key) => post('/prompts/' + encodeURIComponent(key) + '/reset', {}),

    // ---- jobs (scheduled) ----
    jobsList: () => get('/jobs'),
    jobsCreate: (body) => post('/jobs', body),
    jobsUpdate: (id, body) => patch('/jobs/' + id, body),
    jobsDelete: (id) => del('/jobs/' + id),
    jobsRun: (id) => post('/jobs/' + id + '/run', {}),

    // ---- MCP (workspace admin: status, mint, revoke) ----
    mcpStatus: () => get('/mcp/status'),
    mcpToken: (name) => post('/mcp/token', { name: name || 'MCP' }),
    mcpRevoke: (id) => del('/mcp/token/' + encodeURIComponent(id)),
    mcpDeleteToken: (id) => del('/mcp/token/' + encodeURIComponent(id)),

    // ---- Platform super admin ----
    adminOverview: () => get('/admin/overview'),
    adminAudit: (q) => get('/admin/audit', q),
    adminUsers: (q) => get('/admin/users', q),
    adminUser: (id) => get('/admin/users/' + id),
    adminCreateUser: (body) => post('/admin/users', body),
    adminUpdateUser: (id, body) => patch('/admin/users/' + id, body),
    adminDeleteUser: (id) => del('/admin/users/' + id),
    adminWorkspaces: (q) => get('/admin/workspaces', q),
    adminWorkspace: (id) => get('/admin/workspaces/' + id),
    adminCreateWorkspace: (body) => post('/admin/workspaces', body),
    adminUpdateWorkspace: (id, body) => patch('/admin/workspaces/' + id, body),
    adminDeleteWorkspace: (id) => del('/admin/workspaces/' + id),
    adminAddMember: (wsId, userId, role) => post('/admin/workspaces/' + wsId + '/members', { userId, role }),
    adminRemoveMember: (wsId, userId) => del('/admin/workspaces/' + wsId + '/members/' + userId),
    adminSettings: () => get('/admin/settings'),
    adminSettingsSave: (settings) => put('/admin/settings', { settings }),
    adminSettingsSecret: (key, value) => put('/admin/settings/secret', { key, value }),
    adminPushDefaults: (body) => post('/admin/settings/push', body || {}),
    adminPayments: (q) => get('/admin/payments', q),
    adminRefunds: (q) => get('/admin/refunds', q),
    adminRefundPayment: (id, body) => post('/admin/payments/' + id + '/refund', body || {}),
    adminUpsellTips: () => get('/admin/upsell-tips'),
    adminUpsellTipCreate: (body) => post('/admin/upsell-tips', body),
    adminUpsellTipUpdate: (id, body) => patch('/admin/upsell-tips/' + id, body),
    adminUpsellTipDelete: (id) => del('/admin/upsell-tips/' + id),

    // ---- Billing (user) ----
    billingSummary: () => get('/billing/summary'),
    billingCheckout: (plan) => post('/billing/checkout', { plan: plan || 'standard' }),
    billingChangePlan: (plan) => post('/billing/change-plan', { plan }),
    billingCancel: () => post('/billing/cancel', {}),
    billingResume: () => post('/billing/resume', {}),
    billingCreditsCheckout: (quantity) => post('/billing/credits/checkout', { quantity: quantity || 1 }),
    billingPortal: () => post('/billing/portal', {}),
    deleteAccount: () => del('/billing/account', { confirm: 'DELETE' }),

    // ---- Social (Facebook + Instagram) ----
    socialOverview: () => get('/social/overview'),
    socialAccounts: (leadId) => get('/social/accounts/' + leadId),
    socialDisconnect: (id) => del('/social/accounts/' + id),
    socialOauthStart: (leadId, returnTo) => get('/social/oauth/start', { leadId, returnTo }),
    socialCampaigns: (q) => get('/social/campaigns', q),
    socialCampaignGet: (id) => get('/social/campaigns/' + id),
    socialGenerateMonth: (body) => post('/social/campaigns/generate', body),
    socialCampaignStatus: (id, status) => post('/social/campaigns/' + id + '/status', { status }),
    socialSendWeek: (id, force) => post('/social/campaigns/' + id + '/send-week', { force: !!force }),
    socialUpdatePost: (id, body) => patch('/social/posts/' + id, body),
    socialApprovePosts: (postIds) => post('/social/posts/approve', { postIds }),
    socialPublishPost: (id) => post('/social/posts/' + id + '/publish', {}),
    socialPublishDue: (body) => post('/social/publish-due', body || {}),
    socialWeeklyTick: () => post('/social/weekly-tick', {}),
  };
})();
