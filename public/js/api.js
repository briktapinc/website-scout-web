'use strict';

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

  return {
    setWorkspaceId,
    getWorkspaceId,
    me: () => request('/api/v1/auth/me'),
    login: (body) => request('/api/v1/auth/login', { method: 'POST', body }),
    register: (body) => request('/api/v1/auth/register', { method: 'POST', body }),
    logout: () => request('/api/v1/auth/logout', { method: 'POST', body: {} }),
    selectWorkspace: (id) => request('/api/v1/auth/workspace', { method: 'POST', body: { workspaceId: id } }),
    stats: () => request('/api/v1/dashboard/stats'),
    leads: (qs = '') => request('/api/v1/leads' + qs),
    createLead: (body) => request('/api/v1/leads', { method: 'POST', body }),
    deleteLead: (id) => request('/api/v1/leads/' + id, { method: 'DELETE' }),
    qualifyLead: (id, note) => request('/api/v1/leads/' + id + '/qualify', { method: 'POST', body: { note } }),
    scoreLead: (id) => request('/api/v1/leads/' + id + '/score', { method: 'POST', body: {} }),
    researchLead: (id) => request('/api/v1/leads/' + id + '/research', { method: 'POST', body: {} }),
    discover: (body) => request('/api/v1/leads/discover', { method: 'POST', body }),
    designList: (qs = '') => request('/api/v1/design' + qs),
    designPending: () => request('/api/v1/design/pending'),
    designCreate: (body) => request('/api/v1/design', { method: 'POST', body }),
    designNext: () => request('/api/v1/design/next', { method: 'POST', body: {} }),
    websites: (qs = '') => request('/api/v1/websites' + qs),
    generateSite: (body) => request('/api/v1/websites/generate', { method: 'POST', body }),
    templates: () => request('/api/v1/templates'),
    saveTemplate: (body) => request('/api/v1/templates', { method: 'POST', body }),
    campaigns: () => request('/api/v1/campaigns'),
    createCampaign: (body) => request('/api/v1/campaigns', { method: 'POST', body }),
    processQueue: () => request('/api/v1/outreach/process', { method: 'POST', body: {} }),
    outreachStats: () => request('/api/v1/outreach/stats'),
    pipeline: () => request('/api/v1/pipeline'),
    discoveryGet: () => request('/api/v1/discovery/schedule'),
    discoverySet: (body) => request('/api/v1/discovery/schedule', { method: 'PUT', body }),
    discoveryRun: () => request('/api/v1/discovery/run', { method: 'POST', body: {} }),
    settingsGet: () => request('/api/v1/settings'),
    settingsSet: (key, value) => request('/api/v1/settings', { method: 'PUT', body: { key, value } }),
    settingsSecret: (key, value) => request('/api/v1/settings/secret', { method: 'PUT', body: { key, value } }),
    automation: (paused) => request('/api/v1/settings/automation', { method: 'POST', body: { paused } }),
    jobsList: () => request('/api/v1/jobs'),
    jobsCreate: (body) => request('/api/v1/jobs', { method: 'POST', body }),
    jobsUpdate: (id, body) => request('/api/v1/jobs/' + id, { method: 'PATCH', body }),
    jobsDelete: (id) => request('/api/v1/jobs/' + id, { method: 'DELETE' }),
    jobsRun: (id) => request('/api/v1/jobs/' + id + '/run', { method: 'POST', body: {} }),
    mcpStatus: () => request('/api/v1/mcp/status'),
    mcpToken: (name) => request('/api/v1/mcp/token', { method: 'POST', body: { name } }),
  };
})();
